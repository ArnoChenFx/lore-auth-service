import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  approveAuthSession,
  closeDb,
  createAuthSession,
  createResource,
  createUser,
  getApprovedSessionUser,
  getUserResourcePermissions,
} from "../src/db";

const temporaryDirectories: string[] = [];

function testDatabase(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "lore-auth-db-"));
  temporaryDirectories.push(directory);
  return { directory, path: join(directory, "auth.db") };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    closeDb(join(directory, "auth.db"));
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("browser authentication session", () => {
  test("approves a hashed session and exposes the user to Lore polling", () => {
    const database = testDatabase();
    const user = createUser(database.path, "alice", "alice-password", false);
    const session = createAuthSession(database.path, "client-state-123", 300);

    const rejected = approveAuthSession(
      database.path,
      "client-state-123",
      session.sessionCode,
      "alice",
      "wrong-password",
      5,
      60,
    );
    expect(rejected.ok).toBe(false);
    expect(
      getApprovedSessionUser(database.path, "client-state-123", session.sessionCode),
    ).toBeNull();

    const approved = approveAuthSession(
      database.path,
      "client-state-123",
      session.sessionCode,
      "alice",
      "alice-password",
      5,
      60,
    );
    expect(approved.ok).toBe(true);
    expect(
      getApprovedSessionUser(database.path, "client-state-123", session.sessionCode)?.id,
    ).toBe(user.id);
  });

  test("repository creator receives real resource permissions", () => {
    const database = testDatabase();
    const user = createUser(database.path, "alice", "alice-password", false);
    const resourceId = `urc-${"a".repeat(32)}`;

    expect(createResource(database.path, resourceId, "demo", user.id)).toBe(true);
    expect(getUserResourcePermissions(database.path, user)).toEqual([
      {
        resource_id: resourceId,
        permission: ["admin", "read", "write"],
      },
    ]);
  });
});
