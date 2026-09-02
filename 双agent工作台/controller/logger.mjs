// 统一日志：控制台 + 滚动文件 + 内存环形缓冲（供 Dashboard 拉取）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, "..");

export class Logger {
  constructor(dir = path.join(ROOT_DIR, "logs")) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `orchestrator-${new Date().toISOString().slice(0, 10)}.log`);
    this.tail = []; // 最近 N 行，Dashboard 用
    this.maxTail = 800;
    this.onLine = null; // 外部订阅（测试用）
  }

  log(level, scope, msg) {
    const line = `[${new Date().toISOString()}] [${level}] [${scope}] ${msg}`;
    console.log(line);
    try {
      fs.appendFileSync(this.file, line + "\n");
    } catch { /* 日志失败不影响主流程 */ }
    this.tail.push(line);
    if (this.tail.length > this.maxTail) this.tail.shift();
    if (this.onLine) this.onLine(line);
  }

  info(scope, msg) { this.log("INFO", scope, msg); }
  warn(scope, msg) { this.log("WARN", scope, msg); }
  error(scope, msg) { this.log("ERROR", scope, msg); }

  tailText(n = 300) {
    return this.tail.slice(-n).join("\n");
  }
}

export function projectLog(projectDir, msg) {
  const dir = path.join(projectDir, ".gpt_workspace", "logs");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `project-${new Date().toISOString().slice(0, 10)}.log`);
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* ignore */ }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowIso() {
  return new Date().toISOString();
}
