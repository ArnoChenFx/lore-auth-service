/**
 * Bun 使用 `type: "file"` 导入 Proto 时返回资源路径。
 * 开发环境中路径指向源文件，编译后路径指向可执行程序内的 `$bunfs` 资源。
 */
declare module "*.proto" {
  const embeddedPath: string;
  export default embeddedPath;
}

/** Bun Compile 通过 `define` 注入该常量；普通 Bun 环境中不会实际定义它。 */
declare const __LORE_AUTH_STANDALONE__: boolean;
