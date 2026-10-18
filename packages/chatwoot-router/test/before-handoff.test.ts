import { afterEach, describe, expect, it, vi } from "vitest";
import { Budget } from "../../../shared/budget.ts";
import { beforeHandoff } from "../src/before-handoff.ts";
import { testSettings } from "./helpers.ts";
import { BEFORE_HANDOFF_SECRET, ROUTING } from "./world.ts";

afterEach(() => vi.useRealTimers());

describe("before-handoff timeout", () => {
  it("aborts through the Durable Object budget at the hook timeout", async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const hanging = (request: Request) =>
      new Promise<Response>((_resolve, reject) => {
        started();
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      });
    const settings = testSettings(
      {
        routing: { ...ROUTING, beforeHandoff: { url: "https://hooks.example.com/before-handoff", timeoutSeconds: 1 } },
      },
      { BEFORE_HANDOFF_SECRET },
    );
    const budget = new Budget(2, hanging, 60_000);
    const pending = beforeHandoff({ settings, fetch: budget.fetch }, 1, 5, 0, {
      contact: { email: null, blocked: false },
      channel: null,
      hmacVerified: null,
    });
    const rejection = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    await requestStarted;
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(budget.remaining).toBe(1);
  });
});
