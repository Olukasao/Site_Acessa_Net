import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * Versao minima do app Android (versionCode) aceita pelo servidor. O app abre uma tela "Atualizacao necessaria"
 * quando o codigo instalado e menor. Valor 0 = ninguem e forcado (estado padrao).
 *
 * Para forcar, sem deploy nem reinicio: no servidor, `echo 25 > data/app-min-version.txt` (vale em ate 30 s).
 * Para desligar: `echo 0 > data/app-min-version.txt`. Sem o arquivo, vale APP_MIN_VERSION_CODE (default 0).
 */
const CACHE_MS = 30_000;
let cache: { value: number; expiresAt: number } | undefined;

function parseCode(raw: string | undefined) {
  const value = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

async function readMinVersionCode(): Promise<number> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;

  const file = process.env.APP_MIN_VERSION_FILE ?? path.join(process.cwd(), "data", "app-min-version.txt");
  let value = parseCode(process.env.APP_MIN_VERSION_CODE);
  try {
    value = parseCode(await readFile(file, "utf8"));
  } catch {
    // Sem o arquivo (ou ilegivel): vale o valor do ambiente.
  }
  cache = { value, expiresAt: Date.now() + CACHE_MS };
  return value;
}

export async function registerAppVersionRoutes(app: FastifyInstance) {
  // Publica de proposito (o app consulta antes do login) e sem dado de cliente.
  app.get("/v1/app/version", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { minVersionCode: await readMinVersionCode() };
  });
}

/** So para testes. */
export function resetAppVersionCache() {
  cache = undefined;
}
