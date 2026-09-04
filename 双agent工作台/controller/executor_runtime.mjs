import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT_DIR } from "./logger.mjs";

function fileExists(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function packageEntry(packageDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.dsh;
    const file = path.resolve(packageDir, bin || "lib/bin.js");
    if (fileExists(file)) return file;
  } catch { /* 兼容直接提供 lib/bin.js 的安装布局 */ }
  const fallback = path.join(packageDir, "lib", "bin.js");
  return fileExists(fallback) ? fallback : null;
}

/** 从当前安装位置发现 Harness；显式覆盖无效时不静默使用另一套安装。 */
export function findDshBin(hint = "", options = {}) {
  const env = options.env || process.env;
  const rootDir = options.rootDir || ROOT_DIR;
  const nodePath = options.nodePath || process.execPath;
  const explicit = String(env.DSH_BIN || hint || "").trim();
  if (explicit) {
    const file = path.resolve(rootDir, explicit);
    return fileExists(file) ? file : null;
  }

  // 项目安装可位于工作台自身或仓库根目录。
  for (let dir = rootDir; ; dir = path.dirname(dir)) {
    const found = packageEntry(path.join(dir, "node_modules", "@deepseek-ai", "dsh"));
    if (found) return found;
    if (path.dirname(dir) === dir) break;
  }
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] || "";
  const prefixes = [
    env.npm_config_prefix, env.NPM_CONFIG_PREFIX,
    env.APPDATA && path.join(env.APPDATA, "npm"),
    path.dirname(nodePath),
    ...pathValue.split(path.delimiter).map((value) => value.trim().replace(/^"|"$/g, "")),
  ].filter(Boolean);
  for (const prefix of new Set(prefixes)) {
    const found = packageEntry(path.join(prefix, "node_modules", "@deepseek-ai", "dsh"));
    if (found) return found;
    // npm 的本地 .bin shim 对应相邻的包目录。
    if (path.basename(prefix) === ".bin") {
      const local = packageEntry(path.join(path.dirname(prefix), "@deepseek-ai", "dsh"));
      if (local) return local;
    }
  }

  // 自定义 .npmrc prefix：通过 npm 自己获取全局目录，不执行拼接的 shell 命令。
  if (options.npmRoot !== false) {
    const npmCli = [env.npm_execpath, ...prefixes.map((dir) => path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"))]
      .find((file) => file && fileExists(file) && /npm-cli\.js$/i.test(file));
    if (npmCli) {
      try {
        const globalRoot = execFileSync(nodePath, [npmCli, "root", "--global"], {
          env, cwd: rootDir, encoding: "utf8", timeout: 10000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return packageEntry(path.join(globalRoot, "@deepseek-ai", "dsh"));
      } catch { /* doctor 和启动错误提供安装指引 */ }
    }
  }
  return null;
}

export function requireDshBin(config = {}) {
  const entry = findDshBin(config.dshBin);
  if (entry) return entry;
  const explicit = process.env.DSH_BIN || config.dshBin;
  const detail = explicit ? `指定的 Harness 入口不存在：${explicit}。请修正 DSH_BIN 或 config/config.local.json 的 deepseek.dshBin。` :
    "未找到 DeepSeek Harness。请先运行 npm install -g @deepseek-ai/dsh@0.1.1-rc.2；自定义安装可用 DSH_BIN 指向 lib/bin.js。";
  throw Object.assign(new Error(detail), { code: "RUNNER_NOT_INSTALLED" });
}
