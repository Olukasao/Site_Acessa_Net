import { adapterFor, allAdapters } from "./adapters/registry.mjs";
import { checkPin, peekCertificate, routerHttp } from "./http.mjs";
import { timed, timingsStore } from "./timing.mjs";
import { ipAllowed, routerBaseUrl } from "./policy.mjs";

const PROBE_TTL_MS = 10 * 60_000;
const VENDOR_LABEL = { tplink: "TP-Link", huawei: "Huawei", stavix: "Stavix", mercusys: "Mercusys" };
const KNOWN_CODES = new Set(["ROUTER_OFFLINE", "ROUTER_UNSUPPORTED", "ROUTER_REQUIRES_VALIDATION", "ROUTER_UNREACHABLE", "ROUTER_AUTH_FAILED", "ROUTER_NOT_IDENTIFIED", "SGP_UNAVAILABLE", "CONTRACT_NOT_FOUND", "VERIFY_FAILED", "INTERNAL"]);
const codeOf = (error) => (KNOWN_CODES.has(error?.code) ? error.code : "INTERNAL");

/** Rejeita se a promessa nao terminar no prazo (o trabalho em si nao e cancelado: quem chamou segue em frente). */
export const withTimeout = (promise, ms, code = "INTERNAL", what = "operacao") =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(`${what}: tempo esgotado`), { code })), ms);
    promise.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e))
    );
  });

/** Limite de tarefas simultaneas (geral e por fabricante). Quem espera a vez por mais que `waitMs` desiste (nunca fica preso). */
export class Limiter {
  constructor(max) {
    this.max = max;
    this.running = 0;
    this.queue = [];
  }
  async run(fn, { waitMs = Infinity, code = "ROUTER_UNREACHABLE" } = {}) {
    if (this.running >= this.max) {
      await new Promise((resolve, reject) => {
        let timer;
        const entry = () => {
          clearTimeout(timer);
          resolve();
        };
        if (Number.isFinite(waitMs)) {
          timer = setTimeout(() => {
            const i = this.queue.indexOf(entry);
            if (i >= 0) this.queue.splice(i, 1);
            reject(Object.assign(new Error("fila do roteador ocupada"), { code }));
          }, waitMs);
        }
        this.queue.push(entry);
      });
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }
}

/**
 * Router Manager: do contrato ao roteador, sempre pelo SGP. Nenhum dado de destino vem da Central ou do cliente.
 * deps: { sgp, credentials, endpoints, cidrs, decrypt(secretEnc) -> Buffer, dryRun, perVendor: Map<string, Limiter>, log }
 */
export class RouterManager {
  constructor(deps) {
    this.d = deps;
    this.probeCache = new Map(); // ip|mac -> { vendor, model, at }
    this.ssidCache = new Map(); // contrato -> { '2.4GHz': nome, '5GHz': nome } (so nomes das redes, aprendidos na ultima leitura/troca)
  }

  /**
   * Um acesso por vez a cada roteador, em TUDO que toca nele (consultar certificado/pagina de login e a sessao do painel):
   * esses roteadores sao pequenos e travam se receberem conexoes ao mesmo tempo (a pagina de Wi-Fi nao carrega).
   */
  async underRouterLock(ip, fn) {
    this.perRouter ??= new Map();
    if (!this.perRouter.has(ip)) this.perRouter.set(ip, new Limiter(1));
    const lock = this.perRouter.get(ip);
    const pediu = performance.now();
    try {
      return await lock.run(
        async () => {
          const store = timingsStore.getStore();
          if (store) store.steps.set("router.espera_vez", (store.steps.get("router.espera_vez") ?? 0) + (performance.now() - pediu));
          return fn();
        },
        { waitMs: 120_000 }
      );
    } finally {
      if (lock.running === 0 && lock.queue.length === 0) this.perRouter.delete(ip);
    }
  }

  /** Descobre o roteador do contrato. Devolve { outcome, ... } sem tocar no roteador. */
  async resolve(contractId) {
    const access = await this.d.sgp.verificaAcesso(contractId);
    if (!access || !access.serviceId) return { outcome: "not_found" };
    if (!access.online) return { outcome: "offline" };
    // sessao PPPoE (sempre fresca) e tipo de equipamento (em cache) ao mesmo tempo
    const [conn, eq] = await Promise.all([this.d.sgp.connectionStatus(access.serviceId), this.d.sgp.equipmentType(access.serviceId)]);
    if (!conn) throw Object.assign(new Error("status do SGP ilegivel"), { code: "SGP_UNAVAILABLE" });
    if (!conn.online) return { outcome: "offline" };
    if (!conn.ip) throw Object.assign(new Error("IP da sessao ilegivel"), { code: "SGP_UNAVAILABLE" });
    if (eq.vendor === "customer_owned") return { outcome: "unsupported", vendor: eq.vendor, conn };
    // IP fora da faixa liberada: nao conectamos em nada
    if (!ipAllowed(conn.ip, this.d.cidrs)) return { outcome: "unreachable", vendor: eq.vendor, conn };
    // Tudo daqui em diante pode tocar no roteador (certificado e pagina de login): um acesso por vez
    return this.underRouterLock(conn.ip, () => timed("router.sondagem", async () => {
      // O que ja se sabe deste APARELHO (IP + MAC da sessao atual): evita consultar de novo o certificado e a pagina de login.
      // A chave inclui o MAC, entao um IP reaproveitado por outro cliente nunca herda o modelo do aparelho anterior.
      const chave = conn.mac ? `${conn.ip}|${conn.mac}` : null;
      const conhecido = chave ? this.probeCache.get(chave) : null;
      let vendor = eq.vendor;
      let model = null;
      let sondado = false;
      if (conhecido && Date.now() - conhecido.at < PROBE_TTL_MS && (!vendor || vendor === conhecido.vendor)) {
        vendor = vendor ?? conhecido.vendor;
        model = conhecido.model;
      } else if (!vendor) {
        // Sem "Tipo equipamento" no SGP: reconhece pelo proprio roteador (certificado conhecido + pagina de login, sem login)
        const achado = await this.detectVendor(conn.ip);
        vendor = achado?.vendor ?? null;
        model = achado?.model ?? null;
        sondado = true;
      }
      if (!vendor) return { outcome: "not_identified", conn };
      const adapter = adapterFor(vendor);
      if (!adapter) return { outcome: "unsupported", vendor, conn };
      const baseUrl = routerBaseUrl(conn.ip, vendor, this.d.endpoints, this.d.cidrs);
      // fabricante sem porta/protocolo configurado: ainda em validacao
      if (!baseUrl) return { outcome: "requires_validation", vendor, conn, adapter };
      const pins = this.d.endpoints[vendor]?.pins ?? [];
      if (adapter.support === "supported" && !model) {
        try {
          model = (await adapter.identify({ baseUrl, http: routerHttp(baseUrl, { timeoutMs: this.d.routerTimeoutMs, pins }) })).model;
          sondado = true;
        } catch (error) {
          if (error?.code === "ROUTER_CERT_UNKNOWN") return { outcome: "requires_validation", vendor, conn, adapter };
          throw error;
        }
      }
      if (sondado && chave && model) this.probeCache.set(chave, { vendor, model, at: Date.now() });
      // so o modelo validado em bancada e alterado; os outros do mesmo fabricante ficam "em validacao"
      if (adapter.support === "supported" && typeof adapter.supportsModel === "function" && !adapter.supportsModel(model)) return { outcome: "requires_validation", vendor, model, conn, adapter };
      return { outcome: "ok", vendor, model, conn, adapter, baseUrl, pins };
    }));
  }

  /** Reconhece o fabricante pelo certificado (pin) e pela pagina de login. Nunca tenta senha. */
  async detectVendor(ip) {
    for (const adapter of allAdapters()) {
      const ep = this.d.endpoints[adapter.vendor];
      if (adapter.support !== "supported" || !ep?.pins?.length) continue;
      const baseUrl = routerBaseUrl(ip, adapter.vendor, this.d.endpoints, this.d.cidrs);
      if (!baseUrl) continue;
      const pin = await checkPin(baseUrl, ep.pins, this.d.routerTimeoutMs);
      if (!pin.ok) continue;
      const id = await adapter.identify({ baseUrl, http: routerHttp(baseUrl, { timeoutMs: this.d.routerTimeoutMs, pins: ep.pins }) }).catch(() => null);
      if (id?.vendor === adapter.vendor) return { vendor: adapter.vendor, model: id.model ?? null };
    }
    return null;
  }

  /**
   * Inventario SO LEITURA de um contrato: fabricante e modelo, sem login e sem tentar senha.
   * Fabricante desconhecido guarda o dono/impressao do certificado (dado publico do aparelho) para descobrir novos modelos.
   */
  async inventoryOne(contractId) {
    const entry = (management, extra = {}) => ({ contractId: String(contractId), vendor: null, model: null, management, ...extra });
    const access = await this.d.sgp.verificaAcesso(contractId);
    if (!access?.serviceId) return null;
    if (!access.online) return entry("offline");
    const conn = await this.d.sgp.connectionStatus(access.serviceId);
    if (!conn) throw Object.assign(new Error("status do SGP ilegivel"), { code: "SGP_UNAVAILABLE" });
    if (!conn.online || !conn.ip) return entry("offline");
    const eq = await this.d.sgp.equipmentType(access.serviceId);
    if (eq.vendor === "customer_owned") return entry("unsupported", { vendor: "customer_owned" });
    if (!ipAllowed(conn.ip, this.d.cidrs)) return entry("unreachable", { vendor: eq.vendor });
    return this.underRouterLock(conn.ip, async () => {
    const detected = await this.detectVendor(conn.ip);
    const vendor = eq.vendor ?? detected?.vendor ?? null;
    if (vendor) {
      const adapter = adapterFor(vendor);
      const baseUrl = routerBaseUrl(conn.ip, vendor, this.d.endpoints, this.d.cidrs);
      const pins = this.d.endpoints[vendor]?.pins ?? [];
      if (adapter?.support === "supported" && baseUrl && pins.length) {
        const id = await adapter.identify({ baseUrl, http: routerHttp(baseUrl, { timeoutMs: this.d.routerTimeoutMs, pins }) }).catch(() => null);
        if (id?.model) return entry(adapter.supportsModel?.(id.model) === false ? "requires_validation" : "available", { vendor, model: id.model });
      }
      return entry(baseUrl ? "requires_validation" : "requires_validation", { vendor });
    }
    // fabricante nao reconhecido: anota o certificado para descobrir (e fixar) novos modelos
    const probe = Object.entries(this.d.endpoints).find(([, ep]) => ep.protocol === "https");
    const cert = probe ? await peekCertificate(`https://${conn.ip}:${probe[1].port}`, this.d.routerTimeoutMs) : null;
    return entry(cert?.ok ? "not_identified" : "unreachable", { certSubject: cert?.subject ?? null, certFp: cert?.fingerprint ?? null });
    });
  }

  statusResult(base, extra = {}) {
    return { online: false, vendor: null, model: null, firmware: null, management: "offline", bands: [], ssids: {}, canChangePassword: false, ...base, ...extra };
  }

  async status(job, report) {
    // (a Central ja marcou o pedido como "conectando" ao entregar a tarefa: nao precisa repetir)
    let r;
    try {
      r = await this.resolve(job.contractId);
    } catch (error) {
      return report("failed", { errorCode: codeOf(error) });
    }
    if (r.outcome === "not_found") return report("failed", { errorCode: "CONTRACT_NOT_FOUND" });
    if (r.outcome === "offline") return report("completed", { result: this.statusResult({}) });
    const label = VENDOR_LABEL[r.vendor] ?? null;
    if (r.outcome === "not_identified") return report("completed", { result: this.statusResult({ online: true, management: "not_identified" }) });
    if (r.outcome === "requires_validation") return report("completed", { result: this.statusResult({ online: true, vendor: label, model: r.model ?? null, management: "requires_validation" }) });
    if (r.outcome === "unsupported") return report("completed", { result: this.statusResult({ online: true, vendor: label, management: "unsupported" }) });
    if (r.outcome === "unreachable") return report("completed", { result: this.statusResult({ online: true, vendor: label, management: "unreachable" }) });
    if (r.outcome === "requires_validation" || r.adapter.support !== "supported" || this.d.dryRun) {
      return report("completed", { result: this.statusResult({ online: true, vendor: label, management: "requires_validation" }) });
    }
    // Leitura rapida (sem login no painel): modelo e redes vem do que ja foi validado para o modelo; os nomes das redes, do que ja
    // aprendemos neste contrato. Com ROUTER_STATUS_READ_SSID=1 volta a ler os nomes no proprio roteador (leva ~10 s a mais).
    const rapido = !this.d.statusReadsSsid && typeof r.adapter.quickStatus === "function" ? r.adapter.quickStatus(r.model) : null;
    if (rapido) {
      return report("completed", {
        result: this.statusResult({
          online: true,
          vendor: label,
          model: r.model ?? null,
          management: "available",
          bands: rapido.bands,
          ssids: this.ssidCache.get(job.contractId) ?? {},
          canChangePassword: true
        })
      });
    }
    return this.withRouter(r, async (ctx, session) => {
      const info = await r.adapter.getWifiInfo(ctx, session);
      if (info.ssids && Object.keys(info.ssids).length) this.ssidCache.set(job.contractId, info.ssids);
      if (!info.bands?.length) {
        // nao leu nenhuma rede: nunca diz "troca disponivel" sem saber quais redes existem
        this.d.log?.warn?.(`[router-agent] ${r.vendor}: nenhuma rede lida (${(info.errors ?? []).join("; ") || "sem detalhe"})`);
        return report("failed", { errorCode: "ROUTER_UNREACHABLE" });
      }
      const id = r.model ? { model: r.model, firmware: null } : await r.adapter.identify(ctx);
      return report("completed", {
        result: this.statusResult({
          online: true,
          vendor: label,
          model: r.model ?? id.model ?? null,
          firmware: id.firmware ?? null,
          management: "available",
          bands: info.bands ?? [],
          ssids: info.ssids ?? {},
          canChangePassword: true
        })
      });
    }, report);
  }

  async changePassword(job, report) {
    let r;
    try {
      r = await this.resolve(job.contractId);
    } catch (error) {
      return report("failed", { errorCode: codeOf(error) });
    }
    const stop = {
      not_found: ["failed", "CONTRACT_NOT_FOUND"],
      offline: ["failed", "ROUTER_OFFLINE"],
      not_identified: ["failed", "ROUTER_NOT_IDENTIFIED"],
      unsupported: ["unsupported", "ROUTER_UNSUPPORTED"],
      unreachable: ["failed", "ROUTER_UNREACHABLE"],
      requires_validation: ["unsupported", "ROUTER_REQUIRES_VALIDATION"]
    }[r.outcome];
    if (stop) return report(stop[0], { errorCode: stop[1] });
    if (r.adapter.support !== "supported" || this.d.dryRun) return report("unsupported", { errorCode: "ROUTER_REQUIRES_VALIDATION" });

    const secret = this.d.decrypt(job.secretEnc);
    try {
      return await this.withRouter(r, async (ctx, session) => {
        await report("updating");
        let applied = false;
        try {
          await r.adapter.changeWifiPassword(ctx, session, { password: secret.toString("utf8"), bands: job.bands });
          applied = true;
          if (session?.ssids && Object.keys(session.ssids).length) this.ssidCache.set(job.contractId, { ...(this.ssidCache.get(job.contractId) ?? {}), ...session.ssids });
          await report("verifying");
          const verified = await r.adapter.verifyWifiConfiguration(ctx, session, { password: secret.toString("utf8"), bands: job.bands });
          // accepted: o roteador aceitou e a rede continua igual (nao e prova de que a senha mudou; a Central mostra "nao confirmado")
          return report("completed", { result: { bands: job.bands, verified: verified === true, accepted: true, vendor: VENDOR_LABEL[r.vendor] ?? null, model: r.model ?? null } });
        } catch (error) {
          this.d.log?.warn?.(`[router-agent] troca ${r.vendor}: ${String(error?.message ?? error).slice(0, 160)}`);
          // Depois de mandar a alteracao nao da para saber se o roteador aplicou: nao confirmado (e nunca repetimos sozinhos).
          if (applied || error?.code !== "ROUTER_UNREACHABLE") return report("unconfirmed", { errorCode: applied ? "VERIFY_FAILED" : codeOf(error) });
          return report("failed", { errorCode: "ROUTER_UNREACHABLE" });
        }
      }, report);
    } finally {
      secret.fill(0);
    }
  }

  /** Conecta, autentica, executa e sempre encerra a sessao do painel. Tudo com prazo: nada fica preso. */
  async withRouter(r, fn, report) {
    const limiter = this.d.perVendor.get(r.vendor) ?? this.d.perVendor.get("*");
    const t0 = Date.now();
    const fase = (nome) => {
      const seg = Math.round((Date.now() - t0) / 1000);
      if (seg >= 20) this.d.log?.warn?.(`[router-agent] ${r.vendor}: ${nome} so terminou apos ${seg}s`);
    };
    const trabalho = () =>
      limiter.run(
        async () => {
          const credentials = this.d.credentials.get(r.vendor);
          if (!credentials) return report("unsupported", { errorCode: "ROUTER_REQUIRES_VALIDATION" });
          const ctx = { baseUrl: r.baseUrl, credentials, http: routerHttp(r.baseUrl, { timeoutMs: this.d.routerTimeoutMs, pins: r.pins ?? [] }) };
          let session = null;
          try {
            await report("authenticating");
            try {
              session = await withTimeout(r.adapter.authenticate(ctx), 70_000, "ROUTER_UNREACHABLE", "login");
            } catch (error) {
              this.d.log?.warn?.(`[router-agent] login ${r.vendor}: ${String(error?.message ?? error).slice(0, 160)}`);
              return report("failed", { errorCode: error?.code === "ROUTER_UNREACHABLE" ? "ROUTER_UNREACHABLE" : "ROUTER_AUTH_FAILED" });
            }
            fase("login");
            // teto para toda a operacao no roteador (duas redes levam cerca de 30 s)
            return await withTimeout(fn(ctx, session), 180_000, "INTERNAL", "operacao no roteador");
          } finally {
            // sair do painel nunca pode prender a vez do roteador: tem prazo e, se passar dele, o navegador e encerrado a forca
            if (session) {
              await withTimeout(r.adapter.closeSession(ctx, session), 25_000, "INTERNAL", "sair do painel").catch((error) =>
                this.d.log?.warn?.(`[router-agent] ${r.vendor}: ${String(error?.message ?? error).slice(0, 120)}`)
              );
            }
            fase("saida");
          }
        },
        { waitMs: 120_000 }
      );
    return this.underRouterLock(r.conn.ip, trabalho);
  }
}
