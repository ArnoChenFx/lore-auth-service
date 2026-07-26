import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseArguments,
  readRepositoryId,
  resolveIdFile,
} from "../scripts/repository-id";

const temporaryDirectories: string[] = [];

/**
 * 为每个测试创建独立目录，避免测试数据与真实仓库目录相互影响。
 */
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lore-repository-id-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("repository ID CLI", () => {
  test("converts an exact 16-byte ID to lowercase hexadecimal", async () => {
    const directory = await temporaryDirectory();
    const idFile = join(directory, "id");
    await writeFile(
      idFile,
      Uint8Array.from([
        0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a,
        0x0b, 0x0c, 0x0d, 0x0e, 0xff,
      ]),
    );

    expect(await readRepositoryId(idFile)).toBe(
      "urc-000102030405060708090a0b0c0d0eff",
    );
  });

  test("automatically finds the ID file for both repository formats", async () => {
    const loreRepository = await temporaryDirectory();
    const urcRepository = await temporaryDirectory();
    await mkdir(join(loreRepository, ".lore"), { recursive: true });
    await mkdir(join(urcRepository, ".urc"), { recursive: true });
    await writeFile(join(loreRepository, ".lore", "id"), new Uint8Array(16));
    await writeFile(join(urcRepository, ".urc", "id"), new Uint8Array(16));

    expect(
      await resolveIdFile(
        { repositoryDirectory: loreRepository, help: false },
        process.cwd(),
      ),
    ).toBe(join(loreRepository, ".lore", "id"));
    expect(
      await resolveIdFile(
        { repositoryDirectory: urcRepository, help: false },
        process.cwd(),
      ),
    ).toBe(join(urcRepository, ".urc", "id"));
  });

  test("rejects invalid ID sizes and ambiguous argument combinations", async () => {
    const directory = await temporaryDirectory();
    const idFile = join(directory, "id");
    await writeFile(idFile, new Uint8Array(15));

    await expect(readRepositoryId(idFile)).rejects.toThrow(
      "expected 16 bytes, got 15 bytes",
    );
    expect(() =>
      parseArguments(["repository", "--id-file", "custom-id"]),
    ).toThrow("Use either a repository directory or --id-file");
  });
});
