import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContainer } from "../container.js";
import { requireAuth } from "../auth/authenticate.js";
import { parseBody, parseQuery } from "./validation.js";

const submitSchema = z.object({
  contractId: z.string().min(1),
  protocol: z.string().min(1).max(64),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyMeters: z.number().min(0).max(100_000).optional(),
  source: z.enum(["web", "app"])
});

const statusQuery = z.object({
  contractId: z.string().min(1),
  protocol: z.string().min(1).max(64)
});

export async function registerLocationRoutes(app: FastifyInstance, container: AppContainer) {
  /** O cliente manda a localizacao da casa para a visita. Fica pendente ate a equipe aprovar. */
  app.post("/v1/support/location", async (request) => {
    const auth = requireAuth(request);
    const body = parseBody(submitSchema, request.body);
    const record = await container.locationService.submit({
      customerId: auth.customerId,
      contractId: body.contractId,
      protocol: body.protocol,
      latitude: body.latitude,
      longitude: body.longitude,
      accuracyMeters: body.accuracyMeters,
      source: body.source
    });
    await container.centralActivityService.safeRecordAuthenticated({
      auth,
      request,
      eventType: "CUSTOM",
      page: "chamado",
      contractId: body.contractId,
      // Sem coordenadas no registro de atividade: so o fato de ter enviado.
      metadata: { action: "SEND_LOCATION", protocol: body.protocol, source: body.source }
    });
    return { status: record.status, sentAt: record.createdAt };
  });

  app.get("/v1/support/location", async (request) => {
    const auth = requireAuth(request);
    const query = parseQuery(statusQuery, request.query);
    return { location: await container.locationService.statusFor(auth.customerId, query.contractId, query.protocol) };
  });
}
