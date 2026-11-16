/**
 * Interface comum dos adaptadores de roteador. Cada fabricante/modelo/firmware implementa o fluxo REAL que foi
 * validado em bancada. Enquanto nao houver validacao, o adaptador fica em "requires_validation" e diz o que falta:
 * nunca inventamos URL interna, parametro ou fluxo de login.
 *
 * Contexto recebido: { baseUrl, credentials: { username, password }, http } -- http so fala com baseUrl (ver http.mjs).
 */
export class BaseRouterAdapter {
  /** Identificador do fabricante (chave do cofre e da configuracao de porta). */
  vendor = "base";
  /** "supported" (validado em bancada), "requires_validation" ou "unsupported". */
  support = "unsupported";
  /** O que falta para validar (vai para o painel administrativo e para a documentacao). */
  missing = [];
  /** Modelos/firmwares validados (vazio enquanto nada foi testado). */
  validatedModels = [];

  capabilities() {
    return { support: this.support, canReadSsid: false, canReadPassword: false, canChangePassword: this.support === "supported", bands: [], missing: this.missing };
  }

  /** Confirma fabricante/modelo/firmware lendo o proprio roteador (sem login, quando possivel). */
  async identify(_ctx) {
    return { vendor: this.vendor, model: null, firmware: null, confirmed: false };
  }
  async authenticate(_ctx) {
    throw notImplemented(this);
  }
  /** SSID e bandas. Nunca le a senha atual. */
  async getWifiInfo(_ctx, _session) {
    throw notImplemented(this);
  }
  async changeWifiPassword(_ctx, _session, _input) {
    throw notImplemented(this);
  }
  /** Senha e/ou nome. Padrao: so senha (adaptadores que nao trocam nome recusam o pedido de nome). */
  async changeWifiSettings(ctx, session, input) {
    if (input.names) throw notImplemented(this);
    await this.changeWifiPassword(ctx, session, { password: input.password, bands: input.bands });
    return { verified: false };
  }
  /** Prova de que a alteracao valeu (ex.: reler a configuracao). "HTTP 200" sozinho nao basta. */
  async verifyWifiConfiguration(_ctx, _session, _input) {
    return false;
  }
  async closeSession(_ctx, _session) {}
}

export function notImplemented(adapter) {
  const e = new Error(`${adapter.vendor}: fluxo ainda nao validado`);
  e.code = "ROUTER_REQUIRES_VALIDATION";
  return e;
}

/** Adaptador de fabricante conhecido mas ainda nao validado em bancada. */
export class PendingValidationAdapter extends BaseRouterAdapter {
  constructor(vendor, missing) {
    super();
    this.vendor = vendor;
    this.support = "requires_validation";
    this.missing = missing;
  }
}
