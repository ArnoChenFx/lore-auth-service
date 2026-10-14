import { afterEach, describe, expect, test } from "bun:test";

import {
  createAuthSession,
  createUser,
  deleteUser,
  getUserByUsername,
  setUserPassword,
} from "../src/db";
import { createHttpHandler } from "../src/index";
import type { AppConfig } from "../src/config";
import type { AuthServiceContext } from "../src/context";
import { createTestContext, releaseTestContexts } from "./support/context";

const ORIGIN = "https://auth.example.test";
const START_MS = 1_800_000_000_000;
const ONE_HOUR_MS = 60 * 60 * 1000;

type Handler = (req: Request, peerAddress?: string | null) => Promise<Response>;

afterEach(releaseTestContexts);

async function setup(overrides: Partial<AppConfig> = {}): Promise<{
  context: AuthServiceContext;
  handle: Handler;
  clock: { now: number };
}> {
  const context = await createTestContext(overrides);
  const clock = { now: START_MS };
  context.now = () => clock.now;
  createUser(context.config.dbPath, "alice", "alice-password", false);
  createUser(context.config.dbPath, "bob", "bob-password", false);
  createUser(context.config.dbPath, "carol", "carol-password", false);
  return { context, handle: createHttpHandler(context), clock };
}

function loginFrom(
  handle: Handler,
  address: string,
  username: string,
  password: string,
): Promise<Response> {
  return handle(
    new Request(`${ORIGIN}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    }),
    address,
  );
}

async function approveFrom(
  context: AuthServiceContext,
  handle: Handler,
  address: string,
  username: string,
  password: string,
): Promise<Response> {
  const clientState = `state-${crypto.randomUUID()}`;
  const session = createAuthSession(context.config.dbPath, clientState, 300);
  const form = new URLSearchParams({
    session_code: session.sessionCode,
    client_state: clientState,
    username,
    password,
  });
  return handle(
    new Request(`${ORIGIN}/auth/session/approve`, { method: "POST", body: form }),
    address,
  );
}

describe("login throttling per username and address", () => {
  test("locks a username from one address after repeated wrong passwords", async () => {
    const { handle } = await setup();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await loginFrom(handle, "203.0.113.10", "alice", "wrong-password")).status).toBe(401);
    }

    const blocked = await loginFrom(handle, "203.0.113.10", "alice", "alice-password");

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
    expect(await blocked.json()).toMatchObject({
      error: expect.stringContaining("Too many"),
    });
  });

  test("does not lock the same username for another address", async () => {
    const { handle } = await setup();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await loginFrom(handle, "203.0.113.10", "alice", "wrong-password");
    }

    expect((await loginFrom(handle, "203.0.113.11", "alice", "alice-password")).status).toBe(200);
  });

  test("releases the address when the backoff expires", async () => {
    const { handle, clock } = await setup();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await loginFrom(handle, "203.0.113.10", "alice", "wrong-password");
    }
    clock.now += 60_000;

    expect((await loginFrom(handle, "203.0.113.10", "alice", "alice-password")).status).toBe(200);
  });

  test("doubles the lock for each further failure up to the configured maximum", async () => {
    const { handle, clock } = await setup({ loginLockMaxSeconds: 300 });
    const address = "203.0.113.20";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await loginFrom(handle, address, "alice", "wrong-password");
    }

    const retryAfter: string[] = [];
    for (const waitSeconds of [60, 120, 240]) {
      clock.now += waitSeconds * 1000;
      expect((await loginFrom(handle, address, "alice", "wrong-password")).status).toBe(401);
      const blocked = await loginFrom(handle, address, "alice", "alice-password");
      expect(blocked.status).toBe(429);
      retryAfter.push(blocked.headers.get("Retry-After") ?? "");
    }

    expect(retryAfter).toEqual(["120", "240", "300"]);
  });

  test("forgets failures after a full quiet period", async () => {
    const { handle, clock } = await setup();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await loginFrom(handle, "203.0.113.30", "alice", "wrong-password");
    }
    expect((await loginFrom(handle, "203.0.113.30", "alice", "alice-password")).status).toBe(429);

    clock.now += ONE_HOUR_MS;

    expect((await loginFrom(handle, "203.0.113.30", "alice", "wrong-password")).status).toBe(401);
  });

  test("clears the pair counter after a successful login from that address", async () => {
    const { handle } = await setup();
    const address = "203.0.113.40";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await loginFrom(handle, address, "alice", "wrong-password");
    }
    expect((await loginFrom(handle, address, "alice", "alice-password")).status).toBe(200);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await loginFrom(handle, address, "alice", "wrong-password")).status).toBe(401);
    }
    expect((await loginFrom(handle, address, "alice", "wrong-password")).status).toBe(429);
  });

  test("gives unknown usernames the same counters and responses as existing ones", async () => {
    const { handle } = await setup();
    const statusesFor = async (address: string, username: string): Promise<number[]> => {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        statuses.push((await loginFrom(handle, address, username, "wrong-password")).status);
      }
      return statuses;
    };

    expect(await statusesFor("203.0.113.50", "ghost")).toEqual([401, 401, 401, 401, 401, 429]);
    expect(await statusesFor("203.0.113.51", "alice")).toEqual([401, 401, 401, 401, 401, 429]);
  });
});

describe("login throttling per address across usernames", () => {
  test("locks an address that sprays several usernames", async () => {
    const { handle } = await setup({ loginMaxFailuresPerIp: 3 });
    const address = "203.0.113.60";
    await loginFrom(handle, address, "alice", "wrong-password");
    await loginFrom(handle, address, "bob", "wrong-password");
    await loginFrom(handle, address, "carol", "wrong-password");

    expect((await loginFrom(handle, address, "alice", "alice-password")).status).toBe(429);
    expect((await loginFrom(handle, "203.0.113.61", "alice", "alice-password")).status).toBe(200);
  });

  test("keeps address failures when the same address logs in successfully", async () => {
    const { handle } = await setup({ loginMaxFailuresPerIp: 3 });
    const address = "203.0.113.70";
    await loginFrom(handle, address, "alice", "wrong-password");
    await loginFrom(handle, address, "bob", "wrong-password");

    expect((await loginFrom(handle, address, "alice", "alice-password")).status).toBe(200);

    await loginFrom(handle, address, "carol", "wrong-password");
    expect((await loginFrom(handle, address, "bob", "bob-password")).status).toBe(429);
  });
});

describe("login throttling per account across addresses", () => {
  test("does not let a single address lock the account for everyone", async () => {
    const { handle } = await setup({ loginMaxFailingIpsPerAccount: 2 });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await loginFrom(handle, "203.0.113.80", "alice", "wrong-password");
    }

    expect((await loginFrom(handle, "203.0.113.80", "alice", "alice-password")).status).toBe(429);
    expect((await loginFrom(handle, "203.0.113.81", "alice", "alice-password")).status).toBe(200);
  });

  test("locks the account for every address once enough addresses are failing", async () => {
    const { handle, clock } = await setup({ loginMaxFailingIpsPerAccount: 3 });
    await loginFrom(handle, "203.0.113.90", "alice", "wrong-password");
    await loginFrom(handle, "203.0.113.91", "alice", "wrong-password");
    await loginFrom(handle, "203.0.113.92", "alice", "wrong-password");

    const blocked = await loginFrom(handle, "203.0.113.93", "alice", "alice-password");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("900");

    clock.now += 900_000;
    expect((await loginFrom(handle, "203.0.113.93", "alice", "alice-password")).status).toBe(200);
  });

  test("disables a scope when its limit is zero", async () => {
    const { handle } = await setup({
      loginMaxFailuresPerUserIp: 0,
      loginMaxFailuresPerIp: 0,
      loginMaxFailingIpsPerAccount: 0,
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await loginFrom(handle, "203.0.113.100", "alice", "wrong-password")).status).toBe(401);
    }

    expect((await loginFrom(handle, "203.0.113.100", "alice", "alice-password")).status).toBe(200);
  });
});

describe("account lock exemption for sources that logged in recently", () => {
  async function failFromOtherSources(handle: Handler, username: string): Promise<void> {
    for (const address of ["203.0.113.151", "203.0.113.152", "203.0.113.153"]) {
      await loginFrom(handle, address, username, "wrong-password");
    }
  }

  test("does not apply the account lock to a source that logged in recently", async () => {
    const { handle } = await setup({ loginMaxFailingIpsPerAccount: 3 });
    expect((await loginFrom(handle, "203.0.113.150", "alice", "alice-password")).status).toBe(200);
    await failFromOtherSources(handle, "alice");

    expect((await loginFrom(handle, "203.0.113.150", "alice", "alice-password")).status).toBe(200);
    expect((await loginFrom(handle, "203.0.113.154", "alice", "alice-password")).status).toBe(429);
  });

  test("grants the exemption after a successful browser approval", async () => {
    const { context, handle } = await setup({ loginMaxFailingIpsPerAccount: 3 });
    expect(
      (await approveFrom(context, handle, "203.0.113.160", "alice", "alice-password")).status,
    ).toBe(200);
    await failFromOtherSources(handle, "alice");

    expect((await loginFrom(handle, "203.0.113.160", "alice", "alice-password")).status).toBe(200);
  });

  test("keeps the account lock for a source whose last login is outside the window", async () => {
    const { handle, clock } = await setup({
      loginMaxFailingIpsPerAccount: 3,
      loginRecentSuccessSeconds: 3600,
    });
    expect((await loginFrom(handle, "203.0.113.150", "alice", "alice-password")).status).toBe(200);
    clock.now += 2 * ONE_HOUR_MS;
    await failFromOtherSources(handle, "alice");

    expect((await loginFrom(handle, "203.0.113.150", "alice", "alice-password")).status).toBe(429);
  });

  test("keeps the account lock for a source that only logged in to another account", async () => {
    const { handle } = await setup({ loginMaxFailingIpsPerAccount: 3 });
    expect((await loginFrom(handle, "203.0.113.150", "bob", "bob-password")).status).toBe(200);
    await failFromOtherSources(handle, "alice");

    expect((await loginFrom(handle, "203.0.113.150", "alice", "alice-password")).status).toBe(429);
  });

  test("does not let an exempt source skip its own backoff", async () => {
    const { handle } = await setup({ loginMaxFailingIpsPerAccount: 3 });
    expect((await loginFrom(handle, "203.0.113.150", "alice", "alice-password")).status).toBe(200);
    await failFromOtherSources(handle, "alice");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await loginFrom(handle, "203.0.113.150", "alice", "wrong-password")).status).toBe(401);
    }
    const blocked = await loginFrom(handle, "203.0.113.150", "alice", "alice-password");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
  });

  test("turns the exemption off when the window is zero", async () => {
    const { handle } = await setup({
      loginMaxFailingIpsPerAccount: 3,
      loginRecentSuccessSeconds: 0,
    });
    expect((await loginFrom(handle, "203.0.113.150", "alice", "alice-password")).status).toBe(200);
    await failFromOtherSources(handle, "alice");

    expect((await loginFrom(handle, "203.0.113.150", "alice", "alice-password")).status).toBe(429);
  });

  test("does not carry the exemption over to a user re-created with the same name", async () => {
    const { context, handle } = await setup({ loginMaxFailingIpsPerAccount: 3 });
    expect((await loginFrom(handle, "203.0.113.150", "alice", "alice-password")).status).toBe(200);
    deleteUser(context.config.dbPath, "alice");
    createUser(context.config.dbPath, "alice", "new-alice-password", false);
    await failFromOtherSources(handle, "alice");

    expect((await loginFrom(handle, "203.0.113.150", "alice", "new-alice-password")).status).toBe(
      429,
    );
  });

  test("removes the exemption when the password is changed", async () => {
    const { context, handle } = await setup({ loginMaxFailingIpsPerAccount: 3 });
    expect((await loginFrom(handle, "203.0.113.150", "alice", "alice-password")).status).toBe(200);
    const alice = getUserByUsername(context.config.dbPath, "alice");
    setUserPassword(context.config.dbPath, alice!.id, "new-alice-password");
    await failFromOtherSources(handle, "alice");

    expect((await loginFrom(handle, "203.0.113.150", "alice", "new-alice-password")).status).toBe(
      429,
    );
  });
});

describe("login throttling for IPv6 addresses", () => {
  test("counts every address in one /64 as the same source for a username", async () => {
    const { handle } = await setup();
    for (let host = 1; host <= 5; host += 1) {
      await loginFrom(handle, `2001:db8:1:2::${host}`, "alice", "wrong-password");
    }

    expect(
      (await loginFrom(handle, "2001:db8:1:2:ffff::99", "alice", "alice-password")).status,
    ).toBe(429);
    expect((await loginFrom(handle, "2001:db8:1:3::1", "alice", "alice-password")).status).toBe(200);
  });

  test("counts every address in one /64 once for the address-wide limit", async () => {
    const { handle } = await setup({ loginMaxFailuresPerIp: 3 });
    await loginFrom(handle, "2001:db8:1:2::1", "alice", "wrong-password");
    await loginFrom(handle, "2001:db8:1:2::2", "bob", "wrong-password");
    await loginFrom(handle, "2001:db8:1:2::3", "carol", "wrong-password");

    expect(
      (await loginFrom(handle, "2001:db8:1:2::4", "alice", "alice-password")).status,
    ).toBe(429);
    expect(
      (await loginFrom(handle, "2001:db8:1:9::4", "alice", "alice-password")).status,
    ).toBe(200);
  });

  test("does not let addresses in one /64 lock an account by themselves", async () => {
    const { handle } = await setup({ loginMaxFailingIpsPerAccount: 3 });
    for (let host = 1; host <= 4; host += 1) {
      await loginFrom(handle, `2001:db8:1:2::${host}`, "alice", "wrong-password");
    }

    expect((await loginFrom(handle, "2001:db8:7:7::1", "alice", "alice-password")).status).toBe(200);
  });

  test("locks an account once enough distinct IPv6 prefixes have failed", async () => {
    const { handle } = await setup({ loginMaxFailingIpsPerAccount: 3 });
    await loginFrom(handle, "2001:db8:1::1", "alice", "wrong-password");
    await loginFrom(handle, "2001:db8:2::1", "alice", "wrong-password");
    await loginFrom(handle, "2001:db8:3::1", "alice", "wrong-password");

    const blocked = await loginFrom(handle, "2001:db8:4::1", "alice", "alice-password");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("900");
  });
});

describe("browser approval throttling", () => {
  test("remembers failed approvals across new browser sessions", async () => {
    const { context, handle } = await setup();
    const address = "203.0.113.110";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const rejected = await approveFrom(context, handle, address, "alice", "wrong-password");
      expect(rejected.status).toBe(401);
    }

    const blocked = await approveFrom(context, handle, address, "alice", "alice-password");

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
    expect(await blocked.text()).toContain("Too many attempts");
  });

  test("clears the pair counter after a successful browser approval", async () => {
    const { context, handle } = await setup();
    const address = "203.0.113.120";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await approveFrom(context, handle, address, "alice", "wrong-password");
    }
    expect((await approveFrom(context, handle, address, "alice", "alice-password")).status).toBe(200);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await approveFrom(context, handle, address, "alice", "wrong-password")).status).toBe(401);
    }
    expect((await approveFrom(context, handle, address, "alice", "wrong-password")).status).toBe(429);
  });

  test("uses the same address and username counters as the JSON login endpoint", async () => {
    const { context, handle } = await setup();
    const address = "203.0.113.130";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await loginFrom(handle, address, "alice", "wrong-password");
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await approveFrom(context, handle, address, "alice", "wrong-password");
    }

    expect((await approveFrom(context, handle, address, "alice", "alice-password")).status).toBe(429);
  });

  test("answers 429 once a browser session exhausts its own attempts", async () => {
    const { context, handle } = await setup({
      loginMaxFailuresPerUserIp: 0,
      loginMaxFailuresPerIp: 0,
      loginMaxFailingIpsPerAccount: 0,
    });
    const clientState = "session-lock-state";
    const session = createAuthSession(context.config.dbPath, clientState, 300);
    const attempt = (): Promise<Response> =>
      handle(
        new Request(`${ORIGIN}/auth/session/approve`, {
          method: "POST",
          body: new URLSearchParams({
            session_code: session.sessionCode,
            client_state: clientState,
            username: "alice",
            password: "wrong-password",
          }),
        }),
        "203.0.113.140",
      );

    for (let index = 0; index < 4; index += 1) {
      expect((await attempt()).status).toBe(401);
    }
    const locked = await attempt();

    expect(locked.status).toBe(429);
    expect(locked.headers.get("Retry-After")).toBe("60");
    expect(await locked.text()).toContain("Too many attempts");
  });
});

describe("client address resolution for throttling", () => {
  test("ignores a forged X-Forwarded-For header when no proxy is trusted", async () => {
    const { handle } = await setup();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await loginForwardedFrom(handle, "10.0.0.1", `198.51.100.${attempt + 1}`, "alice", "wrong-password");
    }

    const blocked = await loginForwardedFrom(handle, "10.0.0.1", "198.51.100.99", "alice", "alice-password");
    expect(blocked.status).toBe(429);
  });

  test("keys attempts by the client address appended by the trusted proxy", async () => {
    const { handle } = await setup({ trustedProxyCount: 1 });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await loginForwardedFrom(handle, "10.0.0.2", "198.51.100.10", "alice", "wrong-password");
    }

    expect(
      (await loginForwardedFrom(handle, "10.0.0.2", "198.51.100.10", "alice", "alice-password")).status,
    ).toBe(429);
    expect(
      (await loginForwardedFrom(handle, "10.0.0.2", "198.51.100.11", "alice", "alice-password")).status,
    ).toBe(200);
  });

  test("cannot escape the lock by prepending forged addresses", async () => {
    const { handle } = await setup({ trustedProxyCount: 1 });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await loginForwardedFrom(
        handle,
        "10.0.0.2",
        `203.0.113.${attempt + 1}, 198.51.100.10`,
        "alice",
        "wrong-password",
      );
    }

    expect(
      (
        await loginForwardedFrom(
          handle,
          "10.0.0.2",
          "203.0.113.99, 198.51.100.10",
          "alice",
          "alice-password",
        )
      ).status,
    ).toBe(429);
  });
});

function loginForwardedFrom(
  handle: Handler,
  peerAddress: string,
  forwardedFor: string,
  username: string,
  password: string,
): Promise<Response> {
  return handle(
    new Request(`${ORIGIN}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": forwardedFor },
      body: JSON.stringify({ username, password }),
    }),
    peerAddress,
  );
}
