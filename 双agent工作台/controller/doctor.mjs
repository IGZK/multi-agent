import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createRequire } from "node:module";
import { loadConfig, parseArgs } from "./config.mjs";
import { findBrowser } from "./browser_runtime.mjs";
import { findDshBin } from "./executor_runtime.mjs";

let errors = 0;
function check(label, action) {
  try { console.log(`[OK] ${label}: ${action()}`); }
  catch (error) { errors++; console.log(`[缺少/错误] ${label}: ${error.message}`); }
}
check("Windows", () => {
  if (process.platform !== "win32") throw new Error("本项目仅支持 Windows 10/11 桌面环境");
  return `${process.platform} ${process.arch}`;
});
check("Node.js", () => {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("请安装 Node.js 22+ 并重新打开终端");
  return `${process.version} (${process.execPath})`;
});
check("工作台依赖", () => createRequire(import.meta.url).resolve("playwright-core"));
let config;
check("配置", () => { config = loadConfig(parseArgs(process.argv.slice(2))); return "默认配置 + 本机覆盖已加载"; });
if (config) {
  if (config.gpt.mode === "real") check("Chrome / Edge", () => {
    const browser = findBrowser(config.gpt.chromePath);
    if (!browser) throw new Error("请安装 Chrome/Edge，或设置 CHROME_PATH 为浏览器 exe 路径");
    return browser;
  });
  if (config.deepseek.mode === "real") check("DeepSeek Harness", () => {
    const bin = findDshBin(config.deepseek.dshBin);
    if (!bin) throw new Error("请安装 npm install -g @deepseek-ai/dsh@0.1.1-rc.2，或设置 DSH_BIN 指向 lib/bin.js");
    return bin;
  });
  check("数据目录", () => {
    let existing = config.dataDir;
    while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
    fs.accessSync(existing, fs.constants.W_OK);
    return config.dataDir;
  });
  for (const [label, host, port] of [["Dashboard", config.dashboard.host, config.dashboard.port], ...(config.gpt.mode === "real" ? [["GPT 调试", "127.0.0.1", config.gpt.debugPort]] : [])]) {
    await new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", (error) => {
        console.log(`[提示] ${label} 端口 ${port}: ${error.code}，若已有工作台运行属正常，否则请关闭占用程序或修改端口`);
        resolve();
      });
      server.listen(port, host, () => server.close(() => { console.log(`[OK] ${label} 端口 ${port} 可用`); resolve(); }));
    });
  }
}
console.log("\n此检查不登录 ChatGPT、不调用模型。真实执行前需在 Harness 配置自己的模型服务。无需账号体验界面：npm run demo。");
process.exitCode = errors ? 1 : 0;
