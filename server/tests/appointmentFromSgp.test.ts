import { describe, expect, it, vi } from "vitest";
import { InMemoryStore } from "../src/repositories/inMemoryStore.js";
import { SupportService } from "../src/support/supportService.js";
import { mapSgpOsToCustomerVisit } from "../src/integrations/sgp/sgpMapper.js";
import type {
  AppointmentProvider,
  BillingProvider,
  NetworkProvider,
  TicketProvider
} from "../src/integrations/sgp/providers.js";

/** Ocorrencia como o SGP devolve: "data"/"hora" sao a ABERTURA; o horario da visita fica na OS. */
function occurrence(overrides: Record<string, unknown> = {}) {
  return {
    numero: "261028124600",
    status: "Aberta",
    data_cadastro: "2026-10-26",
    hora_cadastro: "08:15",
    data: "2026-10-26",
    hora: "08:15",
    tipo: "Sem internet",
    ...overrides
  };
}

describe("mapSgpOsToCustomerVisit: horario da visita vem do agendamento, nunca da abertura", () => {
  it("nao trata a data/hora de abertura como agendamento (era o que congelava o primeiro horario)", () => {
    const mapped = mapSgpOsToCustomerVisit(occurrence() as never, "14720");
    expect(mapped?.appointment).toBeUndefined();
  });

  it("le o horario de os_data_agendamento da OS (formato do reagendamento da agenda)", () => {
    const mapped = mapSgpOsToCustomerVisit(
      occurrence({ ordens_servicos: [{ status: "Aberta", os_data_agendamento: "2026-10-29 15:30:00" }] }) as never,
      "14720"
    );
    expect(mapped?.appointment).toMatchObject({ date: "2026-10-29", windowStart: "15:30" });
  });

  it("reagendar muda o resultado: a mesma ocorrencia com outro horario devolve o horario novo", () => {
    const before = mapSgpOsToCustomerVisit(
      occurrence({ ordens_servicos: [{ status: "Aberta", os_data_agendamento: "2026-10-29 09:00:00" }] }) as never,
      "14720"
    );
    const after = mapSgpOsToCustomerVisit(
      occurrence({ ordens_servicos: [{ status: "Aberta", os_data_agendamento: "2026-10-30 16:00:00" }] }) as never,
      "14720"
    );
    expect(before?.appointment).toMatchObject({ date: "2026-10-29", windowStart: "09:00" });
    expect(after?.appointment).toMatchObject({ date: "2026-10-30", windowStart: "16:00" });
  });

  it("com varias OS, usa a aberta e mais adiante, nao a primeira da lista", () => {
    const mapped = mapSgpOsToCustomerVisit(
      occurrence({
        ordens_servicos: [
          { status: "Encerrada", os_data_agendamento: "2026-10-27 10:00:00" },
          { status: "Aberta", os_data_agendamento: "2026-10-30 14:00:00" }
        ]
      }) as never,
      "14720"
    );
    expect(mapped?.appointment).toMatchObject({ date: "2026-10-30", windowStart: "14:00" });
  });

  it("aceita data_agendamento + hora_agendamento separados e data no formato brasileiro", () => {
    const separated = mapSgpOsToCustomerVisit(
      occurrence({ ordens_servicos: [{ status: "Aberta", data_agendamento: "2026-11-02", hora_agendamento: "8:30" }] }) as never,
      "14720"
    );
    expect(separated?.appointment).toMatchObject({ date: "2026-11-02", windowStart: "08:30" });

    const brazilian = mapSgpOsToCustomerVisit(
      occurrence({ ordens_servicos: [{ status: "Aberta", os_data_agendamento: "03/11/2026 13:45" }] }) as never,
      "14720"
    );
    expect(brazilian?.appointment).toMatchObject({ date: "2026-11-03", windowStart: "13:45" });
  });

  it("usa o agendamento da propria ocorrencia quando nao ha OS agendada", () => {
    const mapped = mapSgpOsToCustomerVisit(
      occurrence({ data_agendamento: "2026-11-04", hora_agendamento: "10:00" }) as never,
      "14720"
    );
    expect(mapped?.appointment).toMatchObject({ date: "2026-11-04", windowStart: "10:00" });
  });
});

function buildService(listOccurrences: () => Record<string, unknown>[]) {
  const store = new InMemoryStore();
  store.upsertCustomer({ id: "customer_a", name: "Cliente A", cpf: "12345678909", phone: "11987654321" });
  store.upsertContract({
    id: "14720",
    customerId: "customer_a",
    addressLine: "Rua A, 1",
    city: "Franco da Rocha",
    state: "SP",
    planName: "800 Mega",
    status: "ACTIVE"
  });
  // Chamado aberto pelo app: o horario e INVENTADO localmente (amanha+1, 14:00-16:00) e nunca muda.
  store.createTicket({
    customerId: "customer_a",
    contractId: "14720",
    sgpTicketId: "261028124600",
    protocol: "261028124600",
    status: "SCHEDULED",
    title: "Sem internet",
    description: "",
    timeline: [],
    appointment: {
      id: "appt_local",
      ticketId: "261028124600",
      contractId: "14720",
      date: "2026-10-30",
      windowStart: "14:00",
      windowEnd: "16:00",
      addressLine: "Rua A, 1",
      city: "Franco da Rocha",
      state: "SP"
    }
  } as never);

  const ticketProvider: TicketProvider = {
    createTicket: vi.fn(),
    getTicketStatus: vi.fn(),
    getTicketHistory: vi.fn(),
    listTicketsByContract: vi.fn().mockResolvedValue([]),
    listOccurrencesByContract: vi.fn().mockImplementation(async () =>
      listOccurrences().map((raw) => ({
        id: String(raw.numero),
        protocol: String(raw.numero),
        contractId: "14720",
        status: "OPEN",
        title: "Sem internet",
        createdAt: "2026-10-26T08:15:00",
        updatedAt: "2026-10-26T08:15:00",
        raw
      }))
    )
  };
  const networkProvider: NetworkProvider = { getConnectionStatus: vi.fn() };
  const appointmentProvider: AppointmentProvider = { getAppointment: vi.fn().mockResolvedValue(null) };
  const billingProvider = {
    getBillingSummary: vi.fn(),
    listInvoices: vi.fn(),
    requestPaymentPromise: vi.fn()
  } as unknown as BillingProvider;
  return new SupportService(store, networkProvider, ticketProvider, appointmentProvider, billingProvider);
}

describe("SupportService: o SGP manda no horario da visita", () => {
  it("listTickets acompanha o reagendamento feito no SGP (nao fica no primeiro horario)", async () => {
    let schedule = "2026-10-29 09:00:00";
    const service = buildService(() => [occurrence({ ordens_servicos: [{ status: "Aberta", os_data_agendamento: schedule }] })]);

    const first = await service.listTickets("customer_a");
    expect(first[0]?.appointment).toMatchObject({ date: "2026-10-29", windowStart: "09:00" });

    schedule = "2026-10-31 17:00:00"; // reagendado no SGP depois
    const second = await service.listTickets("customer_a");
    expect(second[0]?.appointment).toMatchObject({ date: "2026-10-31", windowStart: "17:00" });
  });

  it("chamado que o SGP conhece mas sem agendamento nao mostra o horario inventado localmente", async () => {
    const service = buildService(() => [occurrence()]);
    const list = await service.listTickets("customer_a");
    expect(list[0]?.appointment).toBeUndefined();
  });

  it("getCurrentTicket tambem traz o horario atual do SGP", async () => {
    const service = buildService(() => [
      occurrence({ ordens_servicos: [{ status: "Aberta", os_data_agendamento: "2026-11-01 11:00:00" }] })
    ]);
    const current = await service.getCurrentTicket("customer_a", "14720");
    expect(current.ticket?.appointment).toMatchObject({ date: "2026-11-01", windowStart: "11:00" });
  });

  it("getAppointment devolve o horario do SGP e nao o local congelado", async () => {
    const service = buildService(() => [
      occurrence({ ordens_servicos: [{ status: "Aberta", os_data_agendamento: "2026-11-02 08:00:00" }] })
    ]);
    const store = (service as unknown as { store: InMemoryStore }).store;
    const localId = [...store.tickets.values()][0]!.id;
    const appointment = await service.getAppointment("customer_a", localId);
    expect(appointment).toMatchObject({ date: "2026-11-02", windowStart: "08:00" });
  });

  it("se o SGP estiver fora do ar, cai no dado local em vez de falhar", async () => {
    const service = buildService(() => {
      throw new Error("SGP fora do ar");
    });
    const store = (service as unknown as { store: InMemoryStore }).store;
    const localId = [...store.tickets.values()][0]!.id;
    const appointment = await service.getAppointment("customer_a", localId);
    expect(appointment).toMatchObject({ windowStart: "14:00" });
  });
});

describe("horario da visita: nunca do texto livre", () => {
  it("OS so com data e texto com hora (linha 'Ultima leitura' do diagnostico) fica sem horario", async () => {
    const { mapSgpOsToCustomerVisit } = await import("../src/integrations/sgp/sgpMapper.js");
    const visit = mapSgpOsToCustomerVisit(
      {
        numero: "261030085200",
        status: "Em execução",
        data_cadastro: "2026-10-30",
        data_agendamento: "",
        conteudo: "Conexao\nUltima leitura: 09/10/2026, 02:05\n\nSolicitacao",
        ordens_servicos: [{ id: 1, status: "Em execução", data_agendamento: "2026-10-30", conteudo: "Ultima leitura: 09/10/2026, 02:05" }]
      } as never,
      "3005"
    );
    expect(visit?.appointment).toMatchObject({ date: "2026-10-30", windowStart: "" });
    expect(visit?.updatedAt).not.toContain("02:05");
  });

  it("registra no log de onde veio o horario, uma vez por mudanca", async () => {
    const { setAppointmentSourceLogger } = await import("../src/integrations/sgp/appointmentSourceLog.js");
    const { mapSgpOsToCustomerVisit } = await import("../src/integrations/sgp/sgpMapper.js");
    const lines: Array<Record<string, unknown>> = [];
    setAppointmentSourceLogger({ info: (obj) => lines.push(obj) });
    const raw = (agendamento: string) =>
      ({ numero: "777", status: "Aberta", data_cadastro: "2026-10-30", ordens_servicos: [{ id: 42, status: "Aberta", os_data_agendamento: agendamento }] }) as never;
    mapSgpOsToCustomerVisit(raw("2026-10-30 09:53:16"), "1");
    mapSgpOsToCustomerVisit(raw("2026-10-30 09:53:16"), "1");
    mapSgpOsToCustomerVisit(raw("2026-10-30"), "1");
    setAppointmentSourceLogger(undefined);
    expect(lines).toEqual([
      { tag: "AGENDAMENTO", protocol: "777", date: "2026-10-30", time: "09:53", source: "OS 42: os_data_agendamento" },
      { tag: "AGENDAMENTO", protocol: "777", date: "2026-10-30", time: null, source: "OS 42: os_data_agendamento (sem hora)" }
    ]);
  });
});

describe("hora real da visita vem da OS por id quando a lista de ocorrencias so traz a data", () => {
  it("busca /api/os/list/id para OS aberta sem hora e usa os_data_agendamento", async () => {
    const { SgpBackedTicketProvider } = await import("../src/integrations/sgp/providers.js");
    const { mapSgpOsToCustomerVisit } = await import("../src/integrations/sgp/sgpMapper.js");
    const lookups: string[] = [];
    const client = {
      listOccurrencesByContract: async () => [
        {
          numero: "261030085200",
          status: "Em execução",
          data_cadastro: "2026-10-30",
          conteudo: "Horario preferencial de atendimento: Integral (qualquer horario)\nUltima leitura: 09/10/2026, 02:05",
          ordens_servicos: [
            { id: 991, status: "Em execução", data_agendamento: "2026-10-30" },
            { id: 992, status: "Encerrada", data_agendamento: "2026-10-29" }
          ]
        }
      ],
      getServiceOrderSchedule: async (osId: string) => {
        lookups.push(osId);
        return "2026-10-30T09:53:16";
      }
    };
    const provider = new (SgpBackedTicketProvider as unknown as new (...args: unknown[]) => { listOccurrencesByContract(id: string): Promise<Array<{ raw: unknown }>> })(
      { listTickets: async () => [], getCurrentTicket: async () => null, createTicket: async () => { throw new Error("x"); } },
      client
    );
    const [occurrence] = await provider.listOccurrencesByContract("3005");
    expect(lookups).toEqual(["991"]);
    const visit = mapSgpOsToCustomerVisit(occurrence!.raw as never, "3005");
    expect(visit).toMatchObject({ appointment: { date: "2026-10-30", windowStart: "09:53" }, preferredPeriod: "Integral" });
  });
});

describe("regra de exibicao do turno", () => {
  it("o turno sai da hora agendada no SGP", async () => {
    const { shiftFromTime } = await import("../src/support/preferredPeriod.js");
    expect(shiftFromTime("09:53")).toBe("Manhã");
    expect(shiftFromTime("11:59")).toBe("Manhã");
    expect(shiftFromTime("12:00")).toBe("Tarde");
    expect(shiftFromTime("17:59")).toBe("Tarde");
    expect(shiftFromTime("18:00")).toBe("Noite");
    expect(shiftFromTime("00:00")).toBeUndefined();
    expect(shiftFromTime("")).toBeUndefined();
    expect(shiftFromTime(null)).toBeUndefined();
  });
});

describe("hora de abertura do chamado", () => {
  it("sem hora_cadastro, usa a hora do protocolo (AAMMDDHHMMSS) quando a data bate", async () => {
    const { mapSgpOsToCustomerVisit, openingTimeFromProtocol } = await import("../src/integrations/sgp/sgpMapper.js");
    expect(openingTimeFromProtocol("261030085200", "2026-10-30")).toBe("08:52");
    expect(openingTimeFromProtocol("261030085200", "2026-10-31")).toBe("");
    expect(openingTimeFromProtocol("12345", "2026-10-30")).toBe("");
    expect(openingTimeFromProtocol("261030995200", "2026-10-30")).toBe("");
    const visit = mapSgpOsToCustomerVisit({ numero: "261030085200", status: "Aberta", data_cadastro: "2026-10-30", ordens_servicos: [] } as never, "3005");
    expect(visit?.createdAt).toBe("2026-10-30T08:52:00");
    const withHour = mapSgpOsToCustomerVisit({ numero: "261030085200", status: "Aberta", data_cadastro: "2026-10-30", hora_cadastro: "10:15:30", ordens_servicos: [] } as never, "3005");
    expect(withHour?.createdAt).toBe("2026-10-30T10:15:00");
  });
});
