// 双 Agent 协作工作台 —— 主入口
// 用法：
//   node controller/index.mjs                          （真实模式）
//   node controller/index.mjs --gpt=mock --executor=mock --selftest
//   node controller/index.mjs --port=3700
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Logger, ROOT_DIR, sleep } from "./logger.mjs";
import { ProjectStore } from "./store.mjs";
import { GptBridge, MockGptBridge } from "./gpt_bridge.mjs";
import { DeepseekRunner } from "./deepseek_runner.mjs";
import { Orchestrator } from "./orchestrator.mjs";
import { DashboardServer } from "./server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { gpt: null, executor: null, port: null, selftest: false, projectsRoot: null };
  for (const a of argv) {
    if (a === "--selftest") out.selftest = true;
    else if (a.startsWith("--gpt=")) out.gpt = a.split("=")[1];
    else if (a.startsWith("--executor=")) out.executor = a.split("=")[1];
    else if (a.startsWith("--port=")) out.port = parseInt(a.split("=")[1], 10);
    else if (a.startsWith("--projects=")) out.projectsRoot = a.split("=")[1];
  }
  return out;
}

export function buildSystem(opts = {}) {
  const configPath = path.join(ROOT_DIR, "config", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (opts.gpt) config.gpt.mode = opts.gpt;
  if (opts.executor) config.deepseek.mode = opts.executor;
  if (opts.port) config.dashboard.port = opts.port;
  if (opts.projectsRoot) config.projectsRoot = path.resolve(ROOT_DIR, opts.projectsRoot);

  const logger = new Logger(path.join(ROOT_DIR, "logs"));
  const store = new ProjectStore(config.projectsRoot || path.join(ROOT_DIR, "projects"), logger);
  const bridge = config.gpt.mode === "mock"
    ? new MockGptBridge(config.gpt, logger)
    : new GptBridge(config.gpt, logger, ROOT_DIR);
  const runner = new DeepseekRunner(config.deepseek, logger);
  const orchestrator = new Orchestrator(config, logger, bridge, runner, store);
  const server = new DashboardServer(config, logger, orchestrator, store, bridge, runner);
  return { config, logger, store, bridge, runner, orchestrator, server };
}

/**
 * 单实例锁：防止两个工作台进程同时操作同一 projects 目录（会相互恢复对方的项目）。
 * 锁按 projects 目录作用域区分：不同 projects 目录可并行运行（如隔离测试实例）。
 * @returns true 表示可以继续运行
 */
export async function acquireInstanceLock(logger, projectsRoot) {
  const crypto = await import("node:crypto").catch(() => null);
  const scope = projectsRoot ? (crypto ? crypto.createHash("md5").update(projectsRoot).digest("hex").slice(0, 8) : path.basename(projectsRoot)) : "default";
  const lockFile = path.join(ROOT_DIR, "logs", `workbench-${scope}.lock`);
  try {
    if (fs.existsSync(lockFile)) {
      const old = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      try {
        process.kill(old.pid, 0); // 进程存活则不抛
        logger?.error("main", `另一个工作台实例正在使用同一项目目录（PID ${old.pid}，启动于 ${old.ts || "?"}）。如需强制启动，先结束该进程或删除 ${lockFile}`);
        return false;
      } catch { /* 进程已死，锁过期 */ }
    }
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }), "utf8");
    const release = () => { try { fs.unlinkSync(lockFile); } catch { /* ignore */ } };
    process.on("exit", release);
    process.on("SIGINT", release);
    process.on("SIGTERM", release);
    return true;
  } catch (e) {
    logger?.warn("main", `实例锁处理失败（继续运行）: ${e.message}`);
    return true;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const selftestProjectsRoot = opts.selftest
    ? path.join(ROOT_DIR, ".selftest-projects")
    : null;
  if (selftestProjectsRoot) {
    // 自测使用独立目录，避免与正式项目冲突；先清理旧残留
    try { fs.rmSync(selftestProjectsRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    opts.projectsRoot = selftestProjectsRoot;
  }
  const { config, logger, bridge, runner, orchestrator, server, store } = buildSystem(opts);

  logger.info("main", `============================================`);
  logger.info("main", `双 Agent 协作工作台启动`);
  logger.info("main", `GPT Bridge 模式: ${config.gpt.mode}${config.gpt.mode === "real" ? `（模型目标: ${config.gpt.modelName}）` : ""}`);
  logger.info("main", `DeepSeek Runner 模式: ${config.deepseek.mode}（${config.deepseek.profile} profile${config.deepseek.mode === "real" && config.deepseek.visible !== false ? "，执行过程在可见窗口实时展示" : "，无可见窗口"}）`);
  logger.info("main", `项目目录: ${config.projectsRoot || path.join(ROOT_DIR, "projects")}`);

  if (opts.selftest) {
    // 自测中不弹可见执行窗口（保持 headless 微任务验证）
    if (config.deepseek.mode === "real") config.deepseek.visible = false;
    return runSelftest(orchestrator, store, logger, config, selftestProjectsRoot);
  }

  if (!(await acquireInstanceLock(logger, config.projectsRoot))) {
    process.exit(1);
  }

  await server.start();
  await orchestrator.boot();

  // 优雅退出
  const shutdown = async () => {
    logger.info("main", "收到退出信号，正在关闭…");
    try { runner.shutdownAll?.(); } catch (e) { logger.warn("main", `关闭执行窗口失败: ${e.message}`); }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // 兜底：进程退出时清理可见执行服务（防止孤儿 dsh web 进程占用端口）
  process.on("exit", () => { try { runner.shutdownAll?.(); } catch { /* ignore */ } });
  process.on("uncaughtException", (e) => logger.error("main", `uncaughtException: ${e.stack || e.message}`));
  process.on("unhandledRejection", (e) => logger.error("main", `unhandledRejection: ${e?.stack || e}`));
}

async function runSelftest(orchestrator, store, logger, config, selftestProjectsRoot) {
  logger.info("selftest", "======== 闭环自测（mock GPT + mock 执行者） ========");
  const id = await orchestrator.createProject("自测项目", "创建一个 Python Hello World 项目，并添加一个 README。");
  logger.info("selftest", `测试项目: ${id}`);
  const t0 = Date.now();
  let lastState = "";
  const windowMs = config.deepseek.mode === "mock" ? 180000 : 1500000;
  while (Date.now() - t0 < windowMs) {
    await sleep(1000);
    const st = store.readState(id);
    if (!st) break;
    if (st.state !== lastState) {
      logger.info("selftest", `状态 → ${st.state}${st.current_task ? `（${st.current_task.id}）` : ""}`);
      lastState = st.state;
    }
    if (["COMPLETED", "ERROR"].includes(st.state)) break;
  }
  const final = store.readState(id);
  logger.info("selftest", `最终状态: ${final?.state}（耗时 ${Math.round((Date.now() - t0) / 1000)}s）`);
  const ok = final?.state === "COMPLETED"
    && (final.completed_tasks || []).length >= 3
    && !!store.readFileSafe(id, "project_analysis.md")
    && !!store.readFileSafe(id, "FINAL_REPORT.md")
    && (final.gpt_messages || []).length >= 4;
  logger.info("selftest", `检查: completed=${(final?.completed_tasks || []).length} analysis=${!!store.readFileSafe(id, "project_analysis.md")} final=${!!store.readFileSafe(id, "FINAL_REPORT.md")} gptMsgs=${(final?.gpt_messages || []).length}`);
  logger.info("selftest", ok ? "闭环自测 PASS" : "闭环自测 FAIL");
  if (selftestProjectsRoot) {
    try { fs.rmSync(selftestProjectsRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  process.exit(ok ? 0 : 1);
}

// 直接运行时启动
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error("启动失败:", e);
    process.exit(1);
  });
}
