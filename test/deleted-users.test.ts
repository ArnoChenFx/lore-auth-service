import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  Metadata,
  credentials,
  loadPackageDefinition,
  status,
  type Client,
  type ServiceClientConstructor,
} from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { join } from "path";

import { createUser, deleteUser } from "../src/db";
import { createHttpHandler, startAuthService } from "../src/index";
import { issueToken } from "../src/jwt";
import { createTestContext, releaseTestContexts } from "./support/context";

const ORIGIN = "https://auth.example.test";

type DynamicClient = Client & Record<string, Function>;

afterEach(releaseTestContexts);

function bearerGet(path: string, token: string): Request {
  return new Request(`${ORIGIN}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

async function loginToken(
  handle: (req: Request) => Promise<Response>,
  username: string,
  password: string,
): Promise<string> {
  const response = await handle(
    new Request(`${ORIGIN}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    }),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

function grpcCall<Response>(
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

function grpcClientFor(port: number): { authClient: DynamicClient; close: () => void } {
  const definition = loadSync(join(import.meta.dir, "..", "proto", "auth_api.proto"), {
    keepCase: true,
    longs: Number,
    defaults: true,
    oneofs: true,
  });
  const root = loadPackageDefinition(definition) as Record<string, any>;
  const Constructor = root.epic_urc.UrcAuthApi as ServiceClientConstructor;
  const authClient = new Constructor(
    `127.0.0.1:${port}`,
    credentials.createInsecure(),
  ) as DynamicClient;
  return { authClient, close: () => authClient.close() };
}

describe("deleted users lose access on the REST API", () => {
  test("rejects a previously issued access token on /auth/me after deletion", async () => {
    const context = await createTestContext();
    createUser(context.config.dbPath, "alice", "alice-password", false);
    const handle = createHttpHandler(context);
    const token = await loginToken(handle, "alice", "alice-password");

    expect((await handle(bearerGet("/auth/me", token))).status).toBe(200);

    expect(deleteUser(context.config.dbPath, "alice")).toBe(true);

    const response = await handle(bearerGet("/auth/me", token));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Token is invalid or expired" });
  });

  test("rejects a deleted administrator's token on administration endpoints", async () => {
    const context = await createTestContext();
    createUser(context.config.dbPath, "root", "root-password", true);
    createUser(context.config.dbPath, "second-admin", "second-password", true);
    const handle = createHttpHandler(context);
    const token = await loginToken(handle, "second-admin", "second-password");

    expect((await handle(bearerGet("/admin/users", token))).status).toBe(200);

    deleteUser(context.config.dbPath, "second-admin");

    const response = await handle(bearerGet("/admin/users", token));
    expect(response.status).toBe(401);
  });

  test("does not transfer an old token to a new user created with the same username", async () => {
    const context = await createTestContext();
    createUser(context.config.dbPath, "root", "root-password", true);
    createUser(context.config.dbPath, "alice", "alice-password", false);
    const handle = createHttpHandler(context);
    const oldToken = await loginToken(handle, "alice", "alice-password");

    deleteUser(context.config.dbPath, "alice");
    createUser(context.config.dbPath, "alice", "new-alice-password", false);

    expect((await handle(bearerGet("/auth/me", oldToken))).status).toBe(401);
  });

  test("takes administrator rights from the stored user record rather than the token claim", async () => {
    const context = await createTestContext();
    createUser(context.config.dbPath, "root", "root-password", true);
    const ops = createUser(context.config.dbPath, "ops", "ops-password", true);
    const token = await issueToken(context.keys, context.config, String(ops.id), {
      username: ops.username,
      is_admin: true,
    });
    const handle = createHttpHandler(context);
    expect((await handle(bearerGet("/admin/users", token))).status).toBe(200);

    const database = new Database(context.config.dbPath);
    database.run("UPDATE users SET is_admin = 0 WHERE id = ?", [ops.id]);
    database.close();

    expect((await handle(bearerGet("/admin/users", token))).status).toBe(403);
    const me = await handle(bearerGet("/auth/me", token));
    expect(((await me.json()) as { user: { is_admin: boolean } }).user.is_admin).toBe(false);
  });
});

describe("deleted users lose access on the gRPC API", () => {
  test("rejects a deleted user's token on VerifyUser and permission lookups", async () => {
    const context = await createTestContext();
    createUser(context.config.dbPath, "alice", "alice-password", false);
    const service = await startAuthService(context);
    const { authClient, close } = grpcClientFor(service.grpc.port);
    try {
      const token = await loginToken(createHttpHandler(context), "alice", "alice-password");

      const verified = await grpcCall<{ user_info: { user_id: string } }>(
        authClient,
        "VerifyUser",
        { target_user: { user_token: token } },
      );
      expect(verified.user_info.user_id).toBe("1");

      deleteUser(context.config.dbPath, "alice");

      const verifyError = await grpcCall(authClient, "VerifyUser", {
        target_user: { user_token: token },
      }).catch((error: { code?: number }) => error);
      expect(verifyError).toMatchObject({ code: status.UNAUTHENTICATED });

      const lookupError = await grpcCall(
        authClient,
        "LookupUserPermissions",
        { resource_filter: "urc" },
        token,
      ).catch((error: { code?: number }) => error);
      expect(lookupError).toMatchObject({ code: status.UNAUTHENTICATED });
    } finally {
      close();
      await service.close();
    }
  });
});
