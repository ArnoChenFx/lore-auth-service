import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config";

const CONFIG_ENV_KEYS = [
  "HOST",
  "PORT",
  "GRPC_HOST",
  "GRPC_PORT",
  "JWT_ISSUER",
  "JWT_AUDIENCE",
  "PUBLIC_BASE_URL",
  "LORE_ENVIRONMENT",
  "TOKEN_TTL",
  "REFRESH_TOKEN_TTL",
  "AUTH_SESSION_TTL",
  "AUTH_SESSION_MAX_ATTEMPTS",
  "AUTH_SESSION_LOCK_SECONDS",
  "KEY_DIR",
  "DB_PATH",
  "ADMIN_USERNAME",
  "ADMIN_PASSWORD",
  "ALLOW_INSECURE_DEFAULT_ADMIN_PASSWORD",
  "TLS_CERT_FILE",
  "TLS_KEY_FILE",
];

let savedEnvironment: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnvironment = Object.fromEntries(
    CONFIG_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  for (const key of CONFIG_ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of CONFIG_ENV_KEYS) {
    const value = savedEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("administrator password configuration", () => {
  test("refuses to start when ADMIN_PASSWORD is not provided", () => {
    expect(() => loadConfig()).toThrow("ADMIN_PASSWORD must be set");
  });

  test("refuses the built-in changeme password without the development flag", () => {
    process.env.ADMIN_PASSWORD = "changeme";

    expect(() => loadConfig()).toThrow("publicly documented value");
  });

  test("refuses the placeholder copied from the example environment files", () => {
    process.env.ADMIN_PASSWORD = "replace-with-a-long-random-password";

    expect(() => loadConfig()).toThrow("publicly documented value");
  });

  test("allows the built-in password only when the development flag is set", () => {
    process.env.ADMIN_PASSWORD = "changeme";
    process.env.ALLOW_INSECURE_DEFAULT_ADMIN_PASSWORD = "true";

    const config = loadConfig();

    expect(config.adminPassword).toBe("changeme");
    expect(config.allowInsecureDefaultAdminPassword).toBe(true);
  });

  test("uses changeme for an unset ADMIN_PASSWORD only in development mode", () => {
    process.env.ALLOW_INSECURE_DEFAULT_ADMIN_PASSWORD = "true";

    expect(loadConfig().adminPassword).toBe("changeme");
  });

  test("ignores the development flag unless it is exactly true", () => {
    process.env.ADMIN_PASSWORD = "changeme";
    process.env.ALLOW_INSECURE_DEFAULT_ADMIN_PASSWORD = "yes";

    expect(() => loadConfig()).toThrow("publicly documented value");
  });

  test("requires at least eight characters", () => {
    process.env.ADMIN_PASSWORD = "short";

    expect(() => loadConfig()).toThrow("at least 8 characters");
  });

  test("accepts a unique administrator password", () => {
    process.env.ADMIN_PASSWORD = "correct horse battery";

    const config = loadConfig();

    expect(config.adminPassword).toBe("correct horse battery");
    expect(config.allowInsecureDefaultAdminPassword).toBe(false);
  });

  test("keeps the documented ten-day access token lifetime by default", () => {
    process.env.ADMIN_PASSWORD = "correct horse battery";

    expect(loadConfig().tokenTtl).toBe(10 * 24 * 60 * 60);
  });
});
