import { parseConnectionStatus, parseEquipmentType } from "./parse.mjs";

/**
 * SGP, so leitura:
 *  - API oficial (URA, Basic): POST /api/ura/verificaacesso/ -> online/offline, servico_id e login do CONTRATO pedido.
 *  - Painel web (sessao do Django, mesmo login do chat interno): IP/MAC da sessao PPPoE e o "Tipo equipamento".
 * O numero do servico vem SEMPRE da API oficial para o contrato pedido (nunca de busca por texto no painel),
 * para nao pegar o roteador de outro cliente.
 */
export class SgpClient {
  constructor(cfg, fetchImpl = fetch) {
    this.cfg = cfg;
    this.fetch = fetchImpl;
    this.cookies = new Map();
    this.sessionUntil = 0;
    this.loggingIn = null;
  }

  async verificaAcesso(contractId) {
    const body = new FormData();
    body.append("contrato", String(contractId));
    const res = await this.fetch(`${this.cfg.uraBaseUrl}/api/ura/verificaacesso/`, {
      method: "POST",
      headers: { Authorization: "Basic " + Buffer.from(`${this.cfg.uraUsername}:${this.cfg.uraPassword}`).toString("base64"), Accept: "application/json" },
      body,
      signal: AbortSignal.timeout(this.cfg.timeoutMs)
    });
    if (!res.ok) throw sgpError(`verificaacesso HTTP ${res.status}`);
    const data = await res.json().catch(() => null);
    if (!data || String(data.contratoId ?? "") !== String(contractId)) return null; // outro contrato ou nao achou
    const serviceId = /^\d{1,12}$/.test(String(data.servico_id ?? "")) ? String(data.servico_id) : null;
    return { online: Number(data.status) === 1, serviceId, login: typeof data.login === "string" ? data.login : null };
  }

  async connectionStatus(serviceId) {
    return parseConnectionStatus(await this.webGet(`/admin/servicos/internet/${serviceId}/infodetail/?statusonly=1`));
  }

  async equipmentType(serviceId) {
    return parseEquipmentType(await this.webGet(`/admin/servicos/internet/${serviceId}/`));
  }

  // ---------- sessao do painel ----------
  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  keepCookies(res) {
    const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie")].filter(Boolean);
    for (const c of list) {
      const pair = String(c).split(";")[0];
      const i = pair.indexOf("=");
      if (i > 0) this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
  }
  async raw(path, init = {}) {
    const res = await this.fetch(`${this.cfg.webBaseUrl}${path}`, {
      ...init,
      redirect: "manual",
      headers: { ...(this.cookies.size ? { Cookie: this.cookieHeader() } : {}), ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(this.cfg.timeoutMs)
    });
    this.keepCookies(res);
    return res;
  }
  async login() {
    this.cookies.clear();
    const page = await this.raw("/accounts/login/?next=/admin/");
    const html = await page.text();
    const csrf = html.match(/name=['"]csrfmiddlewaretoken['"]\s+value=['"]([^'"]+)/i)?.[1] || this.cookies.get("csrftoken");
    if (!csrf) throw sgpError("sem CSRF no login do SGP");
    const form = new URLSearchParams({ csrfmiddlewaretoken: csrf, username: this.cfg.webUsername, password: this.cfg.webPassword, next: "/admin/" });
    await this.raw("/accounts/login/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: this.cfg.webBaseUrl, Referer: `${this.cfg.webBaseUrl}/accounts/login/?next=/admin/` },
      body: form.toString()
    });
    if (!this.cookies.has("sessionid")) throw sgpError("login do painel do SGP recusado");
    this.sessionUntil = Date.now() + 15 * 60_000;
  }
  async ensureSession() {
    if (this.cookies.has("sessionid") && Date.now() < this.sessionUntil) return;
    this.loggingIn ??= this.login().finally(() => (this.loggingIn = null));
    await this.loggingIn;
  }
  async webGet(path, retry = true) {
    await this.ensureSession();
    const res = await this.raw(path, { headers: { Accept: "text/html", "X-Requested-With": "XMLHttpRequest" } });
    const loginRedirect = [301, 302, 303, 307, 308].includes(res.status) && String(res.headers.get("location") ?? "").includes("/accounts/login");
    const text = loginRedirect ? "" : await res.text();
    if (retry && (loginRedirect || /id_username|login-form/i.test(text))) {
      this.sessionUntil = 0;
      return this.webGet(path, false);
    }
    if (!res.ok) throw sgpError(`painel do SGP HTTP ${res.status}`);
    return text;
  }
}

function sgpError(message) {
  const e = new Error(message);
  e.code = "SGP_UNAVAILABLE";
  return e;
}
