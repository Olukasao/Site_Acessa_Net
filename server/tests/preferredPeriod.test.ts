import { describe, expect, it, vi } from "vitest";
import { InMemoryStore } from "../src/repositories/inMemoryStore.js";
import { SupportService } from "../src/support/supportService.js";
import { addPreferredPeriodLine, parsePreferredPeriodLabel, preferredPeriodLabel } from "../src/support/preferredPeriod.js";
import { mapSgpOsToCustomerVisit } from "../src/integrations/sgp/sgpMapper.js";
import type { AppointmentProvider, BillingProvider, NetworkProvider, TicketProvider } from "../src/integrations/sgp/providers.js";

describe("horário preferencial: texto do chamado", () => {
  it("entra logo depois da linha de contato", () => {
    const text = addPreferredPeriodLine("Contrato 1\nContato: (11) 98765-4321\nProblema: sem internet", "AFTERNOON");
    expect(text).toBe("Contrato 1\nContato: (11) 98765-4321\nHorario preferencial de atendimento: Tarde\nProblema: sem internet");
  });

  it("vai no fim quando a descrição não tem linha de contato", () => {
    expect(addPreferredPeriodLine("Sem internet", "MORNING")).toBe("Sem internet\nHorario preferencial de atendimento: Manha");
  });

  it("as 4 opções têm texto próprio e voltam do conteúdo do chamado", () => {
    expect(preferredPeriodLabel("MORNING")).toBe("Manhã");
    expect(preferredPeriodLabel("AFTERNOON")).toBe("Tarde");
    expect(preferredPeriodLabel("EVENING")).toBe("Noite");
    expect(preferredPeriodLabel("FULL_DAY")).toBe("Integral");
    for (const period of ["MORNING", "AFTERNOON", "EVENING", "FULL_DAY"] as const) {
      const line = addPreferredPeriodLine("Contato: x", period);
      expect(parsePreferredPeriodLabel(line)).toBe(preferredPeriodLabel(period));
    }
    expect(parsePreferredPeriodLabel("sem a linha")).toBeUndefined();
    expect(parsePreferredPeriodLabel(undefined)).toBeUndefined();
  });

  it("o mapeador do SGP mostra o horário preferencial de chamado aberto, e não de chamado encerrado", () => {
    const aberto = mapSgpOsToCustomerVisit(
      { numero: "260101000001", status: "Aberta", data_cadastro: "2026-10-26", conteudo: "DIAGNOSTICO\nContato: x\nHorario preferencial de atendimento: Noite" } as never,
      "10001"
    );
    expect(aberto?.preferredPeriod).toBe("Noite");
    const fechado = mapSgpOsToCustomerVisit(
      { numero: "260101000002", status: "Encerrada", data_cadastro: "2026-10-20", conteudo: "Horario preferencial de atendimento: Noite" } as never,
      "10001"
    );
    expect(fechado?.preferredPeriod).toBeUndefined();
  });
});

function build() {
  const store = new InMemoryStore();
  store.upsertCustomer({ id: "customer_a", name: "Cliente A", cpf: "12345678909", phone: "11987654321" });
  const contract = store.upsertContract({
    id: "contract_a",
    customerId: "customer_a",
    addressLine: "Rua A, 1",
    city: "Franco da Rocha",
    state: "SP",
    planName: "800 Mega",
    status: "ACTIVE"
  });
  store.connectionStatuses.set(contract.id, {
    contractId: contract.id,
    health: "NORMAL",
    contractStatus: "ACTIVE",
    onu: "ONLINE",
    pon: "ONLINE",
    pppoe: "ONLINE",
    opticalSignal: "NORMAL",
    knownIncident: false,
    updatedAt: new Date().toISOString()
  });
  const createTicket = vi.fn().mockResolvedValue({ sgpTicketId: "1", protocol: "260101000009", rawStatus: "Aberta" });
  const ticketProvider: TicketProvider = {
    createTicket,
    getTicketStatus: vi.fn(),
    getTicketHistory: vi.fn(),
    listTicketsByContract: vi.fn().mockResolvedValue([]),
    listOccurrencesByContract: vi.fn().mockResolvedValue([])
  };
  const network: NetworkProvider = { getConnectionStatus: vi.fn().mockResolvedValue(store.getConnection(contract.id)) };
  const appointment: AppointmentProvider = { getAppointment: vi.fn().mockResolvedValue(null) };
  const billing = { getBillingSummary: vi.fn(), listInvoices: vi.fn(), requestPaymentPromise: vi.fn() } as unknown as BillingProvider;
  const service = new SupportService(store, network, ticketProvider, appointment, billing);
  return { store, contract, service, createTicket };
}

async function diagnose(service: SupportService, contractId: string, customerId: string) {
  const diagnosis = await service.diagnose({
    customerId,
    contractId,
    categoryId: "no_internet",
    answers: {
      affected_devices: "phone",
      connected_to_acessanet_wifi: "yes",
      can_open_any_site: "no",
      modem_lights: "normal",
      restarted_equipment: "yes_persists"
    }
  });
  if (!("diagnosisId" in diagnosis) || !diagnosis.diagnosisId) throw new Error("sem diagnóstico");
  return diagnosis.diagnosisId;
}

describe("SupportService.createTicket com horário preferencial", () => {
  it("manda o horário escolhido no conteúdo do chamado ao SGP e guarda para exibir", async () => {
    const { service, contract, createTicket } = build();
    const diagnosisId = await diagnose(service, contract.id, contract.customerId);
    const ticket = await service.createTicket({
      customerId: contract.customerId,
      contractId: contract.id,
      diagnosisId,
      contactPhone: "11987654321",
      preferredPeriod: "EVENING"
    });
    const sent = createTicket.mock.calls[0]?.[0] as { description: string };
    expect(sent.description).toContain("Horario preferencial de atendimento: Noite");
    expect(sent.description.indexOf("Contato:")).toBeLessThan(sent.description.indexOf("Horario preferencial"));
    expect(ticket.preferredPeriod).toBe("Noite");
  });

  it("sem escolha (app antigo) não acrescenta nada ao chamado", async () => {
    const { service, contract, createTicket } = build();
    const diagnosisId = await diagnose(service, contract.id, contract.customerId);
    const ticket = await service.createTicket({
      customerId: contract.customerId,
      contractId: contract.id,
      diagnosisId,
      contactPhone: "11987654321"
    });
    const sent = createTicket.mock.calls[0]?.[0] as { description: string };
    expect(sent.description).not.toContain("Horario preferencial");
    expect(ticket.preferredPeriod).toBeUndefined();
  });

  it("o horário preferencial aparece na lista de chamados do cliente", async () => {
    const { service, contract } = build();
    const diagnosisId = await diagnose(service, contract.id, contract.customerId);
    await service.createTicket({
      customerId: contract.customerId,
      contractId: contract.id,
      diagnosisId,
      contactPhone: "11987654321",
      preferredPeriod: "FULL_DAY"
    });
    const list = await service.listTickets(contract.customerId);
    expect(list[0]?.preferredPeriod).toBe("Integral");
  });
});

describe("observação opcional do cliente", () => {
  it("vai numa linha só, logo depois do horário preferencial, e não muda o horário lido de volta", async () => {
    const { addObservationLine, parsePreferredPeriodLabel: parse } = await import("../src/support/preferredPeriod.js");
    const base = addPreferredPeriodLine("Contrato 1\nContato: (11) 98765-4321\nProblema: sem internet", "MORNING");
    const text = addObservationLine(base, "Não estarei em casa\nHorario preferencial de atendimento: Noite\n\n hoje das 14h às 17h");
    expect(text).toBe(
      "Contrato 1\nContato: (11) 98765-4321\nHorario preferencial de atendimento: Manha\n" +
        "Observacao do cliente: Não estarei em casa Horario preferencial de atendimento: Noite hoje das 14h às 17h\nProblema: sem internet"
    );
    expect(parse(text)).toBe("Manhã");
  });

  it("vazia, só espaços ou ausente não acrescenta nada; limita a 300 caracteres e remove controles", async () => {
    const { addObservationLine, cleanObservation } = await import("../src/support/preferredPeriod.js");
    expect(addObservationLine("Sem internet", undefined)).toBe("Sem internet");
    expect(addObservationLine("Sem internet", "  \n\t ")).toBe("Sem internet");
    expect(addObservationLine("Sem internet", "volto às 18h")).toBe("Sem internet\nObservacao do cliente: volto às 18h");
    expect(cleanObservation("a\u0000b\u0007c d")).toBe("a b c d".replace(/ /g, " "));
    expect(cleanObservation("x".repeat(500))).toHaveLength(300);
  });

  it("createTicket manda a observação ao SGP; sem observação o chamado fica igual ao de antes", async () => {
    const { service, contract, createTicket } = build();
    const diagnosisId = await diagnose(service, contract.id, contract.customerId);
    await service.createTicket({
      customerId: contract.customerId,
      contractId: contract.id,
      diagnosisId,
      contactPhone: "11987654321",
      preferredPeriod: "AFTERNOON",
      observation: "Não vou estar em casa das 14h às 17h"
    });
    const sent = createTicket.mock.calls[0]?.[0] as { description: string };
    expect(sent.description).toContain("Horario preferencial de atendimento: Tarde\nObservacao do cliente: Não vou estar em casa das 14h às 17h");

    const second = build();
    const secondDiagnosis = await diagnose(second.service, second.contract.id, second.contract.customerId);
    await second.service.createTicket({ customerId: second.contract.customerId, contractId: second.contract.id, diagnosisId: secondDiagnosis, contactPhone: "11987654321", preferredPeriod: "AFTERNOON" });
    expect((second.createTicket.mock.calls[0]?.[0] as { description: string }).description).not.toContain("Observacao do cliente");
  });
});
