// Worker entry: verifies and acknowledges Chatwoot webhooks and Discord interactions, and hands
// the work to the conversation's Durable Object. Each request stays within a few milliseconds of CPU.

import type { APIInteraction } from "discord-api-types/v10";
import { verifyKey } from "discord-interactions";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { errorFields, log } from "../../../shared/log.ts";
import { eventTarget, isFreshTimestamp, verifyChatwootSignature } from "./chatwoot/webhook.ts";
import { FAILED } from "./commands/common.ts";
import { CONTENT_MAX } from "./commands/definitions.ts";
import { readDraft } from "./commands/draft.ts";
import { handleInteraction, privately } from "./commands/handler.ts";
import { ConfigError } from "./config.ts";
import { conversationStub } from "./conversation.ts";
import { DiscordRest } from "./discord/rest.ts";
import type { Env } from "./env.ts";
import { hub } from "./hub.ts";
import { loadSettings } from "./settings.ts";

/** Reply with draft may look up the triage bot's answer this long, while Discord waits for the reply editor. */
const DRAFT_DEADLINE_MS = 2000;

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", async (c) => {
  try {
    await loadSettings(c.env);
    return c.json({ ok: true });
  } catch (error) {
    log.error(error instanceof ConfigError ? "configuration invalid" : "configuration unavailable", errorFields(error));
    return c.json({ ok: false }, 503);
  }
});

app.post("/chatwoot/webhook", bodyLimit({ maxSize: 2 * 1024 * 1024 }), async (c) => {
  const settings = await loadSettings(c.env);
  const timestamp = c.req.header("x-chatwoot-timestamp");
  if (!timestamp || !isFreshTimestamp(timestamp, Math.floor(Date.now() / 1000))) {
    return c.text("invalid or stale timestamp", 401);
  }
  const body = new Uint8Array(await c.req.arrayBuffer());
  const signature = c.req.header("x-chatwoot-signature");

  // The secret that verifies the request identifies the account it came from.
  let signedBy: number | undefined;
  for (const [accountId, secret] of Object.entries(settings.secrets.CHATWOOT_WEBHOOK_SECRETS)) {
    if (await verifyChatwootSignature(secret, timestamp, body, signature)) {
      signedBy = Number(accountId);
      break;
    }
  }
  if (signedBy === undefined) return c.text("invalid signature", 401);

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return c.text("bad request", 400);
  }
  const target = eventTarget(payload);
  if (!target) return c.json({ ok: true, ignored: true });
  if (target.accountId !== signedBy || !settings.account(target.accountId)) {
    return c.text("account does not match the webhook secret", 403);
  }

  const stub = conversationStub(c.env, target.accountId, target.conversationId);
  if (target.type === "message-updated") {
    await stub.enqueueMessageUpdate(target.accountId, target.conversationId, target.messageId);
  } else {
    await stub.enqueueConversation(target.accountId, target.conversationId, target.delayMs);
  }
  return c.json({ ok: true });
});

// The triage bot's hook, signed like Chatwoot's webhooks: its answer `answerId` to message
// `replyTo` is in the post `threadId`, with the reply `draft` it proposes (see Conversation.triageAnswered).
const answerSchema = z.strictObject({
  threadId: z.string().regex(/^\d{17,20}$/),
  answerId: z.string().regex(/^\d{17,20}$/),
  replyTo: z.string().regex(/^\d{17,20}$/),
  draft: z.string().trim().min(1).max(CONTENT_MAX),
});

app.post("/triage/answered", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
  const secret = (await loadSettings(c.env)).secrets.TRIAGE_HOOK_SECRET;
  if (!secret) return c.text("not found", 404);
  const timestamp = c.req.header("x-timestamp");
  if (!timestamp || !isFreshTimestamp(timestamp, Math.floor(Date.now() / 1000))) {
    return c.text("invalid or stale timestamp", 401);
  }
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (!(await verifyChatwootSignature(secret, timestamp, body, c.req.header("x-signature")))) {
    return c.text("invalid signature", 401);
  }
  let answer: z.infer<typeof answerSchema>;
  try {
    answer = answerSchema.parse(JSON.parse(new TextDecoder().decode(body)));
  } catch {
    return c.text("bad request", 400);
  }
  // An answer in a post that is not a ticket's changes nothing.
  const ticket = await hub(c.env).ticketForThread(answer.threadId);
  if (ticket) await conversationStub(c.env, ticket.accountId, ticket.conversationId).triageAnswered(answer);
  return c.json({ ok: true });
});

app.post("/discord/interactions", bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
  // Discord waits 3 s for the reply editor, counted from the interaction: one deadline for all of it.
  const deadline = AbortSignal.timeout(DRAFT_DEADLINE_MS);
  const settings = await loadSettings(c.env);
  const signature = c.req.header("x-signature-ed25519");
  const timestamp = c.req.header("x-signature-timestamp");
  const body = await c.req.arrayBuffer();
  if (!signature || !timestamp || !(await verifyKey(body, signature, timestamp, settings.secrets.DISCORD_PUBLIC_KEY))) {
    return c.text("invalid request signature", 401);
  }
  // A signature does not expire: an old signed request is refused like a stale webhook.
  if (!isFreshTimestamp(timestamp, Math.floor(Date.now() / 1000))) return c.text("stale request", 401);

  let interaction: APIInteraction;
  try {
    // Discord signed this body, so it is a well-formed interaction (typed, not validated).
    interaction = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return c.text("bad request", 400);
  }

  let ticket: { accountId: number; conversationId: number } | undefined;
  try {
    const result = await handleInteraction(interaction, {
      settings,
      ticketForThread: async (threadId) => {
        ticket = (await hub(c.env).ticketForThread(threadId)) ?? undefined;
        return ticket;
      },
      draftOf: async (threadId, answerId) => {
        const kept = ticket
          ? await conversationStub(c.env, ticket.accountId, ticket.conversationId).answerDraft(answerId)
          : null;
        if (kept !== null) return { text: kept };
        const rest = new DiscordRest(settings.secrets.DISCORD_BOT_TOKEN, (request) =>
          fetch(request, { signal: deadline }),
        );
        // Not read in time (or rate limited): the answer is linked instead.
        return readDraft(rest, threadId, answerId, settings.config.triage.userId).catch(() => ({
          missing: "unreadable" as const,
        }));
      },
    });
    const job = result.job;
    // Durably queued before Discord learns it was accepted.
    if (job) await conversationStub(c.env, job.accountId, job.conversationId).enqueueCommand(job);
    return c.json(result.response);
  } catch (error) {
    log.error("interaction failed", { interactionId: interaction.id, ...errorFields(error) });
    return c.json(privately(FAILED).response);
  }
});

app.notFound((c) => c.text("not found", 404));

app.onError((error, c) => {
  log.error("request failed", { path: c.req.path, ...errorFields(error) });
  return c.text("internal error", 500);
});

const handler = {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(hub(env).requestSweep());
    // The support queue is posted hourly, by the run at minute 0.
    if (new Date(controller.scheduledTime).getUTCMinutes() === 0) ctx.waitUntil(hub(env).requestQueue());
  },
} satisfies ExportedHandler<Env>;

export default handler;

export { Conversation } from "./conversation.ts";
export { Hub } from "./hub.ts";
