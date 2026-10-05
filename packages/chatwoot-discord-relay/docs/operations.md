# Operations

Installing on a Chatwoot that already has conversations, replacing another relay, recovering
state, and running without Cloudflare. See the [README](../README.md) for the setup itself.

## Installing on an existing Chatwoot

Conversations with activity within `reconcile.lookbackSeconds` get a post from the first sweep;
older ones get a post with their next message. A new post relays the conversation's whole
history; its messages older than `reconcile.lookbackSeconds` notify no one (see
[Pings and notifications](relay.md#pings-and-notifications)).
To start with new messages only, set `relay.startAfterMessageId` to the newest message id in
Chatwoot when you install (for example the id in the newest conversation's `messages` from
`GET /api/v1/accounts/<id>/conversations`).

## Cutover from an existing relay

If posts already exist (for example from another relay), the service must not open a second
post for those conversations.

1. Store each existing post URL in its conversation's `discord_thread` attribute
   (`https://discord.com/channels/<guild id>/<thread id>`). A conversation without a mapping
   adopts the linked post if it still exists in that account's forum.
2. Set `relay.startAfterMessageId` to the last message id the other relay handled. Adopted posts
   and new conversations only relay messages after it. (With `0`, adopted posts continue after
   their latest message.)
3. Stop the other relay, deploy this service, and point the Chatwoot webhooks at it. The sweep
   catches up on anything changed in the meantime.

## Upgrading from a version with one Hub (0.30.0 and earlier)

Upgrade to 0.35.1 first and let its hand-over finish (it logs `legacy hand-over done`): that release
moves what the single Hub recorded about each conversation into the conversation's own object. Later
releases keep only the Hub's index of posts and drop the rest. Coming from 0.28.0 or earlier, also
follow the 0.29.0 and 0.30.0 upgrade notes in the [changelog](../CHANGELOG.md).

## State and recovery

Each conversation's state (its post, how far it is relayed, the Discord ids of posted messages, its
job queue) is in its own Durable Object's SQLite database; which conversation each post belongs to,
the sweep's progress and the triage budget are in the Hub's. Restore them, if lost or damaged, with
Durable Objects'
[point-in-time recovery](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)
(any point in the last 30 days).

Without that, a new database recovers each post from the conversation's link attribute on the
conversation's next run, but not how far it was relayed: with `relay.startAfterMessageId` 0 an
adopted post continues after the conversation's latest message (messages not yet relayed are
skipped), and with a watermark it relays everything after the watermark again (duplicates).
The Discord ids of posted messages are gone, so messages deleted in Chatwoot later stay in
Discord.

## Self-hosting without Cloudflare

Self-hosting without Cloudflare is possible with the open-source
[workerd](https://github.com/cloudflare/workerd) runtime (Durable Objects with SQLite and alarms
are supported); you provide TLS, the cron trigger, and storage persistence.
