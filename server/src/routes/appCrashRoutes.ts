import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContainer } from "../container.js";
import { sha256 } from "../security/hash.js";
import { APP_CRASH_KINDS } from "../repositories/appCrashRepository.js";
import { crashSignature, crashTitle, scrubCrashText } from "../support/crashSanitizer.js";
import { parseBody } from "./validation.js";

const crashSchema = z.object({
  kind: z.enum(APP_CRASH_KINDS),
  message: z.string().max(2000),
  stack: z.string().max(12000).optional(),
  appVersion: z.string().trim().min(1).max(32),
  /** ID anonimo gerado pelo app (nao e identificador do aparelho nem do cliente). */
  deviceId: z.string().trim().regex(/^[A-Za-z0-9-]{8,64}$/),
  deviceModel: z.string().trim().max(100).optional(),
  androidVersion: z.string().trim().max(32).optional(),
  /** Quando o erro aconteceu (crash nativo e enviado so na abertura seguinte). */
  occurredAt: z.string().datetime().optional()
});

const RATE_PER_IP = { limit: 60, windowMs: 10 * 60_000 };
const RATE_PER_DEVICE = { limit: 20, windowMs: 60 * 60_000 };
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function registerAppCrashRoutes(app: FastifyInstance, container: AppContainer) {
  // Sem login de proposito: o app pode quebrar antes/durante o login. Defesas: limite por IP e por aparelho, tamanho maximo, texto filtrado.
  app.post("/v1/app-crashes", async (request, reply) => {
    await container.persistentLimiter.consume(`app_crash:ip:${sha256(request.ip || "unknown")}`, RATE_PER_IP);
    const body = parseBody(crashSchema, request.body);
    await container.persistentLimiter.consume(`app_crash:device:${sha256(body.deviceId)}`, RATE_PER_DEVICE);

    const now = new Date();
    const occurred = body.occurredAt ? new Date(body.occurredAt) : now;
    const createdAt = occurred.getTime() > now.getTime() || now.getTime() - occurred.getTime() > MAX_AGE_MS ? now : occurred;

    const title = crashTitle(body.message);
    const stack = scrubCrashText(body.stack ?? "").slice(0, 8000);
    await container.appCrashes.insert({
      signature: crashSignature(body.kind, title, stack),
      kind: body.kind,
      title,
      stack,
      appVersion: body.appVersion,
      deviceId: body.deviceId,
      deviceModel: scrubCrashText(body.deviceModel ?? "").slice(0, 100) || "desconhecido",
      androidVersion: scrubCrashText(body.androidVersion ?? "").slice(0, 32) || "desconhecido",
      createdAt
    });
    return reply.code(202).send({ ok: true });
  });
}
