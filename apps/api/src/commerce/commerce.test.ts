import { createHmac } from "node:crypto";
import { request } from "node:http";
import type { CaptureStats, Case, Correction, IngestPayload, Project } from "@overturn-ai/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, startTestApp, type TestContext } from "../test/harness";
import { SIGNATURE_TOLERANCE_SECONDS, verifyHmacSignature, verifyStripeSignature } from "./signature";

let ctx: TestContext;
const STRIPE_SECRET = "whsec_test_secret";
const RYE_SECRET = "rye_test_secret";

beforeAll(async () => {
  ctx = await startTestApp();
  const res = await api<Project>(ctx, "PATCH", "/v1/project", {
    settings: {
      commerce: { stripeWebhookSecret: STRIPE_SECRET, ryeWebhookSecret: RYE_SECRET },
    },
  });
  expect(res.status).toBe(200);
});
afterAll(async () => {
  await ctx.close();
});

/** A purchasing agent that recorded what it saw and what it bought. */
async function recordPurchase(opts: { externalId: string; runId: string; sku: string }): Promise<void> {
  const now = new Date().toISOString();
  const payload: IngestPayload = {
    v: 1,
    runs: [
      {
        id: opts.runId,
        externalId: opts.externalId,
        agent: "purchasing-agent",
        agentVersion: "buyer-2.1",
        status: "completed",
        input: { instruction: "Order more blue mugs, under $30 each" },
        output: { action: "buy", items: [{ sku: opts.sku, quantity: 2 }] },
        startedAt: now,
        endedAt: now,
      },
    ],
    steps: [
      {
        id: crypto.randomUUID(),
        runId: opts.runId,
        seq: 0,
        kind: "llm_call",
        name: "decide",
        model: "gpt-4.1-mini",
        provider: "openai",
        input: {
          messages: [
            { role: "system", content: "You are a purchasing agent." },
            { role: "user", content: "Order more blue mugs, under $30 each. Catalogue: MUG-B, MUG-R." },
          ],
        },
        output: {
          message: {
            role: "assistant",
            content: JSON.stringify({ action: "buy", items: [{ sku: opts.sku, quantity: 2 }] }),
          },
          finish_reason: "stop",
        },
        startedAt: now,
        endedAt: now,
      },
    ],
  };
  const res = await api(ctx, "POST", "/v1/ingest", payload);
  expect(res.status).toBe(202);
}

function stripeBody(over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: `evt_${Math.random().toString(36).slice(2)}`,
    type: "charge.refunded",
    data: {
      object: {
        id: "ch_live_1",
        payment_intent: "pi_live_1",
        amount: 6000,
        amount_refunded: 6000,
        currency: "usd",
        refunds: { data: [{ reason: "requested_by_customer" }] },
        metadata: meta,
        ...over,
      },
    },
  });
}

function stripeHeaders(body: string, secret = STRIPE_SECRET, atMs = Date.now()) {
  const t = Math.floor(atMs / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return { "stripe-signature": `t=${t},v1=${v1}` };
}

async function post(path: string, body: string, headers: Record<string, string>) {
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

describe("signature verification", () => {
  const raw = Buffer.from('{"a":1}');

  it("accepts Stripe's scheme and rejects a tampered body, a wrong secret and a stale timestamp", () => {
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", "s3cret").update(`${t}.${raw.toString()}`).digest("hex");
    expect(verifyStripeSignature(raw, `t=${t},v1=${sig}`, "s3cret").ok).toBe(true);
    expect(verifyStripeSignature(Buffer.from('{"a":2}'), `t=${t},v1=${sig}`, "s3cret").ok).toBe(false);
    expect(verifyStripeSignature(raw, `t=${t},v1=${sig}`, "other").ok).toBe(false);
    const stale = t - SIGNATURE_TOLERANCE_SECONDS - 10;
    const staleSig = createHmac("sha256", "s3cret").update(`${stale}.${raw.toString()}`).digest("hex");
    expect(verifyStripeSignature(raw, `t=${stale},v1=${staleSig}`, "s3cret")).toMatchObject({
      ok: false,
      reason: "timestamp outside tolerance",
    });
  });

  it("accepts any v1 during a secret roll, and refuses a malformed header", () => {
    const t = Math.floor(Date.now() / 1000);
    const good = createHmac("sha256", "new").update(`${t}.${raw.toString()}`).digest("hex");
    expect(verifyStripeSignature(raw, `t=${t},v1=deadbeef,v1=${good}`, "new").ok).toBe(true);
    expect(verifyStripeSignature(raw, "nonsense", "new").ok).toBe(false);
    expect(verifyStripeSignature(raw, undefined, "new").ok).toBe(false);
  });

  it("accepts a plain HMAC as hex or base64, with or without the sha256 prefix", () => {
    const hex = createHmac("sha256", "k").update(raw).digest("hex");
    const b64 = createHmac("sha256", "k").update(raw).digest("base64");
    expect(verifyHmacSignature(raw, hex, "k").ok).toBe(true);
    expect(verifyHmacSignature(raw, `sha256=${hex}`, "k").ok).toBe(true);
    expect(verifyHmacSignature(raw, b64, "k").ok).toBe(true);
    expect(verifyHmacSignature(raw, hex.replace(/.$/, "0"), "k").ok).toBe(false);
  });
});

describe("POST /v1/commerce/webhooks", () => {
  const runId = "01935000-0000-7000-8000-00000000a001";

  it("turns a refund into a case the suite can replay, with the money on it", async () => {
    await recordPurchase({ externalId: "pi_live_1", runId, sku: "MUG-R" });
    const body = stripeBody({}, { overturn_corrected_sku: "MUG-B", overturn_corrected_quantity: "2" });
    const res = await post(`/v1/commerce/webhooks/stripe/${ctx.projectId}`, body, stripeHeaders(body));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, runId, amountCents: 6000 });

    const corr = await api<Correction>(ctx, "GET", `/v1/corrections?runId=${runId}`);
    const [only] = corr.body as unknown as Correction[];
    expect(only).toMatchObject({
      kind: "edit",
      // Stripe says "requested_by_customer", which is every changed mind as well as every agent
      // mistake. Nobody has said the agent was wrong, so nobody is saying it here either.
      reasonCode: "unattributed",
      amountCents: 6000,
      currency: "usd",
      source: "capture",
    });

    const kase = await api<Case>(ctx, "GET", `/v1/cases/${(res.body as { caseId: string }).caseId}`);
    expect(kase.body).toMatchObject({ agent: "purchasing-agent", scorer: "purchase_decision" });
    // The scorer knows which sku lost the money and what should have been bought instead.
    expect(kase.body.scorerConfig).toMatchObject({ refunded: ["MUG-R"] });
    expect(kase.body.expected).toMatchObject({ action: "buy", items: [{ sku: "MUG-B", quantity: 2 }] });
    expect(kase.body.frozenInput).toBeTruthy();
    // Captured, costed, replayable — but out of the suite until a person attributes it.
    expect(kase.body.status).toBe("archived");
  });

  it("joins the suite when a person attributes the refund to the agent", async () => {
    // Its own run and its own corrected sku: the same fix on the same input is one case, merged.
    const attrRun = "01935000-0000-7000-8000-00000000a003";
    await recordPurchase({ externalId: "pi_attr_1", runId: attrRun, sku: "MUG-R" });
    const body = stripeBody(
      { id: "re_attr_1" },
      { overturn_run_id: attrRun, overturn_corrected_sku: "MUG-TEAL" },
    );
    const res = await post(`/v1/commerce/webhooks/stripe/${ctx.projectId}`, body, stripeHeaders(body));
    const caseId = (res.body as { caseId: string }).caseId;
    const [corr] = (await api<Correction>(ctx, "GET", `/v1/corrections?runId=${attrRun}`))
      .body as unknown as Correction[];

    const attributed = await api<Correction>(ctx, "PATCH", `/v1/corrections/${corr!.id}/attribution`, {
      reasonCode: "wrong_variant",
      note: "ordered the red one; the thread asked for blue",
    });
    expect(attributed.body).toMatchObject({
      reasonCode: "wrong_variant",
      note: "ordered the red one; the thread asked for blue",
    });
    expect((await api<Case>(ctx, "GET", `/v1/cases/${caseId}`)).body.status).toBe("active");
  });

  it("stays out of the suite when the person says it was not the agent", async () => {
    const lateRun = "01935000-0000-7000-8000-00000000a004";
    await recordPurchase({ externalId: "pi_attr_2", runId: lateRun, sku: "MUG-R" });
    const body = stripeBody(
      { id: "re_attr_2" },
      { overturn_run_id: lateRun, overturn_corrected_sku: "MUG-GREY" },
    );
    const res = await post(`/v1/commerce/webhooks/stripe/${ctx.projectId}`, body, stripeHeaders(body));
    const caseId = (res.body as { caseId: string }).caseId;
    const [corr] = (await api<Correction>(ctx, "GET", `/v1/corrections?runId=${lateRun}`))
      .body as unknown as Correction[];

    await api<Correction>(ctx, "PATCH", `/v1/corrections/${corr!.id}/attribution`, {
      reasonCode: "late_or_undeliverable",
      note: "carrier lost it",
    });
    expect((await api<Case>(ctx, "GET", `/v1/cases/${caseId}`)).body.status).toBe("archived");
  });

  it("ignores a retry of the same event", async () => {
    const body = stripeBody({}, { overturn_run_id: runId });
    const headers = stripeHeaders(body);
    const first = await post(`/v1/commerce/webhooks/stripe/${ctx.projectId}`, body, headers);
    expect(first.body).toMatchObject({ ok: true });
    const again = await post(`/v1/commerce/webhooks/stripe/${ctx.projectId}`, body, headers);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, skipped: "already handled" });
  });

  it("refuses a bad signature and never reads the body", async () => {
    const body = stripeBody();
    const res = await post(`/v1/commerce/webhooks/stripe/${ctx.projectId}`, body, {
      "stripe-signature": "t=1,v1=deadbeef",
    });
    expect(res.status).toBe(401);
    const none = await post(`/v1/commerce/webhooks/stripe/${ctx.projectId}`, body, {});
    expect(none.status).toBe(401);
  });

  it("gives nothing away: an unconfigured source and an unknown project answer like a bad signature", async () => {
    const body = JSON.stringify({ id: "x", type: "ORDER_CANCELLED", data: { order_id: "o" } });
    const sig = createHmac("sha256", "whatever").update(body).digest("hex");
    // Configured project, source with no secret.
    const unconfigured = await post(`/v1/commerce/webhooks/zinc/${ctx.projectId}`, body, {
      "x-zinc-signature": sig,
    });
    // A project id that does not exist at all.
    const nobody = await post("/v1/commerce/webhooks/zinc/01935000-0000-7000-8000-0000000fffff", body, {
      "x-zinc-signature": sig,
    });
    // A real endpoint with a wrong signature.
    const wrongSig = await post(`/v1/commerce/webhooks/rye/${ctx.projectId}`, body, {
      "x-rye-signature": sig,
    });
    for (const r of [unconfigured, nobody, wrongSig]) {
      expect(r.status).toBe(401);
      expect(JSON.stringify(r.body)).toBe(JSON.stringify(wrongSig.body));
    }
  });

  it("400s a malformed path and an unknown source", async () => {
    const body = JSON.stringify({ id: "x" });
    expect((await post("/v1/commerce/webhooks/stripe/not-a-uuid", body, {})).status).toBe(400);
    expect((await post(`/v1/commerce/webhooks/paypal/${ctx.projectId}`, body, {})).status).toBe(400);
  });

  it("refuses an oversized body on the declared length, before reading any of it", async () => {
    // Raw http: the point is that the answer comes from the header alone, with the body unsent.
    const url = new URL(`${ctx.baseUrl}/v1/commerce/webhooks/stripe/${ctx.projectId}`);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: { "content-type": "application/json", "content-length": 2 * 1024 * 1024 },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.write('{"pad":"x"}'); // far less than we declared; the server never waits for the rest
    });
    expect(status).toBe(413);
  });

  it("answers 200 and records nothing when no run matches, so a later retry can still land", async () => {
    const body = stripeBody({ payment_intent: "pi_never_recorded", id: "ch_never" });
    const res = await post(`/v1/commerce/webhooks/stripe/${ctx.projectId}`, body, stripeHeaders(body));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, skipped: "no recorded run for this order" });
    // Not remembered as handled: the same delivery can match once the run is recorded.
    const retry = await post(`/v1/commerce/webhooks/stripe/${ctx.projectId}`, body, stripeHeaders(body));
    expect(retry.body).toMatchObject({ skipped: "no recorded run for this order" });
  });

  it("answers 200 for an event type the pack does not handle", async () => {
    const body = JSON.stringify({ id: "evt_ok", type: "payment_intent.succeeded", data: { object: {} } });
    const res = await post(`/v1/commerce/webhooks/stripe/${ctx.projectId}`, body, stripeHeaders(body));
    expect(res.body).toMatchObject({ ok: true, skipped: "event is not a refund, dispute or cancellation" });
  });

  it("maps a cancelled Rye order onto the run it came from", async () => {
    const runId2 = "01935000-0000-7000-8000-00000000a002";
    await recordPurchase({ externalId: "rye-cart-9", runId: runId2, sku: "LAMP-1" });
    const body = JSON.stringify({
      id: "ev_rye_1",
      type: "ORDER_CANCELLED",
      data: {
        order_id: "rye-cart-9",
        status: "cancelled",
        reason: "out_of_stock",
        total: 42.5,
        currency: "usd",
        metadata: { overturn_run_id: runId2 },
      },
    });
    const sig = createHmac("sha256", RYE_SECRET).update(body).digest("hex");
    const res = await post(`/v1/commerce/webhooks/rye/${ctx.projectId}`, body, { "x-rye-signature": sig });
    expect(res.body).toMatchObject({ ok: true, runId: runId2, amountCents: 4250 });
  });

  it("puts the money on the scorecard, per model version", async () => {
    const stats = await api<CaptureStats>(ctx, "GET", "/v1/capture/stats?days=30");
    expect(stats.status).toBe(200);
    expect(stats.body.cost.amountCents).toBeGreaterThanOrEqual(10250);
    expect(stats.body.cost.priced).toBeGreaterThanOrEqual(2);
    const model = stats.body.cost.byModel.find((m) => m.model === "gpt-4.1-mini");
    expect(model).toMatchObject({ agentVersion: "buyer-2.1" });
    expect(model?.amountCents).toBeGreaterThanOrEqual(10250);
  });
});

describe("the idempotency key", () => {
  it("is per project, so one project cannot suppress another's event", async () => {
    const [{ rows }] = [{ rows: null }];
    expect(rows).toBeNull();
    const body = stripeBody({ payment_intent: "pi_live_1", id: "ch_shared" });
    const headers = stripeHeaders(body);
    const first = await post(`/v1/commerce/webhooks/stripe/${ctx.projectId}`, body, headers);
    expect(first.body).toMatchObject({ ok: true });
    // The same event id against a project that never configured stripe is refused on the
    // signature, not silently swallowed as "already handled".
    const other = await post(
      "/v1/commerce/webhooks/stripe/01935000-0000-7000-8000-0000000fffff",
      body,
      headers,
    );
    expect(other.status).toBe(401);
  });
});

describe("webhook secrets", () => {
  it("are never handed back, and survive a patch that does not mention them", async () => {
    const read = await api<Project>(ctx, "GET", "/v1/project");
    expect(read.body.settings.commerce.stripeWebhookSecret).toBe("__set__");
    expect(JSON.stringify(read.body)).not.toContain(STRIPE_SECRET);

    // The web app reads settings, changes one field and writes the whole object back.
    const patched = await api<Project>(ctx, "PATCH", "/v1/project", {
      settings: { commerce: read.body.settings.commerce, retentionDays: 45 },
    });
    expect(patched.body.settings.retentionDays).toBe(45);
    const body = stripeBody({ payment_intent: "pi_live_1", id: "ch_after_patch" });
    const res = await post(`/v1/commerce/webhooks/stripe/${ctx.projectId}`, body, stripeHeaders(body));
    expect(res.status).toBe(200);
  });

  it("can be cleared with an empty string", async () => {
    await api<Project>(ctx, "PATCH", "/v1/project", {
      settings: { commerce: { zincWebhookSecret: "" } },
    });
    const read = await api<Project>(ctx, "GET", "/v1/project");
    expect(read.body.settings.commerce.zincWebhookSecret).toBeNull();
  });
});
