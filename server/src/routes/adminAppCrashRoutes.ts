import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContainer } from "../container.js";
import { requireAdminAuth } from "../auth/adminAuthenticate.js";
import { AppError } from "../errors.js";
import { sha256 } from "../security/hash.js";
import { APP_CRASH_STATUSES } from "../repositories/appCrashRepository.js";
import { groupCrashes, summarizeCrashes } from "../support/crashReport.js";
import { parseBody, parseParams, parseQuery } from "./validation.js";
import { periodQuery, rangeFrom } from "./adminTicketRoutes.js";

const listQuery = periodQuery.extend({
  status: z.enum(APP_CRASH_STATUSES).optional(),
  kind: z.enum(["js", "native", "anr"]).optional()
});
const signatureParams = z.object({ signature: z.string().regex(/^[a-f0-9]{16,64}$/) });
const updateSchema = z.object({
  status: z.enum(APP_CRASH_STATUSES),
  adminNotes: z.string().max(3000).optional().nullable()
});

/** Teto de ocorrencias lidas por consulta. */
const MAX_ROWS = 20_000;

async function audit(
  request: Parameters<typeof requireAdminAuth>[0],
  container: AppContainer,
  action: "VIEW_APP_CRASHES" | "UPDATE_APP_CRASH",
  afterSnapshot: Record<string, unknown>
) {
  const admin = requireAdminAuth(request);
  const record = await container.adminUsers.findById(admin.adminUserId);
  await container.adminAuditLog.record({
    adminUserId: admin.adminUserId,
    adminEmail: record?.email ?? null,
    action,
    ipHash: sha256(request.ip || "unknown"),
    userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined,
    afterSnapshot
  });
}

export async function registerAdminAppCrashRoutes(app: FastifyInstance, container: AppContainer) {
  app.get("/admin/api/erros-app", async (request) => {
    const query = parseQuery(listQuery, request.query);
    await audit(request, container, "VIEW_APP_CRASHES", { period: query.period });
    const range = rangeFrom(query);
    const rows = await container.appCrashes.listInRange(range.from, range.to, MAX_ROWS);
    const statuses = await container.appCrashes.getStatuses(rows.map((row) => row.signature));
    const all = groupCrashes(rows, statuses);
    const items = all.filter((group) => (!query.status || group.status === query.status) && (!query.kind || group.kind === query.kind));
    return { summary: summarizeCrashes(all), items, truncated: rows.length >= MAX_ROWS };
  });

  app.get("/admin/api/erros-app/:signature", async (request) => {
    const { signature } = parseParams(signatureParams, request.params);
    await audit(request, container, "VIEW_APP_CRASHES", { signature });
    const occurrences = await container.appCrashes.listBySignature(signature, 50);
    if (occurrences.length === 0) throw new AppError(404, "NOT_FOUND", "Erro não encontrado.");
    const status = (await container.appCrashes.getStatuses([signature])).get(signature);
    const group = groupCrashes(occurrences, new Map(status ? [[signature, status]] : []))[0]!;
    const { stack } = occurrences[0]!;
    return {
      group,
      stack,
      adminNotes: status?.adminNotes ?? null,
      recent: occurrences.slice(0, 20).map(({ id, appVersion, deviceModel, androidVersion, deviceId, createdAt }) => ({
        id,
        appVersion,
        deviceModel,
        androidVersion,
        device: deviceId.slice(0, 8),
        createdAt
      }))
    };
  });

  app.patch("/admin/api/erros-app/:signature", async (request) => {
    const { signature } = parseParams(signatureParams, request.params);
    const body = parseBody(updateSchema, request.body);
    const exists = (await container.appCrashes.listBySignature(signature, 1)).length > 0;
    if (!exists) throw new AppError(404, "NOT_FOUND", "Erro não encontrado.");
    await container.appCrashes.setStatus(signature, body.status, body.adminNotes?.trim() || null, new Date());
    await audit(request, container, "UPDATE_APP_CRASH", { signature, status: body.status });
    return { ok: true };
  });
}
