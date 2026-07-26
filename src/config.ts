/**
 * config.ts — Load configuration from environment variables with defaults
 */

export interface AppConfig {
  port: number;
  issuer: string;
  audience: string;
  tokenTtl: number;
  keyDir: string;
  dbPath: string;
  adminUsername: string;
  adminPassword: string;
  keyAlg: string;
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

export function loadConfig(): AppConfig {
  return {
    port: envInt("PORT", 8080),
    issuer: env("JWT_ISSUER", "http://localhost:8080"),
    audience: env("JWT_AUDIENCE", "lore-service"),
    tokenTtl: envInt("TOKEN_TTL", 3600),
    keyDir: env("KEY_DIR", "./keys"),
    dbPath: env("DB_PATH", "./lore-auth.db"),
    adminUsername: env("ADMIN_USERNAME", "admin"),
    adminPassword: env("ADMIN_PASSWORD", "changeme"),
    keyAlg: "RS256",
  };
}