import {
  type AppSettings,
  type CaptureAnswer,
  type CaptureCreate,
  type CaptureMessage,
  type ConversationSnapshot,
  DEFAULT_SETTINGS,
  type DraftOrigin,
  type DraftState,
  diffCaptureAnswers,
  normalizeCaptureText,
  type PendingSend,
  REASON_PACKS,
  type SendDecision,
} from "./types.js";

/**
 * Strips HTML formatting common in Intercom rich-text editors and comments.
 */
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

/**
 * Parses settings provided in app installation metadata.
 */
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

  const fields = (str("decision_fields") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, label] = s.split(":").map((x) => x.trim());
      return { id: id!, label: label || id! };
    });

  const min = Number(str("min_draft_chars") ?? "");
  const pack = str("reason_pack");

  return {
    baseUrl: (str("overturn_base_url") ?? DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ""),
    agent: str("agent") ?? DEFAULT_SETTINGS.agent,
    requireReason: bool("require_reason", DEFAULT_SETTINGS.requireReason),
    captureInternalNotes: bool("capture_internal_notes", DEFAULT_SETTINGS.captureInternalNotes),
    decisionFields: fields,
    minDraftChars: Number.isFinite(min) && min > 0 ? min : DEFAULT_SETTINGS.minDraftChars,
    reasonPack: pack === "claims" ? "claims" : "support",
  };
}

export interface IntercomDraftDetector {
  /**
   * Evaluates text entering the composer.
   * isFinAssist indicates explicit trigger from Fin Copilot / AI Assist.
   */
  onComposer(text: string, isFinAssist?: boolean, now?: number): DraftState | null;
  current(): DraftState | null;
  set(d: DraftState | null): void;
  reset(): void;
}

/**
 * Creates a draft detector for Intercom composer events.
 * Fin drafts and human-typed replies are explicitly distinguished:
 * - isFinAssist = true -> draft:ai
 * - sudden jump / paste -> inserted
 * - manual / typing -> draft:manual
 */
export function createIntercomDraftDetector(opts: {
  minDraftChars: number;
  typingWindowMs?: number;
}): IntercomDraftDetector {
  const window = opts.typingWindowMs ?? 1500;
  let draft: DraftState | null = null;
  let last = { text: "", at: 0 };
  let seen = false;

  return {
    onComposer(text: string, isFinAssist = false, now = Date.now()): DraftState | null {
      const prev = last;
      const firstSight = !seen;
      seen = true;
      last = { text, at: now };

      if (draft) return null;

      const cleanText = text.trim();
      const words = cleanText ? cleanText.split(/\s+/).length : 0;

      // 1. Explicit Fin AI assist draft
      if (isFinAssist && cleanText.length >= opts.minDraftChars) {
        draft = {
          text,
          origin: "fin_assist",
          at: now,
          wordCount: words,
        };
        return draft;
      }

      const grew = text.length - prev.text.length;
      const jump =
        grew >= opts.minDraftChars && (prev.text.length < opts.minDraftChars / 2 || now - prev.at > window);
      const first = firstSight && text.length >= opts.minDraftChars;

      if (jump || first) {
        draft = {
          text,
          origin: first ? "preloaded" : "inserted",
          at: now,
          wordCount: words,
        };
        return draft;
      }

      return null;
    },
    current: () => draft,
    set: (d) => {
      draft = d;
    },
    reset: () => {
      draft = null;
      last = { text: "", at: 0 };
      seen = false;
    },
  };
}

/**
 * Builds standard context messages array from Intercom conversation parts.
 */
export function contextFrom(conv: ConversationSnapshot): CaptureMessage[] {
  return conv.conversationParts
    .filter((p) => p.body?.trim())
    .map((p) => {
      let role: CaptureMessage["role"] = "customer";
      if (p.partType === "note") {
        role = "note";
      } else if (p.isFinAi || p.partType === "ai_response") {
        role = "system";
      } else if (p.isTeammate) {
        role = "agent";
      }

      return {
        role,
        author: p.authorEmail ?? p.authorName ?? null,
        content: stripHtml(p.body),
        at: p.createdAt ?? null,
      };
    });
}

/**
 * Evaluates the send event when the teammate hits submit in Intercom inbox.
 * Never blocks the send: returns SendDecision with action 'skip', 'need-reason', or 'capture'.
 */
export function decideOnSend(input: {
  conversation: ConversationSnapshot;
  draft: DraftState | null;
  draftFields?: Record<string, unknown>;
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
  if (send.type === "internalNote" && !settings.captureInternalNotes) {
    return { action: "skip", why: "internal-note" };
  }
  if (!draft) return { action: "skip", why: "no-draft" };

  const hasFields = settings.decisionFields.length > 0;
  const draftAnswer: CaptureAnswer = {
    text: stripHtml(draft.text),
    ...(hasFields ? { fields: input.draftFields ?? {} } : {}),
  };
  const sentAnswer: CaptureAnswer = {
    text: sentText,
    ...(hasFields ? { fields: send.fields ?? {} } : {}),
  };

  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reason = input.reason.trim();
  const reasonCode = input.reasonCode?.trim() || null;

  if (diff.changed && settings.requireReason && !reasonCode) {
    return { action: "need-reason", changedFields: diff.changedFields };
  }

  // Intercom Fin tag specification:
  // tag 'draft:ai' only when origin was an AI assist (Fin), otherwise 'draft:manual'
  const originTag = draft.origin === "fin_assist" ? "draft:ai" : "draft:manual";

  const body: CaptureCreate = {
    source: "intercom",
    externalId: `ic:${conversation.id}`,
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
    tags: [originTag, send.type === "internalNote" ? "internal-note" : "public-reply"],
    metadata: {
      contact: conversation.contactEmail ?? conversation.contactName ?? null,
      origin: draft.origin,
    },
  };

  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

/**
 * Returns formatted status line for Intercom Canvas Kit banner:
 * Shows 'Draft inserted · N words' or execution state.
 */
export function statusLine(
  draft: DraftState | null,
  lastResult: { kind: string; changed: boolean; dedup: boolean } | null,
): string {
  if (lastResult) {
    if (!lastResult.changed) return "Sent as drafted · approved";
    return lastResult.dedup ? "Captured · already in the suite" : "Captured · edit saved as a case";
  }
  if (!draft) return "Waiting for a draft";

  const words = draft.wordCount || draft.text.trim().split(/\s+/).length;
  const originLabel =
    draft.origin === "fin_assist" ? "from Fin AI" : draft.origin === "manual" ? "typed by you" : "inserted";

  return `Draft ${originLabel} · ${words} words`;
}

/**
 * Quick-pick reasons for the active pack (support codes by default).
 */
export function quickReasons(settings: AppSettings) {
  return REASON_PACKS[settings.reasonPack];
}

export type { AppSettings, DraftState };
