import type { AppConfig } from "./config";
import type { KeyMaterial } from "./keys";

/** REST 与 gRPC 共用的只读运行上下文。 */
export interface AuthServiceContext {
  config: AppConfig;
  keys: KeyMaterial;
  jwks: { keys: unknown[] };
  /** 仅测试注入使用；登录节流的时间窗口据此推进，缺省为 Date.now。 */
  now?: () => number;
}
