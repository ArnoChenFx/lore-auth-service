/**
 * keys.ts — RSA key pair management
 *
 * Generates an RS256 key pair on first launch and persists it to disk.
 * Subsequent launches reload the existing keys. Also computes the key ID (kid)
 * and exposes the JWKS endpoint output.
 */

import { generateKeyPair, exportJWK, exportPKCS8, exportSPKI, importPKCS8, importSPKI } from "jose";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import type { KeyLike } from "jose";

export interface KeyMaterial {
  publicKey: KeyLike;
  privateKey: KeyLike;
  kid: string;
  alg: string;
}

/**
 * Computes the JWK thumbprint per RFC 7638 to use as the kid.
 * Takes only the kty / n / e members of the RSA public key, sorts them
 * lexicographically, joins them, then SHA-256 → base64url.
 */
function rfc7638Thumbprint(jwk: { kty: string; n: string; e: string }): string {
  const members: Record<string, string> = { kty: jwk.kty, n: jwk.n, e: jwk.e };
  const sorted = Object.keys(members)
    .sort()
    .map((k) => `"${k}":"${members[k]}"`)
    .join(",");
  return createHash("sha256").update(`{${sorted}}`).digest("base64url");
}

async function generateAndPersist(dir: string, alg: string): Promise<KeyMaterial> {
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });

  const privatePem = await exportPKCS8(privateKey);
  const publicPem = await exportSPKI(publicKey);

  mkdirSync(dir, { recursive: true });
  const { writeFileSync } = await import("fs");
  writeFileSync(join(dir, "private.pem"), privatePem, { mode: 0o600 });
  writeFileSync(join(dir, "public.pem"), publicPem, { mode: 0o644 });

  const jwk = await exportJWK(publicKey);
  const kid = rfc7638Thumbprint(jwk as { kty: string; n: string; e: string });

  // Persist kid so we don't recompute on every startup
  writeFileSync(join(dir, "kid.txt"), kid, "utf-8");

  return { publicKey, privateKey, kid, alg };
}

async function loadExisting(dir: string, alg: string): Promise<KeyMaterial> {
  const privatePem = readFileSync(join(dir, "private.pem"), "utf-8");
  const publicPem = readFileSync(join(dir, "public.pem"), "utf-8");
  const kid = readFileSync(join(dir, "kid.txt"), "utf-8").trim();

  const privateKey = await importPKCS8(privatePem, alg);
  const publicKey = await importSPKI(publicPem, alg, { extractable: true });

  return { publicKey, privateKey, kid, alg };
}

export async function loadOrGenerateKeys(keyDir: string, alg = "RS256"): Promise<KeyMaterial> {
  const absDir = resolve(keyDir);
  const hasKeys =
    existsSync(join(absDir, "private.pem")) &&
    existsSync(join(absDir, "public.pem")) &&
    existsSync(join(absDir, "kid.txt"));

  if (hasKeys) {
    return loadExisting(absDir, alg);
  }
  return generateAndPersist(absDir, alg);
}

/**
 * Builds the JWKS (JSON Web Key Set) containing the public key.
 * Lore Server's [server.auth.jwk].endpoint should point at this output.
 */
export async function buildJwks(keys: KeyMaterial): Promise<{ keys: any[] }> {
  const jwk = await exportJWK(keys.publicKey);
  return {
    keys: [
      {
        ...jwk,
        kid: keys.kid,
        alg: keys.alg,
        use: "sig",
      },
    ],
  };
}