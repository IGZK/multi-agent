// Local Orchestrator：工作流控制中心
// 自动循环：用户任务 → GPT 规划(READY) → DeepSeek 执行 → 分析 → 反馈 GPT
//          → 继续/重规划 → 最终审查 → DONE。全部状态持久化，支持断点恢复。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { sleep, projectLog, nowIso } from "./logger.mjs";
import {
  parseGptResponse, parsePlan, mergePlan, fallbackParse, slimPlan,
  wrapOrchestratorMsg, wrapDeepseekQuery, validateExecutorOutbox,
} from "./protocol.mjs";
import { GPT_SYSTEM_PROMPT, buildDeepseekPlanningGuidance, buildPlanTemplateHint } from "./prompts.mjs";

const TOKEN_KEYS = ["uncachedInputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];

export function runValidationCommand(command, cwd, timeoutMs = 300000) {
  return new Promise((resolve) => {
    const started = Date.now();
    exec(String(command), { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        command: String(command),
        exit_code: Number.isInteger(error?.code) ? error.code : error ? -1 : 0,
        timed_out: !!error?.killed,
        duration_ms: Date.now() - started,
        output: `${stdout || ""}${stderr || ""}`.slice(-8000),
      });
    });
  });
}

export function tokenUsageDelta(before, after) {
  if (!after) return null;
  const out = {};
  for (const key of TOKEN_KEYS) out[key] = Math.max(0, Number(after[key] || 0) - Number(before?.[key] || 0));
  return out;
}

export function contextSnapshot(projection) {
  if (!projection) return null;
  const pressureTokens = Number(projection.projectedTokens ?? projection.pressureTokens);
  const contextWindow = Number(projection.contextWindow);
  const percentage = Number.isFinite(pressureTokens) && Number.isFinite(contextWindow) && contextWindow > 0
    ? Math.round((pressureTokens / contextWindow) * 1000) / 10
    : null;
  return {
    pressureTokens: Number.isFinite(pressureTokens) ? pressureTokens : null,
    contextWindow: Number.isFinite(contextWindow) ? contextWindow : null,
    percentage,
  };
}

export class Orchestrator {
  constructor(config, logger, bridge, runner, store) {
    this.cfg = config; // 全量 config
    this.logger = logger;
    this.bridge = bridge;
    this.runner = runner;
    this.store = store;
    this.loops = new Map(); // projectId -> Promise
    this.projectEpochs = new Map(); // 取消/删除时递增，阻止旧异步结果回写状态
    this.gptOwner = null; // 一个“发送 → 等回复”周期只能属于一个项目
    this.gptWaiters = [];
    this.gptWaitingProjects = new Set();
    this.gptActiveOps = new Map();
    this.maxConsecutiveErrors = config.orchestrator?.maxConsecutiveErrors ?? 3;
    this.protocolReprompts = config.orchestrator?.protocolReprompts ?? 2;
  }

  log(level, projectId, msg) { this.logger?.[level]?.(`orch:${projectId || "-"}`, msg); }

  projectEpoch(projectId) { return this.projectEpochs.get(projectId) || 0; }
  invalidateProject(projectId) {
    const next = this.projectEpoch(projectId) + 1;
    this.projectEpochs.set(projectId, next);
    return next;
  }

  async acquireGpt(projectId) {
    if (this.gptOwner === projectId) return;
    if (this.gptOwner) {
      await new Promise((resolve) => this.gptWaiters.push({ projectId, resolve }));
    } else {
      this.gptOwner = projectId;
    }
    const st = this.store.readState(projectId);
    if (!st || st.state === "PAUSED") {
      this.releaseGpt(projectId);
      const e = new Error("项目已暂停或删除");
      e.code = "PROJECT_CANCELLED";
      throw e;
    }
  }

  releaseGpt(projectId) {
    if (this.gptOwner !== projectId) return;
    const next = this.gptWaiters.shift();
    if (next) {
      this.gptOwner = next.projectId;
      next.resolve();
    } else {
      this.gptOwner = null;
    }
  }

  beginGptOp(projectId) {
    this.gptActiveOps.set(projectId, (this.gptActiveOps.get(projectId) || 0) + 1);
  }

  endGptOp(projectId) {
    const next = (this.gptActiveOps.get(projectId) || 1) - 1;
    if (next > 0) this.gptActiveOps.set(projectId, next);
    else this.gptActiveOps.delete(projectId);
  }

  gptIsActive(projectId) { return (this.gptActiveOps.get(projectId) || 0) > 0; }

  assertProjectActive(projectId, epoch) {
    const st = this.store.readState(projectId);
    if (!st || st.state === "PAUSED" || epoch !== this.projectEpoch(projectId)) {
      const e = new Error("项目已暂停或删除");
      e.code = "PROJECT_CANCELLED";
      throw e;
    }
    return st;
  }

  // ================= 启动 / 恢复 =================
  async boot() {
    const projects = this.store.listProjects();
    this.log("info", "-", `扫描到 ${projects.length} 个项目`);
    for (const p of projects) {
      if (["COMPLETED", "CANCELED"].includes(p.state)) continue;
      this.log("info", p.id, `恢复项目（状态: ${p.state}）`);
      this.startLoop(p.id);
    }
  }

  startLoop(projectId) {
    if (this.loops.has(projectId)) return;
    const p = this.runLoop(projectId).catch((e) => {
      this.log("error", projectId, `循环崩溃: ${e.stack || e.message}`);
    });
    this.loops.set(projectId, p);
    p.finally(() => this.loops.delete(projectId));
  }

  async runLoop(projectId) {
    const dir = this.store.projectDir(projectId);
    this.log("info", projectId, `循环启动（cwd: ${dir}）`);
    while (true) {
      let st = this.store.readState(projectId);
      if (!st) break; // 项目被删除
      if (st.state === "PAUSED") { await sleep(1000); continue; }
      if (["COMPLETED", "CANCELED"].includes(st.state)) break;
      try {
        await this.step(projectId, st);
        const after = this.store.readState(projectId);
        // “连续错误”只在连续抛错时累积；任一正常状态步骤都会清零。
        if (after && st.state !== "ERROR" && after.state !== "ERROR" && after.error_count) {
          this.store.writeState(projectId, { error_count: 0, error_asked_gpt: false });
        }
      } catch (e) {
        this.handleError(projectId, st, e);
      }
      await sleep(this.cfg.orchestrator?.stepIntervalMs ?? 1500);
    }
    this.log("info", projectId, "循环结束");
  }

  handleError(projectId, st, e) {
    const fresh = this.store.readState(projectId);
    if (!fresh || fresh.state === "PAUSED" || e.code === "PROJECT_CANCELLED") return;
    const code = e.code || "UNKNOWN";
    const msg = `${code}: ${e.message}`;
    this.log("error", projectId, `步骤 ${fresh.state || st.state} 出错 → ${msg}`);
    projectLog(this.store.projectDir(projectId), `[error] state=${fresh.state || st.state} ${msg}`);
    const errorCount = (fresh.error_count || 0) + 1;
    const retryState = fresh.pending?.retryState || fresh.previous_state || fresh.state || "INIT";
    this.store.writeState(projectId, {
      state: "ERROR",
      error_count: errorCount,
      last_error: msg,
      pending: {
        text: `步骤 ${st.state} 出错：${msg}`,
        ts: nowIso(),
        retryState,
        errorCode: code,
      },
    });
  }

  // ================= 主状态机 =================
  async step(projectId, st) {
    const S = st.state;
    switch (S) {
      case "INIT": return this.stepInit(projectId, st);
      case "WAITING_FOR_LOGIN": return this.stepWaitingLogin(projectId, st);
      case "GPT_PLANNING": return this.stepGptPlanning(projectId, st);
      case "PLAN_READY": return this.stepPlanReady(projectId, st);
      case "EXECUTING": return this.stepExecuting(projectId, st);
      case "WAITING_FOR_EXECUTOR": return this.stepWaitingExecutor(projectId, st);
      case "ANALYZING": return this.stepAnalyzing(projectId, st);
      case "DECISION_REQUIRED": return this.stepAnalyzing(projectId, st);
      case "WAITING_FOR_GPT": return this.stepWaitingGpt(projectId, st);
      case "REPLANNING": return sleep(500);
      case "ERROR": return this.stepError(projectId, st);
      default:
        this.log("warn", projectId, `未知状态 ${S}，回到 INIT`);
        return this.store.transition(projectId, "INIT");
    }
  }

  // ---------- INIT：准备 GPT 会话，发送系统提示词 + 任务 ----------
  async stepInit(projectId, st) {
    await this.acquireGpt(projectId);
    const epoch = this.projectEpoch(projectId);
    this.beginGptOp(projectId);
    let keepLease = false;
    try {
      const result = await this.stepInitLocked(projectId, this.store.readState(projectId) || st, epoch);
      keepLease = this.store.readState(projectId)?.state === "GPT_PLANNING";
      return result;
    } finally {
      this.endGptOp(projectId);
      if (!keepLease) this.releaseGpt(projectId);
    }
  }

  async stepInitLocked(projectId, st, epoch) {
    await this.bridge.ensureBrowser();
    if (st.gpt?.intro_sent && st.gpt?.conversation_url) {
      // 已发过简介（恢复场景）：先恢复到该项目会话，再进入等待规划。
      await this.openConversation(projectId, st.gpt.conversation_url);
      this.assertProjectActive(projectId, epoch);
      return this.store.transition(projectId, "GPT_PLANNING");
    }
    let pageState = await this.bridge.gotoChat().catch(async () => {
      await this.bridge.ensureBrowser();
      return this.bridge.gotoChat();
    });

    // 页面加载中（未渲染出关键元素，且无明确未登录信号）：静默等待，绝不误报"需要登录"
    const graceMs = this.cfg.gpt?.loginGraceMs ?? 45000;
    const t0 = Date.now();
    while (pageState.loading && !pageState.loggedIn && Date.now() - t0 < graceMs) {
      this.store.writeState(projectId, {
        pending: { text: "正在加载 ChatGPT 页面…", ts: nowIso() },
      });
      await sleep(5000);
      pageState = await this.bridge.detectState();
    }

    if (pageState.challenge) {
      await this.bridge.setWindowVisible(true);
      this.assertProjectActive(projectId, epoch);
      this.store.transition(projectId, "WAITING_FOR_LOGIN", {
        pending: { text: "ChatGPT 出现验证挑战（Cloudflare/CAPTCHA），已弹出浏览器窗口，请人工处理后系统自动继续。", ts: nowIso(), retryState: "INIT" },
      });
      this.log("warn", projectId, "检测到验证挑战，弹出窗口等待人工处理");
      return;
    }
    if (!pageState.loggedIn) {
      // 确实需要登录：弹出窗口 + 明确提示
      await this.bridge.setWindowVisible(true);
      this.assertProjectActive(projectId, epoch);
      this.store.transition(projectId, "WAITING_FOR_LOGIN", {
        pending: {
          text: "需要在 ChatGPT 登录（检测到登录页）。已自动弹出浏览器窗口，登录完成后系统自动继续并收起窗口。",
          ts: nowIso(), retryState: "INIT",
          detect: { hasComposer: pageState.hasComposer, loginButton: pageState.loginButton, url: pageState.url },
        },
      });
      this.log("info", projectId, "检测到未登录，弹出窗口等待登录");
      return;
    }
    // 已登录：静默运行（最小化窗口）
    await this.bridge.setWindowVisible(false);
    if (!st.gpt?.model_selected) {
      const gcfg = this.cfg.gpt || {};
      const sel = await this.bridge.selectModel(gcfg.modelName, gcfg.modelMatch);
      this.store.writeState(projectId, {
        gpt: {
          model_selected: sel.selected || null,
          models_available: sel.available || [],
        },
      });
      if (!sel.selected) this.log("warn", projectId, `未选到目标模型 "${gcfg.modelName}"（可用: ${(sel.available || []).join(", ") || "未枚举"}），使用页面默认模型`);
    }
    // 发送：系统提示词 + 用户任务
    const initialAttachments = this.store.getAttachments(projectId, st.initial_attachment_ids || []);
    const attachmentNote = initialAttachments.length
      ? `\n\n用户随项目附加了以下文件，请结合内容规划：\n${initialAttachments.map((item) => `- ${item.name}`).join("\n")}`
      : "";
    const content = `${GPT_SYSTEM_PROMPT}\n\n================\n用户任务：\n${st.user_task}${attachmentNote}\n\n【本次计划模板】${buildPlanTemplateHint(st.user_task)}\n\n请输出 <GPT_RESPONSE> 开始规划。`;
    await this.sendToGpt(projectId, "PLAN_REQUEST", content, { intro: true, attachments: initialAttachments });
    this.assertProjectActive(projectId, epoch);
    this.store.transition(projectId, "GPT_PLANNING", {
      pending: { text: "已向 GPT 发送任务，等待规划…", ts: nowIso() },
      initial_attachment_ids: [],
    });
  }

  async stepWaitingLogin(projectId, st) {
    await this.acquireGpt(projectId);
    const epoch = this.projectEpoch(projectId);
    this.beginGptOp(projectId);
    try {
      return await this.stepWaitingLoginLocked(projectId, this.store.readState(projectId) || st, epoch);
    } finally {
      this.endGptOp(projectId);
      this.releaseGpt(projectId);
    }
  }

  async stepWaitingLoginLocked(projectId, st, epoch) {
    // 页面丢了（浏览器崩溃等）→ 主动恢复页面并显示窗口
    if (!this.bridge.page || !(await this.bridge.isDebugPortUp().catch(() => false))) {
      this.log("info", projectId, "浏览器不在，重启并显示窗口等待登录");
      try {
        await this.bridge.ensureBrowser();
        await this.bridge.gotoChat();
        await this.bridge.setWindowVisible(true);
      } catch (e) {
        this.log("warn", projectId, `恢复浏览器失败: ${e.message}`);
      }
      await sleep(3000);
      return;
    }
    await this.bridge.setWindowVisible(true);
    try {
      const s = await this.bridge.detectState();
      if (s.loggedIn && !s.challenge) {
        this.log("info", projectId, "检测到已登录，收起窗口继续流程");
        await this.bridge.setWindowVisible(false);
        this.assertProjectActive(projectId, epoch);
        this.store.writeState(projectId, { error_count: 0, pending: { text: "已登录，继续。", ts: nowIso(), retryState: "INIT" } });
        return this.store.transition(projectId, "INIT");
      }
    } catch { /* 页面尚未就绪 */ }
    await sleep(this.cfg.gpt?.loginPollMs ?? 15000);
  }

  // ---------- GPT_PLANNING：等待并解析规划 ----------
  async stepGptPlanning(projectId, st) {
    const text = await this.waitForGpt(projectId);
    let parsed = parseGptResponse(text);
    if (!parsed.status) {
      const fb = fallbackParse(text);
      if (fb.status === "READY") {
        parsed = fb;
        this.log("info", projectId, "协议标签缺失，但全文可解析为计划（宽松回退）");
      } else {
        const used = (st.protocol_reprompts || 0) + 1;
        this.store.writeState(projectId, { protocol_reprompts: used });
        if (used <= this.protocolReprompts) {
          this.log("warn", projectId, `GPT 未按协议回复（第 ${used} 次），重新要求协议输出`);
          await this.sendToGpt(projectId, "REPROMPT", "上一条回复缺少协议块。请严格按协议回复：必须包含 <GPT_RESPONSE>...</GPT_RESPONSE> 和 <STATUS>READY</STATUS>（规划完成时），并附 <PLAN>。</GPT_RESPONSE> 之外不要有多余内容。");
          return this.store.transition(projectId, "GPT_PLANNING");
        }
        this.store.transition(projectId, "ERROR", {
          pending: { text: "GPT 多次未按协议回复，已暂停。请在 Dashboard 查看对话并点击“重试”。", ts: nowIso(), retryState: "GPT_PLANNING" },
        });
        return;
      }
    }
    if (st.protocol_reprompts) this.store.writeState(projectId, { protocol_reprompts: 0 });

    switch (parsed.status) {
      case "READY": {
        if (!parsed.plan) {
          this.log("warn", projectId, "READY 但缺少 PLAN，重新要求");
          await this.sendToGpt(projectId, "REPROMPT", "收到 READY 但缺少 <PLAN> 内容，请补充完整计划。");
          return this.store.transition(projectId, "GPT_PLANNING");
        }
        this.savePlan(projectId, parsed.plan);
        const fresh = this.store.readState(projectId);
        this.log("info", projectId, `规划完成（${fresh.plan?.parsed?.tasks?.length || 0} 项任务），开始执行`);
        return this.store.transition(projectId, "PLAN_READY", {
          pending: { text: "规划已就绪，准备执行。", ts: nowIso() },
        });
      }
      case "NEED_ANALYSIS":
        return this.dispatchExecutor(projectId, "ANALYZE", parsed.request || "分析当前项目并生成 project_analysis.md", null);
      case "DECISION_REQUIRED":
        return this.dispatchExecutor(projectId, "DECIDE", parsed.request || "请做出决定并继续执行", null);
      case "CONTINUE":
        if (st.plan?.parsed) return this.store.transition(projectId, "PLAN_READY");
        this.log("warn", projectId, "尚无计划却收到 CONTINUE，重新要求规划");
        await this.sendToGpt(projectId, "REPROMPT", "请先输出 READY + <PLAN> 完整计划。");
        return this.store.transition(projectId, "GPT_PLANNING");
      case "REPLAN":
        if (parsed.updatedPlan || parsed.plan) {
          this.savePlan(projectId, parsed.updatedPlan || parsed.plan, { replan: true, decision: parsed.decision });
          return this.store.transition(projectId, "PLAN_READY");
        }
        this.log("warn", projectId, "REPLAN 但缺少计划，重新要求");
        return this.store.transition(projectId, "GPT_PLANNING");
      case "DONE":
        return this.completeProject(projectId, "GPT 判定完成");
      default:
        return this.store.transition(projectId, "GPT_PLANNING");
    }
  }

  // ---------- PLAN_READY：挑选下一个任务 ----------
  async stepPlanReady(projectId, st) {
    const task = this.pickNextTask(st);
    if (!task) {
      const unfinished = this.pendingTasks(st);
      if (unfinished.length > 0) {
        const completed = new Set((st.completed_tasks || []).map((t) => String(t.id).toUpperCase()));
        const blocked = unfinished.map((t) => {
          const missing = (t.dependencies || []).filter((d) => !completed.has(String(d).toUpperCase()));
          return `${t.id}: 未满足依赖 ${missing.join(", ") || "未知"}`;
        }).join("\n");
        const query = wrapDeepseekQuery({
          type: "DECISION_REQUIRED",
          context: `项目 ${st.project_name} 的任务依赖无法继续。`,
          problem: blocked,
          options: "A: 修正依赖并 REPLAN\nB: 移除无法执行的任务\nC: 补充缺失的前置任务",
          recommendation: "请输出 REPLAN，给出可执行且无循环依赖的新任务列表。",
          question: "如何解除任务依赖阻塞？",
        });
        await this.sendToGpt(projectId, "QUERY", query);
        return this.store.transition(projectId, "WAITING_FOR_GPT", {
          pending: { text: "任务依赖阻塞，已请求 GPT 重新规划。", ts: nowIso(), retryState: "PLAN_READY" },
        });
      }
      // 全部任务完成 → 生成项目分析 → 发给 GPT 审查
      this.log("info", projectId, "全部任务完成，生成项目分析供 GPT 审查");
      return this.dispatchExecutor(projectId, "ANALYZE", "生成最终项目分析", null);
    }
    this.store.writeState(projectId, {
      current_task: task,
      pending: { text: `执行任务 ${task.id}: ${task.description}`, ts: nowIso() },
    });
    this.store.transition(projectId, "EXECUTING");
    return this.stepExecuting(projectId, await this.store.readState(projectId));
  }

  pickNextTask(st) {
    const candidates = this.pendingTasks(st);
    if (candidates.length === 0) return null;
    const completed = new Set((st.completed_tasks || []).map((t) => String(t.id).toUpperCase()));
    const ready = candidates.filter((t) =>
      (t.dependencies || []).every((d) => completed.has(String(d).toUpperCase()))
    );
    return ready[0] || null;
  }

  pendingTasks(st) {
    const tasks = st.plan?.parsed?.tasks || [];
    const completed = new Set((st.completed_tasks || []).map((t) => String(t.id).toUpperCase()));
    const failed = new Set((st.failed_tasks || []).map((t) => String(t.id).toUpperCase()));
    return tasks.filter((t) => {
      const id = String(t.id).toUpperCase();
      return !completed.has(id) && !failed.has(id);
    });
  }

  // ---------- EXECUTING：分派执行者 ----------
  async stepExecuting(projectId, st) {
    const task = st.current_task;
    if (!task) return this.store.transition(projectId, "PLAN_READY");
    const envelope = this.buildEnvelope(projectId, st, "EXECUTE_PLAN", task, null, 1);
    return this.dispatchExecutor(projectId, "EXECUTE_PLAN", task, envelope);
  }

  async stepAnalyzing(projectId, st) {
    if (st.current_dispatch_id && this.store.readInbox(projectId)?.dispatch_id === st.current_dispatch_id) {
      return this.stepWaitingExecutor(projectId, st);
    }
    const type = st.pending?.type === "DECIDE" ? "DECIDE" : "ANALYZE";
    return this.dispatchExecutor(projectId, type, st.pending?.request || (type === "DECIDE" ? "请评估并做出决定" : "分析当前项目"), null);
  }

  async stepWaitingExecutor(projectId, st) {
    const type = st.pending?.type || "EXECUTE_PLAN";
    const savedEnvelope = this.store.readInbox(projectId);
    if (st.current_dispatch_id && savedEnvelope?.dispatch_id === st.current_dispatch_id) {
      const ready = this.store.readOutboxStatus(projectId);
      if (ready.complete) {
        this.log("info", projectId, `恢复时发现原任务结果: ${st.current_dispatch_id}`);
        try {
          return await this.handleExecutorResult(projectId, { exitCode: 0, timedOut: false, ms: 0, resumed: true }, savedEnvelope);
        } catch (error) {
          if (type === "EXECUTE_PLAN") {
            return this.retryTaskAfterFailure(projectId, savedEnvelope, error.message, error.code || "OUTBOX_INVALID");
          }
          throw error;
        }
      }
      const dirs = { projectDir: this.store.projectDir(projectId), workspaceDir: this.store.workspaceDir(projectId), sourceDir: this.store.sourceDir(projectId) };
      const resumed = await this.runner.resume?.(projectId, dirs, savedEnvelope, this.store);
      if (resumed && !resumed.resumeFailed) {
        try {
          return await this.handleExecutorResult(projectId, resumed, savedEnvelope);
        } catch (error) {
          if (type === "EXECUTE_PLAN") {
            return this.retryTaskAfterFailure(projectId, savedEnvelope, error.message, error.code || "EXECUTOR_RESULT_ERROR");
          }
          throw error;
        }
      }
      if (type === "EXECUTE_PLAN") {
        this.log("warn", projectId, "原执行会话无法接管，恢复检查点后建立恢复会话");
        return this.retryTaskAfterFailure(projectId, savedEnvelope, "工作台重启后无法接管原执行会话", "SESSION_TAKEOVER_FAILED");
      }
    }
    this.log("info", projectId, "等待状态无可接管的 v3 派发，创建恢复会话");
    if (type === "ANALYZE" || type === "DECIDE") {
      return this.dispatchExecutor(projectId, type, st.pending?.request || "分析当前项目", null, 1);
    }
    return this.store.transition(projectId, "EXECUTING");
  }

  /** 项目计划哈希：用于判断计划是否变更（触发重新规划需传递增量 REPLAN）。 */
  planHash(tasks) {
    const s = JSON.stringify((tasks || []).map((t) => [t.id, t.status]));
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return String(h);
  }

  /**
   * 构建任务信封（含增量上下文）。
   * 依据项目级上下文缓存 context_cache：已发送且在会话中有效的信息（已完成/失败任务、
   * 决策、重规划）不再整表重复传输，只传相对上一状态的增量；并附 context 摘要
   * （计数 / 是否新会话 / 计划是否变更），供执行者简短引用与按需读取 project_state.json。
   */
  buildEnvelope(projectId, st, type, task, gptMessage, attempt) {
    const trunc = (s, n) => (s && s.length > n ? s.slice(0, n) + "…" : s);
    const cache = st.context_cache || null;
    const completed = (st.completed_tasks || []).map((t) => t.id);
    const failed = (st.failed_tasks || []).map((t) => t.id);
    const decisions = st.decisions || [];
    const replans = st.replans || [];
    const fresh = !cache || cache.plan_hash === undefined;
    const newCompleted = fresh ? completed : completed.filter((id) => !(cache.completed || []).includes(id));
    const newFailed = fresh ? failed : failed.filter((id) => !(cache.failed || []).includes(id));
    const newDecisions = fresh ? decisions : decisions.slice(cache.decisions || 0);
    const newReplans = fresh ? replans : replans.slice(cache.replans || 0);
    const planChanged = fresh || this.planHash(st.plan?.parsed?.tasks) !== cache.plan_hash;
    const taskId = task?.id || type;
    const timeoutSeconds = Number(task?.timeout);
    return {
      envelope_version: 3,
      schema_version: 3,
      dispatch_id: crypto.randomUUID(),
      created_at: nowIso(),
      workbench_dispatch: true,
      project_id: projectId,
      task_id: taskId,
      type,
      // 计划用"精简视图"（去掉完整任务描述），避免每任务重复携带完整计划文本；
      // 完整计划仍在 project_state.json / project_plan.md 中可读。
      plan: slimPlan(st.plan?.parsed || null),
      current_task: task,
      completed_tasks: newCompleted, // 增量：仅本会话尚未收到的新完成项
      failed_tasks: newFailed.map((id) => ({ id, summary: (st.failed_tasks || []).find((f) => f.id === id)?.summary || "" })),
      decisions: newDecisions,
      replans: newReplans,
      context: {
        fresh, planChanged,
        completedCount: completed.length,
        failedCount: failed.length,
        decisionsCount: decisions.length,
        replansCount: replans.length,
      },
      gpt_message: gptMessage,
      attempt: attempt || 1,
      project_name: st.project_name,
      user_task: trunc(st.user_task, 1200),
      executor_context_file: (st.compaction?.count || 0) > 0 || this.store.readFileSafe(projectId, "executor_context.md") ? ".gpt_workspace/executor_context.md" : null,
      timeoutMs: Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds * 1000 : this.cfg.deepseek?.executorTimeoutMs,
    };
  }

  /** 把当前项目状态写入"项目级上下文缓存基线"（本任务已发送内容），供下个任务做增量。 */
  updateContextCache(projectId) {
    const st = this.store.readState(projectId);
    if (!st) return;
    this.store.writeState(projectId, {
      context_cache: {
        completed: (st.completed_tasks || []).map((t) => t.id),
        failed: (st.failed_tasks || []).map((t) => t.id),
        decisions: (st.decisions || []).length,
        replans: (st.replans || []).length,
        plan_hash: this.planHash(st.plan?.parsed?.tasks),
        ts: nowIso(),
      },
    });
  }

  /**
   * 分派执行者并等待完成（写 inbox → 运行 dsh headless → 读 outbox → 流转）
   */
  async dispatchExecutor(projectId, type, requestOrTask, envelopeOrNull, attempt = 1) {
    const epoch = this.projectEpoch(projectId);
    const dirs = {
      projectDir: this.store.projectDir(projectId),
      workspaceDir: this.store.workspaceDir(projectId),
      sourceDir: this.store.sourceDir(projectId),
    };
    const st = this.store.readState(projectId);
    const envelope = envelopeOrNull || this.buildEnvelope(projectId, st, type, requestOrTask, requestOrTask, attempt);
    envelope.attempt = attempt || envelope.attempt || 1;
    if (type === "EXECUTE_PLAN") {
      const checkpoint = st.checkpoint;
      if (!checkpoint || checkpoint.task_id !== envelope.task_id) {
        this.store.createCheckpoint(projectId, envelope.task_id, envelope.dispatch_id);
      }
    }
    this.store.writeState(projectId, { current_dispatch_id: envelope.dispatch_id });
    if (type === "ANALYZE") {
      this.store.writeState(projectId, { pending: { text: "DeepSeek 正在分析项目…（执行窗口可实时查看）", ts: nowIso(), type: "ANALYZE", request: requestOrTask } });
      this.store.transition(projectId, "ANALYZING");
    } else if (type === "DECIDE") {
      this.store.writeState(projectId, { pending: { text: "DeepSeek 正在评估并做出决定…（执行窗口可实时查看）", ts: nowIso(), type: "DECIDE", request: requestOrTask } });
      this.store.transition(projectId, "DECISION_REQUIRED");
    } else {
      this.store.writeState(projectId, { pending: { text: `DeepSeek 执行中: ${st.current_task?.id || requestOrTask?.id || "-"}（执行窗口可实时查看）`, ts: nowIso(), type: "EXECUTE_PLAN" } });
      this.store.transition(projectId, "WAITING_FOR_EXECUTOR");
    }

    // 清理上一次执行可能残留的结果信封，避免误判（可见模式按 outbox 出现与否判定完成）
    this.store.clearOutbox(projectId);

    if (epoch !== this.projectEpoch(projectId)) return null;
    let result;
    try {
      result = await this.runner.run(projectId, dirs, envelope, this.store);
    } catch (error) {
      if (type === "EXECUTE_PLAN") return this.retryTaskAfterFailure(projectId, envelope, error.message, error.code || "RUNNER_ERROR");
      throw error;
    }
    const fresh = this.store.readState(projectId);
    if (result?.cancelled || epoch !== this.projectEpoch(projectId) || !fresh || fresh.state === "PAUSED") {
      this.log("info", projectId, "忽略已取消执行的迟到结果");
      return null;
    }
    let outcome;
    try {
      outcome = await this.handleExecutorResult(projectId, result, envelope);
    } catch (error) {
      if (type === "EXECUTE_PLAN") return this.retryTaskAfterFailure(projectId, envelope, error.message, error.code || "EXECUTOR_RESULT_ERROR");
      throw error;
    }
    // 更新项目级上下文缓存基线：复用会话→记录已发送状态（下个任务增量）；新会话→重置（下个任务全量）
    if (result?.freshSession) {
      this.store.writeState(projectId, { context_cache: null });
    } else {
      this.updateContextCache(projectId);
    }
    await this.maybeCompactSession(projectId);
    return outcome;
  }

  async retryTaskAfterFailure(projectId, envelope, summary, code = "TASK_FAILED") {
    let st = this.store.readState(projectId);
    const taskId = envelope.task_id || envelope.current_task?.id;
    const task = st?.plan?.parsed?.tasks?.find((item) => item.id === taskId) || st?.current_task || envelope.current_task;
    const currentAttempt = Number(envelope.attempt || 1);
    const maxAttempts = Math.min(10, Math.max(1, Number(task?.max_attempts || this.cfg.deepseek?.maxRetries || 2)));
    try {
      this.store.restoreCheckpoint(projectId);
      this.log("warn", projectId, `任务 ${taskId} 失败后已恢复检查点（${code}）`);
    } catch (error) {
      this.store.writeState(projectId, {
        state: "ERROR",
        error_count: this.maxConsecutiveErrors + 1,
        last_error: `CHECKPOINT_RESTORE: ${error.message}`,
        pending: { text: `恢复检查点失败，已停止任务：${error.message}`, ts: nowIso(), retryState: "ERROR", errorCode: "CHECKPOINT_RESTORE" },
      });
      return null;
    }
    st = this.store.readState(projectId);
    if (currentAttempt < maxAttempts) {
      const nextAttempt = currentAttempt + 1;
      const context = this.buildExecutorContext(projectId, st, `${code}: ${summary}`);
      this.store.writeWorkspaceFile(projectId, "executor_context.md", context);
      this.store.writeState(projectId, { pending: { text: `任务 ${taskId} 已回滚，正在重试 ${nextAttempt}/${maxAttempts}…`, ts: nowIso(), type: "EXECUTE_PLAN" } });
      const nextEnvelope = this.buildEnvelope(projectId, st, "EXECUTE_PLAN", task, null, nextAttempt);
      return this.dispatchExecutor(projectId, "EXECUTE_PLAN", task, nextEnvelope, nextAttempt);
    }
    const failed = (st.failed_tasks || []).filter((item) => item.id !== taskId);
    failed.push({ id: taskId, ts: nowIso(), summary: String(summary || "未知失败"), attempt: currentAttempt, code });
    this.store.writeState(projectId, { failed_tasks: failed, current_dispatch_id: null });
    const query = wrapDeepseekQuery({
      type: "DECISION_REQUIRED",
      context: `项目 ${st.project_name}：任务已恢复到执行前检查点。`,
      problem: `任务 ${taskId}${task?.description ? `（${task.description}）` : ""} 连续失败 ${maxAttempts} 次：${summary}`,
      options: "A: 修改任务方案后重试\nB: 从计划中移除该任务",
      recommendation: "请重新规划该任务，避免重复相同失败。",
      question: "请决策如何继续。",
    });
    await this.sendToGpt(projectId, "QUERY", query);
    return this.store.transition(projectId, "WAITING_FOR_GPT", { pending: { text: `任务 ${taskId} 已回滚，等待 GPT 调整计划。`, ts: nowIso(), retryState: "PLAN_READY" } });
  }

  recordExecutorUsage(projectId, result, envelope, completed) {
    const st = this.store.readState(projectId);
    const after = result.usageAfter?.tokenUsage || null;
    const before = result.usageBefore?.tokenUsage || null;
    const context = contextSnapshot(result.usageAfter?.contextPressure);
    const ds = st.usage.deepseek;

    const generations = [...(st.session_generations || [])];
    let generation = generations.at(-1);
    if (result.sessionId && generation?.session_id !== result.sessionId) {
      if (generation && !generation.ended_at) generation = generations[generations.length - 1] = { ...generation, ended_at: nowIso() };
      generation = {
        generation: (generations.at(-1)?.generation || 0) + 1,
        session_id: result.sessionId,
        started_at: nowIso(),
        ended_at: null,
        reason: result.freshSession ? "new_or_recovered" : "observed",
        model: result.actualModel || null,
        completed_tasks: 0,
      };
      generations.push(generation);
    }
    const effectiveBefore = before || (generation && generation.session_id === result.sessionId ? generation.last_token_usage : null);
    const tokens = tokenUsageDelta(effectiveBefore, after);
    const totals = { ...ds.totals };
    if (tokens) for (const key of TOKEN_KEYS) totals[key] = Number(totals[key] || 0) + tokens[key];
    if (completed && envelope.type === "EXECUTE_PLAN" && generation) {
      generations[generations.length - 1] = { ...generation, completed_tasks: Number(generation.completed_tasks || 0) + 1 };
      generation = generations.at(-1);
    }
    if (generation && after) {
      generations[generations.length - 1] = { ...generation, last_token_usage: after };
      generation = generations.at(-1);
    }

    const record = {
      ts: nowIso(),
      task_id: envelope.current_task?.id || envelope.type,
      type: envelope.type,
      attempt: envelope.attempt || 1,
      generation: generation?.generation || null,
      session_id: result.sessionId || null,
      model: result.actualModel || null,
      duration_ms: result.ms,
      actual: !!tokens,
      tokens,
      context,
    };
    const tasks = [...(ds.tasks || []), record].slice(-500);
    this.store.writeState(projectId, {
      usage: { ...st.usage, deepseek: { ...ds, totals, tasks, context: context || ds.context || null } },
      session_generations: generations,
    });
    return record;
  }

  async handleExecutorResult(projectId, result, envelope) {
    let st = this.store.readState(projectId);
    if (!st) return null;
    const outboxStatus = this.store.readOutboxStatus(projectId);
    const outbox = outboxStatus.data;
    if (outbox) {
      const checked = validateExecutorOutbox(outbox, envelope, st.processed_dispatch_ids || []);
      if (!checked.ok) {
        this.store.clearOutbox(projectId);
        const error = new Error(checked.error);
        error.code = checked.code;
        throw error;
      }
    } else if (outboxStatus.exists) {
      this.store.clearOutbox(projectId);
      const error = new Error("outbox/message.json 未完成原子写入或 JSON 不完整");
      error.code = "OUTBOX_INCOMPLETE";
      throw error;
    }
    let validationResult = null;
    if (outbox?.type === "TASK_DONE" && envelope.type === "EXECUTE_PLAN" && envelope.current_task?.validation) {
      validationResult = await runValidationCommand(envelope.current_task.validation, this.store.sourceDir(projectId), envelope.timeoutMs || 300000);
      validationResult = { ...validationResult, task_id: envelope.task_id, ts: nowIso() };
      this.store.writeState(projectId, { validation_results: { ...(st.validation_results || {}), [envelope.task_id]: validationResult } });
    }
    const usageRecord = this.recordExecutorUsage(projectId, result, envelope, outbox?.type === "TASK_DONE" && validationResult?.ok !== false);
    st = this.store.readState(projectId);
    const runs = [...(st.executor_runs || [])];
    runs.push({
      ts: nowIso(), type: envelope.type,
      task_id: envelope.current_task?.id || envelope.type,
      attempt: envelope.attempt || 1,
      exitCode: result.exitCode, timedOut: !!result.timedOut, ms: result.ms, mock: !!result.mock,
      visible: !!result.visible,
      model: result.actualModel || null,
      usage: usageRecord,
      validation: validationResult,
      resumed: !!result.resumed,
    });
    const processed = outbox ? [...new Set([...(st.processed_dispatch_ids || []), outbox.dispatch_id])].slice(-200) : (st.processed_dispatch_ids || []);
    this.store.writeState(projectId, { executor_runs: runs.slice(-100), processed_dispatch_ids: processed });
    this.store.clearOutbox(projectId);

    if (!outbox) {
      const err = result.timedOut
        ? new Error(`执行者超时（${Math.round(result.ms / 1000)}s）`)
        : result.uiCrashed
          ? new Error("DeepSeek 执行窗口服务中途崩溃，任务未完成")
          : result.idleNoOutbox
            ? new Error("执行会话已结束但未写 outbox/message.json（可见窗口内可查看原因）")
            : new Error(`执行者退出（exitCode=${result.exitCode}）但未写 outbox/message.json`);
      err.code = result.timedOut ? "RUNNER_TIMEOUT" : result.uiCrashed ? "RUNNER_UI_CRASH" : "RUNNER_NO_OUTBOX";
      throw err;
    }

    if (validationResult && !validationResult.ok) {
      this.log("warn", projectId, `任务 ${envelope.task_id} 验证失败: ${validationResult.command}`);
      return this.retryTaskAfterFailure(projectId, envelope, `验证失败（exit=${validationResult.exit_code}）：${validationResult.output}`, "VALIDATION_FAILED");
    }

    if (outbox.type === "TASK_DONE") {
      this.log("info", projectId, `执行完成: ${outbox.task_id} — ${outbox.summary || ""}`);
      if (envelope.type === "ANALYZE" || envelope.type === "DECIDE") {
        const reportFile = outbox.report_file || "project_analysis.md";
        const content = this.store.readFileSafe(projectId, reportFile)
          || this.store.readFileSafe(projectId, "project_analysis.md")
          || outbox.summary || "（无分析内容）";
        const reports = [...(st.analysis_reports || [])];
        reports.push({ ts: nowIso(), file: reportFile, summary: outbox.summary || "", type: envelope.type });
        this.store.writeState(projectId, { analysis_reports: reports.slice(-50) });
        // 把分析结果发给 GPT
        const truncated = this.truncate(content, this.cfg.gpt?.maxAnalysisChars || 30000);
        const kind = envelope.type === "DECIDE" ? "DECISION_RESULT" : "ANALYSIS";
        const payload = envelope.type === "DECIDE"
          ? `DeepSeek 已完成评估/决定，结果如下：\n\n${truncated}\n\n请基于此继续决策。`
          : `这是当前项目分析（project_analysis.md）：\n\n${truncated}\n\n请基于此继续决策（CONTINUE + 下一任务 / REPLAN / DONE）。`;
        await this.sendToGpt(projectId, kind, payload);
        this.store.writeState(projectId, {
          pending: { text: "分析已发送给 GPT，等待决策…", ts: nowIso() },
          review_requested: st.review_requested || false,
        });
        this.store.writeState(projectId, { current_dispatch_id: null });
        return this.store.transition(projectId, "WAITING_FOR_GPT");
      }
      // 普通任务完成
      const completed = [...(st.completed_tasks || [])];
      completed.push({
        id: outbox.task_id || envelope.current_task?.id,
        ts: nowIso(),
        report_file: outbox.report_file || null,
        summary: outbox.summary || "",
      });
      this.store.clearCheckpoint(projectId);
      this.store.writeState(projectId, { completed_tasks: completed, current_dispatch_id: null });
      this.log("info", projectId, `任务完成并记录: ${outbox.task_id}（已完成 ${completed.length} 项）`);
      if (this.store.readState(projectId)?.pending_model_replan?.status === "waiting_task") {
        return this.beginModelReplan(projectId);
      }
      return this.store.transition(projectId, "PLAN_READY");
    }

    if (outbox.type === "TASK_FAILED") {
      const taskId = outbox.task_id || envelope.current_task?.id;
      if (envelope.type !== "EXECUTE_PLAN") {
        const error = new Error(outbox.summary || `${taskId} 失败`);
        error.code = "TASK_FAILED";
        throw error;
      }
      return this.retryTaskAfterFailure(projectId, envelope, outbox.summary || `任务 ${taskId} 失败`, "TASK_FAILED");
    }

    if (outbox.type === "ASK_GPT") {
      this.log("info", projectId, "执行者请求 GPT 决策，转发问题");
      const query = wrapDeepseekQuery({
        type: outbox.type === "ASK_GPT" ? "DECISION_REQUIRED" : outbox.type,
        context: outbox.context || `项目 ${st.project_name}`,
        problem: outbox.problem || "",
        options: outbox.options || "",
        recommendation: outbox.recommendation || "",
        question: outbox.question || "请给出决策。",
      });
      await this.sendToGpt(projectId, "QUERY", query);
      this.store.writeState(projectId, { current_dispatch_id: null });
      return this.store.transition(projectId, "WAITING_FOR_GPT");
    }

    this.log("warn", projectId, `未知 outbox 类型: ${outbox.type}，回到 PLAN_READY`);
    return this.store.transition(projectId, "PLAN_READY");
  }

  // ---------- WAITING_FOR_GPT：处理 GPT 决策 ----------
  async stepWaitingGpt(projectId, st) {
    const text = await this.waitForGpt(projectId);
    st = this.store.readState(projectId) || st;
    let parsed = parseGptResponse(text);
    if (!parsed.status) {
      const used = (st.protocol_reprompts || 0) + 1;
      this.store.writeState(projectId, { protocol_reprompts: used });
      if (used <= this.protocolReprompts) {
        await this.sendToGpt(projectId, "REPROMPT", "请按协议回复：<GPT_RESPONSE><STATUS>CONTINUE|REPLAN|DONE</STATUS>…</GPT_RESPONSE>");
        return this.store.transition(projectId, "WAITING_FOR_GPT");
      }
      this.store.transition(projectId, "ERROR", {
        pending: { text: "GPT 多次未按协议回复。请在 Dashboard 查看对话并点击“重试”。", ts: nowIso(), retryState: "WAITING_FOR_GPT" },
      });
      return;
    }
    if (st.protocol_reprompts) this.store.writeState(projectId, { protocol_reprompts: 0 });

    if (st.pending_model_replan?.status === "awaiting_gpt" && !["REPLAN", "READY"].includes(parsed.status)) {
      await this.sendToGpt(projectId, "REPROMPT", "这是模型切换后的增量重规划。请只输出未完成任务，使用 <STATUS>REPLAN</STATUS> 和 <UPDATED_PLAN>；不要重新加入已完成任务。");
      return this.store.transition(projectId, "WAITING_FOR_GPT");
    }

    switch (parsed.status) {
      case "CONTINUE": {
        if (st.pending_model_replan?.status === "waiting_gpt") return this.beginModelReplan(projectId);
        const nextId = parsed.nextTask ? String(parsed.nextTask).trim().toUpperCase() : null;
        const tasks = st.plan?.parsed?.tasks || [];
        const completed = new Set((st.completed_tasks || []).map((t) => t.id));
        const failed = new Set((st.failed_tasks || []).map((t) => t.id));
        let target = null;
        if (nextId) {
          target = tasks.find((t) => String(t.id).toUpperCase() === nextId) || null;
          if (target && (completed.has(target.id) || failed.has(target.id))) target = null;
        }
        if (target) {
          this.store.writeState(projectId, { current_task: target });
          return this.store.transition(projectId, "PLAN_READY");
        }
        const pendingTasks = tasks.filter((t) => !completed.has(t.id) && !failed.has(t.id));
        if (pendingTasks.length > 0) {
          return this.store.transition(projectId, "PLAN_READY");
        }
        // 无待办任务 → 进入最终审查
        if (!st.review_requested) {
          this.log("info", projectId, "无待办任务，请求 GPT 最终审查");
          await this.sendToGpt(projectId, "REVIEW_REQUEST", this.buildReviewRequest(projectId, st));
          this.store.writeState(projectId, { review_requested: true });
          return this.store.transition(projectId, "WAITING_FOR_GPT");
        }
        // 审查后仍 CONTINUE 且无任务 → 视作完成
        this.log("info", projectId, "GPT 审查后仍 CONTINUE 且无剩余任务，视为完成");
        return this.completeProject(projectId, "GPT 审查通过（无剩余任务）");
      }
      case "REPLAN":
      case "READY": {
        const planText = parsed.updatedPlan || parsed.plan;
        if (!planText) {
          await this.sendToGpt(projectId, "REPROMPT", `收到 ${parsed.status} 但缺少计划内容，请附 <PLAN> 或 <UPDATED_PLAN>。`);
          return this.store.transition(projectId, "WAITING_FOR_GPT");
        }
        this.savePlan(projectId, planText, {
          replan: true,
          decision: parsed.decision,
        });
        if (this.store.readState(projectId)?.pending_model_replan?.status === "waiting_gpt") {
          return this.beginModelReplan(projectId);
        }
        if (this.store.readState(projectId)?.pending_model_replan?.status === "awaiting_gpt") {
          await this.finishModelReplan(projectId);
        }
        this.log("info", projectId, "GPT 重新规划（增量合并），继续执行");
        return this.store.transition(projectId, "PLAN_READY");
      }
      case "NEED_ANALYSIS":
        if (st.pending_model_replan?.status === "waiting_gpt") return this.beginModelReplan(projectId);
        return this.dispatchExecutor(projectId, "ANALYZE", parsed.request || "分析当前项目并生成 project_analysis.md", null);
      case "DECISION_REQUIRED":
        if (st.pending_model_replan?.status === "waiting_gpt") return this.beginModelReplan(projectId);
        return this.dispatchExecutor(projectId, "DECIDE", parsed.request || "请评估并做出决定", null);
      case "DONE":
        if (st.pending_model_replan) this.store.writeState(projectId, { pending_model_replan: null });
        return this.completeProject(projectId, "GPT 最终判定完成");
      default:
        return this.store.transition(projectId, "WAITING_FOR_GPT");
    }
  }

  // ---------- ERROR：自恢复 ----------
  async stepError(projectId, st) {
    const retryState = st.pending?.retryState || st.previous_state || "INIT";
    if (st.error_count <= this.maxConsecutiveErrors) {
      this.log("info", projectId, `错误自恢复（第 ${st.error_count} 次）：回到 ${retryState}`);
      await sleep(8000);
      this.store.writeState(projectId, { pending: { text: `自恢复中：回到 ${retryState}`, ts: nowIso(), retryState } });
      return this.store.transition(projectId, retryState);
    }
    // 超过容错 → 询问 GPT（若有计划）；否则停在 ERROR 等待人工
    if (st.plan?.parsed && !st.error_asked_gpt) {
      this.log("warn", projectId, "连续错误超限，询问 GPT");
      this.store.writeState(projectId, { error_asked_gpt: true });
      const query = wrapDeepseekQuery({
        type: "DECISION_REQUIRED",
        context: `项目 ${st.project_name}，状态机卡在 ${st.previous_state}。`,
        problem: `连续 ${st.error_count} 次错误：${st.last_error}`,
        options: "A: 重新规划（REPLAN）\nB: 跳过当前任务（CONTINUE）\nC: 暂停项目",
        recommendation: "若为执行环境问题建议 REPLAN 调整方案，否则 CONTINUE 跳过。",
        question: "请决策如何恢复项目。",
      });
      await this.sendToGpt(projectId, "QUERY", query);
      return this.store.transition(projectId, "WAITING_FOR_GPT");
    }
    // 停在 ERROR：Dashboard 显示，等待用户操作
    await sleep(5000);
  }

  // ================= GPT 收发 =================
  async sendToGpt(projectId, type, content, opts = {}) {
    await this.acquireGpt(projectId);
    const epoch = this.projectEpoch(projectId);
    this.beginGptOp(projectId);
    let sent = false;
    try {
      const st = this.store.readState(projectId);
      await this.bridge.ensureBrowser();
      if (opts.intro || !st.gpt?.conversation_url) {
        await this.bridge.newConversation();
      } else {
        await this.openConversation(projectId, st.gpt.conversation_url);
      }
      const pageState = await this.bridge.detectState();
      if (pageState.challenge || !pageState.loggedIn) {
        const e = new Error(pageState.challenge ? "ChatGPT 验证挑战" : "ChatGPT 未登录");
        e.code = pageState.challenge ? "GPT_CHALLENGE" : "GPT_LOGIN_REQUIRED";
        throw e;
      }
      const profile = st.deepseek_selection || this.cfg.deepseek || {};
      const profiledContent = ["PLAN_REQUEST", "QUERY"].includes(type)
        ? `${content}\n\n${buildDeepseekPlanningGuidance(profile)}`
        : content;
      const msg = wrapOrchestratorMsg(type, profiledContent);
      const baseline = await this.bridge.assistantCount();
      const files = (Array.isArray(opts.attachments) ? opts.attachments : [])
        .map((a) => this.store.resolveWorkspacePath(projectId, a.relative_path));
      await this.bridge.sendMessage(msg, { files });
      this.assertProjectActive(projectId, epoch);
      this.store.recordGptMessage(projectId, "out", msg, { type, task_id: st.current_task?.id || null });
      const url = this.bridge.page?.url?.() || null;
      this.store.writeState(projectId, {
        gpt: {
          intro_sent: true,
          conversation_url: url || st.gpt?.conversation_url,
          reply_baseline: baseline >= 0 ? baseline : st.gpt?.reply_baseline,
          last_reply_text: null,
        },
      });
      this.log("info", projectId, `已发送消息给 GPT（${type}，${profiledContent.length} 字符，baseline=${baseline}）`);
      sent = true;
    } finally {
      this.endGptOp(projectId);
      if (!sent) this.releaseGpt(projectId);
    }
  }

  async openConversation(projectId, url) {
    if (!url || !/^https?:\/\//.test(url)) return;
    if (this.bridge.page?.url?.() === url) return;
    try {
      await this.bridge.page?.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(3000);
      const s = await this.bridge.detectState();
      if (s.challenge) { const e = new Error("ChatGPT 验证挑战"); e.code = "GPT_CHALLENGE"; throw e; }
    } catch (e) {
      if (e.code) throw e;
      this.log("warn", projectId, `打开会话 ${url} 失败: ${e.message}，回到首页`);
      await this.bridge.gotoChat();
    }
  }

  async waitForGpt(projectId) {
    await this.acquireGpt(projectId);
    const epoch = this.projectEpoch(projectId);
    this.gptWaitingProjects.add(projectId);
    try {
      const st = this.store.readState(projectId);
      await this.bridge.ensureBrowser();
      await this.openConversation(projectId, st.gpt?.conversation_url);
      const baseline = st.gpt?.reply_baseline ?? 0;
      this.store.writeState(projectId, {
        pending: { text: "等待 GPT 回复…", ts: nowIso() },
      });
      const cancelled = () => {
        const fresh = this.store.readState(projectId);
        return epoch !== this.projectEpoch(projectId) || !fresh || fresh.state === "PAUSED";
      };
      const reply = await this.bridge.waitForReply(baseline, this.cfg.gpt?.replyTimeoutMs, cancelled);
      if (cancelled()) {
        const e = new Error("项目已暂停或删除"); e.code = "PROJECT_CANCELLED"; throw e;
      }
      this.store.recordGptMessage(projectId, "in", reply.text, { task_id: st.current_task?.id || null });
      this.store.writeState(projectId, {
        gpt: {
          last_reply_text: reply.text,
          last_reply_ts: nowIso(),
          reply_baseline: reply.count,
        },
      });
      this.log("info", projectId, `收到 GPT 回复（${reply.text.length} 字符，耗时 ${Math.round(reply.ms / 1000)}s）`);
      return reply.text;
    } finally {
      this.gptWaitingProjects.delete(projectId);
      this.releaseGpt(projectId);
    }
  }

  // ================= 计划管理 =================
  savePlan(projectId, planText, meta = {}) {
    const st = this.store.readState(projectId);
    const parsed = parsePlan(planText);
    if (!parsed) {
      const e = new Error("计划解析失败：无法提取任务列表");
      e.code = "PLAN_PARSE";
      throw e;
    }
    const completedIds = (st.completed_tasks || []).map((t) => t.id);
    const failedIds = (st.failed_tasks || []).map((t) => t.id);
    let finalPlan = parsed;
    if (st.plan?.parsed && (meta.replan || false)) {
      finalPlan = mergePlan(st.plan.parsed, parsed, completedIds, failedIds);
    }
    // 任务状态回填
    const completed = new Set(completedIds);
    const failed = new Set(failedIds);
    for (const t of finalPlan.tasks) {
      if (completed.has(t.id)) t.status = "completed";
      else if (failed.has(t.id)) t.status = "failed";
      else t.status = "pending";
    }
    this.store.writeWorkspaceFile(projectId, "project_plan.md", planText);
    const replans = meta.replan ? [...(st.replans || []), { ts: nowIso(), decision: meta.decision || null }] : (st.replans || []);
    this.store.writeState(projectId, {
      plan: { raw: planText, parsed: finalPlan, updated_at: nowIso() },
      replans: replans.slice(-50),
      protocol_reprompts: 0,
    });
    // 更新 gpt_context.md（供恢复时重建会话上下文）
    const ctx = `# 项目上下文：${st.project_name}\n\n更新时间：${nowIso()}\n\n用户任务：\n${st.user_task}\n\n当前计划：\n\n${planText}\n\n已完成任务：\n${completedIds.map((id) => `- ${id}`).join("\n")}\n`;
    this.store.writeWorkspaceFile(projectId, "gpt_context.md", ctx);
    this.log("info", projectId, `计划已保存：${finalPlan.tasks.length} 项任务${meta.replan ? "（增量重规划）" : ""}`);
  }

  buildReviewRequest(projectId, st) {
    const tasks = st.plan?.parsed?.tasks || [];
    const lines = tasks.map((t) => {
      const mark = (st.completed_tasks || []).some((c) => c.id === t.id) ? "[DONE]" : "[PENDING]";
      return `${mark} ${t.id} — ${t.description}`;
    }).join("\n");
    const criteria = (st.plan?.parsed?.acceptance_criteria || []).map((c) => `- ${c}`).join("\n");
    const analysis = this.store.readFileSafe(projectId, "project_analysis.md");
    return `请进行最终审查。\n\n任务清单：\n${lines}\n\n验收标准：\n${criteria || "（无）"}\n\n最新项目分析：\n${this.truncate(analysis || "（无）", 8000)}\n\n请逐项对照验收标准：全部满足输出 <STATUS>DONE</STATUS>；需修改输出 <STATUS>REPLAN</STATUS> + <UPDATED_PLAN>；需继续执行输出 <STATUS>CONTINUE</STATUS>。`;
  }

  truncate(text, max) {
    if (!text) return "";
    if (text.length <= max) return text;
    return text.slice(0, max) + `\n\n…（内容过长，已截断至 ${max} 字符）`;
  }

  buildExecutorContext(projectId, st, reason) {
    const completed = (st.completed_tasks || []).map((t) => `- ${t.id}: ${t.summary || "完成"}`).join("\n") || "- 无";
    const failed = (st.failed_tasks || []).map((t) => `- ${t.id}: ${t.summary || "失败"}`).join("\n") || "- 无";
    const decisions = (st.decisions || []).slice(-10).map((d) => `- ${JSON.stringify(d)}`).join("\n") || "- 无";
    const reports = (st.completed_tasks || []).slice(-3).map((task) => {
      const content = task.report_file ? this.store.readFileSafe(projectId, task.report_file) : null;
      return content ? `## ${task.id} 近期报告\n\n${this.truncate(content, 3000)}` : null;
    }).filter(Boolean).join("\n\n") || "（无可读近期报告）";
    return `# Executor continuation context\n\n- 项目：${st.project_name}\n- 生成时间：${nowIso()}\n- 原因：${reason}\n- 用户目标：${st.user_task}\n\n## 当前计划\n\n${st.plan?.raw || "（无）"}\n\n## 已完成任务\n\n${completed}\n\n## 失败任务\n\n${failed}\n\n## 近期决策\n\n${decisions}\n\n## 近期执行报告\n\n${reports}\n\n继续时只执行计划中尚未完成的任务，不重复执行已完成任务。\n`;
  }

  async performSessionCompaction(projectId, reason = "manual") {
    const st = this.store.readState(projectId);
    if (!st) throw new Error(`项目不存在: ${projectId}`);
    if (this.runner.isRunning?.(projectId)) {
      this.store.writeState(projectId, { compaction: { ...st.compaction, pending: true, in_progress: false, requested_at: nowIso(), reason } });
      return { queued: true };
    }
    this.store.writeState(projectId, { compaction: { ...st.compaction, pending: false, in_progress: true, reason } });
    const epoch = this.projectEpoch(projectId);
    const wasPaused = st.state === "PAUSED";
    const summary = this.buildExecutorContext(projectId, st, reason);
    this.store.writeWorkspaceFile(projectId, "executor_context.md", summary);
    const dirs = {
      projectDir: this.store.projectDir(projectId),
      workspaceDir: this.store.workspaceDir(projectId),
      sourceDir: this.store.sourceDir(projectId),
    };
    try {
      const created = await this.runner.compactSession(projectId, dirs, this.store);
      const fresh = this.store.readState(projectId);
      if (!fresh || epoch !== this.projectEpoch(projectId) || (!wasPaused && fresh.state === "PAUSED")) {
        if (fresh) this.store.writeState(projectId, { compaction: { ...fresh.compaction, in_progress: false } });
        return { queued: false, cancelled: true };
      }
      const generations = [...(fresh.session_generations || [])];
      if (generations.length && !generations.at(-1).ended_at) {
        generations[generations.length - 1] = { ...generations.at(-1), ended_at: nowIso(), end_reason: reason };
      }
      generations.push({
        generation: (generations.at(-1)?.generation || 0) + 1,
        session_id: created.sessionId,
        started_at: nowIso(),
        ended_at: null,
        reason,
        model: created.actualModel || null,
        completed_tasks: 0,
      });
      const count = Number(fresh.compaction?.count || 0) + 1;
      this.store.writeState(projectId, {
        session_generations: generations,
        context_cache: null,
        usage: { ...fresh.usage, deepseek: { ...fresh.usage.deepseek, context: null } },
        compaction: { pending: false, in_progress: false, count, last: { ts: nowIso(), reason, session_id: created.sessionId } },
      });
      this.log("info", projectId, `执行会话已压缩：generation=${generations.at(-1).generation} reason=${reason}`);
      return { queued: false, sessionId: created.sessionId };
    } catch (error) {
      const fresh = this.store.readState(projectId);
      if (fresh) this.store.writeState(projectId, { compaction: { ...fresh.compaction, pending: true, in_progress: false, error: error.message } });
      throw error;
    }
  }

  async maybeCompactSession(projectId) {
    const st = this.store.readState(projectId);
    if (!st || st.pending_model_replan || st.compaction?.in_progress) return false;
    const context = st.usage?.deepseek?.context;
    const threshold = Number(this.cfg.deepseek?.contextCompactThreshold ?? 0.7) * 100;
    const generation = st.session_generations?.at(-1);
    const fallback = Number(this.cfg.deepseek?.contextCompactFallbackTasks ?? 20);
    const reason = st.compaction?.pending
      ? "manual"
      : context?.percentage != null && context.percentage >= threshold
        ? `context_${context.percentage}%`
        : context?.percentage == null && Number(generation?.completed_tasks || 0) >= fallback
          ? `fallback_${fallback}_tasks`
          : null;
    if (!reason) return false;
    await this.performSessionCompaction(projectId, reason);
    return true;
  }

  async beginModelReplan(projectId) {
    const st = this.store.readState(projectId);
    if (!st?.pending_model_replan) return null;
    const completed = new Set((st.completed_tasks || []).map((t) => t.id));
    const unfinished = (st.plan?.parsed?.tasks || []).filter((t) => !completed.has(t.id));
    const list = unfinished.map((t) => `- ${t.id}: ${t.description || ""}（依赖: ${(t.dependencies || []).join(", ") || "无"}）`).join("\n") || "- 无";
    this.store.writeState(projectId, {
      state: "REPLANNING",
      previous_state: st.state,
      pending_model_replan: { ...st.pending_model_replan, status: "sending_gpt" },
      pending: { text: "模型已切换，GPT 正在仅重写未完成任务…", ts: nowIso(), retryState: "PLAN_READY" },
    });
    const prompt = `DeepSeek 执行模型已切换为 ${st.deepseek_selection?.provider || "默认"}/${st.deepseek_selection?.model || "默认"}${st.deepseek_selection?.reasoningEffort ? `（推理=${st.deepseek_selection.reasoningEffort}）` : ""}。\n\n请仅重写下列未完成任务，使粒度适配新模型；不得重新加入或改写已完成任务。输出 <STATUS>REPLAN</STATUS> 和 <UPDATED_PLAN>，计划只包含未完成任务。\n\n未完成任务：\n${list}`;
    await this.sendToGpt(projectId, "QUERY", prompt);
    const fresh = this.store.readState(projectId);
    this.store.writeState(projectId, { pending_model_replan: { ...fresh.pending_model_replan, status: "awaiting_gpt" } });
    return this.store.transition(projectId, "WAITING_FOR_GPT", { pending: { text: "等待 GPT 返回模型切换后的增量计划…", ts: nowIso(), retryState: "PLAN_READY" } });
  }

  async finishModelReplan(projectId) {
    await this.performSessionCompaction(projectId, "model_change");
    this.store.writeState(projectId, { pending_model_replan: null });
  }

  completeProject(projectId, reason) {
    const st = this.store.readState(projectId);
    this.log("info", projectId, `项目完成：${reason}`);
    // 释放可见执行服务（延时，给用户留出查看最终执行窗口的时间）
    this.runner.scheduleUiCleanup?.(projectId, 30000);
    const report = `# 项目完成报告\n\n- 项目：${st.project_name}\n- 完成时间：${nowIso()}\n- 原因：${reason}\n- 完成任务：${(st.completed_tasks || []).map((t) => t.id).join(", ") || "无"}\n- 失败任务：${(st.failed_tasks || []).map((t) => t.id).join(", ") || "无"}\n- GPT 会话：${st.gpt?.conversation_url || "（无）"}\n`;
    this.store.writeWorkspaceFile(projectId, "FINAL_REPORT.md", report);
    return this.store.transition(projectId, "COMPLETED", {
      pending: { text: "项目完成。", ts: nowIso() },
      milestone: { text: reason, ts: nowIso() },
    });
  }

  // ================= 控制指令（Dashboard 用） =================
  async createProject(name, task, sourceDir, opts = {}) {
    const id = this.store.createProject(name, task, sourceDir);
    const initialAttachments = (Array.isArray(opts.attachments) ? opts.attachments : [])
      .map((item) => this.store.saveAttachment(id, item.name, item.mime, item.buffer));
    if (initialAttachments.length) this.store.writeState(id, { initial_attachment_ids: initialAttachments.map((item) => item.id) });
    if (opts.deepseek_selection) {
      this.store.writeState(id, { deepseek_selection: opts.deepseek_selection });
    }
    if (opts.executor_type) await this.selectExecutor(id, opts.executor_type);
    this.startLoop(id);
    return id;
  }

  /** 重命名项目（仅改显示名，目录 id 不变） */
  async renameProject(projectId, newName) {
    const st = this.store.readState(projectId);
    if (!st) throw new Error(`项目不存在: ${projectId}`);
    const name = String(newName || "").trim();
    if (!name) throw new Error("项目名不能为空");
    this.store.writeState(projectId, { project_name: name });
    return this.store.readState(projectId).project_name;
  }

  /** 归档 / 取消归档 */
  async setProjectArchived(projectId, archived) {
    const st = this.store.readState(projectId);
    if (!st) throw new Error(`项目不存在: ${projectId}`);
    this.store.writeState(projectId, { archived: !!archived });
    return !!archived;
  }

  /** 设置项目的 DeepSeek 模型选择 */
  async setProjectDeepseekSelection(projectId, selection) {
    const st = this.store.readState(projectId);
    if (!st) throw new Error(`项目不存在: ${projectId}`);
    const sel = {
      provider: String(selection?.provider || ""),
      model: String(selection?.model || ""),
      reasoningEffort: String(selection?.reasoningEffort || ""),
    };
    const changed = JSON.stringify(st.deepseek_selection || {}) !== JSON.stringify(sel);
    if (!changed) return sel;
    const canReplan = !!st.plan?.parsed && !["COMPLETED", "CANCELED"].includes(st.state);
    const busy = this.runner.isRunning?.(projectId)
      || ["EXECUTING", "WAITING_FOR_EXECUTOR", "ANALYZING", "DECISION_REQUIRED"].includes(st.state);
    const gptBusy = this.gptIsActive(projectId) || this.gptWaitingProjects.has(projectId)
      || ["GPT_PLANNING", "WAITING_FOR_GPT", "REPLANNING"].includes(st.state);
    const paused = st.state === "PAUSED";
    this.store.writeState(projectId, {
      deepseek_selection: sel,
      pending_model_replan: canReplan ? { selection: sel, requested_at: nowIso(), status: paused ? "paused" : busy ? "waiting_task" : gptBusy ? "waiting_gpt" : "ready" } : null,
    });
    if (canReplan && !busy && !gptBusy && !paused) await this.beginModelReplan(projectId);
    return sel;
  }

  async selectExecutor(projectId, type) {
    const st = this.store.readState(projectId);
    if (!st) throw new Error(`项目不存在: ${projectId}`);
    if (this.runner.isRunning?.(projectId)) throw new Error("执行中不能切换执行器");
    const selected = String(type || "deepseek");
    const available = this.runner.available?.() || [];
    const entry = available.find((item) => item.type === selected);
    if (!entry) throw new Error(`未知执行器: ${selected}`);
    if (!entry.configured) throw new Error(`${entry.label} 尚未配置`);
    const executor = { type: selected, capabilities: this.runner.capabilities(selected) };
    this.store.writeState(projectId, { executor, session: selected === "deepseek" ? st.session : null, context_cache: null });
    return executor;
  }

  async compactSession(projectId) {
    const st = this.store.readState(projectId);
    if (!st) throw new Error(`项目不存在: ${projectId}`);
    if (["COMPLETED", "CANCELED"].includes(st.state)) throw new Error("已结束项目无需压缩会话");
    if (this.runner.isRunning?.(projectId)
      || ["EXECUTING", "WAITING_FOR_EXECUTOR", "ANALYZING", "DECISION_REQUIRED"].includes(st.state)) {
      this.store.writeState(projectId, {
        compaction: { ...st.compaction, pending: true, requested_at: nowIso(), reason: "manual" },
      });
      return { queued: true };
    }
    return this.performSessionCompaction(projectId, "manual");
  }

  /** 删除项目：停止循环 + 释放执行者 + 删除目录 */
  async deleteProject(projectId) {
    const st = this.store.readState(projectId);
    if (!st) throw new Error(`项目不存在: ${projectId}`);
    this.invalidateProject(projectId);
    this.runner.kill(projectId);
    if (!this.gptWaitingProjects.has(projectId) && !this.gptIsActive(projectId)) this.releaseGpt(projectId);
    this.store.deleteProject(projectId);
    this.log("info", projectId, `项目已删除（${st.project_name}）`);
  }

  /** 修改项目的源码文件夹（用户自选） */
  async setSourceDir(projectId, dir) {
    const st = this.store.readState(projectId);
    if (!st) throw new Error(`项目不存在: ${projectId}`);
    const raw = String(dir || "").trim();
    if (!raw || !path.isAbsolute(raw)) throw new Error("项目文件夹必须是绝对路径");
    const p = path.resolve(raw);
    fs.mkdirSync(p, { recursive: true });
    this.store.writeState(projectId, { source_dir: p });
    this.log("info", projectId, `项目文件夹已改为: ${p}`);
    return p;
  }

  /** 显示/隐藏浏览器窗口 */
  async toggleWindow(show) {
    try {
      await this.bridge.ensureBrowser();
      if (this.bridge.page) await this.bridge.setWindowVisible(!!show);
      else {
        await this.bridge.gotoChat();
        await this.bridge.setWindowVisible(!!show);
      }
      return this.bridge.windowVisible;
    } catch (e) {
      throw new Error(`窗口操作失败: ${e.message}`);
    }
  }

  async pause(projectId) {
    const st = this.store.readState(projectId);
    if (!st || ["COMPLETED", "CANCELED", "PAUSED"].includes(st.state)) return st;
    this.invalidateProject(projectId);
    this.runner.kill(projectId);
    const result = this.store.writeState(projectId, {
      state: "PAUSED",
      previous_state: st.state,
      pending: { text: "已暂停（用户操作）。", ts: nowIso(), retryState: st.state },
    });
    if (!this.gptWaitingProjects.has(projectId) && !this.gptIsActive(projectId)) this.releaseGpt(projectId);
    return result;
  }

  async endProject(projectId) {
    const st = this.store.readState(projectId);
    if (!st || ["COMPLETED", "CANCELED"].includes(st.state)) return st;
    this.invalidateProject(projectId);
    this.runner.kill(projectId);
    const result = this.store.transition(projectId, "CANCELED", {
      pending: { text: "项目已由用户手动结束。", ts: nowIso() },
      milestone: { text: "用户手动结束", ts: nowIso() },
    });
    if (!this.gptWaitingProjects.has(projectId) && !this.gptIsActive(projectId)) this.releaseGpt(projectId);
    return result;
  }

  async resume(projectId) {
    const st = this.store.readState(projectId);
    if (!st || st.state !== "PAUSED") return st;
    if (st.pending_model_replan?.status === "paused") {
      this.store.writeState(projectId, { pending_model_replan: { ...st.pending_model_replan, status: "ready" } });
      return this.beginModelReplan(projectId);
    }
    const retry = st.pending?.retryState || st.previous_state || "INIT";
    // 恢复执行者状态：重新分派
    const retry2 = ["EXECUTING", "WAITING_FOR_EXECUTOR", "ANALYZING", "DECISION_REQUIRED"].includes(retry)
      ? (st.pending?.type === "ANALYZE" || st.pending?.type === "DECIDE" ? "PLAN_READY" : "EXECUTING")
      : retry;
    this.store.writeState(projectId, { error_count: 0, pending: { text: "已恢复运行。", ts: nowIso(), retryState: retry2 } });
    return this.store.transition(projectId, retry2);
  }

  async retry(projectId) {
    const st = this.store.readState(projectId);
    if (!st) return null;
    const retry = st.pending?.retryState || st.previous_state || "INIT";
    this.store.writeState(projectId, {
      error_count: 0,
      protocol_reprompts: 0,
      pending: { text: "用户点击重试。", ts: nowIso(), retryState: retry },
    });
    return this.store.transition(projectId, retry);
  }

  async retryTask(projectId) {
    const st = this.store.readState(projectId);
    if (!st) throw new Error(`项目不存在: ${projectId}`);
    if (this.runner.isRunning?.(projectId)) throw new Error("当前任务仍在执行");
    const task = st.current_task || st.plan?.parsed?.tasks?.find((item) => (st.failed_tasks || []).some((failed) => failed.id === item.id));
    if (!task) throw new Error("没有可重试的任务");
    const failed = (st.failed_tasks || []).filter((item) => item.id !== task.id);
    this.store.writeState(projectId, {
      current_task: task,
      failed_tasks: failed,
      error_count: 0,
      current_dispatch_id: null,
      pending: { text: `用户重试任务 ${task.id}。`, ts: nowIso(), retryState: "EXECUTING" },
    });
    this.store.clearOutbox(projectId);
    this.store.transition(projectId, "EXECUTING");
    this.startLoop(projectId);
    return this.store.readState(projectId);
  }

  async restoreCheckpoint(projectId) {
    const st = this.store.readState(projectId);
    if (!st) throw new Error(`项目不存在: ${projectId}`);
    if (this.runner.isRunning?.(projectId)) throw new Error("执行中不能手动恢复检查点");
    const restored = this.store.restoreCheckpoint(projectId);
    this.store.writeState(projectId, { pending: { text: `已恢复任务 ${restored.task_id} 的检查点。`, ts: nowIso(), retryState: st.state } });
    return restored;
  }

  exportAudit(projectId) {
    return this.store.exportAudit(projectId);
  }

  async injectMessage(projectId, text, attachments = []) {
    const st = this.store.readState(projectId);
    if (!st) throw new Error(`项目不存在: ${projectId}`);
    await this.sendToGpt(projectId, "USER", text, { attachments });
    return this.store.transition(projectId, "WAITING_FOR_GPT");
  }
}
