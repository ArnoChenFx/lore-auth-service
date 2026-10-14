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
  "LOGIN_MAX_FAILURES_PER_USER_IP",
  "LOGIN_MAX_FAILURES_PER_IP",
  "LOGIN_MAX_FAILING_IPS_PER_ACCOUNT",
  "LOGIN_LOCK_BASE_SECONDS",
  "LOGIN_LOCK_MAX_SECONDS",
  "LOGIN_RECENT_SUCCESS_SECONDS",
  "TRUSTED_PROXY_COUNT",
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

describe("login throttling configuration", () => {
  test("uses the documented defaults", () => {
    process.env.ADMIN_PASSWORD = "correct horse battery";

    const config = loadConfig();

    expect(config.loginMaxFailuresPerUserIp).toBe(5);
    expect(config.loginMaxFailuresPerIp).toBe(100);
    expect(config.loginMaxFailingIpsPerAccount).toBe(50);
    expect(config.loginLockBaseSeconds).toBe(60);
    expect(config.loginLockMaxSeconds).toBe(900);
    expect(config.loginRecentSuccessSeconds).toBe(30 * 24 * 60 * 60);
    expect(config.trustedProxyCount).toBe(0);
  });

  test("treats zero as disabling a limit", () => {
    process.env.ADMIN_PASSWORD = "correct horse battery";
    process.env.LOGIN_MAX_FAILURES_PER_USER_IP = "0";
    process.env.LOGIN_MAX_FAILURES_PER_IP = "0";
    process.env.LOGIN_MAX_FAILING_IPS_PER_ACCOUNT = "0";

    const config = loadConfig();

    expect(config.loginMaxFailuresPerUserIp).toBe(0);
    expect(config.loginMaxFailuresPerIp).toBe(0);
    expect(config.loginMaxFailingIpsPerAccount).toBe(0);
  });

  test("refuses an account threshold that a single address could reach alone", () => {
    process.env.ADMIN_PASSWORD = "correct horse battery";
    process.env.LOGIN_MAX_FAILING_IPS_PER_ACCOUNT = "1";

    expect(() => loadConfig()).toThrow("must be 0 or at least 2");
  });

  test("refuses negative limits and a maximum lock shorter than the base lock", () => {
    process.env.ADMIN_PASSWORD = "correct horse battery";
    process.env.LOGIN_MAX_FAILURES_PER_IP = "-1";
    expect(() => loadConfig()).toThrow("LOGIN_MAX_FAILURES_PER_IP must be a non-negative integer");

    process.env.LOGIN_MAX_FAILURES_PER_IP = "100";
    process.env.LOGIN_LOCK_BASE_SECONDS = "600";
    process.env.LOGIN_LOCK_MAX_SECONDS = "60";
    expect(() => loadConfig()).toThrow("must not be smaller than LOGIN_LOCK_BASE_SECONDS");

    process.env.LOGIN_LOCK_BASE_SECONDS = "60";
    process.env.LOGIN_RECENT_SUCCESS_SECONDS = "-1";
    expect(() => loadConfig()).toThrow("LOGIN_RECENT_SUCCESS_SECONDS must be a non-negative integer");

    process.env.LOGIN_RECENT_SUCCESS_SECONDS = "0";
    expect(loadConfig().loginRecentSuccessSeconds).toBe(0);

    process.env.LOGIN_RECENT_SUCCESS_SECONDS = "60";
    process.env.TRUSTED_PROXY_COUNT = "-2";
    expect(() => loadConfig()).toThrow("TRUSTED_PROXY_COUNT must be a non-negative integer");
  });
});
