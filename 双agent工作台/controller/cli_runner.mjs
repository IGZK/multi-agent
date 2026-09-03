import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";

export class CliRunner {
  constructor(config = {}, logger) {
    this.cfg = config;
    this.logger = logger;
    this.running = new Map();
  }

  capabilities() {
    return { modelSelection: false, sessionResume: false, usage: false, visibleWindow: false };
  }

  health() {
    return { ok: !!String(this.cfg.command || "").trim(), configured: !!String(this.cfg.command || "").trim() };
  }

  async run(projectId, dirs, envelope) {
    const command = String(this.cfg.command || "").trim();
    if (!command) throw Object.assign(new Error("通用命令行执行器尚未配置 command"), { code: "CLI_NOT_CONFIGURED" });
    const inbox = path.join(dirs.workspaceDir, "inbox", "task.json");
    const tmp = inbox + `.tmp-${process.pid}-${Date.now()}`;
    envelope.source_dir = dirs.sourceDir;
    envelope.workspace_dir = dirs.workspaceDir;
    fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2), "utf8");
    fs.renameSync(tmp, inbox);
    const startedAt = Date.now();
    const logFile = path.join(dirs.workspaceDir, "logs", `executor-cli-${Date.now()}.log`);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const fd = fs.openSync(logFile, "a");
    const child = spawn(command, {
      cwd: dirs.sourceDir,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, WORKBENCH_TASK_FILE: inbox, WORKBENCH_DISPATCH_ID: envelope.dispatch_id },
    });
    this.running.set(projectId, { child, startedAt });
    const timeoutMs = envelope.timeoutMs || this.cfg.timeoutMs || 2700000;
    const result = await new Promise((resolve) => {
      let settled = false;
      let timer;
      const finish = (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      };
      child.once("error", (error) => finish({ exitCode: -1, error: error.message }));
      child.once("exit", (code) => finish({ exitCode: code }));
      timer = setTimeout(() => {
        execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
        finish({ exitCode: null, timedOut: true });
      }, timeoutMs);
    });
    this.running.delete(projectId);
    try { fs.closeSync(fd); } catch { /* ignore */ }
    return { ...result, timedOut: !!result.timedOut, ms: Date.now() - startedAt, logFile, cli: true };
  }

  resume() { return null; }
  isRunning(projectId) { return this.running.has(projectId); }
  kill(projectId) {
    const item = this.running.get(projectId);
    if (!item?.child?.pid) return false;
    execFile("taskkill", ["/PID", String(item.child.pid), "/T", "/F"], { windowsHide: true }, () => {});
    this.running.delete(projectId);
    return true;
  }
  status() { return { mode: "cli", active: [...this.running.entries()].map(([projectId, item]) => ({ projectId, pid: item.child?.pid || null, runningMs: Date.now() - item.startedAt, executor: "cli" })), health: this.health() }; }
  detachAll() { this.shutdownAll(); }
  shutdownAll() { for (const id of [...this.running.keys()]) this.kill(id); }
}
