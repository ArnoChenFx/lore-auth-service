#!/usr/bin/env bun

/**
 * 将 Lore 或 URC 仓库中的 16 字节二进制 ID 转换为认证服务使用的资源 ID。
 *
 * 默认接收仓库根目录，并自动检查 `.lore/id` 与 `.urc/id`。调用方也可以通过
 * `--id-file` 直接指定 ID 文件，以便适配非标准目录结构。
 */

import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const HELP_TEXT = `Usage:
  bun run repository:id [repository-directory]
  bun run repository:id --id-file <path>

Options:
  --id-file <path>  Read the repository ID from an explicit file.
  -h, --help        Show this help message.

If no repository directory is provided, the current working directory is used.`;

export interface CliOptions {
  /** 要检查的仓库根目录；未提供时使用当前工作目录。 */
  repositoryDirectory?: string;
  /** 用户显式指定的 ID 文件，优先于仓库目录自动检测。 */
  idFile?: string;
  /** 是否只显示帮助信息。 */
  help: boolean;
}

/**
 * 解析命令行参数，并拒绝未知选项和多个位置参数，避免错误输入被静默忽略。
 */
export function parseArguments(arguments_: string[]): CliOptions {
  const options: CliOptions = { help: false };

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;

    if (argument === "-h" || argument === "--help") {
      options.help = true;
      continue;
    }

    if (argument === "--id-file") {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("Option --id-file requires a path.");
      }
      options.idFile = value;
      index += 1;
      continue;
    }

    if (argument.startsWith("--id-file=")) {
      const value = argument.slice("--id-file=".length);
      if (!value) {
        throw new Error("Option --id-file requires a path.");
      }
      options.idFile = value;
      continue;
    }

    if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    }

    if (options.repositoryDirectory) {
      throw new Error("Only one repository directory can be provided.");
    }
    options.repositoryDirectory = argument;
  }

  if (options.idFile && options.repositoryDirectory) {
    throw new Error(
      "Use either a repository directory or --id-file, but not both.",
    );
  }

  return options;
}

/**
 * 判断候选 ID 文件是否存在。这里只把文件不存在视为正常探测结果，
 * 权限错误等异常会继续抛出，确保调用方能够看到真实原因。
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * 根据显式文件路径或仓库根目录，解析最终需要读取的 ID 文件。
 *
 * 同时发现 `.lore/id` 和 `.urc/id` 时不猜测优先级，而是要求调用方明确指定，
 * 防止为混合格式仓库生成错误的资源 ID。
 */
export async function resolveIdFile(
  options: CliOptions,
  currentWorkingDirectory = process.cwd(),
): Promise<string> {
  if (options.idFile) {
    return resolve(currentWorkingDirectory, options.idFile);
  }

  const repositoryDirectory = resolve(
    currentWorkingDirectory,
    options.repositoryDirectory ?? ".",
  );
  const loreIdFile = resolve(repositoryDirectory, ".lore", "id");
  const urcIdFile = resolve(repositoryDirectory, ".urc", "id");
  const [hasLoreId, hasUrcId] = await Promise.all([
    fileExists(loreIdFile),
    fileExists(urcIdFile),
  ]);

  if (hasLoreId && hasUrcId) {
    throw new Error(
      "Both .lore/id and .urc/id exist. Use --id-file to select one.",
    );
  }
  if (hasLoreId) return loreIdFile;
  if (hasUrcId) return urcIdFile;

  throw new Error(
    `No repository ID file found under: ${repositoryDirectory}`,
  );
}

/**
 * 读取二进制仓库 ID 并生成 `urc-` 前缀资源 ID。
 *
 * Buffer 的 `hex` 编码与原 Shell 命令中 `od -tx1 | tr -d` 的结果一致；
 * 在编码前直接校验字节数，可避免文本编码或换行符干扰判断。
 */
export async function readRepositoryId(idFile: string): Promise<string> {
  const repositoryId = await readFile(idFile);

  if (repositoryId.length !== 16) {
    throw new Error(
      `Invalid Lore Repository ID: expected 16 bytes, got ${repositoryId.length} bytes.`,
    );
  }

  return `urc-${repositoryId.toString("hex")}`;
}

/**
 * 执行命令行流程并返回进程退出码，便于测试时复用而不强制退出测试进程。
 */
export async function run(
  arguments_: string[],
  currentWorkingDirectory = process.cwd(),
): Promise<number> {
  try {
    const options = parseArguments(arguments_);
    if (options.help) {
      console.log(HELP_TEXT);
      return 0;
    }

    const idFile = await resolveIdFile(options, currentWorkingDirectory);
    console.log(await readRepositoryId(idFile));
    return 0;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "An unknown error occurred.";
    console.error(`Error: ${message}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await run(Bun.argv.slice(2));
}
