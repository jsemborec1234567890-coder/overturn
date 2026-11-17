import { Inject, Injectable, Logger, NotFoundException, UnauthorizedException } from "@nestjs/common";
import {
  type CaptureCreate,
  type CommerceCorrection,
  type CommerceSource,
  correctionFromOrderEvent,
  correctionFromStripeEvent,
  decisionAsAnswer,
  describeDecision,
  extractAnswer,
  formatMoney,
  type PurchaseDecision,
  type PurchaseLine,
  purchaseDecisionFrom,
} from "@overturn-ai/shared";
import { and, desc, eq } from "drizzle-orm";
import { CaptureService } from "../capture/capture.service";
import type { Db } from "../db/client";
import { DB } from "../db/db.module";
import { projects, runs, steps, webhookEvents } from "../db/schema";
import { parseSettings } from "../projects/settings";
import { verifyHmacSignature, verifyStripeSignature } from "./signature";

/** Every answer is a 200: a provider that gets anything else retries for days. */
export interface CommerceWebhookResult {
  ok: true;
  /** Why we did nothing, when we did nothing. */
  skipped?: string;
  /** The correction the event became. */
  correctionId?: string;
  caseId?: string | null;
  runId?: string;
  amountCents?: number;
}

const SIGNATURE_HEADER: Record<CommerceSource, string> = {
  stripe: "stripe-signature",
  rye: "x-rye-signature",
  zinc: "x-zinc-signature",
};

const SECRET_KEY = {
  stripe: "stripeWebhookSecret",
  rye: "ryeWebhookSecret",
  zinc: "zincWebhookSecret",
} as const;

/**
 * The commerce pack's capture half. A refund, dispute or cancellation arrives from the provider,
 * is checked against the endpoint's signing secret, and becomes an ordinary correction on the run
 * where the agent made the purchase — same path a Zendesk edit takes, so replay, cases, the gate
 * and the scorecard need no commerce-specific code.
 *
 * What it will not do: invent a run. If the buying agent never recorded what it saw, there is
 * nothing to replay, so the event is answered 200 and counted as unmatched rather than stored as
 * a case with no snapshot.
 */
@Injectable()
export class CommerceService {
  private readonly logger = new Logger("Commerce");

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly capture: CaptureService,
  ) {}

  async handle(
    projectId: string,
    source: CommerceSource,
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<CommerceWebhookResult> {
    // An unknown project, a source with no secret and a bad signature all answer the same way,
    // so this endpoint cannot be used to find out which project ids exist or what they use.
    const secret = await this.secretFor(projectId, source);
    this.verify(source, rawBody, headers, secret ?? DUMMY_SECRET);
    if (!secret) throw new UnauthorizedException("Signature check failed");

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return { ok: true, skipped: "body is not JSON" };
    }

    const event =
      source === "stripe"
        ? correctionFromStripeEvent(payload as Parameters<typeof correctionFromStripeEvent>[0])
        : correctionFromOrderEvent(payload as Record<string, unknown>, source);
    if (!event) return { ok: true, skipped: "event is not a refund, dispute or cancellation" };

    // Retries must not become second corrections; the provider's event id is the key.
    const eventKey = `${projectId}:${source}:${event.eventId}`;
    const claimed = await this.db
      .insert(webhookEvents)
      .values({ id: eventKey, projectId, source })
      .onConflictDoNothing()
      .returning({ id: webhookEvents.id });
    if (claimed.length === 0) return { ok: true, skipped: "already handled" };

    try {
      const result = await this.record(projectId, event);
      if (result.skipped) {
        // Nothing was recorded, so let a later retry try again once the run exists.
        await this.db.delete(webhookEvents).where(eq(webhookEvents.id, eventKey));
        return result;
      }
      await this.db
        .update(webhookEvents)
        .set({ correctionId: result.correctionId ?? null })
        .where(eq(webhookEvents.id, eventKey));
      return result;
    } catch (err) {
      await this.db.delete(webhookEvents).where(eq(webhookEvents.id, eventKey));
      throw err;
    }
  }

  /** The event, on the run that made the purchase. */
  private async record(projectId: string, event: CommerceCorrection): Promise<CommerceWebhookResult> {
    const run = await this.findRun(projectId, event);
    if (!run) {
      this.logger.warn(
        `${event.source} ${event.eventId}: no recorded run for order ${event.orderId}; nothing to replay`,
      );
      return { ok: true, skipped: "no recorded run for this order" };
    }

    const [step] = await this.db
      .select({ id: steps.id, output: steps.output, model: steps.model, provider: steps.provider })
      .from(steps)
      .where(and(eq(steps.runId, run.id), eq(steps.kind, "llm_call")))
      .orderBy(desc(steps.seq))
      .limit(1);
    if (!step) {
      return { ok: true, skipped: "the recorded run has no model step to replay" };
    }

    const bought = purchaseDecisionFrom(extractAnswer(step.output)) ?? {
      action: "buy" as const,
      items: event.bought,
    };
    const refunded = (bought.items.length > 0 ? bought.items : event.bought).map((i: PurchaseLine) => i.sku);
    const settings = await this.settings(projectId);

    const body: CaptureCreate = {
      source: event.source,
      externalId: event.externalId ?? event.orderId,
      agent: run.agent,
      actor: `${event.source}:webhook`,
      subject: `Order ${event.orderId}`,
      context: [],
      draft: decisionAsAnswer(bought, event.currency),
      sent: decisionAsAnswer(event.corrected, event.currency),
      reason: event.note,
      reasonCode: event.reasonCode,
      amountCents: event.amountCents,
      currency: event.currency,
      draftRunId: run.id,
      draftModel: step.model,
      draftProvider: step.provider,
      scorer: "purchase_decision",
      scorerConfig: {
        refunded,
        ...(settings.commerce.maxUnitPriceCents !== null
          ? { maxUnitPriceCents: settings.commerce.maxUnitPriceCents }
          : {}),
      },
      tags: event.tags,
      metadata: {
        orderId: event.orderId,
        eventId: event.eventId,
        partial: event.partial,
        bought: refunded,
      },
    };

    const result = await this.capture.create(projectId, body);
    this.logger.log(
      `${event.source} ${event.reasonCode} on run ${run.id}: ${formatMoney(event.amountCents, event.currency)} — ${describeDecision(event.corrected, event.currency)}`,
    );
    return {
      ok: true,
      correctionId: result.correction.id,
      caseId: result.case?.id ?? null,
      runId: result.runId,
      amountCents: event.amountCents,
    };
  }

  /** The run the purchase was recorded under: by run id when the metadata carries one, else by externalId. */
  private async findRun(
    projectId: string,
    event: CommerceCorrection,
  ): Promise<{ id: string; agent: string } | null> {
    if (event.runId && UUID_RE.test(event.runId)) {
      const [byId] = await this.db
        .select({ id: runs.id, agent: runs.agent })
        .from(runs)
        .where(and(eq(runs.projectId, projectId), eq(runs.id, event.runId)))
        .limit(1);
      if (byId) return byId;
    }
    for (const externalId of [event.externalId, event.orderId].filter((v): v is string => Boolean(v))) {
      const [byExternal] = await this.db
        .select({ id: runs.id, agent: runs.agent })
        .from(runs)
        .where(and(eq(runs.projectId, projectId), eq(runs.externalId, externalId)))
        .orderBy(desc(runs.startedAt))
        .limit(1);
      if (byExternal) return byExternal;
    }
    return null;
  }

  private async settings(projectId: string) {
    const [p] = await this.db
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!p) throw new NotFoundException();
    return parseSettings(p.settings);
  }

  /** The configured secret, or null — never an error, so the answer looks the same either way. */
  private async secretFor(projectId: string, source: CommerceSource): Promise<string | null> {
    const [p] = await this.db
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!p) return null;
    return parseSettings(p.settings).commerce[SECRET_KEY[source]];
  }

  private verify(
    source: CommerceSource,
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    secret: string,
  ): void {
    const raw = headers[SIGNATURE_HEADER[source]];
    const header = Array.isArray(raw) ? raw[0] : raw;
    const result =
      source === "stripe"
        ? verifyStripeSignature(rawBody, header, secret)
        : verifyHmacSignature(rawBody, header, secret);
    if (!result.ok) {
      this.logger.warn(`${source} webhook rejected: ${result.reason}`);
      throw new UnauthorizedException("Signature check failed");
    }
  }
}

/** Verified against when no secret is configured, so the work and the answer do not vary. */
const DUMMY_SECRET = "overturn-no-endpoint-configured";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type { PurchaseDecision };
