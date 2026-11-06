import { isUsableLocation } from "../support/locationService.js";
import { OBSERVATION_MAX_LENGTH, preferredPeriods } from "../support/preferredPeriod.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { diagnosisCategoryIds } from "../types.js";
import type { AppContainer } from "../container.js";
import { requireAuth } from "../auth/authenticate.js";
import { normalizeBrazilianPhone } from "../auth/cpf.js";
import { parseBody, parseParams } from "./validation.js";
import { DOCUMENT_DESCRIPTION_MAX_LENGTH, DOCUMENT_MAX_FILES, DOCUMENT_MAX_FILE_BYTES } from "../support/documentsService.js";

/** Arquivos vao em base64 no JSON (+33%) -- teto = limite de arquivos * tamanho maximo * 4/3, mais folga. */
const DOCUMENTS_BODY_LIMIT = Math.ceil((DOCUMENT_MAX_FILES * DOCUMENT_MAX_FILE_BYTES * 4) / 3) + 64 * 1024;

const documentsSchema = z.object({
  contractId: z.string().min(1),
  contactPhone: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .refine((value) => Boolean(normalizeBrazilianPhone(value)), "Informe um telefone brasileiro valido."),
  description: z.string().max(DOCUMENT_DESCRIPTION_MAX_LENGTH).optional(),
  files: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        contentBase64: z.string().min(1).max(Math.ceil((DOCUMENT_MAX_FILE_BYTES * 4) / 3) + 8)
      })
    )
    .min(1)
    .max(DOCUMENT_MAX_FILES)
});

const idParams = z.object({
  id: z.string().min(1)
});

const diagnosisSchema = z.object({
  contractId: z.string().min(1),
  categoryId: z.enum(diagnosisCategoryIds),
  answers: z.record(z.string(), z.string()).default({})
});

const createTicketSchema = z.object({
  contractId: z.string().min(1),
  diagnosisId: z.string().min(1),
  preferredPeriod: z.enum(preferredPeriods),
  /** Recado opcional do cliente para a equipe (ex.: nao estara em casa em tal horario). */
  observation: z.string().max(OBSERVATION_MAX_LENGTH * 2).optional(),
  /** Ponto da casa confirmado na abertura: vai dentro do texto do chamado. Se vier invalido, o chamado abre sem ele. */
  location: z
    .object({
      latitude: z.number(),
      longitude: z.number(),
      accuracyMeters: z.number().min(0).max(100000).optional(),
      source: z.enum(["app", "web"]).default("web")
    })
    .optional(),
  contactPhone: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .refine((value) => Boolean(normalizeBrazilianPhone(value)), "Informe um telefone brasileiro valido.")
});

export async function registerSupportRoutes(app: FastifyInstance, container: AppContainer) {
  app.get("/v1/support/categories", async () => {
    return container.supportService.categories();
  });

  app.post("/v1/support/diagnosis", async (request) => {
    const auth = requireAuth(request);
    const body = parseBody(diagnosisSchema, request.body);
    const result = await container.supportService.diagnose({
      customerId: auth.customerId,
      contractId: body.contractId,
      categoryId: body.categoryId,
      answers: body.answers
    });
    await container.centralActivityService.safeRecordAuthenticated({
      auth,
      request,
      eventType: "CUSTOM",
      page: "atendimento",
      contractId: body.contractId,
      metadata: { action: "DIAGNOSIS", categoryId: body.categoryId, state: result.state }
    });
    return result;
  });

  app.post("/v1/support/tickets", async (request) => {
    const auth = requireAuth(request);
    const body = parseBody(createTicketSchema, request.body);
    const ticket = await container.supportService.createTicket({
      customerId: auth.customerId,
      contractId: body.contractId,
      diagnosisId: body.diagnosisId,
      contactPhone: body.contactPhone,
      ...(body.preferredPeriod ? { preferredPeriod: body.preferredPeriod } : {}),
      ...(body.observation ? { observation: body.observation } : {}),
      ...(body.location ? { location: { latitude: body.location.latitude, longitude: body.location.longitude, accuracyMeters: body.location.accuracyMeters } } : {})
    });
    // O link ja foi no texto do chamado: aqui so aparece no painel de Localizacoes. Falha nao atrapalha o chamado aberto.
    const locationIncluded = Boolean(body.location && isUsableLocation(body.location.latitude, body.location.longitude, body.location.accuracyMeters));
    if (body.location && locationIncluded) {
      await container.locationService
        .recordIncludedInTicket({
          customerId: auth.customerId,
          contractId: body.contractId,
          protocol: ticket.protocol,
          latitude: body.location.latitude,
          longitude: body.location.longitude,
          accuracyMeters: body.location.accuracyMeters,
          source: body.location.source
        })
        .catch(() => undefined);
    }
    await container.centralActivityService.safeRecordAuthenticated({
      auth,
      request,
      eventType: "OPEN_TICKET",
      page: "atendimento",
      contractId: body.contractId,
      metadata: { ticketId: ticket.id, protocol: ticket.protocol, title: ticket.title }
    });
    return { ...ticket, locationIncluded };
  });

  app.post("/v1/support/documents", { bodyLimit: DOCUMENTS_BODY_LIMIT }, async (request) => {
    const auth = requireAuth(request);
    const body = parseBody(documentsSchema, request.body);
    const result = await container.documentsService.submit({
      customerId: auth.customerId,
      contractId: body.contractId,
      contactPhone: body.contactPhone,
      description: body.description,
      files: body.files
    });
    await container.centralActivityService.safeRecordAuthenticated({
      auth,
      request,
      eventType: "OPEN_TICKET",
      page: "atendimento",
      contractId: body.contractId,
      metadata: { action: "DOCUMENTS", protocol: result.protocol, sent: result.sent, failed: result.failed.length }
    });
    return result;
  });

  app.get("/v1/support/tickets", async (request) => {
    const auth = requireAuth(request);
    const tickets = await container.supportService.listTickets(auth.customerId);
    await container.centralActivityService.safeRecordAuthenticated({
      auth,
      request,
      eventType: "VIEW_TICKETS",
      page: "chamados",
      metadata: { count: tickets.length }
    });
    return tickets;
  });

  app.get("/v1/support/tickets/:id", async (request) => {
    const auth = requireAuth(request);
    const params = parseParams(idParams, request.params);
    const ticket = await container.supportService.getTicket(auth.customerId, params.id);
    await container.centralActivityService.safeRecordAuthenticated({
      auth,
      request,
      eventType: "VIEW_TICKET_DETAIL",
      page: "chamado",
      contractId: ticket.contractId,
      metadata: { ticketId: ticket.id, status: ticket.status }
    });
    return ticket;
  });

  app.get("/v1/support/tickets/:id/timeline", async (request) => {
    const auth = requireAuth(request);
    const params = parseParams(idParams, request.params);
    return container.supportService.getTimeline(auth.customerId, params.id);
  });

  app.get("/v1/support/tickets/:id/appointment", async (request) => {
    const auth = requireAuth(request);
    const params = parseParams(idParams, request.params);
    return container.supportService.getAppointment(auth.customerId, params.id);
  });
}
