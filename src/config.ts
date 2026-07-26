/**
 * config.ts — Load configuration from environment variables with defaults
 */

export interface AppConfig {
  host: string;
  port: number;
  grpcHost: string;
  grpcPort: number;
  issuer: string;
  audience: string[];
  publicBaseUrl: string;
  environment: string;
  tokenTtl: number;
  refreshTokenTtl: number;
  authSessionTtl: number;
  authSessionMaxAttempts: number;
  authSessionLockSeconds: number;
  keyDir: string;
  dbPath: string;
  adminUsername: string;
  adminPassword: string;
  keyAlg: string;
  tlsCertFile: string | null;
  tlsKeyFile: string | null;
}

function env(key: string, fallback: string): string {
  return process.env[key]?.trim() || fallback;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return isNaN(n) ? fallback : n;
}

/**
 * 将逗号分隔的环境变量解析为稳定列表。Lore 会把 JWT `aud` 同时用于服务端
 * 验签和客户端防泄漏校验，因此这里拒绝空项，避免产生看似可用但无法投递的 Token。
 */
function envList(key: string, fallback: string[]): string[] {
  const value = process.env[key]?.trim();
  if (!value) return fallback;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? [...new Set(items)] : fallback;
}

function envOptional(key: string): string | null {
  return process.env[key]?.trim() || null;
}

function assertPositive(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function assertHttpUrl(name: string, value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTP or HTTPS URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} must not contain credentials, query, or fragment`);
  }
}

export function loadConfig(): AppConfig {
  const issuer = env("JWT_ISSUER", "http://localhost:8080").replace(/\/+$/, "");
  const config: AppConfig = {
    host: env("HOST", "0.0.0.0"),
    port: envInt("PORT", 8080),
    grpcHost: env("GRPC_HOST", "0.0.0.0"),
    grpcPort: envInt("GRPC_PORT", 50051),
    issuer,
    // 默认 localhost 只服务本机开发；真实部署必须显式填写 Lore Server 域名。
    audience: envList("JWT_AUDIENCE", ["localhost"]),
    publicBaseUrl: env("PUBLIC_BASE_URL", issuer).replace(/\/+$/, ""),
    environment: env("LORE_ENVIRONMENT", "local"),
    tokenTtl: envInt("TOKEN_TTL", 43200),
    refreshTokenTtl: envInt("REFRESH_TOKEN_TTL", 7 * 24 * 60 * 60),
    // Lore 当前最多轮询 150 秒，默认 5 分钟为浏览器操作留出余量。
    authSessionTtl: envInt("AUTH_SESSION_TTL", 300),
    authSessionMaxAttempts: envInt("AUTH_SESSION_MAX_ATTEMPTS", 5),
    authSessionLockSeconds: envInt("AUTH_SESSION_LOCK_SECONDS", 60),
    keyDir: env("KEY_DIR", "./keys"),
    dbPath: env("DB_PATH", "./lore-auth.db"),
    adminUsername: env("ADMIN_USERNAME", "admin"),
    adminPassword: env("ADMIN_PASSWORD", "changeme"),
    keyAlg: "RS256",
    tlsCertFile: envOptional("TLS_CERT_FILE"),
    tlsKeyFile: envOptional("TLS_KEY_FILE"),
  };
  assertPositive("PORT", config.port);
  assertPositive("GRPC_PORT", config.grpcPort);
  assertPositive("TOKEN_TTL", config.tokenTtl);
  assertPositive("REFRESH_TOKEN_TTL", config.refreshTokenTtl);
  assertPositive("AUTH_SESSION_TTL", config.authSessionTtl);
  assertPositive("AUTH_SESSION_MAX_ATTEMPTS", config.authSessionMaxAttempts);
  assertPositive("AUTH_SESSION_LOCK_SECONDS", config.authSessionLockSeconds);
  assertHttpUrl("JWT_ISSUER", config.issuer);
  assertHttpUrl("PUBLIC_BASE_URL", config.publicBaseUrl);
  if (Boolean(config.tlsCertFile) !== Boolean(config.tlsKeyFile)) {
    throw new Error("TLS_CERT_FILE and TLS_KEY_FILE must be configured together");
  }
  return config;
}
