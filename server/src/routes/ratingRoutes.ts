import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContainer } from "../container.js";
import { requireAuth } from "../auth/authenticate.js";
import { sha256 } from "../security/hash.js";
import { AppError } from "../errors.js";
import { RATING_EXPIRES_DAYS, recordClosedTickets } from "../push/ratingNotifier.js";
import { parseBody } from "./validation.js";

const submitSchema = z.object({
  protocol: z.string().trim().min(1).max(64),
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(1000).optional()
});

const RATE_PER_CUSTOMER = { limit: 60, windowMs: 10 * 60_000 };
/** Intervalo minimo entre duas buscas no SGP por cliente (o app consulta a cada minuto). */
const SCAN_MIN_INTERVAL_MS = 20_000;
const RATE_PER_IP = { limit: 90, windowMs: 10 * 60_000 };

/** Texto livre do cliente: sem caracteres de controle, espacos normalizados, no maximo 500 caracteres. */
export function cleanRatingComment(value: string | undefined): string | null {
  const clean = (value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 500);
  return clean || null;
}

export async function registerRatingRoutes(app: FastifyInstance, container: AppContainer) {
  async function limit(request: Parameters<typeof requireAuth>[0], customerId: string) {
    await container.persistentLimiter.consume(`rating:customer:${customerId}`, RATE_PER_CUSTOMER);
    await container.persistentLimiter.consume(`rating:ip:${sha256(request.ip || "unknown")}`, RATE_PER_IP);
  }

  const lastScan = new Map<string, number>();

  /** Chamados encerrados esperando a nota deste cliente. Confere o SGP na hora, para o cartao aparecer assim que o chamado e finalizado. */
  app.get("/v1/ratings/pending", async (request) => {
    const auth = requireAuth(request);
    await limit(request, auth.customerId);
    const now = new Date();
    if (now.getTime() - (lastScan.get(auth.customerId) ?? 0) >= SCAN_MIN_INTERVAL_MS) {
      if (lastScan.size > 5000) lastScan.clear();
      lastScan.set(auth.customerId, now.getTime());
      const contractIds = container.store.listContracts(auth.customerId).map((contract) => contract.id);
      await Promise.all(
        contractIds.map((contractId) =>
          recordClosedTickets({ ratings: container.ticketRatings, tickets: container.providers.tickets }, auth.customerId, contractId, now, 0).catch(() => 0)
        )
      );
    }
    const since = new Date(now.getTime() - RATING_EXPIRES_DAYS * 24 * 60 * 60 * 1000);
    const pending = await container.ticketRatings.listPending(auth.customerId, now, since);
    return {
      pending: pending.map((item) => ({ protocol: item.protocol, contractId: item.contractId, title: item.ticketTitle }))
    };
  });

  app.post("/v1/ratings", async (request) => {
    const auth = requireAuth(request);
    await limit(request, auth.customerId);
    const body = parseBody(submitSchema, request.body);
    const saved = await container.ticketRatings.submit(auth.customerId, body.protocol, body.rating, cleanRatingComment(body.comment), new Date());
    if (!saved) {
      throw new AppError(409, "RATING_NOT_AVAILABLE", "Este atendimento não está disponível para avaliação ou já foi avaliado.");
    }
    return { ok: true };
  });
}
