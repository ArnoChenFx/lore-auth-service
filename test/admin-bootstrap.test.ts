import { afterEach, describe, expect, test } from "bun:test";

import { createRefreshToken, createUser, getUserByUsername, hashRefreshToken } from "../src/db";
import { createHttpHandler, startAuthService } from "../src/index";
import { createTestContext, releaseTestContexts } from "./support/context";

const ORIGIN = "https://auth.example.test";

afterEach(releaseTestContexts);

function loginRequest(username: string, password: string): Request {
  return new Request(`${ORIGIN}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

describe("administrator bootstrap", () => {
  test("creates the administrator with the configured password in an empty database", async () => {
    const context = await createTestContext({
      adminPassword: "first-run-password",
    });

    const service = await startAuthService(context);
    try {
      const handle = createHttpHandler(context);
      expect((await handle(loginRequest("admin", "first-run-password"))).status).toBe(200);
    } finally {
      await service.close();
    }
  });

  test("replaces a stored built-in default password on the next start", async () => {
    const context = await createTestContext({ adminPassword: "rotated-admin-password" });
    const admin = createUser(context.config.dbPath, "admin", "changeme", true);
    const handle = createHttpHandler(context);
    const refreshToken = "stale-refresh-token-value";
    createRefreshToken(context.config.dbPath, admin.id, hashRefreshToken(refreshToken), 3600);

    const service = await startAuthService(context);
    try {
      expect((await handle(loginRequest("admin", "changeme"))).status).toBe(401);
      expect((await handle(loginRequest("admin", "rotated-admin-password"))).status).toBe(200);
      expect(
        (
          await handle(
            new Request(`${ORIGIN}/auth/refresh`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ refresh_token: refreshToken }),
            }),
          )
        ).status,
      ).toBe(401);
    } finally {
      await service.close();
    }
  });

  test("replaces the placeholder password from the example environment file", async () => {
    const context = await createTestContext({ adminPassword: "rotated-admin-password" });
    createUser(
      context.config.dbPath,
      "admin",
      "replace-with-a-long-random-password",
      true,
    );

    const service = await startAuthService(context);
    try {
      const handle = createHttpHandler(context);
      expect(
        (await handle(loginRequest("admin", "replace-with-a-long-random-password"))).status,
      ).toBe(401);
      expect((await handle(loginRequest("admin", "rotated-admin-password"))).status).toBe(200);
    } finally {
      await service.close();
    }
  });

  test("never overwrites a custom administrator password", async () => {
    const context = await createTestContext({ adminPassword: "new-configured-password" });
    createUser(context.config.dbPath, "admin", "custom-admin-password", true);

    const service = await startAuthService(context);
    try {
      const handle = createHttpHandler(context);
      expect((await handle(loginRequest("admin", "custom-admin-password"))).status).toBe(200);
      expect((await handle(loginRequest("admin", "new-configured-password"))).status).toBe(401);
    } finally {
      await service.close();
    }
  });

  test("leaves the built-in password in place when development mode configures it", async () => {
    const context = await createTestContext({
      adminPassword: "changeme",
      allowInsecureDefaultAdminPassword: true,
    });
    createUser(context.config.dbPath, "admin", "changeme", true);

    const service = await startAuthService(context);
    try {
      const handle = createHttpHandler(context);
      expect((await handle(loginRequest("admin", "changeme"))).status).toBe(200);
    } finally {
      await service.close();
    }
  });

  test("does not create a new administrator when the configured one was removed", async () => {
    const context = await createTestContext({ adminUsername: "ops-admin" });
    createUser(context.config.dbPath, "root", "root-password", true);

    const service = await startAuthService(context);
    try {
      expect(getUserByUsername(context.config.dbPath, "ops-admin")).toBeNull();
    } finally {
      await service.close();
    }
  });
});
