// Who a relayed message notifies: the linked assignee's ping on customer messages, as a line
// added to its last part, and whether the triage bot is called for it (within its hourly
// budgets, and not for a message a routing kind handled; a line says why it is not). Also who a
// post announces as newly assigned. Relay posts the announcement and the triage bot's call after
// the live messages of a run. Only live messages notify; history relayed later (the first sync of
// an older conversation, a catch-up after downtime) and automatic email replies are posted
// without them.

import type { LinkedAgent, RelayConversation, RelayMessage } from "../../../../shared/types.ts";
import { fromCustomer } from "./format.ts";
import type { RelayStore } from "./relay.ts";

export interface TriageOptions {
  userId: string;
  name: string;
  perConversationPerHour: number;
  perHour: number;
}

interface NotifierOptions {
  store: RelayStore;
  triage?: TriageOptions | undefined;
  /** The agent linked to a Chatwoot user id, if any. */
  linkedAgent?: ((chatwootUserId: number) => LinkedAgent | undefined) | undefined;
  /** A message created longer ago than this is history. */
  liveSeconds: number;
  now: () => Date;
  /**
   * Counts a customer message `event` against the hourly budget shared by every conversation, once per event;
   * false when the budget of `hour` is used up. Unset: counted in `store`.
   */
  reserveTriage?: ((hour: string, event: string) => Promise<boolean>) | undefined;
}

interface Notification {
  lines: string[];
  /** Users the lines may ping. */
  users: string[];
  /** Whether the triage bot is called for the message. */
  callsTriage: boolean;
}

/** Who a post announces as its assignee: their Chatwoot user id, which a rename does not change; "" for none. */
export function assigneeKey(conversation: RelayConversation): string {
  const assigneeId = conversation.assignee?.id;
  return assigneeId ? String(assigneeId) : "";
}

/** The longest user mention (snowflakes have at most 20 digits). */
const LONGEST_MENTION = `<@${"9".repeat(20)}>`;

export class Notifier {
  /**
   * The most room the notification lines of a message can take, in UTF-16 units. Sized as when
   * the lines also mentioned the triage bot, so a message splits as it did before: a retry
   * resumes after the parts already posted.
   */
  readonly reserve: number;

  constructor(private readonly options: NotifierOptions) {
    const { triage } = options;
    const lines = [
      `-# ${LONGEST_MENTION} ${LONGEST_MENTION}`,
      ...(triage ? [conversationBudgetNote(triage), hourlyBudgetNote(triage), handledNote(triage)] : []),
    ];
    this.reserve = lines.reduce((sum, line) => sum + line.length + 1, 0);
  }

  /** The notification lines for a message; the same on every attempt at posting it. */
  async notification(message: RelayMessage): Promise<Notification> {
    if (!this.notifies(message)) return { lines: [], users: [], callsTriage: false };
    // While a new assignee waits for their announcement, which pings them, do not ping twice.
    const ping = fromCustomer(message) && !this.newAssignee(message.account.id, message.conversation);
    const assignee = ping ? this.linkedAssignee(message.conversation) : undefined;
    const triage = await this.triage(message);
    const lines = [assignee ? `-# <@${assignee}>` : undefined, triage.note].filter((line) => line !== undefined);
    return { lines, users: assignee ? [assignee] : [], callsTriage: triage.calls === true };
  }

  /**
   * Whether a message notifies: it is live (created within `liveSeconds`) and not an automatic
   * email reply.
   */
  notifies(message: RelayMessage): boolean {
    if (message.autoReply) return false;
    if (message.createdAt === undefined || message.createdAt === null) return true;
    return this.options.now().getTime() - message.createdAt * 1000 <= this.options.liveSeconds * 1000;
  }

  /**
   * When the conversation's assignee is not the one its post last announced, and is linked, their
   * Discord id: the announcement pings them (which also adds them to the post).
   */
  newAssignee(accountId: number, conversation: RelayConversation): string | undefined {
    const recorded = this.options.store.conversation(accountId, conversation.id);
    // A post without a recorded announcement (adopted from the link attribute, or its record was
    // cleared) cannot tell an unchanged assignee from a new one: do not ping. Its next
    // announcement records the current assignee.
    if (recorded?.threadId !== undefined && recorded.announcedAssignee === undefined) return undefined;
    if (recorded?.announcedAssignee === assigneeKey(conversation)) return undefined;
    return this.linkedAssignee(conversation);
  }

  /**
   * Whether the triage bot is called for a customer message, or a note when a routing kind
   * handled it or the bot's hourly budget is used up.
   */
  private async triage(message: RelayMessage): Promise<{ calls?: true; note?: string }> {
    const { triage, store } = this.options;
    if (!fromCustomer(message)) return {};
    if (!triage) return {};
    const { account, conversation } = message;
    // Decided and counted once per message: a retry after a failed post repeats the decision.
    const decision = store.once(`triage:${account.id}:${message.id}`, () => {
      if (conversation.status !== "open" || message.answered) return "answered";
      const hour = this.options.now().toISOString().slice(0, 13);
      const key = `${message.account.id}:${message.conversation.id}`;
      if (store.increment(`triage:${key}:${hour}`) > triage.perConversationPerHour) return "conversation";
      return `hour:${hour}`;
    });
    if (decision === "answered") return { note: handledNote(triage) };
    if (decision === "conversation") return { note: conversationBudgetNote(triage) };
    // Decided by an earlier version, which counted the hourly budget in its own store.
    if (decision === "hour") return { note: hourlyBudgetNote(triage) };
    if (decision === "mention") return { calls: true };
    const hour = decision.slice("hour:".length);
    const event = `${account.id}:${message.id}`;
    const reserve =
      this.options.reserveTriage ??
      (async () =>
        store.once(`triage-hour:${event}`, () => (store.increment(`triage:${hour}`) <= triage.perHour ? "1" : "")) ===
        "1");
    if (!(await reserve(hour, event))) return { note: hourlyBudgetNote(triage) };
    return { calls: true };
  }

  /** The linked Discord user of the conversation's assignee, if any. */
  private linkedAssignee(conversation: RelayConversation): string | undefined {
    const assigneeId = conversation.assignee?.id;
    return assigneeId ? this.options.linkedAgent?.(assigneeId)?.discordUserId : undefined;
  }
}

export function assignedLine(mention: string): string {
  return `-# Assigned to ${mention}`;
}

/** The triage bot's call: a literal mention, which never pings (the bot reads mentions of it). */
export function triageLine(triage: TriageOptions): string {
  return `-# <@${triage.userId}> Triage the customer's latest message.`;
}

function conversationBudgetNote(triage: TriageOptions): string {
  return `-# ${triage.name} not called: more than ${triage.perConversationPerHour} customer messages in this conversation this hour. Ask it here if needed.`;
}

function handledNote(triage: TriageOptions): string {
  return `-# ${triage.name} not called: handled automatically. Ask it here, if needed.`;
}

function hourlyBudgetNote(triage: TriageOptions): string {
  return `-# ${triage.name} not called: more than ${triage.perHour} customer messages this hour. Ask it here if needed.`;
}
