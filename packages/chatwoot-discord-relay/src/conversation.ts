// One Durable Object per Chatwoot conversation. It owns the conversation's post and what was
// posted in it, queues the conversation's background work (relaying messages, keeping the post
// and its card in line), and runs the commands given in the post. Work for one conversation never
// waits for another's: each object has its own alarm, and commands run at once instead of queuing.
//
// Requests only write a job row and set an alarm, so they return quickly. The alarm drains due
// jobs one at a time and yields to a fresh invocation before it would exceed the per-invocation
// subrequest limit. Failed jobs back off (up to 30 minutes) and retry until they succeed.

import { DurableObject } from "cloudflare:workers";
import {
  type APIMessageTopLevelComponent,
  ComponentType,
  MessageFlags,
  type RESTPatchAPIWebhookWithTokenMessageJSONBody,
  type RESTPatchAPIWebhookWithTokenMessageResult,
  Routes,
} from "discord-api-types/v10";
import { z } from "zod";
import { Budget, BudgetExhaustedError } from "../../../shared/budget.ts";
import { type ChatwootConversation, chatwootClient, toRelayConversation } from "../../../shared/chatwoot/api.ts";
import { parseJson } from "../../../shared/json.ts";
import { errorFields, log } from "../../../shared/log.ts";
import { retryDelay } from "../../../shared/store.ts";
import { executeCommand } from "./commands/actions.ts";
import { text } from "./commands/components.ts";
import { type CommandJob, commandJobSchema } from "./commands/job.ts";
import type { Settings } from "./config.ts";
import { DiscordForum } from "./discord/forum.ts";
import { DiscordHttpError, DiscordRest } from "./discord/rest.ts";
import type { Env } from "./env.ts";
import { hub } from "./hub.ts";
import { latestMessageId, type ProcessorContext, processConversation, relayFor } from "./relay/processor.ts";
import { isUnknownCard } from "./relay/relay.ts";
import { processMessageUpdate } from "./relay/updates.ts";
import { loadSettings } from "./settings.ts";
import { type Job, Store } from "./store.ts";

const id = z.number().int().positive();
const payloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("command"), job: commandJobSchema }),
  z.object({ type: z.literal("sync"), accountId: id, conversationId: id }),
  z.object({ type: z.literal("conversation"), accountId: id, conversationId: id }),
  z.object({ type: z.literal("message-updated"), accountId: id, conversationId: id, messageId: id }),
  z.object({ type: z.literal("answer"), accountId: id, conversationId: id, answerId: z.string(), replyTo: z.string() }),
]);
type JobPayload = z.infer<typeof payloadSchema>;

const PRIORITY = { command: 0, sync: 1, answer: 2, conversation: 3, "message-updated": 4 } as const;
/** Requests a command may need: it starts only with this many left, so it is never cut short. */
const COMMAND_BUDGET = 20;
/** Commands that change nothing in Chatwoot: their post needs no sync. */
const READ_ONLY_ACTIONS: ReadonlySet<string> = new Set(["panel", "pick-assignee"]);
/** A job that takes longer than this is logged. */
const SLOW_JOB_MS = 5000;
/** Stop draining and continue in a new invocation after this long (alarms may run 15 minutes). */
const RUN_WALL_MS = 5 * 60 * 1000;
/**
 * Discord interaction tokens are valid for 15 minutes. A command that cannot start within this
 * time is dropped, and the invoker is told while the token still works: running it later could
 * not report its result, and the invoker may already have acted in Chatwoot.
 */
const COMMAND_START_DEADLINE_MS = 12 * 60 * 1000;
const EXPIRED = "❌ This could not start in time, so nothing was done. Please try again.";
/** How long a triage answer's draft is kept for Reply with draft. */
const ANSWER_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * A customer message held while the conversation is the inbox bot's (pending): read again once
 * shortly (a racing status webhook), then this often until the bot's turn ends.
 */
const HELD_RECHECK_MS = 5 * 60 * 1000;
const HELD_KEY = "held";
/** The post registered with the Hub (see claimThread). */
const CLAIMED_KEY = "claimed";

export function conversationStub(env: Env, accountId: number, conversationId: number) {
  return env.CONVERSATION.getByName(`${accountId}:${conversationId}`);
}

export class Conversation extends DurableObject<Env> {
  private readonly store: Store;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new Store(ctx.storage.sql);
    this.store.migrate();
  }

  /**
   * Queues the conversation for syncing, at the earliest after `delayMs`; at once while a customer
   * message is held, since the bot's turn may have ended.
   */
  async enqueueConversation(accountId: number, conversationId: number, delayMs = 0): Promise<void> {
    const delay = this.store.get(HELD_KEY) === undefined ? delayMs : 0;
    this.enqueue({ type: "conversation", accountId, conversationId }, Date.now() + delay);
    await this.schedule();
  }

  /**
   * Queues a check of a message reported as deleted (its Discord messages are removed), as
   * answered by the customer (the response is posted), or with a changed outgoing delivery status.
   */
  async enqueueMessageUpdate(accountId: number, conversationId: number, messageId: number): Promise<void> {
    this.enqueue({ type: "message-updated", accountId, conversationId, messageId });
    await this.schedule();
  }

  /**
   * The sweep saw the conversation in Chatwoot's list: queues it when its post is behind (new
   * messages, or tags, status, or card that differ). Covers webhooks that were never delivered.
   */
  async reconcile(accountId: number, conversationId: number, listed: ChatwootConversation): Promise<void> {
    const settings = await loadSettings(this.env);
    const row = this.store.conversation(accountId, conversationId);
    const latest = latestMessageId(listed);
    const cursor = row?.cursor ?? settings.config.relay.startAfterMessageId;
    const behind =
      (row?.threadId !== undefined && row.cursor === undefined) || (latest !== undefined && latest > cursor);
    const relay = relayFor(settings, this.services(settings, new Budget(0)).forum, this.store);
    const stale =
      row?.threadId !== undefined &&
      (row.state !== relay.stateOf(toRelayConversation(conversationId, listed)) ||
        row.cardCovered === 1 ||
        isUnknownCard(row.cardId) ||
        // A post from before cards gets its card while its ticket is not resolved.
        (row.cardId === undefined && listed.status !== "resolved"));
    if (!behind && !stale && this.store.get(HELD_KEY) === undefined) return;
    this.enqueue({ type: "conversation", accountId, conversationId });
    await this.schedule();
  }

  /**
   * Queues a command given in the post, once per interaction: a repeated (replayed) request is
   * ignored. It runs next, ahead of the conversation's background work; other conversations'
   * work never delays it.
   */
  async enqueueCommand(job: CommandJob): Promise<void> {
    if (!this.store.acceptInteraction(job.interactionId)) {
      log.warn("repeated interaction ignored", { interactionId: job.interactionId });
      return;
    }
    this.enqueue({ type: "command", job });
    await this.schedule();
  }

  /**
   * The triage bot's answer `answerId` to message `replyTo` is in the post, with the reply draft it proposes: the
   * draft is kept for Reply with draft, and the post's card offers it under the answer (Relay.answered).
   * Each answer is taken once, so a repeated call adds nothing.
   */
  async triageAnswered(answer: { threadId: string; answerId: string; replyTo: string; draft: string }): Promise<void> {
    const ticket = this.store.ticketForThread(answer.threadId);
    if (!ticket || this.store.get(answerKey(answer.answerId)) !== undefined) return;
    this.store.set(answerKey(answer.answerId), answer.draft, ANSWER_TTL_MS);
    this.enqueue({ type: "answer", ...ticket, answerId: answer.answerId, replyTo: answer.replyTo });
    await this.schedule();
  }

  /** The draft the triage bot's hook sent with an answer, while it is kept. */
  async answerDraft(answerId: string): Promise<string | null> {
    return this.store.get(answerKey(answerId)) ?? null;
  }

  /** Cloudflare runs at most one alarm() at a time per Durable Object. */
  override async alarm(): Promise<void> {
    const settings = await loadSettings(this.env);
    const budget = new Budget(settings.config.relay.subrequestBudget);
    const services = this.services(settings, budget);
    const startedAt = Date.now();
    let yielded = false;

    this.store.prune();
    for (let job = this.store.nextDueJob(); job; job = this.store.nextDueJob()) {
      const parsed = payloadSchema.safeParse(parseJson(job.payload));
      if (!parsed.success) {
        log.warn("unreadable job dropped", { job: job.key });
        this.store.deleteJob(job.key);
        continue;
      }
      const required = parsed.data.type === "command" ? COMMAND_BUDGET : 2;
      if (budget.remaining < required || Date.now() - startedAt > RUN_WALL_MS) {
        yielded = true;
        break;
      }
      const jobStarted = Date.now();
      const outcome = await this.run(job, parsed.data, services);
      const ms = Date.now() - jobStarted;
      if (ms > SLOW_JOB_MS) log.warn("slow job", { job: job.key, ms });
      if (outcome === "yield") {
        this.store.deferJob(job);
        yielded = true;
        break;
      }
    }
    await this.schedule(yielded ? Date.now() : undefined);
  }

  private async run(job: Job, payload: JobPayload, services: ProcessorContext): Promise<"done" | "yield"> {
    try {
      switch (payload.type) {
        case "command":
          // At most once: a command that sends a message must never run twice.
          this.store.deleteJob(job.key);
          await this.runCommand(payload.job, job.createdAt, services);
          return "done";
        case "sync":
          await this.syncPost(payload, services);
          this.store.completeJob(job);
          return "done";
        case "conversation": {
          const outcome = await processConversation(services, payload.accountId, payload.conversationId);
          if (outcome === "pending") {
            const held = this.store.get(HELD_KEY) !== undefined;
            this.store.set(HELD_KEY, "1");
            this.store.postponeJob(job, held ? HELD_RECHECK_MS : 1000);
            return "done";
          }
          if (outcome === "done") {
            this.store.delete(HELD_KEY);
            await this.releaseThread(payload.accountId, payload.conversationId);
            this.store.completeJob(job);
          }
          return outcome;
        }
        case "message-updated":
          await processMessageUpdate(services, payload.accountId, payload.conversationId, payload.messageId);
          this.store.completeJob(job);
          return "done";
        case "answer":
          // The card moves under the answer when the conversation's post is synced next.
          services.relay.answered(payload.accountId, payload.conversationId, payload.answerId, payload.replyTo);
          this.store.completeJob(job);
          this.enqueue({ type: "conversation", accountId: payload.accountId, conversationId: payload.conversationId });
          return "done";
      }
    } catch (error) {
      if (error instanceof BudgetExhaustedError) return "yield";
      const backoff = retryDelay(job.attempts);
      if (error instanceof DiscordHttpError && error.retryAfterMs !== undefined) {
        // Rate limited: wait as long as Discord asks without counting an attempt, so no rate
        // limit, however long, drops the job.
        const delay = Math.max(backoff, error.retryAfterMs);
        log.warn("job rate limited by Discord; will retry", { job: job.key, delayMs: delay });
        this.store.deferJob(job, delay);
        return "done";
      }
      // Transient failures are warnings; a job that keeps failing is an error.
      const logAt = job.attempts + 1 >= 3 ? log.error : log.warn;
      logAt("job failed; will retry", {
        job: job.key,
        attempts: job.attempts + 1,
        delayMs: backoff,
        ...errorFields(error),
      });
      this.store.retryJob(job, backoff);
      return "done";
    }
  }

  /** Runs a command and replaces the invoker's "thinking…" with its result; the post follows in a sync job. */
  private async runCommand(job: CommandJob, queuedAt: number, services: ProcessorContext): Promise<void> {
    const { accountId, conversationId } = job;
    if (Date.now() - queuedAt > COMMAND_START_DEADLINE_MS) {
      log.warn("command expired before it could run; dropped", { interactionId: job.interactionId });
      await respond(services.rest, job, EXPIRED);
      return;
    }
    if (Date.now() - queuedAt > SLOW_JOB_MS)
      log.warn("command waited", { interactionId: job.interactionId, ms: Date.now() - queuedAt });
    const { content, components, conversationGone } = await executeCommand(
      job,
      services.settings,
      services.budget.fetch,
    );
    // Chatwoot sends no webhook when a conversation is deleted: let its job close the post.
    if (conversationGone) this.enqueue({ type: "conversation", accountId, conversationId });
    else if (!READ_ONLY_ACTIONS.has(job.action.type)) this.enqueue({ type: "sync", accountId, conversationId });
    await respond(services.rest, job, content, components);
  }

  /**
   * Brings the post's tags and card in line right after a command, rather than with Chatwoot's
   * event for the change, whose job waits for the change's activity line and then posts it.
   */
  private async syncPost(
    { accountId, conversationId }: { accountId: number; conversationId: number },
    { chatwoot, relay }: ProcessorContext,
  ): Promise<void> {
    const threadId = this.store.conversation(accountId, conversationId)?.threadId;
    if (!threadId) return;
    const conversation = await chatwoot.getConversation(accountId, conversationId);
    if (conversation) await relay.sync(accountId, toRelayConversation(conversationId, conversation), threadId);
  }

  private services(settings: Settings, budget: Budget): ProcessorContext {
    const rest = new DiscordRest(settings.secrets.DISCORD_BOT_TOKEN, budget.fetch);
    const chatwoot = chatwootClient(
      settings.config.chatwoot.baseUrl,
      settings.secrets.CHATWOOT_RELAY_TOKEN,
      budget.fetch,
    );
    const forum = new DiscordForum(rest, this.store);
    const claimThread = (accountId: number, conversationId: number, threadId: string) =>
      this.claimThread(accountId, conversationId, threadId);
    const relay = relayFor(settings, forum, this.store, {
      claimThread,
      reserveTriage: (hour, event) => hub(this.env).reserveTriage(hour, event, settings.config.triage.perHour),
    });
    return { settings, store: this.store, relay, forum, chatwoot, budget, rest, claimThread };
  }

  /** Registers the post with the Hub, which finds a post's conversation for commands. */
  private async claimThread(accountId: number, conversationId: number, threadId: string): Promise<boolean> {
    if (this.store.get(CLAIMED_KEY) === threadId) return true;
    const claimed = await hub(this.env).claimThread(accountId, conversationId, threadId);
    if (claimed) this.store.set(CLAIMED_KEY, threadId);
    else log.warn("post belongs to another conversation", { accountId, conversationId, threadId });
    return claimed;
  }

  /** A post forgotten because its conversation is gone is no longer found for commands. */
  private async releaseThread(accountId: number, conversationId: number): Promise<void> {
    const claimed = this.store.get(CLAIMED_KEY);
    if (claimed === undefined || this.store.conversation(accountId, conversationId)?.threadId) return;
    await hub(this.env).releaseThread(accountId, conversationId, claimed);
    this.store.delete(CLAIMED_KEY);
  }

  private enqueue(payload: JobPayload, notBefore?: number): void {
    this.store.enqueue(jobKey(payload), PRIORITY[payload.type], JSON.stringify(payload), notBefore);
  }

  /** Sets the alarm for the earliest due job (or `at`), unless an earlier alarm is already set. */
  private async schedule(at?: number): Promise<void> {
    const next = at ?? this.store.nextWakeup();
    if (next === undefined) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }
}

/**
 * Replaces the invoker's "thinking…" with `content`, and `components`: menus under the content,
 * or, when they include more than action rows, a Components V2 message (the Manage panel, the one
 * the job came from or a new one), which has no content.
 */
async function respond(
  rest: DiscordRest,
  job: CommandJob,
  content: string,
  given?: APIMessageTopLevelComponent[],
): Promise<void> {
  // A job from the Manage panel replaces that Components V2 message, which cannot take content.
  const components = given ?? (job.panel ? [text(content)] : undefined);
  const v2 = components?.some((component) => component.type !== ComponentType.ActionRow);
  const body = v2
    ? { flags: MessageFlags.IsComponentsV2, components }
    : { content, ...(components ? { components } : {}) };
  try {
    await rest.patch<RESTPatchAPIWebhookWithTokenMessageResult, RESTPatchAPIWebhookWithTokenMessageJSONBody>(
      Routes.webhookMessage(job.applicationId, job.token, "@original"),
      { body: { ...body, allowed_mentions: { parse: [] } }, auth: false },
    );
  } catch (error) {
    log.error("command follow-up failed", { interactionId: job.interactionId, ...errorFields(error) });
  }
}

/** One job per key: a job queued again while it waits is not queued twice. */
function jobKey(payload: JobPayload): string {
  switch (payload.type) {
    case "command":
      return `command:${payload.job.interactionId}`;
    case "sync":
    case "conversation":
      return `${payload.type}:${payload.accountId}:${payload.conversationId}`;
    case "answer":
      return answerKey(payload.answerId);
    case "message-updated":
      return `${payload.type}:${payload.accountId}:${payload.conversationId}:${payload.messageId}`;
  }
}

function answerKey(answerId: string): string {
  return `answer:${answerId}`;
}
