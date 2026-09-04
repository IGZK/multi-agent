import { DeepseekRunner } from "./deepseek_runner.mjs";
import { CliRunner } from "./cli_runner.mjs";

export class ExecutorRouter {
  constructor(config, logger, store) {
    this.store = store;
    this.deepseek = new DeepseekRunner(config.deepseek, logger);
    this.cli = new CliRunner(config.executors?.cli || {}, logger);
  }

  type(projectId) { return this.store.readState(projectId)?.executor?.type || "deepseek"; }
  selected(projectId) { return this.type(projectId) === "cli" ? this.cli : this.deepseek; }
  capabilities(type) { return type === "cli" ? this.cli.capabilities() : { modelSelection: true, sessionResume: true, usage: true, visibleWindow: true }; }
  available() { return [{ type: "deepseek", label: "DeepSeek Harness", configured: true, capabilities: this.capabilities("deepseek") }, { type: "cli", label: "通用命令行", configured: this.cli.health().configured, capabilities: this.capabilities("cli") }]; }
  run(projectId, ...args) { return this.selected(projectId).run(projectId, ...args); }
  prewarm(projectId, ...args) { return this.type(projectId) === "deepseek" ? this.deepseek.prewarm(projectId, ...args) : null; }
  resume(projectId, ...args) { return this.selected(projectId).resume?.(projectId, ...args) || null; }
  isRunning(projectId) { return this.deepseek.isRunning(projectId) || this.cli.isRunning(projectId); }
  kill(projectId) {
    const deepseek = this.deepseek.kill(projectId);
    const cli = this.cli.kill(projectId);
    return Promise.all([deepseek, cli]).then((results) => results.some(Boolean));
  }
  status() {
    const deepseek = this.deepseek.status();
    return { active: [...deepseek.active, ...this.cli.status().active], mode: "routed", uis: deepseek.uis, executors: this.available() };
  }
  probeModels() { return this.deepseek.probeModels(); }
  uiInfo(projectId) { return this.type(projectId) === "deepseek" ? this.deepseek.uiInfo(projectId) : null; }
  openUiWindow(projectId) { return this.type(projectId) === "deepseek" ? this.deepseek.openUiWindow(projectId) : null; }
  compactSession(projectId, ...args) {
    if (this.type(projectId) !== "deepseek") throw new Error("当前执行器不支持会话压缩");
    return this.deepseek.compactSession(projectId, ...args);
  }
  scheduleUiCleanup(projectId, delayMs) { if (this.type(projectId) === "deepseek") this.deepseek.scheduleUiCleanup(projectId, delayMs); }
  detachAll() { return Promise.all([this.deepseek.detachAll(), this.cli.detachAll()]); }
  shutdownAll() { return Promise.all([this.deepseek.shutdownAll(), this.cli.shutdownAll()]); }
}
