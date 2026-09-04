import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { terminateProcessTree } from "./process_runtime.mjs";

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
    if (this.running.has(projectId)) throw new Error("该项目已有命令行任务正在执行");
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
    const item = { child: null, startedAt, cancelled: false, timedOut: false, stopping: null };
    try {
    const child = spawn(command, {
      cwd: dirs.sourceDir,
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", fd, fd],
      env: { ...process.env, WORKBENCH_TASK_FILE: inbox, WORKBENCH_DISPATCH_ID: envelope.dispatch_id },
    });
    item.child = child;
    this.running.set(projectId, item);
    const timeoutMs = envelope.timeoutMs || this.cfg.timeoutMs || 2700000;
    const result = await new Promise((resolve, reject) => {
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
        item.timedOut = true;
        item.stopping ||= terminateProcessTree(child);
        item.stopping.then((stopped) => {
          if (!stopped) reject(Object.assign(new Error("无法确认命令行执行进程已停止，禁止回滚或删除工作区"), { code: "RUNNER_STOP_FAILED" }));
          else finish({ exitCode: null });
        });
      }, timeoutMs);
    });
    if (item.stopping && !(await item.stopping)) throw Object.assign(new Error("无法确认命令行执行进程已停止"), { code: "RUNNER_STOP_FAILED" });
    return { ...result, timedOut: item.timedOut, cancelled: item.cancelled, ms: Date.now() - startedAt, logFile, cli: true };
    } catch (error) {
      if (error.code === "RUNNER_STOP_FAILED") { item.stopFailed = true; item.stopping = null; }
      throw error;
    } finally {
      if (!item.stopFailed && this.running.get(projectId) === item) this.running.delete(projectId);
      fs.closeSync(fd);
    }
  }

  resume() { return null; }
  isRunning(projectId) { return this.running.has(projectId); }
  kill(projectId) {
    const item = this.running.get(projectId);
    if (!item) return false;
    item.cancelled = true;
    item.stopping ||= terminateProcessTree(item.child);
    return item.stopping.then((stopped) => {
      if (!stopped) {
        item.stopFailed = true;
        item.stopping = null;
        throw Object.assign(new Error("无法确认命令行执行进程已停止，禁止回滚或删除工作区"), { code: "RUNNER_STOP_FAILED" });
      }
      if (item.stopFailed && this.running.get(projectId) === item) this.running.delete(projectId);
      return true;
    });
  }
  status() { return { mode: "cli", active: [...this.running.entries()].map(([projectId, item]) => ({ projectId, pid: item.child?.pid || null, runningMs: Date.now() - item.startedAt, executor: "cli" })), health: this.health() }; }
  detachAll() { return this.shutdownAll(); }
  shutdownAll() { return Promise.all([...this.running.keys()].map((id) => this.kill(id))); }
}
