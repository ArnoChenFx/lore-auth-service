import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPair } from "jose";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { AppConfig } from "../src/config";
import type { AuthServiceContext } from "../src/context";
import {
  closeDb,
  createAuthSession,
  createUser,
  getApprovedSessionUser,
} from "../src/db";
import { createHttpHandler, startAuthService } from "../src/index";
import { buildJwks, type KeyMaterial } from "../src/keys";

const temporaryDirectories: string[] = [];

async function createTestContext(): Promise<AuthServiceContext> {
  const directory = mkdtempSync(join(tmpdir(), "lore-auth-browser-"));
  temporaryDirectories.push(directory);
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const keys: KeyMaterial = {
    publicKey,
    privateKey,
    kid: "browser-login-test",
    alg: "RS256",
  };
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    grpcHost: "127.0.0.1",
    grpcPort: 0,
    issuer: "https://auth.example.test",
    audience: ["lore.example.test"],
    publicBaseUrl: "https://auth.example.test",
    environment: "test",
    tokenTtl: 3600,
    refreshTokenTtl: 7200,
    authSessionTtl: 300,
    authSessionMaxAttempts: 5,
    authSessionLockSeconds: 60,
    keyDir: join(directory, "keys"),
    dbPath: join(directory, "auth.db"),
    adminUsername: "admin",
    adminPassword: "test-password",
    keyAlg: "RS256",
    tlsCertFile: null,
    tlsKeyFile: null,
  };
  return { config, keys, jwks: await buildJwks(keys) };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    closeDb(join(directory, "auth.db"));
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("browser login flow", () => {
  test("starts the combined HTTP and gRPC service and reports healthy", async () => {
    const context = await createTestContext();
    const service = await startAuthService(context);
    try {
      const response = await fetch(
        `http://127.0.0.1:${service.http.port}/health_check`,
      );
      const health = (await response.json()) as { status: string };

      expect(response.status).toBe(200);
      expect(health.status).toBe("ok");
      expect(service.grpc.port).toBeGreaterThan(0);
    } finally {
      await service.close();
    }
  });

  test("renders the login page and approves the Lore session without exposing JWT", async () => {
    const context = await createTestContext();
    createUser(context.config.dbPath, "alice", "alice-password", false);
    const session = createAuthSession(
      context.config.dbPath,
      "browser-client-state",
      context.config.authSessionTtl,
    );
    const handle = createHttpHandler(context);
    const query = new URLSearchParams({
      session_code: session.sessionCode,
      client_state: "browser-client-state",
    });

    const pageResponse = await handle(
      new Request(`https://auth.example.test/login?${query}`),
    );
    const page = await pageResponse.text();
    expect(pageResponse.status).toBe(200);
    expect(pageResponse.headers.get("Content-Security-Policy")).toContain(
      "form-action 'self'",
    );
    expect(page).toContain('name="username"');
    expect(page).toContain('name="password"');
    expect(page).not.toContain("eyJ");

    const form = new FormData();
    form.set("session_code", session.sessionCode);
    form.set("client_state", "browser-client-state");
    form.set("username", "alice");
    form.set("password", "alice-password");
    const approvalResponse = await handle(
      new Request("https://auth.example.test/auth/session/approve", {
        method: "POST",
        body: form,
      }),
    );
    const successPage = await approvalResponse.text();

    expect(approvalResponse.status).toBe(200);
    expect(successPage).toContain("alice");
    expect(successPage).not.toContain("eyJ");
    expect(
      getApprovedSessionUser(
        context.config.dbPath,
        "browser-client-state",
        session.sessionCode,
      )?.username,
    ).toBe("alice");
  });

  test("rejects an unknown or expired browser session", async () => {
    const context = await createTestContext();
    const handle = createHttpHandler(context);
    const response = await handle(
      new Request(
        "https://auth.example.test/login?session_code=unknown&client_state=unknown",
      ),
    );

    expect(response.status).toBe(410);
    expect(await response.text()).toContain("登录会话无效或已经过期");
  });
});
