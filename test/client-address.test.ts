import { describe, expect, test } from "bun:test";

import { UNKNOWN_CLIENT_ADDRESS, clientAddress, normalizeIp } from "../src/client-address";

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

  test("rejects values that are not bare IP addresses", () => {
    expect(normalizeIp("unknown")).toBeNull();
    expect(normalizeIp("203.0.113.5:443")).toBeNull();
    expect(normalizeIp("")).toBeNull();
    expect(normalizeIp(null)).toBeNull();
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
