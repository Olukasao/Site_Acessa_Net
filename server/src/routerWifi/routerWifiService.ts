import { constants, createCipheriv, createDecipheriv, createPublicKey, hkdfSync, publicEncrypt, randomBytes, type KeyObject } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors.js";
import type { PersistentRateLimiter } from "../auth/persistentRateLimiter.js";
import type { AuthProfileRepository } from "../repositories/authProfileRepository.js";
import type { SgpUraClient } from "../integrations/sgp/sgpClient.js";
import type { InMemoryStore } from "../repositories/inMemoryStore.js";
import { OwnershipService } from "../security/ownership.js";
import { sha256, verifyPassword } from "../security/hash.js";
import {
  CHANGE_KINDS,
  ROUTER_JOB_FINAL,
  ROUTER_JOB_PROGRESS,
  isFinalState,
  type InventoryEntry,
  type RouterJobRecord,
  type RouterJobState,
  type RouterWifiRepository,
  type WifiBand
} from "./routerWifiRepository.js";

export interface RouterWifiConfig {
  /** Liga a funcao para os clientes (ROUTER_WIFI_ENABLED=1). Desligada, a tela mostra "indisponivel" e nada e criado. */
  enabled: boolean;
  /** Token do agente interno (ROUTER_AGENT_TOKEN, 32+ caracteres). Sem ele as rotas do agente nem existem. */
  agentToken: string | undefined;
  /** Chave publica do agente (PEM). A senha nova so viaja e fica guardada cifrada com ela. */
  agentPublicKey: string | undefined;
  /** Piloto: so estes contratos podem usar (vazio = todos, quando ligado). */
  pilotContracts: string[];
}

export const WIFI_BANDS: WifiBand[] = ["2.4GHz", "5GHz"];
/** Pendente sem agente por mais que isso: falha "servico indisponivel". */
const PENDING_MAX_MS = 3 * 60_000;
/** Em andamento sem resposta do agente por mais que isso: encerra (troca de senha vira "nao confirmado"). */
const RUNNING_MAX_MS = 4 * 60_000;
/** Leitura do roteador reaproveitada por este tempo (a tela nao dispara uma nova a cada abertura). */
const STATUS_FRESH_MS = 5 * 60_000;

/** O agente busca tarefas a cada poucos segundos; sem sinal por mais que isto ele esta fora do ar. */
const AGENT_ONLINE_MS = 45_000;
/** Quanto tempo o cliente tem para responder "Conseguiu conectar?". */
const CONFIRM_WINDOW_MS = 24 * 60 * 60_000;

/** Dados memorizados para o chamado: so valem por este tempo (depois a senha cifrada e apagada). */
const FALLBACK_KEEP_MS = 24 * 60 * 60_000;
/** Quem esta abrindo o chamado ha mais que isto e considerado caido (o servidor reiniciou no meio): outro processo retoma. */
const OPENING_STALE_MS = 2 * 60_000;

/** Ver a ultima senha: poucas vezes por hora (e sempre com a senha da Central). */
const REVEAL_LIMIT = { limit: 5, windowMs: 60 * 60_000 };
const CHANGE_PER_CUSTOMER = { limit: 3, windowMs: 60 * 60_000 };
const CHANGE_PER_CONTRACT = { limit: 5, windowMs: 24 * 60 * 60_000 };
const CHANGE_PER_IP = { limit: 10, windowMs: 60 * 60_000 };
const STATUS_PER_CONTRACT = { limit: 20, windowMs: 60 * 60_000 };
const REAUTH_FAILURES = { limit: 5, windowMs: 15 * 60_000, cooldownMs: 15 * 60_000 };

/** Mensagens para o cliente, por codigo de erro do agente (o agente nunca manda texto livre para a tela). */
export const ERROR_MESSAGES: Record<string, string> = {
  ROUTER_OFFLINE: "Seu roteador está desconectado agora. Verifique se ele está ligado e tente de novo.",
  ROUTER_UNSUPPORTED: "Ainda não conseguimos alterar o Wi-Fi do seu modelo de roteador por aqui. Abra um atendimento que nossa equipe faz para você.",
  ROUTER_REQUIRES_VALIDATION: "Seu modelo de roteador ainda está em validação. Abra um atendimento que nossa equipe faz para você.",
  ROUTER_UNREACHABLE: "Não conseguimos falar com o seu roteador agora. Tente de novo em alguns minutos.",
  ROUTER_AUTH_FAILED: "Não conseguimos entrar no seu roteador. Abra um atendimento que nossa equipe resolve.",
  ROUTER_NOT_IDENTIFIED: "Não identificamos o seu roteador. Abra um atendimento que nossa equipe resolve.",
  SGP_UNAVAILABLE: "Não conseguimos consultar sua conexão agora. Tente de novo em alguns minutos.",
  CONTRACT_NOT_FOUND: "Não encontramos a conexão deste contrato.",
  VERIFY_FAILED: "O roteador recebeu o pedido, mas não confirmamos a nova senha. Teste a nova senha; se não funcionar, abra um atendimento.",
  ACCEPTED_NOT_VERIFIED: "O roteador aceitou a nova senha. Conecte seus aparelhos com ela; se não funcionar, abra um atendimento.",
  AGENT_UNAVAILABLE: "O serviço de Wi-Fi está indisponível agora. Tente de novo em alguns minutos.",
  AGENT_TIMEOUT: "Não recebemos a confirmação do roteador. Teste a nova senha; se não funcionar, abra um atendimento.",
  AGENT_OFFLINE: "O serviço de Wi-Fi está fora do ar agora. Tente de novo em alguns minutos.",
  INTERNAL: "Não foi possível concluir agora. Tente de novo mais tarde."
};
const ERROR_CODES = Object.keys(ERROR_MESSAGES) as [string, ...string[]];

const STATE_MESSAGES: Record<RouterJobState, string> = {
  pending: "Na fila...",
  connecting: "Conectando ao seu roteador...",
  authenticating: "Acessando o roteador...",
  updating: "Aplicando a nova senha...",
  verifying: "Conferindo a alteração...",
  completed: "Pronto!",
  failed: "Não foi possível concluir.",
  unsupported: "Seu roteador ainda não é compatível com a alteração automática.",
  unconfirmed: "Pedido enviado, mas o resultado ainda não foi confirmado."
};

const text = (max: number) => z.string().trim().max(max);
const bandSchema = z.enum(["2.4GHz", "5GHz"]);
/** O que o agente pode devolver numa leitura. Nada de senha: o schema e estrito. */
const statusResultSchema = z
  .object({
    online: z.boolean(),
    vendor: text(32).nullable(),
    model: text(64).nullable(),
    firmware: text(64).nullable(),
    management: z.enum(["available", "offline", "unsupported", "requires_validation", "unreachable", "not_identified"]),
    bands: z.array(bandSchema).max(2),
    ssids: z.object({ "2.4GHz": text(32).optional(), "5GHz": text(32).optional() }).strict().default({}),
    canChangePassword: z.boolean()
  })
  .strict();
const changeResultSchema = z.object({ bands: z.array(bandSchema).max(2), verified: z.boolean(), accepted: z.boolean().optional(), vendor: text(32).nullable().optional(), model: text(64).nullable().optional() }).strict();

export const agentReportSchema = z
  .object({
    agentId: z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/),
    state: z.enum([...ROUTER_JOB_PROGRESS, ...ROUTER_JOB_FINAL]),
    errorCode: z.enum(ERROR_CODES).optional(),
    result: z.unknown().optional()
  })
  .strict();

/** Regras da senha Wi-Fi (WPA2: 8 a 63 caracteres ASCII visiveis) + as da Central (maiuscula, numero, especial). */
export function validateWifiPassword(value: string): string | null {
  if (value.length < 8) return "A senha precisa ter pelo menos 8 caracteres.";
  if (value.length > 63) return "A senha pode ter no máximo 63 caracteres.";
  if (!/^[\x20-\x7E]+$/.test(value)) return "Use só letras sem acento, números, espaço e símbolos comuns.";
  if (value !== value.trim()) return "A senha não pode começar nem terminar com espaço.";
  if (!/[A-Z]/.test(value)) return "A senha precisa ter pelo menos uma letra maiúscula.";
  if (!/[0-9]/.test(value)) return "A senha precisa ter pelo menos um número.";
  if (!/[^A-Za-z0-9]/.test(value)) return "A senha precisa ter pelo menos um caractere especial.";
  return null;
}

/** Marca que fica SEMPRE no fim do nome de cada rede: o cliente muda so o que vem antes. */
export const SSID_TAGS: Record<WifiBand, string> = { "2.4GHz": "2.4", "5GHz": "5G" };
const SSID_BASE_MAX = 28; // 32 (limite do Wi-Fi) - " 2.4"/" 5G"

/** O cliente digita so o nome; o sistema acrescenta " 2.4" e " 5G". Devolve o motivo se o nome nao serve. */
export function validateWifiBaseName(value: string): string | null {
  if (!value || value !== value.trim()) return value ? "O nome não pode começar nem terminar com espaço." : "Digite o nome do Wi-Fi.";
  if (value.length > SSID_BASE_MAX) return `O nome pode ter no máximo ${SSID_BASE_MAX} caracteres (o sistema acrescenta 2.4 e 5G).`;
  if (!/^[A-Za-z0-9 ._-]+$/.test(value)) return "Use só letras sem acento, números, espaço, ponto, hífen e sublinhado.";
  if (/\s{2,}/.test(value)) return "Use um espaço só entre as palavras.";
  if (/(^|[\s_-])(2\.4|5g|2\.4ghz|5ghz)$/i.test(value)) return "Digite só o nome: o sistema já acrescenta 2.4 e 5G no final.";
  return null;
}

/** Os dois nomes que vao para o roteador (sempre as duas redes, sempre com 2.4 e 5G no fim). */
export function buildWifiNames(base: string): Record<WifiBand, string> {
  return { "2.4GHz": `${base} ${SSID_TAGS["2.4GHz"]}`, "5GHz": `${base} ${SSID_TAGS["5GHz"]}` };
}

export interface PublicRouterJob {
  id: string;
  kind: RouterJobRecord["kind"];
  state: RouterJobState;
  done: boolean;
  bands: WifiBand[];
  message: string;
  errorCode: string | null;
  result: Record<string, unknown> | null;
  /** O cliente ainda precisa dizer se conseguiu conectar ("Conseguiu conectar?"). */
  needsConfirmation: boolean;
  confirmation: "connected" | "not_connected" | null;
  ticketProtocol: string | null;
  /** A troca automatica nao funcionou e a Central ja abriu (ou esta abrindo) o chamado com os dados do cliente. */
  fallbackTicket: boolean;
  /** Novos nomes das redes (pedido de troca de nome; nao e segredo). */
  names: Record<string, string> | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

const awaitsCustomer = (job: RouterJobRecord) =>
  job.kind === "change_password" &&
  job.state === "unconfirmed" &&
  !job.customerConfirmation &&
  (job.errorCode === "ACCEPTED_NOT_VERIFIED" || job.errorCode === "VERIFY_FAILED") &&
  Boolean(job.finishedAt) &&
  Date.now() - Date.parse(job.finishedAt!) < CONFIRM_WINDOW_MS;

const hasMemo = (job: RouterJobRecord) => job.hasFallback || job.kind === "change_ssid";
const isChange = (job: RouterJobRecord) => job.kind === "change_password" || job.kind === "change_ssid";
const failedWithoutCustomer = (job: RouterJobRecord) => isChange(job) && !job.customerConfirmation && isFinalState(job.state) && job.state !== "completed" && job.errorCode !== "ACCEPTED_NOT_VERIFIED";

export function publicJob(job: RouterJobRecord): PublicRouterJob {
  const what = job.kind === "change_ssid" ? "o nome do Wi-Fi" : "a senha";
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    done: isFinalState(job.state),
    bands: job.bands,
    message:
      failedWithoutCustomer(job) && (job.ticketProtocol || hasMemo(job))
        ? job.ticketProtocol
          ? `Não conseguimos trocar ${what} automaticamente. Abrimos o chamado ${job.ticketProtocol} e nossa equipe troca para você.`
          : `Não conseguimos trocar ${what} automaticamente. Já guardamos o seu pedido e estamos abrindo o chamado para nossa equipe trocar para você.`
        : job.kind === "change_ssid" && job.state === "completed"
        ? "Pronto! O nome do Wi-Fi foi alterado nas duas redes. Seus aparelhos vão precisar escolher a rede de novo."
        : job.customerConfirmation === "not_connected"
        ? job.ticketProtocol
          ? `Abrimos o chamado ${job.ticketProtocol} para nossa equipe resolver.`
          : "Registramos que você não conseguiu conectar."
        : job.errorCode
          ? ERROR_MESSAGES[job.errorCode] ?? STATE_MESSAGES[job.state]
          : job.customerConfirmation === "connected"
            ? "Pronto! Você confirmou que o Wi-Fi conectou com a nova senha."
            : STATE_MESSAGES[job.state],
    errorCode: job.errorCode,
    result: job.result,
    needsConfirmation: awaitsCustomer(job),
    confirmation: job.customerConfirmation,
    ticketProtocol: job.ticketProtocol,
    fallbackTicket: isChange(job) && !job.customerConfirmation && (Boolean(job.ticketProtocol) || (hasMemo(job) && failedWithoutCustomer(job))),
    names: job.kind === "change_ssid" && job.params && typeof job.params.names === "object" ? (job.params.names as Record<string, string>) : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt
  };
}

/** Le a chave publica (PEM, aceitando "\n" escapado no .env). Invalida = funcao desligada. */
export function loadAgentPublicKey(pem: string | undefined): KeyObject | null {
  if (!pem) return null;
  try {
    const key = createPublicKey(pem.replace(/\\n/g, "\n"));
    return key.asymmetricKeyType === "rsa" && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048 ? key : null;
  } catch {
    return null;
  }
}

/** Ligacoes com o resto da Central (chamado e avisos), injetadas para o servico ser testavel sem SGP, FCM ou SMTP. */
export interface RouterWifiHooks {
  /** Abre o chamado de "nao consegui conectar" (sem a senha) e devolve o protocolo. */
  openTicket(input: { customerId: string; contractId: string; description: string }): Promise<{ protocol: string }>;
  /** Avisa o titular que a senha do Wi-Fi mudou (push e e-mail). Nunca lanca. */
  notifyChanged(job: RouterJobRecord): Promise<void>;
}

export class RouterWifiService {
  private readonly ownership: OwnershipService;
  private readonly publicKey: KeyObject | null;

  constructor(
    private readonly config: RouterWifiConfig,
    private readonly repo: RouterWifiRepository,
    private readonly authProfiles: AuthProfileRepository,
    private readonly limiter: PersistentRateLimiter,
    store: InMemoryStore,
    sgpClient: SgpUraClient,
    private readonly hooks?: RouterWifiHooks
  ) {
    this.ownership = new OwnershipService(store, sgpClient);
    this.publicKey = loadAgentPublicKey(config.agentPublicKey);
  }

  // ---------- dados memorizados (senha escolhida) ----------

  /** Chave so da Central (derivada do segredo do agente); o agente nao usa esta copia. */
  private fallbackKey(): Buffer | null {
    const token = this.config.agentToken;
    return token ? Buffer.from(hkdfSync("sha256", token, "acessanet-router-wifi", "fallback-v1", 32)) : null;
  }

  private encryptFallback(password: string): string | null {
    const key = this.fallbackKey();
    if (!key) return null;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
    return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${data.toString("base64")}`;
  }

  private decryptFallback(box: string | null): string | null {
    const key = this.fallbackKey();
    if (!key || !box) return null;
    try {
      const [iv, tag, data] = box.split(".").map((part) => Buffer.from(part, "base64"));
      const decipher = createDecipheriv("aes-256-gcm", key, iv!);
      decipher.setAuthTag(tag!);
      return Buffer.concat([decipher.update(data!), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }

  /**
   * Texto do chamado com os dados memorizados: redes, motivo e a senha que o cliente escolheu (como ja acontece no pedido
   * de troca pelo atendimento, para o tecnico trocar no roteador). A senha sai do banco assim que o chamado abre.
   */
  private async buildTicketDescription(job: RouterJobRecord, reason: string): Promise<string> {
    const when = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).format(new Date(job.finishedAt ?? job.updatedAt));
    const roteador = (job.result as { vendor?: string | null; model?: string | null } | null) ?? null;
    if (job.kind === "change_ssid") {
      const names = (job.params?.names ?? {}) as Record<string, string>;
      return [
        "Troca do NOME do Wi-Fi pedida pelo cliente na Central do Assinante.",
        reason,
        ...Object.entries(names).map(([band, name]) => `Rede ${band.replace("GHz", " GHz")}: novo nome "${name}".`),
        roteador?.vendor ? `Roteador: ${[roteador.vendor, roteador.model].filter(Boolean).join(" ")}.` : "",
        `Tentativa automática em ${when}.`,
        "Trocar o nome das duas redes no roteador do cliente (mantendo 2.4 e 5G no final) e avisar."
      ]
        .filter(Boolean)
        .join("\n");
    }
    const password = this.decryptFallback(await this.repo.getFallbackEnc(job.id));
    return [
      "Troca de senha do Wi-Fi pedida pelo cliente na Central do Assinante.",
      reason,
      `Redes: ${job.bands.map((b) => b.replace("GHz", " GHz")).join(" e ") || "—"}.`,
      roteador?.vendor ? `Roteador: ${[roteador.vendor, roteador.model].filter(Boolean).join(" ")}.` : "",
      `Tentativa automática em ${when}.`,
      password ? `Nova senha escolhida pelo cliente: ${password}` : "A nova senha não ficou guardada: pedir ao cliente por telefone.",
      "Trocar a senha no roteador do cliente e avisar."
    ]
      .filter(Boolean)
      .join("\n");
  }

  /**
   * A troca automatica nao funcionou: abre o chamado com os dados memorizados (uma vez so) e apaga a senha guardada.
   * Se nao conseguir abrir agora (ex.: SGP fora), os dados continuam guardados e a varredura tenta de novo.
   */
  async ensureFallbackTicket(jobId: string): Promise<void> {
    if (!this.hooks) return;
    const job = await this.repo.findById(jobId);
    if (!job || !isChange(job) || job.ticketProtocol || !hasMemo(job) || job.customerConfirmation) return;
    if (!isFinalState(job.state) || job.state === "completed" || job.errorCode === "ACCEPTED_NOT_VERIFIED") return;
    if (!(await this.repo.claimFallback(jobId, new Date(), new Date(Date.now() - OPENING_STALE_MS)))) return;
    try {
      const reason = `A ${job.kind === "change_ssid" ? "troca do nome" : "troca"} automática NÃO funcionou (${job.errorCode ?? job.state}). Se algo foi aplicado no roteador, pode ter sido só em parte.`;
      const ticket = await this.hooks.openTicket({ customerId: job.customerId, contractId: job.contractId, description: await this.buildTicketDescription(job, reason) });
      await this.repo.finishFallback(jobId, ticket.protocol);
    } catch {
      await this.repo.releaseFallback(jobId);
    }
  }

  /** Varredura periodica: encerra o que parou, abre os chamados que faltam e apaga dados memorizados vencidos. */
  async sweepFallbacks(limit = 20): Promise<number> {
    await this.expire(true);
    const pending = await this.repo.listFallbackPending(new Date(Date.now() - FALLBACK_KEEP_MS), new Date(Date.now() - OPENING_STALE_MS), limit);
    for (const job of pending) await this.ensureFallbackTicket(job.id);
    await this.repo.purgeFallbackBefore(new Date(Date.now() - FALLBACK_KEEP_MS));
    return pending.length;
  }

  /** Ligado, com agente configurado e (no piloto) com o contrato na lista. */
  availableFor(contractId: string) {
    if (!this.config.enabled || !this.publicKey || !this.config.agentToken) return false;
    return this.config.pilotContracts.length === 0 || this.config.pilotContracts.includes(contractId);
  }

  /** O agente interno mandou sinal de vida nos ultimos segundos? */
  async agentOnline(): Promise<boolean> {
    const last = await this.repo.lastAgent();
    return Boolean(last && Date.now() - Date.parse(last.lastSeenAt) < AGENT_ONLINE_MS);
  }

  /** Para a tela decidir se oferece a troca (nao cria tarefa nem consulta o roteador). */
  async availability(customerId: string, contractId: string) {
    await this.ownership.assertContract(customerId, contractId);
    if (!this.availableFor(contractId)) return { available: false, agentOnline: false };
    return { available: true, agentOnline: await this.agentOnline() };
  }

  private lastExpire = 0;

  /** Encerra o que parou. O acompanhamento da tela pergunta a cada segundo: nos caminhos quentes faz no maximo a cada 5 s. */
  private async expire(force = false) {
    if (!force && Date.now() - this.lastExpire < 5000) return;
    this.lastExpire = Date.now();
    await this.repo.expireStale(new Date(), PENDING_MAX_MS, RUNNING_MAX_MS);
  }

  /** Leitura do roteador do contrato (modelo, redes, se da para trocar a senha). Cria uma tarefa se nao houver leitura recente. */
  async status(customerId: string, contractId: string) {
    await this.ownership.assertContract(customerId, contractId);
    if (!this.availableFor(contractId)) return { available: false as const, agentOnline: false, job: null, pendingChange: null };
    await this.expire();
    const awaiting = await this.repo.findAwaitingConfirmation(contractId, new Date(Date.now() - CONFIRM_WINDOW_MS));
    const pendingChange = awaiting && awaiting.customerId === customerId ? publicJob(awaiting) : null;
    // Agente fora do ar: nao cria tarefa que ficaria presa; a tela mostra "indisponivel agora".
    if (!(await this.agentOnline())) return { available: true as const, agentOnline: false, job: null, pendingChange };
    const open = await this.repo.findOpen(contractId, "status");
    if (open) return { available: true as const, agentOnline: true, job: publicJob(open), pendingChange };
    const last = await this.repo.latestFinished(contractId, "status");
    if (last?.finishedAt && Date.now() - Date.parse(last.finishedAt) < STATUS_FRESH_MS) return { available: true as const, agentOnline: true, job: publicJob(last), pendingChange };
    await this.limiter.consume(`router_wifi:status:contract:${contractId}`, STATUS_PER_CONTRACT);
    const job = await this.repo.create({ customerId, contractId, kind: "status", bands: [], secretEnc: null });
    return { available: true as const, agentOnline: true, job: publicJob(job), pendingChange };
  }

  /** Redes da ultima leitura concluida (sem criar tarefa). */
  async networks(customerId: string, contractId: string) {
    await this.ownership.assertContract(customerId, contractId);
    if (!this.availableFor(contractId)) return { available: false, networks: [] };
    const last = await this.repo.latestFinished(contractId, "status");
    const result = last?.state === "completed" ? (last.result as { bands?: WifiBand[]; ssids?: Record<string, string> } | null) : null;
    return { available: true, networks: (result?.bands ?? []).map((band) => ({ band, ssid: result?.ssids?.[band] ?? null })) };
  }

  async changePassword(input: {
    customerId: string;
    cpfHash: string;
    ip: string;
    contractId: string;
    newPassword: string;
    bands: WifiBand[];
    currentPassword: string;
  }) {
    await this.ownership.assertContract(input.customerId, input.contractId);
    if (!this.availableFor(input.contractId)) throw new AppError(404, "WIFI_MANAGER_UNAVAILABLE", "A alteração do Wi-Fi pela Central ainda não está disponível para você.");

    if (!(await this.agentOnline())) throw new AppError(503, "WIFI_AGENT_OFFLINE", ERROR_MESSAGES.AGENT_OFFLINE!);

    const problem = validateWifiPassword(input.newPassword);
    if (problem) throw new AppError(422, "INVALID_WIFI_PASSWORD", problem);
    const bands = [...new Set(input.bands)];
    if (!bands.length || !bands.every((band) => WIFI_BANDS.includes(band))) throw new AppError(422, "INVALID_BANDS", "Escolha a rede 2.4 GHz, 5 GHz ou as duas.");

    await this.reauth(input.cpfHash, input.currentPassword);

    // Ja ha uma troca em andamento: responde isso antes de gastar as cotas (clicar de novo nao pode consumir o limite do cliente)
    await this.expire(true);
    if (await this.repo.findOpenChange(input.contractId)) {
      throw new AppError(409, "WIFI_CHANGE_IN_PROGRESS", "Já existe uma alteração em andamento. Aguarde terminar.");
    }
    await this.limiter.consume(`router_wifi:change:customer:${input.customerId}`, CHANGE_PER_CUSTOMER);
    await this.limiter.consume(`router_wifi:change:contract:${input.contractId}`, CHANGE_PER_CONTRACT);
    await this.limiter.consume(`router_wifi:change:ip:${sha256(input.ip)}`, CHANGE_PER_IP);

    const secretEnc = publicEncrypt(
      { key: this.publicKey!, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(input.newPassword, "utf8")
    ).toString("base64");
    const job = await this.repo.create({ customerId: input.customerId, contractId: input.contractId, kind: "change_password", bands, secretEnc, fallbackEnc: this.encryptFallback(input.newPassword) });
    return publicJob(job);
  }

  /** Confirma que e o titular: pede de novo a senha da Central (a sessao sozinha nao basta). */
  private async reauth(cpfHash: string, currentPassword: string) {
    await this.limiter.consume(`router_wifi:reauth:${cpfHash}:check`, REAUTH_FAILURES);
    const profile = await this.authProfiles.findByCpfHash(cpfHash);
    if (!profile?.passwordHash || !(await verifyPassword(currentPassword, profile.passwordHash))) {
      throw new AppError(403, "REAUTH_FAILED", "Senha da Central incorreta.");
    }
  }

  /**
   * Troca o NOME do Wi-Fi. O cliente digita so o nome; o sistema acrescenta " 2.4" e " 5G" e troca SEMPRE as duas redes juntas.
   * A conferencia e real (le o nome de volta no roteador), entao termina "concluido" sem pedir confirmacao ao cliente.
   */
  async changeName(input: { customerId: string; cpfHash: string; ip: string; contractId: string; name: string; currentPassword: string }) {
    await this.ownership.assertContract(input.customerId, input.contractId);
    if (!this.availableFor(input.contractId)) throw new AppError(404, "WIFI_MANAGER_UNAVAILABLE", "A alteração do Wi-Fi pela Central ainda não está disponível para você.");
    if (!(await this.agentOnline())) throw new AppError(503, "WIFI_AGENT_OFFLINE", ERROR_MESSAGES.AGENT_OFFLINE!);

    const problem = validateWifiBaseName(input.name);
    if (problem) throw new AppError(422, "INVALID_WIFI_NAME", problem);
    const names = buildWifiNames(input.name);

    await this.reauth(input.cpfHash, input.currentPassword);
    await this.expire(true);
    if (await this.repo.findOpenChange(input.contractId)) {
      throw new AppError(409, "WIFI_CHANGE_IN_PROGRESS", "Já existe uma alteração em andamento. Aguarde terminar.");
    }
    await this.limiter.consume(`router_wifi:name:customer:${input.customerId}`, CHANGE_PER_CUSTOMER);
    await this.limiter.consume(`router_wifi:name:contract:${input.contractId}`, CHANGE_PER_CONTRACT);
    await this.limiter.consume(`router_wifi:change:ip:${sha256(input.ip)}`, CHANGE_PER_IP);

    const job = await this.repo.create({ customerId: input.customerId, contractId: input.contractId, kind: "change_ssid", bands: [...WIFI_BANDS], secretEnc: null, params: { names } });
    return publicJob(job);
  }

  /** Historico das ultimas trocas (senha e nome) do contrato. Nunca traz senha: so quando, quais redes e como terminou. */
  async history(customerId: string, contractId: string) {
    await this.ownership.assertContract(customerId, contractId);
    if (!this.availableFor(contractId)) return { available: false, items: [], lastPassword: null };
    const jobs = (await this.repo.listChanges(contractId, 10)).filter((j) => j.customerId === customerId);
    const last = await this.repo.getLastPassword(contractId);
    return {
      available: true,
      items: jobs.map((j) => ({
        id: j.id,
        kind: j.kind,
        bands: j.bands,
        names: j.kind === "change_ssid" && j.params?.names ? (j.params.names as Record<string, string>) : null,
        state: j.state,
        done: isFinalState(j.state),
        message: publicJob(j).message,
        ticketProtocol: j.ticketProtocol,
        createdAt: j.createdAt,
        finishedAt: j.finishedAt
      })),
      // so informa que existe e quando foi; a senha so sai em revealLastPassword, depois de confirmar a senha da Central
      lastPassword: last && last.customerId === customerId ? { setAt: last.setAt, bands: last.bands } : null
    };
  }

  /** Mostra a ultima senha definida pela Central, so depois de o titular confirmar a senha da Central. Fica cifrada no banco. */
  async revealLastPassword(input: { customerId: string; cpfHash: string; contractId: string; currentPassword: string }) {
    await this.ownership.assertContract(input.customerId, input.contractId);
    if (!this.availableFor(input.contractId)) throw new AppError(404, "WIFI_MANAGER_UNAVAILABLE", "Esta função ainda não está disponível para você.");
    await this.limiter.consume(`router_wifi:reveal:customer:${input.customerId}`, REVEAL_LIMIT);
    await this.reauth(input.cpfHash, input.currentPassword);
    const last = await this.repo.getLastPassword(input.contractId);
    if (!last || last.customerId !== input.customerId) throw new AppError(404, "NO_LAST_PASSWORD", "Não há uma senha guardada para este contrato.");
    const password = this.decryptFallback(last.passwordEnc);
    if (!password) throw new AppError(410, "LAST_PASSWORD_UNREADABLE", "Não foi possível recuperar a senha guardada. Troque a senha de novo.");
    return { password, bands: last.bands, setAt: last.setAt };
  }

  /** Acompanhamento: o cliente so ve as proprias tarefas. */
  async getJob(customerId: string, jobId: string) {
    await this.expire();
    let job = await this.repo.findById(jobId);
    if (!job || job.customerId !== customerId) throw new AppError(404, "RESOURCE_NOT_FOUND", "Solicitação não encontrada.");
    // pedido que parou (agente caiu) e ainda nao virou chamado: abre agora, para a resposta ja trazer o protocolo
    if (isChange(job) && hasMemo(job) && !job.ticketProtocol && isFinalState(job.state)) {
      await this.ensureFallbackTicket(jobId);
      job = (await this.repo.findById(jobId)) ?? job;
    }
    return publicJob(job);
  }

  // ---------- agente interno ----------

  async claim(agentId: string, max: number, info: { dryRun?: boolean | undefined; version?: string | undefined; waitMs?: number | undefined } = {}) {
    // cada busca de tarefas e o sinal de vida do agente
    await this.repo.touchAgent(agentId, info.dryRun ?? true, info.version ?? null, new Date());
    await this.expire(true);
    const limit = Math.min(Math.max(1, max), 10);
    let jobs = await this.repo.claim(agentId, limit, new Date());
    // Espera longa: se nao ha tarefa, segura a resposta ate chegar uma (ate waitMs). O agente e avisado na hora, sem esperar o proximo ciclo.
    const deadline = Date.now() + Math.min(Math.max(0, info.waitMs ?? 0), 20_000);
    while (!jobs.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      jobs = await this.repo.claim(agentId, limit, new Date());
    }
    // O agente recebe so o contrato e o segredo cifrado; nada de cliente/CPF.
    return jobs.map((job) => ({ id: job.id, contractId: job.contractId, kind: job.kind, bands: job.bands, secretEnc: job.secretEnc, params: job.params }));
  }

  async report(jobId: string, body: unknown) {
    const parsed = agentReportSchema.safeParse(body);
    if (!parsed.success) throw new AppError(422, "INVALID_REPORT", "Relatório inválido.");
    const { agentId, state, errorCode } = parsed.data;
    const job = await this.repo.findById(jobId);
    if (!job || job.agentId !== agentId) throw new AppError(404, "RESOURCE_NOT_FOUND", "Tarefa não encontrada.");

    let result: Record<string, unknown> | null = null;
    if (parsed.data.result !== undefined) {
      const schema = job.kind === "status" ? statusResultSchema : changeResultSchema;
      const ok = schema.safeParse(parsed.data.result);
      if (!ok.success) throw new AppError(422, "INVALID_RESULT", "Resultado inválido.");
      result = ok.data as Record<string, unknown>;
    }
    // "Concluido" exige verificacao: troca de senha sem ela vira "nao confirmado" (o roteador esconde a senha); troca de nome sem ela e falha.
    let finalState: RouterJobState = state;
    let finalError = errorCode ?? null;
    const verified = (result as { verified?: boolean } | null)?.verified === true;
    if (job.kind === "change_password" && state === "completed" && !verified) {
      finalState = "unconfirmed";
      finalError = finalError ?? ((result as { accepted?: boolean } | null)?.accepted === true ? "ACCEPTED_NOT_VERIFIED" : "VERIFY_FAILED");
    }
    if (job.kind === "change_ssid" && state === "completed" && !verified) {
      finalState = "unconfirmed";
      finalError = finalError ?? "VERIFY_FAILED";
    }
    if ((finalState === "failed" || finalState === "unsupported") && !finalError) finalError = "INTERNAL";

    // a senha memorizada (cifrada) vira "ultima senha" se a troca foi aceita; ler ANTES do update, que apaga a copia quando conclui
    const memorized = job.kind === "change_password" ? await this.repo.getFallbackEnc(jobId) : null;
    const ok = await this.repo.update(jobId, agentId, { state: finalState, result, errorCode: finalError, now: new Date() });
    if (!ok) throw new AppError(409, "JOB_ALREADY_FINISHED", "A tarefa já terminou.");
    const accepted = finalState === "completed" || finalError === "ACCEPTED_NOT_VERIFIED";
    if (job.kind === "change_password" && accepted && memorized) {
      await this.repo.saveLastPassword({ contractId: job.contractId, customerId: job.customerId, passwordEnc: memorized, bands: job.bands, jobId, setAt: new Date().toISOString() });
    }
    // Troca aceita (confirmada ou aceita pelo roteador): avisa o titular, uma vez, sem atrasar a resposta ao agente.
    if (isChange(job) && accepted) {
      void this.notifyOnce(jobId).catch(() => undefined);
    } else if (isChange(job) && isFinalState(finalState)) {
      // a troca automatica nao funcionou: memoriza e abre o chamado
      void this.ensureFallbackTicket(jobId).catch(() => undefined);
    }
    return { ok: true, state: finalState };
  }

  private async notifyOnce(jobId: string) {
    if (!this.hooks) return;
    if (!(await this.repo.markNotified(jobId, new Date()))) return;
    const job = await this.repo.findById(jobId);
    if (job) await this.hooks.notifyChanged(job);
  }

  /** "Conseguiu conectar?": sim fecha o pedido; nao abre o chamado (sem a senha) e guarda o numero do protocolo no pedido. */
  async confirm(input: { customerId: string; jobId: string; connected: boolean }) {
    const job = await this.repo.findById(input.jobId);
    if (!job || job.customerId !== input.customerId || job.kind !== "change_password") throw new AppError(404, "RESOURCE_NOT_FOUND", "Solicitação não encontrada.");
    await this.ownership.assertContract(input.customerId, job.contractId);
    if (!awaitsCustomer(job)) throw new AppError(409, "WIFI_NOTHING_TO_CONFIRM", "Esta alteração não está esperando confirmação.");

    const done = await this.repo.confirm(job.id, input.customerId, input.connected ? "connected" : "not_connected", new Date());
    if (!done) throw new AppError(409, "WIFI_ALREADY_CONFIRMED", "Você já respondeu sobre esta alteração.");
    // o cliente disse que a senha nova NAO funcionou: ela nao vale como "ultima senha"
    if (!input.connected) {
      const last = await this.repo.getLastPassword(job.contractId);
      if (last?.jobId === job.id) await this.repo.deleteLastPassword(job.contractId);
    }

    if (!input.connected) {
      const description = await this.buildTicketDescription(
        job,
        "O cliente disse que NÃO conseguiu conectar com a nova senha (o roteador tinha aceitado o pedido, mas não deu para conferir)."
      );
      try {
        const ticket = await this.hooks?.openTicket({ customerId: input.customerId, contractId: job.contractId, description });
        if (ticket) await this.repo.finishFallback(job.id, ticket.protocol);
      } catch (error) {
        // O chamado nao abriu agora: a resposta do cliente fica gravada e a tela oferece o atendimento manual.
        const fresh = await this.repo.findById(job.id);
        return { job: publicJob(fresh ?? job), ticketOpened: false, error: error instanceof AppError ? error.message : "Não foi possível abrir o chamado agora." };
      }
    }
    const fresh = await this.repo.findById(job.id);
    return { job: publicJob(fresh ?? job), ticketOpened: !input.connected };
  }

  // ---------- aviso para a equipe ----------

  /**
   * Trocas de senha que a equipe quer saber (feed para o chat interno/Workspace): o roteador aceitou, o cliente confirmou
   * ou disse que nao conseguiu conectar. Sem senha, sem IP, sem id interno do cliente.
   */
  async staffFeed(since: Date) {
    const jobs = (await this.repo.listSince(since, 500)).filter(
      (j) => j.kind === "change_password" && (j.state === "completed" || j.errorCode === "ACCEPTED_NOT_VERIFIED" || j.customerConfirmation !== null)
    );
    return jobs.map((j) => {
      const r = j.result as { vendor?: string | null; model?: string | null } | null;
      return {
        id: j.id,
        contractId: j.contractId,
        customerId: j.customerId,
        bands: j.bands,
        vendor: r?.vendor ?? null,
        model: r?.model ?? null,
        state: j.state,
        confirmation: j.customerConfirmation,
        ticketProtocol: j.ticketProtocol,
        finishedAt: j.finishedAt,
        confirmedAt: j.confirmedAt
      };
    });
  }

  // ---------- inventario e painel ----------

  async saveInventory(entries: InventoryEntry[]) {
    return this.repo.upsertInventory(entries, new Date());
  }

  /** Painel administrativo: resumo do periodo, ultimas solicitacoes e inventario. */
  async adminOverview(days: number, filter: { vendor?: string | undefined; state?: string | undefined } = {}) {
    const since = new Date(Date.now() - days * 24 * 60 * 60_000);
    const jobs = await this.repo.listSince(since, 5000);
    const changes = jobs.filter((j) => j.kind === "change_password");
    const finished = changes.filter((j) => isFinalState(j.state));
    const durations = finished.filter((j) => j.finishedAt).map((j) => Date.parse(j.finishedAt!) - Date.parse(j.createdAt)).filter((ms) => ms >= 0);
    const failuresByCode: Record<string, number> = {};
    for (const j of jobs) if (j.errorCode && (j.state === "failed" || j.state === "unsupported" || j.state === "unconfirmed")) failuresByCode[j.errorCode] = (failuresByCode[j.errorCode] ?? 0) + 1;
    const accepted = changes.filter((j) => j.state === "completed" || j.errorCode === "ACCEPTED_NOT_VERIFIED").length;
    // taxa por fabricante/modelo: o agente informa vendor/model em cada resultado
    const byModel: Record<string, { requests: number; accepted: number; failed: number }> = {};
    for (const j of changes) {
      const r = j.result as { vendor?: string | null; model?: string | null } | null;
      const key = [r?.vendor, r?.model].filter(Boolean).join(" ") || "Não identificado";
      const row = (byModel[key] ??= { requests: 0, accepted: 0, failed: 0 });
      row.requests++;
      if (j.state === "completed" || j.errorCode === "ACCEPTED_NOT_VERIFIED") row.accepted++;
      else if (j.state === "failed" || j.state === "unsupported") row.failed++;
    }
    const rows = (await Promise.all(jobs.slice(0, 200).map(async (j) => ({ ...publicJob(j), contractId: j.contractId, vendor: (j.result as { vendor?: string } | null)?.vendor ?? null, model: (j.result as { model?: string } | null)?.model ?? null }))))
      .filter((j) => (!filter.state || j.state === filter.state) && (!filter.vendor || j.vendor === filter.vendor));
    const agent = await this.repo.lastAgent();
    return {
      agent: { online: await this.agentOnline(), lastSeenAt: agent?.lastSeenAt ?? null, dryRun: agent?.dryRun ?? null, version: agent?.version ?? null },
      enabled: this.config.enabled,
      summary: {
        days,
        requests: changes.length,
        accepted,
        acceptedRate: changes.length ? Math.round((accepted / changes.length) * 100) : null,
        confirmedByCustomer: changes.filter((j) => j.customerConfirmation === "connected").length,
        notConnected: changes.filter((j) => j.customerConfirmation === "not_connected").length,
        awaitingCustomer: changes.filter(awaitsCustomer).length,
        failed: changes.filter((j) => j.state === "failed").length,
        unsupported: changes.filter((j) => j.state === "unsupported").length,
        avgSeconds: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 1000) : null,
        failuresByCode,
        byModel
      },
      inventory: await this.repo.inventorySummary(),
      items: rows
    };
  }

  async adminList(limit: number) {
    return (await this.repo.list(Math.min(Math.max(1, limit), 500))).map((job) => ({ ...publicJob(job), contractId: job.contractId }));
  }
}
