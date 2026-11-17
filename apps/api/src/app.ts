import "reflect-metadata";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { Logger, type LogLevel } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/http-exception.filter";
import type { AppConfig } from "./config";

/** A refund event is a few kilobytes; nothing legitimate on these routes is near this. */
const WEBHOOK_BODY_LIMIT = 1024 * 1024;

const LEVELS: Record<AppConfig["LOG_LEVEL"], LogLevel[]> = {
  fatal: ["fatal"],
  error: ["fatal", "error"],
  warn: ["fatal", "error", "warn"],
  info: ["fatal", "error", "warn", "log"],
  debug: ["fatal", "error", "warn", "log", "debug"],
  trace: ["fatal", "error", "warn", "log", "debug", "verbose"],
};

export async function createApp(config: AppConfig): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(config),
    new FastifyAdapter({ bodyLimit: 32 * 1024 * 1024, trustProxy: true }),
    {
      logger: LEVELS[config.LOG_LEVEL],
      // Provider webhooks are signed over the bytes they sent, so the raw body has to survive
      // parsing: an HMAC over re-serialized JSON would never match (apps/api/src/commerce).
      rawBody: true,
    },
  );
  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  });
  await app.register(cookie);
  // The webhook endpoints are the only unauthenticated writes, so an oversized body is refused
  // before it is read: the rest of the API still accepts 32MB ingest payloads behind an API key.
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook("onRequest", (req, reply, done) => {
    if (req.url?.startsWith("/v1/commerce/webhooks/")) {
      const length = Number(req.headers["content-length"] ?? 0);
      if (length > WEBHOOK_BODY_LIMIT) {
        // Nothing drains the body we are refusing, so the connection goes with the answer.
        void reply
          .header("connection", "close")
          .status(413)
          .send({ statusCode: 413, error: "Payload Too Large", message: "Body too large" });
        return;
      }
    }
    done();
  });
  // OTLP/HTTP protobuf bodies arrive as raw bytes
  app
    .getHttpAdapter()
    .getInstance()
    .addContentTypeParser("application/x-protobuf", { parseAs: "buffer" }, (_req, body, done) => {
      done(null, body);
    });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
  return app;
}

export async function startApp(config: AppConfig): Promise<NestFastifyApplication> {
  const app = await createApp(config);
  await app.listen({ port: config.PORT, host: config.HOST });
  new Logger("Bootstrap").log(`Overturn API listening on http://${config.HOST}:${config.PORT}`);
  return app;
}
