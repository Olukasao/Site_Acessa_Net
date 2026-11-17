import { BaseRouterAdapter } from "./base.mjs";
import { acquireBrowser, bound, closeContext, liveContexts, liveSessions } from "./huaweiOnt.mjs";
import { timed } from "../timing.mjs";

/**
 * Stavix (ONT/roteador com chip Realtek, painel "XPON HGU" por HTTP na porta 80, servidor Boa).
 * Validado em bancada: MP-G421R, firmware V2.0.3 (contrato 3005). O painel e o mesmo nos outros modelos Stavix (so muda a
 * descricao do modelo), entao qualquer Stavix reconhecido entra; se a tela de algum modelo for diferente, a troca falha com
 * seguranca (ROUTER_UNSUPPORTED/INTERNAL) e vira chamado.
 *
 * Como o painel funciona (levantado em bancada):
 *  - login: /admin/login.asp (usuario + senha; a pagina calcula um desafio md5 no proprio clique -> usamos o navegador, nunca reimplementamos);
 *  - so UMA sessao de administrador por vez, presa ao IP do cliente (nao ao cookie): "ERROR: you have logined!". O logout
 *    (POST /boaform/admin/formLogout) funciona sem cookie, entao tambem serve para liberar uma sessao esquecida;
 *  - Wi-Fi: wlan_idx 0 e 1 = uma radio cada (quem e 2.4 e quem e 5 GHz vem do campo "Band" da tela Basic, nao se presume);
 *    nome em wlbasic.asp (campo ssid), senha em wlwpa.asp (campo pskValue, WPA2-PSK, texto na pagina -> da para conferir de volta).
 * O painel NAO diz "Stavix" antes do login (a tela de login e generica de chip Realtek): por isso o reconhecimento sem SGP exige a
 * assinatura da pagina E o prefixo (OUI) do MAC da sessao PPPoE estar na lista de Stavix conhecidos (ROUTER_STAVIX_OUIS).
 */
const VALIDATED_MODELS = ["MP-G421R"];
const DEFAULT_OUIS = ["0cf0b4"];
const fail = (code, message) => Object.assign(new Error(message), { code });
const LOGOUT_BODY = "save=Logout&submit-url=%2Fadmin%2Flogin.asp";

/** A pagina de login e a do painel Realtek/Boa (formLogin com desafio)? Nao identifica a marca. */
export function isRealtekBoaLogin(html) {
  const text = String(html);
  return /\/boaform\/admin\/formLogin/i.test(text) && /name=["']?challenge/i.test(text);
}

/** "0c:f0:b4:7d:a4:ba" / "0CF0B47DA4BA" -> "0cf0b4" */
export function ouiOf(mac) {
  const hex = String(mac ?? "").replace(/[^0-9a-f]/gi, "").toLowerCase();
  return hex.length >= 6 ? hex.slice(0, 6) : null;
}

/** Texto da pagina de status (status.asp): modelo e firmware. */
export function parseStavixStatus(text) {
  const t = String(text).replace(/\s+/g, " ");
  const model = t.match(/Device Name\s+([A-Za-z0-9._-]{2,30})/)?.[1] ?? null;
  const firmware = t.match(/Firmware Version\s+([A-Za-z0-9._-]{1,30})/)?.[1] ?? null;
  return { model, firmware };
}

/** Faixa pelo campo "Band" da tela Basic (texto da opcao escolhida, ex.: "5 GHz (A+N+AC)", "2.4 GHz (B+G+N)"). */
export function bandOfLabel(label) {
  const t = String(label ?? "");
  if (/5\s*GHz/i.test(t)) return "5GHz";
  if (/2\.4\s*GHz/i.test(t)) return "2.4GHz";
  return null;
}

export class StavixRealtekAdapter extends BaseRouterAdapter {
  vendor = "stavix";
  support = "supported";
  validatedModels = VALIDATED_MODELS;
  missing = [];

  constructor({ browserPath, launch, ouis } = {}) {
    super();
    this.browserPath = browserPath ?? process.env.ROUTER_BROWSER_PATH;
    this.launch = launch; // so para testes
    const lista = ouis ?? String(process.env.ROUTER_STAVIX_OUIS ?? "").split(/[\s,;]+/).filter(Boolean);
    this.ouis = new Set([...DEFAULT_OUIS, ...lista].map((o) => ouiOf(o)).filter(Boolean));
  }

  /** Qualquer Stavix (mesmo painel; o modelo so aparece depois do login). */
  supportsModel() {
    return true;
  }
  capabilities() {
    return { support: this.support, canReadSsid: true, canReadPassword: false, canChangePassword: true, bands: ["2.4GHz", "5GHz"], missing: [], validatedModels: VALIDATED_MODELS };
  }

  /**
   * Sem login: confere a assinatura da pagina de login E o OUI do MAC (ctx.mac). Assinatura sem OUI conhecido = nao reconhece
   * (outras marcas usam a mesma tela; nunca tentamos a senha do Stavix em aparelho que nao e Stavix).
   */
  async identify(ctx) {
    const res = await timed("router.identificar", () => ctx.http.request("/admin/login.asp", { headers: { Accept: "text/html" } }));
    const html = res.status === 200 ? await res.text() : "";
    const sig = isRealtekBoaLogin(html);
    const oui = ouiOf(ctx.mac);
    const ok = sig && oui !== null && this.ouis.has(oui);
    return { vendor: ok ? "stavix" : null, model: null, firmware: null, confirmed: ok, signature: sig, oui };
  }

  async authenticate(ctx) {
    const { chromium } = await import("playwright-core");
    const browser = await timed("router.navegador", () => acquireBrowser(this.launch ?? ((o) => chromium.launch(o)), { headless: true, executablePath: this.browserPath }));
    let context = null;
    let loggedIn = false;
    try {
      context = await browser.newContext({ javaScriptEnabled: true, acceptDownloads: false, viewport: { width: 1280, height: 900 } });
      liveContexts.set(context, { browser, since: Date.now() });
      const origin = new URL(ctx.baseUrl).origin;
      await context.route("**/*", (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      const dialogs = [];
      page.on("dialog", async (d) => {
        dialogs.push(d.message().slice(0, 200));
        await d.accept().catch(() => undefined);
      });
      const session = { browser, context, page, origin, dialogs, frame: null, model: null, firmware: null, bandIdx: null };
      liveSessions.set(context, session);
      let entrou = false;
      await timed("router.login.enviar", async () => {
        for (let tentativa = 0; tentativa < 2 && !entrou; tentativa++) {
          await timed("router.login.pagina", () => page.goto(`${origin}/admin/login.asp`, { waitUntil: "domcontentloaded" }));
          if (!(await page.locator("input[name=username]").count())) throw fail("ROUTER_UNREACHABLE", "pagina de login nao abriu");
          await page.fill("input[name=username]", ctx.credentials.username ?? "");
          await page.fill("input[name=password]", ctx.credentials.password);
          await page.click("input[name=save]");
          entrou = await page.locator("iframe[name=contentIframe]").waitFor({ state: "attached", timeout: 15000 }).then(() => true, () => false);
          if (entrou) break;
          const texto = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
          if (/you have logined/i.test(texto) && tentativa === 0) {
            // sessao esquecida (outro painel aberto ou saida que falhou): o proprio logout do painel libera, sem cookie
            await this.#postLogout(context, origin);
            await page.waitForTimeout(1500);
            continue;
          }
          throw fail(/you have logined/i.test(texto) ? "ROUTER_UNREACHABLE" : "ROUTER_AUTH_FAILED", "login recusado");
        }
      });
      loggedIn = true;
      // a area de conteudo (iframe) aparece um instante depois do login
      for (let i = 0; i < 40 && !session.frame; i++) {
        session.frame = page.frame({ name: "contentIframe" });
        if (!session.frame) await page.waitForTimeout(250);
      }
      // o modelo e o firmware so aparecem depois do login (status.asp e a pagina inicial)
      await timed("router.status", async () => {
        const f = session.frame;
        if (!f) return;
        await f.waitForSelector("body", { timeout: 10000 }).catch(() => undefined);
        await page.waitForTimeout(800);
        const st = parseStavixStatus(await f.evaluate(() => document.body?.innerText ?? "").catch(() => ""));
        session.model = st.model;
        session.firmware = st.firmware;
      });
      if (!session.frame) throw fail("ROUTER_UNSUPPORTED", "painel sem a area de conteudo esperada");
      return session;
    } catch (error) {
      const sessao = context ? liveSessions.get(context) : null;
      if (sessao && loggedIn) await bound(this.#postLogout(context, sessao.origin), 8000);
      if (context) await closeContext(context);
      throw error;
    }
  }

  /** Abre uma tela de Wi-Fi da radio `idx` dentro da area de conteudo do painel. */
  async #open(session, asp, idx) {
    const { frame, origin } = session;
    await frame.goto(`${origin}/boaform/formWlanRedirect?redirect-url=/${asp}&wlan_idx=${idx}`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await frame.waitForSelector("form", { timeout: 15000 });
  }

  async #readBasic(session, idx) {
    await this.#open(session, "wlbasic.asp", idx);
    return session.frame.evaluate(() => ({
      ssid: document.querySelector("input[name=ssid]")?.value ?? "",
      off: Boolean(document.querySelector("input[name=wlanDisabled]")?.checked),
      bandLabel: (() => {
        const s = document.querySelector("select[name=band]");
        return s?.options?.[s.selectedIndex]?.text ?? "";
      })()
    }));
  }

  async #readSecurity(session, idx) {
    await this.#open(session, "wlwpa.asp", idx);
    return session.frame.evaluate(() => ({
      method: document.querySelector("select[name=security_method]")?.value ?? "",
      wpaAuth: document.querySelector("input[name=wpaAuth]:checked")?.value ?? "",
      pskFormat: document.querySelector("select[name=pskFormat]")?.value ?? "",
      psk: document.querySelector("input[name=pskValue]")?.value ?? ""
    }));
  }

  /** Descobre qual radio e 2.4 e qual e 5 GHz (uma vez por sessao). */
  async #bands(session) {
    if (session.bandIdx) return session.bandIdx;
    const map = {};
    const ssids = {};
    for (const idx of [0, 1]) {
      const b = await this.#readBasic(session, idx).catch(() => null);
      const band = bandOfLabel(b?.bandLabel);
      if (band && b.ssid) {
        map[band] = idx;
        ssids[band] = b.ssid.slice(0, 32);
      }
    }
    session.bandIdx = map;
    session.ssids = ssids;
    return map;
  }

  async getWifiInfo(_ctx, session) {
    const errors = [];
    const map = await this.#bands(session);
    const bands = ["2.4GHz", "5GHz"].filter((b) => map[b] !== undefined);
    if (!bands.length) errors.push("nenhuma radio com nome lida");
    return { bands, ssids: { ...session.ssids }, errors, model: session.model, firmware: session.firmware };
  }

  async changeWifiPassword(ctx, session, input) {
    return this.changeWifiSettings(ctx, session, { password: input.password, bands: input.bands });
  }

  async changeWifiSettings(_ctx, session, input) {
    const { page, frame } = session;
    const names = input.names ?? null;
    const map = await this.#bands(session);
    session.verified = false;
    const plan = [];
    for (const band of input.bands) {
      const idx = map[band];
      if (idx === undefined) throw fail("ROUTER_UNSUPPORTED", `rede ${band} nao encontrada`);
      if (input.password) {
        const sec = await this.#readSecurity(session, idx);
        if (!["4", "6"].includes(sec.method) || sec.wpaAuth !== "psk") throw fail("ROUTER_UNSUPPORTED", `rede ${band} nao usa senha WPA2`);
        if (sec.pskFormat !== "0") throw fail("ROUTER_UNSUPPORTED", `rede ${band} usa chave em hexadecimal`);
      }
      plan.push({ band, idx });
    }
    const save = async (what) => {
      const dialogsBefore = session.dialogs.length;
      await Promise.all([frame.waitForNavigation({ timeout: 15000, waitUntil: "domcontentloaded" }).catch(() => null), frame.click("input[name=save]")]);
      // salvar aplica o Wi-Fi: o roteador fica alguns segundos sem responder
      await page.waitForTimeout(4000);
      if (session.dialogs.length > dialogsBefore) throw fail("INTERNAL", `o painel mostrou um aviso ao salvar ${what}`);
    };
    await timed("router.aplicar", async () => {
      for (const { band, idx } of plan) {
        if (names?.[band]) {
          await this.#open(session, "wlbasic.asp", idx);
          await frame.fill("input[name=ssid]", names[band]);
          await save(`o nome (${band})`);
        }
        if (input.password) {
          await this.#open(session, "wlwpa.asp", idx);
          await frame.fill("input[name=pskValue]", input.password);
          await save(`a senha (${band})`);
        }
      }
    });
    // confere de volta (o painel mostra nome e senha em texto): so vale se TUDO bateu
    const esperado = (band) => ({ ssid: names?.[band] ?? session.ssids?.[band] });
    let ok = false;
    for (let tentativa = 0; tentativa < 6 && !ok; tentativa++) {
      try {
        ok = true;
        for (const { band, idx } of plan) {
          if (names?.[band]) {
            const b = await this.#readBasic(session, idx);
            if (b.ssid !== esperado(band).ssid) ok = false;
          }
          if (input.password) {
            const s = await this.#readSecurity(session, idx);
            if (s.psk !== input.password) ok = false;
          }
        }
      } catch {
        ok = false;
      }
      if (!ok) await page.waitForTimeout(3000);
    }
    if (!ok) throw fail("INTERNAL", "o roteador nao guardou a alteracao");
    for (const { band } of plan) if (names?.[band]) session.ssids[band] = names[band].slice(0, 32);
    session.verified = true;
    return { verified: true };
  }

  /** O painel mostra a senha gravada: se a releitura bateu, esta confirmado de verdade. */
  async verifyWifiConfiguration(_ctx, session) {
    return session?.verified === true;
  }

  async closeSession(_ctx, session) {
    return timed("router.sair", async () => {
      let ativa = true;
      try {
        for (let tentativa = 0; tentativa < 2 && ativa !== false; tentativa++) {
          await bound(this.#postLogout(session.context, session.origin), 10_000);
          ativa = await this.#stillActive(session);
        }
      } finally {
        await closeContext(session.context);
      }
      if (ativa === true) throw fail("INTERNAL", "a sessao do painel pode ter ficado aberta");
    });
  }

  /** Logout do painel (nao depende de cookie: a sessao e presa ao IP). */
  async #postLogout(context, origin) {
    try {
      const res = await context.request.post(`${origin}/boaform/admin/formLogout`, { data: LOGOUT_BODY, headers: { "content-type": "application/x-www-form-urlencoded" }, timeout: 8000 });
      return res.ok();
    } catch {
      return false;
    }
  }

  /** A sessao ainda vale? Abre a pagina de status: se mostrar "Device Status", ainda esta logado. true = aberta, false = fechada, null = nao deu para saber. */
  async #stillActive(session) {
    try {
      const res = await session.context.request.get(`${session.origin}/status.asp`, { timeout: 8000, maxRedirects: 0 });
      const texto = await res.text();
      if (/Device Status/i.test(texto)) return true;
      return res.status() >= 300 || /login|logined|password/i.test(texto) ? false : null;
    } catch {
      return null;
    }
  }
}
