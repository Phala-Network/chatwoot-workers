import { errorFields, log } from "../../../shared/log.ts";
import type { Settings } from "./config.ts";

const encoder = new TextEncoder();

export interface BeforeHandoffConversation {
  contact: { email?: string | null; blocked?: boolean };
  channel?: string | null;
  hmacVerified?: boolean | null;
}

export interface BeforeHandoffContext {
  settings: Settings;
  /** Counts toward the invocation's subrequest budget. */
  fetch: (request: Request) => Promise<Response>;
}

/**
 * Let a dependent service finish its per-turn write before the router releases the pending bot turn.
 * An unset URL deliberately does nothing, preserving the router's existing behavior.
 */
export async function beforeHandoff(
  ctx: BeforeHandoffContext,
  accountId: number,
  conversationId: number,
  turnId: number,
  conversation: BeforeHandoffConversation,
): Promise<void> {
  const config = ctx.settings.config.routing.beforeHandoff;
  if (!config) return;
  const secret = ctx.settings.secrets.BEFORE_HANDOFF_SECRET;
  // buildSettings requires this whenever the hook is configured. Keep this guard for callers that construct
  // Settings directly, and never send an unsigned request.
  if (!secret) throw new Error("before-handoff secret is not configured");

  const body = JSON.stringify({
    accountId,
    conversationId,
    turnId,
    contact: { email: conversation.contact.email ?? null, blocked: conversation.contact.blocked ?? false },
    channel: conversation.channel ?? null,
    hmacVerified: conversation.hmacVerified ?? null,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signed = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`)));
  const signature = Array.from(signed, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("The request timed out", "TimeoutError")),
    config.timeoutSeconds * 1000,
  );
  try {
    const response = await ctx.fetch(
      new Request(config.url, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-timestamp": timestamp,
          "x-signature": `sha256=${signature}`,
        },
        body,
      }),
    );
    // Consume the response so the timeout also covers a stalled response body and the budget timer can clear.
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`before-handoff HTTP ${response.status}`);
  } catch (error) {
    log.warn("before-handoff failed", { accountId, conversationId, turnId, ...errorFields(error) });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
