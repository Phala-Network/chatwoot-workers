// The one Durable Object shared by every conversation. It knows which conversation each post
// belongs to (commands are given in a post), counts the triage bot's hourly budget, and runs the
// installation-wide background work: the reconciliation sweep and the hourly support queue.
// Requests from conversations only read or write its storage, so none of them waits for that
// background work.

import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { Budget, BudgetExhaustedError } from "../../../shared/budget.ts";
import { CONVERSATIONS_PER_PAGE, chatwootClient } from "../../../shared/chatwoot/api.ts";
import { parseJson } from "../../../shared/json.ts";
import { errorFields, log } from "../../../shared/log.ts";
import { retryDelay } from "../../../shared/store.ts";
import { relaysInbox, type Settings } from "./config.ts";
import { conversationStub } from "./conversation.ts";
import { DiscordHttpError, DiscordRest } from "./discord/rest.ts";
import type { Env } from "./env.ts";
import { postQueue, type QueueContext } from "./queue.ts";
import { queueBudget } from "./queue-limits.ts";
import { loadSettings } from "./settings.ts";
import { type Job, Store } from "./store.ts";

const HUB_NAME = "global";

export function hub(env: Env) {
  return env.HUB.getByName(HUB_NAME);
}

const id = z.number().int().positive();
const payloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("sweep"), accountId: id }),
  z.object({ type: z.literal("queue") }),
  // A conversation the sweep could not hand over, given to its object by a job that retries.
  z.object({ type: z.literal("conversation"), accountId: id, conversationId: id }),
]);
type JobPayload = z.infer<typeof payloadSchema>;

const sweepPassSchema = z.object({ cutoff: z.number(), page: z.number().int().positive(), startedAt: z.number() });
const PASS_TTL_MS = 24 * 60 * 60 * 1000;
/** Stop draining and continue in a new invocation after this long. */
const RUN_WALL_MS = 5 * 60 * 1000;
/** How long the support queue may be posted after it is due: Discord's nonce check covers a few minutes. */
const QUEUE_RETRY_MS = 3 * 60 * 1000;

export class Hub extends DurableObject<Env> {
  private readonly store: Store;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new Store(ctx.storage.sql);
    this.store.migrate();
    // Relay 0.27 kept every conversation's records here; their objects took them over (0.35).
    this.store.keepThreadIndexOnly();
  }

  ticketForThread(threadId: string): { accountId: number; conversationId: number } | null {
    return this.store.ticketForThread(threadId) ?? null;
  }

  /** Records that the conversation's post is `threadId`, unless another conversation's post is. */
  claimThread(accountId: number, conversationId: number, threadId: string): boolean {
    return this.ctx.storage.transactionSync(() => {
      const owner = this.store.ticketForThread(threadId);
      if (owner && (owner.accountId !== accountId || owner.conversationId !== conversationId)) return false;
      this.store.updateConversation(accountId, conversationId, { threadId });
      return true;
    });
  }

  /** Forgets that `threadId` is the conversation's post (its conversation was deleted). */
  releaseThread(accountId: number, conversationId: number, threadId: string): void {
    const owner = this.store.ticketForThread(threadId);
    if (owner?.accountId === accountId && owner.conversationId === conversationId)
      this.store.forgetThread(accountId, conversationId);
  }

  /**
   * Counts a customer message `event` against the triage bot's budget of `hour` (once per event):
   * whether it is within `limit`.
   */
  reserveTriage(hour: string, event: string, limit: number): boolean {
    return this.ctx.storage.transactionSync(
      () =>
        this.store.once(`triage-hour:${event}`, () => (this.store.increment(`triage:${hour}`) <= limit ? "1" : "")) ===
        "1",
    );
  }

  /** Queues a reconciliation sweep for every configured account (called by the cron trigger). */
  async requestSweep(): Promise<void> {
    for (const account of (await loadSettings(this.env)).config.accounts)
      this.enqueue({ type: "sweep", accountId: account.id });
    await this.schedule();
  }

  /** Queues the hourly support queue, if configured (called by the cron trigger at minute 0). */
  async requestQueue(): Promise<void> {
    if (!(await loadSettings(this.env)).config.queue) return;
    this.enqueue({ type: "queue" });
    await this.schedule();
  }

  override async alarm(): Promise<void> {
    const settings = await loadSettings(this.env);
    const budget = new Budget(settings.config.relay.subrequestBudget);
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
      const payload = parsed.data;
      if (budget.remaining < requiredBudget(payload, settings) || Date.now() - startedAt > RUN_WALL_MS) {
        yielded = true;
        break;
      }
      if (!(await this.run(job, payload, settings, budget))) {
        this.store.deferJob(job);
        yielded = true;
        break;
      }
    }
    await this.schedule(yielded ? Date.now() : undefined);
  }

  /** Runs a job; false when the invocation's budget ran out before it was done. */
  private async run(job: Job, payload: JobPayload, settings: Settings, budget: Budget): Promise<boolean> {
    const context: QueueContext = {
      settings,
      store: this.store,
      chatwoot: chatwootClient(settings.config.chatwoot.baseUrl, settings.secrets.CHATWOOT_RELAY_TOKEN, budget.fetch),
      rest: new DiscordRest(settings.secrets.DISCORD_BOT_TOKEN, budget.fetch),
    };
    try {
      switch (payload.type) {
        case "sweep":
          await this.sweep(payload.accountId, context, budget);
          break;
        case "queue":
          // Discord drops a repeated post by its nonce only for a few minutes: however the job
          // is retried or deferred, nothing is posted after that, so the queue and its pings are
          // never posted twice. Every attempt posts the same messages with the same nonces.
          await postQueue(context, job.createdAt, job.createdAt + QUEUE_RETRY_MS);
          break;
        case "conversation":
          budget.consume();
          await conversationStub(this.env, payload.accountId, payload.conversationId).enqueueConversation(
            payload.accountId,
            payload.conversationId,
          );
      }
      this.store.completeJob(job);
      return true;
    } catch (error) {
      if (error instanceof BudgetExhaustedError) return false;
      const backoff = retryDelay(job.attempts);
      const delay = error instanceof DiscordHttpError ? Math.max(backoff, error.retryAfterMs ?? 0) : backoff;
      const logAt = job.attempts + 1 >= 3 ? log.error : log.warn;
      logAt("job failed; will retry", {
        job: job.key,
        attempts: job.attempts + 1,
        delayMs: delay,
        ...errorFields(error),
      });
      this.store.retryJob(job, delay);
      return true;
    }
  }

  /**
   * Hands every conversation with activity in the window to its object, which queues it when its
   * post is behind. Covers webhooks that were never delivered and service downtime. A pass reads
   * conversations newest activity first, down to the start of its window (since the previous pass
   * started, at least `lookbackSeconds`, at most `maxCatchUpSeconds`), one page per job,
   * continuing where it stopped until it is done. Activity means a new message (Chatwoot's
   * `last_activity_at`); a change that creates none, such as only a custom attribute, relies on
   * its webhook.
   */
  private async sweep(accountId: number, { settings, chatwoot }: QueueContext, budget: Budget): Promise<void> {
    const key = `sweep:${accountId}:pass`;
    const saved = sweepPassSchema.safeParse(parseJson(this.store.get(key)));
    const now = Date.now();
    const last = Number(this.store.get(`sweep:${accountId}:last`) ?? 0);
    const { lookbackSeconds, maxCatchUpSeconds } = settings.config.reconcile;
    const window = Math.min(
      Math.max(last > 0 ? (now - last) / 1000 + 60 : lookbackSeconds, lookbackSeconds),
      maxCatchUpSeconds,
    );
    const pass = saved.success ? saved.data : { cutoff: now / 1000 - window, page: 1, startedAt: now };
    const account = settings.account(accountId);
    const conversations = await chatwoot.listConversations(accountId, pass.page);
    const recent = conversations.filter((conversation) => (conversation.last_activity_at ?? 0) >= pass.cutoff);
    const reachedCutoff = recent.length < conversations.length || conversations.length === 0;
    const relayed = recent.flatMap((conversation) =>
      conversation.id !== undefined && account && relaysInbox(account, conversation.inbox_id)
        ? [{ conversationId: conversation.id, conversation }]
        : [],
    );
    for (const _ of relayed) budget.consume();
    const results = await Promise.allSettled(
      relayed.map(({ conversationId, conversation }) =>
        conversationStub(this.env, accountId, conversationId).reconcile(accountId, conversationId, conversation),
      ),
    );
    results.forEach((result, index) => {
      const conversationId = relayed[index]?.conversationId;
      if (result.status === "fulfilled" || conversationId === undefined) return;
      // Handed over by a job that retries until it succeeds, so the window moving on cannot lose it.
      log.warn("sweep could not hand over a conversation", {
        accountId,
        conversationId,
        ...errorFields(result.reason),
      });
      this.enqueue({ type: "conversation", accountId, conversationId });
    });
    const seen = relayed.length;
    if (reachedCutoff) {
      // The next pass covers list movement while this pass ran.
      this.store.set(`sweep:${accountId}:last`, String(pass.startedAt));
      this.store.delete(key);
      log.info("sweep done", { accountId, pages: pass.page, seen });
    } else {
      this.store.set(key, JSON.stringify({ ...pass, page: pass.page + 1 }), PASS_TTL_MS);
      this.enqueue({ type: "sweep", accountId });
    }
  }

  private enqueue(payload: JobPayload): void {
    this.store.enqueue(jobKey(payload), payload.type === "sweep" ? 1 : 2, JSON.stringify(payload));
  }

  /** Sets the alarm for the earliest due job (or `at`), unless an earlier alarm is already set. */
  private async schedule(at?: number): Promise<void> {
    const next = at ?? this.store.nextWakeup();
    if (next === undefined) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }
}

function jobKey(payload: JobPayload): string {
  switch (payload.type) {
    case "sweep":
      return `sweep:${payload.accountId}`;
    case "queue":
      return "queue";
    case "conversation":
      return `conversation:${payload.accountId}:${payload.conversationId}`;
  }
}

function requiredBudget(payload: JobPayload, settings: Settings): number {
  if (payload.type === "queue") return queueBudget(settings.config.accounts.length);
  // A page of conversations, and one call per conversation in it.
  return payload.type === "sweep" ? 1 + CONVERSATIONS_PER_PAGE : 1;
}
