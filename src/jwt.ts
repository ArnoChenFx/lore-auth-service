/**
 * jwt.ts — JWT signing and verification using the jose library
 *
 * Issued token structure:
 *   header: { alg: "RS256", kid: "<key-id>", typ: "JWT" }
 *   claims: { iss, aud, sub, iat, exp, ...custom }
 *
 * The jwt_issuer / jwt_audience configured on the Lore Server side
 * under [server.auth] must match the issuer / audience configured here.
 */

import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import { randomBytes } from "crypto";
import type { KeyMaterial } from "./keys";
import type { AppConfig } from "./config";

export interface CustomClaims {
  username: string;
  is_admin: boolean;
}

export interface TokenPayload {
  sub: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  username: string;
  is_admin: boolean;
}

export async function issueToken(
  keys: KeyMaterial,
  config: AppConfig,
  userId: string,
  claims: CustomClaims,
): Promise<string> {
  return new SignJWT({
    username: claims.username,
    is_admin: claims.is_admin,
  })
    .setProtectedHeader({ alg: keys.alg, kid: keys.kid, typ: "JWT" })
    .setSubject(userId)
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setIssuedAt()
    .setExpirationTime(`${config.tokenTtl}s`)
    .sign(keys.privateKey);
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
    return {
      sub: payload.sub!,
      iss: payload.iss!,
      aud: payload.aud as string,
      iat: payload.iat!,
      exp: payload.exp!,
      username: payload.username as string,
      is_admin: payload.is_admin as boolean,
    };
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) return null;
    if (err instanceof joseErrors.JWTInvalid) return null;
    if (err instanceof joseErrors.JWSSignatureVerificationFailed) return null;
    // Don't expose unknown errors to the client either
    return null;
  }
}

/**
 * Generate a cryptographically secure opaque refresh token.
 * Returns a 64-byte hex string (256 bits of entropy).
 */
export function generateRefreshToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Extract a Bearer token from the Authorization header
 */
export function extractBearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}