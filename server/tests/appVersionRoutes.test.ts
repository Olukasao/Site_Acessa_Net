import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerAppVersionRoutes, resetAppVersionCache } from "../src/routes/appVersionRoutes.js";

async function ask() {
  const app = Fastify();
  await registerAppVersionRoutes(app);
  const response = await app.inject({ method: "GET", url: "/v1/app/version" });
  await app.close();
  return { body: response.json(), cache: response.headers["cache-control"] };
}

describe("GET /v1/app/version", () => {
  afterEach(() => {
    delete process.env.APP_MIN_VERSION_FILE;
    delete process.env.APP_MIN_VERSION_CODE;
    resetAppVersionCache();
  });

  it("nao forca ninguem por padrao (0) e nunca cacheia", async () => {
    process.env.APP_MIN_VERSION_FILE = path.join(os.tmpdir(), "nao-existe-app-min-version.txt");
    const { body, cache } = await ask();
    expect(body).toEqual({ minVersionCode: 0 });
    expect(cache).toBe("no-store");
  });

  it("usa o arquivo quando existe e ele manda mais que a variavel de ambiente", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "appver-"));
    const file = path.join(dir, "app-min-version.txt");
    await writeFile(file, "25\n");
    process.env.APP_MIN_VERSION_FILE = file;
    process.env.APP_MIN_VERSION_CODE = "10";
    expect((await ask()).body).toEqual({ minVersionCode: 25 });
  });

  it("cai na variavel de ambiente sem arquivo e ignora lixo", async () => {
    process.env.APP_MIN_VERSION_FILE = path.join(os.tmpdir(), "nao-existe-app-min-version.txt");
    process.env.APP_MIN_VERSION_CODE = "12";
    expect((await ask()).body).toEqual({ minVersionCode: 12 });
    resetAppVersionCache();
    process.env.APP_MIN_VERSION_CODE = "abc";
    expect((await ask()).body).toEqual({ minVersionCode: 0 });
  });
});

describe("GET /v1/app/version no app completo", () => {
  it("e publica: responde sem login (o hook global de autenticacao nao a bloqueia)", async () => {
    const { buildApp } = await import("../src/app.js");
    const { createContainer } = await import("../src/container.js");
    const container = createContainer({ env: "test", sqlitePath: ":memory:", sgp: { basicUsername: "t", basicPassword: "t" } } as never);
    const app = await buildApp(container);
    process.env.APP_MIN_VERSION_FILE = path.join(os.tmpdir(), "nao-existe-app-min-version.txt");
    resetAppVersionCache();

    const response = await app.inject({ method: "GET", url: "/v1/app/version" });
    await app.close();
    delete process.env.APP_MIN_VERSION_FILE;

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ minVersionCode: 0 });
  });
});
