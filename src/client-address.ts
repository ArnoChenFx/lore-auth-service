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

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(candidate);
  if (mapped) return mapped[1];
  if (family === 4) return candidate;
  return canonicalIpv6(candidate);
}

function canonicalIpv6(address: string): string | null {
  try {
    return new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
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
