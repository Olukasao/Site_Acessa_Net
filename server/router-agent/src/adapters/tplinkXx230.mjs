import { BaseRouterAdapter } from "./base.mjs";
import { acquireBrowser, bound, closeContext, liveContexts, liveSessions } from "./huaweiOnt.mjs";
import { safeError } from "../safe.mjs";
import { timed } from "../timing.mjs";

/**
 * TP-Link XX230v (AX1800 GPON, firmware 0.12.0), painel por HTTP na porta 80.
 * O painel cifra todas as chamadas no navegador (AES + assinatura), entao NAO reimplementamos o protocolo: o navegador do agente usa a
 * propria pagina (login, Basico > Wi-Fi, Salvar), como uma pessoa faria.
 *
 * Com o Band Steering ligado (o padrao) o roteador tem UMA rede so, com um nome e uma senha para 2.4 e 5 GHz. Nesse modo:
 *  - a senha troca as duas bandas de uma vez;
 *  - o nome e o da rede unica (sem sufixo 2.4/5G, porque nao existem duas redes).
 * Com o Band Steering desligado a tela e outra: nao e alterada (vira chamado), para nao mexer na rede do cliente sem validacao.
 * Esta TP-Link mostra senha e nome em texto na pagina, entao a troca e conferida lendo de volta (verificada de verdade).
 */
const VALIDATED_MODELS = ["XX230v"];
const MODEL_BANDS = { XX230v: ["2.4GHz", "5GHz"] };
const fail = (code, message) => Object.assign(new Error(message), { code });
const SSID_FIELD = "#ssid_bs";
const PSK_FIELD = "#wpa2PersonalPwd_bs";

export function parseTplinkModel(html) {
  return String(html).match(/modelName\s*=\s*"([A-Za-z0-9._-]{1,30})"/)?.[1] ?? null;
}

/** Nome da rede unica: o nome-base que o cliente digitou (tira o sufixo " 2.4"/" 5G" que a Central acrescenta). */
export function singleNetworkName(names) {
  const raw = names?.["2.4GHz"] ?? names?.["5GHz"] ?? "";
  return raw.replace(/ (2\.4|5G)$/, "").slice(0, 32);
}

export class TplinkXx230Adapter extends BaseRouterAdapter {
  vendor = "tplink";
  support = "supported";
  validatedModels = VALIDATED_MODELS;
  missing = [];

  constructor({ browserPath, launch } = {}) {
    super();
    this.browserPath = browserPath ?? process.env.ROUTER_BROWSER_PATH;
    this.launch = launch; // so para testes
  }

  /** Qualquer TP-Link reconhecido pela pagina de login: se a tela de Wi-Fi for diferente, a troca falha com seguranca (vira chamado). */
  supportsModel(model) {
    return Boolean(model);
  }
  quickStatus(model) {
    const bands = MODEL_BANDS[String(model ?? "")];
    return bands ? { bands: [...bands] } : null;
  }
  capabilities() {
    return { support: this.support, canReadSsid: true, canReadPassword: false, canChangePassword: true, bands: ["2.4GHz", "5GHz"], missing: [], validatedModels: VALIDATED_MODELS };
  }

  /** Pagina de login (sem login): o modelo vem no proprio HTML. */
  async identify(ctx) {
    const res = await timed("router.identificar", () => ctx.http.request("/", { headers: { Accept: "text/html" } }));
    const html = res.status === 200 ? await res.text() : "";
    const model = /tp-link/i.test(html) ? parseTplinkModel(html) : null;
    return { vendor: model ? "tplink" : null, model, firmware: null, confirmed: Boolean(model) };
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
      const session = { browser, context, page, origin, dialogs, logout: (abrirInicio) => this.#logout(session, abrirInicio) };
      liveSessions.set(context, session);
      await timed("router.login.pagina", () => page.goto(`${origin}/`, { waitUntil: "domcontentloaded" }));
      await page.fill("#pc-login-password", ctx.credentials.password);
      await timed("router.login.enviar", async () => {
        await page.click("#pc-login-btn");
        // "So um aparelho entra por vez": confirma para entrar (derruba a sessao de quem estava no painel)
        const entrou = page.locator("#topLogout").waitFor({ state: "visible", timeout: 12000 }).then(() => true, () => false);
        const aviso = page.locator("#confirm-yes").waitFor({ state: "visible", timeout: 6000 }).then(() => true, () => false);
        if (!(await Promise.race([entrou, aviso]))) {
          // nem entrou nem pediu confirmacao
        }
        if (await page.locator("#confirm-yes").isVisible().catch(() => false)) await page.locator("#confirm-yes").click();
        if (!(await page.locator("#topLogout").waitFor({ state: "visible", timeout: 15000 }).then(() => true, () => false))) {
          throw fail("ROUTER_AUTH_FAILED", "login recusado");
        }
      });
      loggedIn = true;
      await this.#openWifi(session);
      return session;
    } catch (error) {
      const sessao = context ? liveSessions.get(context) : null;
      if (sessao && loggedIn) await bound(this.#logout(sessao, true), 10_000);
      if (context) await closeContext(context);
      throw error;
    }
  }

  /** Basico > Wi-Fi. So existe o formulario de rede unica com o Band Steering ligado. */
  async #openWifi(session) {
    const { page } = session;
    await page.click("#basic");
    await page.locator("#wireless").waitFor({ state: "visible" });
    await page.click("#wireless");
    const achou = await page.locator(SSID_FIELD).waitFor({ state: "visible", timeout: 15000 }).then(() => true, () => false);
    if (!achou) throw fail("ROUTER_UNSUPPORTED", "tela de Wi-Fi diferente (Band Steering desligado?)");
    // os campos chegam vazios e sao preenchidos pelo painel: espera o nome aparecer
    await page.waitForFunction((sel) => document.querySelector(sel)?.value, SSID_FIELD, { timeout: 15000 }).catch(() => undefined);
  }

  async #read(session) {
    const { page } = session;
    return page.evaluate(([s, p]) => ({ ssid: document.querySelector(s)?.value ?? "", psk: document.querySelector(p)?.value ?? "" }), [SSID_FIELD, PSK_FIELD]);
  }

  async getWifiInfo(_ctx, session) {
    const { ssid } = await this.#read(session);
    if (!ssid) return { bands: [], ssids: {}, errors: ["pagina sem SSID"] };
    return { bands: ["2.4GHz", "5GHz"], ssids: { "2.4GHz": ssid.slice(0, 32), "5GHz": ssid.slice(0, 32) }, errors: [] };
  }

  async changeWifiPassword(ctx, session, input) {
    return this.changeWifiSettings(ctx, session, { password: input.password, bands: input.bands });
  }

  async changeWifiSettings(_ctx, session, input) {
    const { page } = session;
    const names = input.names ?? null;
    const novoNome = names ? singleNetworkName(names) : null;
    if (names && !novoNome) throw fail("ROUTER_UNSUPPORTED", "nome vazio");
    const antes = await this.#read(session);
    if (!antes.ssid) throw fail("ROUTER_UNSUPPORTED", "rede nao encontrada");
    await timed("router.aplicar", async () => {
      if (input.password) {
        await page.fill(PSK_FIELD, input.password);
        await page.dispatchEvent(PSK_FIELD, "input");
      }
      if (novoNome) {
        await page.fill(SSID_FIELD, novoNome);
        await page.dispatchEvent(SSID_FIELD, "input");
      }
      await page.click("#save_bs");
      // salvar aplica o Wi-Fi: o painel segura a tela alguns segundos
      await page.waitForTimeout(6000);
    });
    // confere de volta: reabre a tela e le o que o roteador guardou
    const esperado = { ssid: novoNome ?? antes.ssid, psk: input.password ?? antes.psk };
    let depois = null;
    for (let tentativa = 0; tentativa < 6; tentativa++) {
      try {
        await this.#openWifi(session);
        depois = await this.#read(session);
        if (depois.ssid === esperado.ssid && depois.psk === esperado.psk) break;
      } catch (error) {
        if (error?.code === "ROUTER_UNSUPPORTED") throw error;
      }
      await page.waitForTimeout(3000);
    }
    if (!depois || depois.ssid !== esperado.ssid || depois.psk !== esperado.psk) throw fail("INTERNAL", "o roteador nao guardou a alteracao");
    return { verified: Boolean(names) && !input.password };
  }

  async verifyWifiConfiguration() {
    return false;
  }

  async closeSession(_ctx, session) {
    return timed("router.sair", async () => {
      let ativa = true;
      try {
        for (let tentativa = 0; tentativa < 2 && ativa !== false; tentativa++) {
          await bound(this.#logout(session, tentativa === 1), 10_000);
          ativa = await this.#stillActive(session);
        }
      } finally {
        await closeContext(session.context);
      }
      if (ativa === true) throw fail("INTERNAL", "a sessao do painel pode ter ficado aberta");
    });
  }

  /** Sai pelo botao "Log out" do proprio painel. */
  async #logout(session, abrirInicio = false) {
    const { page, origin } = session;
    try {
      if (abrirInicio || !(await page.locator("#topLogout").isVisible().catch(() => false))) {
        await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 8000 });
        await page.locator("#topLogout").waitFor({ state: "visible", timeout: 8000 });
      }
      await page.click("#topLogout", { timeout: 5000 });
      await page.waitForTimeout(800);
      // "Tem certeza que quer sair?" -> Sim
      await page.locator("button.btn-msg-ok.btn-confirm").filter({ visible: true }).first().click({ timeout: 4000 });
      await page.waitForTimeout(1500);
      return true;
    } catch {
      return false;
    }
  }

  /** Reabre o painel com os mesmos cookies: se ainda entrar sem senha, a sessao continua aberta. true = aberta, false = fechada, null = nao deu para saber. */
  async #stillActive(session) {
    try {
      const { page, origin } = session;
      await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 8000 });
      await page.waitForTimeout(2500);
      if (await page.locator("#topLogout").isVisible().catch(() => false)) return true;
      return (await page.locator("#pc-login-password").isVisible().catch(() => false)) ? false : null;
    } catch {
      return null;
    }
  }
}

export { safeError };
