/**
 * The commerce pack: a refund, a dispute or a cancelled order is a human correcting an agent's
 * purchase, and the money on it says what the mistake cost. This file is the pure half — the
 * shapes, the parsing and the mapping from a provider event to a capture. Signature checks,
 * idempotency and the database live in the API (apps/api/src/commerce).
 *
 * The pack is an adapter, not a second product: an event becomes an ordinary correction record
 * through the same capture path a Zendesk reply takes, so replay, cases, the gate and the
 * scorecard work on it unchanged.
 */
import type { CaptureAnswer } from "./schemas.js";

export const COMMERCE_SOURCES = ["stripe", "rye", "zinc"] as const;
export type CommerceSource = (typeof COMMERCE_SOURCES)[number];

/** The commerce pack: why a purchase was refunded, disputed or cancelled. */
export const COMMERCE_REASON_CODES = [
  { code: "unattributed", label: "Not attributed yet" },
  { code: "wrong_item", label: "Wrong item" },
  { code: "wrong_variant", label: "Wrong size / variant" },
  { code: "wrong_quantity", label: "Wrong quantity" },
  { code: "overpaid", label: "Paid too much" },
  { code: "duplicate_order", label: "Duplicate order" },
  { code: "should_not_have_bought", label: "Should not have bought" },
  { code: "out_of_policy", label: "Against purchase policy" },
  { code: "not_authorised", label: "Not authorised by the user" },
  { code: "fraudulent", label: "Fraudulent / disputed" },
  { code: "late_or_undeliverable", label: "Late or undeliverable" },
] as const;

/** One line of a purchase: what the agent bought, or what it should have bought instead. */
export interface PurchaseLine {
  sku: string;
  title?: string | null;
  quantity: number;
  unitPriceCents?: number | null;
}

/** What the agent decided to do with the cart. `decline` is always a safe answer on replay. */
export interface PurchaseDecision {
  action: "buy" | "decline";
  items: PurchaseLine[];
  /** The agent's own one line on why, when it gave one. */
  reason?: string | null;
}

/** What the agent saw before it decided: the replay re-runs against exactly this. */
export interface PurchaseSnapshot {
  /** What the user asked for, in their words. */
  instruction: string;
  cart?: PurchaseLine[];
  catalogue?: PurchaseLine[];
  budgetCents?: number | null;
  currency?: string | null;
}

/** A provider event, read and mapped. The API turns this into a capture. */
export interface CommerceCorrection {
  source: CommerceSource;
  /** The provider's id for this event; the API uses it to ignore retries. */
  eventId: string;
  /** The order, charge or payment this is about. */
  orderId: string;
  /** Set when the buying agent recorded its run and put the id on the payment. */
  runId: string | null;
  /** The externalId the run was recorded under, when the metadata carries one. */
  externalId: string | null;
  /** What the mistake cost, in the smallest unit of the currency. Never negative. */
  amountCents: number;
  currency: string;
  reasonCode: string;
  /** One line for the case title and the judge's rubric. */
  note: string;
  /** What the agent should have done: buy the replacement, or not buy at all. */
  corrected: PurchaseDecision;
  /** What the order actually contained, when the provider tells us. */
  bought: PurchaseLine[];
  /** True for a partial refund: some of the order stood. */
  partial: boolean;
  tags: string[];
}

// ---------- parsing ----------

/**
 * A structured field (`action`, `status`, `decision`) names what the agent chose, so the whole
 * word has to be one of these: a prefix match would read a payment's `status: "rejected"` as the
 * agent declining, and `"nonexistent"` as `"none"`. Free prose is looser still — "aborted" or
 * "I'll ask the user" can be about anything — so prose has to name the purchase it turns down.
 * Either way a false decline is the dangerous direction: it passes a release that never re-decided.
 */
const DECLINE_ACTIONS = new Set([
  "decline",
  "declined",
  "declines",
  "no_purchase",
  "no-purchase",
  "no purchase",
  "nopurchase",
  "no_buy",
  "no-buy",
  "no_order",
  "no-order",
  "skip",
  "skipped",
  "abort",
  "aborted",
  "none",
  "hold",
  "held",
]);
const DECLINE_PROSE_RE =
  /\b((?:declin\w*|refus\w*|abort\w*|held? off|hold off|holding off|skipp?\w*)\s+(?:\w+\s+){0,4}?(?:buy|buying|order|ordering|purchas\w*|checkout|cart)|(?:will not|won'?t|do not|don'?t|cannot|can'?t|should not|shouldn'?t|did not|didn'?t|am not|'?m not)\s+(?:\w+\s+){0,3}?(?:buy|buying|order|ordering|purchas\w*|checkout)|not\s+(?:\w+\s+){0,3}?(?:buy|buying|order|ordering|purchas\w*)|no purchase|ask the user (?:\w+\s+){0,4}?(?:buy|order|purchas\w*|confirm))/i;
const BUY_TOOL_RE = /(buy|order|purchase|checkout|cart_add|add_to_cart|place_order|pay)/i;

function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function first(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

/**
 * Money as the smallest unit. `*_cents` and `amount` are already minor units (the Stripe
 * convention); `price`, `unit_price` and `total` are major units (the Rye convention), which is
 * why an order's total is read by orderAmountCents below rather than guessed here.
 */
function centsFrom(o: Record<string, unknown>): number | null {
  const minor = first(o, ["unit_price_cents", "unitPriceCents", "price_cents", "amount_cents", "amount"]);
  if (typeof minor === "number" && Number.isFinite(minor)) return Math.round(minor);
  if (typeof minor === "string" && minor.trim() !== "" && Number.isFinite(Number(minor)))
    return Math.round(Number(minor));
  const major = first(o, ["unit_price", "unitPrice", "price", "total"]);
  if (typeof major === "number" && Number.isFinite(major)) return Math.round(major * 100);
  if (typeof major === "string") {
    const n = Number(major.replace(/[^0-9.-]/g, ""));
    if (major.trim() !== "" && Number.isFinite(n)) return Math.round(n * 100);
  }
  return null;
}

/**
 * An order's total. Zinc reports `price_components` in cents, Rye reports a `total` in dollars,
 * and Stripe reports `amount` in cents, so the field decides the unit — never the value.
 */
function orderAmountCents(data: Record<string, unknown>): number | null {
  const pc = obj(data.price_components) ?? obj(data.priceComponents);
  const pcTotal = pc ? first(pc, ["total", "subtotal"]) : undefined;
  if (typeof pcTotal === "number" && Number.isFinite(pcTotal)) return Math.round(pcTotal);
  const minor = first(data, ["amount_cents", "amountCents", "total_cents", "totalCents", "amount"]);
  if (typeof minor === "number" && Number.isFinite(minor)) return Math.round(minor);
  return centsFrom(data);
}

export function purchaseLineFrom(value: unknown): PurchaseLine | null {
  const o = obj(value);
  if (!o) {
    // A bare string is a sku: ["SKU-1", "SKU-2"].
    const s = str(value);
    return s ? { sku: s, quantity: 1 } : null;
  }
  const sku = str(
    first(o, ["sku", "variant_id", "variantId", "product_id", "productId", "asin", "id", "item_id"]),
  );
  if (!sku) return null;
  const q = first(o, ["quantity", "qty", "count", "units"]);
  const quantity = typeof q === "number" && Number.isFinite(q) ? Math.max(0, Math.round(q)) : Number(q) || 1;
  const cents = centsFrom(o);
  const title = str(first(o, ["title", "name", "description"]));
  return {
    sku,
    quantity: quantity > 0 ? quantity : 1,
    ...(title ? { title } : {}),
    ...(cents !== null ? { unitPriceCents: cents } : {}),
  };
}

function linesFrom(value: unknown): PurchaseLine[] {
  if (Array.isArray(value)) return value.map(purchaseLineFrom).filter((l): l is PurchaseLine => l !== null);
  const one = purchaseLineFrom(value);
  return one ? [one] : [];
}

/**
 * Read a purchase decision out of whatever the agent returned: the capture shape
 * ({action, items}), a tool call (place_order / add_to_cart), a bare {sku, quantity},
 * or a sentence that says it is not buying. Null when none of those fit — the scorer
 * fails loudly rather than guessing that silence meant "declined".
 */
export function purchaseDecisionFrom(value: unknown): PurchaseDecision | null {
  if (value === null || value === undefined) return null;

  if (typeof value === "string") {
    return DECLINE_PROSE_RE.test(value)
      ? { action: "decline", items: [], reason: value.trim().slice(0, 500) }
      : null;
  }

  const o = obj(value);
  if (!o) return null;

  // A tool decision: the buying tool is the decision.
  const calls = o.tool_calls;
  if (Array.isArray(calls)) {
    const buy = calls
      .map((c) => obj(c))
      .find((c) => c !== null && typeof c.name === "string" && BUY_TOOL_RE.test(c.name));
    if (buy) {
      const args = obj(buy.args) ?? {};
      const items = linesFrom(first(args, ["items", "line_items", "lineItems", "lines"]) ?? args);
      return { action: "buy", items };
    }
    // Calling search_catalogue and stopping is not a decision to decline; it is no decision.
    return null;
  }

  const action = str(first(o, ["action", "decision", "status"]))?.toLowerCase();
  const declinedFlag =
    o.declined === true ||
    o.decline === true ||
    o.purchase === false ||
    o.buy === false ||
    o.purchased === false;
  const reason = str(first(o, ["reason", "why", "explanation", "reply"]));

  if (declinedFlag || (action && DECLINE_ACTIONS.has(action))) {
    return { action: "decline", items: [], ...(reason ? { reason } : {}) };
  }

  const items = linesFrom(first(o, ["items", "line_items", "lineItems", "lines", "products"]) ?? o);
  if (items.length > 0) return { action: "buy", items, ...(reason ? { reason } : {}) };
  if (action === "buy" || action === "purchase" || action === "order") return { action: "buy", items: [] };
  if (reason && DECLINE_PROSE_RE.test(reason)) return { action: "decline", items: [], reason };
  return null;
}

/** Skus compare case- and space-insensitively: "SKU-1" and "sku-1 " are the same item. */
export function normalizeSku(sku: string): string {
  return sku.trim().toLowerCase();
}

export function formatMoney(cents: number, currency = "usd"): string {
  const code = currency.toUpperCase();
  const amount = (cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return code === "USD" ? `$${amount}` : `${amount} ${code}`;
}

/** One line a person can read in a case title or a Slack message. */
export function describeDecision(d: PurchaseDecision, currency = "usd"): string {
  if (d.action === "decline") return "do not buy";
  if (d.items.length === 0) return "buy (no items given)";
  return d.items
    .map((i) => {
      const price = i.unitPriceCents != null ? ` at ${formatMoney(i.unitPriceCents, currency)}` : "";
      return `${i.quantity}× ${i.title ?? i.sku}${price}`;
    })
    .join(", ");
}

/** The frozen user turn: exactly what the agent saw when it decided. */
export function renderPurchaseSnapshot(s: PurchaseSnapshot): string {
  const money = (c: number | null | undefined) =>
    c == null ? "" : ` (${formatMoney(c, s.currency ?? "usd")})`;
  const parts = [`User instruction:\n${s.instruction.trim()}`];
  if (s.budgetCents != null) parts.push(`Budget: ${formatMoney(s.budgetCents, s.currency ?? "usd")}`);
  if (s.cart?.length)
    parts.push(
      `Cart:\n${s.cart.map((i) => `- ${i.quantity}× ${i.title ?? i.sku}${money(i.unitPriceCents)} [${i.sku}]`).join("\n")}`,
    );
  if (s.catalogue?.length)
    parts.push(
      `Catalogue:\n${s.catalogue.map((i) => `- ${i.title ?? i.sku}${money(i.unitPriceCents)} [${i.sku}]`).join("\n")}`,
    );
  return parts.join("\n\n");
}

/** The system turn of a purchase run. */
export function purchaseSystemPrompt(agent: string): string {
  return `You are the "${agent}" purchasing agent. Decide what to buy for the user from the catalogue below, within any budget given. Answer with the decision: the items and quantities to order, or decline to buy and say why. Buying the wrong thing costs real money; declining is better than guessing.`;
}

/** A decision as a capture answer: fields are scored exactly, the line of prose is not. */
export function decisionAsAnswer(d: PurchaseDecision, currency = "usd"): CaptureAnswer {
  return {
    text: describeDecision(d, currency),
    fields: { action: d.action, items: d.items as unknown as Record<string, unknown>[] },
  };
}

// ---------- provider mapping ----------

const VALID_CODES: ReadonlySet<string> = new Set<string>(COMMERCE_REASON_CODES.map((c) => c.code));

/**
 * A provider's reason code is an accounting category, not a human saying the agent was wrong.
 * "requested_by_customer" is every changed mind, bad fit and damaged box; "insufficient_funds" is
 * a card. Mapping those onto agent fault would fill the corpus with tests for things the agent did
 * correctly, and the gate would block releases over them — so only the few reasons that state a
 * fact the provider actually knows get a code, and everything else waits for a person.
 *
 * Nothing here is ever an agent error on the provider's say-so. Even a duplicate charge can be a
 * payment retry rather than the agent buying twice, so it lands as a fact to be attributed, and
 * the codes that are never the agent's doing are excluded from the suite outright.
 */
const STRIPE_REASONS: Record<string, string> = {
  fraudulent: "fraudulent",
  unrecognized: "fraudulent",
  product_not_received: "late_or_undeliverable",
  duplicate: "duplicate_order",
};

const CANCEL_REASONS: Record<string, string> = {
  out_of_stock: "late_or_undeliverable",
  unavailable: "late_or_undeliverable",
  duplicate: "duplicate_order",
};

/**
 * Metadata the buying agent puts on the payment or order so a refund can find its run.
 * Everything else about the event is read from the provider's own fields.
 */
export interface CommerceMetadata {
  runId: string | null;
  externalId: string | null;
  reasonCode: string | null;
  corrected: PurchaseDecision | null;
  agent: string | null;
}

export function commerceMetadataFrom(raw: unknown): CommerceMetadata {
  const m = obj(raw) ?? {};
  const get = (...keys: string[]) => str(first(m, keys));
  const correctedRaw = first(m, ["overturn_corrected", "overturnCorrected"]);
  let corrected: PurchaseDecision | null = null;
  if (typeof correctedRaw === "string") {
    try {
      corrected = purchaseDecisionFrom(JSON.parse(correctedRaw));
    } catch {
      corrected = null;
    }
  } else if (correctedRaw !== undefined) {
    corrected = purchaseDecisionFrom(correctedRaw);
  }
  if (!corrected) {
    const sku = get("overturn_corrected_sku", "overturnCorrectedSku");
    if (sku) {
      const q = Number(get("overturn_corrected_quantity", "overturnCorrectedQuantity") ?? "1");
      corrected = {
        action: "buy",
        items: [{ sku, quantity: Number.isFinite(q) && q > 0 ? Math.round(q) : 1 }],
      };
    }
  }
  const code = get("overturn_reason_code", "overturnReasonCode");
  return {
    runId: get("overturn_run_id", "overturnRunId"),
    externalId: get("overturn_external_id", "overturnExternalId"),
    reasonCode: code && VALID_CODES.has(code) ? code : null,
    corrected,
    agent: get("overturn_agent", "overturnAgent"),
  };
}

export interface StripeEventLike {
  id?: unknown;
  type?: unknown;
  data?: { object?: unknown } | unknown;
}

/**
 * A Stripe refund or dispute as a correction. Returns null for every other event type, so the
 * endpoint can answer 200 and Stripe stops retrying.
 */
export function correctionFromStripeEvent(event: StripeEventLike): CommerceCorrection | null {
  const type = str(event.type);
  const eventId = str(event.id);
  const data = obj(obj(event.data)?.object);
  if (!type || !eventId || !data) return null;

  const isRefund = type === "charge.refunded" || type === "refund.created" || type === "refund.updated";
  const isDispute = type === "charge.dispute.created";
  const isCancel = type === "payment_intent.canceled";
  if (!isRefund && !isDispute && !isCancel) return null;

  // charge.refunded hands us the charge; refund.* hands us the refund.
  const charge = type.startsWith("charge.") ? data : null;
  const meta = commerceMetadataFrom(data.metadata ?? charge?.metadata);

  const orderId =
    str(first(data, ["payment_intent", "charge", "id"])) ?? str(charge?.id) ?? str(data.id) ?? null;
  if (!orderId) return null;

  const total = typeof data.amount === "number" ? data.amount : null;
  const refunded =
    typeof data.amount_refunded === "number"
      ? data.amount_refunded
      : typeof data.amount === "number"
        ? data.amount
        : 0;
  const amountCents = Math.max(0, Math.round(isDispute ? (total ?? refunded) : refunded));
  const partial = Boolean(isRefund && total !== null && refunded > 0 && refunded < total);

  const providerReason =
    str(data.reason) ??
    str(obj(first(data, ["refunds"]))?.reason) ??
    (Array.isArray((data.refunds as { data?: unknown[] } | undefined)?.data)
      ? str(obj((data.refunds as { data: unknown[] }).data.at(-1))?.reason)
      : null);
  const mapped = providerReason ? STRIPE_REASONS[providerReason] : undefined;
  // meta.reasonCode is the integrator attributing it themselves at refund time; otherwise the
  // provider's fact if it stated one, and otherwise nobody has said why yet.
  const reasonCode = meta.reasonCode ?? mapped ?? "unattributed";

  const corrected: PurchaseDecision = meta.corrected ?? { action: "decline", items: [] };
  const currency = (str(data.currency) ?? "usd").toLowerCase();
  const what = isDispute ? "Disputed" : partial ? "Partly refunded" : "Refunded";

  return {
    source: "stripe",
    eventId,
    orderId,
    runId: meta.runId,
    externalId: meta.externalId ?? orderId,
    amountCents,
    currency,
    reasonCode,
    bought: linesFrom(first(data, ["items", "line_items", "lineItems"])),
    note: `${what} ${formatMoney(amountCents, currency)}${providerReason ? ` (${providerReason.replace(/_/g, " ")})` : ""}: ${describeDecision(corrected, currency)}`,
    corrected,
    partial,
    tags: ["commerce", `commerce:${isDispute ? "dispute" : "refund"}`, "source:stripe"],
  };
}

export interface OrderEventLike {
  id?: unknown;
  type?: unknown;
  data?: unknown;
  [k: string]: unknown;
}

/**
 * A cancelled or failed order from Rye or Zinc. Both post an order-shaped body; the fields we
 * need are the order id, a status that means "this did not stand", the money and our metadata.
 * Field names differ between them and between their API versions, so this reads a union of the
 * plausible spellings and returns null when it cannot find an order id — never a guess.
 */
export function correctionFromOrderEvent(
  payload: OrderEventLike,
  source: Exclude<CommerceSource, "stripe">,
): CommerceCorrection | null {
  const root = payload;
  const data = obj(root.data) ?? obj(root.order) ?? obj(root.request) ?? root;
  const type = (str(root.type) ?? str(root.event) ?? str(data.status) ?? str(data._type) ?? "").toLowerCase();
  const status = (str(first(data, ["status", "state", "order_status"])) ?? type).toLowerCase();

  const cancelled = /cancel|refund|fail|error|reject|return/.test(`${type} ${status}`);
  if (!cancelled) return null;

  const orderId = str(
    first(data, ["order_id", "orderId", "request_id", "id", "merchant_order_id", "external_id"]) ??
      first(root, ["order_id", "orderId", "request_id", "id"]),
  );
  if (!orderId) return null;

  const meta = commerceMetadataFrom(
    first(data, ["metadata", "client_notes", "clientNotes", "attributes"]) ?? root.metadata,
  );
  const amountCents = orderAmountCents(data) ?? 0;
  const currency = (str(first(data, ["currency", "currency_code"])) ?? "usd").toLowerCase();

  const providerReason = str(
    first(data, ["reason", "cancellation_reason", "cancelReason", "code", "message", "error_message"]),
  );
  const key = providerReason?.toLowerCase().replace(/[\s-]+/g, "_") ?? "";
  const reasonCode = meta.reasonCode ?? CANCEL_REASONS[key] ?? "unattributed";

  const corrected: PurchaseDecision = meta.corrected ?? { action: "decline", items: [] };
  const bought = linesFrom(first(data, ["items", "products", "line_items", "lineItems"]));

  return {
    source,
    eventId: str(first(root, ["id", "event_id", "eventId"])) ?? `${source}:${orderId}:${status}`,
    orderId,
    runId: meta.runId,
    externalId: meta.externalId ?? orderId,
    amountCents: Math.max(0, amountCents),
    currency,
    reasonCode,
    note: `Order ${status || "cancelled"}${providerReason ? ` (${providerReason.slice(0, 120)})` : ""}${
      bought.length ? `: ${describeDecision({ action: "buy", items: bought }, currency)}` : ""
    } → ${describeDecision(corrected, currency)}`,
    corrected,
    bought,
    partial: false,
    tags: ["commerce", "commerce:cancellation", `source:${source}`],
  };
}
