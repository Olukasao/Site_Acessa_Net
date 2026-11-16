import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";

/**
 * Cofre das credenciais de administrador dos roteadores (por fabricante e, se precisar, por modelo).
 * Arquivo cifrado com AES-256-GCM; a chave fica so na variavel ROUTER_CREDENTIALS_KEY (32 bytes em hex/base64).
 * Nada disso vai para o git, para a Central ou para log.
 */
export class CredentialStore {
  constructor(path, keyText) {
    this.path = path;
    this.key = parseKey(keyText);
  }

  readAll() {
    if (!existsSync(this.path)) return {};
    const box = JSON.parse(readFileSync(this.path, "utf8"));
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(box.iv, "base64"));
    decipher.setAuthTag(Buffer.from(box.tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]);
    return JSON.parse(plain.toString("utf8"));
  }

  /** Credencial do modelo, ou a do fabricante quando nao ha uma especifica. */
  get(vendor, model = null) {
    const all = this.readAll();
    const entry = (model && all[`${vendor}:${model}`]) || all[vendor];
    return entry ? { username: entry.username ?? null, password: entry.password } : null;
  }

  set(id, value) {
    if (!/^[a-z0-9_]+(:[\w.-]+)?$/i.test(id)) throw new Error("id invalido (use fabricante ou fabricante:modelo)");
    if (!value?.password) throw new Error("senha obrigatoria");
    const all = this.readAll();
    all[id] = { username: value.username || null, password: value.password };
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(all), "utf8"), cipher.final()]);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") }), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  /** So os nomes (para conferir o que esta cadastrado, sem mostrar senha). */
  ids() {
    return Object.keys(this.readAll());
  }
}

function parseKey(text) {
  const raw = String(text ?? "").trim();
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("ROUTER_CREDENTIALS_KEY precisa ter 32 bytes (64 hex ou base64)");
  return key;
}
