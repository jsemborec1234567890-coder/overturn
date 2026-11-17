/**
 * The auth context is passed around every request and could end up in a log, an error report or
 * a future serializer, so the webhook signing secrets never ride along on it. Only the commerce
 * service reads them, and it reads them from the row.
 */
export function withoutSecrets(settings: unknown): Record<string, unknown> {
  const s = (settings ?? {}) as Record<string, unknown>;
  const commerce = s.commerce;
  if (!commerce || typeof commerce !== "object") return s;
  const { stripeWebhookSecret, ryeWebhookSecret, zincWebhookSecret, ...rest } = commerce as Record<
    string,
    unknown
  >;
  return { ...s, commerce: rest };
}
