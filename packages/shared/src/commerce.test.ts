import { describe, expect, it } from "vitest";
import {
  COMMERCE_REASON_CODES,
  commerceMetadataFrom,
  correctionFromOrderEvent,
  correctionFromStripeEvent,
  decisionAsAnswer,
  describeDecision,
  formatMoney,
  purchaseDecisionFrom,
  REASON_PACKS,
  reasonCodeLabel,
  reasonPackFrom,
  renderPurchaseSnapshot,
  scorePurchaseDecision,
} from "./index.js";

describe("purchaseDecisionFrom", () => {
  // The gate's dangerous direction is a false decline: it passes a release that never re-decided.
  it("does not read a decline out of an agent that only looked around", () => {
    expect(
      purchaseDecisionFrom({ tool_calls: [{ name: "search_catalogue", args: { q: "cable" } }] }),
    ).toBeNull();
    expect(purchaseDecisionFrom({ tool_calls: [] })).toBeNull();
  });

  it("does not read a payment status as the agent declining", () => {
    // "rejected" is what a processor says, not what the agent chose.
    expect(purchaseDecisionFrom({ status: "rejected", items: [{ sku: "A-1" }] })?.action).toBe("buy");
    expect(purchaseDecisionFrom({ status: "nonexistent" })).toBeNull();
    expect(purchaseDecisionFrom({ action: "declined" })?.action).toBe("decline");
    expect(purchaseDecisionFrom({ action: "no_purchase" })?.action).toBe("decline");
  });

  it("does not read a decline out of prose that never mentions the purchase", () => {
    expect(purchaseDecisionFrom("Aborted: the catalogue API timed out.")).toBeNull();
    expect(purchaseDecisionFrom("I'll ask the user which colour they prefer.")).toBeNull();
    expect(purchaseDecisionFrom("The merchant refused to ship to that address.")).toBeNull();
    expect(purchaseDecisionFrom("Holding off on the summary until the run finishes.")).toBeNull();
  });

  it("still reads a decline out of prose that names the purchase", () => {
    for (const text of [
      "Declining to buy — the instruction says one unit, the cart has three.",
      "I won't order this; it is over the user's limit.",
      "No purchase: nothing in the catalogue matches.",
      "Holding off on the order until the user confirms.",
    ]) {
      expect(purchaseDecisionFrom(text)?.action, text).toBe("decline");
    }
  });

  it("reads the capture shape a commerce case freezes", () => {
    expect(
      purchaseDecisionFrom({ action: "buy", items: [{ sku: "A-1", quantity: 2 }], reply: "ordering two" }),
    ).toEqual({ action: "buy", items: [{ sku: "A-1", quantity: 2 }], reason: "ordering two" });
  });

  it("reads a tool call as the decision", () => {
    const d = purchaseDecisionFrom({
      tool_calls: [{ name: "place_order", args: { items: [{ sku: "B-2", qty: 1, price: 19.99 }] } }],
    });
    expect(d).toEqual({ action: "buy", items: [{ sku: "B-2", quantity: 1, unitPriceCents: 1999 }] });
  });

  it("reads a bare item, a sku list and dollar prices", () => {
    expect(purchaseDecisionFrom({ sku: "C-3", quantity: 4 })?.items[0]).toEqual({ sku: "C-3", quantity: 4 });
    expect(purchaseDecisionFrom({ items: ["D-4", "E-5"] })?.items.map((i) => i.sku)).toEqual(["D-4", "E-5"]);
    expect(purchaseDecisionFrom({ items: [{ sku: "F-6", unit_price_cents: 500 }] })?.items[0]).toMatchObject({
      quantity: 1,
      unitPriceCents: 500,
    });
  });

  it("reads a decline, by flag, by action or in prose", () => {
    expect(purchaseDecisionFrom({ action: "decline", reason: "over budget" })).toMatchObject({
      action: "decline",
      reason: "over budget",
    });
    expect(purchaseDecisionFrom({ buy: false })?.action).toBe("decline");
    expect(purchaseDecisionFrom("I won't buy this; the price doubled")?.action).toBe("decline");
  });

  it("returns null rather than guessing that silence meant decline", () => {
    expect(purchaseDecisionFrom("here is the catalogue")).toBeNull();
    expect(purchaseDecisionFrom(null)).toBeNull();
    expect(purchaseDecisionFrom({ notes: "thinking about it" })).toBeNull();
  });
});

describe("scorePurchaseDecision", () => {
  const cfg = { refunded: ["WRONG-1"] };
  const expected = { action: "buy", items: [{ sku: "RIGHT-2", quantity: 1 }] };
  const run = (actual: unknown, config: Record<string, unknown> = cfg, exp: unknown = expected) =>
    scorePurchaseDecision({ scorer: "purchase_decision", config, expected: exp, actual });

  it("passes when the agent buys the corrected item", async () => {
    await expect(run({ action: "buy", items: [{ sku: "right-2", quantity: 1 }] })).resolves.toMatchObject({
      passed: true,
      score: 1,
    });
  });

  it("passes when the agent declines, whatever the correction said", async () => {
    await expect(run({ action: "decline" })).resolves.toMatchObject({ passed: true });
    await expect(
      run("I'm not going to buy that", cfg, { action: "decline", items: [] }),
    ).resolves.toMatchObject({ passed: true });
  });

  it("fails when the refunded item is bought again, and says so", async () => {
    const r = await run({ action: "buy", items: [{ sku: "WRONG-1", quantity: 1 }] });
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0);
    expect(r.reason).toContain("bought the refunded item again");
  });

  it("fails a purchase when the human said not to buy at all", async () => {
    const r = await run({ action: "buy", items: [{ sku: "OTHER-9", quantity: 1 }] }, cfg, {
      action: "decline",
      items: [],
    });
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("should not have bought");
  });

  it("fails the right item at the wrong quantity, with partial credit", async () => {
    const r = await run({ action: "buy", items: [{ sku: "RIGHT-2", quantity: 9 }] });
    expect(r).toMatchObject({ passed: false, score: 0.5 });
    expect(r.reason).toContain("wrong quantity");
    const loose = await run(
      { action: "buy", items: [{ sku: "RIGHT-2", quantity: 9 }] },
      {
        ...cfg,
        matchQuantity: false,
      },
    );
    expect(loose.passed).toBe(true);
  });

  it("fails a purchase over the price ceiling", async () => {
    const r = await run(
      { action: "buy", items: [{ sku: "RIGHT-2", quantity: 1, unitPriceCents: 9000 }] },
      {
        ...cfg,
        maxUnitPriceCents: 5000,
      },
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("ceiling");
  });

  it("fails an output with no decision in it", async () => {
    await expect(run("the catalogue has three options")).resolves.toMatchObject({
      passed: false,
      reason: "no purchase decision in the output",
    });
  });
});

describe("correctionFromStripeEvent", () => {
  const charge = (over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => ({
    id: "evt_1",
    type: "charge.refunded",
    data: {
      object: {
        id: "ch_1",
        payment_intent: "pi_1",
        amount: 4999,
        amount_refunded: 4999,
        currency: "usd",
        refunds: { data: [{ reason: "requested_by_customer" }] },
        metadata: { overturn_run_id: "01924f3f-0000-7000-8000-000000000001", ...meta },
        ...over,
      },
    },
  });

  it("captures a full refund with the money on it, blaming nobody", () => {
    const c = correctionFromStripeEvent(charge());
    expect(c).toMatchObject({
      source: "stripe",
      eventId: "evt_1",
      orderId: "pi_1",
      runId: "01924f3f-0000-7000-8000-000000000001",
      amountCents: 4999,
      currency: "usd",
      // requested_by_customer is a changed mind as often as an agent mistake; it is not evidence.
      reasonCode: "unattributed",
      partial: false,
      corrected: { action: "decline", items: [] },
    });
    expect(c?.tags).toContain("commerce:refund");
    expect(c?.note).toContain("$49.99");
  });

  it("marks a partial refund partial without calling it overpaying", () => {
    const c = correctionFromStripeEvent(charge({ amount_refunded: 1000, refunds: { data: [] } }));
    expect(c).toMatchObject({ amountCents: 1000, partial: true, reasonCode: "unattributed" });
  });

  it("leaves a provider reason that says nothing about fault unattributed", () => {
    for (const reason of ["requested_by_customer", "insufficient_funds", "subscription_canceled"]) {
      expect(correctionFromStripeEvent(charge({ refunds: { data: [{ reason }] } }))?.reasonCode).toBe(
        "unattributed",
      );
    }
  });

  it("uses the provider's reason and the agent's corrected sku when they are given", () => {
    const c = correctionFromStripeEvent(
      charge({ refunds: { data: [{ reason: "duplicate" }] } }, { overturn_corrected_sku: "SKU-9" }),
    );
    expect(c?.reasonCode).toBe("duplicate_order");
    expect(c?.corrected).toEqual({ action: "buy", items: [{ sku: "SKU-9", quantity: 1 }] });
  });

  it("maps a dispute, and takes an explicit reason code over the provider's", () => {
    const c = correctionFromStripeEvent({
      id: "evt_2",
      type: "charge.dispute.created",
      data: { object: { id: "dp_1", charge: "ch_2", amount: 2500, currency: "usd", reason: "fraudulent" } },
    });
    expect(c).toMatchObject({ amountCents: 2500, reasonCode: "fraudulent", orderId: "ch_2" });
    const override = correctionFromStripeEvent(charge({}, { overturn_reason_code: "out_of_policy" }));
    expect(override?.reasonCode).toBe("out_of_policy");
    expect(correctionFromStripeEvent(charge({}, { overturn_reason_code: "not_a_code" }))?.reasonCode).toBe(
      "unattributed",
    );
  });

  it("ignores every other event so the endpoint can answer 200", () => {
    expect(
      correctionFromStripeEvent({ id: "evt_3", type: "payment_intent.succeeded", data: { object: {} } }),
    ).toBeNull();
    expect(correctionFromStripeEvent({ type: "charge.refunded" })).toBeNull();
  });
});

describe("correctionFromOrderEvent", () => {
  it("maps a cancelled Rye order", () => {
    const c = correctionFromOrderEvent(
      {
        id: "ev_9",
        type: "ORDER_CANCELLED",
        data: {
          order_id: "ord_7",
          status: "cancelled",
          reason: "out_of_stock",
          total: 120.5,
          currency: "usd",
          items: [{ sku: "X-1", quantity: 1 }],
          metadata: { overturn_external_id: "cart-42" },
        },
      },
      "rye",
    );
    expect(c).toMatchObject({
      source: "rye",
      orderId: "ord_7",
      externalId: "cart-42",
      amountCents: 12050,
      reasonCode: "late_or_undeliverable",
      corrected: { action: "decline" },
    });
    expect(c?.tags).toContain("source:rye");
  });

  it("maps a Zinc failure and falls back to an event id of its own", () => {
    const c = correctionFromOrderEvent(
      { request_id: "req_3", _type: "error", code: "duplicate", price_components: { total: 899 } },
      "zinc",
    );
    expect(c).toMatchObject({ eventId: "zinc:req_3:error", reasonCode: "duplicate_order", amountCents: 899 });
  });

  it("ignores an order that stood, and anything with no id", () => {
    expect(correctionFromOrderEvent({ data: { order_id: "o1", status: "delivered" } }, "rye")).toBeNull();
    expect(correctionFromOrderEvent({ data: { status: "cancelled" } }, "zinc")).toBeNull();
  });
});

describe("the pack", () => {
  it("is selectable and labels its codes", () => {
    expect(reasonPackFrom("commerce")).toBe("commerce");
    expect(REASON_PACKS.commerce).toBe(COMMERCE_REASON_CODES);
    expect(reasonCodeLabel("wrong_variant")).toBe("Wrong size / variant");
  });

  it("renders the snapshot the replay re-runs against", () => {
    const text = renderPurchaseSnapshot({
      instruction: "Order more of the blue mugs",
      budgetCents: 5000,
      cart: [{ sku: "MUG-B", title: "Blue mug", quantity: 2, unitPriceCents: 1200 }],
      catalogue: [{ sku: "MUG-R", title: "Red mug", quantity: 1, unitPriceCents: 1100 }],
      currency: "usd",
    });
    expect(text).toContain("Order more of the blue mugs");
    expect(text).toContain("Budget: $50.00");
    expect(text).toContain("2× Blue mug ($12.00) [MUG-B]");
    expect(text).toContain("Red mug ($11.00) [MUG-R]");
  });

  it("turns a decision into a capture answer whose fields are scored", () => {
    const a = decisionAsAnswer({ action: "buy", items: [{ sku: "Z-1", quantity: 3 }] });
    expect(a.fields).toEqual({ action: "buy", items: [{ sku: "Z-1", quantity: 3 }] });
    expect(a.text).toBe("3× Z-1");
    expect(describeDecision({ action: "decline", items: [] })).toBe("do not buy");
    expect(formatMoney(4999)).toBe("$49.99");
    expect(formatMoney(4999, "eur")).toBe("49.99 EUR");
  });

  it("reads the metadata the buying agent leaves on the payment", () => {
    const m = commerceMetadataFrom({
      overturn_run_id: "r1",
      overturn_corrected: '{"action":"buy","items":[{"sku":"Q-1","quantity":2}]}',
      overturn_agent: "buyer",
    });
    expect(m.runId).toBe("r1");
    expect(m.agent).toBe("buyer");
    expect(m.corrected).toEqual({ action: "buy", items: [{ sku: "Q-1", quantity: 2 }] });
    expect(commerceMetadataFrom({ overturn_corrected: "{broken" }).corrected).toBeNull();
  });
});
