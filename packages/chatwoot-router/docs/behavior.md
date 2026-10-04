# Routing behavior

The precise rules the router follows, and the Chatwoot v4.18.0 contracts they rest on. The
[README](../README.md#how-it-works) has the overview.

Chatwoot owns the lifecycle: a conversation is the bot's while pending, and people's otherwise.

System One is TypeSafe's class of decision models, and Jev is its first model. The router calls TypeSafe's
System One API (`/v1/systemone`) with the model in `routing.model` (Jev by default). `routing.endpoint`
may point to another deployment of that API, for example a proxy or gateway.

- Each routed account has a configured brand bot. Routing is limited to inboxes linked to that exact account's
  bot, discovered through `GET inboxes/{id}/agent_bot`. The wrapped `agent_bot.id` and `account_id` must match;
  `agent_bot: null` or `agent_bot: {}` means unlinked. Foreign-account and system bots are rejected. The user token
  must see every routed inbox. Disconnecting an inbox stops classification/replies and hands any pending ticket still assigned to this bot to people. The API does not expose whether the
  association is inactive; disconnect to disable it. `routing.botIds` and both bot credential maps require
  exactly the routed account keys (see the [configuration reference](../README.md#configuration-reference)).
- Each conversation is routed by a `Router` Durable Object of its own, so a slow Jev or Chatwoot request for one
  conversation never delays another; one more `Router` object runs the sweep.
- Signed bot webhooks at `/chatwoot/agent-bot` enqueue a deduplicated conversation job. The five-minute sweep
  lists only **pending and open conversations in the account**, including disconnected inboxes, without an age
  cutoff. Pending tickets route or hand off; open tickets still assigned to the brand bot release that assignment
  with `POST assignments {assignee_id: null}`, preserving status after a fresh ownership read. Resolved/snoozed
  history is not scanned. Each status has its own persistent page cursor within the request budget. Failed pages
  retry. An empty page ends that status's pass; the next starts at page 1 and catches
  conversations skipped by changing pages. Neither event payloads nor sweep rows are decision inputs.
- Read messages newest-first, unfiltered (including activities), with `before` paging, at most five pages of 20.
  The latest `conversation_status_changed` activity begins the turn; without one or evidence it is missing, use
  the conversation's start. Take the first three usable customer texts after the boundary, oldest first. Include
  email subjects and reply text without quoted history; omit automatic email, deleted messages and private notes.
  Redact identifiers and contact names, then cap the input at 1,600 characters. Memoize Jev's decision by input ids.
- Status activity is asynchronous. The queue's boundary guard remembers an observed/expected transition and the
  last boundary needed to reject stale handoff work. An activity read before its first status webhook can match
  that webhook's status and time only if no existing expectation requires a newer activity. Merging a webhook
  never lowers or removes an expected boundary id. Once matched, a different transition requires an activity
  **after that boundary id**, even when the old activity has the same status and second-level timestamp. Repeated
  delivery of the same transition timestamp does not start another expectation. Only a status webhook supplies a transition time;
  a read observing pending end requires a newer activity without inferring a time from `updated_at`. The last
  pending observation survives retries, so a retry confirming resolution after a lost response retains that boundary.
  Other non-pending snapshots only release a remaining brand-bot assignment: metadata updates change `updated_at` without creating a status activity.
  An expected activity not yet present retries normally; an incomplete read or a deleted known boundary hands off.
  Permanently missing activity uses the same three-attempt limit. A new boundary clears the previous turn's failure
  count and handoff. Chatwoot exposes no turn API: a lost webhook plus permanently removed, never-observed activity
  cannot be reconstructed. Chatwoot writes activity only for a changed status with activity content; no-op status
  changes create none. Activities use job execution time, and customer/scheduled reopen usually creates none.
  A late activity ordered after new text does not license reading old text across the boundary; empty input hands off.
- Jev chooses owner, topic, kind and whether there is a request. A confident kind takes precedence; otherwise a
  confident greeting/no-request stays pending while fewer than three texts exist. Empty or identifier-only input,
  three greetings, an unclear owner with an actual request, or a public human reply hands off. Blocked contacts
  and person-assigned conversations are untouched during routing; disconnect handoff also clears blocked bot leftovers.
  Bot and user assignees are distinguished by `assignee_type`.
- Before **each** action, re-read the inbox link, pending status, assignee, turn boundary, inputs and public human
  replies. A changed input defers the job to decide again. Apply topic/kind labels, then the kind's canned reply,
  then end the turn: set the kind's resolved/snoozed status and immediately release the bot, assign a confident
  owner, or use explicit bot `status=open` handoff. Chatwoot keeps the bot on resolve/snooze, so release is part of
  that same ending, with a fresh ownership/status read. A failed release keeps the durable job for retry, even
  though the sweep excludes closed history. Clearing only the bot creates no assignment/status activity and does
  not move the turn boundary; Chatwoot still dispatches assignment/update events. Preserve human topic labels and
  validate that an owner still belongs to the account.
  Successful person assignment ends the turn without a bot-handoff reporting event; nothing follows it.
  Reopened resolved conversations can lack a bot assignee, in which case assignment would not open
  pending: use native handoff instead. Chatwoot has no atomic compare-and-write API for a change racing a mutation.
- Only canned replies have an action record, `reply:<account>:<conversation>`, kept across turns and upgrades.
  Before sending, read up to five unfiltered history pages (100 messages), past turn boundaries, for a public outgoing
  message (`message_type=1`, `private=false`, `sender.type=agent_bot`) from this account's exact configured bot id.
  A confirmed, non-deleted, non-failed reply counts as replied, including replies the old relay sent; preserve an
  observed record so later removal cannot permit a resend. A complete read to the beginning with none permits the
  first attempt; an incomplete/failed/ambiguous read or an existing attempt without a visible reply hands off.
  Record the attempt **before sending**. A failed POST, lost response, malformed receipt or failed/deleted reply
  persists handoff and never resolves/snoozes or resends. Only a valid creation receipt for this conversation or
  confirmed history permits the kind's ending status. This confirms creation in Chatwoot, not channel delivery;
  a delivery failure seen in the final fresh read also hands off. Labels, assignment and status use
  current Chatwoot state, without an effects ledger or custom coordination attributes. A missing canned response
  hands off immediately. After three processing failures (initial, +5s, +10s), persist handoff mode. Further retries
  only revalidate the turn and hand off, with backoff capped at 30 minutes. Handoff failures keep the job; deleted
  conversations end it. Disconnected brand-bot pending tickets use native bot `status=open` handoff without Jev
  or a turn-history read; failures retry until the handoff succeeds. Other bots and people are untouched. Credentials/service failures need repair before handoff can succeed.
- A Worker 2xx means the job is durable, not that routing succeeded. Chatwoot's own webhook failure fallback cannot
  cover later alarm failures. Its fallback opens pending on failed `message_created`/`message_updated` delivery unless
  `keep_pending_on_bot_failure` is enabled; it may leave a bot assignee on open. The router releases that assignment on its next job or sweep.
  Chatwoot makes three delivery attempts for 429/500 responses. Irrelevant valid bot events are acknowledged.
  There is no router account-webhook endpoint.

After handoff, later customer messages belong to people. Resolved tickets reopen pending in an active bot inbox
and are decided on their **new turn's** messages. Snoozed tickets reopen open and go to people. A canned reply
following a customer message counts as answering it in the relay, even if that message was outside Jev's window.

The API contracts were checked against Chatwoot v4.18.0:
[assignment service](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/services/conversations/assignment_service.rb)
and [controller](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/controllers/api/v1/accounts/conversations/assignments_controller.rb),
[status changes](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/controllers/api/v1/accounts/conversations_controller.rb),
[activity creation](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/models/concerns/activity_message_handler.rb)
and its [job](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/jobs/conversations/activity_message_job.rb),
[message paging](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/finders/message_finder.rb),
[message creation](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/builders/messages/message_builder.rb),
[message JSON](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/views/api/v1/models/_message.json.jbuilder),
[bot sender](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/models/agent_bot.rb),
[account access](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/controllers/concerns/ensure_current_account_helper.rb),
[conversation access](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/policies/conversation_policy.rb),
[inbox bot response](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/views/api/v1/accounts/inboxes/agent_bot.json.jbuilder),
[assignees/timestamps](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/presenters/conversations/event_data_presenter.rb),
[token permissions](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/controllers/concerns/access_token_auth_helper.rb),
[bot events](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/listeners/agent_bot_listener.rb), and
[webhook fallback](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/lib/webhooks/trigger.rb).
