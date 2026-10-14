/**
 * login-throttle.ts — 密码登录失败节流（JSON 登录与浏览器审批共用）
 *
 * 三个维度对应不同的攻击面：
 * - （用户名, IP）：同一来源持续猜测同一账号，按失败次数指数退避，只影响该来源。
 * - IP：同一来源轮换用户名喷洒。成功登录不清除该计数，否则攻击者只需混入一次自己账号
 *   的成功登录即可重置。
 * - 账号：统计窗口内失败过的不同来源数。单一来源无论失败多少次都只计为一个，因此不能
 *   单独锁死他人账号；只有多个来源同时失败才会触发账号级锁定。近期在该账号上成功登录过的
 *   来源不受账号级锁定影响，但其自身的（用户名, 来源）计数仍然生效。
 *
 * 所有维度的来源都经过 `throttleSource` 归一：IPv4 逐地址计数，IPv6 按 /64 前缀计数，
 * 同一 /64 内的地址不会增加来源数。
 *
 * 被拒绝的请求既不校验密码也不计入失败，锁定期间无法通过继续尝试来延长锁定时间。
 */

import type { AppConfig } from "./config";
import { throttleSource } from "./client-address";
import {
  clearLoginThrottle,
  getLoginThrottle,
  getLoginThrottleAccountEdge,
  getUserByUsername,
  hasRecentLoginSuccessSource,
  hashOpaqueToken,
  pruneLoginSuccessSources,
  pruneLoginThrottles,
  recordLoginSuccessSource,
  recordLoginThrottleFailure,
  type LoginThrottleEntry,
} from "./db";

const QUIET_PERIOD_MS = 60 * 60 * 1000;
const ACCOUNT_WINDOW_MS = 15 * 60 * 1000;
const MAX_BACKOFF_EXPONENT = 30;

export interface LoginThrottlePolicy {
  maxFailuresPerUserIp: number;
  maxFailuresPerIp: number;
  maxFailingIpsPerAccount: number;
  lockBaseSeconds: number;
  lockMaxSeconds: number;
  recentSuccessSeconds: number;
}

export type LoginGate = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export function loginThrottlePolicy(config: AppConfig): LoginThrottlePolicy {
  return {
    maxFailuresPerUserIp: config.loginMaxFailuresPerUserIp,
    maxFailuresPerIp: config.loginMaxFailuresPerIp,
    maxFailingIpsPerAccount: config.loginMaxFailingIpsPerAccount,
    lockBaseSeconds: config.loginLockBaseSeconds,
    lockMaxSeconds: config.loginLockMaxSeconds,
    recentSuccessSeconds: config.loginRecentSuccessSeconds,
  };
}

export function checkLoginAllowed(
  dbPath: string,
  policy: LoginThrottlePolicy,
  username: string,
  address: string,
  nowMs: number,
): LoginGate {
  const waitsMs: number[] = [];

  if (policy.maxFailuresPerUserIp > 0) {
    const until = backoffUntil(
      getLoginThrottle(dbPath, "user_ip", pairKey(username, address)),
      policy.maxFailuresPerUserIp,
      policy,
    );
    if (until > nowMs) waitsMs.push(until - nowMs);
  }

  if (policy.maxFailuresPerIp > 0) {
    const until = backoffUntil(
      getLoginThrottle(dbPath, "ip", addressKey(address)),
      policy.maxFailuresPerIp,
      policy,
    );
    if (until > nowMs) waitsMs.push(until - nowMs);
  }

  if (policy.maxFailingIpsPerAccount > 0) {
    const edge = getLoginThrottleAccountEdge(
      dbPath,
      accountKey(username),
      nowMs - ACCOUNT_WINDOW_MS,
      policy.maxFailingIpsPerAccount,
    );
    if (edge !== null && !hasRecentSuccessFrom(dbPath, policy, username, address, nowMs)) {
      waitsMs.push(edge + ACCOUNT_WINDOW_MS - nowMs);
    }
  }

  if (waitsMs.length === 0) return { allowed: true };
  return { allowed: false, retryAfterSeconds: Math.ceil(Math.max(...waitsMs) / 1000) };
}

export function recordLoginFailure(
  dbPath: string,
  policy: LoginThrottlePolicy,
  username: string,
  address: string,
  nowMs: number,
): void {
  const staleBeforeMs = nowMs - Math.max(QUIET_PERIOD_MS, policy.lockMaxSeconds * 1000);

  if (policy.maxFailuresPerUserIp > 0 || policy.maxFailingIpsPerAccount > 0) {
    recordLoginThrottleFailure(
      dbPath,
      "user_ip",
      pairKey(username, address),
      accountKey(username),
      nowMs,
      staleBeforeMs,
    );
  }
  if (policy.maxFailuresPerIp > 0) {
    recordLoginThrottleFailure(dbPath, "ip", addressKey(address), null, nowMs, staleBeforeMs);
  }
  pruneLoginThrottles(dbPath, staleBeforeMs);
}

/** 只清除（用户名, IP）计数：同一 IP 的跨用户名计数不因一次成功登录而重置。 */
export function clearLoginFailures(dbPath: string, username: string, address: string): void {
  clearLoginThrottle(dbPath, "user_ip", pairKey(username, address));
}

/**
 * 记录一次成功登录的来源，供账号级锁定豁免使用。过期记录在此一并清理，使表中只保留窗口内的记录。
 */
export function recordLoginSuccess(
  dbPath: string,
  policy: LoginThrottlePolicy,
  userId: number,
  address: string,
  nowMs: number,
): void {
  if (policy.recentSuccessSeconds > 0) {
    recordLoginSuccessSource(dbPath, userId, addressKey(address), nowMs);
  }
  pruneLoginSuccessSources(dbPath, nowMs - policy.recentSuccessSeconds * 1000);
}

/**
 * 账号级锁定不阻止近期在该账号上成功登录过的来源。来源自身的（用户名, 来源）退避仍然生效，
 * 因此豁免不会让该来源获得额外的猜测次数。
 */
function hasRecentSuccessFrom(
  dbPath: string,
  policy: LoginThrottlePolicy,
  username: string,
  address: string,
  nowMs: number,
): boolean {
  if (policy.recentSuccessSeconds <= 0) return false;
  const user = getUserByUsername(dbPath, username);
  return (
    user !== null &&
    hasRecentLoginSuccessSource(
      dbPath,
      user.id,
      addressKey(address),
      nowMs - policy.recentSuccessSeconds * 1000,
    )
  );
}

function backoffUntil(
  entry: LoginThrottleEntry | null,
  threshold: number,
  policy: LoginThrottlePolicy,
): number {
  if (!entry || entry.failures < threshold) return 0;
  const exponent = Math.min(entry.failures - threshold, MAX_BACKOFF_EXPONENT);
  const lockMs = Math.min(
    policy.lockMaxSeconds * 1000,
    policy.lockBaseSeconds * 1000 * 2 ** exponent,
  );
  return entry.last_failure_ms + lockMs;
}

function pairKey(username: string, address: string): string {
  return hashOpaqueToken(JSON.stringify([username, throttleSource(address)]));
}

function addressKey(address: string): string {
  return hashOpaqueToken(JSON.stringify([throttleSource(address)]));
}

function accountKey(username: string): string {
  return hashOpaqueToken(JSON.stringify([username]));
}
