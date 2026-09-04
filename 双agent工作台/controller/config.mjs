import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "./logger.mjs";

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("必须是 JSON 对象");
    return value;
  } catch (error) { throw new Error(`无法读取配置 ${file}: ${error.message}`); }
}

function merge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) continue;
    result[key] = value && typeof value === "object" && !Array.isArray(value)
      ? merge(base?.[key] || {}, value) : value;
  }
  return result;
}

export function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (["--selftest", "--open", "--no-open"].includes(arg)) {
      out[arg === "--selftest" ? "selftest" : "open"] = arg !== "--no-open";
      continue;
    }
    const match = arg.match(/^--(gpt|executor|port|projects|config|data-dir)=(.*)$/);
    if (!match) throw new Error(`未知参数 ${arg}。支持 --port=3700、--gpt=mock、--executor=mock、--projects=目录、--config=文件、--data-dir=目录、--open。`);
    const keys = { projects: "projectsRoot", "data-dir": "dataDir" };
    out[keys[match[1]] || match[1]] = match[2];
  }
  return out;
}

/** All relative config paths are rooted at the application, never the launch directory. */
export function loadConfig(opts = {}, rootDir = ROOT_DIR, env = process.env) {
  let config = readJson(path.join(rootDir, "config", "config.json"));
  const localPath = path.join(rootDir, "config", "config.local.json");
  if (fs.existsSync(localPath)) config = merge(config, readJson(localPath));
  const extraPath = opts.config || env.WORKBENCH_CONFIG;
  if (extraPath) config = merge(config, readJson(path.resolve(rootDir, extraPath)));
  if (opts.gpt) config.gpt.mode = opts.gpt;
  if (opts.executor) config.deepseek.mode = opts.executor;
  config.dashboard.port = Number(opts.port ?? env.WORKBENCH_PORT ?? config.dashboard.port);
  if (!Number.isInteger(config.dashboard.port) || config.dashboard.port < 1 || config.dashboard.port > 65535) {
    throw new Error("dashboard.port 必须是 1–65535 的整数");
  }
  for (const [key, mode] of [["gpt", config.gpt.mode], ["deepseek", config.deepseek.mode]]) {
    if (!["real", "mock"].includes(mode)) throw new Error(`${key}.mode 必须是 real 或 mock`);
  }
  config.dataDir = path.resolve(rootDir, opts.dataDir || env.WORKBENCH_DATA_DIR || config.dataDir || ".");
  config.projectsRoot = opts.projectsRoot || config.projectsRoot
    ? path.resolve(rootDir, opts.projectsRoot || config.projectsRoot)
    : path.join(config.dataDir, "projects");
  config.logsDir = path.join(config.dataDir, "logs");
  config.gpt.profileDir = path.resolve(config.dataDir, config.gpt.profileDir || "browser-profile");
  config.deepseek.nodeBin = env.NODE_BIN || config.deepseek.nodeBin || process.execPath;
  for (const [section, key, envKey] of [["deepseek", "nodeBin", "NODE_BIN"], ["deepseek", "dshBin", "DSH_BIN"], ["gpt", "chromePath", "CHROME_PATH"], ["deepseek", "uiChromePath", "CHROME_PATH"]]) {
    const value = env[envKey] || config[section][key];
    if (value) config[section][key] = /[\\/]/.test(value) ? path.resolve(rootDir, value) : value;
  }
  return config;
}
