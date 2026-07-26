/**
 * index.ts — Lore Auth Service 入口
 *
 * REST 端点负责浏览器页面、管理 API、JWKS 与兼容登录；原生 gRPC 端点负责 Lore
 * 浏览器会话、Token 交换、权限查询和 ReBAC。两者共享同一数据库与签名密钥。
 */

import { readFileSync } from "fs";

import { handleAdminPanel } from "./admin-panel";
import { loadConfig } from "./config";
import type { AuthServiceContext } from "./context";
import {
  OWNER_PERMISSIONS,
  approveAuthSession,
  authenticate,
  createRefreshToken,
  createUser,
  deleteUser,
  ensureResource,
  getAuthSession,
  getRefreshTokenByHash,
  getUserById,
  getUserByUsername,
  hashRefreshToken,
  initDb,
  listResourceAccessAssignments,
  listResources,
  listUsers,
  revokeRefreshToken,
  setUserResourcePermissions,
  userCount,
} from "./db";
import { startGrpcServer, type RunningGrpcServer } from "./grpc-server";
import {
  extractBearerToken,
  generateRefreshToken,
  issueAuthenticationToken,
  issueToken,
  verifyToken,
  type TokenPayload,
} from "./jwt";
import { buildJwks, loadOrGenerateKeys } from "./keys";
import {
  renderInvalidSession,
  renderLoginPage,
  renderLoginSuccess,
} from "./login-page";

export interface RunningAuthService {
  context: AuthServiceContext;
  http: ReturnType<typeof Bun.serve>;
  grpc: RunningGrpcServer;
  close(): Promise<void>;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function html(content: string, status = 200): Response {
  return new Response(content, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

function errorResponse(message: string, status = 400): Response {
  return json({ error: message }, status);
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > 64 * 1024) return null;
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function parseFormBody(req: Request): Promise<Record<string, string> | null> {
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > 16 * 1024) return null;
  try {
    const form = await req.formData();
    return Object.fromEntries(
      [...form.entries()].map(([key, value]) => [
        key,
        typeof value === "string" ? value : "",
      ]),
    );
  } catch {
    return null;
  }
}

async function handleLogin(context: AuthServiceContext, req: Request): Promise<Response> {
  const body = await parseJsonBody(req);
  const username = typeof body?.username === "string" ? body.username : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!username || !password) return errorResponse("Missing username or password", 400);

  // 复用数据库认证函数的恒定时间哈希比较，同时保持外部错误不可枚举用户。
  const authenticated = authenticate(context.config.dbPath, username, password);
  if (!authenticated) return errorResponse("Invalid username or password", 401);

  const accessToken = await issueAuthenticationToken(
    context.keys,
    context.config,
    authenticated,
  );
  const refreshToken = generateRefreshToken();
  createRefreshToken(
    context.config.dbPath,
    authenticated.id,
    hashRefreshToken(refreshToken),
    context.config.refreshTokenTtl,
  );

  return json({
    token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: context.config.tokenTtl,
    refresh_expires_in: context.config.refreshTokenTtl,
    user: {
      id: authenticated.id,
      username: authenticated.username,
      is_admin: authenticated.is_admin === 1,
    },
  });
}

async function handleRefreshToken(
  context: AuthServiceContext,
  req: Request,
): Promise<Response> {
  const body = await parseJsonBody(req);
  const rawRefreshToken =
    typeof body?.refresh_token === "string" ? body.refresh_token : "";
  if (!rawRefreshToken) return errorResponse("Missing refresh_token", 400);

  const tokenHash = hashRefreshToken(rawRefreshToken);
  const stored = getRefreshTokenByHash(context.config.dbPath, tokenHash);
  if (!stored || stored.revoked_at || new Date(stored.expires_at) < new Date()) {
    return errorResponse("Invalid or expired refresh token", 401);
  }
  const user = getUserById(context.config.dbPath, stored.user_id);
  if (!user) return errorResponse("User not found", 401);

  // Refresh Token rotation：旧 Token 在签发新 Token 前立即失效。
  revokeRefreshToken(context.config.dbPath, tokenHash);
  const accessToken = await issueAuthenticationToken(context.keys, context.config, user);
  const refreshToken = generateRefreshToken();
  createRefreshToken(
    context.config.dbPath,
    user.id,
    hashRefreshToken(refreshToken),
    context.config.refreshTokenTtl,
  );

  return json({
    token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: context.config.tokenTtl,
    refresh_expires_in: context.config.refreshTokenTtl,
  });
}

async function handleMe(context: AuthServiceContext, req: Request): Promise<Response> {
  const token = extractBearerToken(req.headers.get("Authorization"));
  if (!token) return errorResponse("Missing Authorization Bearer token", 401);
  const payload = await verifyToken(context.keys, context.config, token);
  if (!payload) return errorResponse("Token is invalid or expired", 401);
  return json({ user: payload });
}

type AdminCheckResult =
  | { ok: true; payload: TokenPayload }
  | { ok: false; status: number; message: string };

async function requireAdmin(
  context: AuthServiceContext,
  req: Request,
): Promise<AdminCheckResult> {
  const token = extractBearerToken(req.headers.get("Authorization"));
  if (!token) return { ok: false, status: 401, message: "Missing Authorization Bearer token" };
  const payload = await verifyToken(context.keys, context.config, token);
  if (!payload) return { ok: false, status: 401, message: "Token is invalid or expired" };
  if (!payload.is_admin) {
    return { ok: false, status: 403, message: "Admin privileges required" };
  }
  return { ok: true, payload };
}

async function handleCreateUser(
  context: AuthServiceContext,
  req: Request,
): Promise<Response> {
  const check = await requireAdmin(context, req);
  if (!check.ok) return errorResponse(check.message, check.status);
  const body = await parseJsonBody(req);
  const username = typeof body?.username === "string" ? body.username : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!username || !password) return errorResponse("Missing username or password", 400);
  try {
    const user = createUser(
      context.config.dbPath,
      username,
      password,
      body?.is_admin === true,
    );
    return json(
      {
        id: user.id,
        username: user.username,
        is_admin: user.is_admin === 1,
        created_at: user.created_at,
      },
      201,
    );
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "User could not be created", 409);
  }
}

async function handleListUsers(
  context: AuthServiceContext,
  req: Request,
): Promise<Response> {
  const check = await requireAdmin(context, req);
  if (!check.ok) return errorResponse(check.message, check.status);
  return json({
    users: listUsers(context.config.dbPath).map((user) => ({
      id: user.id,
      username: user.username,
      is_admin: user.is_admin === 1,
      created_at: user.created_at,
    })),
  });
}

async function handleDeleteUser(
  context: AuthServiceContext,
  req: Request,
  username: string,
): Promise<Response> {
  const check = await requireAdmin(context, req);
  if (!check.ok) return errorResponse(check.message, check.status);
  if (check.payload.preferred_username === username) {
    return errorResponse("Cannot delete yourself", 400);
  }
  if (!deleteUser(context.config.dbPath, username)) {
    return errorResponse(`User '${username}' not found`, 404);
  }
  return json({ deleted: username });
}

async function handleListResources(
  context: AuthServiceContext,
  req: Request,
): Promise<Response> {
  const check = await requireAdmin(context, req);
  if (!check.ok) return errorResponse(check.message, check.status);
  return json({
    resources: listResources(context.config.dbPath),
    assignments: listResourceAccessAssignments(context.config.dbPath),
  });
}

async function handleCreateResource(
  context: AuthServiceContext,
  req: Request,
): Promise<Response> {
  const check = await requireAdmin(context, req);
  if (!check.ok) return errorResponse(check.message, check.status);
  const body = await parseJsonBody(req);
  const resourceId = typeof body?.resource_id === "string" ? body.resource_id.trim() : "";
  const resourceName =
    typeof body?.resource_name === "string" ? body.resource_name.trim() : resourceId;
  if (!/^urc-[0-9a-fA-F]{32}$/.test(resourceId)) {
    return errorResponse("resource_id must be urc-<32 hexadecimal repository id>", 400);
  }
  const resource = ensureResource(context.config.dbPath, resourceId, resourceName);
  return json(resource, 201);
}

async function handleSetResourceAccess(
  context: AuthServiceContext,
  req: Request,
  resourceId: string,
  username: string,
): Promise<Response> {
  const check = await requireAdmin(context, req);
  if (!check.ok) return errorResponse(check.message, check.status);
  const resource = listResources(context.config.dbPath).find(
    (item) => item.resource_id === resourceId,
  );
  const user = getUserByUsername(context.config.dbPath, username);
  if (!resource || !user) return errorResponse("Resource or user was not found", 404);
  const body = await parseJsonBody(req);
  const requested = Array.isArray(body?.permissions)
    ? body.permissions.filter((item): item is string => typeof item === "string")
    : [];
  const allowed = new Set<string>(OWNER_PERMISSIONS);
  if (requested.some((permission) => !allowed.has(permission))) {
    return errorResponse("permissions may only contain read, write, or admin", 400);
  }
  setUserResourcePermissions(context.config.dbPath, user.id, resourceId, requested);
  return json({ resource_id: resourceId, username, permissions: requested });
}

async function handleBrowserSessionApproval(
  context: AuthServiceContext,
  req: Request,
): Promise<Response> {
  const body = await parseFormBody(req);
  const sessionCode = body?.session_code ?? "";
  const clientState = body?.client_state ?? "";
  const username = body?.username?.trim() ?? "";
  const password = body?.password ?? "";
  if (!sessionCode || !clientState || !username || !password) {
    return html(renderInvalidSession("认证请求缺少必要字段，请返回 Lore Client 重试。"), 400);
  }

  const result = approveAuthSession(
    context.config.dbPath,
    clientState,
    sessionCode,
    username,
    password,
    context.config.authSessionMaxAttempts,
    context.config.authSessionLockSeconds,
  );
  if (result.ok) return html(renderLoginSuccess(result.user.username));

  if (result.reason === "invalid_session" || result.reason === "expired") {
    return html(renderInvalidSession(), 410);
  }
  const message =
    result.reason === "locked"
      ? `尝试次数过多，请在 ${result.retryAfterSeconds ?? 60} 秒后重试。`
      : "用户名或密码不正确。";
  return html(renderLoginPage({ sessionCode, clientState, error: message }), 401);
}

/**
 * 创建无状态 HTTP 请求处理器。
 *
 * 单独导出是为了让浏览器登录流程可在不占用真实端口的情况下完成集成测试；生产环境仍由
 * `startAuthService` 将它挂载到 Bun HTTP/HTTPS 服务。
 */
export function createHttpHandler(context: AuthServiceContext) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();

    try {
      if (path === "/.well-known/jwks.json" && method === "GET") return json(context.jwks);
      if (path === "/health_check" && method === "GET") {
        return json({
          status: "ok",
          service: "lore-auth",
          keys: context.jwks.keys.length,
          grpc_port: context.config.grpcPort,
        });
      }
      if (path === "/auth/login" && method === "POST") return handleLogin(context, req);
      if (path === "/auth/refresh" && method === "POST") {
        return handleRefreshToken(context, req);
      }
      if (path === "/auth/me" && method === "GET") return handleMe(context, req);

      if (path === "/login" && method === "GET") {
        const sessionCode = url.searchParams.get("session_code") ?? "";
        const clientState = url.searchParams.get("client_state") ?? "";
        if (!getAuthSession(context.config.dbPath, clientState, sessionCode)) {
          return html(renderInvalidSession(), 410);
        }
        return html(renderLoginPage({ sessionCode, clientState }));
      }
      if (path === "/auth/session/approve" && method === "POST") {
        return handleBrowserSessionApproval(context, req);
      }

      if (path === "/admin" && method === "GET") return handleAdminPanel();
      if (path === "/admin/users" && method === "POST") {
        return handleCreateUser(context, req);
      }
      if (path === "/admin/users" && method === "GET") return handleListUsers(context, req);
      if (path.startsWith("/admin/users/") && method === "DELETE") {
        return handleDeleteUser(
          context,
          req,
          decodeURIComponent(path.slice("/admin/users/".length)),
        );
      }
      if (path === "/admin/resources" && method === "GET") {
        return handleListResources(context, req);
      }
      if (path === "/admin/resources" && method === "POST") {
        return handleCreateResource(context, req);
      }

      const assignmentMatch = path.match(
        /^\/admin\/resources\/([^/]+)\/users\/([^/]+)$/,
      );
      if (assignmentMatch && method === "PUT") {
        return handleSetResourceAccess(
          context,
          req,
          decodeURIComponent(assignmentMatch[1]),
          decodeURIComponent(assignmentMatch[2]),
        );
      }

      return errorResponse("Not Found", 404);
    } catch (error) {
      console.error("[http] Request failed", error);
      return errorResponse("Internal error", 500);
    }
  };
}

export async function createAuthServiceContext(): Promise<AuthServiceContext> {
  const config = loadConfig();
  initDb(config.dbPath);
  const keys = await loadOrGenerateKeys(config.keyDir, config.keyAlg);
  const jwks = await buildJwks(keys);
  return { config, keys, jwks };
}

/** 仅在空数据库中创建首个管理员，并对仍使用示例密码的部署给出明确告警。 */
function bootstrapAdmin(context: AuthServiceContext): void {
  createUser(
    context.config.dbPath,
    context.config.adminUsername,
    context.config.adminPassword,
    true,
  );
  console.log(`[bootstrap] Admin user created: ${context.config.adminUsername}`);
  if (context.config.adminPassword === "changeme") {
    console.warn(
      "[security] Default admin password is in use. Set ADMIN_PASSWORD before exposing this service.",
    );
  }
}

export async function startAuthService(
  context?: AuthServiceContext,
): Promise<RunningAuthService> {
  const resolvedContext = context ?? (await createAuthServiceContext());
  if (userCount(resolvedContext.config.dbPath) === 0) {
    bootstrapAdmin(resolvedContext);
  }

  const grpc = await startGrpcServer(resolvedContext);
  const tls =
    resolvedContext.config.tlsCertFile && resolvedContext.config.tlsKeyFile
      ? {
          cert: readFileSync(resolvedContext.config.tlsCertFile),
          key: readFileSync(resolvedContext.config.tlsKeyFile),
        }
      : undefined;
  const http = Bun.serve({
    hostname: resolvedContext.config.host,
    port: resolvedContext.config.port,
    tls,
    fetch: createHttpHandler(resolvedContext),
  });

  return {
    context: resolvedContext,
    http,
    grpc,
    async close() {
      http.stop(true);
      await grpc.close();
    },
  };
}

async function main(): Promise<void> {
  const context = await createAuthServiceContext();
  const args = process.argv.slice(2);
  const tokenFor = args.find((argument) => argument.startsWith("--token-for="));

  if (args.includes("--bootstrap") || userCount(context.config.dbPath) === 0) {
    if (userCount(context.config.dbPath) === 0) {
      bootstrapAdmin(context);
    }
  }

  if (tokenFor) {
    const username = tokenFor.slice("--token-for=".length);
    const user = getUserByUsername(context.config.dbPath, username);
    if (!user) throw new Error(`User '${username}' not found`);
    console.log(await issueToken(context.keys, context.config, String(user.id), {
      username: user.username,
      is_admin: user.is_admin === 1,
    }));
    return;
  }

  const service = await startAuthService(context);
  const grpcScheme = service.grpc.secure ? "https" : "http";
  console.log(`
Lore Auth Service started
  HTTP:        ${context.config.publicBaseUrl}
  gRPC:        ${grpcScheme}://${context.config.grpcHost}:${service.grpc.port}
  JWKS:        ${context.config.publicBaseUrl}/.well-known/jwks.json
  Browser:     ${context.config.publicBaseUrl}/login
  Issuer:      ${context.config.issuer}
  Audience:    ${context.config.audience.join(", ")}
  Database:    ${context.config.dbPath}
`);
  if (!service.grpc.secure) {
    console.warn(
      "[security] gRPC is running without TLS. Current Lore clients require a trusted HTTPS auth endpoint.",
    );
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[shutdown] Stopping Lore Auth Service");
    await service.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Fatal:", error);
    process.exit(1);
  });
}
