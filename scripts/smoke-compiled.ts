/**
 * smoke-compiled.ts — 独立可执行程序冒烟测试
 *
 * 测试会从不包含源码和 Proto 的临时目录运行产物，并要求
 * `@grpc/proto-loader` 真实解析两个 `$bunfs` 内嵌文件。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

import packageJson from "../package.json";

interface HealthResponse {
  status?: string;
  grpc_port?: number;
}

/** 临时占用并释放一个回环端口，供独立程序启动测试使用。 */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListening);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("无法分配本地测试端口");
  }
  await new Promise<void>((resolveClosed, reject) => {
    server.close((error) => (error ? reject(error) : resolveClosed()));
  });
  return address.port;
}

const requestedPath = Bun.argv[2];
if (!requestedPath) {
  throw new Error("请提供待验证的可执行程序路径");
}

const executable = isAbsolute(requestedPath) ? requestedPath : resolve(requestedPath);
const versionProcess = Bun.spawn([executable, "--version"], {
  stdout: "pipe",
  stderr: "pipe",
});
const versionOutput = await new Response(versionProcess.stdout).text();
const versionError = await new Response(versionProcess.stderr).text();
if ((await versionProcess.exited) !== 0) {
  throw new Error(`可执行程序版本查询失败：${versionError.trim()}`);
}
if (versionOutput.trim() !== packageJson.version) {
  throw new Error(
    `可执行程序版本输出不正确：期望 ${packageJson.version}，实际为 ${JSON.stringify(versionOutput.trim())}`,
  );
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "lore-auth-compiled-"));
let serviceProcess: ReturnType<typeof Bun.spawn> | null = null;

try {
  const protoProcess = Bun.spawn([executable, "--check-embedded-protos"], {
    cwd: temporaryDirectory,
    stdout: "pipe",
    stderr: "pipe",
  });
  const protoOutput = await new Response(protoProcess.stdout).text();
  const protoError = await new Response(protoProcess.stderr).text();
  if ((await protoProcess.exited) !== 0) {
    throw new Error(`嵌入 Proto 验证失败：${protoError.trim()}`);
  }

  const protoStatus = JSON.parse(protoOutput) as {
    status?: string;
    auth_service?: boolean;
    rebac_service?: boolean;
  };
  if (
    protoStatus.status !== "ok" ||
    protoStatus.auth_service !== true ||
    protoStatus.rebac_service !== true
  ) {
    throw new Error(`嵌入 Proto 返回了无效状态：${protoOutput.trim()}`);
  }

  const httpPort = await freePort();
  let grpcPort = await freePort();
  while (grpcPort === httpPort) grpcPort = await freePort();

  serviceProcess = Bun.spawn([executable], {
    cwd: temporaryDirectory,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(httpPort),
      GRPC_HOST: "127.0.0.1",
      GRPC_PORT: String(grpcPort),
      PUBLIC_BASE_URL: `http://127.0.0.1:${httpPort}`,
      JWT_ISSUER: `http://127.0.0.1:${httpPort}`,
      DB_PATH: join(temporaryDirectory, "lore-auth.db"),
      KEY_DIR: join(temporaryDirectory, "keys"),
    },
    stdout: "inherit",
    stderr: "inherit",
  });

  let health: HealthResponse | null = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${httpPort}/health_check`);
      if (response.ok) {
        health = (await response.json()) as HealthResponse;
        break;
      }
    } catch {
      // RSA 密钥生成和服务监听需要短暂启动时间。
    }
    await Bun.sleep(100);
  }
  if (!health || health.status !== "ok" || health.grpc_port !== grpcPort) {
    throw new Error("编译产物未在超时时间内通过健康检查");
  }

  console.log(
    JSON.stringify({
      version: versionOutput.trim(),
      proto_status: protoStatus.status,
      auth_service: protoStatus.auth_service,
      rebac_service: protoStatus.rebac_service,
      health_status: health.status,
      grpc_port: health.grpc_port,
      proto_source_directory_required: false,
    }),
  );
} finally {
  if (serviceProcess) {
    serviceProcess.kill();
    await serviceProcess.exited;
  }
  // 路径由 mkdtemp 创建在系统临时目录中，清理范围严格限定为本次测试目录。
  await rm(temporaryDirectory, { recursive: true, force: true });
}
