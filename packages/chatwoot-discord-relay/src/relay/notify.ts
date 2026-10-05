// Who a relayed message notifies: the linked assignee's ping on customer messages, as a line
// added to its last part. Also who a post announces as newly assigned, and whether the triage bot
// is called for the customer's latest message (within its hourly budgets, and not when a reply
// answered it or the ticket is no longer open; a note says why it is not). Relay posts the
// announcement, the note, and the call after the live messages of a run. Only live messages
// notify; history relayed later (the first sync of an older conversation, a catch-up after
// downtime) and automatic email replies are posted without them.

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
   * Counts a call `event` against the hourly budget shared by every conversation, once per event;
   * false when the budget of `hour` is used up. Unset: counted in `store`.
   */
  reserveTriage?: ((hour: string, event: string) => Promise<boolean>) | undefined;
}

interface Notification {
  lines: string[];
  /** Users the lines may ping. */
  users: string[];
}

/** The triage bot is called, or a note says why it is not. */
export type TriageDecision = { call: true } | { note: string };

/** Who a post announces as its assignee: their Chatwoot user id, which a rename does not change; "" for none. */
export function assigneeKey(conversation: RelayConversation): string {
  const assigneeId = conversation.assignee?.id;
  return assigneeId ? String(assigneeId) : "";
}

/** The longest user mention (snowflakes have at most 20 digits). */
const LONGEST_MENTION = `<@${"9".repeat(20)}>`;

export class Notifier {
  /** The room kept on a message for its notification line (the assignee's ping), in UTF-16 units. */
  readonly reserve = `\n-# ${LONGEST_MENTION}`.length;

  constructor(private readonly options: NotifierOptions) {}

  /** The notification lines for a message; the same on every attempt at posting it. */
  async notification(message: RelayMessage): Promise<Notification> {
    if (!this.notifies(message)) return { lines: [], users: [] };
    // While a new assignee waits for their announcement, which pings them, do not ping twice.
    const ping = fromCustomer(message) && !this.newAssignee(message.account.id, message.conversation);
    const assignee = ping ? this.linkedAssignee(message.conversation) : undefined;
    return assignee ? { lines: [`-# <@${assignee}>`], users: [assignee] } : { lines: [], users: [] };
  }

  /** Whether a message is one the triage bot may be called for: a live customer message, with a triage bot set. */
  callsTriage(message: RelayMessage): boolean {
    return this.options.triage !== undefined && fromCustomer(message) && this.notifies(message);
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
   * Whether the triage bot is called for customer message `messageId`, the latest of the run, or
   * the note that says why not: a reply `answered` it, the conversation is no longer open, or a
   * budget is used up. Decided and counted once per message, so a retry repeats the decision.
   */
  async triage(accountId: number, conversation: RelayConversation, messageId: number, answered: boolean) {
    const { triage, store } = this.options;
    if (!triage) return undefined;
    const decision = store.once(`triage:${accountId}:${messageId}`, () => {
      if (conversation.status !== "open" || answered) return "answered";
      const hour = this.options.now().toISOString().slice(0, 13);
      if (store.increment(`triage:${accountId}:${conversation.id}:${hour}`) > triage.perConversationPerHour) {
        return "conversation";
      }
      return `hour:${hour}`;
    });
    const note = (text: string): TriageDecision => ({ note: text });
    if (decision === "answered") return note(handledNote(triage));
    if (decision === "conversation") return note(conversationBudgetNote(triage));
    const hour = decision.slice("hour:".length);
    const event = `${accountId}:${messageId}`;
    const reserve =
      this.options.reserveTriage ??
      (async () =>
        store.once(`triage-hour:${event}`, () => (store.increment(`triage:${hour}`) <= triage.perHour ? "1" : "")) ===
        "1");
    if (!(await reserve(hour, event))) return note(hourlyBudgetNote(triage));
    return { call: true } as const;
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
  return `-# ${triage.name} not called: called ${triage.perConversationPerHour} times in this conversation this hour. Ask it here if needed.`;
}

function handledNote(triage: TriageOptions): string {
  return `-# ${triage.name} not called: the customer was answered, or the ticket is not open. Ask it here if needed.`;
}

function hourlyBudgetNote(triage: TriageOptions): string {
  return `-# ${triage.name} not called: called ${triage.perHour} times this hour. Ask it here if needed.`;
}
