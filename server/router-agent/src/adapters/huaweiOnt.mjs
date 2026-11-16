import { BaseRouterAdapter } from "./base.mjs";
import { checkPin } from "../http.mjs";

/**
 * Huawei com painel "ONT" (validado em bancada em 16/11/2026: EG8145V5-V2, perfil BREBG2, https na porta 80).
 *
 * Como o painel funciona (lido do proprio aparelho):
 *  - login: /asp/GetRandCount.asp (token) + POST /login.cgi com UserName, PassWord em base64 e x.X_HW_Token;
 *    bloqueia o login depois de 3 senhas erradas (errloginlockNum), por isso so tentamos UMA vez por tarefa;
 *  - Wi-Fi: /html/amp/wlanbasic/WlanBasic.asp?2G e ?5G; o botao Aplicar (#btnApplySubmit) manda set.cgi com
 *    SSID/seguranca atuais + k.PreSharedKey + o espelho do mesh (w.*), tudo montado pelo JavaScript da pagina;
 *  - a senha atual volta sempre mascarada ("********"): nao da para reler e confirmar a troca pelo painel.
 *
 * Por isso a troca e feita pelo proprio painel num navegador sem tela (Playwright), so preenchendo o campo da senha:
 * o painel monta o envio exatamente como faria para um tecnico. O navegador so acessa a origem do roteador.
 */
const VALIDATED_MODELS = ["EG8145V5-V2"];
const BAND_PAGE = { "2.4GHz": "2G", "5GHz": "5G" };
const PSK_MODES = new Set(["wpa/wpa2-psk", "wpa2-psk", "wpa-psk", "wpa2/wpa3-psk", "wpa3-sae", "wpa2-psk/wpa3-sae"]);

export function parseProductName(html) {
  const m = String(html).match(/var\s+ProductName\s*=\s*'([^']{1,40})'/);
  if (!m) return null;
  return m[1].replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).trim();
}

const fail = (code, message) => Object.assign(new Error(message), { code });

/** Espera uma promessa por no maximo `ms` (sem lancar): usada para sair do painel sem nunca travar. */
const bound = (promise, ms) => Promise.race([Promise.resolve(promise).catch(() => undefined), new Promise((resolve) => setTimeout(resolve, ms))]);

/**
 * Navegadores abertos agora. Se algum passar de MAX_BROWSER_MS (travou ao sair do painel, por exemplo) o faxineiro o
 * encerra a forca: um navegador esquecido segura uma vaga de sessao no roteador e consome memoria do servidor.
 */
const liveBrowsers = new Map();
const MAX_BROWSER_MS = 4 * 60_000;
export async function killBrowser(browser) {
  await bound(browser.close(), 6000);
  try {
    browser.process?.()?.kill("SIGKILL");
  } catch {
    // ja encerrado
  }
}
export async function reapBrowsers(maxAgeMs = MAX_BROWSER_MS) {
  let reaped = 0;
  for (const [browser, since] of [...liveBrowsers]) {
    if (Date.now() - since < maxAgeMs) continue;
    liveBrowsers.delete(browser);
    await killBrowser(browser);
    reaped++;
  }
  return reaped;
}
setInterval(() => void reapBrowsers(), 30_000).unref();

export class HuaweiOntAdapter extends BaseRouterAdapter {
  vendor = "huawei";
  support = "supported";
  validatedModels = VALIDATED_MODELS;
  missing = [];

  constructor({ browserPath, launch } = {}) {
    super();
    this.browserPath = browserPath ?? process.env.ROUTER_BROWSER_PATH;
    this.launch = launch; // so para testes
  }

  supportsModel(model) {
    return VALIDATED_MODELS.includes(String(model ?? ""));
  }

  capabilities() {
    return { support: this.support, canReadSsid: true, canReadPassword: false, canChangePassword: true, bands: ["2.4GHz", "5GHz"], missing: [], validatedModels: VALIDATED_MODELS };
  }

  /** Pagina de login (sem login): o nome do produto vem no proprio HTML. */
  async identify(ctx) {
    const res = await ctx.http.request("/", { headers: { Accept: "text/html" } });
    const model = res.status === 200 ? parseProductName(await res.text()) : null;
    return { vendor: model ? "huawei" : null, model, firmware: null, confirmed: Boolean(model) };
  }

  async authenticate(ctx) {
    // confere o certificado antes de abrir o navegador (o contexto do navegador aceita o certificado de fabrica so desta origem)
    const pin = await checkPin(ctx.baseUrl, ctx.http.pins);
    if (pin.unreachable) throw fail("ROUTER_UNREACHABLE", "roteador nao respondeu");
    if (!pin.ok) throw fail("ROUTER_CERT_UNKNOWN", "certificado do roteador fora da lista");

    const { chromium } = await import("playwright-core");
    const browser = await (this.launch ?? ((o) => chromium.launch(o)))({ headless: true, executablePath: this.browserPath });
    liveBrowsers.set(browser, Date.now());
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, javaScriptEnabled: true, acceptDownloads: false });
      const origin = new URL(ctx.baseUrl).origin;
      // o navegador so fala com o roteador: qualquer outro destino e bloqueado
      await context.route("**/*", (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      const dialogs = [];
      page.on("dialog", async (d) => {
        dialogs.push(d.message().slice(0, 200));
        await d.accept().catch(() => undefined);
      });
      await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
      await page.fill("#txt_Username", ctx.credentials.username ?? "");
      await page.fill("#txt_Password", ctx.credentials.password);
      await page.locator('input[type=button], button').filter({ hasText: /^\s*Log In\s*$/ }).or(page.locator('input[type=button][value="Log In"]')).filter({ visible: true }).first().click();
      // depois do login.cgi o painel redireciona sozinho para /index.asp; ja logado, nao precisa abrir de novo
      await page.waitForURL((u) => u.pathname !== "/" && !/login/i.test(u.pathname), { timeout: 15000 }).catch(() => undefined);
      await page.waitForLoadState("domcontentloaded");
      const loggedIn = await page.evaluate(() => !document.getElementById("txt_Password") && /logoutfunc/i.test(document.documentElement.innerHTML));
      if (!loggedIn) throw fail("ROUTER_AUTH_FAILED", "login recusado");
      return { browser, context, page, origin, dialogs };
    } catch (error) {
      liveBrowsers.delete(browser);
      await killBrowser(browser);
      throw error;
    }
  }

  async readBand(session, band, timeout = 20000) {
    await session.page.goto(`${session.origin}/html/amp/wlanbasic/WlanBasic.asp?${BAND_PAGE[band]}`, { waitUntil: "domcontentloaded", timeout });
    // os campos sao preenchidos pelo JavaScript da pagina: espera o SSID aparecer
    await session.page.waitForFunction(() => document.getElementById("wlSsid")?.value, null, { timeout }).catch(() => undefined);
    return session.page.evaluate(() => ({
      ssid: document.getElementById("wlSsid")?.value ?? null,
      auth: document.getElementById("wlAuthMode")?.value ?? null,
      pskField: document.getElementById("wlWpaPsk")?.offsetParent ? "#wlWpaPsk" : document.getElementById("twlWpaPsk")?.offsetParent ? "#twlWpaPsk" : null
    }));
  }

  async getWifiInfo(_ctx, session) {
    const bands = [];
    const ssids = {};
    const errors = [];
    for (const band of ["2.4GHz", "5GHz"]) {
      try {
        // logo depois de uma troca o roteador demora a voltar a abrir a pagina de Wi-Fi: espera ele voltar
        const info = await this.readWhenBack(session, band, 45_000);
        if (info?.ssid) {
          bands.push(band);
          ssids[band] = info.ssid.slice(0, 32);
        } else errors.push(`${band}: pagina sem SSID`);
      } catch (error) {
        errors.push(`${band}: ${String(error?.message ?? error).split("\n")[0].slice(0, 80)}`);
      }
    }
    return { bands, ssids, errors };
  }

  /** Depois de salvar o roteador fica alguns segundos sem responder (aplica o Wi-Fi): tenta ler de novo ate ele voltar. */
  async readWhenBack(session, band, maxMs = 45000) {
    const deadline = Date.now() + maxMs;
    let last = null;
    for (;;) {
      try {
        const info = await this.readBand(session, band, 8000);
        if (info.ssid) return info;
      } catch (error) {
        last = error;
      }
      if (Date.now() >= deadline) throw last ?? fail("INTERNAL", "o roteador nao voltou a responder");
      await session.page.waitForTimeout(1000);
    }
  }

  async changeWifiPassword(_ctx, session, input) {
    session.applied = [];
    for (const band of input.bands) {
      const before = await this.readBand(session, band);
      if (!before.ssid) throw fail("ROUTER_UNSUPPORTED", `rede ${band} nao encontrada`);
      if (!PSK_MODES.has(String(before.auth).toLowerCase()) || !before.pskField) throw fail("ROUTER_UNSUPPORTED", `rede ${band} nao usa senha WPA`);
      let saved = false;
      // o painel recusa salvar enquanto aplica outra mudanca (aviso na tela): espera um pouco e tenta de novo, uma vez
      for (let attempt = 0; attempt < 2 && !saved; attempt++) {
        const dialogsBefore = session.dialogs.length;
        await session.page.fill(before.pskField, input.password);
        await session.page.dispatchEvent(before.pskField, "change");
        const response = session.page.waitForResponse((r) => /\/set\.cgi\?/.test(r.url()) && r.request().method() === "POST", { timeout: attempt === 0 ? 12000 : 30000 });
        await session.page.click("#btnApplySubmit");
        const res = await response.catch(() => null);
        if (res) {
          if (res.status() !== 200) throw fail("INTERNAL", "o roteador nao respondeu ao salvar");
          saved = true;
        } else if (session.dialogs.length > dialogsBefore && attempt === 0) {
          await session.page.waitForTimeout(4000);
          await this.readBand(session, band); // recarrega a pagina antes de tentar de novo
        } else {
          throw fail("INTERNAL", session.dialogs.length > dialogsBefore ? "o painel mostrou um aviso ao salvar" : "o roteador nao respondeu ao salvar");
        }
      }
      // depois de salvar o roteador aplica a mudanca; uma pausa curta e a pagina aberta de novo mostram o estado real
      const after = await this.readWhenBack(session, band);
      if (after.ssid !== before.ssid || after.auth !== before.auth) throw fail("INTERNAL", "a rede mudou alem da senha");
      session.applied.push(band);
    }
  }

  /** A senha volta mascarada: nao ha como reler. O roteador aceitou e a rede continua igual, mas isso nao e prova. */
  async verifyWifiConfiguration() {
    return false;
  }

  async closeSession(_ctx, session) {
    try {
      // sair pelo proprio painel (libera a sessao do roteador, que tem poucas vagas); cada passo tem prazo
      await bound(session.page.goto(`${session.origin}/index.asp`, { waitUntil: "domcontentloaded", timeout: 8000 }), 10_000);
      await bound(session.page.evaluate(() => (typeof window.logoutfunc === "function" ? window.logoutfunc() : null)), 5000);
      await bound(session.page.waitForTimeout(1200), 3000);
    } finally {
      liveBrowsers.delete(session.browser);
      await killBrowser(session.browser);
    }
  }
}
