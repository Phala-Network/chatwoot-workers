import {
  createExecutionContext,
  createScheduledController,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commandRegistrationHash, commandRegistrationPayload } from "../src/commands/registration.ts";
import { Hub, hub } from "../src/hub.ts";
import worker from "../src/index.ts";
import { Store } from "../src/store.ts";
import { json, mockFetch, on, testSettings } from "./helpers.ts";

const API = "discord.com/api/v10";
const APP = "100000000000000001";
const FORUM = "100000000000000055";
const GUILD = "100000000000000044";
const HASH_KEY = "discord:commands:hash";
const application = on("GET", `${API}/applications/@me`, () => json({ id: APP }));
const forum = on("GET", `${API}/channels/${FORUM}`, () => json({ guild_id: GUILD }));

async function withHub(run: (instance: Hub, store: Store) => Promise<void>, config = testSettings().config) {
  await runInDurableObject(env.HUB.getByName(`registration-${crypto.randomUUID()}`), (_instance, state) =>
    run(
      new Hub(state, {
        ...env,
        CONFIG: config,
        CHATWOOT_WEBHOOK_SECRETS: JSON.stringify(Object.fromEntries(config.accounts.map(({ id }) => [id, "secret"]))),
      }),
      new Store(state.storage.sql),
    ),
  );
}

afterEach(async () => {
  // The scheduled-handler test also requests a real sweep; let its empty pages finish.
  await vi.waitFor(async () => {
    await runInDurableObject(hub(env), (_instance, state) => {
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM jobs").one().n).toBe(0);
    });
  });
  await runInDurableObject(hub(env), async (_instance, state) => {
    state.storage.sql.exec("DELETE FROM cache");
    await state.storage.deleteAlarm();
  });
  vi.restoreAllMocks();
});

describe("guild command registration", () => {
  it("makes no Discord calls when commands and forums are unchanged, regardless of order or duplicates", async () => {
    const otherForum = "100000000000000056";
    const config = testSettings({
      accounts: [
        { id: 3, name: "Acme", forumChannelId: otherForum },
        { id: 1, name: "Globex", forumChannelId: FORUM },
      ],
    }).config;
    const { requests } = mockFetch();
    await withHub(async (instance, store) => {
      const hash = await commandRegistrationHash(commandRegistrationPayload(), [FORUM, otherForum, FORUM]);
      store.set(HASH_KEY, hash);
      await instance.registerCommands();
      expect(requests).toEqual([]);
      expect(store.get(HASH_KEY)).toBe(hash);
    }, config);
  });

  it("registers unchanged commands in every guild when a configured forum is added", async () => {
    const otherForum = "100000000000000056";
    const otherGuild = "100000000000000045";
    const config = testSettings({
      accounts: [
        { id: 3, name: "Acme", forumChannelId: FORUM },
        { id: 1, name: "Globex", forumChannelId: otherForum },
      ],
    }).config;
    const { requests } = mockFetch(
      application,
      forum,
      on("GET", `${API}/channels/${otherForum}`, () => json({ guild_id: otherGuild })),
      on("PUT", new RegExp(`^discord\\.com/api/v10/applications/${APP}/guilds/\\d+/commands$`), () => json([])),
    );
    await withHub(async (instance, store) => {
      const payload = commandRegistrationPayload();
      store.set(HASH_KEY, await commandRegistrationHash(payload, [FORUM]));
      await instance.registerCommands();
      const puts = requests.filter(({ method }) => method === "PUT");
      expect(puts.map(({ url }) => url.pathname)).toEqual([
        `/api/v10/applications/${APP}/guilds/${GUILD}/commands`,
        `/api/v10/applications/${APP}/guilds/${otherGuild}/commands`,
      ]);
      expect(puts.map(({ body }) => body)).toEqual([JSON.stringify(payload), JSON.stringify(payload)]);
      expect(store.get(HASH_KEY)).toBe(await commandRegistrationHash(payload, [FORUM, otherForum]));
    }, config);
  });

  it("overwrites once per guild, deduplicates forums, and stores the registration hash after every PUT", async () => {
    const otherForum = "100000000000000056";
    const thirdForum = "100000000000000057";
    const otherGuild = "100000000000000045";
    const config = testSettings(
      {
        accounts: [
          { id: 3, name: "Acme", forumChannelId: FORUM },
          { id: 1, name: "Globex", forumChannelId: FORUM },
          { id: 2, name: "Example", forumChannelId: otherForum },
          { id: 4, name: "Sample", forumChannelId: thirdForum },
        ],
      },
      { CHATWOOT_WEBHOOK_SECRETS: '{"1":"secret","2":"secret","3":"secret","4":"secret"}' },
    ).config;
    await withHub(async (instance, store) => {
      store.set(HASH_KEY, "previous-payload");
      const { requests } = mockFetch(
        application,
        forum,
        on("GET", `${API}/channels/${otherForum}`, () => json({ guild_id: GUILD })),
        on("GET", `${API}/channels/${thirdForum}`, () => json({ guild_id: otherGuild })),
        on("PUT", new RegExp(`^discord\\.com/api/v10/applications/${APP}/guilds/\\d+/commands$`), () => {
          expect(store.get(HASH_KEY)).toBe("previous-payload");
          return json([]);
        }),
      );
      await instance.registerCommands();
      expect(requests.map(({ method, url }) => `${method} ${url.pathname}`)).toEqual([
        "GET /api/v10/applications/@me",
        `GET /api/v10/channels/${FORUM}`,
        `GET /api/v10/channels/${otherForum}`,
        `GET /api/v10/channels/${thirdForum}`,
        `PUT /api/v10/applications/${APP}/guilds/${GUILD}/commands`,
        `PUT /api/v10/applications/${APP}/guilds/${otherGuild}/commands`,
      ]);
      const puts = requests.filter(({ method }) => method === "PUT");
      const body = JSON.stringify(commandRegistrationPayload());
      expect(puts.map(({ body }) => body)).toEqual([body, body]);
      expect(store.get(HASH_KEY)).toBe(
        await commandRegistrationHash(
          commandRegistrationPayload(),
          config.accounts.map(({ forumChannelId }) => forumChannelId),
        ),
      );
      expect(requests.every(({ headers }) => headers.get("authorization") === "Bot test-bot-token")).toBe(true);
    }, config);
  });

  it("keeps the previous hash after a partial failure and retries every guild next time", async () => {
    const otherForum = "100000000000000056";
    const otherGuild = "100000000000000045";
    const config = testSettings({
      accounts: [
        { id: 3, name: "Acme", forumChannelId: FORUM },
        { id: 1, name: "Globex", forumChannelId: otherForum },
      ],
    }).config;
    let fail = true;
    const { requests } = mockFetch(
      application,
      forum,
      on("GET", `${API}/channels/${otherForum}`, () => json({ guild_id: otherGuild })),
      on("PUT", `${API}/applications/${APP}/guilds/${GUILD}/commands`, () => json([])),
      on("PUT", `${API}/applications/${APP}/guilds/${otherGuild}/commands`, () =>
        fail ? json({ message: "Missing Access", code: 50001 }, { status: 403 }) : json([]),
      ),
    );
    await withHub(async (instance, store) => {
      store.set(HASH_KEY, "previous-payload");
      await expect(instance.registerCommands()).resolves.toBeUndefined();
      expect(store.get(HASH_KEY)).toBe("previous-payload");
      fail = false;
      await instance.registerCommands();
      expect(requests.filter(({ method }) => method === "PUT")).toHaveLength(4);
      expect(store.get(HASH_KEY)).toBe(
        await commandRegistrationHash(
          commandRegistrationPayload(),
          config.accounts.map(({ forumChannelId }) => forumChannelId),
        ),
      );
    }, config);
  });

  it("requests the hourly queue while registration is still pending and contains a PUT failure", async () => {
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    const queueRequest = vi.spyOn(Hub.prototype, "requestQueue");
    await runInDurableObject(hub(env), (_instance, state) => {
      new Store(state.storage.sql).set(HASH_KEY, "previous-payload");
    });
    mockFetch(
      application,
      forum,
      on("PUT", `${API}/applications/${APP}/guilds/${GUILD}/commands`, () => {
        started.resolve();
        return response.promise;
      }),
      on("GET", /^chatwoot\.example\.com\/api\/v1\/accounts\/\d+\/conversations$/, () =>
        json({ data: { meta: {}, payload: [] } }),
      ),
    );
    const ctx = createExecutionContext();
    await worker.scheduled?.(
      createScheduledController({ cron: "*/5 * * * *", scheduledTime: Date.UTC(2026, 9, 13, 0, 0) }),
      env,
      ctx,
    );
    try {
      await started.promise;
      await vi.waitFor(() => expect(queueRequest).toHaveBeenCalledTimes(1));
    } finally {
      response.resolve(json({ message: "Missing Access", code: 50001 }, { status: 403 }));
    }
    await expect(waitOnExecutionContext(ctx)).resolves.toBeUndefined();
    await runInDurableObject(hub(env), (_instance, state) => {
      expect(new Store(state.storage.sql).get(HASH_KEY)).toBe("previous-payload");
    });
  });

  it("does not save a hash when a configured channel has no guild", async () => {
    const { requests } = mockFetch(
      application,
      on("GET", `${API}/channels/${FORUM}`, () => json({ type: 1 })),
    );
    await withHub(async (instance, store) => {
      await instance.registerCommands();
      expect(requests.filter(({ method }) => method === "PUT")).toEqual([]);
      expect(store.get(HASH_KEY)).toBeUndefined();
    });
  });

  it("stops at the invocation's subrequest budget without recording success", async () => {
    const accounts = Array.from({ length: 45 }, (_, index) => ({
      id: index + 1,
      name: `Account ${index + 1}`,
      forumChannelId: String(200000000000000000n + BigInt(index)),
    }));
    const config = testSettings(
      { accounts },
      { CHATWOOT_WEBHOOK_SECRETS: JSON.stringify(Object.fromEntries(accounts.map(({ id }) => [id, "secret"]))) },
    ).config;
    const { requests } = mockFetch(
      application,
      on("GET", /^discord\.com\/api\/v10\/channels\/\d+$/, () => json({ guild_id: GUILD })),
    );
    await withHub(async (instance, store) => {
      await instance.registerCommands();
      expect(requests).toHaveLength(config.relay.subrequestBudget);
      expect(store.get(HASH_KEY)).toBeUndefined();
    }, config);
  });
});
