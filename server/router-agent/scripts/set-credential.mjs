// Grava a credencial de administrador de um fabricante no cofre cifrado, lendo do teclado (nao fica no historico).
// Uso: npm run set-credential -- tplink        (ou fabricante:modelo)
import { createInterface } from "node:readline/promises";
import { CredentialStore } from "../src/credentials.mjs";

const id = process.argv[2];
if (!id) { console.error("informe o fabricante: tplink, huawei, stavix, mercusys (ou fabricante:modelo)"); process.exit(1); }
const store = new CredentialStore(process.env.ROUTER_CREDENTIALS_PATH, process.env.ROUTER_CREDENTIALS_KEY);
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const username = (await rl.question("usuario (vazio se o painel so pede senha): ")).trim();
const password = await rl.question("senha: ");
rl.close();
store.set(id, { username, password });
console.log(`gravado: ${id}. Cadastrados: ${store.ids().join(", ")}`);
