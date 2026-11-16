import { constants, createPublicKey, publicEncrypt, type KeyObject } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors.js";
import type { PersistentRateLimiter } from "../auth/persistentRateLimiter.js";
import type { AuthProfileRepository } from "../repositories/authProfileRepository.js";
import type { SgpUraClient } from "../integrations/sgp/sgpClient.js";
import type { InMemoryStore } from "../repositories/inMemoryStore.js";
import { OwnershipService } from "../security/ownership.js";
import { sha256, verifyPassword } from "../security/hash.js";
import {
  ROUTER_JOB_FINAL,
  ROUTER_JOB_PROGRESS,
  isFinalState,
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
const changeResultSchema = z.object({ bands: z.array(bandSchema).max(2), verified: z.boolean(), accepted: z.boolean().optional() }).strict();

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

export interface PublicRouterJob {
  id: string;
  kind: RouterJobRecord["kind"];
  state: RouterJobState;
  done: boolean;
  bands: WifiBand[];
  message: string;
  errorCode: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export function publicJob(job: RouterJobRecord): PublicRouterJob {
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    done: isFinalState(job.state),
    bands: job.bands,
    message: job.errorCode ? ERROR_MESSAGES[job.errorCode] ?? STATE_MESSAGES[job.state] : STATE_MESSAGES[job.state],
    errorCode: job.errorCode,
    result: job.result,
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

export class RouterWifiService {
  private readonly ownership: OwnershipService;
  private readonly publicKey: KeyObject | null;

  constructor(
    private readonly config: RouterWifiConfig,
    private readonly repo: RouterWifiRepository,
    private readonly authProfiles: AuthProfileRepository,
    private readonly limiter: PersistentRateLimiter,
    store: InMemoryStore,
    sgpClient: SgpUraClient
  ) {
    this.ownership = new OwnershipService(store, sgpClient);
    this.publicKey = loadAgentPublicKey(config.agentPublicKey);
  }

  /** Ligado, com agente configurado e (no piloto) com o contrato na lista. */
  availableFor(contractId: string) {
    if (!this.config.enabled || !this.publicKey || !this.config.agentToken) return false;
    return this.config.pilotContracts.length === 0 || this.config.pilotContracts.includes(contractId);
  }

  private async expire() {
    await this.repo.expireStale(new Date(), PENDING_MAX_MS, RUNNING_MAX_MS);
  }

  /** Leitura do roteador do contrato (modelo, redes, se da para trocar a senha). Cria uma tarefa se nao houver leitura recente. */
  async status(customerId: string, contractId: string) {
    await this.ownership.assertContract(customerId, contractId);
    if (!this.availableFor(contractId)) return { available: false as const, job: null };
    await this.expire();
    const open = await this.repo.findOpen(contractId, "status");
    if (open) return { available: true as const, job: publicJob(open) };
    const last = await this.repo.latestFinished(contractId, "status");
    if (last?.finishedAt && Date.now() - Date.parse(last.finishedAt) < STATUS_FRESH_MS) return { available: true as const, job: publicJob(last) };
    await this.limiter.consume(`router_wifi:status:contract:${contractId}`, STATUS_PER_CONTRACT);
    const job = await this.repo.create({ customerId, contractId, kind: "status", bands: [], secretEnc: null });
    return { available: true as const, job: publicJob(job) };
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

    const problem = validateWifiPassword(input.newPassword);
    if (problem) throw new AppError(422, "INVALID_WIFI_PASSWORD", problem);
    const bands = [...new Set(input.bands)];
    if (!bands.length || !bands.every((band) => WIFI_BANDS.includes(band))) throw new AppError(422, "INVALID_BANDS", "Escolha a rede 2.4 GHz, 5 GHz ou as duas.");

    // Confirma que e o titular: pede de novo a senha da Central (a sessao sozinha nao basta para mexer no roteador).
    const reauthKey = `router_wifi:reauth:${input.cpfHash}`;
    await this.limiter.consume(`${reauthKey}:check`, REAUTH_FAILURES);
    const profile = await this.authProfiles.findByCpfHash(input.cpfHash);
    if (!profile?.passwordHash || !(await verifyPassword(input.currentPassword, profile.passwordHash))) {
      throw new AppError(403, "REAUTH_FAILED", "Senha da Central incorreta.");
    }

    await this.limiter.consume(`router_wifi:change:customer:${input.customerId}`, CHANGE_PER_CUSTOMER);
    await this.limiter.consume(`router_wifi:change:contract:${input.contractId}`, CHANGE_PER_CONTRACT);
    await this.limiter.consume(`router_wifi:change:ip:${sha256(input.ip)}`, CHANGE_PER_IP);

    await this.expire();
    if (await this.repo.findOpen(input.contractId, "change_password")) {
      throw new AppError(409, "WIFI_CHANGE_IN_PROGRESS", "Já existe uma alteração em andamento. Aguarde terminar.");
    }

    const secretEnc = publicEncrypt(
      { key: this.publicKey!, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(input.newPassword, "utf8")
    ).toString("base64");
    const job = await this.repo.create({ customerId: input.customerId, contractId: input.contractId, kind: "change_password", bands, secretEnc });
    return publicJob(job);
  }

  /** Acompanhamento: o cliente so ve as proprias tarefas. */
  async getJob(customerId: string, jobId: string) {
    await this.expire();
    const job = await this.repo.findById(jobId);
    if (!job || job.customerId !== customerId) throw new AppError(404, "RESOURCE_NOT_FOUND", "Solicitação não encontrada.");
    return publicJob(job);
  }

  // ---------- agente interno ----------

  async claim(agentId: string, max: number) {
    await this.expire();
    const jobs = await this.repo.claim(agentId, Math.min(Math.max(1, max), 10), new Date());
    // O agente recebe so o contrato e o segredo cifrado; nada de cliente/CPF.
    return jobs.map((job) => ({ id: job.id, contractId: job.contractId, kind: job.kind, bands: job.bands, secretEnc: job.secretEnc }));
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
    // "Concluido" de troca de senha exige verificacao: sem ela vira "nao confirmado".
    let finalState: RouterJobState = state;
    let finalError = errorCode ?? null;
    if (job.kind === "change_password" && state === "completed" && (result as { verified?: boolean } | null)?.verified !== true) {
      finalState = "unconfirmed";
      finalError = finalError ?? ((result as { accepted?: boolean } | null)?.accepted === true ? "ACCEPTED_NOT_VERIFIED" : "VERIFY_FAILED");
    }
    if ((finalState === "failed" || finalState === "unsupported") && !finalError) finalError = "INTERNAL";

    const ok = await this.repo.update(jobId, agentId, { state: finalState, result, errorCode: finalError, now: new Date() });
    if (!ok) throw new AppError(409, "JOB_ALREADY_FINISHED", "A tarefa já terminou.");
    return { ok: true, state: finalState };
  }

  async adminList(limit: number) {
    return (await this.repo.list(Math.min(Math.max(1, limit), 500))).map((job) => ({ ...publicJob(job), contractId: job.contractId }));
  }
}
