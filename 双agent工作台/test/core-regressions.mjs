import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectStore } from "../controller/store.mjs";
import { mergePlan, slimPlan, validateExecutorOutbox } from "../controller/protocol.mjs";
import { DeepseekRunner } from "../controller/deepseek_runner.mjs";
import { ExecutorRouter } from "../controller/executor_router.mjs";
import { Orchestrator, contextSnapshot, tokenUsageDelta } from "../controller/orchestrator.mjs";
import { DashboardServer } from "../controller/server.mjs";
import { GptBridge } from "../controller/gpt_bridge.mjs";
import { buildDeepseekPlanningGuidance, buildExecutorPrompt, buildExecutorTurnPrompt } from "../controller/prompts.mjs";
import { ensureProfileSkill } from "../controller/workbench_skill.mjs";

const silent = { info() {}, warn() {}, error() {} };

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dual-agent-test-"));
  const store = new ProjectStore(path.join(root, "projects"), silent);
  const ids = [];
  return {
    root,
    store,
    create(name = "测试") { const id = store.createProject(name, "完成测试"); ids.push(id); return id; },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function config() {
  return {
    orchestrator: { stepIntervalMs: 1 },
    gpt: { replyTimeoutMs: 100 },
    deepseek: { mode: "mock", maxRetries: 2 },
  };
}

function executorEnvelope(projectId, task, attempt = 1, dispatchId = `dispatch-${attempt}`) {
  return {
    envelope_version: 3, schema_version: 3, type: "EXECUTE_PLAN", project_id: projectId,
    task_id: task.id, dispatch_id: dispatchId, created_at: new Date().toISOString(), current_task: task, attempt,
  };
}

function executorResult(envelope, type, summary = "完成") {
  return {
    schema_version: 3, type, project_id: envelope.project_id, task_id: envelope.task_id,
    dispatch_id: envelope.dispatch_id, created_at: new Date().toISOString(), summary,
  };
}

test("项目路径不能越过 projects 根目录", () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.projectDir(".."), /非法项目 ID/);
    assert.throws(() => f.store.workspaceDir("a/b"), /非法项目 ID/);
  } finally { f.cleanup(); }
});

test("工作区报告路径兼容 .gpt_workspace 前缀", () => {
  const f = fixture();
  try {
    const id = f.create();
    f.store.writeWorkspaceFile(id, "executor_reports/a.md", "ok");
    assert.equal(f.store.readFileSafe(id, ".gpt_workspace/executor_reports/a.md"), "ok");
  } finally { f.cleanup(); }
});

test("附件真实落盘并可按 ID 取回", () => {
  const f = fixture();
  try {
    const id = f.create();
    const saved = f.store.saveAttachment(id, "说明.txt", "text/plain", Buffer.from("你好"));
    assert.equal(f.store.getAttachments(id, [saved.id])[0].name, "说明.txt");
    assert.equal(fs.readFileSync(f.store.resolveWorkspacePath(id, saved.relative_path), "utf8"), "你好");
  } finally { f.cleanup(); }
});

test("旧项目状态惰性补齐 v2.0 字段且不在读取时改写磁盘", () => {
  const f = fixture();
  try {
    const id = f.create();
    const file = f.store.resolveWorkspacePath(id, "project_state.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.schema = 1;
    delete raw.usage;
    delete raw.session_generations;
    fs.writeFileSync(file, JSON.stringify(raw), "utf8");
    const state = f.store.readState(id);
    assert.equal(state.schema, 3);
    assert.equal(state.usage.deepseek.totals.outputTokens, 0);
    assert.deepEqual(state.session_generations, []);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).schema, 1);
  } finally { f.cleanup(); }
});

test("GPT 网页用量只记录字符和明确估算 token", () => {
  const f = fixture();
  try {
    const id = f.create();
    f.store.recordGptMessage(id, "out", "12345678");
    f.store.recordGptMessage(id, "in", "1234");
    const usage = f.store.readState(id).usage.gpt;
    assert.equal(usage.actual, false);
    assert.equal(usage.estimate, true);
    assert.equal(usage.sentCharacters, 8);
    assert.equal(usage.receivedCharacters, 4);
    assert.equal(usage.estimatedInputTokens, 2);
    assert.equal(usage.estimatedOutputTokens, 1);
  } finally { f.cleanup(); }
});

test("Harness token 投影按任务求差并计算上下文压力", () => {
  assert.deepEqual(tokenUsageDelta(
    { uncachedInputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1 },
    { uncachedInputTokens: 25, outputTokens: 8, cacheReadTokens: 10, cacheWriteTokens: 2 },
  ), { uncachedInputTokens: 15, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 1 });
  assert.deepEqual(contextSnapshot({ projectedTokens: 700, contextWindow: 1000 }), {
    pressureTokens: 700, contextWindow: 1000, percentage: 70,
  });
  assert.equal(contextSnapshot(null), null);
});

test("达到 70% 后只创建一个摘要化新会话", async () => {
  const f = fixture();
  try {
    const id = f.create();
    const task = { id: "TASK-001", description: "完成实现", dependencies: [] };
    f.store.writeState(id, { plan: { raw: "tasks:\n- id: TASK-001", parsed: { tasks: [task] } }, current_task: task });
    let compacted = 0;
    const runner = {
      isRunning: () => false,
      async compactSession() { compacted++; return { sessionId: "session-2", previousSessionId: "session-1", actualModel: { model: "v4", reasoningEffort: "high" } }; },
    };
    const cfg = config();
    cfg.deepseek.contextCompactThreshold = 0.7;
    const orch = new Orchestrator(cfg, silent, {}, runner, f.store);
    orch.recordExecutorUsage(id, {
      sessionId: "session-1", freshSession: true, ms: 10, actualModel: { model: "v4", reasoningEffort: "high" },
      usageBefore: { tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      usageAfter: {
        tokenUsage: { uncachedInputTokens: 500, outputTokens: 50, cacheReadTokens: 100, cacheWriteTokens: 0 },
        contextPressure: { projectedTokens: 700, contextWindow: 1000 },
      },
    }, { type: "EXECUTE_PLAN", current_task: task, attempt: 1 }, true);
    assert.equal(await orch.maybeCompactSession(id), true);
    assert.equal(await orch.maybeCompactSession(id), false);
    const state = f.store.readState(id);
    assert.equal(compacted, 1);
    assert.equal(state.compaction.count, 1);
    assert.equal(state.session_generations.length, 2);
    assert.match(f.store.readFileSafe(id, "executor_context.md"), /已完成任务/);
  } finally { f.cleanup(); }
});

test("投影不可用时同会话完成 20 个任务触发后备压缩", async () => {
  const f = fixture();
  try {
    const id = f.create();
    f.store.writeState(id, { session_generations: [{ generation: 1, session_id: "s1", completed_tasks: 20 }] });
    let compacted = 0;
    const runner = { isRunning: () => false, async compactSession() { compacted++; return { sessionId: "s2" }; } };
    const orch = new Orchestrator(config(), silent, {}, runner, f.store);
    assert.equal(await orch.maybeCompactSession(id), true);
    assert.equal(compacted, 1);
  } finally { f.cleanup(); }
});

test("执行中手动压缩和切换模型都只排队", async () => {
  const f = fixture();
  try {
    const id = f.create();
    const task = { id: "TASK-001", description: "当前任务", dependencies: [] };
    f.store.writeState(id, { state: "WAITING_FOR_EXECUTOR", current_task: task, plan: { parsed: { tasks: [task] } } });
    let compacted = 0;
    const runner = { isRunning: () => true, async compactSession() { compacted++; } };
    const orch = new Orchestrator(config(), silent, {}, runner, f.store);
    assert.equal((await orch.compactSession(id)).queued, true);
    await orch.setProjectDeepseekSelection(id, { provider: "deepseek", model: "v4", reasoningEffort: "high" });
    const state = f.store.readState(id);
    assert.equal(compacted, 0);
    assert.equal(state.compaction.pending, true);
    assert.equal(state.pending_model_replan.status, "waiting_task");
    assert.equal(state.state, "WAITING_FOR_EXECUTOR");
  } finally { f.cleanup(); }
});

test("空闲切换模型立即只重规划未完成任务", async () => {
  const f = fixture();
  try {
    const id = f.create();
    const done = { id: "TASK-001", description: "已完成" };
    const pending = { id: "TASK-002", description: "仍待实现", dependencies: ["TASK-001"] };
    f.store.writeState(id, { state: "PLAN_READY", plan: { parsed: { tasks: [done, pending] } }, completed_tasks: [{ id: done.id }] });
    let prompt = "";
    const orch = new Orchestrator(config(), silent, {}, { isRunning: () => false }, f.store);
    orch.sendToGpt = async (_id, _type, text) => { prompt = text; };
    await orch.setProjectDeepseekSelection(id, { provider: "deepseek", model: "v4", reasoningEffort: "low" });
    assert.match(prompt, /TASK-002/);
    assert.doesNotMatch(prompt, /TASK-001: 已完成/);
    assert.equal(f.store.readState(id).state, "WAITING_FOR_GPT");
    assert.equal(f.store.readState(id).pending_model_replan.status, "awaiting_gpt");
  } finally { f.cleanup(); }
});

test("暂停项目切换模型不会隐式恢复，继续时才重规划", async () => {
  const f = fixture();
  try {
    const id = f.create();
    const task = { id: "TASK-001", description: "待处理", dependencies: [] };
    f.store.writeState(id, { state: "PAUSED", plan: { parsed: { tasks: [task] } } });
    let sends = 0;
    const orch = new Orchestrator(config(), silent, {}, { isRunning: () => false }, f.store);
    orch.sendToGpt = async () => { sends++; };
    await orch.setProjectDeepseekSelection(id, { provider: "deepseek", model: "v4" });
    assert.equal(f.store.readState(id).state, "PAUSED");
    assert.equal(sends, 0);
    await orch.resume(id);
    assert.equal(sends, 1);
    assert.equal(f.store.readState(id).state, "WAITING_FOR_GPT");
  } finally { f.cleanup(); }
});

test("GPT 正在回复时切换 DeepSeek 模型不会并发发送", async () => {
  const f = fixture();
  try {
    const id = f.create();
    const task = { id: "TASK-001", description: "待处理", dependencies: [] };
    f.store.writeState(id, { state: "WAITING_FOR_GPT", plan: { parsed: { tasks: [task] } } });
    let sends = 0;
    const orch = new Orchestrator(config(), silent, {}, { isRunning: () => false }, f.store);
    orch.gptWaitingProjects.add(id);
    orch.sendToGpt = async () => { sends++; };
    await orch.setProjectDeepseekSelection(id, { provider: "deepseek", model: "v4" });
    assert.equal(sends, 0);
    assert.equal(f.store.readState(id).pending_model_replan.status, "waiting_gpt");
  } finally { f.cleanup(); }
});

test("重规划以新任务列表为准，可删除旧任务", () => {
  const result = mergePlan(
    { tasks: [{ id: "TASK-001" }, { id: "TASK-002" }] },
    { tasks: [{ id: "TASK-002", description: "保留" }] },
  );
  assert.deepEqual(result.tasks.map((task) => task.id), ["TASK-002"]);
});

test("执行信封不再重复携带完整任务列表", () => {
  const plan = slimPlan({
    objective: "交付工具",
    acceptance_criteria: ["测试通过"],
    tasks: [{ id: "TASK-001", description: "很长的实现说明", dependencies: [] }],
  });
  assert.equal("tasks" in plan, false);
  assert.equal(plan.objective, "交付工具");
});

test("DeepSeek 档位会改变 GPT 的任务描述策略", () => {
  const strong = buildDeepseekPlanningGuidance({ model: "deepseek-v4-pro", reasoningEffort: "high" });
  const guided = buildDeepseekPlanningGuidance({ model: "deepseek-v4-flash", reasoningEffort: "off" });
  assert.match(strong, /任务可较粗/);
  assert.match(guided, /拆成小而自足/);
  assert.match(guided, /验证命令或检查点/);
});

test("GPT 规划请求会带上项目当前 DeepSeek 档位", async () => {
  const f = fixture();
  try {
    const id = f.create();
    f.store.writeState(id, { deepseek_selection: { model: "deepseek-v4-flash", reasoningEffort: "low" } });
    let sent = "";
    const bridge = {
      page: { url: () => "https://chatgpt.com/c/test" },
      async ensureBrowser() {}, async newConversation() {},
      async detectState() { return { loggedIn: true, challenge: false }; },
      async assistantCount() { return 0; },
      async sendMessage(text) { sent = text; },
    };
    const orch = new Orchestrator(config(), silent, bridge, {}, f.store);
    await orch.sendToGpt(id, "PLAN_REQUEST", "规划这个项目", { intro: true });
    assert.match(sent, /deepseek-v4-flash/);
    assert.match(sent, /拆成小而自足/);
  } finally { f.cleanup(); }
});

test("DeepSeek 首轮加载 Skill，后续轮次只通知信封更新", () => {
  const envelope = { workspace_dir: "C:/work/.gpt_workspace", current_task: { id: "TASK-001", description: "不应重复到提示中" } };
  const first = buildExecutorPrompt(envelope);
  const next = buildExecutorTurnPrompt(envelope);
  assert.match(first, /WORKBENCH_MANAGED_DISPATCH_V1/);
  assert.match(first, /skill 工具加载/);
  assert.doesNotMatch(first + next, /不应重复到提示中/);
  assert.doesNotMatch(next, /outbox.*格式/);
});

test("工作台 Skill 只安装到独立 Harness Profile", () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "dual-agent-skill-test-"));
  try {
    const skillDir = ensureProfileSkill(profile).dir;
    const skill = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    assert.match(skill, /WORKBENCH_MANAGED_DISPATCH_V1/);
    assert.match(skill, /workbench_dispatch: true/);
    assert.match(skill, /user-invocable: false/);
    assert.equal(fs.existsSync(path.join(profile, ".dsh", "skills")), false);
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
});

test("DeepSeek 与命令行执行器共用 v3 结果协议", async () => {
  const f = fixture();
  try {
    const id = f.create();
    const helper = path.join(f.root, "cli-executor.mjs");
    fs.writeFileSync(helper, `import fs from "node:fs"; import path from "node:path"; const envelope=JSON.parse(fs.readFileSync(process.env.WORKBENCH_TASK_FILE,"utf8")); const out=path.join(path.dirname(path.dirname(process.env.WORKBENCH_TASK_FILE)),"outbox","message.json"); const tmp=out+".tmp"; fs.writeFileSync(tmp,JSON.stringify({schema_version:3,type:"TASK_DONE",project_id:envelope.project_id,task_id:envelope.task_id,dispatch_id:envelope.dispatch_id,created_at:new Date().toISOString()})); fs.renameSync(tmp,out);`, "utf8");
    const cfg = { deepseek: { mode: "mock" }, executors: { cli: { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(helper)}`, timeoutMs: 5000 } } };
    const router = new ExecutorRouter(cfg, silent, f.store);
    const dirs = { projectDir: f.store.projectDir(id), workspaceDir: f.store.workspaceDir(id), sourceDir: f.store.sourceDir(id) };
    const task = { id: "TASK-001", description: "协议验证" };
    const deepseekEnvelope = executorEnvelope(id, task, 1, "deepseek-dispatch");
    await router.run(id, dirs, deepseekEnvelope, f.store);
    assert.equal(validateExecutorOutbox(f.store.readOutbox(id), deepseekEnvelope).ok, true);
    f.store.clearOutbox(id);
    f.store.writeState(id, { executor: { type: "cli", capabilities: router.capabilities("cli") } });
    const cliEnvelope = executorEnvelope(id, task, 1, "cli-dispatch");
    const cliResult = await router.run(id, dirs, cliEnvelope, f.store);
    assert.equal(cliResult.exitCode, 0);
    assert.equal(validateExecutorOutbox(f.store.readOutbox(id), cliEnvelope).ok, true);
    assert.equal(router.capabilities("cli").sessionResume, false);
  } finally { f.cleanup(); }
});

test("同一项目复用会话时只打开一次执行窗口", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dual-agent-window-test-"));
  const dirs = {
    projectDir: root,
    workspaceDir: path.join(root, ".gpt_workspace"),
    sourceDir: path.join(root, "source"),
  };
  fs.mkdirSync(path.join(dirs.workspaceDir, "outbox"), { recursive: true });
  fs.mkdirSync(path.join(dirs.workspaceDir, "inbox"), { recursive: true });
  fs.mkdirSync(dirs.sourceDir, { recursive: true });
  let reused = false;
  let opened = 0;
  const outbox = path.join(dirs.workspaceDir, "outbox", "message.json");
  const server = { url: "http://127.0.0.1:1", child: { pid: 1 }, logFile: path.join(root, "ui.log") };
  const runner = Object.assign(Object.create(DeepseekRunner.prototype), {
    cfg: { mode: "real", visible: true, uiOpenWindow: true, executorTimeoutMs: 1000 },
    logger: silent,
    running: new Map(),
    cancelled: new Set(),
    ui: {
      profileName: "test",
      ensureServer: async () => server,
      getOrCreateSession: async () => ({ sessionId: "session-1", reused }),
      submitPrompt: async () => fs.writeFileSync(outbox, "{}"),
      openWindow: () => { opened++; return { opened: true }; },
      isAlive: async () => true,
    },
  });
  const store = { readState: () => ({}), writeState() {} };
  const envelope = { type: "EXECUTE_PLAN", current_task: { id: "TASK-001" }, workspace_dir: dirs.workspaceDir };
  try {
    await runner.runSessionPool("project", dirs, envelope, store, buildExecutorPrompt(envelope));
    fs.rmSync(outbox, { force: true });
    reused = true;
    envelope.current_task = { id: "TASK-002" };
    await runner.runSessionPool("project", dirs, envelope, store, buildExecutorPrompt(envelope));
    assert.equal(opened, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("调度器不会执行依赖未满足的任务", () => {
  const orch = new Orchestrator(config(), silent, {}, {}, {});
  const state = {
    plan: { parsed: { tasks: [{ id: "TASK-002", dependencies: ["TASK-001"] }] } },
    completed_tasks: [], failed_tasks: [],
  };
  assert.equal(orch.pickNextTask(state), null);
});

test("单页 GPT 桥在项目间串行租用", async () => {
  const f = fixture();
  try {
    const a = f.create("甲");
    const b = f.create("乙");
    const orch = new Orchestrator(config(), silent, {}, {}, f.store);
    await orch.acquireGpt(a);
    let bAcquired = false;
    const waiting = orch.acquireGpt(b).then(() => { bAcquired = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bAcquired, false);
    orch.releaseGpt(a);
    await waiting;
    assert.equal(bAcquired, true);
    orch.releaseGpt(b);
  } finally { f.cleanup(); }
});

test("恢复等待状态时会重建浏览器并打开保存的会话", async () => {
  const f = fixture();
  try {
    const id = f.create();
    const opened = [];
    const bridge = {
      page: null,
      async ensureBrowser() {
        this.page = { url: () => opened.at(-1) || "about:blank", async goto(url) { opened.push(url); } };
      },
      async detectState() { return { challenge: false }; },
      async waitForReply() { return { text: "完成", count: 1, ms: 1 }; },
    };
    f.store.writeState(id, { state: "GPT_PLANNING", gpt: { conversation_url: "https://chatgpt.com/c/test", reply_baseline: 0 } });
    const orch = new Orchestrator(config(), silent, bridge, {}, f.store);
    assert.equal(await orch.waitForGpt(id), "完成");
    assert.deepEqual(opened, ["https://chatgpt.com/c/test"]);
  } finally { f.cleanup(); }
});

test("浏览器仍连接但页面已关闭时会重建页面", async () => {
  const page = {
    isClosed: () => false,
    setDefaultTimeout() {},
    on() {},
  };
  const bridge = Object.assign(Object.create(GptBridge.prototype), {
    cfg: { debugPort: 9333 },
    logger: silent,
    page: null,
    browser: {
      isConnected: () => true,
      contexts: () => [{ pages: () => [], newPage: async () => page }],
    },
  });
  await bridge.ensureBrowser();
  assert.equal(bridge.page, page);
});

test("暂停会取消执行且迟到结果不能覆盖 PAUSED", async () => {
  const f = fixture();
  try {
    const id = f.create();
    const runner = new DeepseekRunner({ mode: "mock" }, silent);
    const orch = new Orchestrator(config(), silent, {}, runner, f.store);
    const task = { id: "TASK-001", description: "慢任务", dependencies: [] };
    f.store.writeState(id, { state: "EXECUTING", current_task: task, plan: { parsed: { tasks: [task] } } });
    const running = orch.dispatchExecutor(id, "EXECUTE_PLAN", task, null);
    setTimeout(() => orch.pause(id), 20);
    await running;
    const state = f.store.readState(id);
    assert.equal(state.state, "PAUSED");
    assert.equal(state.completed_tasks.length, 0);
  } finally { f.cleanup(); }
});

test("GPT 发送途中暂停不会被迟到写入覆盖", async () => {
  const f = fixture();
  try {
    const id = f.create();
    let finishSend;
    const bridge = {
      page: { url: () => "https://chatgpt.com/c/test" },
      async ensureBrowser() {}, async newConversation() {},
      async detectState() { return { loggedIn: true, challenge: false }; },
      async assistantCount() { return 0; },
      async sendMessage() { await new Promise((resolve) => { finishSend = resolve; }); },
    };
    const orch = new Orchestrator(config(), silent, bridge, { kill() {} }, f.store);
    const sending = orch.sendToGpt(id, "USER", "测试");
    while (!finishSend) await new Promise((resolve) => setImmediate(resolve));
    await orch.pause(id);
    finishSend();
    await assert.rejects(sending, (error) => error.code === "PROJECT_CANCELLED");
    assert.equal(f.store.readState(id).state, "PAUSED");
    assert.equal(orch.gptOwner, null);
  } finally { f.cleanup(); }
});

test("手动结束项目会取消执行并保留项目记录", async () => {
  const f = fixture();
  try {
    const id = f.create();
    let killed = false;
    const orch = new Orchestrator(config(), silent, {}, { kill() { killed = true; } }, f.store);
    const state = await orch.endProject(id);
    assert.equal(killed, true);
    assert.equal(state.state, "CANCELED");
    assert.equal(f.store.readState(id).milestone.text, "用户手动结束");
  } finally { f.cleanup(); }
});

test("自动重试成功后不会同时留下失败记录", async () => {
  const f = fixture();
  try {
    const id = f.create();
    const task = { id: "TASK-001", description: "可重试", dependencies: [], max_attempts: 2 };
    f.store.writeState(id, { state: "WAITING_FOR_EXECUTOR", current_task: task, plan: { parsed: { tasks: [task] } } });
    const runner = {
      async run(projectId, dirs, envelope, store) {
        store.writeOutboxAtomic(projectId, executorResult(envelope, "TASK_DONE", "重试成功"));
        return { exitCode: 0, timedOut: false, ms: 1 };
      },
    };
    const orch = new Orchestrator(config(), silent, {}, runner, f.store);
    const envelope = executorEnvelope(id, task);
    f.store.createCheckpoint(id, task.id, envelope.dispatch_id);
    f.store.writeOutboxAtomic(id, executorResult(envelope, "TASK_FAILED", "首次失败"));
    await orch.handleExecutorResult(id, { exitCode: 1, timedOut: false, ms: 1 }, envelope);
    const state = f.store.readState(id);
    assert.equal(state.failed_tasks.length, 0);
    assert.deepEqual(state.completed_tasks.map((item) => item.id), [task.id]);
  } finally { f.cleanup(); }
});

test("任务重试耗尽后会把失败交给 GPT 决策", async () => {
  const f = fixture();
  try {
    const id = f.create();
    const task = { id: "TASK-001", description: "最终失败任务", dependencies: [], max_attempts: 2 };
    f.store.writeState(id, { state: "WAITING_FOR_EXECUTOR", current_task: task, plan: { parsed: { tasks: [task] } } });
    let query = "";
    const orch = new Orchestrator(config(), silent, {}, {}, f.store);
    orch.sendToGpt = async (_projectId, type, text) => { assert.equal(type, "QUERY"); query = text; };
    const envelope = executorEnvelope(id, task, 2);
    f.store.createCheckpoint(id, task.id, envelope.dispatch_id);
    f.store.writeOutboxAtomic(id, executorResult(envelope, "TASK_FAILED", "仍然失败"));
    await orch.handleExecutorResult(id, { exitCode: 1, timedOut: false, ms: 1 }, envelope);
    assert.match(query, /最终失败任务/);
    assert.equal(f.store.readState(id).state, "WAITING_FOR_GPT");
  } finally { f.cleanup(); }
});

test("v3 结果拒绝错误派发和重复派发", () => {
  const envelope = executorEnvelope("project", { id: "TASK-001" });
  const good = executorResult(envelope, "TASK_DONE");
  assert.equal(validateExecutorOutbox(good, envelope).ok, true);
  assert.equal(validateExecutorOutbox({ ...good, dispatch_id: "other" }, envelope).code, "OUTBOX_DISPATCH");
  assert.equal(validateExecutorOutbox(good, envelope, [good.dispatch_id]).code, "OUTBOX_DUPLICATE");
});

test("半写 outbox 不会被视为完整结果", () => {
  const f = fixture();
  try {
    const id = f.create();
    f.store.writeWorkspaceFile(id, "outbox/message.json", '{"schema_version":3');
    const status = f.store.readOutboxStatus(id);
    assert.equal(status.exists, true);
    assert.equal(status.complete, false);
    assert.equal(status.data, null);
  } finally { f.cleanup(); }
});

test("任务检查点恢复源码并保留依赖目录", () => {
  const f = fixture();
  try {
    const id = f.create();
    const source = f.store.sourceDir(id);
    fs.writeFileSync(path.join(source, "app.txt"), "before", "utf8");
    fs.mkdirSync(path.join(source, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(source, "node_modules", "keep.txt"), "keep", "utf8");
    f.store.createCheckpoint(id, "TASK-001", "dispatch-1");
    fs.writeFileSync(path.join(source, "app.txt"), "after", "utf8");
    fs.writeFileSync(path.join(source, "extra.txt"), "remove", "utf8");
    f.store.restoreCheckpoint(id);
    assert.equal(fs.readFileSync(path.join(source, "app.txt"), "utf8"), "before");
    assert.equal(fs.existsSync(path.join(source, "extra.txt")), false);
    assert.equal(fs.readFileSync(path.join(source, "node_modules", "keep.txt"), "utf8"), "keep");
  } finally { f.cleanup(); }
});

test("检查点恢复失败会进入 ERROR 且停止重试", async () => {
  const f = fixture();
  try {
    const id = f.create();
    const task = { id: "TASK-001", description: "恢复失败", dependencies: [], max_attempts: 2 };
    const envelope = executorEnvelope(id, task);
    const checkpoint = f.store.createCheckpoint(id, task.id, envelope.dispatch_id);
    fs.rmSync(f.store.resolveWorkspacePath(id, `${checkpoint.relative_path}/source`), { recursive: true, force: true });
    f.store.writeState(id, { current_task: task, plan: { parsed: { tasks: [task] } } });
    const orch = new Orchestrator(config(), silent, {}, {}, f.store);
    await orch.retryTaskAfterFailure(id, envelope, "执行器崩溃");
    assert.equal(f.store.readState(id).state, "ERROR");
    assert.match(f.store.readState(id).last_error, /CHECKPOINT_RESTORE/);
  } finally { f.cleanup(); }
});

test("验证失败按普通失败回滚并重试", async () => {
  const f = fixture();
  try {
    const id = f.create();
    const task = { id: "TASK-001", description: "需要验证", kind: "test", dependencies: [], validation: 'node -e "process.exit(1)"', max_attempts: 2 };
    f.store.writeState(id, { state: "WAITING_FOR_EXECUTOR", current_task: task, plan: { parsed: { tasks: [task] } } });
    let retries = 0;
    const runner = {
      async run(projectId, dirs, nextEnvelope, store) {
        retries++;
        store.writeOutboxAtomic(projectId, executorResult(nextEnvelope, "TASK_DONE"));
        return { exitCode: 0, timedOut: false, ms: 1 };
      },
    };
    const orch = new Orchestrator(config(), silent, {}, runner, f.store);
    orch.sendToGpt = async () => {};
    const envelope = executorEnvelope(id, task);
    f.store.createCheckpoint(id, task.id, envelope.dispatch_id);
    f.store.writeOutboxAtomic(id, executorResult(envelope, "TASK_DONE"));
    await orch.handleExecutorResult(id, { exitCode: 0, timedOut: false, ms: 1 }, envelope);
    const state = f.store.readState(id);
    assert.equal(retries, 1);
    assert.equal(state.state, "WAITING_FOR_GPT");
    assert.equal(state.failed_tasks.at(-1).code, "VALIDATION_FAILED");
    assert.equal(state.validation_results[task.id].ok, false);
  } finally { f.cleanup(); }
});

test("无效的旧源码目录会回退到项目默认 source", () => {
  const f = fixture();
  try {
    const id = f.create();
    f.store.writeState(id, { source_dir: path.join(f.root, "不存在") });
    assert.equal(f.store.sourceDir(id), path.join(f.store.projectsRoot, id, "source"));
  } finally { f.cleanup(); }
});

test("Dashboard 拒绝外部网页发起的写入请求", async () => {
  const server = new DashboardServer({ dashboard: { host: "127.0.0.1", port: 3700 } }, silent, {}, {}, {}, {});
  const req = { method: "POST", url: "/api/projects", headers: { origin: "https://evil.example" } };
  let status = 0;
  let payload = "";
  const res = { writeHead(code) { status = code; }, end(body) { payload = body; } };
  await server.handle(req, res);
  assert.equal(status, 403);
  assert.match(payload, /拒绝/);
});

test("新建项目可由工作目录自动命名并按目录暴露", async () => {
  const f = fixture();
  let created;
  const sourceDir = path.join(f.root, "demo-source");
  const orchestrator = {
    async createProject(name, task, dir) { created = { name, task, dir }; return "demo-source"; },
  };
  const bridge = { async getSystemState() { return {}; } };
  const runner = { status() { return {}; } };
  const server = new DashboardServer({ dashboard: { host: "127.0.0.1", port: 0 } }, silent, orchestrator, f.store, bridge, runner);
  try {
    await server.start();
    const base = `http://127.0.0.1:${server.server.address().port}`;
    const response = await fetch(`${base}/api/projects`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "实现一个目录内工具", source_dir: sourceDir }),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(created, { name: "demo-source", task: "实现一个目录内工具", dir: path.resolve(sourceDir) });
  } finally {
    if (server.server?.listening) await new Promise((resolve) => server.server.close(resolve));
    f.cleanup();
  }
});

test("项目列表暴露源码目录用于侧栏分组", () => {
  const f = fixture();
  try {
    const id = f.store.createProject("目录项目", "测试", path.join(f.root, "src"));
    const item = f.store.listProjects().find((p) => p.id === id);
    assert.equal(item.source_dir, path.resolve(f.root, "src"));
  } finally { f.cleanup(); }
});

test("附件 API 落盘并把真实路径注入消息", async () => {
  const f = fixture();
  const id = f.create();
  let injected = "";
  let injectedAttachments = [];
  const orchestrator = { async injectMessage(projectId, text, attachments) { assert.equal(projectId, id); injected = text; injectedAttachments = attachments; } };
  const bridge = { async getSystemState() { return {}; } };
  const runner = { status() { return {}; } };
  const server = new DashboardServer({ dashboard: { host: "127.0.0.1", port: 0 } }, silent, orchestrator, f.store, bridge, runner);
  try {
    await server.start();
    const base = `http://127.0.0.1:${server.server.address().port}`;
    const upload = await fetch(`${base}/api/projects/${encodeURIComponent(id)}/attachments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "资料.txt", mime: "text/plain", data: Buffer.from("内容").toString("base64") }),
    });
    assert.equal(upload.status, 201);
    const attachmentId = (await upload.json()).attachment.id;
    const message = await fetch(`${base}/api/projects/${encodeURIComponent(id)}/message`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "分析", attachment_ids: [attachmentId] }),
    });
    assert.equal(message.status, 200);
    assert.match(injected, /资料\.txt:/);
    assert.match(injected, /attachments/);
    assert.equal(injectedAttachments.length, 1);
    assert.equal(injectedAttachments[0].name, "资料.txt");
  } finally {
    if (server.server?.listening) await new Promise((resolve) => server.server.close(resolve));
    f.cleanup();
  }
});

test("已结束项目不再显示等待计时", () => {
  const f = fixture();
  try {
    const id = f.create();
    f.store.writeState(id, { state: "CANCELED", pending: { text: "项目已由用户手动结束。", ts: new Date(Date.now() - 60000).toISOString() } });
    const server = new DashboardServer({ dashboard: { host: "127.0.0.1", port: 3700 } }, silent, {}, f.store, {}, {});
    assert.equal(server.projectDetail(id).pending_elapsed_s, null);
  } finally { f.cleanup(); }
});

test("Dashboard 轮询只读取最近 40 条对话和日志末尾 60 行", () => {
  const f = fixture();
  try {
    const id = f.create();
    for (let i = 1; i <= 45; i++) f.store.recordGptMessage(id, "in", `消息 ${i}`);
    const logDir = path.join(f.store.workspaceDir(id), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, "project-test.log"), Array.from({ length: 80 }, (_, i) => `日志 ${i + 1}`).join("\n"));
    const server = new DashboardServer({ dashboard: { host: "127.0.0.1", port: 3700 } }, silent, {}, f.store, {}, {});
    const detail = server.projectDetail(id);
    assert.equal(detail.conversation.length, 40);
    assert.equal(detail.conversation[0].text, "消息 6");
    assert.doesNotMatch(detail.logs_tail, /日志 20(?:\D|$)/);
    assert.match(detail.logs_tail, /日志 80/);
  } finally { f.cleanup(); }
});
