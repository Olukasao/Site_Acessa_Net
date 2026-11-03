import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContainer } from "../container.js";
import { requireAuth } from "../auth/authenticate.js";
import { OwnershipService } from "../security/ownership.js";
import { parseBody } from "./validation.js";

/** B5: metadata livre vinha sem limite (gravado em coluna de texto a cada evento). Teto de chaves, tamanho da chave e do JSON. */
const METADATA_MAX_KEYS = 20;
const METADATA_MAX_KEY_LENGTH = 60;
const METADATA_MAX_JSON_BYTES = 2048;

const activityMetadataSchema = z.record(z.string().max(METADATA_MAX_KEY_LENGTH), z.unknown()).superRefine((value, ctx) => {
  if (Object.keys(value).length > METADATA_MAX_KEYS) {
    ctx.addIssue({ code: "custom", message: `Use no maximo ${METADATA_MAX_KEYS} campos em metadata.` });
    return;
  }
  let size = 0;
  try {
    size = Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    size = Number.POSITIVE_INFINITY;
  }
  if (size > METADATA_MAX_JSON_BYTES) {
    ctx.addIssue({ code: "custom", message: `metadata excede ${METADATA_MAX_JSON_BYTES} bytes.` });
  }
});

const activityBodySchema = z.object({
  eventType: z.enum(["VIEW_PLAN", "DOWNLOAD_INVOICE", "GENERATE_PIX", "VIEW_HOME", "VIEW_INVOICES", "VIEW_CONNECTION", "VIEW_TICKETS"]),
  page: z.string().trim().min(1).max(120).optional(),
  contractId: z.string().trim().min(1).max(80).optional(),
  metadata: activityMetadataSchema.optional()
});

export async function registerCentralActivityRoutes(app: FastifyInstance, container: AppContainer) {
  const ownership = new OwnershipService(container.store, container.sgpClient);

  app.post("/v1/central/activity", async (request) => {
    const auth = requireAuth(request);
    const body = parseBody(activityBodySchema, request.body);

    if (body.contractId) {
      await ownership.assertContract(auth.customerId, body.contractId);
    }

    await container.centralActivityService.safeRecordAuthenticated({
      auth,
      request,
      eventType: body.eventType,
      page: body.page,
      contractId: body.contractId,
      metadata: body.metadata
    });

    return { ok: true };
  });
}
