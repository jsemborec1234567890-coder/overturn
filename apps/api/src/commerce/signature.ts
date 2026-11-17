import { createHmac, timingSafeEqual } from "node:crypto";

/** How old a signed payload may be before we treat it as a replay, in seconds. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Stripe's scheme: `Stripe-Signature: t=<unix>,v1=<hex>`, where the signature is an
 * HMAC-SHA256 of `<t>.<raw body>` keyed with the endpoint secret. The timestamp is part of
 * the signed string and is checked against a tolerance, so a captured delivery cannot be
 * replayed later. Several v1 signatures can appear during a secret roll; any one may match.
 */
export function verifyStripeSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
  nowMs: number = Date.now(),
): VerifyResult {
  if (!header) return { ok: false, reason: "missing Stripe-Signature header" };
  const parts = new Map<string, string[]>();
  for (const piece of header.split(",")) {
    const i = piece.indexOf("=");
    if (i <= 0) continue;
    const k = piece.slice(0, i).trim();
    const v = piece.slice(i + 1).trim();
    parts.set(k, [...(parts.get(k) ?? []), v]);
  }
  const t = parts.get("t")?.[0];
  const signatures = parts.get("v1") ?? [];
  if (!t || signatures.length === 0) return { ok: false, reason: "malformed Stripe-Signature header" };
  const timestamp = Number(t);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: "malformed timestamp" };
  const ageSeconds = Math.abs(nowMs / 1000 - timestamp);
  if (ageSeconds > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: "timestamp outside tolerance" };

  const expected = createHmac("sha256", secret)
    .update(`${t}.${rawBody.toString("utf8")}`)
    .digest("hex");
  return signatures.some((s) => safeEqualHex(expected, s))
    ? { ok: true }
    : { ok: false, reason: "signature does not match" };
}

/**
 * The order APIs sign the raw body with an HMAC-SHA256 the endpoint shares, sent as hex or
 * base64 and sometimes prefixed `sha256=`. Field names differ between providers and between
 * their API versions, so confirm the header against the provider's current docs before you
 * point a live endpoint at it (docs/commerce.md says which header each one is configured with).
 */
export function verifyHmacSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
): VerifyResult {
  if (!header) return { ok: false, reason: "missing signature header" };
  const given = header.trim().replace(/^sha256[=\s]/i, "");
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  if (safeEqualHex(expected, given)) return { ok: true };
  // Same digest, base64 instead of hex.
  const b64 = Buffer.from(expected, "hex").toString("base64");
  if (given.length === b64.length) {
    try {
      if (timingSafeEqual(Buffer.from(given), Buffer.from(b64))) return { ok: true };
    } catch {
      /* fall through */
    }
  }
  return { ok: false, reason: "signature does not match" };
}
