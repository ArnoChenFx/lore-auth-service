/**
 * db.ts — User storage backed by bun:sqlite
 *
 * users table: users(id, username UNIQUE, password_hash, is_admin, created_at)
 * Passwords are hashed with scrypt + salt.
 */

import { Database } from "bun:sqlite";
import { scryptSync, randomBytes, timingSafeEqual } from "crypto";
import { existsSync } from "fs";

export interface User {
  id: number;
  username: string;
  password_hash: string;
  is_admin: number;
  created_at: string;
}

let db: Database | null = null;

function getDb(dbPath: string): Database {
  if (db) return db;

  const dir = dbPath.includes("/") || dbPath.includes("\\")
    ? dbPath.replace(/[/\\][^/\\]*$/, "")
    : ".";
  if (dir && !existsSync(dir)) {
    import("fs").then(({ mkdirSync }) => mkdirSync(dir, { recursive: true }));
  }

  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_admin      INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);");
  return db;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const hashBuf = Buffer.from(hash, "hex");
  const testBuf = scryptSync(password, salt, 64);
  if (hashBuf.length !== testBuf.length) return false;
  return timingSafeEqual(hashBuf, testBuf);
}

export function initDb(dbPath: string): void {
  getDb(dbPath);
}

export function createUser(
  dbPath: string,
  username: string,
  password: string,
  isAdmin = false,
): User {
  const conn = getDb(dbPath);
  const hash = hashPassword(password);
  try {
    conn.run(
      "INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)",
      [username, hash, isAdmin ? 1 : 0],
    );
  } catch (_e: any) {
    throw new Error(`User '${username}' already exists`);
  }
  return getUserByUsername(dbPath, username)!;
}

export function getUserByUsername(dbPath: string, username: string): User | null {
  const conn = getDb(dbPath);
  return conn.query("SELECT * FROM users WHERE username = ?").get(username) as User | null;
}

export function authenticate(dbPath: string, username: string, password: string): User | null {
  const user = getUserByUsername(dbPath, username);
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  return user;
}

export function listUsers(dbPath: string): User[] {
  const conn = getDb(dbPath);
  return conn.query("SELECT * FROM users ORDER BY id").all() as User[];
}

export function deleteUser(dbPath: string, username: string): boolean {
  const conn = getDb(dbPath);
  const result = conn.run("DELETE FROM users WHERE username = ?", [username]);
  return result.changes > 0;
}

export function userCount(dbPath: string): number {
  const conn = getDb(dbPath);
  const row = conn.query("SELECT COUNT(*) as count FROM users").get() as { count: number };
  return row.count;
}