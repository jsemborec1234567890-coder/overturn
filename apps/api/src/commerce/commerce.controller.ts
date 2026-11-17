import type { RawBodyRequest } from "@nestjs/common";
import { BadRequestException, Controller, Headers, HttpCode, Param, Post, Req } from "@nestjs/common";
import { COMMERCE_SOURCES, type CommerceSource } from "@overturn-ai/shared";
import type { FastifyRequest } from "fastify";
import { CommerceService, type CommerceWebhookResult } from "./commerce.service";

const WEBHOOK_PREFIX = "v1/commerce/webhooks";

/**
 * Provider webhooks. These are the only unauthenticated write endpoints in the API: a refund
 * arrives from Stripe with no API key, so the project is named in the path and the signing
 * secret configured for that project is what authorises the call. Nothing is read from the body
 * until the signature over the raw bytes checks out.
 */
@Controller(WEBHOOK_PREFIX)
export class CommerceController {
  constructor(private readonly commerce: CommerceService) {}

  @Post(":source/:projectId")
  @HttpCode(200)
  async receive(
    @Param("source") source: string,
    @Param("projectId") projectId: string,
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<CommerceWebhookResult> {
    if (!isSource(source)) throw new BadRequestException("Unknown commerce source");
    if (!UUID_RE.test(projectId)) throw new BadRequestException("Malformed project id");
    const rawBody = req.rawBody;
    if (!rawBody || rawBody.length === 0) throw new BadRequestException("Empty body");
    return this.commerce.handle(projectId, source, rawBody, headers);
  }
}

function isSource(v: string): v is CommerceSource {
  return (COMMERCE_SOURCES as readonly string[]).includes(v);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
