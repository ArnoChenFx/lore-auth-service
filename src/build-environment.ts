/**
 * 判断当前代码是否运行在 Bun Compile 生成的独立可执行程序中。
 *
 * 编译脚本使用 `define` 把该标记替换为 `true`。普通 `bun run`、测试和库导入环境
 * 没有这个全局常量，`typeof` 检查可避免访问未定义变量。
 */
export const isStandaloneExecutable =
  typeof __LORE_AUTH_STANDALONE__ !== "undefined" &&
  __LORE_AUTH_STANDALONE__ === true;
