import type Front from "@frontapp/plugin-sdk";
import type {
  ApplicationConversationId,
  ApplicationDraft,
  ApplicationDraftId,
  ApplicationMessage,
  ApplicationMessageList,
  ApplicationSingleConversation,
  ApplicationTag,
} from "@frontapp/plugin-sdk";
import type { CaptureCreate, CaptureResult } from "@overturn-ai/shared";
import type { Observable, Subscription } from "rxjs";
import {
  type AppSettings,
  createDraftDetector,
  DEFAULT_SETTINGS,
  type DraftDetector,
  type DraftState,
  decideOnSend,
  type FrontConversationSnapshot,
  type FrontMessageSnapshot,
  inScope,
  type PendingSend,
  statusLine,
} from "./capture";

/** The context object emitted by Front.contextUpdates */
export type FrontContext = typeof Front extends { contextUpdates: Observable<infer T> } ? T : never;

/** Minimum Front SDK surface required by this adapter. */
export interface FrontSdkSurface {
  contextUpdates: Observable<FrontContext>;
}

export interface PendingHeldCapture {
  conversation: FrontConversationSnapshot;
  draft: DraftState;
  send: PendingSend;
  actor: string | null;
  changedFields: string[];
  sentAt: number;
}

export interface FrontAdapterState {
  conversationId: string | null;
  draft: DraftState | null;
  lastResult: { kind: string; changed: boolean; dedup: boolean } | null;
  pendingCapture: PendingHeldCapture | null;
  reasonCode: string | null;
  reasonNote: string;
  statusText: string;
  noteText: string;
  inScope: boolean;
  isWatching: boolean;
  isSending: boolean;
}

export interface FrontAdapterOptions {
  front: FrontSdkSurface;
  settings?: AppSettings;
  fetchFn?: typeof fetch;
  onStateChange?: (state: FrontAdapterState) => void;
  now?: () => number;
}

/** Sends a capture payload to POST /v1/capture with authorization. */
export async function sendCapture(
  baseUrl: string,
  apiKey: string | null,
  body: CaptureCreate,
  fetchFn: typeof fetch = fetch,
): Promise<CaptureResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const res = await fetchFn(`${baseUrl}/v1/capture`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const error = new Error(`Capture request failed with status ${res.status}`);
    Object.assign(error, { status: res.status });
    throw error;
  }
  return (await res.json()) as CaptureResult;
}

/** Queries Overturn API for a recorded run matching externalId. */
export async function findRecordedRun(
  baseUrl: string,
  apiKey: string | null,
  externalId: string,
  agent: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ id: string; output: string } | null> {
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  try {
    const res = await fetchFn(
      `${baseUrl}/v1/runs?externalId=${encodeURIComponent(externalId)}&agent=${encodeURIComponent(agent)}&limit=1`,
      { headers },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { items?: Array<{ id: string; output: unknown }> };
    const item = data.items?.[0];
    if (item && typeof item.output === "string" && item.output.trim()) {
      return { id: item.id, output: item.output };
    }
  } catch {
    // Fail-open: network or key error doesn't block the plugin
  }
  return null;
}

/** Extract conversation tag names safely. */
function extractTagNames(tags: ReadonlyArray<ApplicationTag> | undefined): string[] {
  if (!tags) return [];
  return tags
    .map((t) => {
      if (typeof t === "string") return t;
      return t && typeof t.name === "string" ? t.name : "";
    })
    .filter(Boolean);
}

/** Extract custom decision fields from conversation custom attributes. */
function extractDecisionFields(
  conv: ApplicationSingleConversation,
  settings: AppSettings,
): Record<string, unknown> {
  if (settings.decisionFields.length === 0) return {};
  const attrs = conv.customFieldAttributes ?? [];
  const fields: Record<string, unknown> = {};
  for (const f of settings.decisionFields) {
    const hit = attrs.find((a) => a.id === f.id || a.name === f.id || a.name === f.label);
    fields[f.label] = hit?.value ?? null;
  }
  return fields;
}

/** Creates an adapter instance that connects Front SDK contextUpdates to Overturn capture. */
export class FrontCaptureAdapter {
  private readonly front: FrontSdkSurface;
  private readonly settings: AppSettings;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly listeners = new Set<(state: FrontAdapterState) => void>();

  private subscription: Subscription | null = null;
  private currentContext: FrontContext | null = null;
  private currentConversationId: string | null = null;
  private detector: DraftDetector;
  private seenMessageIds = new Set<string>();

  private lastResult: { kind: string; changed: boolean; dedup: boolean } | null = null;
  private pendingCapture: PendingHeldCapture | null = null;
  private reasonCode: string | null = null;
  private reasonNote = "";
  private noteText = "";
  private inScope = true;
  private isWatching = false;
  private isSending = false;

  constructor(opts: FrontAdapterOptions) {
    this.front = opts.front;
    this.settings = opts.settings ?? DEFAULT_SETTINGS;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
    this.detector = createDraftDetector({ minDraftChars: this.settings.minDraftChars });

    if (opts.onStateChange) {
      this.listeners.add(opts.onStateChange);
    }
  }

  /** Starts watching Front contextUpdates. */
  public start(): this {
    if (this.subscription) return this;
    this.subscription = this.front.contextUpdates.subscribe({
      next: (context) => {
        void this.handleContext(context);
      },
      error: (err: unknown) => {
        console.error("Front contextUpdates error:", err);
      },
    });
    return this;
  }

  /** Stops watching Front contextUpdates. */
  public destroy(): void {
    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = null;
    }
    this.listeners.clear();
  }

  public subscribe(listener: (state: FrontAdapterState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getState(): FrontAdapterState {
    let statusText = statusLine(this.detector.current(), this.lastResult);
    if (!this.inScope && this.settings.scopeTag) {
      statusText = `Not watching: no "${this.settings.scopeTag}" tag`;
    } else if (this.pendingCapture) {
      statusText = "Reply changed · select why to save case";
    }

    return {
      conversationId: this.currentConversationId,
      draft: this.detector.current(),
      lastResult: this.lastResult,
      pendingCapture: this.pendingCapture,
      reasonCode: this.reasonCode,
      reasonNote: this.reasonNote,
      statusText,
      noteText: this.noteText,
      inScope: this.inScope,
      isWatching: this.isWatching,
      isSending: this.isSending,
    };
  }

  private notify(): void {
    const s = this.getState();
    for (const l of this.listeners) {
      l(s);
    }
  }

  /** Primary handler for every Front context update. */
  public async handleContext(context: FrontContext): Promise<void> {
    this.currentContext = context;

    if (context.type === "noConversation" || context.type === "noConversationPopover") {
      this.currentConversationId = null;
      this.isWatching = false;
      this.inScope = true;
      this.notify();
      return;
    }

    const conv: ApplicationSingleConversation | undefined =
      context.type === "singleConversation" || context.type === "singleConversationPopover"
        ? context.conversation
        : context.type === "messageComposer"
          ? context.conversation
          : undefined;

    if (!conv) {
      this.isWatching = false;
      this.notify();
      return;
    }

    const conversationId: string = conv.id;
    const tags = extractTagNames(conv.tags);
    if (!inScope(tags, this.settings)) {
      this.currentConversationId = conversationId;
      this.inScope = false;
      this.isWatching = false;
      this.notify();
      return;
    }

    this.inScope = true;
    this.isWatching = true;

    // Handle new conversation
    if (this.currentConversationId !== conversationId) {
      this.currentConversationId = conversationId;
      this.detector = createDraftDetector({ minDraftChars: this.settings.minDraftChars });
      this.pendingCapture = null;
      this.lastResult = null;
      this.reasonCode = null;
      this.reasonNote = "";
      this.noteText = "";
      this.seenMessageIds.clear();

      // Seed existing message IDs so past history is never treated as a new send
      await this.seedExistingMessages(context);

      // Check for SDK recorded draft
      await this.lookupRecordedDraft(conversationId);
    }

    // Inspect draft
    await this.syncDraft(context);

    // Inspect outbound messages
    await this.inspectOutboundMessages(context);

    this.notify();
  }

  private async seedExistingMessages(context: FrontContext): Promise<void> {
    if (
      context.type !== "singleConversation" &&
      context.type !== "singleConversationPopover" &&
      context.type !== "messageComposer"
    ) {
      return;
    }
    try {
      const list = await context.listMessages();
      for (const m of list.results) {
        this.seenMessageIds.add(m.id);
      }
    } catch {
      // Ignore if listMessages is unavailable
    }
  }

  private async lookupRecordedDraft(conversationId: string): Promise<void> {
    const found = await findRecordedRun(
      this.settings.baseUrl,
      this.settings.apiKey,
      `fr:${conversationId}`,
      this.settings.agent,
      this.fetchFn,
    );
    if (found?.output) {
      this.detector.set({
        text: found.output,
        origin: "recorded",
        runId: found.id,
        at: this.now(),
      });
    }
  }

  private async syncDraft(context: FrontContext): Promise<void> {
    let draftText: string | null = null;

    if (context.type === "singleConversation" || context.type === "singleConversationPopover") {
      const draftId: ApplicationDraftId | undefined = context.conversation.draftId;
      if (draftId) {
        try {
          const draft: ApplicationDraft | undefined = await context.fetchDraft(draftId);
          if (draft?.content?.body) {
            draftText = draft.content.body;
          }
        } catch {
          // fetchDraft failed; skip
        }
      }
    } else if (context.type === "messageComposer" && context.draft?.content?.body) {
      draftText = context.draft.content.body;
    }

    if (draftText) {
      this.detector.onComposer(draftText, this.now());
    }
  }

  private async inspectOutboundMessages(context: FrontContext): Promise<void> {
    if (
      context.type !== "singleConversation" &&
      context.type !== "singleConversationPopover" &&
      context.type !== "messageComposer"
    ) {
      return;
    }

    let list: ApplicationMessageList;
    try {
      list = await context.listMessages();
    } catch {
      return;
    }

    const currentDraft = this.detector.current();
    const newOutbound: ApplicationMessage[] = [];

    for (const m of list.results) {
      if (m.status === "outbound" && !this.seenMessageIds.has(m.id)) {
        this.seenMessageIds.add(m.id);
        newOutbound.push(m);
      }
    }

    if (newOutbound.length === 0 || !currentDraft) return;

    // Pick the most recent outbound message
    const latestSent = newOutbound[newOutbound.length - 1];
    if (!latestSent?.content?.body) return;

    const conv =
      context.type === "singleConversation" || context.type === "singleConversationPopover"
        ? context.conversation
        : (context.conversation ?? {
            id: latestSent.id as unknown as ApplicationConversationId,
            status: "open",
            type: "email",
            subject: latestSent.subject,
            blurb: undefined,
            assignee: undefined,
            recipient: latestSent.to[0],
            channels: [],
            inboxes: [],
            tags: [],
            topics: [],
            links: [],
            closedAt: undefined,
            statusId: undefined,
            statusCategory: undefined,
            ticketIds: [],
            customFieldAttributes: [],
            draftId: undefined,
          });

    const snapshot = this.buildSnapshot(conv, list.results);
    const draftFields = extractDecisionFields(conv, this.settings);
    const sendFields = extractDecisionFields(conv, this.settings);

    const pendingSend: PendingSend = {
      text: latestSent.content.body,
      type: "outbound",
      fields: sendFields,
    };

    const actor = context.teammate?.email ?? null;
    const decision = decideOnSend({
      conversation: snapshot,
      draft: currentDraft,
      draftFields,
      send: pendingSend,
      reasonCode: this.reasonCode,
      reason: this.reasonNote,
      actor,
      settings: this.settings,
      now: this.now(),
    });

    if (decision.action === "skip") return;

    if (decision.action === "need-reason") {
      // Front has already sent the message natively; hold the capture in the panel
      this.pendingCapture = {
        conversation: snapshot,
        draft: currentDraft,
        send: pendingSend,
        actor,
        changedFields: decision.changedFields,
        sentAt: this.now(),
      };
      this.noteText = `Pick why you changed the ${decision.changedFields.length ? decision.changedFields.join(", ") : "reply"} in the Overturn panel.`;
      return;
    }

    if (decision.action === "capture") {
      await this.executeCapture(decision.body);
    }
  }

  private buildSnapshot(
    conv: ApplicationSingleConversation,
    messages: ReadonlyArray<ApplicationMessage>,
  ): FrontConversationSnapshot {
    const mappedMessages: FrontMessageSnapshot[] = messages.map((m) => ({
      id: m.id,
      content: m.content?.body ?? "",
      status: m.status,
      authorEmail: m.from?.handle ?? null,
      authorName: m.from?.name ?? null,
      date: m.date instanceof Date ? m.date.toISOString() : (m.date ?? null),
    }));

    return {
      id: conv.id,
      subject: conv.subject ?? null,
      recipientEmail: conv.recipient?.handle ?? null,
      recipientName: conv.recipient?.name ?? null,
      messages: mappedMessages,
      fields: extractDecisionFields(conv, this.settings),
      url: `https://app.frontapp.com/open/${conv.id}`,
      tags: extractTagNames(conv.tags),
    };
  }

  /**
   * Executes the capture POST /v1/capture.
   * Fail-open: Never blocks or throws; logs errors and surfaces gentle panel note.
   */
  public async executeCapture(body: CaptureCreate): Promise<boolean> {
    this.isSending = true;
    this.notify();

    try {
      const result = await sendCapture(this.settings.baseUrl, this.settings.apiKey, body, this.fetchFn);
      this.lastResult = {
        kind: result.kind,
        changed: result.changed,
        dedup: result.deduplicated,
      };
      this.noteText = result.changed && result.case ? `Case: ${result.case.title}` : "";
      this.pendingCapture = null;
      this.detector.set(null);
      this.reasonCode = null;
      this.reasonNote = "";
      this.isSending = false;
      this.notify();
      return true;
    } catch (e) {
      console.error("Overturn could not save capture:", e);
      const status = (e as { status?: number })?.status ?? "network";
      this.noteText = `Overturn could not save this capture (${status}).`;
      this.isSending = false;
      this.notify();
      return false;
    }
  }

  /**
   * Submits a held capture after a reason code is selected.
   */
  public async submitReason(reasonCode: string, reasonNote?: string): Promise<boolean> {
    if (!this.pendingCapture) return false;

    const code = reasonCode.trim();
    const note = (reasonNote !== undefined ? reasonNote : this.reasonNote).trim();
    this.reasonCode = code;
    if (reasonNote !== undefined) this.reasonNote = reasonNote;

    const decision = decideOnSend({
      conversation: this.pendingCapture.conversation,
      draft: this.pendingCapture.draft,
      draftFields: this.pendingCapture.draft
        ? extractDecisionFields(
            { customFieldAttributes: [] } as unknown as ApplicationSingleConversation,
            this.settings,
          )
        : {},
      send: this.pendingCapture.send,
      reasonCode: code,
      reason: note,
      actor: this.pendingCapture.actor,
      settings: this.settings,
      now: this.pendingCapture.sentAt,
    });

    if (decision.action === "capture") {
      return await this.executeCapture(decision.body);
    }
    return false;
  }

  /** Manually marks the current text in Front's composer/draft as the draft. */
  public async markCurrentDraft(): Promise<void> {
    if (!this.currentContext) return;

    let text = "";
    if (
      this.currentContext.type === "singleConversation" ||
      this.currentContext.type === "singleConversationPopover"
    ) {
      const draftId = this.currentContext.conversation.draftId;
      if (draftId) {
        const d = await this.currentContext.fetchDraft(draftId);
        text = d?.content?.body ?? "";
      }
    } else if (this.currentContext.type === "messageComposer") {
      text = this.currentContext.draft?.content?.body ?? "";
    }

    if (!text.trim()) return;

    this.detector.set({
      text,
      origin: "manual",
      at: this.now(),
    });
    this.lastResult = null;
    this.pendingCapture = null;
    this.notify();
  }

  /** Selects or toggles a reason code. If a capture is held pending, automatically submits it. */
  public selectReasonCode(code: string): void {
    if (this.pendingCapture) {
      void this.submitReason(code);
      return;
    }
    this.reasonCode = this.reasonCode === code ? null : code;
    this.notify();
  }

  public setReasonNote(note: string): void {
    this.reasonNote = note;
    this.notify();
  }

  public getDetector(): DraftDetector {
    return this.detector;
  }
}
