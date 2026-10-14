import { afterEach, describe, expect, spyOn, test } from "bun:test";

import {
  UNKNOWN_CLIENT_ADDRESS,
  clientAddress,
  isNonPublicAddress,
  normalizeIp,
  throttleSource,
  trustedProxyWarning,
} from "../src/client-address";
import { createHttpHandler } from "../src/index";
import { createTestContext, releaseTestContexts } from "./support/context";

function request(forwardedFor?: string): Request {
  const headers: Record<string, string> = {};
  if (forwardedFor !== undefined) headers["x-forwarded-for"] = forwardedFor;
  return new Request("https://auth.example.test/auth/login", { method: "POST", headers });
}

describe("normalizeIp", () => {
  test("canonicalizes IPv6 and unwraps IPv4-mapped addresses", () => {
    expect(normalizeIp("2001:0DB8:0:0::1")).toBe("2001:db8::1");
    expect(normalizeIp("[2001:db8::1]")).toBe("2001:db8::1");
    expect(normalizeIp("::ffff:198.51.100.7")).toBe("198.51.100.7");
  });

  test("unwraps IPv4-mapped addresses written in hexadecimal", () => {
    expect(normalizeIp("::ffff:c633:6407")).toBe("198.51.100.7");
    expect(normalizeIp("0:0:0:0:0:ffff:c633:6407")).toBe("198.51.100.7");
  });

  test("rejects values that are not bare IP addresses", () => {
    expect(normalizeIp("unknown")).toBeNull();
    expect(normalizeIp("203.0.113.5:443")).toBeNull();
    expect(normalizeIp("")).toBeNull();
    expect(normalizeIp(null)).toBeNull();
  });
});

describe("throttleSource", () => {
  test("keys an IPv6 address by its /64 prefix", () => {
    expect(throttleSource("2001:db8:1:2:abcd:0:0:1")).toBe("2001:db8:1:2::/64");
    expect(throttleSource("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(throttleSource("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(throttleSource("2001:db8:1:3::1")).not.toBe(throttleSource("2001:db8:1:2::1"));
  });

  test("keeps IPv4 addresses and unwraps IPv4-mapped addresses", () => {
    expect(throttleSource("203.0.113.5")).toBe("203.0.113.5");
    expect(throttleSource("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(throttleSource("::ffff:cb00:7105")).toBe("203.0.113.5");
  });

  test("returns values that are not addresses unchanged", () => {
    expect(throttleSource(UNKNOWN_CLIENT_ADDRESS)).toBe(UNKNOWN_CLIENT_ADDRESS);
  });
});

describe("clientAddress", () => {
  test("uses the TCP peer and ignores X-Forwarded-For without a trusted proxy", () => {
    expect(clientAddress(request("198.51.100.1"), "203.0.113.9", 0)).toBe("203.0.113.9");
  });

  test("normalizes an IPv4-mapped peer address", () => {
    expect(clientAddress(request(), "::ffff:203.0.113.9", 0)).toBe("203.0.113.9");
  });

  test("uses the entry appended by the nearest trusted proxy", () => {
    expect(clientAddress(request("203.0.113.200, 198.51.100.7"), "10.0.0.2", 1)).toBe(
      "198.51.100.7",
    );
  });

  test("skips one entry for each additional trusted proxy", () => {
    expect(clientAddress(request("198.51.100.7, 192.0.2.10"), "10.0.0.1", 2)).toBe(
      "198.51.100.7",
    );
  });

  test("falls back to the peer when the forwarded chain is too short or invalid", () => {
    expect(clientAddress(request("198.51.100.7"), "10.0.0.1", 2)).toBe("10.0.0.1");
    expect(clientAddress(request("198.51.100.7, unknown"), "10.0.0.1", 1)).toBe("10.0.0.1");
    expect(clientAddress(request(), "10.0.0.1", 1)).toBe("10.0.0.1");
  });

  test("reports an unknown address when neither the peer nor a header is usable", () => {
    expect(clientAddress(request(), null, 0)).toBe(UNKNOWN_CLIENT_ADDRESS);
  });
});

describe("isNonPublicAddress", () => {
  test("recognizes private, loopback, link-local, unspecified and shared IPv4 addresses", () => {
    for (const address of [
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "127.0.0.1",
      "169.254.10.20",
      "100.64.0.1",
      "0.0.0.0",
    ]) {
      expect(isNonPublicAddress(address)).toBe(true);
    }
  });

  test("treats the neighbours of those ranges as public", () => {
    for (const address of ["172.15.255.255", "172.32.0.1", "100.128.0.1", "11.0.0.1", "8.8.8.8"]) {
      expect(isNonPublicAddress(address)).toBe(false);
    }
  });

  test("recognizes loopback, unique-local, link-local and unspecified IPv6 addresses", () => {
    for (const address of ["::1", "::", "fd12:3456:789a::1", "fc00::1", "fe80::1"]) {
      expect(isNonPublicAddress(address)).toBe(true);
    }
  });

  test("applies the IPv4 rules to IPv4-mapped addresses and treats other peers as public", () => {
    expect(isNonPublicAddress("::ffff:10.0.0.5")).toBe(true);
    expect(isNonPublicAddress("::ffff:8.8.8.8")).toBe(false);
    expect(isNonPublicAddress("2606:4700:4700::1111")).toBe(false);
    expect(isNonPublicAddress(null)).toBe(false);
    expect(isNonPublicAddress(UNKNOWN_CLIENT_ADDRESS)).toBe(false);
  });
});

describe("trustedProxyWarning", () => {
  test("describes a non-public peer that arrives without a trusted proxy", () => {
    const warning = trustedProxyWarning(request(), "127.0.0.1", 0);
    expect(warning).toContain("TRUSTED_PROXY_COUNT=0");
    expect(warning).not.toContain("X-Forwarded-For header was present");
  });

  test("notes a forwarding header that was ignored", () => {
    expect(trustedProxyWarning(request("198.51.100.7"), "10.0.0.2", 0)).toContain(
      "An X-Forwarded-For header was present and ignored.",
    );
  });

  test("stays silent for public peers, unknown peers, or a configured proxy count", () => {
    expect(trustedProxyWarning(request(), "203.0.113.9", 0)).toBeNull();
    expect(trustedProxyWarning(request(), null, 0)).toBeNull();
    expect(trustedProxyWarning(request(), "10.0.0.2", 1)).toBeNull();
  });
});

describe("trusted proxy warning at the HTTP handler", () => {
  afterEach(releaseTestContexts);

  test("logs once for the service, however many requests arrive from a non-public peer", async () => {
    const context = await createTestContext();
    const handle = createHttpHandler(context);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let index = 0; index < 3; index += 1) {
        expect(
          (await handle(new Request("https://auth.example.test/health_check"), "10.0.0.2")).status,
        ).toBe(200);
      }
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("TRUSTED_PROXY_COUNT=0");
    } finally {
      warn.mockRestore();
    }
  });

  test("stays silent when the service sees only public peers", async () => {
    const context = await createTestContext();
    const handle = createHttpHandler(context);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await handle(new Request("https://auth.example.test/health_check"), "203.0.113.9");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("stays silent when a trusted proxy count is configured", async () => {
    const context = await createTestContext({ trustedProxyCount: 1 });
    const handle = createHttpHandler(context);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await handle(new Request("https://auth.example.test/health_check"), "10.0.0.2");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
