import { afterEach, describe, expect, spyOn, test } from "bun:test";

import {
  createResource,
  createUser,
  getUserResourcePermissions,
  setUserResourcePermissions,
} from "../src/db";
import { createHttpHandler, startAuthService } from "../src/index";
import { issueToken } from "../src/jwt";
import { createTestContext, releaseTestContexts } from "./support/context";

const JSON_LIMIT = 64 * 1024;
const FORM_LIMIT = 16 * 1024;
const ORIGIN = "https://auth.example.test";

afterEach(releaseTestContexts);

function loginJson(totalBytes: number): string {
  const base = JSON.stringify({ username: "alice", password: "alice-password", padding: "" });
  const padding = "x".repeat(totalBytes - base.length);
  return JSON.stringify({ username: "alice", password: "alice-password", padding });
}

function chunkedStream(text: string, chunkBytes: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkBytes));
      offset += chunkBytes;
    },
  });
}

function endlessStream(chunkBytes: number, maxBytes: number): {
  body: ReadableStream<Uint8Array>;
  pulls: () => number;
} {
  let produced = 0;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (produced >= maxBytes) {
        controller.close();
        return;
      }
      produced += chunkBytes;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
    },
  });
  return { body, pulls: () => pulls };
}

function jsonPost(path: string, body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

function formPost(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/auth/session/approve`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body,
  });
}

describe("JSON request body limit", () => {
  test("returns 413 for a Content-Length body above 64 KiB", async () => {
    const context = await createTestContext();
    createUser(context.config.dbPath, "alice", "alice-password", false);
    const handle = createHttpHandler(context);
    const payload = loginJson(JSON_LIMIT + 1);

    const response = await handle(
      jsonPost("/auth/login", payload, { "content-length": String(payload.length) }),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(413);
    expect(body.error).toContain("64 KiB");
    expect(body.error).not.toContain("Missing username or password");
  });

  test("returns 413 for a chunked body above 64 KiB even with valid credentials", async () => {
    const context = await createTestContext();
    createUser(context.config.dbPath, "alice", "alice-password", false);
    const handle = createHttpHandler(context);

    const response = await handle(
      jsonPost("/auth/login", chunkedStream(loginJson(JSON_LIMIT + 1), 4096)),
    );

    const body = (await response.json()) as { error: string; token?: string };

    expect(response.status).toBe(413);
    expect(body.error).toContain("64 KiB");
    expect(body.token).toBeUndefined();
  });

  test("counts bytes instead of trusting an understated Content-Length", async () => {
    const context = await createTestContext();
    createUser(context.config.dbPath, "alice", "alice-password", false);
    const handle = createHttpHandler(context);

    const response = await handle(
      jsonPost("/auth/login", loginJson(JSON_LIMIT + 4096), { "content-length": "32" }),
    );

    expect(response.status).toBe(413);
  });

  test("stops reading a chunked body as soon as the limit is exceeded", async () => {
    const context = await createTestContext();
    const handle = createHttpHandler(context);
    const endless = endlessStream(1024, 16 * 1024 * 1024);

    const response = await handle(jsonPost("/auth/refresh", endless.body));

    expect(response.status).toBe(413);
    expect(endless.pulls()).toBeLessThan(100);
  });

  test("accepts a body of exactly 64 KiB and rejects one byte more", async () => {
    const context = await createTestContext();
    createUser(context.config.dbPath, "alice", "alice-password", false);
    const handle = createHttpHandler(context);

    const atLimit = await handle(jsonPost("/auth/login", loginJson(JSON_LIMIT)));
    expect(atLimit.status).toBe(200);

    const overLimit = await handle(jsonPost("/auth/login", loginJson(JSON_LIMIT + 1)));
    expect(overLimit.status).toBe(413);
  });

  test("accepts a valid login delivered as a chunked body", async () => {
    const context = await createTestContext();
    createUser(context.config.dbPath, "alice", "alice-password", false);
    const handle = createHttpHandler(context);

    const response = await handle(
      jsonPost(
        "/auth/login",
        chunkedStream(JSON.stringify({ username: "alice", password: "alice-password" }), 7),
      ),
    );
    const body = (await response.json()) as { token: string; user: { username: string } };

    expect(response.status).toBe(200);
    expect(body.token.split(".")).toHaveLength(3);
    expect(body.user.username).toBe("alice");
  });

  test.each([
    ["malformed JSON", "{not json"],
    ["a JSON array", "[]"],
    ["a JSON string", '"alice"'],
    ["JSON null", "null"],
    ["an empty body", ""],
  ])("rejects %s with 400", async (_label, payload) => {
    const context = await createTestContext();
    const handle = createHttpHandler(context);

    const response = await handle(jsonPost("/auth/login", payload));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Request body must be a JSON object",
    });
  });

  test("applies the same limit to administrator endpoints after authentication", async () => {
    const context = await createTestContext();
    const admin = createUser(context.config.dbPath, "admin", "admin-password", true);
    const token = await issueToken(context.keys, context.config, String(admin.id), {
      username: admin.username,
      is_admin: true,
    });
    const handle = createHttpHandler(context);

    const response = await handle(
      new Request(`${ORIGIN}/admin/users`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: chunkedStream(loginJson(JSON_LIMIT + 1), 8192),
      }),
    );

    expect(response.status).toBe(413);
  });

  test("keeps existing repository permissions when a permission update body is unreadable", async () => {
    const context = await createTestContext();
    const admin = createUser(context.config.dbPath, "admin", "admin-password", true);
    const alice = createUser(context.config.dbPath, "alice", "alice-password", false);
    const resourceId = `urc-${"c".repeat(32)}`;
    createResource(context.config.dbPath, resourceId, "demo", admin.id);
    setUserResourcePermissions(context.config.dbPath, alice.id, resourceId, ["read"]);
    const token = await issueToken(context.keys, context.config, String(admin.id), {
      username: admin.username,
      is_admin: true,
    });
    const handle = createHttpHandler(context);

    const response = await handle(
      new Request(`${ORIGIN}/admin/resources/${resourceId}/users/alice`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{not json",
      }),
    );

    expect(response.status).toBe(400);
    expect(getUserResourcePermissions(context.config.dbPath, alice)).toEqual([
      { resource_id: resourceId, permission: ["read"] },
    ]);
  });

  test("rejects oversized refresh requests before looking up the token", async () => {
    const context = await createTestContext();
    const handle = createHttpHandler(context);
    const payload = JSON.stringify({ refresh_token: "x".repeat(JSON_LIMIT) });

    const response = await handle(jsonPost("/auth/refresh", chunkedStream(payload, 8192)));

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("64 KiB") });
  });
});

describe("browser approval form body limit", () => {
  test("returns 413 for an oversized form declared by Content-Length", async () => {
    const context = await createTestContext();
    const handle = createHttpHandler(context);
    const form = `session_code=${"a".repeat(FORM_LIMIT)}&client_state=state&username=alice&password=pw`;

    const response = await handle(
      formPost(form, { "content-length": String(form.length) }),
    );
    const page = await response.text();

    expect(response.status).toBe(413);
    expect(page).toContain("16 KiB");
    expect(page).not.toContain("Required authentication fields are missing");
  });

  test("returns 413 for an oversized form delivered as a chunked body", async () => {
    const context = await createTestContext();
    const handle = createHttpHandler(context);
    const form = `session_code=${"a".repeat(FORM_LIMIT)}&client_state=state&username=alice&password=pw`;

    const response = await handle(formPost(chunkedStream(form, 2048)));

    expect(response.status).toBe(413);
  });

  test("passes a form exactly at the 16 KiB limit on to session validation", async () => {
    const context = await createTestContext();
    const handle = createHttpHandler(context);
    const base = "session_code=abc&client_state=state&username=alice&password=";
    const form = base + "p".repeat(FORM_LIMIT - base.length);

    const response = await handle(formPost(chunkedStream(form, 1024)));

    expect(response.status).toBe(410);
    expect(await response.text()).not.toContain("16 KiB");
  });
});

describe("request body limits over HTTP", () => {
  test("enforces both transfer encodings on the real listener", async () => {
    const context = await createTestContext();
    createUser(context.config.dbPath, "alice", "alice-password", false);
    const service = await startAuthService(context);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const url = `http://127.0.0.1:${service.http.port}/auth/login`;
      const headers = { "content-type": "application/json" };
      const payload = loginJson(JSON_LIMIT + 1024);

      const declared = await fetch(url, { method: "POST", headers, body: payload });
      expect(declared.status).toBe(413);
      expect(await declared.json()).toMatchObject({ error: expect.stringContaining("64 KiB") });

      const chunked = await fetch(url, {
        method: "POST",
        headers,
        body: chunkedStream(payload, 4096),
      });
      expect(chunked.status).toBe(413);

      const valid = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ username: "alice", password: "alice-password" }),
      });
      expect(valid.status).toBe(200);
    } finally {
      warn.mockRestore();
      await service.close();
    }
  });
});
