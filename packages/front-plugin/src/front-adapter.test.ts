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
import { Subject } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, settingsFrom } from "./capture";
import {
  FrontCaptureAdapter,
  type FrontContext,
  type FrontSdkSurface,
  findRecordedRun,
  sendCapture,
} from "./front-adapter";

function makeMockConversation(
  id: string,
  overrides: Partial<ApplicationSingleConversation> = {},
): ApplicationSingleConversation {
  return {
    id: id as ApplicationConversationId,
    type: "email",
    status: "open",
    subject: "Water leak claim #48213",
    blurb: "Water came through the ceiling",
    assignee: undefined,
    recipient: { name: "Dana Smith", handle: "dana@example.com", type: "email", contact: undefined },
    channels: [],
    inboxes: [],
    tags: [],
    topics: [],
    links: [],
    closedAt: undefined,
    statusId: undefined,
    statusCategory: "open",
    ticketIds: [],
    customFieldAttributes: [],
    draftId: undefined,
    ...overrides,
  };
}

function makeMockMessage(id: string, status: "inbound" | "outbound", body: string): ApplicationMessage {
  return {
    id: id as unknown as ApplicationMessage["id"],
    subject: "Claim inquiry",
    date: new Date("2026-10-01T12:00:00Z"),
    status,
    content: {
      body,
      type: "html",
      attachments: [],
    },
    rfc5322MessageId: undefined,
    from: { name: "Agent Ray", handle: "ray@carrier.com", type: "email", contact: undefined },
    replyTo: undefined,
    to: [{ name: "Dana", handle: "dana@example.com", type: "email", contact: undefined }],
    cc: [],
    bcc: [],
  };
}

function createMockFetch(captureResult?: Partial<CaptureResult>) {
  return vi.fn().mockImplementation(async (url: string, _init?: RequestInit) => {
    if (url.includes("/v1/runs")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: [] }),
      } as unknown as Response;
    }
    if (url.includes("/v1/capture")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          runId: "run_test",
          stepId: "step_test",
          kind: "approve",
          changed: false,
          changedFields: [],
          correction: { id: "c_test", kind: "approve", source: "capture" },
          case: null,
          deduplicated: false,
          ...captureResult,
        }),
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  });
}

describe("sendCapture and findRecordedRun", () => {
  it("sendCapture posts JSON and returns CaptureResult", async () => {
    const mockResult = {
      runId: "0199a0d0-0000-7000-8000-000000000001",
      stepId: "0199a0d0-0000-7000-8000-000000000002",
      kind: "approve",
      changed: false,
      changedFields: [],
      correction: {
        id: "0199a0d0-0000-7000-8000-000000000003",
        runId: "0199a0d0-0000-7000-8000-000000000001",
        stepId: "0199a0d0-0000-7000-8000-000000000002",
        kind: "approve",
        source: "capture",
        createdAt: "2026-10-01T12:00:00Z",
      },
      case: null,
      deduplicated: false,
    } as unknown as CaptureResult;

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResult,
    } as unknown as Response);

    const body: CaptureCreate = {
      source: "front",
      externalId: "fr:cnv_123",
      agent: "support-reply",
      draft: { text: "Hello" },
      sent: { text: "Hello" },
      context: [],
    };

    const res = await sendCapture("https://api.overturn.run", "ov_test_key", body, mockFetch);
    expect(res).toEqual(mockResult);
    expect(mockFetch).toHaveBeenCalledWith("https://api.overturn.run/v1/capture", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer ov_test_key",
      },
      body: JSON.stringify(body),
    });
  });

  it("findRecordedRun queries the runs API and returns output when present", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        items: [{ id: "run_999", output: "AI drafted text from run" }],
      }),
    } as unknown as Response);

    const run = await findRecordedRun(
      "https://api.overturn.run",
      "key_123",
      "fr:cnv_123",
      "claims-reply",
      mockFetch,
    );
    expect(run).toEqual({ id: "run_999", output: "AI drafted text from run" });
  });

  it("findRecordedRun fails open when network error occurs", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network failed"));
    const run = await findRecordedRun(
      "https://api.overturn.run",
      null,
      "fr:cnv_123",
      "claims-reply",
      mockFetch,
    );
    expect(run).toBeNull();
  });
});

describe("FrontCaptureAdapter", () => {
  const longDraft =
    "<p>Dear Dana, your roof leak claim has been received and reviewed under your policy HO-3. An adjuster will inspect within 5 days.</p>";

  it("handles noConversation gracefully without crashing", async () => {
    const contextUpdates$ = new Subject<FrontContext>();
    const mockFront: FrontSdkSurface = { contextUpdates: contextUpdates$.asObservable() };

    const adapter = new FrontCaptureAdapter({ front: mockFront, fetchFn: createMockFetch() }).start();
    expect(adapter.getState().isWatching).toBe(false);

    contextUpdates$.next({ type: "noConversation" } as unknown as FrontContext);
    expect(adapter.getState().isWatching).toBe(false);
    expect(adapter.getState().conversationId).toBeNull();

    adapter.destroy();
  });

  it("respects scopeTag and ignores out-of-scope conversations", async () => {
    const contextUpdates$ = new Subject<FrontContext>();
    const mockFront: FrontSdkSurface = { contextUpdates: contextUpdates$.asObservable() };
    const settings = settingsFrom({ scope_tag: "ai_monitored" });

    const adapter = new FrontCaptureAdapter({
      front: mockFront,
      settings,
      fetchFn: createMockFetch(),
    }).start();

    const unscopedConv = makeMockConversation("cnv_1", {
      tags: [
        { id: "tag_1" as unknown as ApplicationTag["id"], name: "general" } as unknown as ApplicationTag,
      ],
    });

    await adapter.handleContext({
      type: "singleConversation",
      conversation: unscopedConv,
      listMessages: async () => ({ results: [] }) as unknown as ApplicationMessageList,
      fetchDraft: async () => undefined,
    } as unknown as FrontContext);

    expect(adapter.getState().inScope).toBe(false);
    expect(adapter.getState().isWatching).toBe(false);
    expect(adapter.getState().statusText).toBe('Not watching: no "ai_monitored" tag');

    const scopedConv = makeMockConversation("cnv_2", {
      tags: [
        { id: "tag_2" as unknown as ApplicationTag["id"], name: "ai_monitored" } as unknown as ApplicationTag,
      ],
    });

    await adapter.handleContext({
      type: "singleConversation",
      conversation: scopedConv,
      listMessages: async () => ({ results: [] }) as unknown as ApplicationMessageList,
      fetchDraft: async () => undefined,
    } as unknown as FrontContext);

    expect(adapter.getState().inScope).toBe(true);
    expect(adapter.getState().isWatching).toBe(true);
    expect(adapter.getState().statusText).toBe("Waiting for a draft");

    adapter.destroy();
  });

  it("detects draft inserted via fetchDraft in singleConversation", async () => {
    const contextUpdates$ = new Subject<FrontContext>();
    const mockFront: FrontSdkSurface = { contextUpdates: contextUpdates$.asObservable() };

    const adapter = new FrontCaptureAdapter({
      front: mockFront,
      fetchFn: createMockFetch(),
    }).start();

    const conv = makeMockConversation("cnv_100", {
      draftId: "dra_1" as ApplicationDraftId,
    });

    const mockDraft: ApplicationDraft = {
      id: "dra_1" as ApplicationDraftId,
      channel: {} as unknown as ApplicationDraft["channel"],
      to: [],
      cc: [],
      bcc: [],
      subject: "Claim update",
      content: { body: longDraft, type: "html", attachments: [] },
      isEditable: true,
    };

    await adapter.handleContext({
      type: "singleConversation",
      conversation: conv,
      listMessages: async () => ({ results: [] }) as unknown as ApplicationMessageList,
      fetchDraft: async () => mockDraft,
    } as unknown as FrontContext);

    const state = adapter.getState();
    expect(state.draft).not.toBeNull();
    expect(state.draft?.origin).toBe("preloaded");
    expect(state.statusText).toContain("Draft found in the composer · 22 words");

    adapter.destroy();
  });

  it("detects draft in messageComposer context and allows manual draft mark", async () => {
    const contextUpdates$ = new Subject<FrontContext>();
    const mockFront: FrontSdkSurface = { contextUpdates: contextUpdates$.asObservable() };

    const adapter = new FrontCaptureAdapter({
      front: mockFront,
      fetchFn: createMockFetch(),
    }).start();

    const conv = makeMockConversation("cnv_200");
    const mockDraft: ApplicationDraft = {
      id: "dra_2" as ApplicationDraftId,
      channel: {} as unknown as ApplicationDraft["channel"],
      to: [],
      cc: [],
      bcc: [],
      subject: "Composer update",
      content: { body: longDraft, type: "html", attachments: [] },
      isEditable: true,
    };

    await adapter.handleContext({
      type: "messageComposer",
      conversation: conv,
      draft: mockDraft,
      listMessages: async () => ({ results: [] }) as unknown as ApplicationMessageList,
    } as unknown as FrontContext);

    expect(adapter.getState().draft?.text).toBe(longDraft);

    // Test manual marking
    await adapter.markCurrentDraft();
    expect(adapter.getState().draft?.origin).toBe("manual");
    expect(adapter.getState().statusText).toContain("Draft marked by you · 22 words");

    adapter.destroy();
  });

  it("captures unchanged outbound reply as approve without requiring reason", async () => {
    const contextUpdates$ = new Subject<FrontContext>();
    const mockFront: FrontSdkSurface = { contextUpdates: contextUpdates$.asObservable() };

    const mockFetch = createMockFetch({
      runId: "run_1",
      stepId: "step_1",
      kind: "approve",
      changed: false,
      changedFields: [],
      case: null,
    });

    const adapter = new FrontCaptureAdapter({
      front: mockFront,
      fetchFn: mockFetch,
    }).start();

    const conv = makeMockConversation("cnv_300", { draftId: "dra_3" as ApplicationDraftId });
    const mockDraft: ApplicationDraft = {
      id: "dra_3" as ApplicationDraftId,
      channel: {} as unknown as ApplicationDraft["channel"],
      to: [],
      cc: [],
      bcc: [],
      subject: "Storm reply",
      content: { body: longDraft, type: "html", attachments: [] },
      isEditable: true,
    };

    // Initial context load
    await adapter.handleContext({
      type: "singleConversation",
      conversation: conv,
      listMessages: async () => ({ results: [] }) as unknown as ApplicationMessageList,
      fetchDraft: async () => mockDraft,
      teammate: { email: "ray@carrier.com" },
    } as unknown as FrontContext);

    expect(adapter.getState().draft).not.toBeNull();

    // Now message is sent natively by Front without changes
    const sentMsg = makeMockMessage("msg_sent_1", "outbound", longDraft);

    await adapter.handleContext({
      type: "singleConversation",
      conversation: { ...conv, draftId: undefined },
      listMessages: async () => ({ results: [sentMsg] }) as unknown as ApplicationMessageList,
      fetchDraft: async () => undefined,
      teammate: { email: "ray@carrier.com" },
    } as unknown as FrontContext);

    const captureCalls = mockFetch.mock.calls.filter(([u]) => (u as string).includes("/v1/capture"));
    expect(captureCalls).toHaveLength(1);

    const postBody = JSON.parse(captureCalls[0]![1]!.body as string) as CaptureCreate;
    expect(postBody.source).toBe("front");
    expect(postBody.externalId).toBe("fr:cnv_300");
    expect(postBody.agent).toBe("support-reply");
    expect(postBody.draft.text).toBe(postBody.sent.text);

    expect(adapter.getState().statusText).toBe("Sent as drafted · approved");
    expect(adapter.getState().draft).toBeNull();
    expect(adapter.getState().pendingCapture).toBeNull();

    adapter.destroy();
  });

  it("holds capture in panel when require_reason is on and reply was changed without pre-selected reason", async () => {
    const contextUpdates$ = new Subject<FrontContext>();
    const mockFront: FrontSdkSurface = { contextUpdates: contextUpdates$.asObservable() };

    const mockFetch = createMockFetch({
      runId: "run_2",
      stepId: "step_2",
      kind: "edit",
      changed: true,
      changedFields: [],
      case: { id: "case_2", title: "Adjuster SLA" } as unknown as CaptureResult["case"],
    });

    const adapter = new FrontCaptureAdapter({
      front: mockFront,
      fetchFn: mockFetch,
      settings: DEFAULT_SETTINGS, // requireReason: true
    }).start();

    const conv = makeMockConversation("cnv_400", { draftId: "dra_4" as ApplicationDraftId });
    const mockDraft: ApplicationDraft = {
      id: "dra_4" as ApplicationDraftId,
      channel: {} as unknown as ApplicationDraft["channel"],
      to: [],
      cc: [],
      bcc: [],
      subject: "Storm reply",
      content: { body: longDraft, type: "html", attachments: [] },
      isEditable: true,
    };

    // Load conversation with draft
    await adapter.handleContext({
      type: "singleConversation",
      conversation: conv,
      listMessages: async () => ({ results: [] }) as unknown as ApplicationMessageList,
      fetchDraft: async () => mockDraft,
      teammate: { email: "ray@carrier.com" },
    } as unknown as FrontContext);

    // Agent edited reply and sent natively in Front
    const editedText = longDraft.replace("within 5 days", "within 2 days");
    const sentMsg = makeMockMessage("msg_sent_2", "outbound", editedText);

    await adapter.handleContext({
      type: "singleConversation",
      conversation: { ...conv, draftId: undefined },
      listMessages: async () => ({ results: [sentMsg] }) as unknown as ApplicationMessageList,
      fetchDraft: async () => undefined,
      teammate: { email: "ray@carrier.com" },
    } as unknown as FrontContext);

    // NO capture sent yet because require_reason held it in the panel!
    const captureCallsBefore = mockFetch.mock.calls.filter(([u]) => (u as string).includes("/v1/capture"));
    expect(captureCallsBefore).toHaveLength(0);
    expect(adapter.getState().pendingCapture).not.toBeNull();
    expect(adapter.getState().statusText).toBe("Reply changed · select why to save case");
    expect(adapter.getState().noteText).toContain("Pick why you changed the reply");

    // Agent clicks reason chip in panel
    adapter.selectReasonCode("wrong_amount_or_date");

    await new Promise((r) => setTimeout(r, 10));

    // Capture is now sent!
    const captureCallsAfter = mockFetch.mock.calls.filter(([u]) => (u as string).includes("/v1/capture"));
    expect(captureCallsAfter).toHaveLength(1);

    const postBody = JSON.parse(captureCallsAfter[0]![1]!.body as string) as CaptureCreate;
    expect(postBody.source).toBe("front");
    expect(postBody.externalId).toBe("fr:cnv_400");
    expect(postBody.reasonCode).toBe("wrong_amount_or_date");
    expect(postBody.sent.text).toContain("within 2 days");

    expect(adapter.getState().statusText).toBe("Captured · edit saved as a case");
    expect(adapter.getState().noteText).toBe("Case: Adjuster SLA");
    expect(adapter.getState().pendingCapture).toBeNull();

    adapter.destroy();
  });

  it("submits immediately when reason code was selected prior to native send", async () => {
    const contextUpdates$ = new Subject<FrontContext>();
    const mockFront: FrontSdkSurface = { contextUpdates: contextUpdates$.asObservable() };

    const mockFetch = createMockFetch({
      runId: "run_3",
      stepId: "step_3",
      kind: "edit",
      changed: true,
      changedFields: [],
      case: { id: "case_3", title: "Coverage Exclusion" } as unknown as CaptureResult["case"],
    });

    const adapter = new FrontCaptureAdapter({
      front: mockFront,
      fetchFn: mockFetch,
      settings: settingsFrom({ reason_pack: "claims", require_reason: "true" }),
    }).start();

    const conv = makeMockConversation("cnv_500", { draftId: "dra_5" as ApplicationDraftId });
    const mockDraft: ApplicationDraft = {
      id: "dra_5" as ApplicationDraftId,
      channel: {} as unknown as ApplicationDraft["channel"],
      to: [],
      cc: [],
      bcc: [],
      subject: "Coverage query",
      content: { body: longDraft, type: "html", attachments: [] },
      isEditable: true,
    };

    await adapter.handleContext({
      type: "singleConversation",
      conversation: conv,
      listMessages: async () => ({ results: [] }) as unknown as ApplicationMessageList,
      fetchDraft: async () => mockDraft,
      teammate: { email: "ray@carrier.com" },
    } as unknown as FrontContext);

    // Agent selects a reason chip before sending
    adapter.selectReasonCode("missed_exclusion");
    adapter.setReasonNote("Flood damage excluded");

    // Agent sends edited text natively
    const editedText = longDraft.replace("reviewed", "denied and rejected");
    const sentMsg = makeMockMessage("msg_sent_3", "outbound", editedText);

    await adapter.handleContext({
      type: "singleConversation",
      conversation: { ...conv, draftId: undefined },
      listMessages: async () => ({ results: [sentMsg] }) as unknown as ApplicationMessageList,
      fetchDraft: async () => undefined,
      teammate: { email: "ray@carrier.com" },
    } as unknown as FrontContext);

    const captureCalls = mockFetch.mock.calls.filter(([u]) => (u as string).includes("/v1/capture"));
    expect(captureCalls).toHaveLength(1);

    const postBody = JSON.parse(captureCalls[0]![1]!.body as string) as CaptureCreate;
    expect(postBody.source).toBe("front");
    expect(postBody.reasonCode).toBe("missed_exclusion");
    expect(postBody.reason).toBe("Flood damage excluded");

    adapter.destroy();
  });

  it("fails open when /v1/capture fails with 500 error", async () => {
    const contextUpdates$ = new Subject<FrontContext>();
    const mockFront: FrontSdkSurface = { contextUpdates: contextUpdates$.asObservable() };
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/v1/runs")) {
        return { ok: true, status: 200, json: async () => ({ items: [] }) } as unknown as Response;
      }
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: "Internal Server Error" }),
      } as unknown as Response;
    });

    const adapter = new FrontCaptureAdapter({
      front: mockFront,
      fetchFn: mockFetch,
    }).start();

    const conv = makeMockConversation("cnv_600", { draftId: "dra_6" as ApplicationDraftId });
    const mockDraft: ApplicationDraft = {
      id: "dra_6" as ApplicationDraftId,
      channel: {} as unknown as ApplicationDraft["channel"],
      to: [],
      cc: [],
      bcc: [],
      subject: "Test failure",
      content: { body: longDraft, type: "html", attachments: [] },
      isEditable: true,
    };

    await adapter.handleContext({
      type: "singleConversation",
      conversation: conv,
      listMessages: async () => ({ results: [] }) as unknown as ApplicationMessageList,
      fetchDraft: async () => mockDraft,
    } as unknown as FrontContext);

    // Outbound send happens
    const sentMsg = makeMockMessage("msg_sent_6", "outbound", longDraft);
    await adapter.handleContext({
      type: "singleConversation",
      conversation: { ...conv, draftId: undefined },
      listMessages: async () => ({ results: [sentMsg] }) as unknown as ApplicationMessageList,
      fetchDraft: async () => undefined,
    } as unknown as FrontContext);

    expect(consoleSpy).toHaveBeenCalled();
    expect(adapter.getState().noteText).toBe("Overturn could not save this capture (500).");

    consoleSpy.mockRestore();
    adapter.destroy();
  });
});
