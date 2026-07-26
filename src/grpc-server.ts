/**
 * grpc-server.ts — Lore UrcAuthApi 与 RebacApi 的原生 gRPC 实现
 *
 * Proto 文件固定复制自当前 Lore 版本。这里使用动态加载避免生成代码漂移；所有字段
 * 保持 snake_case，与 Lore Proto 一致，HTTP/2 线协议仍由 grpc-js 正常编码。
 */

import {
  Server,
  ServerCredentials,
  status,
  type GrpcObject,
  type Metadata,
  type ServiceDefinition,
  type ServiceClientConstructor,
  type ServerUnaryCall,
  type ServiceError,
  type UntypedServiceImplementation,
  type sendUnaryData,
  loadPackageDefinition,
} from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

import type { AuthServiceContext } from "./context";
import {
  OWNER_PERMISSIONS,
  createAuthSession,
  createResource,
  deleteResource,
  ensureResource,
  getApprovedSessionUser,
  getResource,
  getUserById,
  getUserByUsername,
  getUserResourcePermissions,
  hasResourcePermission,
  type ResourcePermission,
  type User,
} from "./db";
import {
  extractBearerToken,
  issueAuthenticationToken,
  issueAuthorizationToken,
  verifyToken,
} from "./jwt";

type UnaryCall<Request = Record<string, unknown>> = ServerUnaryCall<
  Request,
  Record<string, unknown>
>;
type UnaryCallback<Response = Record<string, unknown>> = sendUnaryData<Response>;

interface AuthApiPackage extends GrpcObject {
  UrcAuthApi: ServiceClientConstructor;
}

interface RebacApiPackage extends GrpcObject {
  RebacApi: ServiceClientConstructor;
}

interface LoadedLoreProto {
  authService: ServiceDefinition;
  rebacService: ServiceDefinition;
}

export interface RunningGrpcServer {
  server: Server;
  port: number;
  secure: boolean;
  close(): Promise<void>;
}

function protoPath(filename: string): string {
  return fileURLToPath(new URL(`../proto/${filename}`, import.meta.url));
}

export function loadLoreProto(): LoadedLoreProto {
  const definition = loadSync([protoPath("auth_api.proto"), protoPath("rebac_api.proto")], {
    keepCase: true,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const root = loadPackageDefinition(definition) as GrpcObject;
  const epicUrc = root.epic_urc as AuthApiPackage | undefined;
  const ucs = root.ucs as GrpcObject | undefined;
  const ucsAuth = ucs?.auth as RebacApiPackage | undefined;
  if (!epicUrc?.UrcAuthApi?.service || !ucsAuth?.RebacApi?.service) {
    throw new Error("Lore authentication Proto services could not be loaded");
  }
  return {
    authService: epicUrc.UrcAuthApi.service,
    rebacService: ucsAuth.RebacApi.service,
  };
}

function grpcError(code: status, message: string): ServiceError {
  return Object.assign(new Error(message), { code }) as ServiceError;
}

function metadataBearer(metadata: Metadata): string | null {
  const value = metadata.get("authorization")[0];
  const raw = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  return extractBearerToken(typeof raw === "string" ? raw : null);
}

async function userFromToken(
  context: AuthServiceContext,
  token: string | null,
): Promise<User | null> {
  if (!token) return null;
  const payload = await verifyToken(context.keys, context.config, token);
  if (!payload || !/^\d+$/.test(payload.sub)) return null;
  return getUserById(context.config.dbPath, Number(payload.sub));
}

async function requireCaller(
  context: AuthServiceContext,
  call: UnaryCall,
): Promise<User> {
  const user = await userFromToken(context, metadataBearer(call.metadata));
  if (!user) throw grpcError(status.UNAUTHENTICATED, "Valid Authorization Bearer token required");
  return user;
}

function asUserToken(token: string, user: User, expiresAtMs: number): Record<string, unknown> {
  return {
    user_token: token,
    expires_at: expiresAtMs,
    user_id: String(user.id),
    user_name: user.username,
  };
}

function tokenExpiryMs(context: AuthServiceContext): number {
  return Date.now() + context.config.tokenTtl * 1000;
}

function validClientState(value: unknown): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= 512;
}

function validSessionCode(value: unknown): value is string {
  return typeof value === "string" && value.length >= 32 && value.length <= 512;
}

function validResourceId(resourceId: string): boolean {
  return /^urc-[0-9a-fA-F]{32}$/.test(resourceId);
}

function unary<Request, Response>(
  handler: (call: UnaryCall<Request>) => Promise<Response> | Response,
): (call: UnaryCall<Request>, callback: UnaryCallback<Response>) => void {
  return (call, callback) => {
    Promise.resolve(handler(call)).then(
      (response) => callback(null, response),
      (error: unknown) => {
        callback(
          error && typeof error === "object" && "code" in error
            ? (error as ServiceError)
            : grpcError(status.INTERNAL, "Authentication service operation failed"),
          null,
        );
      },
    );
  };
}

async function resolveTargetUser(
  context: AuthServiceContext,
  caller: User,
  targetUser: { user_token?: string } | undefined,
): Promise<User> {
  if (!targetUser?.user_token) return caller;
  const target = await userFromToken(context, targetUser.user_token);
  if (!target) throw grpcError(status.UNAUTHENTICATED, "Target user token is invalid");
  if (target.id !== caller.id && caller.is_admin !== 1) {
    throw grpcError(status.PERMISSION_DENIED, "Target user lookup requires administrator access");
  }
  return target;
}

function buildAuthImplementation(
  context: AuthServiceContext,
): UntypedServiceImplementation {
  return {
    HealthCheck: unary(() => ({ status: "ok" })),

    StartAuthSession: unary<{ client_state?: string }, Record<string, unknown>>((call) => {
      const clientState = call.request.client_state;
      if (!validClientState(clientState)) {
        throw grpcError(status.INVALID_ARGUMENT, "client_state is required");
      }
      const session = createAuthSession(
        context.config.dbPath,
        clientState,
        context.config.authSessionTtl,
      );
      const url = new URL("/login", `${context.config.publicBaseUrl}/`);
      url.searchParams.set("session_code", session.sessionCode);
      url.searchParams.set("client_state", clientState);
      return {
        session_code: session.sessionCode,
        login_url: url.toString(),
      };
    }),

    GetAuthSession: unary<
      { client_state?: string; session_code?: string },
      Record<string, unknown>
    >(async (call) => {
      const { client_state: clientState, session_code: sessionCode } = call.request;
      if (!validClientState(clientState) || !validSessionCode(sessionCode)) {
        throw grpcError(status.INVALID_ARGUMENT, "client_state and session_code are required");
      }
      const user = getApprovedSessionUser(context.config.dbPath, clientState, sessionCode);
      if (!user) return {};
      const token = await issueAuthenticationToken(context.keys, context.config, user);
      return {
        user_token: asUserToken(token, user, tokenExpiryMs(context)),
      };
    }),

    RefreshAuthSession: unary(() => {
      throw grpcError(
        status.UNIMPLEMENTED,
        "Lore's current UcsAuthentication client does not send a refresh token",
      );
    }),

    VerifyUser: unary<
      { target_user?: { user_token?: string } },
      Record<string, unknown>
    >(async (call) => {
      const token = call.request.target_user?.user_token;
      const user = await userFromToken(context, token ?? null);
      if (!user) throw grpcError(status.UNAUTHENTICATED, "User token is invalid");
      return {
        user_info: { user_id: String(user.id), display_name: user.username },
      };
    }),

    ExchangeExternalTokenForUserToken: unary<
      { external_token?: string },
      Record<string, unknown>
    >(async (call) => {
      const user = await userFromToken(context, call.request.external_token ?? null);
      if (!user) throw grpcError(status.UNAUTHENTICATED, "External token is invalid");
      const token = await issueAuthenticationToken(context.keys, context.config, user);
      return {
        user_token: asUserToken(token, user, tokenExpiryMs(context)),
      };
    }),

    ExchangeAPIKeyForUserToken: unary(() => {
      throw grpcError(status.UNIMPLEMENTED, "API key authentication is not configured");
    }),

    ExchangeUserTokenForMultiresourceToken: unary<
      { resource_id?: string[] },
      Record<string, unknown>
    >(async (call) => {
      const user = await requireCaller(context, call);
      const requested = [...new Set(call.request.resource_id ?? [])];
      if (requested.length === 0 || requested.some((item) => !validResourceId(item))) {
        throw grpcError(status.INVALID_ARGUMENT, "At least one valid urc-<repository-id> is required");
      }

      if (user.is_admin === 1) {
        // 管理员首次访问旧仓库时自动登记资源，便于从启用 Auth 前的部署平滑迁移。
        for (const resourceId of requested) {
          ensureResource(context.config.dbPath, resourceId);
        }
      }
      const available = new Map(
        getUserResourcePermissions(context.config.dbPath, user).map((item) => [
          item.resource_id,
          item,
        ]),
      );
      const resources = requested
        .map((resourceId) => available.get(resourceId))
        .filter((item): item is ResourcePermission => Boolean(item));
      if (resources.length !== requested.length) {
        throw grpcError(status.PERMISSION_DENIED, "User is not allowed to access every requested resource");
      }

      const token = await issueAuthorizationToken(
        context.keys,
        context.config,
        user,
        resources,
      );
      return {
        token: asUserToken(token, user, tokenExpiryMs(context)),
      };
    }),

    CheckUserPermission: unary<
      { resource_id?: string[]; target_user?: { user_token?: string } },
      Record<string, unknown>
    >(async (call) => {
      const caller = await requireCaller(context, call);
      const target = await resolveTargetUser(context, caller, call.request.target_user);
      const requested = [...new Set(call.request.resource_id ?? [])];
      const permissions = new Map(
        getUserResourcePermissions(context.config.dbPath, target).map((item) => [
          item.resource_id,
          item,
        ]),
      );
      const allowed: ResourcePermission[] = [];
      const denied: ResourcePermission[] = [];
      for (const resourceId of requested) {
        const permission = permissions.get(resourceId);
        if (permission) {
          allowed.push(permission);
        } else {
          denied.push({ resource_id: resourceId, permission: [] });
        }
      }
      return {
        allowed_resource_permission: allowed,
        denied_resource_permission: denied,
      };
    }),

    LookupUserPermissions: unary<
      { resource_filter?: string; page_size?: number; page_token?: string },
      Record<string, unknown>
    >(async (call) => {
      const user = await requireCaller(context, call);
      const all = getUserResourcePermissions(
        context.config.dbPath,
        user,
        call.request.resource_filter ?? "",
      );
      const pageSize = Math.min(Math.max(call.request.page_size || 1000, 1), 5000);
      const rawOffset = call.request.page_token ?? "";
      if (rawOffset && !/^\d+$/.test(rawOffset)) {
        throw grpcError(status.INVALID_ARGUMENT, "page_token is invalid");
      }
      const offset = rawOffset ? Number(rawOffset) : 0;
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw grpcError(status.INVALID_ARGUMENT, "page_token is invalid");
      }
      const nextOffset = offset + pageSize;
      return {
        resource_permission: all.slice(offset, nextOffset),
        next_page_token: all.length > nextOffset ? String(nextOffset) : "",
      };
    }),

    GetUserInfo: unary<
      { resource_id?: string; user_id?: string[] },
      Record<string, unknown>
    >(async (call) => {
      const caller = await requireCaller(context, call);
      const resourceId = call.request.resource_id ?? "";
      if (!resourceId || !hasResourcePermission(context.config.dbPath, caller, resourceId)) {
        throw grpcError(status.PERMISSION_DENIED, "Repository access is required");
      }
      const userInfo = (call.request.user_id ?? [])
        .map((id) => (/^\d+$/.test(id) ? getUserById(context.config.dbPath, Number(id)) : null))
        .filter((user): user is User => Boolean(user))
        .map((user) => ({ user_id: String(user.id), display_name: user.username }));
      return { user_info: userInfo };
    }),

    GetUserId: unary<
      { resource_id?: string; user_display_name?: string },
      Record<string, unknown>
    >(async (call) => {
      const caller = await requireCaller(context, call);
      const resourceId = call.request.resource_id ?? "";
      if (!resourceId || !hasResourcePermission(context.config.dbPath, caller, resourceId)) {
        throw grpcError(status.PERMISSION_DENIED, "Repository access is required");
      }
      const user = getUserByUsername(
        context.config.dbPath,
        call.request.user_display_name ?? "",
      );
      return {
        user_info: user
          ? { user_id: String(user.id), display_name: user.username }
          : undefined,
      };
    }),

    GetProviderUserId: unary<{ user_id?: string }, Record<string, unknown>>(async (call) => {
      await requireCaller(context, call);
      const userId = call.request.user_id ?? "";
      if (!/^\d+$/.test(userId) || !getUserById(context.config.dbPath, Number(userId))) {
        throw grpcError(status.NOT_FOUND, "User was not found");
      }
      return { user_id: userId, provider_user_id: userId };
    }),
  };
}

function buildRebacImplementation(
  context: AuthServiceContext,
): UntypedServiceImplementation {
  return {
    CreateResource: unary<
      { resource_id?: string; resource_name?: string },
      Record<string, never>
    >(async (call) => {
      const caller = await requireCaller(context, call);
      const resourceId = call.request.resource_id ?? "";
      if (!validResourceId(resourceId)) {
        throw grpcError(status.INVALID_ARGUMENT, "resource_id must be urc-<repository-id>");
      }
      const created = createResource(
        context.config.dbPath,
        resourceId,
        call.request.resource_name ?? resourceId,
        caller.id,
      );
      if (!created) throw grpcError(status.ALREADY_EXISTS, "Resource already exists");
      return {};
    }),

    DeleteResource: unary<{ resource_id?: string }, Record<string, never>>(async (call) => {
      const caller = await requireCaller(context, call);
      const resourceId = call.request.resource_id ?? "";
      if (!validResourceId(resourceId) || !getResource(context.config.dbPath, resourceId)) {
        throw grpcError(status.NOT_FOUND, "Resource was not found");
      }
      if (!hasResourcePermission(context.config.dbPath, caller, resourceId, "admin")) {
        throw grpcError(status.PERMISSION_DENIED, "Resource administrator access is required");
      }
      deleteResource(context.config.dbPath, resourceId);
      return {};
    }),
  };
}

function serverCredentials(context: AuthServiceContext): {
  credentials: ServerCredentials;
  secure: boolean;
} {
  const { tlsCertFile, tlsKeyFile } = context.config;
  if ((tlsCertFile && !tlsKeyFile) || (!tlsCertFile && tlsKeyFile)) {
    throw new Error("TLS_CERT_FILE and TLS_KEY_FILE must be configured together");
  }
  if (!tlsCertFile || !tlsKeyFile) {
    return { credentials: ServerCredentials.createInsecure(), secure: false };
  }
  return {
    credentials: ServerCredentials.createSsl(
      null,
      [
        {
          private_key: readFileSync(tlsKeyFile),
          cert_chain: readFileSync(tlsCertFile),
        },
      ],
      false,
    ),
    secure: true,
  };
}

export async function startGrpcServer(
  context: AuthServiceContext,
): Promise<RunningGrpcServer> {
  const proto = loadLoreProto();
  const server = new Server({
    "grpc.max_receive_message_length": 1024 * 1024,
    "grpc.max_send_message_length": 1024 * 1024,
  });
  server.addService(proto.authService, buildAuthImplementation(context));
  server.addService(proto.rebacService, buildRebacImplementation(context));

  const { credentials, secure } = serverCredentials(context);
  const address = `${context.config.grpcHost}:${context.config.grpcPort}`;
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync(address, credentials, (error, boundPort) => {
      if (error) reject(error);
      else resolve(boundPort);
    });
  });

  return {
    server,
    port,
    secure,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.tryShutdown((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
