import { constants, createPrivateKey, privateDecrypt } from "node:crypto";
import { readFileSync } from "node:fs";
import { CredentialStore } from "./credentials.mjs";
import { Limiter, RouterManager } from "./manager.mjs";
import { parseCidr } from "./policy.mjs";
import { SgpClient } from "./sgp.mjs";

/** Le e valida a configuracao (variaveis de ambiente). Falta algo essencial = nao sobe. */
export function loadConfig(env = process.env) {
  const need = (name) => {
    const v = env[name];
    if (!v) throw new Error(`falta ${name}`);
    return v;
  };
  const token = need("ROUTER_AGENT_TOKEN");
  if (token.length < 32) throw new Error("ROUTER_AGENT_TOKEN curto demais");
  const endpoints = JSON.parse(env.ROUTER_ENDPOINTS || "{}"); // ex.: {"tplink":{"protocol":"http","port":80}}
  return {
    centralUrl: need("CENTRAL_URL").replace(/\/+$/, ""),
    token,
    agentId: env.ROUTER_AGENT_ID || "agente-1",
    privateKeyPath: need("ROUTER_AGENT_PRIVATE_KEY_PATH"),
    credentialsPath: need("ROUTER_CREDENTIALS_PATH"),
    credentialsKey: need("ROUTER_CREDENTIALS_KEY"),
    sgp: {
      uraBaseUrl: need("SGP_URA_BASE_URL").replace(/\/+$/, ""),
      uraUsername: need("SGP_URA_USERNAME"),
      uraPassword: need("SGP_URA_PASSWORD"),
      webBaseUrl: need("SGP_WEB_BASE_URL").replace(/\/+$/, ""),
      webUsername: need("SGP_WEB_USERNAME"),
      webPassword: need("SGP_WEB_PASSWORD"),
      timeoutMs: Number(env.SGP_TIMEOUT_MS || 15000)
    },
    cidrs: (env.ROUTER_ALLOWED_CIDRS || "100.64.0.0/10").split(",").map(parseCidr),
    endpoints,
    // Seguranca: sem ROUTER_AGENT_DRY_RUN=0 o agente so le o SGP e nunca entra num roteador.
    dryRun: env.ROUTER_AGENT_DRY_RUN !== "0",
    pollMs: Math.max(1000, Number(env.ROUTER_AGENT_POLL_MS || 3000)),
    concurrency: Math.max(1, Math.min(20, Number(env.ROUTER_AGENT_CONCURRENCY || 4))),
    perVendorConcurrency: Math.max(1, Math.min(10, Number(env.ROUTER_AGENT_PER_VENDOR || 2))),
    routerTimeoutMs: Number(env.ROUTER_TIMEOUT_MS || 8000)
  };
}

export const AGENT_VERSION = "0.2";

export class Agent {
  constructor(cfg, { fetchImpl = fetch, sgp, credentials, manager, log = console } = {}) {
    this.cfg = cfg;
    this.fetch = fetchImpl;
    this.log = log;
    this.running = 0;
    this.stopped = false;
    const privateKey = manager ? null : createPrivateKey(readFileSync(cfg.privateKeyPath));
    const perVendor = new Map([["*", new Limiter(cfg.perVendorConcurrency)]]);
    for (const vendor of ["tplink", "huawei", "stavix", "mercusys"]) perVendor.set(vendor, new Limiter(cfg.perVendorConcurrency));
    this.manager =
      manager ??
      new RouterManager({
        sgp: sgp ?? new SgpClient(cfg.sgp, fetchImpl),
        credentials: credentials ?? new CredentialStore(cfg.credentialsPath, cfg.credentialsKey),
        endpoints: cfg.endpoints,
        cidrs: cfg.cidrs,
        dryRun: cfg.dryRun,
        perVendor,
        routerTimeoutMs: cfg.routerTimeoutMs,
        log,
        decrypt: (secretEnc) => privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(String(secretEnc), "base64"))
      });
  }

  async central(path, body) {
    const res = await this.fetch(`${this.cfg.centralUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw Object.assign(new Error(`Central respondeu ${res.status} em ${path}`), { status: res.status });
    return res.json();
  }

  /** Uma rodada: pega o que couber e processa. Devolve quantas tarefas pegou. */
  async tick() {
    const free = this.cfg.concurrency - this.running;
    if (free <= 0) return 0;
    // cada busca de tarefas e tambem o sinal de vida (a Central mostra "indisponivel agora" se ele sumir)
    const { jobs } = await this.central("/api/internal/router-agent/claim", { agentId: this.cfg.agentId, max: Math.min(free, 10), dryRun: this.cfg.dryRun, version: AGENT_VERSION });
    for (const job of jobs) {
      this.running++;
      this.process(job).finally(() => this.running--);
    }
    return jobs.length;
  }

  async process(job) {
    const started = Date.now();
    const FINAIS = ["completed", "failed", "unsupported", "unconfirmed"];
    const report = async (state, extra = {}) => {
      try {
        await this.central(`/api/internal/router-agent/jobs/${job.id}`, { agentId: this.cfg.agentId, state, ...extra });
      } catch (error) {
        // 409 num andamento = a Central ja encerrou este pedido (expirou, por exemplo): nao mexe mais no roteador
        if (error?.status === 409 && !FINAIS.includes(state)) throw Object.assign(new Error("pedido ja encerrado pela Central"), { code: "JOB_ABORTED" });
        this.log.warn?.(`[router-agent] relatorio ${job.id}: ${error.message}`);
      }
      if (FINAIS.includes(state)) {
        // Log sem senha, sem IP e sem credencial: so a tarefa, o tipo, o resultado e o tempo.
        this.log.info?.(`[router-agent] ${job.kind} ${job.id} -> ${state}${extra.errorCode ? ` (${extra.errorCode})` : ""} em ${Date.now() - started} ms`);
      }
    };
    try {
      if (job.kind === "status") await this.manager.status(job, report);
      else if (job.kind === "change_password") await this.manager.changePassword(job, report);
      else await report("failed", { errorCode: "INTERNAL" });
    } catch (error) {
      if (error?.code === "JOB_ABORTED") {
        this.log.warn?.(`[router-agent] ${job.kind} ${job.id}: ${error.message}; roteador nao foi tocado`);
        return;
      }
      this.log.error?.(`[router-agent] ${job.id}: ${error?.message ?? error}`);
      await report(job.kind === "change_password" ? "unconfirmed" : "failed", { errorCode: "INTERNAL" });
    }
  }

  async loop() {
    this.log.info?.(`[router-agent] ${this.cfg.agentId} no ar${this.cfg.dryRun ? " (modo seguro: so le o SGP, nao entra em roteador)" : ""}`);
    while (!this.stopped) {
      try {
        await this.tick();
      } catch (error) {
        this.log.warn?.(`[router-agent] ${error.message}`);
      }
      await new Promise((r) => setTimeout(r, this.cfg.pollMs));
    }
  }
}
