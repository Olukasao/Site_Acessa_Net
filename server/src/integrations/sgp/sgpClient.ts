import type { AppConfig } from "../../config.js";
import { AppError } from "../../errors.js";
import { redactSgpPayload } from "./redact.js";

/** Tempo minimo da consulta de ocorrencias por contrato (ver listOccurrencesByContract). */
const OCCURRENCE_LIST_MIN_TIMEOUT_MS = 20_000;

export interface SgpContractRaw {
  [key: string]: unknown;
}

export interface SgpOccurrenceRaw {
  [key: string]: unknown;
}

export interface SgpInvoiceRaw {
  [key: string]: unknown;
}

/**
 * Client para a familia de API /api/ura/* do SGP (consulta cliente,
 * ocorrencias) mais /api/central/chamado/ (criacao de chamado). Reduzido em
 * relacao ao AcessaNet app: sem faturas (/api/ura/titulos/) nem ordens de
 * servico/agenda (/api/ura/ordemservico/*), fora de escopo por enquanto.
 */
export class SgpUraClient {
  private readonly tokenAuthFields: Record<string, string> | undefined;
  private readonly basicAuthorization: string | undefined;
  private readonly occurrenceCache = new Map<string, { expiresAt: number; value: SgpOccurrenceRaw[] }>();
  private readonly occurrenceRequests = new Map<string, Promise<SgpOccurrenceRaw[]>>();
  private readonly occurrenceCacheTtlMs = 3000;
  /** Hora real da visita (os_data_agendamento) por OS: a lista de ocorrencias so traz a data. Cache curto para acompanhar reagendamentos. */
  private readonly osScheduleCache = new Map<string, { expiresAt: number; value: string | null }>();
  private readonly osScheduleRequests = new Map<string, Promise<string | null>>();
  private readonly osScheduleCacheTtlMs = 60_000;
  private readonly osScheduleErrorTtlMs = 30_000;
  /**
   * Mesmo motivo do cache de ocorrencias acima: consultCustomerByContract e
   * chamado por mais de um provider (contratos e faturamento) dentro da
   * MESMA carga de pagina da Central -- sem isso, cada visita paga 2x a
   * latencia do SGP (medida em producao entre ~0.7s e ~4.5s por chamada,
   * ver server-out.log 2026-10-02) pelo EXATO mesmo dado. TTL curto de
   * proposito: o suficiente pra deduplicar a mesma carga de pagina, pequeno
   * demais pra servir plano/endereco desatualizado numa navegacao real.
   */
  private readonly contractCache = new Map<string, { expiresAt: number; value: SgpContractRaw[] }>();
  private readonly contractRequests = new Map<string, Promise<SgpContractRaw[]>>();
  private readonly contractCacheTtlMs = 3000;
  /**
   * Mesmo caso: listInvoicesByContract e chamado 2x por carga da Home --
   * uma vez embutido em SgpBackedBillingProvider.getBillingSummary (pro
   * calculo de maxDaysLate) e outra vez direto pela rota
   * /v1/contracts/:id/invoices (FaturasPage/ClienteHome). Sem cache, cada
   * visita paga a paginacao inteira de /api/ura/titulos/ duas vezes.
   */
  private readonly invoiceCache = new Map<string, { expiresAt: number; value: SgpInvoiceRaw[] }>();
  private readonly invoiceRequests = new Map<string, Promise<SgpInvoiceRaw[]>>();
  private readonly invoiceCacheTtlMs = 3000;

  /**
   * Consulta por CPF/CNPJ (superficie ANONIMA: login, primeiro acesso, esqueci a senha). Antes, cada consulta
   * podia disparar ate 16 chamadas ao SGP (2 endpoints x 4 campos x 2 formatos). Agora:
   *  - cache curto por documento (positivo e NEGATIVO) + deduplicacao de consultas concorrentes;
   *  - um campo de busca so e abandonado quando o SGP o REJEITA (400/422); resposta 200 vazia = "nao achou";
   *  - lembra o endpoint/campo/formato que ja funcionou e passa a usar so ele.
   * Pior caso frio sem nenhum sucesso previo: 2 endpoints x 2 formatos = 4 chamadas; depois de aprendido: 2.
   */
  private readonly documentCache = new Map<string, { expiresAt: number; value: SgpContractRaw[] }>();
  private readonly documentRequests = new Map<string, Promise<SgpContractRaw[]>>();
  private readonly documentCacheTtlMs: number;
  private readonly documentNegativeTtlMs: number;
  private learnedSearch = new Map<string, { field: string; variant: "formatted" | "digits" }>();
  /** Teto global de chamadas ao SGP por minuto (todas as rotas) e teto proprio para buscas por documento. */
  /**
   * Segredo (derivado de CPF_HASH_SECRET) para o customerId por HMAC -- so definido com CUSTOMER_ID_HMAC=1.
   * Fica aqui porque o client SGP ja e injetado em todo lugar que deriva/verifica ids de cliente.
   */
  get customerIdSecret(): string | undefined {
    return this.config.customerIdSecret;
  }
  private readonly maxCallsPerMinute: number;
  private readonly maxLookupCallsPerMinute: number;
  private callWindow = { startedAt: 0, total: 0, lookups: 0 };
  /** Circuit breaker: falhas consecutivas de infraestrutura (timeout/rede/5xx) abrem o circuito por um tempo. */
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private readonly circuitThreshold: number;
  private readonly circuitOpenMs: number;

  constructor(private readonly config: AppConfig["sgp"]) {
    this.documentCacheTtlMs = config.documentCacheTtlMs ?? 60_000;
    this.documentNegativeTtlMs = config.documentNegativeCacheTtlMs ?? 60_000;
    this.maxCallsPerMinute = config.maxCallsPerMinute ?? 1500;
    this.maxLookupCallsPerMinute = config.maxLookupCallsPerMinute ?? 300;
    this.circuitThreshold = config.circuitFailureThreshold ?? 8;
    this.circuitOpenMs = config.circuitOpenMs ?? 20_000;
    if (config.app && config.token) {
      this.tokenAuthFields = { app: config.app, token: config.token };
    }

    if (config.basicUsername && config.basicPassword) {
      this.basicAuthorization = `Basic ${Buffer.from(`${config.basicUsername}:${config.basicPassword}`).toString("base64")}`;
    }

    if (!this.tokenAuthFields && !this.basicAuthorization) {
      throw new AppError(500, "SGP_NOT_CONFIGURED", "Integracao SGP nao configurada.");
    }
  }

  async consultCustomerByContract(contractId: string) {
    const cached = this.contractCache.get(contractId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const inFlight = this.contractRequests.get(contractId);
    if (inFlight) {
      return inFlight;
    }

    const request = this.postForm<{ contratos?: SgpContractRaw[] }>("/api/ura/consultacliente/", {
      contrato: contractId
    }).then((response) => {
      const contracts = Array.isArray(response.contratos) ? response.contratos : [];
      this.contractCache.set(contractId, { expiresAt: Date.now() + this.contractCacheTtlMs, value: contracts });
      return contracts;
    });

    this.contractRequests.set(contractId, request);

    try {
      return await request;
    } finally {
      this.contractRequests.delete(contractId);
    }
  }

  async consultCustomerByDocument(documento: string) {
    const normalizedDocument = documento.replace(/\D/g, "");
    const cached = this.documentCache.get(normalizedDocument);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const inFlight = this.documentRequests.get(normalizedDocument);
    if (inFlight) {
      return inFlight;
    }

    const request = this.searchDocument(normalizedDocument).then((contracts) => {
      if (this.documentCache.size > 2000) this.pruneDocumentCache();
      const ttl = contracts.length > 0 ? this.documentCacheTtlMs : this.documentNegativeTtlMs;
      if (ttl > 0) this.documentCache.set(normalizedDocument, { expiresAt: Date.now() + ttl, value: contracts });
      return contracts;
    });
    this.documentRequests.set(normalizedDocument, request);

    try {
      return await request;
    } finally {
      this.documentRequests.delete(normalizedDocument);
    }
  }

  private pruneDocumentCache() {
    const now = Date.now();
    for (const [key, entry] of this.documentCache) {
      if (entry.expiresAt <= now) this.documentCache.delete(key);
    }
    // Ainda cheio (muitos documentos distintos em 1 min): descarta os mais antigos.
    if (this.documentCache.size > 2000) {
      for (const key of [...this.documentCache.keys()].slice(0, 1000)) this.documentCache.delete(key);
    }
  }

  private async searchDocument(normalizedDocument: string): Promise<SgpContractRaw[]> {
    const variants = buildDocumentVariants(normalizedDocument);
    const formatted = variants[0] as string;
    const digits = variants[variants.length - 1] as string;

    const endpoints = [
      { path: "/api/ura/clientes/", listKey: "clientes" as const },
      { path: "/api/ura/consultacliente/", listKey: "contratos" as const }
    ];

    for (const endpoint of endpoints) {
      const learned = this.learnedSearch.get(endpoint.path);
      const fields = learned ? [learned.field] : this.config.cpfSearchFields;
      const order: Array<"formatted" | "digits"> = learned
        ? [learned.variant]
        : variants.length > 1
          ? ["formatted", "digits"]
          : ["digits"];

      for (const field of fields) {
        let fieldRejected = false;
        for (const variantName of order) {
          const variant = variantName === "formatted" ? formatted : digits;
          this.consumeLookupBudget();
          try {
            const response = await this.postForm<Record<string, unknown>>(endpoint.path, { [field]: variant });
            const contracts = normalizeSearchResponse(response, endpoint.listKey);
            if (contracts.length > 0) {
              this.learnedSearch.set(endpoint.path, { field, variant: variantName });
              return contracts;
            }
          } catch (error) {
            if (!isRecoverableSearchFieldError(error)) {
              throw error;
            }
            // 400/422: o SGP nao aceita ESTE campo -- tenta o proximo campo, nao o outro formato do mesmo campo.
            fieldRejected = true;
            break;
          }
        }
        // Campo aceito (200, mesmo vazio): os demais nomes de campo sao redundantes.
        if (!fieldRejected) break;
      }
    }

    return [];
  }

  async consultCustomerByCpf(cpf: string) {
    return this.consultCustomerByDocument(cpf);
  }

  async listInvoicesByContract(contractId: string) {
    const cached = this.invoiceCache.get(contractId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const inFlight = this.invoiceRequests.get(contractId);
    if (inFlight) {
      return inFlight;
    }

    const request = this.fetchInvoicesByContract(contractId).then((invoices) => {
      this.invoiceCache.set(contractId, { expiresAt: Date.now() + this.invoiceCacheTtlMs, value: invoices });
      return invoices;
    });

    this.invoiceRequests.set(contractId, request);

    try {
      return await request;
    } finally {
      this.invoiceRequests.delete(contractId);
    }
  }

  private async fetchInvoicesByContract(contractId: string) {
    const invoices: SgpInvoiceRaw[] = [];
    const limit = 250;
    let offset = 0;

    for (let page = 0; page < 100; page += 1) {
      const response = await this.postForm<{
        titulos?: SgpInvoiceRaw[];
        paginacao?: { total?: number; parcial?: number };
      }>("/api/ura/titulos/", {
        contrato: contractId,
        offset: String(offset),
        limit: String(limit)
      });
      const pageInvoices = Array.isArray(response.titulos) ? response.titulos : [];
      invoices.push(...pageInvoices);

      const total = Number(response.paginacao?.total);
      if (pageInvoices.length === 0 || (Number.isFinite(total) && invoices.length >= total) || pageInvoices.length < limit) {
        break;
      }

      offset += pageInvoices.length;
    }

    return invoices;
  }

  /**
   * "AAAA-MM-DDTHH:MM:SS" do agendamento da OS, via /api/os/list/id/{id} (o mesmo que a Agenda de Tecnicos usa;
   * so aceita Basic Auth). null quando a OS nao tem agendamento, sem Basic Auth configurado ou se o SGP falhar.
   */
  async getServiceOrderSchedule(osId: string): Promise<string | null> {
    if (!this.basicAuthorization || !/^\d{1,20}$/.test(osId)) return null;
    const cached = this.osScheduleCache.get(osId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const inFlight = this.osScheduleRequests.get(osId);
    if (inFlight) return inFlight;

    const request = (async () => {
      try {
        const data = await this.postJson<unknown>(`/api/os/list/id/${osId}`);
        const item = Array.isArray(data) ? data[0] : data;
        const raw = item && typeof item === "object" ? (item as Record<string, unknown>).os_data_agendamento : undefined;
        const value = typeof raw === "string" && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(raw) ? raw : null;
        this.osScheduleCache.set(osId, { expiresAt: Date.now() + this.osScheduleCacheTtlMs, value });
        return value;
      } catch {
        this.osScheduleCache.set(osId, { expiresAt: Date.now() + this.osScheduleErrorTtlMs, value: null });
        return null;
      }
    })();
    this.osScheduleRequests.set(osId, request);
    try {
      return await request;
    } finally {
      this.osScheduleRequests.delete(osId);
    }
  }

  async listOccurrencesByContract(contractId: string) {
    const cached = this.occurrenceCache.get(contractId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const inFlight = this.occurrenceRequests.get(contractId);
    if (inFlight) {
      return inFlight;
    }

    // Contrato com muitos chamados leva ~5 s sozinho (99 itens medidos em 2026-11-03) e passa de 8 s com varias consultas
    // em paralelo (painel de Chamados). Estourar o tempo aqui virava lista vazia ("Indisponivel") e, em sequencia, abria o
    // circuit breaker para TODAS as consultas ao SGP. Esta consulta ganha um limite maior.
    const request = this.postForm<{ ocorrencias?: SgpOccurrenceRaw[] }>(
      "/api/ura/ocorrencia/list/",
      { contrato: contractId },
      { timeoutMs: Math.max(this.config.timeoutMs, OCCURRENCE_LIST_MIN_TIMEOUT_MS) }
    ).then((response) => {
      const occurrences = Array.isArray(response.ocorrencias) ? response.ocorrencias : [];
      this.occurrenceCache.set(contractId, {
        expiresAt: Date.now() + this.occurrenceCacheTtlMs,
        value: occurrences
      });
      return occurrences;
    });

    this.occurrenceRequests.set(contractId, request);

    try {
      return await request;
    } finally {
      this.occurrenceRequests.delete(contractId);
    }
  }

  /**
   * POST /api/central/chamado/ -- familia de API diferente de /api/ura/*:
   * autentica SO com token+app no corpo (nunca Basic Auth, nunca retry).
   * Validado sob demanda (nao no construtor) para nao derrubar o cliente
   * inteiro -- e as demais chamadas /api/ura/* que ja funcionam -- so
   * porque a criacao de chamado ainda nao foi configurada.
   */
  async createCentralChamado(input: {
    contrato: string;
    conteudo: string;
    contato?: string | undefined;
    contatoNumero?: string | undefined;
    ocorrenciaTipo: string;
    motivoOs: string;
    semOs?: string | undefined;
    setor?: string | undefined;
  }): Promise<{ sgpTicketId: string; osId: string; occurrenceId: string; protocol: string; rawStatus: string; raw: Record<string, unknown> }> {
    const app = this.config.chamado.app;
    const token = this.config.chamado.token;
    if (!app || !token) {
      throw new AppError(500, "SGP_CHAMADO_NOT_CONFIGURED", "Integracao de abertura de chamado no SGP nao configurada.");
    }

    const fields: Record<string, string> = {
      token,
      app,
      contrato: input.contrato,
      conteudo: input.conteudo,
      ocorrenciatipo: input.ocorrenciaTipo,
      motivoos: input.motivoOs
    };

    if (input.contato) {
      fields.contato = input.contato;
    }
    if (input.contatoNumero) {
      fields.contato_numero = input.contatoNumero;
    }
    if (input.semOs) {
      fields.sem_os = input.semOs;
    }
    if (input.setor) {
      fields.setor = input.setor;
    }

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      params.append(key, value);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.chamado.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/api/central/chamado/`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
        signal: controller.signal
      });
    } catch {
      throw new AppError(502, "SGP_CHAMADO_REQUEST_FAILED", "Nao foi possivel abrir o chamado no SGP agora.");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new AppError(502, "SGP_CHAMADO_REQUEST_FAILED", "Nao foi possivel abrir o chamado no SGP agora.", {
        upstreamStatus: response.status
      });
    }

    let raw: Record<string, unknown>;
    try {
      const parsed = (await response.json()) as unknown;
      // A doc do SGP mostra a resposta como lista com um item ([{ os_id, os_protocolo, ... }]).
      const first = Array.isArray(parsed) ? parsed[0] : parsed;
      raw = (first && typeof first === "object" ? first : {}) as Record<string, unknown>;
    } catch {
      throw new AppError(502, "SGP_CHAMADO_REQUEST_FAILED", "Resposta invalida do SGP ao abrir o chamado.");
    }

    // O SGP responde 200 mesmo quando recusa (ex.: {"status":3,"msg":"Ja existe chamado aberto para o tipo selecionado"});
    // sucesso e "status":0. Sem esta checagem a recusa viraria um chamado "criado" com o protocolo do que ja existia.
    if (typeof raw.status === "number" && raw.status !== 0) {
      const msg = typeof raw.msg === "string" ? raw.msg : "";
      if (/j[aá] existe chamado aberto/i.test(msg)) {
        throw new AppError(409, "SGP_CHAMADO_ALREADY_OPEN", "Voce ja possui um chamado aberto desse tipo. Aguarde o atendimento dele.", {
          protocol: pickString(raw, ["protocolo"])
        });
      }
      throw new AppError(502, "SGP_CHAMADO_REJECTED", "O SGP recusou a abertura do chamado.", { sgpStatus: raw.status, sgpMsg: msg });
    }

    return {
      sgpTicketId: pickString(raw, ["id", "id_chamado", "chamado_id", "os_id", "ocorrencia_id", "os", "id_os", "numero", "protocolo"]) || `sgp_chamado_${Date.now()}`,
      osId: pickString(raw, ["os_id", "id_os", "os"]),
      occurrenceId: pickString(raw, ["ocorrencia_id", "id_ocorrencia"]),
      protocol: pickString(raw, ["protocolo", "os_protocolo", "protocol", "numero", "id"]) || "",
      rawStatus: pickString(raw, ["status", "status_descricao", "situacao"]) || "aberto",
      raw: redactSgpPayload(raw) as Record<string, unknown>
    };
  }

  /**
   * POST /api/ura/ocorrencia/{ocorrencia_id}/anexo/add/ -- anexa o arquivo na aba "Anexos" da ocorrencia. E o caminho
   * certo para o tipo ANEXAR DOCUMENTO, que nao gera OS (o /api/central/chamado/{os_id}/anexo/add/ so anexa em OS).
   * Descoberto por sondagem em 2026-11-03: nao consta na doc do SGP. Aceita token+app (o mesmo do chamado) e responde
   * {"msg":"Anexo cadastrado com sucesso"}. Sem retry: reenviar duplicaria o anexo.
   */
  async addOccurrenceAttachment(input: {
    occurrenceId: string;
    filename: string;
    contentType: string;
    data: Buffer;
  }): Promise<void> {
    const app = this.config.chamado.app;
    const token = this.config.chamado.token;
    if (!app || !token) {
      throw new AppError(500, "SGP_CHAMADO_NOT_CONFIGURED", "Integracao de abertura de chamado no SGP nao configurada.");
    }
    if (!/^\d+$/.test(input.occurrenceId)) {
      throw new AppError(502, "SGP_ATTACHMENT_FAILED", "O SGP nao devolveu o numero da ocorrencia para anexar o arquivo.");
    }

    const form = new FormData();
    form.append("token", token);
    form.append("app", app);
    form.append("file", new Blob([new Uint8Array(input.data)], { type: input.contentType }), input.filename);

    const controller = new AbortController();
    // Arquivos sao maiores que o POST de texto: o dobro do tempo do chamado.
    const timer = setTimeout(() => controller.abort(), this.config.chamado.timeoutMs * 2);

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/api/ura/ocorrencia/${input.occurrenceId}/anexo/add/`, {
        method: "POST",
        body: form,
        signal: controller.signal
      });
    } catch {
      throw new AppError(502, "SGP_ATTACHMENT_FAILED", "Nao foi possivel enviar o arquivo ao SGP agora.");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new AppError(502, "SGP_ATTACHMENT_FAILED", "Nao foi possivel enviar o arquivo ao SGP agora.", {
        upstreamStatus: response.status
      });
    }
  }

  /**
   * Escreve um texto na OS (anotacao, lida pelo tecnico) ou na ocorrencia (comentario). Mesmo token+app do chamado.
   * POST /api/os/anotacoes/add/id/{os_id}/ e POST /api/os/ocorrencia/comentario/add/id/{os_id}/ -- confirmados em
   * 2026-11-03 (resposta {"anotacao_id":N,"usuario":"system"}). Sem retry: repetir duplicaria o texto.
   */
  async addServiceOrderNote(input: { osId: string; text: string; target: "os" | "occurrence" }): Promise<void> {
    const app = this.config.chamado.app;
    const token = this.config.chamado.token;
    if (!app || !token) {
      throw new AppError(500, "SGP_CHAMADO_NOT_CONFIGURED", "Integracao de abertura de chamado no SGP nao configurada.");
    }
    if (!/^\d+$/.test(input.osId)) {
      throw new AppError(502, "SGP_NOTE_FAILED", "O SGP nao devolveu o numero da OS para gravar a anotacao.");
    }

    const path = input.target === "os" ? `/api/os/anotacoes/add/id/${input.osId}/` : `/api/os/ocorrencia/comentario/add/id/${input.osId}/`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.chamado.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token, app, anotacao: input.text }).toString(),
        signal: controller.signal
      });
    } catch {
      throw new AppError(502, "SGP_NOTE_FAILED", "Nao foi possivel gravar a anotacao no SGP agora.");
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new AppError(502, "SGP_NOTE_FAILED", "Nao foi possivel gravar a anotacao no SGP agora.", { upstreamStatus: response.status });
    }
  }

  /**
   * POST /api/ura/liberacaopromessa/ -- "promessa de pagamento" / "liberacao
   * por confianca". Nao documentado nos manuais publicos do SGP (bookstack/
   * wiki); o path e o verbo foram confirmados de forma independente numa
   * integracao real de terceiro com o mesmo SGP (PR publico
   * tavaresbr/genieacs-panel#156, que corrigiu de "/api/ura/liberacao/"
   * -- invalido -- para este path). Mesma familia de auth de
   * consultCustomerByContract/listOccurrencesByContract (postForm), nenhuma
   * credencial nova. Nomes de campo da resposta tambem vem dessa mesma
   * integracao de terceiro, nao de doc oficial -- por isso o fallback
   * tolerante de nomes abaixo, igual ao resto deste arquivo/sgpMapper.ts.
   */
  async requestPaymentPromise(contractId: string): Promise<{
    released: boolean;
    protocol: string;
    releasedDays: number | undefined;
    message: string;
    raw: Record<string, unknown>;
  }> {
    const raw = await this.postForm<Record<string, unknown>>("/api/ura/liberacaopromessa/", {
      contrato: contractId
    });

    const releasedRaw = pickString(raw, ["liberado", "released", "sucesso", "success"]).trim().toLowerCase();
    const released = releasedRaw.length > 0 && !["0", "false", "nao", "não", "n", "failed", "erro"].includes(releasedRaw);

    const releasedDaysText = pickString(raw, ["liberado_dias", "liberadoDias", "dias", "dias_liberados", "diasLiberados"]);
    const releasedDays = releasedDaysText ? Number(releasedDaysText) : undefined;

    return {
      released,
      protocol: pickString(raw, ["protocolo", "protocol", "numero", "id"]),
      releasedDays: Number.isFinite(releasedDays) ? releasedDays : undefined,
      message: pickString(raw, ["mensagem", "msg", "message", "motivo", "descricao"]),
      raw: redactSgpPayload(raw) as Record<string, unknown>
    };
  }

  /** Janela de 1 minuto compartilhada: devolve o contador atual ja incrementado. */
  private tick(kind: "total" | "lookups") {
    const now = Date.now();
    if (now - this.callWindow.startedAt >= 60_000) this.callWindow = { startedAt: now, total: 0, lookups: 0 };
    this.callWindow[kind] += 1;
    return this.callWindow[kind];
  }

  private consumeLookupBudget() {
    if (this.tick("lookups") > this.maxLookupCallsPerMinute) {
      throw new AppError(503, "SGP_BUSY", "Muitas consultas ao SGP no momento. Tente novamente em instantes.");
    }
  }

  private assertCallAllowed() {
    if (this.circuitOpenUntil > Date.now()) {
      throw new AppError(503, "SGP_CIRCUIT_OPEN", "SGP temporariamente indisponivel. Tente novamente em instantes.");
    }
    if (this.tick("total") > this.maxCallsPerMinute) {
      throw new AppError(503, "SGP_BUSY", "Muitas consultas ao SGP no momento. Tente novamente em instantes.");
    }
  }

  private noteUpstream(ok: boolean) {
    if (ok) {
      this.consecutiveFailures = 0;
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.circuitThreshold) {
      this.circuitOpenUntil = Date.now() + this.circuitOpenMs;
      this.consecutiveFailures = 0;
    }
  }

  /** POST com corpo JSON vazio e Basic Auth (rotas /api/os/*). Mesmo teto de chamadas e circuit breaker do postForm. */
  private async postJson<T>(path: string): Promise<T> {
    this.assertCallAllowed();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(`${this.config.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: this.basicAuthorization ?? "" },
        body: "{}",
        signal: controller.signal
      });
      if (!response.ok) {
        this.noteUpstream(response.status < 500);
        throw new AppError(502, "SGP_REQUEST_FAILED", "Nao foi possivel consultar o SGP agora.", { upstreamStatus: response.status });
      }
      const parsed = (await response.json()) as T;
      this.noteUpstream(true);
      return parsed;
    } catch (error) {
      if (error instanceof AppError) throw error;
      this.noteUpstream(false);
      throw new AppError(502, "SGP_REQUEST_FAILED", "Nao foi possivel consultar o SGP agora.");
    } finally {
      clearTimeout(timer);
    }
  }

  private async postForm<T>(path: string, fields: Record<string, string>, options?: { timeoutMs?: number }): Promise<T> {
    this.assertCallAllowed();
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      params.append(key, value);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? this.config.timeoutMs);

    try {
      let response: Response;

      if (this.basicAuthorization) {
        response = await fetch(`${this.config.baseUrl}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: this.basicAuthorization
          },
          body: params.toString(),
          signal: controller.signal
        });
      } else {
        // Sem Basic Auth o corpo ja leva app+token: antes ia SEM credencial primeiro e so repetia com token apos 401/403 (2x chamadas).
        const bodyWithAuth = new URLSearchParams();
        for (const [key, value] of Object.entries({ ...(this.tokenAuthFields ?? {}), ...fields })) {
          bodyWithAuth.append(key, value);
        }
        response = await fetch(`${this.config.baseUrl}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: bodyWithAuth.toString(),
          signal: controller.signal
        });
      }

      if (!response.ok && (response.status === 401 || response.status === 403) && this.tokenAuthFields && this.basicAuthorization) {
        const tokenParams = new URLSearchParams();
        for (const [key, value] of Object.entries({ ...this.tokenAuthFields, ...fields })) {
          tokenParams.append(key, value);
        }
        response = await fetch(`${this.config.baseUrl}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: tokenParams.toString(),
          signal: controller.signal
        });
      }

      if (!response.ok) {
        // 5xx conta para o circuit breaker; 4xx (ex.: campo de busca rejeitado) e resposta valida do SGP.
        this.noteUpstream(response.status < 500);
        throw new AppError(502, "SGP_REQUEST_FAILED", "Nao foi possivel consultar o SGP agora.", {
          upstreamStatus: response.status
        });
      }

      const parsed = (await response.json()) as T;
      this.noteUpstream(true);
      return parsed;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      this.noteUpstream(false);
      throw new AppError(502, "SGP_REQUEST_FAILED", "Nao foi possivel consultar o SGP agora.");
    } finally {
      clearTimeout(timer);
    }
  }
}

function isRecoverableSearchFieldError(error: unknown): boolean {
  if (!(error instanceof AppError)) {
    return false;
  }

  const upstreamStatus =
    error.details && typeof error.details === "object" && "upstreamStatus" in error.details
      ? Number((error.details as Record<string, unknown>).upstreamStatus)
      : 0;

  return upstreamStatus === 400 || upstreamStatus === 422;
}

function normalizeSearchResponse(response: Record<string, unknown>, listKey: "clientes" | "contratos") {
  const value = response[listKey];
  if (Array.isArray(value)) {
    return value as SgpContractRaw[];
  }

  if (value && typeof value === "object" && "items" in value && Array.isArray((value as { items?: unknown[] }).items)) {
    return (value as { items: SgpContractRaw[] }).items;
  }

  return [];
}

function pickString(record: Record<string, unknown>, fields: string[]) {
  for (const field of fields) {
    const value = record[field];
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return "";
}

function buildDocumentVariants(digits: string): string[] {
  if (digits.length === 11) {
    const formatted = `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9, 11)}`;
    return [formatted, digits];
  }

  if (digits.length === 14) {
    const formatted = `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12, 14)}`;
    return [formatted, digits];
  }

  return [digits];
}
