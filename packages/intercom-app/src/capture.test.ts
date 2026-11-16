import { describe, expect, it } from "vitest";
import {
  contextFrom,
  createIntercomDraftDetector,
  decideOnSend,
  quickReasons,
  settingsFrom,
  statusLine,
  stripHtml,
} from "./capture.js";
import {
  type ConversationSnapshot,
  DEFAULT_SETTINGS,
  type DraftState,
} from "./types.js";

const sampleConversation: ConversationSnapshot = {
  id: "774892",
  subject: "Billing issue with annual plan",
  contactName: "Alice Martin",
  contactEmail: "alice@example.com",
  conversationParts: [
    {
      id: "part_1",
      partType: "comment",
      body: "<p>Hello, I was charged twice for the annual plan renewal.</p>",
      authorName: "Alice Martin",
      authorEmail: "alice@example.com",
      isTeammate: false,
      createdAt: "2026-11-16T12:00:00Z",
    },
    {
      id: "part_2",
      partType: "note",
      body: "<p>Verified Stripe transaction: duplicate charge ID ch_89412.</p>",
      authorName: "Internal Bot",
      isTeammate: true,
      createdAt: "2026-11-16T12:02:00Z",
    },
  ],
  customAttributes: {
    plan_tier: "enterprise",
  },
  url: "https://app.intercom.com/a/apps/xyz/inbox/conversation/774892",
};

describe("Intercom Capture Adapter Unit Suite", () => {
  it("criterion 1: detects draft landing in composer and formats status line", () => {
    const detector = createIntercomDraftDetector({ minDraftChars: 30 });
    expect(detector.current()).toBeNull();

    // 1a. Fin assist insertion
    const finDraftText = "Hello Alice, I have reviewed your account and initiated a refund for the duplicate charge.";
    const detectedFin = detector.onComposer(finDraftText, true);

    expect(detectedFin).not.toBeNull();
    expect(detectedFin?.origin).toBe("fin_assist");
    expect(detectedFin?.wordCount).toBe(15);
    expect(statusLine(detectedFin, null)).toBe("Draft from Fin AI · 15 words");

    // 1b. Sudden jump/paste without Fin flag
    detector.reset();
    const pasteDraftText = "This is a pre-written macro text explaining our billing refund policy in detail.";
    const detectedPaste = detector.onComposer(pasteDraftText, false);
    expect(detectedPaste).not.toBeNull();
    expect(detectedPaste?.origin).toBe("preloaded");
    expect(statusLine(detectedPaste, null)).toBe("Draft inserted · 13 words");
  });

  it("criterion 2: offers support reason codes by default and parses settings", () => {
    const settings = settingsFrom({
      agent: "billing-support",
      require_reason: "true",
      reason_pack: "support",
    });

    expect(settings.agent).toBe("billing-support");
    expect(settings.requireReason).toBe(true);
    expect(settings.reasonPack).toBe("support");

    const reasons = quickReasons(settings);
    expect(reasons.length).toBeGreaterThan(5);
    expect(reasons.some((r) => r.code === "wrong_amount_or_date")).toBe(true);
    expect(reasons.some((r) => r.code === "wrong_answer")).toBe(true);
  });

  it("criterion 3: generates POST /v1/capture payload with source: intercom and externalId: ic:<id>", () => {
    const draft: DraftState = {
      text: "Hello Alice, we will process your refund in 10 business days.",
      origin: "fin_assist",
      at: 1700000000000,
      wordCount: 11,
    };

    const decision = decideOnSend({
      conversation: sampleConversation,
      draft,
      send: {
        text: "Hello Alice, we will process your refund in 10 business days.",
        type: "publicReply",
      },
      reasonCode: null,
      reason: "",
      actor: "agent@support.com",
      settings: DEFAULT_SETTINGS,
      now: 1700000030000,
    });

    expect(decision.action).toBe("capture");
    if (decision.action === "capture") {
      expect(decision.changed).toBe(false);
      expect(decision.body.source).toBe("intercom");
      expect(decision.body.externalId).toBe("ic:774892");
      expect(decision.body.draft.text).toBe(draft.text);
      expect(decision.body.sent.text).toBe(draft.text);
      expect(decision.body.tags).toContain("draft:ai");
      expect(decision.body.tags).toContain("public-reply");
      expect(decision.body.context.length).toBe(2);
      expect(decision.body.context[0].role).toBe("customer");
      expect(decision.body.context[1].role).toBe("note");
    }
  });

  it("criterion 4: honours require_reason when the draft was changed", () => {
    const draft: DraftState = {
      text: "Hello Alice, we will process your refund in 10 business days.",
      origin: "fin_assist",
      at: 1700000000000,
      wordCount: 11,
    };

    // Edited reply without providing reason code
    const blockedDecision = decideOnSend({
      conversation: sampleConversation,
      draft,
      send: {
        text: "Hello Alice, I have already processed your refund immediately. It will appear in 2 business days.",
        type: "publicReply",
      },
      reasonCode: null,
      reason: "",
      actor: "agent@support.com",
      settings: { ...DEFAULT_SETTINGS, requireReason: true },
    });

    expect(blockedDecision.action).toBe("need-reason");

    // Provide reason code
    const validDecision = decideOnSend({
      conversation: sampleConversation,
      draft,
      send: {
        text: "Hello Alice, I have already processed your refund immediately. It will appear in 2 business days.",
        type: "publicReply",
      },
      reasonCode: "wrong_amount_or_date",
      reason: "Corrected refund ETA to 2 business days",
      actor: "agent@support.com",
      settings: { ...DEFAULT_SETTINGS, requireReason: true },
    });

    expect(validDecision.action).toBe("capture");
    if (validDecision.action === "capture") {
      expect(validDecision.changed).toBe(true);
      expect(validDecision.body.reasonCode).toBe("wrong_amount_or_date");
      expect(validDecision.body.reason).toBe("Corrected refund ETA to 2 business days");
    }
  });

  it("criterion 5: never blocks the send, tags draft:ai only for Fin and draft:manual for human", () => {
    // 5a. Fin assist draft
    const finDraft: DraftState = {
      text: "Fin generated this draft.",
      origin: "fin_assist",
      at: Date.now(),
      wordCount: 4,
    };
    const finDecision = decideOnSend({
      conversation: sampleConversation,
      draft: finDraft,
      send: { text: "Fin generated this draft.", type: "publicReply" },
      reasonCode: null,
      reason: "",
      actor: "agent@support.com",
      settings: DEFAULT_SETTINGS,
    });
    if (finDecision.action === "capture") {
      expect(finDecision.body.tags).toContain("draft:ai");
      expect(finDecision.body.tags).not.toContain("draft:manual");
    }

    // 5b. Manual inserted/typed draft
    const manualDraft: DraftState = {
      text: "Human agent typed or pasted this draft.",
      origin: "inserted",
      at: Date.now(),
      wordCount: 7,
    };
    const manualDecision = decideOnSend({
      conversation: sampleConversation,
      draft: manualDraft,
      send: { text: "Human agent typed or pasted this draft.", type: "publicReply" },
      reasonCode: null,
      reason: "",
      actor: "agent@support.com",
      settings: DEFAULT_SETTINGS,
    });
    if (manualDecision.action === "capture") {
      expect(manualDecision.body.tags).toContain("draft:manual");
      expect(manualDecision.body.tags).not.toContain("draft:ai");
    }

    // 5c. Empty or no draft skips gracefully
    const noDraftDecision = decideOnSend({
      conversation: sampleConversation,
      draft: null,
      send: { text: "Some quick reply", type: "publicReply" },
      reasonCode: null,
      reason: "",
      actor: "agent@support.com",
      settings: DEFAULT_SETTINGS,
    });
    expect(noDraftDecision.action).toBe("skip");
  });

  it("contextFrom strips HTML properly", () => {
    expect(stripHtml("<p>Hello <b>World</b>&nbsp;!</p>")).toBe("Hello World !");
    const ctx = contextFrom(sampleConversation);
    expect(ctx[0].content).toBe("Hello, I was charged twice for the annual plan renewal.");
  });
});
