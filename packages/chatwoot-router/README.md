# chatwoot-router

A native Chatwoot agent bot that uses [TypeSafe's System One API](https://docs.typesafe.ai) to assign owners, add topic and
kind labels, send canned responses, and resolve or snooze tickets. Runs on Cloudflare Workers independently
of [chatwoot-discord-relay](https://github.com/Phala-Network/chatwoot-workers/tree/main/packages/chatwoot-discord-relay). The Workers coordinate through Chatwoot status.

## How it works

Chatwoot owns the lifecycle: a conversation is the bot's while it is pending, and people's otherwise. The router
is each routed account's native agent bot, connected to the inboxes it should route.

1. A new ticket in a connected inbox is pending, so Chatwoot sends its events to the router's
   `/chatwoot/agent-bot` webhook. Each conversation is routed by a Durable Object of its own, so a slow request
   for one conversation never delays another.
2. The router reads the customer's first messages of this turn (redacted, at most three and 1,600 characters)
   and asks TypeSafe's System One API (`/v1/systemone`, model `routing.model`, Jev by default; `routing.endpoint`
   may point to another deployment) for the owner, topic, kind, and whether there is a request yet.
3. It applies the topic and kind labels, sends the kind's canned reply if it has one (at most once per
   conversation), and ends the turn: the kind's resolved or snoozed status, the confident owner, or a handoff to
   people (`status=open`). A greeting with no request yet stays pending until the customer says more. A resolved
   ticket that a customer message reopens keeps its owner: its kind may still end it (a thanks is resolved),
   otherwise it goes back to the owner.
4. Anything uncertain hands off to people: an unclear owner, a failed or unconfirmed reply, a human replying,
   three failed attempts. Disconnecting an inbox's bot hands its pending tickets to people.
5. A sweep every five minutes lists pending and open conversations, so a missed webhook is caught up and a bot
   assignment left on an open ticket is released.

[Routing behavior](https://github.com/Phala-Network/chatwoot-workers/blob/main/packages/chatwoot-router/docs/behavior.md) has the precise rules and the Chatwoot contracts they rest on.

## Deploy

Use Node 24 (24.15 or newer), npm 12.1.0, and the Cloudflare CLI `cf`. From this repository, run inside Docker:

```sh
npm ci
cd packages/chatwoot-router
npm run typecheck
npm test
npm run build
npx cf deploy --prebuilt --dry-run
```

Edit `cloudflare.config.ts` with your non-secret settings. Keep required secrets out of source control;
`.dev.vars.example` lists placeholders. For local development copy it to `.dev.vars` and use `npm run dev`.
A maintainer deploys with `npx cf deploy --secrets-file <private-file>`.
The default Worker name is `chatwoot-router`; it exports one SQLite Durable Object, `Router`, bound as `ROUTER`.
Keep the `*/5 * * * *` cron trigger for reconciliation. `GET /healthz` returns 200 for a valid, readable
configuration and 503 otherwise; it does not test upstream credentials or connectivity.

For a private deployment repository, depend on the public `chatwoot-router` npm package plus `cf`, Vite, and
`@cloudflare/vite-plugin`. Its Worker entry is:

```ts
export { default, Router } from "chatwoot-router";
```

Use the same `cloudflare.config.ts` and `vite.config.ts` structure as this package. Pin compatible tooling versions
from the workspace and root manifests. Declare `Router` with `exports.durableObject({ storage: "sqlite" })`, bind it as
`ROUTER`, declare required secrets with `bindings.secret()`, and put `CONFIG` in `bindings.json(...)`.

For a configuration larger than a Worker JSON binding, use immutable KV configuration instead:

```sh
npx cf kv namespaces create --title chatwoot-router-config
npx chatwoot-router-store-config config.jsonc --namespace-id <namespace-id>
```

```ts
import { storedConfig } from "chatwoot-router/stored-config";
```

Set `CONFIG_STORE: bindings.kv({ id: "<namespace-id>" })` and
`CONFIG_KEY: bindings.text(storedConfig("config.jsonc").key)` in the Worker's `env`, removing `CONFIG`.
The CLI validates JSONC, uploads through the deployment project's `cf`, and prints the content-addressed key.
Keep older keys for rollbacks. The JavaScript and type declarations in each npm tarball are self-contained;
no unpublished shared package needs installing.

## Chatwoot setup

1. Give `CHATWOOT_TOKEN`'s user access to every routed inbox (membership or account administrator).
2. Create a brand agent bot in each account. Set its webhook URL to `https://<router>/chatwoot/agent-bot` and put its
   id in `routing.botIds`, access token in `CHATWOOT_AGENT_BOT_TOKENS`, and bot webhook secret in
   `CHATWOOT_AGENT_BOT_SECRETS`. All three maps must name exactly the routed accounts. Account webhook secrets
   are different credentials. Bot signatures use HMAC-SHA256 of `<timestamp>.<raw body>`, a ±5-minute window,
   and account matching. Valid irrelevant events are acknowledged without actions.
3. Create topic and kind labels and any canned responses in Chatwoot. Canned responses use their short codes and
   are read at send time; customers see the brand bot's name. Chatwoot expands its normal message variables.
4. After deploying both Workers, connect each bot to the inboxes it routes. No `routing_*` custom attributes or
   definitions are needed. For the relay's Manage card, list every kind name in `router.keepLabels`.

## Configuration reference

`CONFIG` accepts a JSON object or JSON string, or use `CONFIG_STORE` + `CONFIG_KEY` instead. Do not set both.

```json
{
  "chatwoot": { "baseUrl": "https://chatwoot.example.com" },
  "routing": {
    "botIds": { "1": 1 },
    "accounts": {
      "1": {
        "support": { "assignee": 6, "covers": "Product support, billing, and account access." },
        "sales": { "assignee": 7, "covers": "Sales questions and purchase enquiries." }
      }
    },
    "topics": { "billing": "Invoices and payments.", "technical": "Product troubleshooting." },
    "minConfidence": 0.7,
    "kinds": { "1": { "spam": { "covers": "Unsolicited advertising.", "status": "resolved" } } }
  }
}
```

| Setting | Type | Default | Meaning |
| --- | --- | --- | --- |
| `chatwoot.baseUrl` | HTTP(S) URL | required | Final Chatwoot API URL; redirects are refused. |
| `subrequestBudget` | integer 45–1000 | `45` | Per-alarm outbound budget; reserve 45 for a bounded turn read and all actions. |
| `routing.endpoint` | HTTPS URL | `https://api.typesafe.ai/v1/systemone` | TypeSafe's System One API endpoint; may point to another deployment of that API, for example a proxy or gateway. Redirects are refused. |
| `routing.model` | non-empty string | `jev-1.13.0` | Model sent to TypeSafe's System One API; Jev by default. |
| `routing.minConfidence` | number 0.5–1 | `0.7` | Probability an answer needs before it is applied. |
| `routing.botIds` | object: account id → positive safe integer | required | Brand bot id for every routed account, and no others. |
| `routing.accounts` | object: account id → (owner name → owner) | required | Routed accounts and the owners Jev chooses from. Owner names are 1–40 lower-case letters, digits, or `_`; `unclear` is reserved. |
| `routing.accounts.<id>.<name>.assignee` | integer > 0 | required | Chatwoot user id to assign. |
| `routing.accounts.<id>.<name>.covers` | 1–1000 characters | required | What the owner handles: Jev's criterion for choosing them. |
| `routing.topics` | object: label → what it covers | unset | Topic labels (Chatwoot label names, lower case) Jev chooses from; one is added when a ticket has no label other than its kinds (an automation rule's label is kept alone). The separate relay can display them using its `forumTags` configuration. Unset: no topic. |
| `routing.kinds` | object: account id → (kind name → kind) | unset | Kinds of ticket Jev recognizes in routed accounts, added as labels beside the topic, and what is done once when it does ([How it works](#how-it-works)). Kind names are the account's label names (1–40 lower-case letters, digits, `_`, or `-`); `none` is reserved. Unset: none. |
| `routing.kinds.<id>.<name>.covers` | 1–1000 characters | required | What the kind is: Jev's criterion for recognizing it. |
| `routing.kinds.<id>.<name>.cannedResponse` | short code | unset | The account's Chatwoot canned response sent to the customer once, by the account's agent bot (`CHATWOOT_AGENT_BOT_TOKENS`); handoff if it is missing. |
| `routing.kinds.<id>.<name>.status` | `resolved` or `snoozed` | unset | Set instead of routing the ticket (`snoozed`: until the customer's next message), after the reply of a `cannedResponse`; a new customer message reopens it. |

### Secrets

| Secret | Required | Meaning |
| --- | --- | --- |
| `CHATWOOT_TOKEN` | Yes | User token for messages, canned responses, inbox discovery and sweep. Must see every routed inbox. |
| `CHATWOOT_AGENT_BOT_TOKENS` | Yes | JSON object of bot access tokens by account id, e.g. `{"1":"<token>"}`. All mutations use the bot token. |
| `CHATWOOT_AGENT_BOT_SECRETS` | Yes | JSON object of bot webhook secrets by account id, e.g. `{"1":"<secret>"}`. |
| `TYPESAFE_API_KEY` | Yes | TypeSafe API key for System One API requests. |

Both bot-secret maps require nonempty values and exactly the `routing.accounts` keys. Missing/invalid entries
fail startup; `/healthz` returns 503 without credentials in its response. All secrets use `bindings.secret()`.

## Upgrade and rollback

Keep Worker names, Durable Object namespaces/storage and old KV configuration keys. The Router DO holds
permanent reply attempts/observed records and turn guards as well as jobs and decisions. Message history cannot
rebuild an unknown attempt, an observed reply since deleted, or a missing turn boundary. Do not delete or recreate
the Router DO during rollback. If its state is lost or restored to an older recovery point, keep bots disconnected
and isolate conversations with uncertain attempts/turns for owner review; a currently empty history does not
prove another send is safe. Existing pending conversations are reconciled; non-pending conversations stay with people. The user token must see all relevant inboxes.

For the first move from the relay's built-in routing (production baseline 0.27.0):

1. Record the live relay deployment/version id and CONFIG_KEY before rollout; retain its Hub and old secrets.
   Disconnect all brand bots and prevent competing old deployments. Verify bot identities, owner membership,
   labels, canned responses and inbox visibility. Historical confirmed brand-bot replies need no ledger migration.
2. Deploy and verify relay 0.30 first. Remove `routing`, `router.accounts` and `router.waitSeconds`; keep every kind
   in `router.keepLabels`. Verify the actual version and that built-in routing/in-flight old work stopped.
3. Bootstrap this Worker by hand with all four secrets in a protected secrets file while bots remain disconnected.
   Verify KV/domain, upstream permissions and test tickets; health/2xx alone do not prove routing success.
   If using an infra PR whose push deploys both Workers independently, merge only after both hand deployments pass.
4. Connect bots one account at a time and verify real routing, handoff, failed/unknown reply handling, historical
   reply deduplication and Discord/triage behavior, including at least a complete sweep.
5. To roll back, disconnect bots first and **keep this router running until no pending ticket remains assigned to
   a disconnected brand bot and no non-pending ticket remains assigned to that bot**. Complete pending/open
   account passes and let failed ending releases finish through their durable retries: pending uses native bot
   handoff, open leftovers use explicit unassignment, and kind endings release resolved/snoozed tickets in the
   same turn. Confirm cleared bot ownership across statuses; preserve human/other-bot owners. Then stop
   webhook entry, cron and queued/in-flight router work; stopping cron alone does not cancel DO alarms. Preserve DO
   namespace and storage, including reply and turn guards. Restore the recorded live 0.27 version **and its
   CONFIG_KEY**, without overlapping old/new routing. Relay 0.27 uses its original Hub's
   `kind-reply:<account>:<conversation>` records; the Router uses separate `reply:<account>:<conversation>`
   records. Restoring code/config does not copy Router attempts into the Hub or reset either ledger. Only replies
   already recorded by 0.27 retain its own reply-once protection; Router-only replies/unknown attempts can be
   attempted again by 0.27. Keep both DOs and review/isolate those tickets before restoring old routing. Rollback
   does not guarantee reply-once across this switch or undo sent messages or other mutations.

Current router upgrades need no custom coordination attributes, compatibility effects or one-time lifecycle
cleanup. Older unreadable job payloads are dropped; live snapshots and the account sweep reconstruct queued work, not durable reply/turn guards.
If handoff credentials fail, repair them or let a real owner take the tickets; do not bulk-open with the integration
user token, which can assign every ticket to that user. Keep old attributes through the owner's rollback window.

Redaction is best effort, not anonymization: other personal information can still reach TypeSafe. Logs contain
ids and outcomes, never message bodies or credentials. See [SECURITY.md](https://github.com/Phala-Network/chatwoot-workers/blob/main/SECURITY.md),
[CONTRIBUTING.md](https://github.com/Phala-Network/chatwoot-workers/blob/main/CONTRIBUTING.md) and [CHANGELOG.md](https://github.com/Phala-Network/chatwoot-workers/blob/main/packages/chatwoot-router/CHANGELOG.md). Licensed under [MIT](https://github.com/Phala-Network/chatwoot-workers/blob/main/packages/chatwoot-router/LICENSE).
