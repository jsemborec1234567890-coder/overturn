import { type ProjectSettings, projectSettingsSchema, SETTINGS_MASK } from "@overturn-ai/shared";

/** Settings as stored (jsonb, possibly older shape) → current defaults filled in. */
export function parseSettings(raw: unknown): ProjectSettings {
  const parsed = projectSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : projectSettingsSchema.parse({});
}

/**
 * Write-only settings. A webhook signing secret has to be stored in the clear to verify an
 * HMAC, but nothing should hand it back: every read goes through here, so a project member,
 * an API key or a support session sees `__set__` and never the secret itself.
 */
const SECRET_KEYS = ["stripeWebhookSecret", "ryeWebhookSecret", "zincWebhookSecret"] as const;

export function maskSecrets(settings: ProjectSettings): ProjectSettings {
  const commerce = { ...settings.commerce };
  for (const k of SECRET_KEYS) if (commerce[k]) commerce[k] = SETTINGS_MASK;
  return { ...settings, commerce };
}

/** The mask coming back in a PATCH means "leave it alone"; an empty string clears it. */
export function unmaskSecrets(
  incoming: ProjectSettings["commerce"],
  current: ProjectSettings["commerce"],
): ProjectSettings["commerce"] {
  const out = { ...incoming };
  for (const k of SECRET_KEYS) {
    if (out[k] === SETTINGS_MASK) out[k] = current[k];
    else if (out[k] === "") out[k] = null;
  }
  return out;
}
