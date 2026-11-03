import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContainer } from "../container.js";
import { requireAdminAuth, requireAdminPermission } from "../auth/adminAuthenticate.js";
import { AppError } from "../errors.js";
import { sha256 } from "../security/hash.js";
import { buildRatingsSummary, listRatings } from "../support/ratingsReport.js";
import { parseQuery } from "./validation.js";
import { periodQuery, rangeFrom } from "./adminTicketRoutes.js";

const listQuery = periodQuery.extend({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  technician: z.string().trim().max(160).optional(),
  withComment: z.enum(["1", "0"]).optional()
});

/** Teto de pedidos lidos por consulta; o resumo avisa quando o periodo passou disso. */
const MAX_RECORDS = 10_000;

export async function registerAdminRatingRoutes(app: FastifyInstance, container: AppContainer) {
  app.get("/admin/api/avaliacoes", async (request) => {
    const query = parseQuery(listQuery, request.query);
    const admin = requireAdminAuth(request);
    const record = await container.adminUsers.findById(admin.adminUserId);
    await container.adminAuditLog.record({
      adminUserId: admin.adminUserId,
      adminEmail: record?.email ?? null,
      action: "VIEW_RATINGS",
      ipHash: sha256(request.ip || "unknown"),
      userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined,
      afterSnapshot: { period: query.period }
    });

    const range = rangeFrom(query);
    const records = await container.ticketRatings.listInRange(range.from, range.to, MAX_RECORDS);
    const list = listRatings(records, { rating: query.rating, technician: query.technician, withComment: query.withComment === "1" }, query.page, query.limit);
    const names = await container.centralActivityService.findCustomerNames(list.items.map((item) => item.customerId));
    return {
      summary: buildRatingsSummary(records),
      truncated: records.length >= MAX_RECORDS,
      ...list,
      // Quem avaliou: o id interno do cliente não sai do servidor, só o nome.
      items: list.items.map(({ customerId, ...item }) => ({ ...item, customerName: names.get(customerId) ?? null }))
    };
  });

  /**
   * Apaga uma avaliacao (limpar teste). So admin. Fica no registro de auditoria com o que foi apagado: o dado em si
   * nao tem volta, entao a nota, o protocolo e o contrato ficam anotados.
   */
  app.delete<{ Params: { id: string } }>("/admin/api/avaliacoes/:id", async (request) => {
    const admin = requireAdminPermission(request, "avaliacoes.delete");
    const record = await container.ticketRatings.findById(request.params.id);
    if (!record) throw new AppError(404, "RATING_NOT_FOUND", "Avaliacao nao encontrada.");

    await container.ticketRatings.deleteById(record.id);
    const user = await container.adminUsers.findById(admin.adminUserId);
    await container.adminAuditLog.record({
      adminUserId: admin.adminUserId,
      adminEmail: user?.email ?? null,
      action: "DELETE_RATING",
      ipHash: sha256(request.ip || "unknown"),
      userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined,
      beforeSnapshot: {
        protocol: record.protocol,
        contractId: record.contractId,
        rating: record.rating,
        answeredAt: record.answeredAt
      }
    });
    return { ok: true };
  });

  /** Apaga todas as avaliacoes (respondidas e pendentes) de um contrato. So admin; ex.: contrato de teste. */
  app.delete<{ Params: { contractId: string } }>("/admin/api/avaliacoes/contrato/:contractId", async (request) => {
    const admin = requireAdminPermission(request, "avaliacoes.delete");
    const { contractId } = request.params;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(contractId)) throw new AppError(400, "INVALID_ID", "Contrato invalido.");

    const deleted = await container.ticketRatings.deleteByContract(contractId);
    if (deleted === 0) throw new AppError(404, "RATING_NOT_FOUND", "Esse contrato nao tem avaliacoes.");

    const user = await container.adminUsers.findById(admin.adminUserId);
    await container.adminAuditLog.record({
      adminUserId: admin.adminUserId,
      adminEmail: user?.email ?? null,
      action: "DELETE_CONTRACT_RATINGS",
      ipHash: sha256(request.ip || "unknown"),
      userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined,
      beforeSnapshot: { contractId, deleted }
    });
    return { ok: true, deleted };
  });
}
