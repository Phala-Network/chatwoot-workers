// The customer context of a post: what a deployment's own service (`customerContext.url`) knows about the ticket's
// customer, e.g. their accounts in its products, as Markdown for one Discord message. The request is
// `POST {"email", "name", "phone"}`, signed like Chatwoot's webhooks with CUSTOMER_CONTEXT_SECRET (`x-timestamp`, and
// `x-signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<body>">`); the answer is `{"markdown": "..."}`, empty for
// nothing to show.

import type { Fetch } from "../../../../shared/chatwoot/api.ts";
import type { RelayConversation } from "../../../../shared/types.ts";

export type ContextLookup = (contact: RelayConversation["contact"]) => Promise<string | undefined>;

const encoder = new TextEncoder();

export function contextLookup(url: string, secret: string, fetch: Fetch): ContextLookup {
  return async (contact) => {
    if (!contact.email) return undefined;
    const body = JSON.stringify({ email: contact.email, name: contact.name ?? null, phone: contact.phone ?? null });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    const signed = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`)));
    const signature = Array.from(signed, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const response = await fetch(
      new Request(url, {
        method: "POST",
        body,
        headers: { "content-type": "application/json", "x-timestamp": timestamp, "x-signature": `sha256=${signature}` },
      }),
    );
    if (!response.ok) throw new Error(`Customer context failed with HTTP ${response.status}`);
    const { markdown } = (await response.json()) as { markdown?: unknown };
    return typeof markdown === "string" && markdown.trim() !== "" ? markdown.trim() : undefined;
  };
}
