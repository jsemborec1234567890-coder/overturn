import type { ReportRow } from "@overturn-ai/shared";
import { describe, expect, it } from "vitest";
import { gateFor } from "./replay.service";

const row = (over: Partial<ReportRow>): ReportRow =>
  ({
    caseId: "01935000-0000-7000-8000-00000000b001",
    title: "bought the wrong mug",
    kind: "edit",
    agent: "purchasing-agent",
    runId: "01935000-0000-7000-8000-00000000b002",
    scorer: "purchase_decision",
    verdict: "pass",
    passed: true,
    score: 1,
    reason: null,
    baselineOutput: null,
    targetOutput: null,
    expected: null,
    note: null,
    actor: null,
    error: null,
    costUsd: null,
    latencyMs: null,
    ...over,
  }) as ReportRow;

describe("the CI gate", () => {
  it("is green with nothing to report", () => {
    expect(gateFor([row({})], true)).toMatchObject({ pass: true, reasons: [], moneyAtRiskCents: 0 });
  });

  it("blocks when a past refund would happen again, and says what it cost", () => {
    const gate = gateFor(
      [
        row({ verdict: "regression", passed: false, amountCents: 6000, currency: "usd" }),
        row({ verdict: "regression", passed: false, amountCents: 4250, currency: "usd" }),
        row({ verdict: "fail", passed: false, amountCents: 9999 }),
      ],
      true,
    );
    expect(gate.pass).toBe(false);
    expect(gate.moneyAtRiskCents).toBe(10250);
    expect(gate.reasons[0]).toBe("2 regressions ($102.50 of past refunds would happen again)");
  });

  it("counts only regressions as money at risk: a case that was already failing is not new damage", () => {
    const gate = gateFor([row({ verdict: "fail", passed: false, amountCents: 9999 })], true);
    expect(gate).toMatchObject({ pass: true, moneyAtRiskCents: 0 });
  });

  it("keeps its old wording when no case carries money", () => {
    const gate = gateFor([row({ verdict: "regression", passed: false })], true);
    expect(gate.reasons).toEqual(["1 regression"]);
  });

  it("still blocks on unaccepted new paths", () => {
    expect(gateFor([row({ verdict: "new_path" })], true).pass).toBe(false);
    expect(gateFor([row({ verdict: "new_path" })], false).pass).toBe(true);
  });
});
