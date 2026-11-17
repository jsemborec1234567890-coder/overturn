import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import {
  type Correction,
  type CorrectionAttribute,
  type CorrectionCreate,
  type CorrectionResult,
  correctionAttributeSchema,
  correctionCreateSchema,
  correctionListQuerySchema,
} from "@overturn-ai/shared";
import { z } from "zod";
import { ApiKeyGuard, Auth } from "../auth/api-key.guard";
import type { AuthContext } from "../auth/api-keys.service";
import { zod } from "../common/zod.pipe";
import { CorrectionsService } from "./corrections.service";

@Controller("v1/corrections")
@UseGuards(ApiKeyGuard)
export class CorrectionsController {
  constructor(private readonly corrections: CorrectionsService) {}

  @Post()
  @HttpCode(201)
  create(
    @Auth() auth: AuthContext,
    @Body(zod(correctionCreateSchema)) body: CorrectionCreate,
  ): Promise<CorrectionResult> {
    // Corrections made from the web app are attributed to the signed-in user unless an actor is given.
    const actor = body.actor ?? auth.user?.email ?? null;
    return this.corrections.create(auth.projectId, {
      ...body,
      actor,
      source: auth.user ? "ui" : body.source,
    });
  }

  /**
   * Who was at fault for a captured refund. A webhook has no human on it, so a commerce correction
   * arrives unattributed and its case sits out of the suite until this says the agent was wrong.
   */
  @Patch(":id/attribution")
  attribute(
    @Auth() auth: AuthContext,
    @Param("id", zod(z.uuid())) id: string,
    @Body(zod(correctionAttributeSchema)) body: CorrectionAttribute,
  ): Promise<Correction> {
    const actor = body.actor ?? auth.user?.email ?? null;
    return this.corrections.attribute(auth.projectId, id, { ...body, actor });
  }

  @Get()
  list(
    @Auth() auth: AuthContext,
    @Query(zod(correctionListQuerySchema)) q: z.infer<typeof correctionListQuerySchema>,
  ): Promise<Correction[]> {
    return this.corrections.list(auth.projectId, q);
  }
}
