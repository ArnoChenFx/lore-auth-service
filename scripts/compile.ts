/**
 * compile.ts - Lore Auth Service cross-platform standalone executable compiler
 *
 * This script is the single source of truth for local builds and GitHub Actions.
 * By default it compiles for the current platform. Use `--all` for every target
 * or `--target=<name>` for one explicit target.
 */

import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

interface CompileTarget {
  /** Stable target name used by developers and CI. */
  name: string;
  /** Runtime target accepted by Bun Compile. */
  bunTarget: Bun.Build.CompileTarget;
  /** Executable name inside the target directory and release archive. */
  executable: string;
}

const targets = {
  "linux-x64": {
    name: "linux-x64",
    bunTarget: "bun-linux-x64",
    executable: "lore-auth",
  },
  "linux-arm64": {
    name: "linux-arm64",
    bunTarget: "bun-linux-arm64",
    executable: "lore-auth",
  },
  "linux-x64-musl": {
    name: "linux-x64-musl",
    bunTarget: "bun-linux-x64-musl",
    executable: "lore-auth",
  },
  "linux-arm64-musl": {
    name: "linux-arm64-musl",
    bunTarget: "bun-linux-arm64-musl",
    executable: "lore-auth",
  },
  "windows-x64": {
    name: "windows-x64",
    bunTarget: "bun-windows-x64",
    executable: "lore-auth.exe",
  },
  "macos-x64": {
    name: "macos-x64",
    bunTarget: "bun-darwin-x64",
    executable: "lore-auth",
  },
  "macos-arm64": {
    name: "macos-arm64",
    bunTarget: "bun-darwin-arm64",
    executable: "lore-auth",
  },
} as const satisfies Record<string, CompileTarget>;

type TargetName = keyof typeof targets;

function isTargetName(value: string): value is TargetName {
  return Object.hasOwn(targets, value);
}

/**
 * Convert Bun's platform and architecture names to the stable project target.
 * Unsupported combinations fail immediately to prevent mislabeled artifacts.
 */
function currentTarget(): TargetName {
  const architecture = process.arch === "arm64" ? "arm64" : process.arch;
  const value =
    process.platform === "win32"
      ? `windows-${architecture}`
      : process.platform === "darwin"
        ? `macos-${architecture}`
        : process.platform === "linux"
          ? `linux-${architecture}`
          : "";

  if (!isTargetName(value)) {
    throw new Error(
      `The current platform is not supported: ${process.platform}/${process.arch}`,
    );
  }
  return value;
}

function argumentValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = Bun.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}

interface SelectedTarget {
  target: CompileTarget;
  /** Native builds reuse the installed runtime; explicit targets may download one. */
  native: boolean;
}

function selectedTargets(): SelectedTarget[] {
  if (Bun.argv.includes("--all")) {
    return Object.values(targets).map((target) => ({ target, native: false }));
  }

  const requested = argumentValue("--target");
  if (!requested) return [{ target: targets[currentTarget()], native: true }];
  if (!isTargetName(requested)) {
    throw new Error(
      `Unknown compile target "${requested}". Available targets: ${Object.keys(targets).join(", ")}`,
    );
  }
  return [{ target: targets[requested], native: false }];
}

async function compile(target: CompileTarget, native: boolean): Promise<void> {
  // Separate directories preserve every target during `--all` while keeping the
  // executable name identical inside each release archive.
  const outputPath = join("dist", target.name, target.executable);
  await mkdir(dirname(outputPath), { recursive: true });
  console.log(`[compile] ${target.name} -> ${outputPath}`);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await Bun.build({
      entrypoints: ["src/index.ts"],
      target: "bun",
      packages: "bundle",
      minify: true,
      sourcemap: "none",
      // This compile-time constant cannot be changed by deployment environment variables.
      define: { __LORE_AUTH_STANDALONE__: "true" },
      // Preserve Proto asset names for diagnostics without affecting single-file delivery.
      naming: { asset: "[name].[ext]" },
      compile: native
        ? {
            outfile: outputPath,
            // Omit the target for native builds so Bun can reuse the installed runtime.
            autoloadDotenv: true,
            autoloadBunfig: false,
            autoloadTsconfig: false,
            autoloadPackageJson: false,
          }
        : {
            target: target.bunTarget,
            outfile: outputPath,
            // Keep deployment .env loading, but ignore runtime bunfig and TypeScript metadata.
            autoloadDotenv: true,
            autoloadBunfig: false,
            autoloadTsconfig: false,
            autoloadPackageJson: false,
          },
      throw: false,
    });

    if (result.success) {
      try {
        const artifact = await stat(outputPath);
        if (artifact.isFile() && artifact.size > 0) return;
      } catch {
        // The diagnostic below reports Bun's actual output paths.
      }

      const actualOutputs = result.outputs.map((output) => output.path).join(", ");
      console.error(
        `[compile] Bun reported success but ${outputPath} is missing or empty. ` +
          `Reported outputs: ${actualOutputs || "(none)"}`,
      );
    }
    for (const log of result.logs) console.error(log);
    if (attempt < 2) {
      // Cross-compilation downloads a target runtime, so retry one transient failure.
      console.warn(`[compile] ${target.name} failed; retrying in 1 second.`);
      await Bun.sleep(1000);
    }
  }

  throw new Error(`Failed to compile ${target.name}`);
}

for (const selection of selectedTargets()) {
  await compile(selection.target, selection.native);
}

console.log("[compile] All selected targets completed.");
