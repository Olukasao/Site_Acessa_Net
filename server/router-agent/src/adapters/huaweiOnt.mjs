import { BaseRouterAdapter } from "./base.mjs";
import { checkPin } from "../http.mjs";
import { safeError } from "../safe.mjs";
import { timed } from "../timing.mjs";

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
// Redes que cada modelo validado tem (conferido na bancada): permite responder a leitura sem entrar no painel.
const MODEL_BANDS = { "EG8145V5-V2": ["2.4GHz", "5GHz"] };
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
 * Um navegador (processo) compartilhado entre os pedidos, aberto sob demanda e fechado depois de um tempo parado; cada pedido usa um
 * CONTEXTO proprio (cookies e sessoes isolados por roteador). Contexto que passa de MAX_CONTEXT_MS (travou ao sair do painel, por exemplo)
 * e fechado pelo faxineiro; se nem assim fechar, o navegador inteiro e encerrado a forca. Um navegador esquecido segura vaga de sessao no
 * roteador e memoria do servidor.
 */
let sharedBrowser = null; // Promise<Browser>
let idleTimer = null;
const liveContexts = new Map(); // context -> { browser, since }
const MAX_CONTEXT_MS = 4 * 60_000;
const BROWSER_IDLE_MS = 90_000;

async function acquireBrowser(launch, options) {
  clearTimeout(idleTimer);
  if (sharedBrowser) {
    const existing = await sharedBrowser.catch(() => null);
    if (existing?.isConnected?.()) return existing;
    sharedBrowser = null;
  }
  const promise = Promise.resolve(launch(options));
  sharedBrowser = promise;
  try {
    const browser = await promise;
    browser.on?.("disconnected", () => {
      if (sharedBrowser === promise) sharedBrowser = null;
    });
    return browser;
  } catch (error) {
    if (sharedBrowser === promise) sharedBrowser = null;
    throw error;
  }
}

function scheduleBrowserIdleClose() {
  clearTimeout(idleTimer);
  if (liveContexts.size > 0 || !sharedBrowser) return;
  idleTimer = setTimeout(async () => {
    if (liveContexts.size > 0 || !sharedBrowser) return;
    const promise = sharedBrowser;
    sharedBrowser = null;
    const browser = await promise.catch(() => null);
    if (browser) await killBrowser(browser);
  }, BROWSER_IDLE_MS);
  idleTimer.unref?.();
}

async function closeContext(context) {
  const info = liveContexts.get(context);
  liveContexts.delete(context);
  await bound(context.close(), 6000);
  scheduleBrowserIdleClose();
  return info;
}

export async function killBrowser(browser) {
  await bound(browser.close(), 6000);
  try {
    browser.process?.()?.kill("SIGKILL");
  } catch {
    // ja encerrado
  }
}
/** Encerramento do agente: fecha todos os contextos e o navegador compartilhado (nao deixa processo de navegador orfao). */
export async function shutdownBrowsers() {
  clearTimeout(idleTimer);
  await reapBrowsers(0);
  const promise = sharedBrowser;
  sharedBrowser = null;
  const browser = await promise?.catch(() => null);
  if (browser) await killBrowser(browser);
}

export async function reapBrowsers(maxAgeMs = MAX_CONTEXT_MS) {
  let reaped = 0;
  for (const [context, info] of [...liveContexts]) {
    if (Date.now() - info.since < maxAgeMs) continue;
    liveContexts.delete(context);
    await bound(context.close(), 6000);
    // contexto que nao fecha: derruba o navegador inteiro (os outros pedidos, se houver, falham e viram "nao confirmado")
    if (info.browser?.isConnected?.()) await killBrowser(info.browser);
    reaped++;
  }
  scheduleBrowserIdleClose();
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

  /** Leitura sem login: so para modelo validado. null = precisa ler no painel. */
  quickStatus(model) {
    const bands = MODEL_BANDS[String(model ?? "")];
    return bands ? { bands: [...bands] } : null;
  }

  capabilities() {
    return { support: this.support, canReadSsid: true, canReadPassword: false, canChangePassword: true, bands: ["2.4GHz", "5GHz"], missing: [], validatedModels: VALIDATED_MODELS };
  }

  /** Pagina de login (sem login): o nome do produto vem no proprio HTML. */
  async identify(ctx) {
    const res = await timed("router.identificar", () => ctx.http.request("/", { headers: { Accept: "text/html" } }));
    const model = res.status === 200 ? parseProductName(await res.text()) : null;
    return { vendor: model ? "huawei" : null, model, firmware: null, confirmed: Boolean(model) };
  }

  async authenticate(ctx) {
    // confere o certificado antes de abrir o navegador (o contexto do navegador aceita o certificado de fabrica so desta origem)
    const pin = await timed("router.certificado", () => checkPin(ctx.baseUrl, ctx.http.pins));
    if (pin.unreachable) throw fail("ROUTER_UNREACHABLE", "roteador nao respondeu");
    if (!pin.ok) throw fail("ROUTER_CERT_UNKNOWN", "certificado do roteador fora da lista");

    const { chromium } = await import("playwright-core");
    const browser = await timed("router.navegador", () => acquireBrowser(this.launch ?? ((o) => chromium.launch(o)), { headless: true, executablePath: this.browserPath }));
    let context = null;
    try {
      context = await browser.newContext({ ignoreHTTPSErrors: true, javaScriptEnabled: true, acceptDownloads: false });
      liveContexts.set(context, { browser, since: Date.now() });
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
      await timed("router.login.pagina", () => page.goto(`${origin}/`, { waitUntil: "domcontentloaded" }));
      await page.fill("#txt_Username", ctx.credentials.username ?? "");
      await page.fill("#txt_Password", ctx.credentials.password);
      // Depois do login.cgi o painel manda para a pagina inicial (index.asp), que aqui nao serve para nada: vamos direto a pagina de Wi-Fi.
      await timed("router.login.enviar", async () => {
        const resposta = page.waitForResponse((r) => /\/login\.cgi/.test(r.url()), { timeout: 20000 });
        await page.locator('input[type=button], button').filter({ hasText: /^\s*Log In\s*$/ }).or(page.locator('input[type=button][value="Log In"]')).filter({ visible: true }).first().click();
        await resposta;
      });
      const session = { browser, context, page, origin, dialogs, preloaded: null };
      const info = await this.#openBand(session, "2.4GHz", 20000);
      // a pagina de Wi-Fi so abre com sessao valida; se voltou a tela de login, a senha foi recusada
      if (info.loginForm) throw fail("ROUTER_AUTH_FAILED", "login recusado");
      session.preloaded = { band: "2.4GHz", info };
      return session;
    } catch (error) {
      if (context) await closeContext(context);
      throw error;
    }
  }

  async readBand(session, band, timeout = 20000) {
    // a pagina que acabou de abrir no login ja traz esta rede: nao carrega de novo
    if (session.preloaded?.band === band) {
      const { info } = session.preloaded;
      session.preloaded = null;
      return info;
    }
    return timed(`router.ler.${band}`, () => this.#openBand(session, band, timeout));
  }

  async #openBand(session, band, timeout) {
    await session.page.goto(`${session.origin}/html/amp/wlanbasic/WlanBasic.asp?${BAND_PAGE[band]}`, { waitUntil: "domcontentloaded", timeout });
    // os campos sao preenchidos pelo JavaScript da pagina: espera o SSID aparecer (ou a tela de login, se a sessao caiu)
    await session.page.waitForFunction(() => document.getElementById("wlSsid")?.value || document.getElementById("txt_Password"), null, { timeout }).catch(() => undefined);
    return session.page.evaluate(() => ({
      // a pagina traz a configuracao das DUAS redes (lida do roteador agora): serve para conferir a outra rede sem abrir a pagina dela
      config: (() => {
        const lista = typeof Wlan !== "undefined" && Array.isArray(Wlan) ? Wlan : [];
        const out = {};
        for (const w of lista) {
          if (!w) continue;
          const banda = w.name === "ath0" ? "2.4GHz" : w.name === "ath4" ? "5GHz" : null;
          if (banda) out[banda] = { ssid: w.ssid, beacon: w.BeaconType, wpa: w.WPAAuthenticationMode, i11: w.IEEE11iAuthenticationMode, mix: w.X_HW_WPAand11iAuthenticationMode, enc: w.WPAEncryptionModes };
        }
        return out;
      })(),
      loginForm: Boolean(document.getElementById("txt_Password")),
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
        errors.push(`${band}: ${safeError(error, 80)}`);
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
    session.ssids = {};
    // Configuracao das duas redes ANTES de qualquer troca (so a senha pode mudar). Cada pagina de Wi-Fi traz as duas redes, entao
    // abrir a pagina da proxima rede ja prova, lendo do roteador, que a rede anterior so mudou a senha.
    let baseline = null;
    const igual = (a, b) => Boolean(a) && Boolean(b) && a.ssid === b.ssid && a.beacon === b.beacon && a.wpa === b.wpa && a.i11 === b.i11 && a.mix === b.mix && a.enc === b.enc;
    for (const band of input.bands) {
      const before = await this.readBand(session, band);
      if (!before.ssid) throw fail("ROUTER_UNSUPPORTED", `rede ${band} nao encontrada`);
      if (!PSK_MODES.has(String(before.auth).toLowerCase()) || !before.pskField) throw fail("ROUTER_UNSUPPORTED", `rede ${band} nao usa senha WPA`);
      session.ssids[band] = before.ssid.slice(0, 32);
      if (!baseline) baseline = before.config ?? {};
      for (const feita of session.applied) {
        if (baseline[feita] && !igual(baseline[feita], before.config?.[feita])) throw fail("INTERNAL", "a rede mudou alem da senha");
      }
      let saved = false;
      // o painel recusa salvar enquanto aplica outra mudanca (aviso na tela): espera um pouco e tenta de novo, uma vez
      for (let attempt = 0; attempt < 2 && !saved; attempt++) {
        const dialogsBefore = session.dialogs.length;
        const res = await timed(`router.aplicar.${band}`, async () => {
          await session.page.fill(before.pskField, input.password);
          await session.page.dispatchEvent(before.pskField, "change");
          const response = session.page.waitForResponse((r) => /\/set\.cgi\?/.test(r.url()) && r.request().method() === "POST", { timeout: attempt === 0 ? 12000 : 30000 });
          await session.page.click("#btnApplySubmit");
          return response.catch(() => null);
        });
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
      session.applied.push(band);
    }
    // So a ultima rede trocada precisa de uma leitura nova (as anteriores foram conferidas ao abrir a pagina da seguinte)
    const ultima = session.applied.at(-1);
    if (ultima) {
      const depois = await timed(`router.reler.${ultima}`, () => this.readWhenBack(session, ultima));
      if (baseline?.[ultima] && depois.config?.[ultima]) {
        if (!igual(baseline[ultima], depois.config[ultima])) throw fail("INTERNAL", "a rede mudou alem da senha");
      } else if (!depois.ssid || depois.ssid.slice(0, 32) !== session.ssids[ultima]) {
        throw fail("INTERNAL", "a rede mudou alem da senha");
      }
    }
  }

  /** A senha volta mascarada: nao ha como reler. O roteador aceitou e a rede continua igual, mas isso nao e prova. */
  async verifyWifiConfiguration() {
    return false;
  }

  async closeSession(_ctx, session) {
    return timed("router.sair", () => this.#closeSession(session));
  }

  async #closeSession(session) {
    try {
      // a pagina de Wi-Fi ja traz a funcao de sair: usa ela (sem abrir a pagina inicial). Cada passo tem prazo.
      const saiu = await bound(
        Promise.all([
          bound(session.page.waitForResponse((r) => /\/logout\.cgi/.test(r.url()), { timeout: 4000 }), 4500),
          session.page.evaluate(() => (typeof window.logoutfunc === "function" ? (window.logoutfunc(), true) : false))
        ]).then(([, chamou]) => chamou),
        6000
      );
      if (!saiu) {
        await bound(session.page.goto(`${session.origin}/index.asp`, { waitUntil: "domcontentloaded", timeout: 8000 }), 10_000);
        await bound(session.page.evaluate(() => (typeof window.logoutfunc === "function" ? window.logoutfunc() : null)), 5000);
        await bound(session.page.waitForTimeout(1200), 3000);
      }
    } finally {
      await closeContext(session.context);
    }
  }
}
