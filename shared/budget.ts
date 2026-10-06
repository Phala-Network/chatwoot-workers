// Counts outbound requests so a Durable Object invocation stays under the Workers subrequest
// limit (50 per invocation on the Free plan). Work checks `remaining` before starting a unit
// that must not be cut in half, and yields to a fresh invocation when it is low. Every request
// also gets a timeout (fetch only takes one as an AbortSignal): a request that never answers
// would otherwise hold the alarm, and with it the whole queue, until the runtime ends it.

import type { Fetch } from "./chatwoot/api.ts";

export class BudgetExhaustedError extends Error {
  constructor() {
    super("Subrequest budget for this invocation is used up");
    this.name = "BudgetExhaustedError";
  }
}

/**
 * How long a request may take, response body included. Generous for the largest transfers (a
 * 50 MB command upload to Chatwoot); a request that times out fails like a network error.
 */
const REQUEST_TIMEOUT_MS = 60_000;

export class Budget {
  private used = 0;

  constructor(
    readonly limit: number,
    private readonly fetchImpl: Fetch = (request) => fetch(request),
    private readonly timeoutMs = REQUEST_TIMEOUT_MS,
  ) {}

  get remaining(): number {
    return this.limit - this.used;
  }

  /** Counts a request that is not a fetch, such as a call to another Durable Object. */
  consume(): void {
    if (this.used >= this.limit) throw new BudgetExhaustedError();
    this.used += 1;
  }

  /** Counts the request and gives up after REQUEST_TIMEOUT_MS (see `within`). */
  readonly fetch: Fetch = (request) => this.within(this.timeoutMs)(request);

  /**
   * Counts each request and gives up after `timeoutMs`, for a request on a path that must not wait long. The timeout
   * is cleared once the response body has been read (or there is none): a pending timer, such as
   * `AbortSignal.timeout`'s, keeps the invocation open until it fires.
   */
  within(timeoutMs: number): Fetch {
    return async (request) => {
      if (this.used >= this.limit) throw new BudgetExhaustedError();
      this.used += 1;
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new DOMException("The request timed out", "TimeoutError")),
        timeoutMs,
      );
      try {
        const response = await this.fetchImpl(new Request(request, { signal: controller.signal }));
        if (!response.body) {
          clearTimeout(timer);
          return response;
        }
        const body = response.body.pipeThrough(new TransformStream({ flush: () => clearTimeout(timer) }));
        return new Response(body, response);
      } catch (error) {
        clearTimeout(timer);
        throw error;
      }
    };
  }
}
