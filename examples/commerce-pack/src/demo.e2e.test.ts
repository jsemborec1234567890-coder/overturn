/**
 * End to end: a purchase recorded through the SDK, refunded through the webhook, scored by the
 * replay, and counted on the scorecard. Needs TEST_DATABASE_URL and the API built.
 */
import { Overturn } from "@overturn-ai/sdk";
import { type Case, type PurchaseDecision, scorePurchaseDecision } from "@overturn-ai/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDemo, SNAPSHOT, WRONG_DECISION } from "./demo.js";

// The API is CommonJS; import its test harness through the built output.
const harness = await import("../../../apps/api/dist/test/harness.js");

let ctx: Awaited<ReturnType<typeof harness.startTestApp>>;
let ov: Overturn;
let demo: Awaited<ReturnType<typeof runDemo>>;

beforeAll(async () => {
  ctx = await harness.startTestApp();
  ov = new Overturn({ apiKey: ctx.apiKey, baseUrl: ctx.baseUrl });
  demo = await runDemo(ov, ctx.baseUrl);
});
afterAll(async () => {
  await ov.shutdown();
  await ctx.close();
});

describe("a refund becomes a regression test", () => {
  it("lands as a case on the run that made the purchase", () => {
    expect(demo.caseId).toBeTruthy();
    expect(demo.amountCents).toBe(2200);
  });

  it("freezes what the agent saw, so the replay asks the same question again", async () => {
    const kase = await ov.api.request<Case>("GET", `/v1/cases/${demo.caseId}`);
    expect(kase.scorer).toBe("purchase_decision");
    expect(kase.agent).toBe("purchasing-agent");
    expect(kase.recordedModel).toBe("gpt-4.1-mini");
    const prompt = JSON.stringify(kase.frozenInput);
    expect(prompt).toContain("Reorder two, nothing over $30 each");
    expect(prompt).toContain("MUG-B");
    expect(kase.expected).toMatchObject({ action: "buy", items: [{ sku: "MUG-B", quantity: 2 }] });
    expect(kase.scorerConfig).toMatchObject({ refunded: ["MUG-R"] });
  });

  it("scores the next model the way the gate will", async () => {
    const kase = await ov.api.request<Case>("GET", `/v1/cases/${demo.caseId}`);
    const score = (actual: PurchaseDecision | string) =>
      scorePurchaseDecision({
        scorer: "purchase_decision",
        config: kase.scorerConfig as Record<string, unknown>,
        expected: kase.expected,
        actual,
      });
    // The same mistake again: this is what turns the CI check red.
    await expect(score(WRONG_DECISION)).resolves.toMatchObject({ passed: false });
    // The fix the human asked for.
    await expect(score({ action: "buy", items: [{ sku: "MUG-B", quantity: 2 }] })).resolves.toMatchObject({
      passed: true,
    });
    // Not spending the money is never the expensive mistake.
    await expect(score("The blue mug is out of stock, so I won't order a substitute")).resolves.toMatchObject(
      { passed: true },
    );
  });

  it("puts the money against the model version that spent it", () => {
    const row = demo.lostByModel.find((m) => m.model === "gpt-4.1-mini");
    expect(row).toMatchObject({ agentVersion: "buyer-2.1", amountCents: 2200, edited: 1 });
  });

  it("keeps the snapshot a buyer would recognise", () => {
    expect(SNAPSHOT.catalogue?.map((c) => c.sku)).toContain("MUG-B");
    expect(WRONG_DECISION.items[0]?.sku).toBe("MUG-R");
  });
});
