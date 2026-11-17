import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

/** Snapshot of a single message in a Front conversation. */
export interface FrontMessageSnapshot {
  id?: string;
  content: string;
  status: "inbound" | "outbound" | "note" | string;
  authorName?: string | null;
  authorEmail?: string | null;
  date?: string | null;
}

/** Snapshot of the Front conversation being viewed. */
export interface FrontConversationSnapshot {
  id: string;
  subject: string | null;
  recipientEmail: string | null;
  recipientName: string | null;
  /** Messages in chronological order, oldest first. */
  messages: FrontMessageSnapshot[];
  /** Custom decision fields by label. */
  fields: Record<string, unknown>;
  url: string | null;
  tags?: string[];
}

export interface AppSettings {
  baseUrl: string;
  agent: string;
  /** Hold capture in panel until the agent picks a reason when the reply was changed. */
  requireReason: boolean;
  /** Also capture internal notes, not only outbound replies. */
  captureInternalNotes: boolean;
  /** `custom_field_123:coverage, custom_field_9:reserve` -> decision fields by label. */
  decisionFields: Array<{ id: string; label: string }>;
  /** Replies shorter than this never count as a draft (a typed greeting is not a draft). */
  minDraftChars: number;
  /** When set, the plugin watches only conversations carrying this tag. */
  scopeTag: string | null;
  /** Which quick-pick reasons the agent sees: the claims pack or the vendor-neutral support pack. */
  reasonPack: ReasonPack;
  /** Optional Overturn API key for direct requests from the browser plugin. */
  apiKey: string | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  agent: "support-reply",
  requireReason: true,
  captureInternalNotes: false,
  decisionFields: [],
  minDraftChars: 80,
  scopeTag: null,
  reasonPack: "support",
  apiKey: null,
};

/** Parses plugin settings from configuration objects (manifest parameters, query params, or preferences). */
export function settingsFrom(raw: Record<string, unknown>): AppSettings {
  const str = (k: string): string | null => {
    const v = raw[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const bool = (k: string, d: boolean): boolean => {
    const v = raw[k];
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return v === "true" || v === "1";
    return d;
  };
  const fields = (str("decision_fields") ?? str("decisionFields") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, label] = s.split(":").map((x) => x.trim());
      return { id: id ?? "", label: label || id || "" };
    })
    .filter((f) => f.id.length > 0);
  const min = Number(str("min_draft_chars") ?? str("minDraftChars") ?? "");
  return {
    baseUrl: (str("overturn_base_url") ?? str("baseUrl") ?? DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ""),
    agent: str("agent") ?? DEFAULT_SETTINGS.agent,
    requireReason: bool("require_reason", bool("requireReason", DEFAULT_SETTINGS.requireReason)),
    captureInternalNotes: bool(
      "capture_internal_notes",
      bool("captureInternalNotes", DEFAULT_SETTINGS.captureInternalNotes),
    ),
    decisionFields: fields,
    minDraftChars: Number.isFinite(min) && min > 0 ? min : DEFAULT_SETTINGS.minDraftChars,
    scopeTag: str("scope_tag") ?? str("scopeTag"),
    reasonPack: reasonPackFrom(str("reason_pack") ?? str("reasonPack")),
    apiKey: str("overturn_api_key") ?? str("apiKey"),
  };
}

/**
 * Whether the plugin should watch this conversation at all.
 * With no scope tag every conversation is watched; with a scope tag,
 * conversations without it are ignored.
 */
export function inScope(tags: readonly string[], settings: AppSettings): boolean {
  if (!settings.scopeTag) return true;
  return tags.includes(settings.scopeTag);
}

/** Where the draft originated from. */
export type DraftOrigin = "inserted" | "manual" | "recorded" | "preloaded";

export interface DraftState {
  text: string;
  origin: DraftOrigin;
  runId?: string;
  model?: string | null;
  at: number;
}

export interface DraftDetector {
  /** Feed composer/draft values; returns a draft the first time one appears. */
  onComposer(text: string, now?: number): DraftState | null;
  current(): DraftState | null;
  set(d: DraftState | null): void;
}

export function createDraftDetector(opts: { minDraftChars: number; typingWindowMs?: number }): DraftDetector {
  const window = opts.typingWindowMs ?? 1500;
  let draft: DraftState | null = null;
  let last = { text: "", at: 0 };
  let seen = false;
  return {
    onComposer(text, now = Date.now()) {
      const prev = last;
      const firstSight = !seen;
      seen = true;
      last = { text, at: now };
      if (draft) return null;
      const grew = text.length - prev.text.length;
      // A jump of reply size in one change (or a reply-sized composer on first sight).
      const jump =
        grew >= opts.minDraftChars && (prev.text.length < opts.minDraftChars / 2 || now - prev.at > window);
      const first = firstSight && text.length >= opts.minDraftChars;
      if (jump || first) {
        draft = { text, origin: first ? "preloaded" : "inserted", at: now };
        return draft;
      }
      return null;
    },
    current: () => draft,
    set: (d) => {
      draft = d;
    },
  };
}

function role(m: FrontMessageSnapshot): CaptureMessage["role"] {
  if (m.status === "note" || m.status === "internalNote") return "note";
  return m.status === "outbound" ? "agent" : "customer";
}

/** The conversation the agent saw, oldest first, as capture context. */
export function contextFrom(conversation: FrontConversationSnapshot): CaptureMessage[] {
  return conversation.messages
    .filter((m) => m.content?.trim())
    .map((m) => ({
      role: role(m),
      author: m.authorEmail ?? m.authorName ?? null,
      content: stripHtml(m.content),
      at: m.date ?? null,
    }));
}

/** Strips HTML tags and resolves common HTML entities into readable plain text. */
export function stripHtml(html: string): string {
  return normalizeCaptureText(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  );
}

export interface PendingSend {
  text: string;
  type: "publicReply" | "internalNote" | "outbound" | string;
  fields: Record<string, unknown>;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "internal-note" | "empty" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; changedFields: string[] };

/** What to do when an outbound send is detected. Pure decision function. */
export function decideOnSend(input: {
  conversation: FrontConversationSnapshot;
  draft: DraftState | null;
  draftFields: Record<string, unknown>;
  send: PendingSend;
  reasonCode: string | null;
  reason: string;
  actor: string | null;
  settings: AppSettings;
  now?: number;
}): SendDecision {
  const { conversation, draft, send, settings } = input;
  const sentText = stripHtml(send.text);
  if (!sentText) return { action: "skip", why: "empty" };
  if ((send.type === "internalNote" || send.type === "note") && !settings.captureInternalNotes) {
    return { action: "skip", why: "internal-note" };
  }
  if (!draft) return { action: "skip", why: "no-draft" };

  const hasFields = settings.decisionFields.length > 0;
  const draftAnswer: CaptureAnswer = {
    text: stripHtml(draft.text),
    ...(hasFields ? { fields: input.draftFields } : {}),
  };
  const sentAnswer: CaptureAnswer = { text: sentText, ...(hasFields ? { fields: send.fields } : {}) };
  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reason = input.reason.trim();
  const reasonCode = input.reasonCode?.trim() || null;

  if (diff.changed && settings.requireReason && !reasonCode) {
    return { action: "need-reason", changedFields: diff.changedFields };
  }

  const body: CaptureCreate = {
    source: "front",
    externalId: `fr:${conversation.id}`,
    agent: settings.agent,
    actor: input.actor,
    subject: conversation.subject,
    context: contextFrom(conversation),
    draft: draftAnswer,
    sent: sentAnswer,
    reason: reason || null,
    reasonCode: diff.changed ? reasonCode : null,
    secondsToSend: Math.max(0, Math.round(((input.now ?? Date.now()) - draft.at) / 100) / 10),
    draftRunId: draft.runId ?? null,
    draftModel: draft.model ?? null,
    url: conversation.url,
    tags: [
      `draft:${draft.origin}`,
      send.type === "internalNote" || send.type === "note" ? "internal-note" : "public-reply",
    ],
    metadata: { recipient: conversation.recipientEmail ?? conversation.recipientName ?? null },
  };

  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

/** Status line for the plugin panel, exactly mirroring the Zendesk app conventions. */
export function statusLine(
  d: DraftState | null,
  lastResult: { kind: string; changed: boolean; dedup: boolean } | null,
): string {
  if (lastResult) {
    if (!lastResult.changed) return "Sent as drafted · approved";
    return lastResult.dedup ? "Captured · already in the suite" : "Captured · edit saved as a case";
  }
  if (!d) return "Waiting for a draft";
  const words = d.text.trim().split(/\s+/).filter(Boolean).length;
  const from = {
    inserted: "inserted",
    manual: "marked by you",
    recorded: "recorded by your agent",
    preloaded: "found in the composer",
  }[d.origin];
  return `Draft ${from} · ${words} words`;
}

/** Returns the reason codes for the active pack (claims or support). */
export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}
