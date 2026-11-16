// Gera o par de chaves do agente. A privada fica SO aqui (arquivo 600); a publica vai para o .env da Central
// (ROUTER_AGENT_PUBLIC_KEY). Uso: node scripts/keygen.mjs data/agent-key.pem
import { generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

const out = process.argv[2] || "data/agent-key.pem";
if (existsSync(out)) { console.error(`${out} ja existe; apague antes se quiser trocar a chave.`); process.exit(1); }
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
writeFileSync(out, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
const pub = publicKey.export({ type: "spki", format: "pem" }).toString().trim().replace(/\n/g, "\\n");
console.log(`chave privada: ${out}\n\nColoque no .env da Central:\nROUTER_AGENT_PUBLIC_KEY="${pub}"`);
