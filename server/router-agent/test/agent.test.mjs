import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { parseConnectionStatus, parseEquipmentType } from "../src/parse.mjs";
import { ipAllowed, parseCidr, routerBaseUrl, sameOrigin } from "../src/policy.mjs";
import { CredentialStore } from "../src/credentials.mjs";
import { Limiter, RouterManager } from "../src/manager.mjs";
import { BaseRouterAdapter } from "../src/adapters/base.mjs";
import { registerAdapter, adapterFor } from "../src/adapters/registry.mjs";
import { routerHttp } from "../src/http.mjs";

const ONLINE_HTML = `<h1 style="color: #6fc46f;"> Online </h1>
 Detalhes: <br/><br/>
 Tempo: 2 days, 7:01:02 <br/>
 Port Type: Ethernet <br/>
 IP: <a href="http://100.64.10.20" target="_blank"> 100.64.10.20 </a> <br/>
 MAC: AA:BB:CC:00:11:22 <br/>
 Protocolo: PPP <br/>
 NAS: 10.0.0.1 <br/>`;

test("lê o status da sessão PPPoE do painel do SGP", () => {
  assert.deepEqual(parseConnectionStatus(ONLINE_HTML), { online: true, ip: "100.64.10.20", mac: "aa:bb:cc:00:11:22", nas: "10.0.0.1", uptime: "2 days, 7:01:02" });
  assert.deepEqual(parseConnectionStatus("<h1> Offline </h1>"), { online: false, ip: null, mac: null, nas: null, uptime: null });
  assert.equal(parseConnectionStatus("<html>pagina de login</html>"), null); // layout mudou: nada de chute
  assert.equal(parseConnectionStatus(ONLINE_HTML.replace("100.64.10.20 </a>", "999.1.1.1 </a>")).ip, null);
});

test("lê o fabricante pelo Tipo equipamento", () => {
  const sel = (label) => `<select name="servicoi-tipo_equipamento"><option value="">---------</option><option value="3" selected>${label}</option></select>`;
  assert.equal(parseEquipmentType(sel("Fibra - ROTEADOR - TP LINK")).vendor, "tplink");
  assert.equal(parseEquipmentType(sel("Fibra - ROTEADOR - HUAWEI")).vendor, "huawei");
  assert.equal(parseEquipmentType(sel("Fibra - PARTICULAR")).vendor, "customer_owned");
  assert.equal(parseEquipmentType(`<select name="servicoi-tipo_equipamento"><option selected>---------</option></select>`).vendor, null);
  assert.equal(parseEquipmentType("<html></html>").found, false);
});

test("destino: só IP do SGP dentro da faixa liberada e porta configurada do fabricante", () => {
  const cidrs = [parseCidr("100.64.0.0/10")];
  assert.equal(ipAllowed("100.64.0.1", cidrs), true);
  assert.equal(ipAllowed("100.127.255.254", cidrs), true);
  assert.equal(ipAllowed("100.128.0.1", cidrs), false);
  assert.equal(ipAllowed("192.168.0.1", cidrs), false);
  assert.equal(ipAllowed("169.254.169.254", cidrs), false);
  assert.equal(ipAllowed("100.64.0.1:8080", cidrs), false);
  const endpoints = { tplink: { protocol: "http", port: 80 } };
  assert.equal(routerBaseUrl("100.64.1.2", "tplink", endpoints, cidrs), "http://100.64.1.2:80");
  assert.equal(routerBaseUrl("100.64.1.2", "huawei", endpoints, cidrs), null); // sem configuração: não conecta
  assert.equal(routerBaseUrl("8.8.8.8", "tplink", endpoints, cidrs), null);
  assert.throws(() => parseCidr("0.0.0.0/0"));
  assert.equal(sameOrigin("http://100.64.1.2:80/x", "http://100.64.1.2:80"), true);
  assert.equal(sameOrigin("http://evil.com/x", "http://100.64.1.2:80"), false);
  assert.equal(sameOrigin("http://user:pw@100.64.1.2:80/", "http://100.64.1.2:80"), false);
});

test("cliente HTTP do roteador recusa outro destino e não segue redirecionamento", async () => {
  const calls = [];
  const http = routerHttp("http://100.64.1.2:80", { fetchImpl: async (url, init) => (calls.push([url, init.redirect]), new Response("ok")) });
  await http.request("/login.htm");
  assert.deepEqual(calls[0], ["http://100.64.1.2/login.htm", "manual"]);
  await assert.rejects(http.request("http://evil.com/"), /fora do roteador/);
  await assert.rejects(http.request("//evil.com/x"), /fora do roteador/);
});

test("cofre de credenciais: cifrado, arquivo 600, chave errada não abre", () => {
  const dir = mkdtempSync(join(tmpdir(), "cofre-"));
  const key = randomBytes(32).toString("hex");
  const store = new CredentialStore(join(dir, "c.json"), key);
  store.set("tplink", { username: "", password: "segredo-1" });
  store.set("huawei", { username: "adm", password: "segredo-2" });
  assert.deepEqual(store.get("tplink"), { username: null, password: "segredo-1" });
  assert.deepEqual(store.get("huawei", "HG8145"), { username: "adm", password: "segredo-2" });
  assert.equal(store.get("stavix"), null);
  assert.equal(statSync(join(dir, "c.json")).mode & 0o777, 0o600);
  assert.throws(() => new CredentialStore(join(dir, "c.json"), randomBytes(32).toString("hex")).get("tplink"));
});

// ---------- Router Manager com SGP e roteador falsos ----------
const fakeSgp = (over = {}) => ({
  verificaAcesso: async (c) => (c === "1001" ? { online: true, serviceId: "77", login: "x" } : null),
  connectionStatus: async () => ({ online: true, ip: "100.64.10.20", mac: "aa:bb:cc:00:11:22", nas: "10.0.0.1", uptime: "1d" }),
  equipmentType: async () => ({ found: true, label: "Fibra - ROTEADOR - TP LINK", vendor: "tplink" }),
  ...over
});
function managerWith(over = {}) {
  return new RouterManager({
    sgp: fakeSgp(over.sgp),
    credentials: { get: (v) => (v === "fake" || v === "tplink" ? { username: null, password: "adm" } : null) },
    endpoints: { tplink: { protocol: "http", port: 80 }, fake: { protocol: "http", port: 80 } },
    cidrs: [parseCidr("100.64.0.0/10")],
    dryRun: over.dryRun ?? false,
    perVendor: new Map([["*", new Limiter(2)]]),
    decrypt: () => Buffer.from("Casa-Nova#2026"),
    routerTimeoutMs: 1000
  });
}
const recorder = () => {
  const states = [];
  const report = async (state, extra = {}) => void states.push({ state, ...extra });
  return { states, report };
};

test("modelo não validado: lê o SGP, não entra no roteador e responde 'em validação'", async () => {
  const { states, report } = recorder();
  await managerWith().status({ contractId: "1001", kind: "status" }, report);
  assert.equal(states.at(-1).state, "completed");
  assert.equal(states.at(-1).result.management, "requires_validation");
  assert.equal(states.at(-1).result.vendor, "TP-Link");
  const ch = recorder();
  await managerWith().changePassword({ contractId: "1001", kind: "change_password", bands: ["5GHz"], secretEnc: "x" }, ch.report);
  assert.deepEqual(ch.states.at(-1), { state: "unsupported", errorCode: "ROUTER_REQUIRES_VALIDATION" });
});

test("offline, contrato não achado, sem fabricante e roteador do cliente", async () => {
  const cases = [
    [{ verificaAcesso: async () => ({ online: false, serviceId: "77" }) }, "failed", "ROUTER_OFFLINE"],
    [{ verificaAcesso: async () => null }, "failed", "CONTRACT_NOT_FOUND"],
    [{ equipmentType: async () => ({ found: true, label: null, vendor: null }) }, "failed", "ROUTER_NOT_IDENTIFIED"],
    [{ equipmentType: async () => ({ found: true, label: "PARTICULAR", vendor: "customer_owned" }) }, "unsupported", "ROUTER_UNSUPPORTED"],
    [{ connectionStatus: async () => ({ online: true, ip: "192.168.0.10" }) }, "failed", "ROUTER_UNREACHABLE"],
    [{ connectionStatus: async () => null }, "failed", "SGP_UNAVAILABLE"]
  ];
  for (const [sgp, state, errorCode] of cases) {
    const { states, report } = recorder();
    await managerWith({ sgp }).changePassword({ contractId: "1001", kind: "change_password", bands: ["5GHz"], secretEnc: "x" }, report);
    assert.deepEqual(states.at(-1), { state, errorCode }, JSON.stringify(sgp));
  }
});

class FakeAdapter extends BaseRouterAdapter {
  vendor = "fake";
  support = "supported";
  constructor(behavior = {}) {
    super();
    this.b = behavior;
    this.closed = 0;
    this.changed = null;
  }
  async authenticate(ctx) {
    if (this.b.authFail) throw new Error("401");
    assert.equal(ctx.baseUrl, "http://100.64.10.20:80");
    return { token: "s" };
  }
  async getWifiInfo() {
    return { bands: ["2.4GHz", "5GHz"], ssids: { "2.4GHz": "Casa", "5GHz": "Casa_5G" } };
  }
  async changeWifiPassword(_c, _s, input) {
    if (this.b.changeFail) throw Object.assign(new Error("timeout"), { code: this.b.changeFail });
    this.changed = input;
  }
  async verifyWifiConfiguration() {
    return this.b.verified ?? true;
  }
  async closeSession() {
    this.closed++;
  }
}
const fakeVendor = { equipmentType: async () => ({ found: true, label: "fake", vendor: "fake" }) };

test("modelo validado: autentica, troca, verifica e sempre fecha a sessão", async () => {
  const adapter = new FakeAdapter();
  registerAdapter(adapter);
  const { states, report } = recorder();
  await managerWith({ sgp: fakeVendor }).changePassword({ contractId: "1001", kind: "change_password", bands: ["2.4GHz", "5GHz"], secretEnc: "x" }, report);
  assert.deepEqual(states.map((s) => s.state), ["connecting", "authenticating", "updating", "verifying", "completed"]);
  assert.deepEqual(states.at(-1).result, { bands: ["2.4GHz", "5GHz"], verified: true });
  assert.deepEqual(adapter.changed, { password: "Casa-Nova#2026", bands: ["2.4GHz", "5GHz"] });
  assert.equal(adapter.closed, 1);
  assert.equal(adapterFor("fake"), adapter);
});

test("sem verificação = não confirmado; falha de login = falha; erro no meio = não confirmado", async () => {
  const run = async (behavior) => {
    registerAdapter(new FakeAdapter(behavior));
    const { states, report } = recorder();
    await managerWith({ sgp: fakeVendor }).changePassword({ contractId: "1001", kind: "change_password", bands: ["5GHz"], secretEnc: "x" }, report);
    return states.at(-1);
  };
  assert.deepEqual((await run({ verified: false })).result, { bands: ["5GHz"], verified: false }); // a Central transforma em "nao confirmado"
  assert.deepEqual(await run({ authFail: true }), { state: "failed", errorCode: "ROUTER_AUTH_FAILED" });
  assert.deepEqual(await run({ changeFail: "INTERNAL" }), { state: "unconfirmed", errorCode: "INTERNAL" });
  assert.deepEqual(await run({ changeFail: "ROUTER_UNREACHABLE" }), { state: "failed", errorCode: "ROUTER_UNREACHABLE" });
});

test("modo seguro (padrão): mesmo modelo validado não entra no roteador", async () => {
  registerAdapter(new FakeAdapter());
  const { states, report } = recorder();
  await managerWith({ sgp: fakeVendor, dryRun: true }).changePassword({ contractId: "1001", kind: "change_password", bands: ["5GHz"], secretEnc: "x" }, report);
  assert.deepEqual(states.at(-1), { state: "unsupported", errorCode: "ROUTER_REQUIRES_VALIDATION" });
});

test("limite de simultâneas", async () => {
  const lim = new Limiter(2);
  let now = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 6 }, () => lim.run(async () => { now++; peak = Math.max(peak, now); await new Promise((r) => setTimeout(r, 10)); now--; })));
  assert.equal(peak, 2);
});
