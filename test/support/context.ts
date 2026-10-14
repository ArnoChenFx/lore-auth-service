import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generateKeyPair } from "jose";

import type { AppConfig } from "../../src/config";
import type { AuthServiceContext } from "../../src/context";
import { closeDb } from "../../src/db";
import { buildJwks, type KeyMaterial } from "../../src/keys";

interface TemporaryDatabase {
  directory: string;
  dbPath: string;
}

const temporaryDatabases: TemporaryDatabase[] = [];

export async function createTestContext(
  overrides: Partial<AppConfig> = {},
): Promise<AuthServiceContext> {
  const directory = mkdtempSync(join(tmpdir(), "lore-auth-test-"));
  const dbPath = join(directory, "auth.db");
  temporaryDatabases.push({ directory, dbPath });

  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const keys: KeyMaterial = {
    publicKey,
    privateKey,
    kid: "test-key",
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
    dbPath,
    adminUsername: "admin",
    adminPassword: "test-password",
    keyAlg: "RS256",
    tlsCertFile: null,
    tlsKeyFile: null,
    ...overrides,
  };
  return { config, keys, jwks: await buildJwks(keys) };
}

export function releaseTestContexts(): void {
  for (const { directory, dbPath } of temporaryDatabases.splice(0)) {
    closeDb(dbPath);
    rmSync(directory, { recursive: true, force: true });
  }
}
