/**
 * db.ts — 用户、浏览器认证会话与 Lore 资源权限持久化
 *
 * 认证服务只持久化密码哈希、Refresh Token 哈希和浏览器会话随机值的哈希。
 * 原始密码、浏览器 session_code、client_state 与 JWT 都不会写入数据库。
 */

import { Database } from "bun:sqlite";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { resolve } from "path";

export interface User {
  id: number;
  username: string;
  password_hash: string;
  is_admin: number;
  created_at: string;
}

export interface RefreshToken {
  id: number;
  user_id: number;
  token_hash: string;
  expires_at: string;
  created_at: string;
  revoked_at: string | null;
}

export interface AuthSession {
  session_code_hash: string;
  client_state_hash: string;
  status: "pending" | "approved";
  user_id: number | null;
  expires_at_ms: number;
  failed_attempts: number;
  locked_until_ms: number | null;
  created_at_ms: number;
  approved_at_ms: number | null;
  last_polled_at_ms: number | null;
}

export interface AuthResource {
  resource_id: string;
  resource_name: string;
  created_by_user_id: number | null;
  created_at: string;
}

export interface ResourcePermission {
  resource_id: string;
  permission: string[];
}

export interface ResourceAccessAssignment {
  resource_id: string;
  username: string;
  permission: string[];
}

export type ApproveSessionResult =
  | { ok: true; user: User }
  | {
      ok: false;
      reason: "invalid_session" | "expired" | "locked" | "invalid_credentials";
      retryAfterSeconds?: number;
    };

const databaseCache = new Map<string, Database>();

/**
 * 同一进程可同时运行生产数据库和多个 `:memory:` 测试数据库，因此不能继续使用
 * 单一全局连接。路径归一化后按库缓存，也避免重复初始化 Schema。
 */
function databaseKey(dbPath: string): string {
  return dbPath === ":memory:" ? dbPath : resolve(dbPath);
}

function getDb(dbPath: string): Database {
  const key = databaseKey(dbPath);
  const cached = databaseCache.get(key);
  if (cached) return cached;

  const dir =
    dbPath.includes("/") || dbPath.includes("\\")
      ? dbPath.replace(/[/\\][^/\\]*$/, "")
      : ".";
  if (dir && dbPath !== ":memory:" && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const connection = new Database(dbPath);
  connection.exec("PRAGMA foreign_keys = ON;");
  initializeSchema(connection);
  databaseCache.set(key, connection);
  return connection;
}

function initializeSchema(connection: Database): void {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_admin      INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL,
      token_hash    TEXT NOT NULL UNIQUE,
      expires_at    TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at    TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

    CREATE TABLE IF NOT EXISTS auth_sessions (
      session_code_hash TEXT PRIMARY KEY,
      client_state_hash TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'approved')),
      user_id           INTEGER,
      expires_at_ms     INTEGER NOT NULL,
      failed_attempts   INTEGER NOT NULL DEFAULT 0,
      locked_until_ms   INTEGER,
      created_at_ms     INTEGER NOT NULL,
      approved_at_ms    INTEGER,
      last_polled_at_ms INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry
      ON auth_sessions(expires_at_ms);

    CREATE TABLE IF NOT EXISTS resources (
      resource_id        TEXT PRIMARY KEY,
      resource_name      TEXT NOT NULL,
      created_by_user_id INTEGER,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS user_resource_permissions (
      user_id     INTEGER NOT NULL,
      resource_id TEXT NOT NULL,
      permission  TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, resource_id, permission),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (resource_id) REFERENCES resources(resource_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_user_resource_permissions_user
      ON user_resource_permissions(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_resource_permissions_resource
      ON user_resource_permissions(resource_id);
  `);
}

export function initDb(dbPath: string): void {
  getDb(dbPath);
}

/** 测试结束时显式释放 SQLite 句柄，避免 Windows 临时文件仍被占用。 */
export function closeDb(dbPath: string): void {
  const key = databaseKey(dbPath);
  const connection = databaseCache.get(key);
  if (!connection) return;
  connection.close();
  databaseCache.delete(key);
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function hashRefreshToken(token: string): string {
  return hashOpaqueToken(token);
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

// 用户不存在时仍执行一次同成本的 scrypt，降低通过响应时间枚举用户名的风险。
const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(32).toString("hex"));

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const hashBuffer = Buffer.from(hash, "hex");
  const candidate = scryptSync(password, salt, 64);
  if (hashBuffer.length !== candidate.length) return false;
  return timingSafeEqual(hashBuffer, candidate);
}

export function createUser(
  dbPath: string,
  username: string,
  password: string,
  isAdmin = false,
): User {
  const connection = getDb(dbPath);
  const normalizedUsername = username.trim();
  if (!normalizedUsername || password.length < 8) {
    throw new Error("Username is required and password must contain at least 8 characters");
  }

  try {
    connection.run(
      "INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)",
      [normalizedUsername, hashPassword(password), isAdmin ? 1 : 0],
    );
  } catch {
    throw new Error(`User '${normalizedUsername}' already exists`);
  }
  return getUserByUsername(dbPath, normalizedUsername)!;
}

export function getUserByUsername(dbPath: string, username: string): User | null {
  return getDb(dbPath)
    .query("SELECT * FROM users WHERE username = ?")
    .get(username.trim()) as User | null;
}

export function getUserById(dbPath: string, id: number): User | null {
  return getDb(dbPath).query("SELECT * FROM users WHERE id = ?").get(id) as User | null;
}

export function authenticate(dbPath: string, username: string, password: string): User | null {
  const user = getUserByUsername(dbPath, username);
  const passwordMatches = verifyPassword(
    password,
    user?.password_hash ?? DUMMY_PASSWORD_HASH,
  );
  if (!user || !passwordMatches) return null;
  return user;
}

export function listUsers(dbPath: string): User[] {
  return getDb(dbPath).query("SELECT * FROM users ORDER BY id").all() as User[];
}

export function deleteUser(dbPath: string, username: string): boolean {
  const result = getDb(dbPath).run("DELETE FROM users WHERE username = ?", [username]);
  return result.changes > 0;
}

export function userCount(dbPath: string): number {
  const row = getDb(dbPath).query("SELECT COUNT(*) as count FROM users").get() as {
    count: number;
  };
  return row.count;
}

// ─── Refresh Token ──────────────────────────────────────────────────────────

export function createRefreshToken(
  dbPath: string,
  userId: number,
  tokenHash: string,
  ttlSeconds: number,
): RefreshToken {
  const connection = getDb(dbPath);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  connection.run(
    "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
    [userId, tokenHash, expiresAt],
  );
  return connection
    .query("SELECT * FROM refresh_tokens WHERE token_hash = ?")
    .get(tokenHash) as RefreshToken;
}

export function getRefreshTokenByHash(
  dbPath: string,
  tokenHash: string,
): RefreshToken | null {
  return getDb(dbPath)
    .query("SELECT * FROM refresh_tokens WHERE token_hash = ?")
    .get(tokenHash) as RefreshToken | null;
}

export function revokeRefreshToken(dbPath: string, tokenHash: string): boolean {
  const result = getDb(dbPath).run(
    "UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE token_hash = ?",
    [tokenHash],
  );
  return result.changes > 0;
}

export function revokeAllUserRefreshTokens(dbPath: string, userId: number): void {
  getDb(dbPath).run(
    "UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL",
    [userId],
  );
}

export function cleanupExpiredRefreshTokens(dbPath: string): void {
  getDb(dbPath).run("DELETE FROM refresh_tokens WHERE expires_at < datetime('now')");
}

// ─── 浏览器认证会话 ───────────────────────────────────────────────────────

export function createAuthSession(
  dbPath: string,
  clientState: string,
  ttlSeconds: number,
): { sessionCode: string; expiresAtMs: number } {
  const connection = getDb(dbPath);
  const now = Date.now();
  const sessionCode = randomBytes(32).toString("base64url");
  const expiresAtMs = now + ttlSeconds * 1000;

  cleanupExpiredAuthSessions(dbPath, now);
  connection.run(
    `INSERT INTO auth_sessions (
       session_code_hash, client_state_hash, expires_at_ms, created_at_ms
     ) VALUES (?, ?, ?, ?)`,
    [hashOpaqueToken(sessionCode), hashOpaqueToken(clientState), expiresAtMs, now],
  );
  return { sessionCode, expiresAtMs };
}

export function getAuthSession(
  dbPath: string,
  clientState: string,
  sessionCode: string,
): AuthSession | null {
  const session = getDb(dbPath)
    .query(
      `SELECT * FROM auth_sessions
       WHERE session_code_hash = ? AND client_state_hash = ?`,
    )
    .get(hashOpaqueToken(sessionCode), hashOpaqueToken(clientState)) as AuthSession | null;
  if (!session || session.expires_at_ms <= Date.now()) return null;
  return session;
}

export function approveAuthSession(
  dbPath: string,
  clientState: string,
  sessionCode: string,
  username: string,
  password: string,
  maxAttempts: number,
  lockSeconds: number,
): ApproveSessionResult {
  const connection = getDb(dbPath);
  const now = Date.now();
  const session = getAuthSession(dbPath, clientState, sessionCode);
  if (!session) return { ok: false, reason: "invalid_session" };
  if (session.expires_at_ms <= now) return { ok: false, reason: "expired" };
  if (session.locked_until_ms && session.locked_until_ms > now) {
    return {
      ok: false,
      reason: "locked",
      retryAfterSeconds: Math.ceil((session.locked_until_ms - now) / 1000),
    };
  }

  const user = authenticate(dbPath, username, password);
  if (!user) {
    const failedAttempts = session.failed_attempts + 1;
    const lockedUntil =
      failedAttempts >= Math.max(1, maxAttempts) ? now + lockSeconds * 1000 : null;
    connection.run(
      `UPDATE auth_sessions
       SET failed_attempts = ?, locked_until_ms = ?
       WHERE session_code_hash = ?`,
      [failedAttempts, lockedUntil, session.session_code_hash],
    );
    return {
      ok: false,
      reason: lockedUntil ? "locked" : "invalid_credentials",
      retryAfterSeconds: lockedUntil ? lockSeconds : undefined,
    };
  }

  connection.run(
    `UPDATE auth_sessions
     SET status = 'approved', user_id = ?, approved_at_ms = ?,
         failed_attempts = 0, locked_until_ms = NULL
     WHERE session_code_hash = ?`,
    [user.id, now, session.session_code_hash],
  );
  return { ok: true, user };
}

export function getApprovedSessionUser(
  dbPath: string,
  clientState: string,
  sessionCode: string,
): User | null {
  const session = getAuthSession(dbPath, clientState, sessionCode);
  if (!session || session.status !== "approved" || session.user_id === null) return null;

  getDb(dbPath).run(
    "UPDATE auth_sessions SET last_polled_at_ms = ? WHERE session_code_hash = ?",
    [Date.now(), session.session_code_hash],
  );
  return getUserById(dbPath, session.user_id);
}

export function cleanupExpiredAuthSessions(dbPath: string, now = Date.now()): void {
  getDb(dbPath).run("DELETE FROM auth_sessions WHERE expires_at_ms <= ?", [now]);
}

// ─── Lore 资源与权限 ───────────────────────────────────────────────────────

export const OWNER_PERMISSIONS = ["read", "write", "admin"] as const;

export function createResource(
  dbPath: string,
  resourceId: string,
  resourceName: string,
  ownerUserId: number,
): boolean {
  const connection = getDb(dbPath);
  const transaction = connection.transaction(() => {
    const result = connection.run(
      `INSERT OR IGNORE INTO resources
       (resource_id, resource_name, created_by_user_id)
       VALUES (?, ?, ?)`,
      [resourceId, resourceName || resourceId, ownerUserId],
    );
    if (result.changes === 0) return false;
    setUserResourcePermissions(dbPath, ownerUserId, resourceId, [...OWNER_PERMISSIONS]);
    return true;
  });
  return transaction();
}

/**
 * 仅供管理员迁移已有 Lore 仓库。若资源已经存在，只更新更可读的名称，不改变权限。
 */
export function ensureResource(
  dbPath: string,
  resourceId: string,
  resourceName = resourceId,
): AuthResource {
  const connection = getDb(dbPath);
  connection.run(
    `INSERT INTO resources (resource_id, resource_name)
     VALUES (?, ?)
     ON CONFLICT(resource_id) DO UPDATE SET
       resource_name = CASE
         WHEN resources.resource_name = resources.resource_id THEN excluded.resource_name
         ELSE resources.resource_name
       END`,
    [resourceId, resourceName || resourceId],
  );
  return getResource(dbPath, resourceId)!;
}

export function getResource(dbPath: string, resourceId: string): AuthResource | null {
  return getDb(dbPath)
    .query("SELECT * FROM resources WHERE resource_id = ?")
    .get(resourceId) as AuthResource | null;
}

export function listResources(dbPath: string): AuthResource[] {
  return getDb(dbPath)
    .query("SELECT * FROM resources ORDER BY resource_name, resource_id")
    .all() as AuthResource[];
}

export function listResourceAccessAssignments(dbPath: string): ResourceAccessAssignment[] {
  const rows = getDb(dbPath)
    .query(
      `SELECT p.resource_id, u.username, p.permission
       FROM user_resource_permissions p
       JOIN users u ON u.id = p.user_id
       ORDER BY p.resource_id, u.username, p.permission`,
    )
    .all() as Array<{ resource_id: string; username: string; permission: string }>;
  const grouped = new Map<string, ResourceAccessAssignment>();
  for (const row of rows) {
    const key = `${row.resource_id}\u0000${row.username}`;
    const assignment = grouped.get(key) ?? {
      resource_id: row.resource_id,
      username: row.username,
      permission: [],
    };
    assignment.permission.push(row.permission);
    grouped.set(key, assignment);
  }
  return [...grouped.values()];
}

export function deleteResource(dbPath: string, resourceId: string): boolean {
  return getDb(dbPath).run("DELETE FROM resources WHERE resource_id = ?", [resourceId])
    .changes > 0;
}

export function setUserResourcePermissions(
  dbPath: string,
  userId: number,
  resourceId: string,
  permissions: string[],
): void {
  const connection = getDb(dbPath);
  const normalized = [...new Set(permissions.map((item) => item.trim()).filter(Boolean))];
  const transaction = connection.transaction(() => {
    connection.run(
      "DELETE FROM user_resource_permissions WHERE user_id = ? AND resource_id = ?",
      [userId, resourceId],
    );
    for (const permission of normalized) {
      connection.run(
        `INSERT INTO user_resource_permissions (user_id, resource_id, permission)
         VALUES (?, ?, ?)`,
        [userId, resourceId, permission],
      );
    }
  });
  transaction();
}

export function getUserResourcePermissions(
  dbPath: string,
  user: User,
  resourceFilter = "",
): ResourcePermission[] {
  if (user.is_admin === 1) {
    return listResources(dbPath)
      .filter((resource) => resource.resource_id.startsWith(resourceFilter))
      .map((resource) => ({
        resource_id: resource.resource_id,
        permission: [...OWNER_PERMISSIONS],
      }));
  }

  const rows = getDb(dbPath)
    .query(
      `SELECT resource_id, permission
       FROM user_resource_permissions
       WHERE user_id = ? AND resource_id LIKE ?
       ORDER BY resource_id, permission`,
    )
    .all(user.id, `${resourceFilter}%`) as Array<{
    resource_id: string;
    permission: string;
  }>;

  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const permissions = grouped.get(row.resource_id) ?? [];
    permissions.push(row.permission);
    grouped.set(row.resource_id, permissions);
  }
  return [...grouped].map(([resource_id, permission]) => ({
    resource_id,
    permission,
  }));
}

export function hasResourcePermission(
  dbPath: string,
  user: User,
  resourceId: string,
  requiredPermission?: string,
): boolean {
  if (user.is_admin === 1) return true;
  const permissions = getUserResourcePermissions(dbPath, user).find(
    (entry) => entry.resource_id === resourceId,
  )?.permission;
  if (!permissions) return false;
  return requiredPermission ? permissions.includes(requiredPermission) : permissions.length > 0;
}
