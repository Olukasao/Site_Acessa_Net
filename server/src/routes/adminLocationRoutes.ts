import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContainer } from "../container.js";
import { requireAdminPermission } from "../auth/adminAuthenticate.js";
import { sha256 } from "../security/hash.js";
import { googleMapsUrl } from "../support/locationService.js";
import type { LocationRequestRecord } from "../repositories/locationRequestRepository.js";
import { parseBody, parseQuery } from "./validation.js";

const listQuery = z.object({
  status: z.enum(["pending", "approved", "rejected"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100)
});

const rejectSchema = z.object({ note: z.string().trim().max(500).optional().nullable() });

function clientIpHash(request: FastifyRequest) {
  return sha256(request.ip || "unknown");
}

function userAgent(request: FastifyRequest) {
  return typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined;
}

export async function registerAdminLocationRoutes(app: FastifyInstance, container: AppContainer) {
  async function audit(
    request: FastifyRequest,
    adminUserId: string,
    action: "VIEW_LOCATIONS" | "APPROVE_LOCATION" | "REJECT_LOCATION",
    snapshot: Record<string, unknown>
  ) {
    const user = await container.adminUsers.findById(adminUserId);
    await container.adminAuditLog.record({
      adminUserId,
      adminEmail: user?.email ?? null,
      action,
      ipHash: clientIpHash(request),
      userAgent: userAgent(request),
      // Coordenada exata e dado pessoal: a auditoria guarda quem decidiu e qual envio, nao o ponto.
      afterSnapshot: snapshot
    });
  }

  function present(record: LocationRequestRecord, names: Map<string, string>) {
    return {
      id: record.id,
      customerName: names.get(record.customerId) ?? null,
      contractId: record.contractId,
      protocol: record.protocol,
      latitude: record.latitude,
      longitude: record.longitude,
      accuracyMeters: record.accuracyMeters,
      source: record.source,
      status: record.status,
      createdAt: record.createdAt,
      reviewedAt: record.reviewedAt,
      reviewNote: record.reviewNote,
      sgpPostedAt: record.sgpPostedAt,
      mapUrl: googleMapsUrl(record.latitude, record.longitude)
    };
  }

  app.get("/admin/api/localizacoes", async (request) => {
    const admin = requireAdminPermission(request, "localizacoes.review");
    const query = parseQuery(listQuery, request.query);
    const records = await container.locationRequests.list(query.status, query.limit);
    await audit(request, admin.adminUserId, "VIEW_LOCATIONS", { status: query.status ?? "all", count: records.length });
    const names = await container.centralActivityService.findCustomerNames(records.map((record) => record.customerId));
    return { items: records.map((record) => present(record, names)) };
  });

  app.post<{ Params: { id: string } }>("/admin/api/localizacoes/:id/aprovar", async (request) => {
    const admin = requireAdminPermission(request, "localizacoes.review");
    const record = await container.locationService.approve(request.params.id, admin.adminUserId);
    await audit(request, admin.adminUserId, "APPROVE_LOCATION", { locationId: record.id, contractId: record.contractId, protocol: record.protocol });
    return { ok: true, status: record.status };
  });

  app.post<{ Params: { id: string } }>("/admin/api/localizacoes/:id/recusar", async (request) => {
    const admin = requireAdminPermission(request, "localizacoes.review");
    const body = parseBody(rejectSchema, request.body ?? {});
    const record = await container.locationService.reject(request.params.id, admin.adminUserId, body.note ?? null);
    await audit(request, admin.adminUserId, "REJECT_LOCATION", { locationId: record.id, contractId: record.contractId, protocol: record.protocol });
    return { ok: true, status: record.status };
  });
}
