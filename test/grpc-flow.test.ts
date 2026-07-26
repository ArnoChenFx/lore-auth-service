import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  Metadata,
  credentials,
  loadPackageDefinition,
  type Client,
  type ServiceClientConstructor,
} from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { generateKeyPair } from "jose";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { AppConfig } from "../src/config";
import type { AuthServiceContext } from "../src/context";
import {
  approveAuthSession,
  closeDb,
  createUser,
} from "../src/db";
import { startGrpcServer, type RunningGrpcServer } from "../src/grpc-server";
import { verifyToken } from "../src/jwt";
import type { KeyMaterial } from "../src/keys";

type DynamicClient = Client & Record<string, Function>;

const directory = mkdtempSync(join(tmpdir(), "lore-auth-grpc-"));
const dbPath = join(directory, "auth.db");
let context: AuthServiceContext;
let running: RunningGrpcServer;
let authClient: DynamicClient;
let rebacClient: DynamicClient;

function call<Response>(
  client: DynamicClient,
  method: string,
  request: Record<string, unknown>,
  token?: string,
): Promise<Response> {
  const metadata = new Metadata();
  if (token) metadata.set("authorization", `Bearer ${token}`);
  return new Promise((resolve, reject) => {
    client[method](request, metadata, (error: Error | null, response: Response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

beforeAll(async () => {
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
    keyDir: join(directory, "unused-keys"),
    dbPath,
    adminUsername: "admin",
    adminPassword: "admin-password",
    keyAlg: "RS256",
    tlsCertFile: null,
    tlsKeyFile: null,
  };
  const pair = await generateKeyPair("RS256");
  const keys: KeyMaterial = {
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    kid: "grpc-test-key",
    alg: "RS256",
  };
  context = { config, keys, jwks: { keys: [] } };
  createUser(dbPath, "alice", "alice-password", false);
  running = await startGrpcServer(context);

  const definition = loadSync(join(import.meta.dir, "..", "proto", "auth_api.proto"), {
    keepCase: true,
    longs: Number,
    defaults: true,
    oneofs: true,
  });
  const root = loadPackageDefinition(definition) as Record<string, any>;
  const Constructor = root.epic_urc.UrcAuthApi as ServiceClientConstructor;
  authClient = new Constructor(
    `127.0.0.1:${running.port}`,
    credentials.createInsecure(),
  ) as DynamicClient;

  const rebacDefinition = loadSync(
    join(import.meta.dir, "..", "proto", "rebac_api.proto"),
    {
      keepCase: true,
      longs: Number,
      defaults: true,
      oneofs: true,
    },
  );
  const rebacRoot = loadPackageDefinition(rebacDefinition) as Record<string, any>;
  const RebacConstructor = rebacRoot.ucs.auth.RebacApi as ServiceClientConstructor;
  rebacClient = new RebacConstructor(
    `127.0.0.1:${running.port}`,
    credentials.createInsecure(),
  ) as DynamicClient;
});

afterAll(async () => {
  authClient.close();
  rebacClient.close();
  await running.close();
  closeDb(dbPath);
  rmSync(directory, { recursive: true, force: true });
});

describe("Lore gRPC authentication flow", () => {
  test("browser approval returns AuthN and repository-scoped AuthZ tokens", async () => {
    const start = await call<{
      session_code: string;
      login_url: string;
    }>(authClient, "StartAuthSession", {
      client_state: "client-state-grpc-test",
    });
    expect(start.session_code.length).toBeGreaterThan(32);
    expect(start.login_url).toContain("/login?");

    const approval = approveAuthSession(
      dbPath,
      "client-state-grpc-test",
      start.session_code,
      "alice",
      "alice-password",
      5,
      60,
    );
    expect(approval.ok).toBe(true);

    const polled = await call<{
      user_token: { user_token: string; user_id: string; expires_at: number };
    }>(authClient, "GetAuthSession", {
      client_state: "client-state-grpc-test",
      session_code: start.session_code,
    });
    expect(polled.user_token.user_id).toBe("1");
    const authn = polled.user_token.user_token;
    expect((await verifyToken(context.keys, context.config, authn))?.name).toBe("alice");

    const resourceId = `urc-${"b".repeat(32)}`;
    await call(
      rebacClient,
      "CreateResource",
      { resource_id: resourceId, resource_name: "browser-flow" },
      authn,
    );
    const permissions = await call<{
      resource_permission: Array<{ resource_id: string; permission: string[] }>;
    }>(
      authClient,
      "LookupUserPermissions",
      { resource_filter: "urc" },
      authn,
    );
    expect(permissions.resource_permission[0]?.resource_id).toBe(resourceId);

    const exchanged = await call<{
      token: { user_token: string };
    }>(
      authClient,
      "ExchangeUserTokenForMultiresourceToken",
      { resource_id: [resourceId] },
      authn,
    );
    const authz = await verifyToken(
      context.keys,
      context.config,
      exchanged.token.user_token,
    );
    expect(authz?.resources).toEqual([
      {
        resource_id: resourceId,
        permission: ["admin", "read", "write"],
      },
    ]);
  });
});
