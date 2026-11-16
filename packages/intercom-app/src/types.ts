/**
 * Types and schema contracts for Overturn Intercom App capture adapter.
 * Compatible with @overturn-ai/shared and Intercom Canvas Kit / Messenger data structures.
 */

export interface CaptureAnswer {
  text: string;
  fields?: Record<string, unknown>;
}

export interface CaptureMessage {
  role: "customer" | "agent" | "note" | "system";
  author?: string | null;
  content: string;
  at?: string | null;
}

export interface CaptureCreate {
  source: "intercom";
  externalId: string;
  agent: string;
  actor: string | null;
  subject?: string | null;
  context: CaptureMessage[];
  draft: CaptureAnswer;
  sent: CaptureAnswer;
  reason: string | null;
  reasonCode: string | null;
  secondsToSend?: number;
  draftRunId?: string | null;
  draftModel?: string | null;
  url?: string | null;
  tags: string[];
  metadata?: Record<string, unknown>;
}

export interface ConversationSnapshot {
  id: string | number;
  subject: string | null;
  contactName: string | null;
  contactEmail: string | null;
  conversationParts: Array<{
    id?: string | number;
    partType: "comment" | "note" | "ai_response" | string;
    body: string;
    authorName?: string | null;
    authorEmail?: string | null;
    isTeammate?: boolean;
    isFinAi?: boolean;
    createdAt?: string | null;
  }>;
  customAttributes: Record<string, unknown>;
  url: string | null;
}

export interface AppSettings {
  baseUrl: string;
  agent: string;
  requireReason: boolean;
  captureInternalNotes: boolean;
  decisionFields: Array<{ id: string; label: string }>;
  minDraftChars: number;
  reasonPack: "support" | "claims";
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  agent: "support-reply",
  requireReason: true,
  captureInternalNotes: false,
  decisionFields: [],
  minDraftChars: 80,
  reasonPack: "support",
};

export type DraftOrigin = "fin_assist" | "manual" | "inserted" | "preloaded";

export interface DraftState {
  text: string;
  origin: DraftOrigin;
  runId?: string;
  model?: string | null;
  at: number;
  wordCount: number;
}

export interface PendingSend {
  text: string;
  type: "publicReply" | "internalNote" | string;
  fields?: Record<string, unknown>;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "internal-note" | "empty" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; changedFields: string[] };

export function normalizeCaptureText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(",")}}`;
}

export interface CaptureDiff {
  changed: boolean;
  textChanged: boolean;
  changedFields: string[];
}

export function diffCaptureAnswers(draft: CaptureAnswer, sent: CaptureAnswer): CaptureDiff {
  const textChanged = normalizeCaptureText(draft.text) !== normalizeCaptureText(sent.text);
  const keys = new Set([...Object.keys(draft.fields ?? {}), ...Object.keys(sent.fields ?? {})]);
  const changedFields = [...keys]
    .filter((k) => stableJson(draft.fields?.[k] ?? null) !== stableJson(sent.fields?.[k] ?? null))
    .sort();
  return { changed: textChanged || changedFields.length > 0, textChanged, changedFields };
}

export const SUPPORT_REASON_CODES = [
  { code: "wrong_answer", label: "Wrong answer" },
  { code: "missing_information", label: "Missing information" },
  { code: "wrong_amount_or_date", label: "Wrong amount or date" },
  { code: "missing_required_step", label: "Missing required step" },
  { code: "against_policy", label: "Against policy" },
  { code: "should_escalate", label: "Should have escalated" },
  { code: "tone_wording", label: "Tone / wording" },
  { code: "wrong_language_or_format", label: "Wrong language / format" },
] as const;

export const CLAIMS_REASON_CODES = [
  { code: "wrong_coverage_decision", label: "Wrong coverage decision" },
  { code: "missed_exclusion", label: "Missed exclusion" },
  { code: "reserve_too_low", label: "Reserve too low" },
  { code: "reserve_too_high", label: "Reserve too high" },
  { code: "wrong_amount_or_date", label: "Wrong amount or date" },
  { code: "missing_required_step", label: "Missing required step" },
  { code: "tone_wording", label: "Tone / wording" },
  { code: "policy_exception", label: "Policy exception" },
] as const;

export const REASON_PACKS = {
  support: SUPPORT_REASON_CODES,
  claims: CLAIMS_REASON_CODES,
} as const;
