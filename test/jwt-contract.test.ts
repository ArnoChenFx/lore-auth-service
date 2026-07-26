import { describe, expect, test } from "bun:test";
import { decodeJwt, generateKeyPair } from "jose";

import type { AppConfig } from "../src/config";
import { issueToken } from "../src/jwt";
import type { KeyMaterial } from "../src/keys";

/**
 * 构造完全位于内存中的签名材料，避免契约测试在仓库里生成一次性密钥文件。
 */
async function createTestKeys(): Promise<KeyMaterial> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  return {
    publicKey,
    privateKey,
    kid: "contract-test-key",
    alg: "RS256",
  };
}

const config: AppConfig = {
  host: "127.0.0.1",
  port: 8080,
  grpcHost: "127.0.0.1",
  grpcPort: 50051,
  issuer: "https://auth.example.test",
  audience: ["lore.example.test"],
  publicBaseUrl: "https://auth.example.test",
  environment: "local",
  tokenTtl: 3600,
  refreshTokenTtl: 7200,
  authSessionTtl: 300,
  authSessionMaxAttempts: 5,
  authSessionLockSeconds: 60,
  keyDir: "./unused-test-keys",
  dbPath: ":memory:",
  adminUsername: "admin",
  adminPassword: "test-only",
  keyAlg: "RS256",
  tlsCertFile: null,
  tlsKeyFile: null,
};

describe("Lore JWT contract", () => {
  test("authentication token contains all claims required by Lore", async () => {
    const token = await issueToken(await createTestKeys(), config, "42", {
      username: "alice",
      is_admin: false,
    });
    const payload = decodeJwt(token);

    expect(payload.sub).toBe("42");
    expect(payload.iss).toBe(config.issuer);
    expect(payload.aud).toEqual(config.audience);
    expect(payload.env).toBe("local");
    expect(payload.name).toBe("alice");
    expect(payload.preferred_username).toBe("alice");
    expect(payload.is_service_account).toBe(false);
  });
});
