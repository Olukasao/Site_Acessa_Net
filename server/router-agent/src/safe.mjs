/**
 * Texto de erro que pode ir para o log: so a primeira linha (as mensagens do Playwright trazem o "call log" com a URL), sem IP, MAC
 * nem endereco. Nunca grava senha, token, IP de cliente ou credencial.
 */
export function safeError(error, max = 160) {
  const first = String(error?.message ?? error ?? "erro").split("\n")[0] ?? "";
  return first
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "<ip>")
    .replace(/\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi, "<mac>")
    .slice(0, max);
}
