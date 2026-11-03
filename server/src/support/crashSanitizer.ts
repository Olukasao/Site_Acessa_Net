import { sha256 } from "../security/hash.js";

/** Tira de um texto de erro o que pode identificar o cliente: e-mails, CPF/telefone/números longos, tokens e query strings. */
export function scrubCrashText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g, "[token]")
    .replace(/Bearer\s+\S+/gi, "Bearer [token]")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]")
    .replace(/\?[^\s)'"]*/g, "?[removido]")
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "[num]")
    .replace(/\b\d{6,}\b/g, "[num]")
    .replace(/[A-Za-z0-9_-]{40,}/g, "[token]");
}

/** Primeira linha da mensagem, curta, para o título do grupo. */
export function crashTitle(message: string): string {
  const first = scrubCrashText(message).split("\n", 1)[0]?.trim() ?? "";
  return (first || "Erro sem mensagem").slice(0, 300);
}

/**
 * Assinatura que agrupa o mesmo erro: tipo + título sem números + as 3 primeiras linhas da pilha sem
 * números de linha/coluna (mudam a cada build sem mudar a causa).
 */
export function crashSignature(kind: string, title: string, stack: string): string {
  const frames = stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(at\s|[\w$.]+\(|[\w$.<>]+@|\w[\w$.]*\s*\()/.test(line))
    .slice(0, 3)
    .map((line) => line.replace(/:\d+(:\d+)?/g, "").replace(/0x[0-9a-f]+/gi, ""));
  const base = title.replace(/\d+/g, "#");
  return sha256(`${kind}|${base}|${frames.join("|")}`).slice(0, 32);
}
