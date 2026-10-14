/**
 * client-address.ts — 登录节流使用的客户端来源地址
 *
 * 默认只信任 TCP 对端地址。只有 TRUSTED_PROXY_COUNT 大于 0 时才读取 X-Forwarded-For，
 * 并且只取最近一个可信代理追加的那一项，客户端自行放入的前缀不会影响结果。
 */

import { isIP } from "node:net";

export const UNKNOWN_CLIENT_ADDRESS = "unknown";

export function normalizeIp(value: string | null | undefined): string | null {
  const candidate = value?.trim().replace(/^\[(.*)\]$/, "$1");
  if (!candidate) return null;
  const family = isIP(candidate);
  if (family === 0) return null;
  if (family === 4) return candidate;

  const canonical = canonicalIpv6(candidate);
  if (canonical === null) return null;
  const groups = ipv6Groups(canonical);
  if (groups && isIpv4Mapped(groups)) return ipv4FromGroups(groups[6], groups[7]);
  return canonical;
}

/**
 * 登录节流使用的来源键。IPv4 直接使用地址；IPv6 只保留前 64 位，因为同一 /64 通常属于
 * 同一客户端，攻击者可以在其中任意更换地址来绕过按地址的计数。
 */
export function throttleSource(address: string): string {
  const normalized = normalizeIp(address) ?? address;
  const groups = isIP(normalized) === 6 ? ipv6Groups(normalized) : null;
  if (!groups) return normalized;
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

function canonicalIpv6(address: string): string | null {
  try {
    return new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

/** 输入须为 canonicalIpv6 的输出，即最多只有一段连续零被压缩为 `::`。 */
function ipv6Groups(canonical: string): number[] | null {
  const halves = canonical.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const groups = [...head, ...new Array<string>(missing).fill("0"), ...tail];
  return groups.map((group) => Number.parseInt(group, 16));
}

function isIpv4Mapped(groups: number[]): boolean {
  return groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
}

function ipv4FromGroups(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

export function clientAddress(
  req: Request,
  peerAddress: string | null,
  trustedProxyCount: number,
): string {
  if (trustedProxyCount > 0) {
    const forwarded = req.headers.get("x-forwarded-for")?.split(",") ?? [];
    const candidate = normalizeIp(forwarded[forwarded.length - trustedProxyCount]);
    if (candidate) return candidate;
  }
  return normalizeIp(peerAddress) ?? UNKNOWN_CLIENT_ADDRESS;
}
