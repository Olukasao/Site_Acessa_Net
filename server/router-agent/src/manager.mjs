import { adapterFor } from "./adapters/registry.mjs";
import { routerHttp } from "./http.mjs";
import { ipAllowed, routerBaseUrl } from "./policy.mjs";

const VENDOR_LABEL = { tplink: "TP-Link", huawei: "Huawei", stavix: "Stavix", mercusys: "Mercusys" };
const KNOWN_CODES = new Set(["ROUTER_OFFLINE", "ROUTER_UNSUPPORTED", "ROUTER_REQUIRES_VALIDATION", "ROUTER_UNREACHABLE", "ROUTER_AUTH_FAILED", "ROUTER_NOT_IDENTIFIED", "SGP_UNAVAILABLE", "CONTRACT_NOT_FOUND", "VERIFY_FAILED", "INTERNAL"]);
const codeOf = (error) => (KNOWN_CODES.has(error?.code) ? error.code : "INTERNAL");

/** Limite de tarefas simultaneas (geral e por fabricante). */
export class Limiter {
  constructor(max) {
    this.max = max;
    this.running = 0;
    this.queue = [];
  }
  async run(fn) {
    if (this.running >= this.max) await new Promise((resolve) => this.queue.push(resolve));
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
  }

  /** Descobre o roteador do contrato. Devolve { outcome, ... } sem tocar no roteador. */
  async resolve(contractId) {
    const access = await this.d.sgp.verificaAcesso(contractId);
    if (!access || !access.serviceId) return { outcome: "not_found" };
    if (!access.online) return { outcome: "offline" };
    const conn = await this.d.sgp.connectionStatus(access.serviceId);
    if (!conn) throw Object.assign(new Error("status do SGP ilegivel"), { code: "SGP_UNAVAILABLE" });
    if (!conn.online) return { outcome: "offline" };
    if (!conn.ip) throw Object.assign(new Error("IP da sessao ilegivel"), { code: "SGP_UNAVAILABLE" });
    const eq = await this.d.sgp.equipmentType(access.serviceId);
    const vendor = eq.vendor;
    if (!vendor) return { outcome: "not_identified", conn };
    if (vendor === "customer_owned") return { outcome: "unsupported", vendor, conn };
    const adapter = adapterFor(vendor);
    if (!adapter) return { outcome: "unsupported", vendor, conn };
    // IP fora da faixa liberada: nao conectamos. Fabricante sem porta/protocolo configurado: ainda em validacao.
    if (!ipAllowed(conn.ip, this.d.cidrs)) return { outcome: "unreachable", vendor, conn, adapter };
    const baseUrl = routerBaseUrl(conn.ip, vendor, this.d.endpoints, this.d.cidrs);
    if (!baseUrl) return { outcome: "requires_validation", vendor, conn, adapter };
    return { outcome: "ok", vendor, conn, adapter, baseUrl };
  }

  statusResult(base, extra = {}) {
    return { online: false, vendor: null, model: null, firmware: null, management: "offline", bands: [], ssids: {}, canChangePassword: false, ...base, ...extra };
  }

  async status(job, report) {
    await report("connecting");
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
    if (r.outcome === "unsupported") return report("completed", { result: this.statusResult({ online: true, vendor: label, management: "unsupported" }) });
    if (r.outcome === "unreachable") return report("completed", { result: this.statusResult({ online: true, vendor: label, management: "unreachable" }) });
    if (r.outcome === "requires_validation" || r.adapter.support !== "supported" || this.d.dryRun) {
      return report("completed", { result: this.statusResult({ online: true, vendor: label, management: "requires_validation" }) });
    }
    return this.withRouter(r, async (ctx, session) => {
      const info = await r.adapter.getWifiInfo(ctx, session);
      const id = await r.adapter.identify(ctx);
      return report("completed", {
        result: this.statusResult({
          online: true,
          vendor: label,
          model: id.model ?? null,
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
    await report("connecting");
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
          await report("verifying");
          const verified = await r.adapter.verifyWifiConfiguration(ctx, session, { password: secret.toString("utf8"), bands: job.bands });
          return report("completed", { result: { bands: job.bands, verified: verified === true } });
        } catch (error) {
          // Depois de mandar a alteracao nao da para saber se o roteador aplicou: nao confirmado (e nunca repetimos sozinhos).
          if (applied || error?.code !== "ROUTER_UNREACHABLE") return report("unconfirmed", { errorCode: applied ? "VERIFY_FAILED" : codeOf(error) });
          return report("failed", { errorCode: "ROUTER_UNREACHABLE" });
        }
      }, report);
    } finally {
      secret.fill(0);
    }
  }

  /** Conecta, autentica, executa e sempre encerra a sessao do painel. Respeita o limite por fabricante. */
  async withRouter(r, fn, report) {
    const limiter = this.d.perVendor.get(r.vendor) ?? this.d.perVendor.get("*");
    return limiter.run(async () => {
      const credentials = this.d.credentials.get(r.vendor);
      if (!credentials) return report("unsupported", { errorCode: "ROUTER_REQUIRES_VALIDATION" });
      const ctx = { baseUrl: r.baseUrl, credentials, http: routerHttp(r.baseUrl, { timeoutMs: this.d.routerTimeoutMs }) };
      let session = null;
      try {
        await report("authenticating");
        try {
          session = await r.adapter.authenticate(ctx);
        } catch (error) {
          return report("failed", { errorCode: error?.code === "ROUTER_UNREACHABLE" ? "ROUTER_UNREACHABLE" : "ROUTER_AUTH_FAILED" });
        }
        return await fn(ctx, session);
      } finally {
        if (session) await r.adapter.closeSession(ctx, session).catch(() => undefined);
      }
    });
  }
}
