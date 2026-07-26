/**
 * index.ts — Lore Auth Service entry point
 *
 * HTTP service based on Bun.serve, providing:
 *   GET  /.well-known/jwks.json     — JWKS endpoint (fetched by Lore Server)
 *   GET  /health_check              — Health check
 *   POST /auth/login                — User login, returns access + refresh tokens
 *   POST /auth/refresh              — Use refresh token to get a new access token
 *   GET  /auth/me                   — Verify token, return current user info
 *   GET  /admin                    — Admin panel (HTML UI)
 *   POST /admin/users               — Create a user (requires admin token)
 *   GET  /admin/users               — List users (requires admin token)
 *   DEL  /admin/users/:username     — Delete a user (requires admin token)
 */

import { loadConfig } from "./config";
import { loadOrGenerateKeys, buildJwks, type KeyMaterial } from "./keys";
import {
  initDb,
  createUser,
  authenticate,
  getUserByUsername,
  getUserById,
  listUsers,
  deleteUser,
  userCount,
  hashRefreshToken,
  createRefreshToken,
  getRefreshTokenByHash,
  revokeRefreshToken,
} from "./db";
import { issueToken, verifyToken, generateRefreshToken, extractBearerToken, type TokenPayload } from "./jwt";
import { handleAdminPanel } from "./admin-panel";

// ─── Types ──────────────────────────────────────────

interface RequestContext {
  config: ReturnType<typeof loadConfig>;
  keys: KeyMaterial;
  jwks: { keys: any[] };
}

// ─── Utilities ──────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 400): Response {
  return json({ error: message }, status);
}

async function parseBody(req: Request): Promise<Record<string, any> | null> {
  try {
    return (await req.json()) as Record<string, any>;
  } catch {
    return null;
  }
}

// ─── Route handlers ─────────────────────────────────

async function handleJwks(ctx: RequestContext): Promise<Response> {
  return json(ctx.jwks);
}

async function handleHealth(ctx: RequestContext): Promise<Response> {
  return json({ status: "ok", service: "lore-auth", keys: ctx.jwks.keys.length });
}

async function handleLogin(ctx: RequestContext, req: Request): Promise<Response> {
  const body = await parseBody(req);
  if (!body || !body.username || !body.password) {
    return errorResponse("Missing username or password", 400);
  }

  const user = authenticate(ctx.config.dbPath, body.username, body.password);
  if (!user) {
    return errorResponse("Invalid username or password", 401);
  }

  const accessToken = await issueToken(ctx.keys, ctx.config, String(user.id), {
    username: user.username,
    is_admin: user.is_admin === 1,
  });

  const refreshToken = generateRefreshToken();
  const refreshTokenHash = hashRefreshToken(refreshToken);
  createRefreshToken(ctx.config.dbPath, user.id, refreshTokenHash, ctx.config.refreshTokenTtl);

  return json({
    token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: ctx.config.tokenTtl,
    refresh_expires_in: ctx.config.refreshTokenTtl,
    user: {
      id: user.id,
      username: user.username,
      is_admin: user.is_admin === 1,
    },
  });
}

async function handleRefreshToken(ctx: RequestContext, req: Request): Promise<Response> {
  const body = await parseBody(req);
  if (!body || !body.refresh_token || typeof body.refresh_token !== "string") {
    return errorResponse("Missing refresh_token", 400);
  }

  const tokenHash = hashRefreshToken(body.refresh_token);
  const stored = getRefreshTokenByHash(ctx.config.dbPath, tokenHash);
  if (!stored || stored.revoked_at || new Date(stored.expires_at) < new Date()) {
    return errorResponse("Invalid or expired refresh token", 401);
  }

  const user = getUserById(ctx.config.dbPath, stored.user_id);
  // user_id references users(id); guard against a deleted user just in case.
  if (!user) return errorResponse("User not found", 401);

  // Rotate the refresh token: revoke the old one and issue a new one.
  revokeRefreshToken(ctx.config.dbPath, tokenHash);

  const accessToken = await issueToken(ctx.keys, ctx.config, String(user.id), {
    username: user.username,
    is_admin: user.is_admin === 1,
  });

  const newRefreshToken = generateRefreshToken();
  const newRefreshTokenHash = hashRefreshToken(newRefreshToken);
  createRefreshToken(ctx.config.dbPath, user.id, newRefreshTokenHash, ctx.config.refreshTokenTtl);

  return json({
    token: accessToken,
    refresh_token: newRefreshToken,
    token_type: "Bearer",
    expires_in: ctx.config.tokenTtl,
    refresh_expires_in: ctx.config.refreshTokenTtl,
  });
}

async function handleMe(ctx: RequestContext, req: Request): Promise<Response> {
  const token = extractBearerToken(req.headers.get("Authorization"));
  if (!token) return errorResponse("Missing Authorization Bearer token", 401);

  const payload = await verifyToken(ctx.keys, ctx.config, token);
  if (!payload) return errorResponse("Token is invalid or expired", 401);

  return json({ user: payload });
}

type AdminCheckResult =
  | { ok: true; payload: TokenPayload }
  | { ok: false; status: number; message: string };

async function requireAdmin(ctx: RequestContext, req: Request): Promise<AdminCheckResult> {
  const token = extractBearerToken(req.headers.get("Authorization"));
  if (!token) return { ok: false, status: 401, message: "Missing Authorization Bearer token" };
  const payload = await verifyToken(ctx.keys, ctx.config, token);
  if (!payload) return { ok: false, status: 401, message: "Token is invalid or expired" };
  if (!payload.is_admin) return { ok: false, status: 403, message: "Admin privileges required" };
  return { ok: true, payload };
}

async function handleCreateUser(ctx: RequestContext, req: Request): Promise<Response> {
  const check = await requireAdmin(ctx, req);
  if (!check.ok) return errorResponse(check.message, check.status);

  const body = await parseBody(req);
  if (!body || !body.username || !body.password) {
    return errorResponse("Missing username or password", 400);
  }

  try {
    const user = createUser(ctx.config.dbPath, body.username, body.password, !!body.is_admin);
    return json(
      {
        id: user.id,
        username: user.username,
        is_admin: user.is_admin === 1,
        created_at: user.created_at,
      },
      201,
    );
  } catch (e: any) {
    return errorResponse(e.message, 409);
  }
}

async function handleListUsers(ctx: RequestContext, req: Request): Promise<Response> {
  const check = await requireAdmin(ctx, req);
  if (!check.ok) return errorResponse(check.message, check.status);

  const users = listUsers(ctx.config.dbPath).map((u) => ({
    id: u.id,
    username: u.username,
    is_admin: u.is_admin === 1,
    created_at: u.created_at,
  }));

  return json({ users });
}

async function handleDeleteUser(
  ctx: RequestContext,
  req: Request,
  username: string,
): Promise<Response> {
  const check = await requireAdmin(ctx, req);
  if (!check.ok) return errorResponse(check.message, check.status);

  if (check.payload.username === username) {
    return errorResponse("Cannot delete yourself", 400);
  }

  const ok = deleteUser(ctx.config.dbPath, username);
  if (!ok) return errorResponse(`User '${username}' not found`, 404);
  return json({ deleted: username });
}

// ─── Main entry point ──────────────────────────────

async function main() {
  const config = loadConfig();

  // Parse CLI arguments
  const args = process.argv.slice(2);
  const isBootstrap = args.includes("--bootstrap");
  const shouldCreateToken = args.find((a) => a.startsWith("--token-for="));

  // Initialize database
  initDb(config.dbPath);

  // Load or generate keys
  const keys = await loadOrGenerateKeys(config.keyDir, config.keyAlg);
  const jwks = await buildJwks(keys);

  const ctx: RequestContext = { config, keys, jwks };

  // bootstrap: create admin if database is empty
  if (isBootstrap || userCount(config.dbPath) === 0) {
    if (userCount(config.dbPath) === 0) {
      createUser(config.dbPath, config.adminUsername, config.adminPassword, true);
      console.log(`[bootstrap] Admin user created: ${config.adminUsername}`);
    }
  }

  // --token-for=username: convenience token issuance (for testing/CI)
  if (shouldCreateToken) {
    const username = shouldCreateToken.split("=")[1];
    const user = getUserByUsername(config.dbPath, username);
    if (!user) {
      console.error(`User '${username}' not found`);
      process.exit(1);
    }
    const token = await issueToken(keys, config, String(user.id), {
      username: user.username,
      is_admin: user.is_admin === 1,
    });
    console.log(token);
    return;
  }

  // Start HTTP service
  const server = Bun.serve({
    port: config.port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method.toUpperCase();

      try {
        // ── Public endpoints ──
        if (path === "/.well-known/jwks.json" && method === "GET") {
          return handleJwks(ctx);
        }
        if (path === "/health_check" && method === "GET") {
          return handleHealth(ctx);
        }
        if (path === "/auth/login" && method === "POST") {
          return handleLogin(ctx, req);
        }
        if (path === "/auth/refresh" && method === "POST") {
          return handleRefreshToken(ctx, req);
        }
        if (path === "/auth/me" && method === "GET") {
          return handleMe(ctx, req);
        }

        // ── Admin panel (HTML UI) ──
        if (path === "/admin" && method === "GET") {
          return handleAdminPanel();
        }

        // ── Admin endpoints ──
        if (path === "/admin/users" && method === "POST") {
          return handleCreateUser(ctx, req);
        }
        if (path === "/admin/users" && method === "GET") {
          return handleListUsers(ctx, req);
        }
        if (path.startsWith("/admin/users/") && method === "DELETE") {
          return handleDeleteUser(ctx, req, decodeURIComponent(path.replace("/admin/users/", "")));
        }

        // ── 404 ──
        return errorResponse("Not Found", 404);
      } catch (err) {
        console.error("[error]", err);
        return errorResponse("Internal error", 500);
      }
    },
  });

  console.log(`
╔══════════════════════════════════════════════════════╗
║            Lore Auth Service started                  ║
╠══════════════════════════════════════════════════════╣
  Port:        ${config.port}
  Key alg:     ${config.keyAlg}
  Key ID:      ${keys.kid}
  Issuer:      ${config.issuer}
  Audience:    ${config.audience}
  Token TTL:   ${config.tokenTtl}s
  Database:    ${config.dbPath}

  JWKS:        ${config.issuer}/.well-known/jwks.json
  Login:       ${config.issuer}/auth/login
  Admin panel: ${config.issuer}/admin

  ── Lore Server config snippet ──────────────────────
  [server.auth]
  jwt_issuer = "${config.issuer}"
  jwt_audience = ["${config.audience}"]

  [server.auth.jwk]
  endpoint = "${config.issuer}/.well-known/jwks.json"
╚══════════════════════════════════════════════════════╝
  `);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});