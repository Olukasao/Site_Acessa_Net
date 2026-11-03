// Relatorio automatico de erros do SITE -> POST /v1/app-crashes (o mesmo painel "Erros do app"; aparece como versao "site").
// Mesmas regras do app: sem login, poucos por sessao, sem repetir, falha de envio ignorada. Envia so: mensagem, pilha, navegador/sistema
// e um ID anonimo gerado aqui. Nunca envia CPF, tokens, URL com parametros nem o conteudo das telas; o servidor ainda filtra e-mails e
// numeros longos.

const DEVICE_KEY = "acessanet.crash.deviceId";
const MAX_PER_SESSION = 5;
const SITE_VERSION = "site";

/** Ruido que nao e defeito do site: extensao do navegador, rede fora, aba antiga depois de um deploy, robos. */
const IGNORED_MESSAGES = [
  /ResizeObserver loop/i,
  /^Script error\.?$/i,
  /Load failed|Failed to fetch|NetworkError|Network request failed/i,
  /dynamically imported module|Importing a module script failed|Loading chunk|Unable to preload CSS/i,
  /Non-Error promise rejection/i
];
const BOT_AGENT = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|gtmetrix|prerender/i;

let sent = 0;
const seen = new Set();

function deviceId() {
  try {
    let id = window.localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = window.crypto.randomUUID();
      window.localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return `sessao-${Math.random().toString(16).slice(2, 12)}`;
  }
}

/** "Chrome 130" / "Safari 17" / ... do user agent. */
export function browserFromUserAgent(userAgent) {
  const rules = [
    [/Edg(?:e|A|iOS)?\/([\d.]+)/, "Edge"],
    [/OPR\/([\d.]+)/, "Opera"],
    [/SamsungBrowser\/([\d.]+)/, "Samsung Internet"],
    [/(?:Chrome|CriOS)\/([\d.]+)/, "Chrome"],
    [/(?:Firefox|FxiOS)\/([\d.]+)/, "Firefox"],
    [/Version\/([\d.]+).*Safari/, "Safari"]
  ];
  for (const [pattern, name] of rules) {
    const match = userAgent.match(pattern);
    if (match) return `${name} ${match[1].split(".")[0]}`;
  }
  return "desconhecido";
}

/** "Windows" / "Android 14" / "iOS 17" / ... do user agent. */
export function systemFromUserAgent(userAgent) {
  let match = userAgent.match(/Android\s([\d.]+)/);
  if (match) return `Android ${match[1].split(".")[0]}`;
  match = userAgent.match(/(?:iPhone|iPad|CPU) OS ([\d_]+)/);
  if (match) return `iOS ${match[1].split("_")[0]}`;
  if (/Windows/.test(userAgent)) return "Windows";
  if (/Mac OS X/.test(userAgent)) return "macOS";
  if (/CrOS/.test(userAgent)) return "ChromeOS";
  if (/Linux/.test(userAgent)) return "Linux";
  return "desconhecido";
}

/**
 * Tira da pilha o que muda a cada deploy ou identifica o ambiente: o dominio e o hash do arquivo
 * ("/assets/ClienteArea-D5FyMVT_.js" vira "/assets/ClienteArea.js"), senao o mesmo erro viraria um grupo novo a cada publicacao.
 */
export function cleanStack(stack) {
  return String(stack || "")
    .replace(/https?:\/\/[^/\s)]+/g, "")
    .replace(/(\/assets\/[\w.]+?)-[A-Za-z0-9_-]{8}(\.(?:m?js|css))/g, "$1$2")
    .replace(/[?#][^\s):]*/g, "");
}

/** Erro do proprio site? Ignora script de extensao, de terceiros ou de outro dominio. */
function isOwnCode(filename, stack) {
  const origin = window.location.origin;
  if (filename) return filename.startsWith(origin);
  return !stack || stack.includes(origin) || stack.includes("/assets/");
}

async function send(payload) {
  const agent = navigator.userAgent;
  const response = await fetch("/v1/app-crashes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "js",
      message: String(payload.message || "Erro sem mensagem").slice(0, 2000),
      stack: cleanStack(payload.stack).slice(0, 12000),
      appVersion: SITE_VERSION,
      deviceId: deviceId(),
      deviceModel: browserFromUserAgent(agent).slice(0, 100),
      androidVersion: systemFromUserAgent(agent).slice(0, 32)
    }),
    keepalive: true
  });
  return response.ok;
}

export function reportError(error, fallbackMessage, filename) {
  try {
    const message = error?.message || fallbackMessage || "Erro sem mensagem";
    const stack = error?.stack || "";
    if (IGNORED_MESSAGES.some((pattern) => pattern.test(message))) return;
    if (!isOwnCode(filename, stack)) return;
    const key = `${message}|${cleanStack(stack).split("\n").slice(0, 3).join("|")}`;
    if (seen.has(key) || sent >= MAX_PER_SESSION) return;
    seen.add(key);
    sent += 1;
    void send({ message: `${error?.name || "Error"}: ${message}`, stack }).catch(() => {});
  } catch {
    // o relatorio nunca pode causar outro erro
  }
}

export function installErrorReporter() {
  if (typeof window === "undefined" || BOT_AGENT.test(navigator.userAgent)) return;

  window.addEventListener("error", (event) => reportError(event.error, event.message, event.filename));
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    // Erros das APIs (cliente e admin) e cancelamentos sao parte do fluxo normal, nao defeitos do site.
    if (reason?.name === "ClienteApiError" || reason?.name === "AdminApiError" || reason?.name === "AbortError") return;
    reportError(reason instanceof Error ? reason : new Error(String(reason)), "Promessa rejeitada");
  });
  // Falhas de renderizacao capturadas pelo RouteErrorBoundary.
  window.addEventListener("acessanet:render-error", (event) => reportError(event.detail, "Falha ao renderizar"));
}
