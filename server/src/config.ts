import dotenv from "dotenv";
import { createHmac } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

dotenv.config();
dotenv.config({ path: path.join(serverRoot, ".env") });

export interface AppConfig {
  env: "development" | "test" | "production";
  port: number;
  jwtSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  /** Secret separado do de cliente -- comprometer um token de cliente nunca deve permitir forjar um token admin. */
  adminJwtSecret: string;
  adminAccessTokenTtlSeconds: number;
  adminRefreshTokenTtlSeconds: number;
  corsOrigins: string[] | true;
  /**
   * Repassado ao `trustProxy` do Fastify (TRUST_PROXY). Default false: so
   * ligar atras de proxy reverso, senao qualquer um forja X-Forwarded-For e
   * escapa do limite por IP. true | numero de hops | lista de IPs/CIDR.
   */
  trustProxy: boolean | number | string;
  sgp: {
    enabled: boolean;
    baseUrl: string;
    app: string | undefined;
    token: string | undefined;
    basicUsername: string | undefined;
    basicPassword: string | undefined;
    timeoutMs: number;
    cpfSearchFields: string[];
    /** TTL do cache por documento (ms) -- positivo e negativo. SGP_DOCUMENT_CACHE_TTL_MS / SGP_DOCUMENT_NEGATIVE_CACHE_TTL_MS. */
    documentCacheTtlMs?: number;
    documentNegativeCacheTtlMs?: number;
    /** Teto global de chamadas ao SGP por minuto (SGP_MAX_CALLS_PER_MINUTE, default 1500). */
    customerIdSecret?: string | undefined;
    maxCallsPerMinute?: number;
    /** Teto de chamadas de BUSCA POR DOCUMENTO por minuto -- a superficie anonima (SGP_MAX_LOOKUP_CALLS_PER_MINUTE, default 300). */
    maxLookupCallsPerMinute?: number;
    /** Falhas consecutivas (timeout/rede/5xx) que abrem o circuit breaker e por quanto tempo. */
    circuitFailureThreshold?: number;
    circuitOpenMs?: number;
    chamado: {
      app: string | undefined;
      token: string | undefined;
      timeoutMs: number;
      semOs: string | undefined;
      mapping: Record<string, { ocorrenciaTipo: string; motivoOs: string }>;
      /** Chamado "Anexar documentos" (tipo ANEXAR DOCUMENTO do SGP): tipo/motivo/setor enviados em /api/central/chamado/. */
      documents: { ocorrenciaTipo: string; motivoOs: string; setor: string | undefined };
    };
    /**
     * Assinaturas eletronicas (SGPSign). "enabled" e uma chave PROPRIA
     * (SGP_SIGN_ENABLED), nunca derivada so de SGP_APP/SGP_TOKEN existirem
     * (esses ja sao obrigatorios para login) -- sem isso, o provider real
     * ligaria sozinho no dia em que o metodo fosse implementado, sem
     * validacao previa contra o SGP real. Hoje nao ha endpoint confirmado;
     * ver server/src/integrations/sgp/providers.ts (SignatureProvider).
     */
    sign: {
      enabled: boolean;
      app: string | undefined;
      token: string | undefined;
      timeoutMs: number;
    };
  };
  /**
   * Dados fake de assinatura pendente so para construir/testar a UI antes do
   * endpoint real do SGPSign existir. SEMPRE false em producao, independente
   * do valor da env var (trava abaixo em loadConfig) -- nunca deve aparecer
   * para um cliente real.
   */
  sgpSignMock: {
    enabled: boolean;
  };
  oltCloud: {
    /** Somente leitura -- ver server/src/integrations/oltcloud. Nunca usar este client para POST/PUT/PATCH/DELETE. */
    enabled: boolean;
    baseUrl: string;
    /** Token estatico opcional (atalho manual/debug, ver scripts/test-oltcloud.js) -- quando ausente, login automatico via username/password abaixo (ver oltCloudAuth.ts). */
    token: string | undefined;
    /** Usuario/senha com permissao de API na OLT Cloud (POST /api/token) -- preferido sobre token estatico: renova sozinho (access ~3h, refresh ~24h), nunca expira em produção. */
    username: string | undefined;
    password: string | undefined;
    timeoutMs: number;
    /** TTL do cache de status de incidente por cliente (evita 1 chamada a OLT Cloud por render da Central). */
    cacheTtlMs: number;
    debug: {
      /** GET /api/debug/oltcloud/client-status/:contractId -- rota de teste, nunca deve ficar exposta em producao sem token. */
      enabled: boolean;
      token: string | undefined;
    };
  };
  /**
   * Integracao com o AcessaNet Connect (captive portal Wi-Fi, repo separado em
   * /home/noc/roteador-publico/apps/api) -- so para a tela "Marketing" do admin,
   * le os leads que deram opt-in de marketing no Wi-Fi publico. Mesmo padrao do
   * bloco oltCloud acima: opcional, enabled = Boolean(baseUrl && token).
   */
  /** Wi-Fi publico (captive portal + RADIUS) -- ver src/wifi/wifiRoutes.ts. */
  /** Feed de contratacoes pendentes para o chat interno (rota so existe com token). */
  contractFeed: {
    token: string | undefined;
  };
  /**
   * Chat de atendimento (acessanet-chat-api). `tokenSecret` e o mesmo segredo que a chat-api usa para conferir o token do
   * cliente (CUSTOMER_CHAT_JWT_SECRET); sem ele a rota /api/auth/chat-token fica desligada. `pushToken` protege a rota
   * pela qual a chat-api pede o aviso no celular do cliente (sem ele a rota nem existe).
   */
  chat: {
    tokenSecret: string | undefined;
    ttlSeconds: number;
    issuer: string;
    audience: string;
    pushToken: string | undefined;
  };
  /** Resumo agregado do site para a aba Marketing do Workspace (a rota so existe com token). */
  marketingFeed: {
    token: string | undefined;
  };
  wifi: {
    /** Segredo compartilhado com o radius-bridge. Vazio = rota de autorizacao desligada. */
    radiusToken: string | undefined;
    /** Quanto tempo o login temporario vale (e vira o Session-Timeout no AP). */
    sessionHours: number;
    /** Hosts extras aceitos em login_url alem de IPs privados (ex.: dominio do controlador). */
    loginHosts: string[];
  };
  acessanetConnect: {
    enabled: boolean;
    baseUrl: string;
    token: string | undefined;
    timeoutMs: number;
  };
  /**
   * Sincronizacao periodica de queda massiva de PON (alert/list -> pon_loss
   * -> equipment/list -> external_client_contract_id -> network_incidents).
   * So roda quando oltCloud.enabled -- ver startPonOutageSync em server.ts.
   */
  ponOutageSync: {
    intervalSeconds: number;
  };
  /** Deteccao de instabilidade regional (server/src/services/networkIncidentDetection) -- consome oltCloud, nunca chama a OLT Cloud diretamente por conta propria. */
  regionalIncident: {
    /** Quantidade minima de dispositivos/clientes correlacionados pra virar "high"/"confirmed" (abaixo disso fica low/medium e nunca vira incidente exposto ao cliente). */
    minClients: number;
    /** Janela de tempo pra considerar eventos correlacionados (mesma infra, inicio proximo). */
    windowMinutes: number;
    /** So usado se/quando existir fonte real de latitude/longitude (hoje nao existe -- ver clientRegionResolver.ts). */
    radiusMeters: number;
    /** Depois de quanto tempo sem evidencia nova um incidente confirmado vira "resolved" (passando por "recovering" antes). */
    recoveryWindowMinutes: number;
    /** TTL do cache do refresh de alertas da OLT Cloud usado pelo correlacionador. */
    refreshTtlMs: number;
    /** TTL do cache do probe de equipment/list (fallback quando ainda nao ha alerta oficial da OLT Cloud). */
    equipmentProbeTtlMs: number;
  };
  /** Segredo usado para HMAC-SHA256 do CPF normalizado (customer_auth_profiles.cpf_hash). Nunca reaproveitar para outra finalidade. */
  cpfHashSecret: string;
  /** Segredo usado para HMAC-SHA256 do codigo OTP (password_reset_requests.otp_hash). Espaco de busca pequeno (6 digitos) -- nunca hashear com sha256 puro nem reaproveitar este segredo para outra finalidade. */
  otpHashSecret: string;
  /** Caminho do arquivo SQLite com os dados de autenticacao (senha, sessao, tentativas, auditoria). So usado quando dbDriver === "sqlite". */
  sqlitePath: string;
  /**
   * "sqlite" (default, arquivo local via node:sqlite) ou "mysql" (banco
   * gerenciado pela Hostinger, fora da pasta que o deploy apaga/recria --
   * ver deploy-hostinger.sh e o backup automatico de auth.sqlite). Trocar
   * exige so DB_DRIVER=mysql no .env + reiniciar; nenhum redeploy de
   * codigo necessario pra reverter, de proposito (rollback instantaneo
   * durante o periodo de validacao da migracao).
   */
  dbDriver: "sqlite" | "mysql";
  mysql: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
  /**
   * Diretorio do build do frontend servido estaticamente em producao (ver
   * app.ts). Resolvido a partir do cwd do processo (nao do import.meta.url
   * deste arquivo) porque o layout de build do pacote de deploy fica em
   * profundidade diferente do layout de dev (server/src/config.ts) -- cwd
   * e a unica referencia estavel nos dois casos (processo sempre iniciado
   * a partir da raiz do projeto/deploy). Default "<cwd>/public" -- irmao
   * de "dist/" (onde o backend compilado fica), nunca dentro dele, pra nao
   * colidir com os arquivos compilados do backend. So importa quando o
   * diretorio existe (ver staticDirExists em app.ts); em dev normal (vite
   * dev separado) fica inerte.
   */
  staticDir: string;
  /**
   * Identifica a build/deploy atual do backend (ver GET /api/health). Vem de
   * APP_VERSION, setado no .env de cada deploy -- nao calculado em runtime
   * (nao ha hash de git/commit disponivel no pacote de deploy, so o dist/
   * compilado). Sem APP_VERSION definido, cai no timestamp de boot do
   * processo: nao identifica a build, mas ja distingue "reiniciou depois do
   * meu deploy" de "processo antigo ainda rodando", o caso mais comum de
   * diagnostico.
   */
  appVersion: string;
  smtp: {
    enabled: boolean;
    host: string;
    port: number;
    secure: boolean;
    user: string | undefined;
    pass: string | undefined;
    from: string;
  };
}

export type AppConfigOverrides = Partial<Omit<AppConfig, "sgp" | "oltCloud" | "regionalIncident" | "sgpSignMock">> & {
  /** Equivale a STRICT_ENV=1 (ver loadConfig). */
  strictEnv?: boolean;
  sgp?: Partial<Omit<AppConfig["sgp"], "chamado" | "sign">> & {
    chamado?: Partial<AppConfig["sgp"]["chamado"]>;
    sign?: Partial<AppConfig["sgp"]["sign"]>;
  };
  oltCloud?: Partial<Omit<AppConfig["oltCloud"], "debug">> & { debug?: Partial<AppConfig["oltCloud"]["debug"]> };
  acessanetConnect?: Partial<AppConfig["acessanetConnect"]>;
  wifi?: Partial<AppConfig["wifi"]>;
  regionalIncident?: Partial<AppConfig["regionalIncident"]>;
  sgpSignMock?: Partial<AppConfig["sgpSignMock"]>;
};

/** TRUST_PROXY: vazio/false -> false; true -> true; "2" -> 2 hops; "10.0.0.1,10.0.0.0/8" -> lista. */
export function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const value = raw?.trim();
  if (!value || value.toLowerCase() === "false") return false;
  if (value.toLowerCase() === "true") return true;
  if (/^\d+$/.test(value)) return Number(value);
  // Fastify/proxy-addr aceita string com IPs/CIDR separados por virgula.
  return parseCsv(value).join(",");
}

/** Origens padrao quando nao ha CORS_ORIGINS e o ambiente e de producao/STRICT_ENV (site + WebView do app Capacitor). */
export const DEFAULT_PRODUCTION_CORS_ORIGINS = ["https://acessanet.com.br", "https://localhost", "capacitor://localhost"];

let warnedAboutEnvironment = false;

/**
 * Ambiente efetivo: APP_ENV (do .env do app) tem prioridade sobre NODE_ENV. Em hospedagens onde NODE_ENV vem do painel
 * e nao pode ser mudado por arquivo, APP_ENV=production no .env do servidor liga o modo producao.
 */
function rawEnvironment(): string | undefined {
  return process.env.APP_ENV ?? process.env.NODE_ENV;
}

export function loadConfig(overrides: AppConfigOverrides = {}): AppConfig {
  const env = (overrides.env ?? (rawEnvironment() as AppConfig["env"]) ?? "development") as AppConfig["env"];
  /**
   * STRICT_ENV=1 (opcional, DESLIGADO por padrao): exige NODE_ENV=production definido e trata o ambiente como
   * producao para segredos fortes, CORS fixo e travas de debug/mock. Nao e o padrao porque o servidor de producao
   * hoje sobe sem NODE_ENV (reporta "development" em /api/health): torna-lo fatal por padrao derrubaria o site
   * no proximo deploy. Ligue so depois de definir NODE_ENV=production e os segredos no .env do servidor.
   */
  const strictEnv = (overrides.strictEnv ?? process.env.STRICT_ENV === "1") === true;
  if (strictEnv && !overrides.env && rawEnvironment() !== "production") {
    throw new Error("STRICT_ENV=1 exige NODE_ENV=production definido explicitamente (hoje: " + (rawEnvironment() ?? "nao definido") + ").");
  }
  /** Producao de verdade OU modo estrito: aplica todas as travas de producao. */
  const prodLike = env === "production" || strictEnv;
  if (!prodLike && !overrides.env && env === "development" && rawEnvironment() === undefined && !warnedAboutEnvironment) {
    warnedAboutEnvironment = true;
    console.warn(
      "[config] ALERTA DE SEGURANCA: NODE_ENV nao esta definido; rodando como 'development' (segredos padrao do repositorio permitidos, " +
        "CORS aberto a qualquer origem, rota de debug da OLT ligada). Em producao defina NODE_ENV=production " +
        "(ou STRICT_ENV=1 para falhar a subida se faltar) e JWT_SECRET/CPF_HASH_SECRET/OTP_HASH_SECRET/ADMIN_JWT_SECRET com 32+ caracteres."
    );
  }

  const jwtSecret = process.env.JWT_SECRET ?? (prodLike ? "" : "local-dev-jwt-secret-change-me");
  const cpfHashSecret = process.env.CPF_HASH_SECRET ?? (prodLike ? "" : "local-dev-cpf-hash-secret-change-me");
  const otpHashSecret = process.env.OTP_HASH_SECRET ?? (prodLike ? "" : "local-dev-otp-hash-secret-change-me");
  // Sem ADMIN_JWT_SECRET, o admin NUNCA assina com o texto padrao (esta no repositorio, que e publico):
  // deriva do JWT_SECRET real. So cai no padrao de dev quando nem o JWT_SECRET existe (maquina local).
  const adminJwtSecret =
    process.env.ADMIN_JWT_SECRET ??
    (prodLike
      ? ""
      : process.env.JWT_SECRET
        ? createHmac("sha256", process.env.JWT_SECRET).update("acessanet/admin-jwt/v1").digest("hex")
        : "local-dev-admin-jwt-secret-change-me");

  if (prodLike && jwtSecret.length < 32 && !overrides.jwtSecret) {
    throw new Error("JWT_SECRET must contain at least 32 characters in production (or STRICT_ENV=1).");
  }
  if (prodLike && cpfHashSecret.length < 32 && !overrides.cpfHashSecret) {
    throw new Error("CPF_HASH_SECRET must contain at least 32 characters in production.");
  }
  if (prodLike && otpHashSecret.length < 32 && !overrides.otpHashSecret) {
    throw new Error("OTP_HASH_SECRET must contain at least 32 characters in production.");
  }
  if (prodLike && adminJwtSecret.length < 32 && !overrides.adminJwtSecret) {
    throw new Error("ADMIN_JWT_SECRET must contain at least 32 characters in production.");
  }

  const corsOriginsEnv = process.env.CORS_ORIGINS?.trim();

  const base: AppConfig = {
    env,
    port: Number(process.env.PORT ?? 9531),
    jwtSecret,
    accessTokenTtlSeconds: Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? 900),
    refreshTokenTtlSeconds: Number(process.env.REFRESH_TOKEN_TTL_SECONDS ?? 60 * 60 * 24 * 30),
    adminJwtSecret,
    adminAccessTokenTtlSeconds: Number(process.env.ADMIN_ACCESS_TOKEN_TTL_SECONDS ?? 900),
    adminRefreshTokenTtlSeconds: Number(process.env.ADMIN_REFRESH_TOKEN_TTL_SECONDS ?? 60 * 60 * 24 * 7),
    /**
     * Sem CORS_ORIGINS: producao/STRICT_ENV usa a lista fixa (nunca "true"); fora disso reflete qualquer origem
     * (dev). CORS_ORIGINS="*" nao e aceito em modo producao -- cai na lista fixa.
     */
    corsOrigins: corsOriginsEnv
      ? prodLike && parseCsv(corsOriginsEnv).includes("*")
        ? DEFAULT_PRODUCTION_CORS_ORIGINS
        : parseCsv(corsOriginsEnv)
      : prodLike
        ? DEFAULT_PRODUCTION_CORS_ORIGINS
        : true,
    // Sem TRUST_PROXY, confia so no proxy reverso da propria maquina (loopback): atras do proxy da Hostinger todo
    // pedido chega de 127.0.0.1, e sem isso todos os visitantes dividiam o mesmo limite por IP. Conexao vinda
    // de fora do loopback nunca tem o X-Forwarded-For aceito. TRUST_PROXY=false desliga.
    trustProxy: process.env.TRUST_PROXY === undefined ? "127.0.0.1,::1" : parseTrustProxy(process.env.TRUST_PROXY),
    sgp: {
      enabled: Boolean(
        (process.env.SGP_APP && process.env.SGP_TOKEN) ||
          (process.env.SGP_BASIC_USERNAME && process.env.SGP_BASIC_PASSWORD)
      ),
      baseUrl: process.env.SGP_BASE_URL ?? "https://acessanet.sgp.net.br",
      app: unwrapEnv(process.env.SGP_APP),
      token: unwrapEnv(process.env.SGP_TOKEN),
      basicUsername: unwrapEnv(process.env.SGP_BASIC_USERNAME),
      basicPassword: unwrapEnv(process.env.SGP_BASIC_PASSWORD),
      timeoutMs: Number(process.env.SGP_TIMEOUT_MS ?? 8000),
      cpfSearchFields: parseCsv(process.env.SGP_CPF_SEARCH_FIELDS ?? "cpfcnpj,cpf_cnpj,cpfCnpj,cpf"),
      // CUSTOMER_ID_HMAC=1: customerId passa a ser HMAC do CPF (ver sgpMapper.ts). Segredo derivado, com separacao de dominio.
      customerIdSecret: process.env.CUSTOMER_ID_HMAC === "1" ? createHmac("sha256", cpfHashSecret).update("acessanet/customer-id/v1").digest("hex") : undefined,
      documentCacheTtlMs: Number(process.env.SGP_DOCUMENT_CACHE_TTL_MS ?? 60_000),
      documentNegativeCacheTtlMs: Number(process.env.SGP_DOCUMENT_NEGATIVE_CACHE_TTL_MS ?? 60_000),
      maxCallsPerMinute: Number(process.env.SGP_MAX_CALLS_PER_MINUTE ?? 1500),
      maxLookupCallsPerMinute: Number(process.env.SGP_MAX_LOOKUP_CALLS_PER_MINUTE ?? 300),
      circuitFailureThreshold: Number(process.env.SGP_CIRCUIT_FAILURE_THRESHOLD ?? 8),
      circuitOpenMs: Number(process.env.SGP_CIRCUIT_OPEN_MS ?? 20_000),
      chamado: {
        app: unwrapEnv(process.env.SGP_CHAMADO_APP) ?? unwrapEnv(process.env.SGP_APP),
        token: unwrapEnv(process.env.SGP_CHAMADO_TOKEN) ?? unwrapEnv(process.env.SGP_TOKEN),
        timeoutMs: Number(process.env.SGP_CHAMADO_TIMEOUT_MS ?? 15000),
        semOs: unwrapEnv(process.env.SGP_CHAMADO_SEM_OS),
        mapping: parseChamadoMapping(process.env.SGP_CHAMADO_MAPPING),
        documents: {
          // 10013 = codigo do tipo ANEXAR DOCUMENTO em /api/central/tipoocorrencia/list/ (id 2335 no relatorio do SGP).
          ocorrenciaTipo: unwrapEnv(process.env.SGP_DOCUMENTS_TIPO) ?? "10013",
          motivoOs: unwrapEnv(process.env.SGP_DOCUMENTS_MOTIVO) ?? "2125",
          // 3 = setor FINANCEIRO, o unico setor desse tipo no SGP.
          setor: unwrapEnv(process.env.SGP_DOCUMENTS_SETOR) ?? "3"
        }
      },
      sign: {
        /**
         * Chave PROPRIA (SGP_SIGN_ENABLED) -- deliberadamente nao derivada
         * de SGP_APP/SGP_TOKEN existirem, ver comentario no tipo AppConfig.
         */
        enabled: process.env.SGP_SIGN_ENABLED === "true",
        app: unwrapEnv(process.env.SGP_SIGN_APP) ?? unwrapEnv(process.env.SGP_APP),
        token: unwrapEnv(process.env.SGP_SIGN_TOKEN) ?? unwrapEnv(process.env.SGP_TOKEN),
        timeoutMs: Number(process.env.SGP_SIGN_TIMEOUT_MS ?? 10000)
      }
    },
    sgpSignMock: {
      /** Trava de seguranca: nunca true em producao, independente da env var. */
      enabled: !prodLike && process.env.SGP_SIGN_MOCK_ENABLED === "true"
    },
    oltCloud: {
      enabled: Boolean(
        process.env.OLTCLOUD_BASE_URL &&
          (process.env.OLTCLOUD_TOKEN || (process.env.OLTCLOUD_USERNAME && process.env.OLTCLOUD_PASSWORD))
      ),
      baseUrl: process.env.OLTCLOUD_BASE_URL ?? "",
      token: unwrapEnv(process.env.OLTCLOUD_TOKEN),
      username: unwrapEnv(process.env.OLTCLOUD_USERNAME),
      password: unwrapEnv(process.env.OLTCLOUD_PASSWORD),
      timeoutMs: Number(process.env.OLTCLOUD_TIMEOUT_MS ?? 8000),
      cacheTtlMs: Number(process.env.OLTCLOUD_CACHE_TTL_MS ?? 45000),
      debug: {
        enabled:
          process.env.OLTCLOUD_DEBUG_ENABLED !== undefined
            ? process.env.OLTCLOUD_DEBUG_ENABLED === "true"
            : !prodLike,
        token: unwrapEnv(process.env.OLTCLOUD_DEBUG_TOKEN)
      }
    },
    contractFeed: {
      token: unwrapEnv(process.env.CONTRACT_FEED_TOKEN)
    },
    marketingFeed: {
      token: unwrapEnv(process.env.MARKETING_FEED_TOKEN)
    },
    chat: {
      tokenSecret: unwrapEnv(process.env.CHAT_TOKEN_SECRET),
      ttlSeconds: Math.min(3600, Math.max(60, Number(process.env.CHAT_TOKEN_TTL_SECONDS ?? 900) || 900)),
      issuer: unwrapEnv(process.env.CHAT_TOKEN_ISSUER) ?? "acessanet-app",
      audience: unwrapEnv(process.env.CHAT_TOKEN_AUDIENCE) ?? "acessanet-chat-api",
      pushToken: unwrapEnv(process.env.CHAT_PUSH_TOKEN)
    },
    wifi: {
      radiusToken: unwrapEnv(process.env.WIFI_RADIUS_TOKEN),
      sessionHours: Number(process.env.WIFI_SESSION_HOURS ?? 4),
      loginHosts: parseCsv(process.env.WIFI_LOGIN_HOSTS ?? "").map((host) => host.toLowerCase())
    },
    acessanetConnect: {
      enabled: Boolean(process.env.ACESSANET_CONNECT_URL && process.env.ACESSANET_CONNECT_TOKEN),
      baseUrl: process.env.ACESSANET_CONNECT_URL ?? "",
      token: unwrapEnv(process.env.ACESSANET_CONNECT_TOKEN),
      timeoutMs: Number(process.env.ACESSANET_CONNECT_TIMEOUT_MS ?? 8000)
    },
    ponOutageSync: {
      intervalSeconds: Number(process.env.OLT_PON_OUTAGE_SYNC_INTERVAL_SECONDS ?? 60)
    },
    regionalIncident: {
      minClients: Number(process.env.REGIONAL_INCIDENT_MIN_CLIENTS ?? 3),
      windowMinutes: Number(process.env.REGIONAL_INCIDENT_WINDOW_MINUTES ?? 10),
      radiusMeters: Number(process.env.REGIONAL_INCIDENT_RADIUS_METERS ?? 800),
      recoveryWindowMinutes: Number(process.env.REGIONAL_INCIDENT_RECOVERY_WINDOW_MINUTES ?? 5),
      refreshTtlMs: Number(process.env.REGIONAL_INCIDENT_REFRESH_TTL_MS ?? 45000),
      equipmentProbeTtlMs: Number(process.env.REGIONAL_INCIDENT_EQUIPMENT_PROBE_TTL_MS ?? 45000)
    },
    cpfHashSecret,
    otpHashSecret,
    sqlitePath: process.env.SQLITE_PATH ?? path.join(serverRoot, "data", "auth.sqlite"),
    dbDriver: process.env.DB_DRIVER === "mysql" ? "mysql" : "sqlite",
    mysql: {
      host: process.env.MYSQL_HOST ?? "localhost",
      port: Number(process.env.MYSQL_PORT ?? 3306),
      user: process.env.MYSQL_USER ?? "",
      password: process.env.MYSQL_PASSWORD ?? "",
      database: process.env.MYSQL_DATABASE ?? ""
    },
    staticDir: process.env.STATIC_DIR ? path.resolve(process.env.STATIC_DIR) : path.resolve(process.cwd(), "public"),
    appVersion: process.env.APP_VERSION ?? `boot-${new Date().toISOString()}`,
    smtp: {
      enabled: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
      host: process.env.SMTP_HOST ?? "",
      port: Number(process.env.SMTP_PORT ?? 465),
      secure: (process.env.SMTP_SECURE ?? "true") !== "false",
      user: unwrapEnv(process.env.SMTP_USER),
      pass: unwrapEnv(process.env.SMTP_PASS),
      from: process.env.SMTP_FROM ?? process.env.SMTP_USER ?? ""
    }
  };

  return {
    ...base,
    ...overrides,
    sgp: {
      ...base.sgp,
      ...overrides.sgp,
      chamado: { ...base.sgp.chamado, ...overrides.sgp?.chamado },
      sign: { ...base.sgp.sign, ...overrides.sgp?.sign }
    },
    acessanetConnect: {
      ...base.acessanetConnect,
      ...overrides.acessanetConnect
    },
    wifi: { ...base.wifi, ...overrides.wifi },
    oltCloud: {
      ...base.oltCloud,
      ...overrides.oltCloud,
      debug: { ...base.oltCloud.debug, ...overrides.oltCloud?.debug }
    },
    regionalIncident: {
      ...base.regionalIncident,
      ...overrides.regionalIncident
    },
    sgpSignMock: {
      /** Trava de seguranca reaplicada aqui: nenhum override pode ligar mock em producao. */
      enabled: !prodLike && (overrides.sgpSignMock?.enabled ?? base.sgpSignMock.enabled)
    }
  };
}

function parseChamadoMapping(value: string | undefined): Record<string, { ocorrenciaTipo: string; motivoOs: string }> {
  if (!value || !value.trim()) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      "SGP_CHAMADO_MAPPING precisa ser um JSON valido, ex: " +
        '{"FALHA_REDE_ACESSO":{"ocorrenciaTipo":"3","motivoOs":"12"}}'
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SGP_CHAMADO_MAPPING precisa ser um objeto JSON (classificacao -> {ocorrenciaTipo, motivoOs}).");
  }

  const mapping: Record<string, { ocorrenciaTipo: string; motivoOs: string }> = {};
  for (const [classification, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`SGP_CHAMADO_MAPPING: entrada invalida para "${classification}".`);
    }

    const ocorrenciaTipo = String((entry as Record<string, unknown>).ocorrenciaTipo ?? "").trim();
    const motivoOs = String((entry as Record<string, unknown>).motivoOs ?? "").trim();
    if (!ocorrenciaTipo || !motivoOs) {
      throw new Error(
        `SGP_CHAMADO_MAPPING: "${classification}" precisa de ocorrenciaTipo e motivoOs nao vazios.`
      );
    }

    mapping[classification] = { ocorrenciaTipo, motivoOs };
  }

  return mapping;
}

function parseCsv(value: string) {
  return value
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function unwrapEnv(value: string | undefined) {
  if (!value) {
    return value;
  }
  return value.trim().replace(/^["']|["']$/g, "") || undefined;
}
