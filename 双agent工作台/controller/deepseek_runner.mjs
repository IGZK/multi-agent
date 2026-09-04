// DeepSeek Runner：把执行任务分派给 DeepSeek Harness
//
// 真实执行模式（统一走"项目级会话池"）：
//   每项目一个独立端口的 DeepSeek Harness Web 服务 + 一个持久会话，跨任务复用；
//   config.deepseek.visible 仅决定是否弹出浏览器窗口。首个 Task 启动服务+会话，
//   后续 Task 复用同一会话（不重建窗口、不重复注入完整提示）。headless 仅作会话池
//   无法启动时的兜底（每次任务 = 一个全新 dsh --profile headless 进程，独立上下文，无复用）。
//   服务崩溃交回编排器回滚后重试，并记录可供工作台重启接管的项目级会话状态。
//
// 两种模式共用文件信封协议：
//   编排器 → inbox/task.json + inbox/task_prompt.txt（完整提示词）
//   执行者 → outbox/message.json + executor_reports/*.md + project_analysis.md
// stdout/stderr 重定向到项目日志文件（避免管道，Windows 沙箱友好）。
import fs from "node:fs";
import { resolveDeepseekSelection, planningPolicy, validateTaskContract } from "./planning_policy.mjs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { sleep, projectLog, nowIso } from "./logger.mjs";
import { buildExecutorPrompt, buildExecutorTurnPrompt } from "./prompts.mjs";
import { UiExecutor } from "./dsh_ui.mjs";
import { requireDshBin } from "./executor_runtime.mjs";

/** 用目录事件即时唤醒，以短轮询作为 Windows/网络盘上的丢事件兜底。 */
export function createFileWake(directory, targetName) {
  let dirty = false;
  let waiter = null;
  let watcher = null;
  const signal = () => {
    dirty = true;
    if (waiter) { const resolve = waiter; waiter = null; resolve(); }
  };
  try {
    watcher = fs.watch(directory, (_event, name) => {
      if (!name || path.basename(String(name)) === targetName) signal();
    });
  } catch { /* 轮询兜底 */ }
  return {
    wait(ms = 150) {
      if (dirty) { dirty = false; return Promise.resolve(); }
      return new Promise((resolve) => {
        let timer;
        waiter = () => { clearTimeout(timer); dirty = false; resolve(); };
        timer = setTimeout(() => { if (waiter) waiter = null; resolve(); }, ms);
      });
    },
    close() { waiter = null; watcher?.close?.(); },
  };
}

export function currentOutbox(store, projectId, envelope) {
  const status = store.readOutboxStatus(projectId);
  const dispatchId = status.data?.dispatch_id;
  // 上轮已提交结果后，执行者可能又写了一次旧结果；不得据此回滚新任务。
  if (status.complete && dispatchId && dispatchId !== envelope.dispatch_id
    && store.readState?.(projectId)?.processed_dispatch_ids?.includes(dispatchId)) {
    return { ...status, complete: false, stale: true };
  }
  return status;
}

export class RunnerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // RUNNER_SPAWN | RUNNER_TIMEOUT | RUNNER_EXIT | RUNNER_UI_*
    this.name = "RunnerError";
  }
}

export class DeepseekRunner {
  constructor(config, logger) {
    this.cfg = config; // config.deepseek
    this.logger = logger;
    this.running = new Map(); // projectId -> {pid, startedAt, sessionId?, visible?}
    this.cancelled = new Set();
    this.ui = new UiExecutor(config, logger);
  }

  log(level, msg) { this.logger?.[level]?.("deepseek-runner", msg); }

  /** 组装完整提示词（DeepSeek 系统提示词 + 任务信封） */
  buildPrompt(envelope) {
    return buildExecutorPrompt(envelope);
  }

  get visibleEnabled() { return this.cfg.mode === "real" && this.cfg.visible !== false; }

  /**
   * 解析某项目的 DeepSeek 模型选择：项目级 deepseek_selection 优先，
   * 否则回退到 config.deepseek 的 model/modelProvider/reasoningEffort。
   * 返回 null 表示“跟随 DeepSeek 默认”。
   */
  resolveSelection(store, projectId) {
    const st = store?.readState?.(projectId) || {};
    const { provider, model, reasoningEffort: effort } = resolveDeepseekSelection(st.deepseek_selection, this.cfg);
    if (!model) return null;
    return { provider: provider || "deepseek-official", model, reasoningEffort: effort || undefined };
  }

  /** 探测可用 DeepSeek 模型目录（Dashboard 下拉框用）。 */
  probeModels() {
    return this.ui.probeModels();
  }

  /** 在 GPT 规划期间提前启动项目执行服务，不建会话、不弹窗。 */
  async prewarm(projectId, dirs) {
    if (this.cfg.mode !== "real" || this.cfg.useSessionPool === false) return null;
    const logDir = path.join(dirs.workspaceDir, "logs");
    const server = await this.ui.ensureServer(projectId, logDir);
    if (server) this.log("info", `执行服务预热完成: ${server.url}（project=${projectId}）`);
    return server;
  }

  /**
   * 运行一次执行任务。
   * @param projectId 项目 id
   * @param dirs {projectDir, workspaceDir, sourceDir} 绝对路径
   * @param envelope 任务信封（写入 inbox/task.json）
   * @returns {exitCode, timedOut, logFile, ms, visible?, sessionId?, uiUrl?}
   */
  async run(projectId, dirs, envelope, store) {
    this.cancelled.delete(projectId);
    const { workspaceDir, sourceDir } = dirs;
    fs.mkdirSync(sourceDir, { recursive: true });

    // 0. 专用 Skill 只供给到工作台 Harness Profile，不写入用户源码目录。
    // 1. 原子写入 v3 任务信封
    envelope.envelope_version = 3;
    envelope.schema_version = 3;
    envelope.dispatch_id ||= crypto.randomUUID();
    envelope.workbench_dispatch = true;
    envelope.project_id = projectId;
    envelope.source_dir = sourceDir;
    envelope.workspace_dir = workspaceDir;
    envelope.task_id ||= envelope.current_task?.id || envelope.type;
    envelope.created_at ||= new Date().toISOString();
    envelope.dispatched_at = envelope.created_at;
    const inboxFile = path.join(workspaceDir, "inbox", "task.json");
    const inboxTmp = inboxFile + `.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(inboxTmp, JSON.stringify(envelope, null, 2), "utf8");
    fs.renameSync(inboxTmp, inboxFile);
    const prompt = this.buildPrompt(envelope);
    fs.writeFileSync(path.join(workspaceDir, "inbox", "task_prompt.txt"), prompt, "utf8");

    // 2. mock 模式
    if (this.cfg.mode === "mock") {
      return this.mockRun(projectId, dirs, envelope, store);
    }

    // 3. 真实模式：统一走"项目级会话池"（每项目一个 dsh web 服务 + 一个持久会话，跨任务复用）。
    //    visible 仅决定是否弹窗；无论 visible 与否都复用同一会话。
    //    仅当会话池无法启动（服务/会话创建失败）时回退 headless（一次任务一个进程，无复用）。
    if (this.cfg.useSessionPool !== false) {
      try {
        return await this.runSessionPool(projectId, dirs, envelope, store, prompt);
      } catch (e) {
        if (["RUNNER_WORKSPACE", "MODEL_SELECTION", "PLAN_POLICY"].includes(e.code)) throw e;
        if (this.running.has(projectId) || this.cancelled.has(projectId)) {
          // 已提交或已取消的任务绝不能改走另一进程重复执行。
          this.running.delete(projectId);
          throw e;
        }
        if (e instanceof RunnerError) {
          this.log("warn", `执行会话池未能开始（${e.message}），回退 headless 模式`);
        } else {
          this.log("warn", `执行会话池异常（${e.message}），回退 headless 模式`);
        }
      }
    }

    // 4. headless 回退：spawn node <dshBin> --profile headless <prompt>（每任务一个进程）
    if (envelope.type === "EXECUTE_PLAN") {
      if (this.resolveSelection(store, projectId)) throw new RunnerError("MODEL_SELECTION", "headless 回退无法保证项目选择的模型与档位，已停止派发；请恢复 Harness 会话服务。");
      const errors = validateTaskContract(envelope.current_task, planningPolicy());
      if (errors.length) throw new RunnerError("PLAN_POLICY", `headless 默认档位需要完整执行指导: ${errors.join("；")}`);
    }
    return this.runHeadless(projectId, dirs, envelope, prompt);
  }

  // ---------- 真实模式会话池：每项目一个 dsh web 服务 + 一个持久会话 ----------

  /**
   * 运行一次执行任务（真实模式主路径）。
   * 步骤：确保项目 dsh web 服务 → 获取/复用项目会话 → 应用模型 → 按需弹窗 →
   *       提交任务（新会话=完整提示，复用=精简提示）→ 轮询 outbox/会话状态，
   *       含服务崩溃自动恢复与项目级会话状态记录。
   * 服务/会话无法启动时抛 RunnerError（调用方回退 headless）。
   */
  async runSessionPool(projectId, dirs, envelope, store, prompt) {
    const { projectDir, workspaceDir, sourceDir } = dirs;
    const startedAt = Date.now();
    const logDir = path.join(workspaceDir, "logs");
    const taskId = envelope.current_task?.id || envelope.type;
    const timeoutMs = envelope.timeoutMs || this.cfg.executorTimeoutMs || 2700000;
    const outboxFile = path.join(workspaceDir, "outbox", "message.json");
    fs.mkdirSync(logDir, { recursive: true });

    // a. 确保项目可见执行服务（失败→抛错回退 headless，任务尚未开始，安全）
    let server = await this.ui.ensureServer(projectId, logDir);
    if (!server) {
      throw new RunnerError("RUNNER_UI_BOOT", `执行服务启动失败（profile=${this.ui.profileName}）`);
    }

    // b. 获取（必要时创建）项目会话 —— 一个项目一个会话，跨任务复用；项目间按 projectId 隔离
    const got = await this.ui.getOrCreateSession(projectId, sourceDir);
    let sessionId = got.sessionId;
    let sessionReused = got.reused;
    // 会话是否为"新建立"：新会话→编排器重置上下文缓存，下个任务发全量；复用→下个任务发增量
    let freshSession = !sessionReused || !!got.bootstrap;

    // c. 应用用户选择的模型/推理等级（每次任务都同步，保证"保存模型"即时生效）
    const applyModel = async () => {
      const sel = this.resolveSelection(store, projectId);
      if (sel) {
        try {
          await this.ui.selectModel(projectId, sessionId, sel);
          this.log("info", `模型已应用: ${sel.provider}/${sel.model}${sel.reasoningEffort ? `（推理=${sel.reasoningEffort}）` : ""}`);
        } catch (e) {
          throw new RunnerError("MODEL_SELECTION", `模型选择失败，已停止派发以防使用错误档位: ${e.message}`);
        }
      }
    };
    await applyModel();
    const [reportedModel, usageBeforeValue] = await Promise.all([
      this.ui.currentModel?.(projectId, sessionId, 1000).catch(() => null),
      this.ui.sessionProjection?.(projectId, sessionId, 1000).catch(() => null),
    ]);
    let actualModel = reportedModel;
    if (envelope.type === "EXECUTE_PLAN") {
      const errors = validateTaskContract(envelope.current_task, planningPolicy(reportedModel || {}));
      if (errors.length) throw new RunnerError("PLAN_POLICY", `指令未达到实际执行档位需要的详细程度，停止派发: ${errors.join("；")}`);
    }
    let usageBefore = usageBeforeValue || null;

    this.running.set(projectId, { pid: server.child?.pid, startedAt, sessionId, visible: this.visibleEnabled, serviceUrl: server.url });
    this.log("info", `执行会话${sessionReused ? "已复用" : "已创建"}: ${sessionId}（type=${envelope.type} task=${taskId}）`);

    // d. 提交任务：新会话只加载一次 Skill；复用会话只通知信封已更新。
    const submit = async (promptText) => {
      await this.ui.submitPrompt(projectId, sessionId, promptText, taskId);
    };
    const bootstrapPrompt = got.bootstrap
      ? `${prompt}\n\n这是压缩后的新会话。请读取 ${envelope.executor_context_file || ".gpt_workspace/executor_context.md"} 恢复项目上下文；不要查找或要求旧会话历史。`
      : prompt;
    const turnPrompt = sessionReused && !got.bootstrap ? buildExecutorTurnPrompt(envelope) : bootstrapPrompt;
    fs.writeFileSync(path.join(workspaceDir, "inbox", "task_prompt.txt"), turnPrompt, "utf8");
    const submitTurn = () => submit(buildExecutorTurnPrompt(envelope));
    const submitFull = () => submit(bootstrapPrompt);
    try {
      if (sessionReused && !got.bootstrap) await submitTurn(); else await submitFull();
      this.ui.clearBootstrap?.(projectId, sessionId);
    } catch (e) {
      // ACK 超时不代表任务未入队；直接转 headless 会造成重复执行。
      this.log("warn", `提交 ACK 不确定，继续监听原会话结果: ${e.message}`);
    }
    this.log("info", `任务已提交: type=${envelope.type} task=${taskId}（${sessionReused && !got.bootstrap ? "复用会话，精简提示" : "新会话，摘要化提示"}）`);
    projectLog(projectDir, `[dispatch] pool type=${envelope.type} task=${taskId} attempt=${envelope.attempt || 1} session=${sessionId} ui=${server.url}`);

    // 记录项目级会话状态（Dashboard / 恢复用）
    this.recordProjectSession(store, projectId, {
      sessionId, servicePid: server.child?.pid, serviceUrl: server.url,
      taskId, type: envelope.type, reused: sessionReused, createdAt: nowIso(), cwd: sourceDir,
      dispatchId: envelope.dispatch_id, generation: store?.readState?.(projectId)?.session_generations?.at(-1)?.generation || 1,
      logFile: server.logFile,
    });

    // 只在项目会话首次建立时打开窗口；后续 Task 复用现有窗口。
    if (!sessionReused && this.visibleEnabled && this.cfg.uiOpenWindow !== false) {
      try {
        const opened = (await this.ui.openWindow(projectId))?.opened === true;
        this.log("info", `执行窗口${opened ? "已打开" : "打开失败"}: ${server.url}（任务 ${taskId}）`);
      } catch (error) {
        this.log("warn", `执行窗口未打开，可从 Dashboard 重试：${error.message}（${server.url}）`);
      }
    }

    // e. 轮询 outbox + 会话状态 + 崩溃检测。崩溃后由编排器先回滚检查点再重试。
    const t0 = Date.now();
    let lastSessionCheck = 0;
    let idleSince = 0;
    let consecutiveHealthFailures = 0;
    let lastHealthCheck = 0;
    let healthPending = false;
    let sessionPending = false;
    let monitoring = true;
    const wake = createFileWake(path.dirname(outboxFile), path.basename(outboxFile));

    const buildResult = async (extra = {}) => {
      const usageAfter = await this.ui.sessionProjection?.(projectId, sessionId, 1000).catch(() => null) || null;
      const result = { exitCode: 0, timedOut: false, visible: this.visibleEnabled, freshSession, sessionId, uiUrl: server.url, usageBefore, usageAfter, actualModel, ...extra };
      result.logFile = server.logFile;
      result.ms = Date.now() - startedAt;
      return result;
    };

    try {
      while (Date.now() - t0 < timeoutMs) {
      if (this.cancelled.has(projectId)) {
        this.running.delete(projectId);
        return await buildResult({ cancelled: true, exitCode: null });
      }
      const outboxReady = store?.readOutboxStatus ? currentOutbox(store, projectId, envelope).complete : fs.existsSync(outboxFile);
      if (outboxReady) {
        projectLog(projectDir, `[settle] outbox written task=${taskId} ms=${Date.now() - startedAt}`);
        this.running.delete(projectId);
        return await buildResult();
      }

      // 服务进程崩溃检测（两次确认，避免误判）
      if (!healthPending && Date.now() - lastHealthCheck >= 5000) {
        lastHealthCheck = Date.now();
        healthPending = true;
        // 诊断 RPC 不占用收包通道；即使服务探测卡住也能即时接收结果。
        Promise.resolve().then(() => this.ui.isAlive(server, 1000)).catch(() => false).then((alive) => {
          if (monitoring) consecutiveHealthFailures = alive ? 0 : consecutiveHealthFailures + 1;
        }).finally(() => { healthPending = false; });
      }
      if (consecutiveHealthFailures >= 2) {
          const result = await buildResult({ uiCrashed: true });
          projectLog(projectDir, `[settle] ui crashed; checkpoint rollback required task=${taskId} ms=${result.ms}`);
          this.running.delete(projectId);
          return result;
      }

      // 会话空闲检测：任务已结束但没写 outbox → 视为"执行完未写结果信封"
      if (!sessionPending && Date.now() - lastSessionCheck > 2000) {
        lastSessionCheck = Date.now();
        sessionPending = true;
        Promise.resolve().then(() => this.ui.sessionState(projectId, sessionId, 1000)).then((st) => {
          if (!monitoring || !st) return;
          if (st.running) idleSince = 0;
          else if (!idleSince) idleSince = Date.now();
        }).catch(() => {}).finally(() => { sessionPending = false; });
      }
      if (idleSince && Date.now() - idleSince > 5000) {
              const result = await buildResult({ idleNoOutbox: true });
              projectLog(projectDir, `[settle] idle without outbox task=${taskId} ms=${result.ms}`);
              this.running.delete(projectId);
              return result;
      }
        await wake.wait(this.cfg.outboxPollMs || 150);
      }
    } finally {
      monitoring = false;
      wake.close();
    }

    // f. 超时：取消会话并关闭服务
    this.log("warn", `执行超时（${Math.round(timeoutMs / 1000)}s），取消会话 ${sessionId}`);
    await this.ui.cancelSession(projectId, sessionId).catch(() => {});
    const result = await buildResult({ timedOut: true });
    this.ui.disposeServer(projectId);
    this.running.delete(projectId);
    result.exitCode = null;
    projectLog(projectDir, `[settle] timeout task=${taskId} ms=${result.ms}`);
    return result;
  }

  /** 记录项目级会话状态到 project_state.json（Dashboard / 断点恢复用）。 */
  recordProjectSession(store, projectId, data) {
    if (!store?.writeState) return;
    try {
      store.writeState(projectId, {
        session: {
          service_url: data.serviceUrl,
          service_pid: data.servicePid || null,
          session_id: data.sessionId,
          cwd: data.cwd || null,
          generation: data.generation || null,
          task_id: data.taskId || null,
          dispatch_id: data.dispatchId || null,
          type: data.type || "EXECUTE_PLAN",
          started_at: data.createdAt || nowIso(),
          log_file: data.logFile || null,
          ts: nowIso(),
        },
        pending: {
          text: `DeepSeek 执行中: ${data.taskId || "-"}${this.visibleEnabled ? "（执行窗口可实时查看）" : "（后台执行中）"}`,
          ts: nowIso(),
          type: data.type || "EXECUTE_PLAN",
          sessionId: data.sessionId,
          uiUrl: data.serviceUrl,
        },
      });
    } catch { /* ignore */ }
  }

  /** 重启恢复：接管已保存服务与会话，只等待原 dispatch 的结果。 */
  async resume(projectId, dirs, envelope, store) {
    if (this.cfg.mode !== "real" || this.cfg.useSessionPool === false) return null;
    const saved = store?.readState?.(projectId)?.session;
    const adopted = await this.ui.adoptSession(projectId, saved, dirs.sourceDir).catch(() => null);
    if (!adopted) return null;
    const startedAt = Date.now();
    const timeoutMs = envelope.timeoutMs || this.cfg.executorTimeoutMs || 2700000;
    this.running.set(projectId, { pid: saved.service_pid, startedAt, sessionId: adopted.sessionId, visible: this.visibleEnabled, serviceUrl: adopted.server.url, resumed: true });
    this.log("info", `已接管执行会话: ${adopted.sessionId}（dispatch=${envelope.dispatch_id}）`);
    let idleSince = adopted.running ? 0 : Date.now();
    let lastProbe = 0;
    let probePending = false;
    let healthFailures = 0;
    let monitoring = true;
    const wake = createFileWake(path.join(dirs.workspaceDir, "outbox"), "message.json");
    try {
    while (Date.now() - startedAt < timeoutMs) {
      if (this.cancelled.has(projectId)) {
        this.running.delete(projectId);
        return { cancelled: true, exitCode: null, timedOut: false, ms: Date.now() - startedAt, resumed: true };
      }
      const outbox = currentOutbox(store, projectId, envelope);
      if (outbox.complete) {
        this.running.delete(projectId);
        return { exitCode: 0, timedOut: false, ms: Date.now() - startedAt, visible: this.visibleEnabled, resumed: true, sessionId: adopted.sessionId, uiUrl: adopted.server.url };
      }
      if (healthFailures >= 2) {
        this.running.delete(projectId);
        return { exitCode: null, timedOut: false, ms: Date.now() - startedAt, resumed: true, resumeFailed: true, uiCrashed: true };
      }
      if (!probePending && Date.now() - lastProbe >= 2000) {
        probePending = true;
        lastProbe = Date.now();
        Promise.all([
          this.ui.isAlive(adopted.server, 1000).catch(() => false),
          this.ui.sessionState(projectId, adopted.sessionId, 1000).catch(() => null),
        ]).then(([alive, session]) => {
          if (!monitoring) return;
          healthFailures = alive ? 0 : healthFailures + 1;
          if (session?.running) idleSince = 0;
          else if (session && !idleSince) idleSince = Date.now();
        }).finally(() => { probePending = false; });
      }
      if (idleSince && Date.now() - idleSince > 5000) {
        this.running.delete(projectId);
        return { exitCode: 0, timedOut: false, ms: Date.now() - startedAt, visible: this.visibleEnabled, resumed: true, sessionId: adopted.sessionId, idleNoOutbox: true, invalidOutbox: outbox.exists };
      }
      await wake.wait(this.cfg.outboxPollMs || 150);
    }
    } finally { monitoring = false; wake.close(); }
    await this.ui.cancelSession(projectId, adopted.sessionId).catch(() => {});
    this.running.delete(projectId);
    return { exitCode: null, timedOut: true, ms: Date.now() - startedAt, visible: this.visibleEnabled, resumed: true, sessionId: adopted.sessionId };
  }

  /** 创建摘要化的新 Harness 会话；保留服务和窗口，只替换会话 ID。 */
  async compactSession(projectId, dirs, store) {
    if (this.cfg.mode === "mock") return { mock: true, sessionId: `mock-${Date.now()}`, previousSessionId: null };
    const logDir = path.join(dirs.workspaceDir, "logs");
    const server = await this.ui.ensureServer(projectId, logDir);
    if (!server) throw new RunnerError("RUNNER_UI_BOOT", "压缩时无法启动执行服务");
    const replaced = await this.ui.replaceSession(projectId, dirs.sourceDir);
    const selection = this.resolveSelection(store, projectId);
    if (selection) await this.ui.selectModel(projectId, replaced.sessionId, selection);
    const actualModel = await this.ui.currentModel?.(projectId, replaced.sessionId).catch(() => null) || selection;
    return { ...replaced, actualModel, serviceUrl: server.url };
  }

  isRunning(projectId) { return this.running.has(projectId); }

  // ---------- headless 模式（原有逻辑） ----------

  async runHeadless(projectId, dirs, envelope, prompt) {
    const dshBin = requireDshBin(this.cfg);
    const { projectDir, workspaceDir, sourceDir } = dirs;
    const logFile = path.join(workspaceDir, "logs", `executor-${Date.now()}.log`);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const fd = fs.openSync(logFile, "a");
    projectLog(projectDir, `[dispatch] headless type=${envelope.type} task=${envelope.current_task?.id || "-"} attempt=${envelope.attempt || 1}`);

    const args = [dshBin, "--profile", this.cfg.profile || "headless", prompt];
    this.log("info", `启动 headless 执行会话: type=${envelope.type} task=${envelope.current_task?.id || "-"}（cwd=${sourceDir}）`);
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(this.cfg.nodeBin || process.execPath, args, {
        cwd: sourceDir,
        stdio: ["ignore", fd, fd], // 输出直接进文件，避免管道
        env: { ...process.env, DSH_HOME: this.ui.dshHome(), DSH_BUNDLED_SKILL_DIR: path.join(this.ui.ensureProfile().dir, "skills") },
        windowsHide: true,
      });
    } catch (e) {
      fs.closeSync(fd);
      throw new RunnerError("RUNNER_SPAWN", `无法启动执行会话: ${e.message}`);
    }
    this.running.set(projectId, { pid: child.pid, startedAt });

    const timeoutMs = envelope.timeoutMs || this.cfg.executorTimeoutMs || 2700000;
    const result = await new Promise((resolve) => {
      let settled = false;
      let timer;
      const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
      child.on("error", (e) => finish({ exitCode: -1, timedOut: false, error: e.message }));
      child.on("exit", (code) => finish({ exitCode: code, timedOut: false }));
      timer = setTimeout(() => {
        if (settled) return;
        this.log("warn", `执行会话超时（${Math.round(timeoutMs / 1000)}s），强制终止 PID ${child.pid}`);
        execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }, () => {});
        finish({ exitCode: null, timedOut: true });
      }, timeoutMs);
      child.once("exit", () => clearTimeout(timer));
    });
    this.running.delete(projectId);
    try { fs.closeSync(fd); } catch { /* ignore */ }
    result.logFile = logFile;
    result.ms = Date.now() - startedAt;
    result.cancelled = this.cancelled.has(projectId);
    projectLog(projectDir, `[settle] headless exitCode=${result.exitCode} timedOut=${result.timedOut} ms=${result.ms}`);
    return result;
  }

  /** mock 执行者：直接落盘文件与 outbox（不调用 LLM），用于编排器闭环演练 */
  async mockRun(projectId, dirs, envelope, store) {
    const { workspaceDir, sourceDir } = dirs;
    await sleep(150);
    if (this.cancelled.has(projectId)) return { exitCode: null, timedOut: false, logFile: null, ms: 150, mock: true, cancelled: true };
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const taskId = envelope.task_id || envelope.current_task?.id || envelope.type;
    let outbox;
    if (envelope.type === "ANALYZE") {
      const analysis = `# 项目分析（mock 执行者）\n\n- 生成时间：${ts}\n- 项目目录：${sourceDir}\n- 说明：这是编排器闭环演练的模拟分析。\n`;
      fs.writeFileSync(path.join(workspaceDir, "project_analysis.md"), analysis, "utf8");
      fs.writeFileSync(path.join(workspaceDir, "analysis", `project_analysis-${ts}.md`), analysis, "utf8");
      outbox = { schema_version: 3, type: "TASK_DONE", project_id: projectId, dispatch_id: envelope.dispatch_id, task_id: "ANALYZE", created_at: nowIso(), report_file: ".gpt_workspace/project_analysis.md", summary: "模拟分析完成" };
    } else {
      const report = `# ${taskId} 执行报告（mock 执行者）\n\n- 时间：${ts}\n- 任务：${envelope.current_task?.description || ""}\n- 结果：模拟执行成功。\n`;
      fs.mkdirSync(path.join(workspaceDir, "executor_reports"), { recursive: true });
      fs.writeFileSync(path.join(workspaceDir, "executor_reports", `${taskId}.md`), report, "utf8");
      const artifact = path.join(sourceDir, `${taskId}.mock-artifact.txt`);
      fs.writeFileSync(artifact, `mock artifact for ${taskId} @ ${ts}\n`, "utf8");
      outbox = { schema_version: 3, type: "TASK_DONE", project_id: projectId, dispatch_id: envelope.dispatch_id, task_id: taskId, created_at: nowIso(), report_file: `.gpt_workspace/executor_reports/${taskId}.md`, summary: "模拟执行成功" };
    }
    if (store?.writeOutboxAtomic) store.writeOutboxAtomic(projectId, outbox);
    else {
      const file = path.join(workspaceDir, "outbox", "message.json");
      const tmp = file + `.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(outbox, null, 2), "utf8");
      fs.renameSync(tmp, file);
    }
    return { exitCode: 0, timedOut: false, logFile: null, ms: 150, mock: true };
  }

  status() {
    const active = [];
    for (const [projectId, info] of this.running) {
      active.push({ projectId, pid: info.pid, runningMs: Date.now() - info.startedAt, sessionId: info.sessionId || null, visible: !!info.visible });
    }
    return { active, mode: this.cfg.mode, uis: this.ui.list() };
  }

  /** 某项目执行窗口信息（Dashboard 用） */
  uiInfo(projectId) {
    return this.ui.info(projectId);
  }

  /** 重新打开某项目的执行窗口（用户手动点击用） */
  async openUiWindow(projectId) {
    const res = await this.ui.openWindow(projectId);
    return res ? { url: res.url, opened: res.opened } : null;
  }

  /** 终止某项目的执行会话（暂停用）：取消可见会话 + 关闭窗口服务 + 杀 headless 进程 */
  kill(projectId) {
    this.cancelled.add(projectId);
    const info = this.running.get(projectId);
    if (info?.sessionId && this.ui.info(projectId)) {
      this.ui.cancelSession(projectId, info.sessionId).catch(() => {});
      this.ui.disposeServer(projectId);
      this.running.delete(projectId);
      return true;
    }
    if (info?.pid) {
      this.log("warn", `强制终止执行会话 PID ${info.pid}（项目 ${projectId}）`);
      execFile("taskkill", ["/PID", String(info.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }, () => {});
      this.running.delete(projectId);
      return true;
    }
    // 无运行会话但服务仍在（例如项目刚完成）→ 也清理
    if (this.ui.info(projectId)) {
      this.ui.disposeServer(projectId);
      return true;
    }
    return false;
  }

  /** 项目完成后延时释放可见执行服务（给用户留出查看时间） */
  scheduleUiCleanup(projectId, delayMs) {
    this.ui.scheduleDispose(projectId, delayMs);
  }

  /** 进程退出前关闭全部可见执行服务 */
  shutdownAll() {
    this.ui.shutdownAll();
  }

  detachAll() {
    this.ui.detachAll();
  }
}

// ---------- 自测：真实 headless 微任务 ----------
export async function selftest() {
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-runner-test-"));
  const dirs = {
    projectDir: tmp,
    workspaceDir: path.join(tmp, ".gpt_workspace"),
    sourceDir: path.join(tmp, "source"),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(dirs.workspaceDir, "inbox"), { recursive: true });
  fs.mkdirSync(path.join(dirs.workspaceDir, "outbox"), { recursive: true });

  const cfg = {
    mode: "real",
    visible: false, // 自测保持 headless，避免弹窗
    useSessionPool: false, // 自测走纯 headless（每任务一个进程），不启动 web 服务
    nodeBin: process.execPath,
    dshBin: "",
    profile: "headless",
    executorTimeoutMs: 240000,
  };
  const runner = new DeepseekRunner(cfg, logger);
  const envelope = {
    type: "EXECUTE_PLAN",
    plan: { tasks: [] },
    current_task: { id: "TASK-TEST", description: "在 source 目录创建 runner-test.txt，内容 runner-ok" },
    completed_tasks: [],
    failed_tasks: [],
    gpt_message: null,
    attempt: 1,
  };
  const t0 = Date.now();
  const result = await runner.run("selftest", dirs, envelope, null);
  const artifact = path.join(dirs.sourceDir, "runner-test.txt");
  const fileOk = fs.existsSync(artifact) && fs.readFileSync(artifact, "utf8").includes("runner-ok");
  const outbox = (() => { try { return JSON.parse(fs.readFileSync(path.join(dirs.workspaceDir, "outbox", "message.json"), "utf8")); } catch { return null; } })();

  console.log(`真实 headless 执行: exitCode=${result.exitCode} 耗时=${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`文件产出: ${fileOk ? "PASS" : "FAIL"}（${artifact}）`);
  console.log(`outbox 信封: ${outbox ? `PASS（type=${outbox.type}）` : "FAIL（执行者未写 outbox）"}`);
  const ok = result.exitCode === 0 && fileOk && !!outbox;
  console.log(`\nDeepSeek Runner 自测: ${ok ? "ALL PASS" : "FAIL"}`);
  // 清理
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  return ok;
}

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ok = await selftest();
  process.exit(ok ? 0 : 1);
}
