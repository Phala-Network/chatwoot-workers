import { afterEach, describe, expect, it, vi } from "vitest";
import { Budget } from "../../../shared/budget.ts";

afterEach(() => vi.restoreAllMocks());

describe("request budget", () => {
  it("clears a request's timeout once its body is read, so nothing keeps the invocation open", async () => {
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    const budget = new Budget(2, async () => new Response("ok"));
    const response = await budget.fetch(new Request("https://example.com/"));
    expect(cleared).not.toHaveBeenCalled();
    expect(await response.text()).toBe("ok");
    expect(cleared).toHaveBeenCalledTimes(1);

    await budget.fetch(new Request("https://example.com/"));
    expect(budget.remaining).toBe(0);
    await expect(budget.fetch(new Request("https://example.com/"))).rejects.toThrow("used up");
  });

  it("clears it at once for a response without a body", async () => {
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    const response = await new Budget(1, async () => new Response(null, { status: 204 })).fetch(
      new Request("https://example.com/"),
    );
    expect(response.status).toBe(204);
    expect(cleared).toHaveBeenCalledTimes(1);
  });
});
