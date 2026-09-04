import { findBrowser, BROWSER_HELP } from "../controller/browser_runtime.mjs";

// 集成测试允许无浏览器环境跳过；直接运行 UI 脚本必须安装浏览器。
export function testBrowserPath(context) {
  const executable = findBrowser();
  if (executable) return executable;
  if (context) { context.skip(BROWSER_HELP); return null; }
  throw new Error(BROWSER_HELP);
}
