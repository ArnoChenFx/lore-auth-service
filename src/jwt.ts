/**
 * jwt.ts — Lore AuthN / AuthZ JWT 签发与验证
 *
 * Lore Client 会在本地无验签解码 Token 来选择账号并检查可投递域名，Lore Server
 * 再通过 JWKS 做完整验签。因此这里同时保证字段完整、Audience 精确和签名可靠。
 */

import { randomBytes } from "crypto";
import { SignJWT, errors as joseErrors, jwtVerify } from "jose";

import type { AppConfig } from "./config";
import type { ResourcePermission, User } from "./db";
import type { KeyMaterial } from "./keys";

export interface CustomClaims {
  username: string;
  is_admin: boolean;
}

export interface TokenPayload {
  sub: string;
  iss: string;
  aud: string[];
  iat: number;
  exp: number;
  env: string;
  name: string;
  preferred_username: string;
  is_service_account: boolean;
  is_admin: boolean;
  resources?: ResourcePermission[];
  groups?: string[];
  idp?: string;
}

function normalizeAudience(audience: unknown): string[] {
  if (typeof audience === "string") return [audience];
  if (Array.isArray(audience)) {
    return audience.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function baseToken(
  keys: KeyMaterial,
  config: AppConfig,
  userId: string,
  username: string,
  isAdmin: boolean,
): SignJWT {
  return new SignJWT({
    env: config.environment,
    name: username,
    preferred_username: username,
    is_service_account: false,
    is_admin: isAdmin,
  })
    .setProtectedHeader({ alg: keys.alg, kid: keys.kid, typ: "JWT" })
    .setSubject(userId)
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setIssuedAt()
    .setExpirationTime(`${config.tokenTtl}s`);
}

/** 签发用于证明用户身份的 AuthN Token。 */
export async function issueAuthenticationToken(
  keys: KeyMaterial,
  config: AppConfig,
  user: Pick<User, "id" | "username" | "is_admin">,
): Promise<string> {
  return baseToken(
    keys,
    config,
    String(user.id),
    user.username,
    user.is_admin === 1,
  ).sign(keys.privateKey);
}

/**
 * 签发仓库范围 AuthZ Token。资源集合已经在数据库边界按当前用户裁剪，不能把请求
 * 中未经授权的 resource_id 原样写入 Claims。
 */
export async function issueAuthorizationToken(
  keys: KeyMaterial,
  config: AppConfig,
  user: Pick<User, "id" | "username" | "is_admin">,
  resources: ResourcePermission[],
): Promise<string> {
  return new SignJWT({
    env: config.environment,
    name: user.username,
    preferred_username: user.username,
    resources,
    groups: user.is_admin === 1 ? ["lore-admin"] : [],
    is_service_account: false,
    is_admin: user.is_admin === 1,
    idp: "lore-auth-service",
  })
    .setProtectedHeader({ alg: keys.alg, kid: keys.kid, typ: "JWT" })
    .setSubject(String(user.id))
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setIssuedAt()
    .setExpirationTime(`${config.tokenTtl}s`)
    .sign(keys.privateKey);
}

/**
 * 保留原有公共函数名称，避免 REST 登录调用方和已有 SDK 集成被不必要地打断。
 * 新代码优先使用语义更明确的 `issueAuthenticationToken`。
 */
export async function issueToken(
  keys: KeyMaterial,
  config: AppConfig,
  userId: string,
  claims: CustomClaims,
): Promise<string> {
  return issueAuthenticationToken(keys, config, {
    id: Number(userId),
    username: claims.username,
    is_admin: claims.is_admin ? 1 : 0,
  });
}

export async function verifyToken(
  keys: KeyMaterial,
  config: AppConfig,
  token: string,
): Promise<TokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, keys.publicKey, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: [keys.alg],
    });
    if (
      !payload.sub ||
      !payload.iss ||
      !payload.iat ||
      !payload.exp ||
      typeof payload.env !== "string" ||
      typeof payload.name !== "string" ||
      typeof payload.preferred_username !== "string"
    ) {
      return null;
    }
    return {
      sub: payload.sub,
      iss: payload.iss,
      aud: normalizeAudience(payload.aud),
      iat: payload.iat,
      exp: payload.exp,
      env: payload.env,
      name: payload.name,
      preferred_username: payload.preferred_username,
      is_service_account: payload.is_service_account === true,
      is_admin: payload.is_admin === true,
      resources: Array.isArray(payload.resources)
        ? (payload.resources as ResourcePermission[])
        : undefined,
      groups: Array.isArray(payload.groups)
        ? payload.groups.filter((item): item is string => typeof item === "string")
        : undefined,
      idp: typeof payload.idp === "string" ? payload.idp : undefined,
    };
  } catch (error) {
    if (
      error instanceof joseErrors.JWTExpired ||
      error instanceof joseErrors.JWTInvalid ||
      error instanceof joseErrors.JWSSignatureVerificationFailed
    ) {
      return null;
    }
    return null;
  }
}

export function generateRefreshToken(): string {
  return randomBytes(32).toString("hex");
}

export function extractBearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}
