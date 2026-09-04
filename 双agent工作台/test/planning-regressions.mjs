import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PLANNING_MATRIX, planningPolicy, resolveDeepseekSelection, validatePlanContract } from "../controller/planning_policy.mjs";
import { parsePlan } from "../controller/protocol.mjs";
import { MockGptBridge } from "../controller/gpt_bridge.mjs";
import { Orchestrator } from "../controller/orchestrator.mjs";
import { ProjectStore } from "../controller/store.mjs";
import { DeepseekRunner, RunnerError } from "../controller/deepseek_runner.mjs";

const silent = { info() {}, warn() {}, error() {} };
const task = (patch = {}) => ({
  id: "TASK-001", description: "修正空输入的返回值", kind: "coding", files: ["src/main.js", "test/main.test.js"],
  scope: "仅修改空输入分支，保持非空输入行为和函数签名",
  inputs: ["src/main.js 的 normalize 函数，输入为数组"],
  implementation_notes: "normalize 开头判断 input.length === 0 时返回 []；后续分支保持不变",
  steps: [{ action: "检查 normalize 的参数和空输入分支", expected_result: "确认输入为数组" }, { action: "在空输入分支返回 [] 并添加测试", expected_result: "空输入断言成立" }, { action: "运行测试核对正常与空输入返回值", expected_result: "测试通过" }],
  edge_cases: ["空数组返回 []，非数组保持已有错误处理"],
  verification: [{ action: "输入 [] 调用 normalize", expected_result: "返回 []" }],
  outputs: ["空输入修复及测试"], open_decisions: [], dependencies: [],
  acceptance_check: "空输入返回 []，普通输入保持原结果", failure_handling: "记录失败输出并请求重规划", ...patch,
});
const plan = (tasks = [task()]) => ({ objective: "修复空输入", acceptance_criteria: ["空输入和普通输入测试通过"], tasks });
const autonomousTask = (patch = {}) => ({ id: "TASK-001", description: "修复空输入处理", kind: "coding", scope: "normalize 模块，保持非空输入与公开接口", outputs: ["修复及验证证据"], dependencies: [], acceptance_check: "空输入返回 []，原有测试通过", ...patch });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-planning-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ProjectStore(root, silent);
  const id = store.createProject("规划检查", "修复空输入");
  const orch = new Orchestrator({ orchestrator: { protocolReprompts: 2 }, deepseek: {} }, silent, {}, {}, store);
  const messages = [];
  orch.sendToGpt = async (_id, type, text) => { messages.push({ type, text }); };
  return { id, store, orch, messages };
}

test("模型与档位映射为不同指挥深度，弱档要详细指令，强档可只给目标", () => {
  for (const [family, efforts] of Object.entries(PLANNING_MATRIX)) {
    for (const [effort, mode] of Object.entries(efforts)) {
      const selected = { model: `deepseek-v4-${family}`, reasoningEffort: effort };
      const p = planningPolicy(selected);
      assert.equal(p.key, `${family}/${effort}`);
      assert.equal(p.mode, mode);
      assert.equal(validatePlanContract(plan(), selected).ok, true);
      assert.equal(validatePlanContract(plan([autonomousTask()]), selected).ok, ["delegated", "autonomous"].includes(mode));
    }
  }
  assert.equal(planningPolicy({ model: "future-pro", reasoningEffort: "max" }).key, "conservative");
  assert.equal(planningPolicy({ model: "deepseek-v4-pro" }).mode, "recipe");
  assert.equal(planningPolicy({ model: "deepseek-v4-pro", reasoningEffort: "toString" }).mode, "recipe");
  assert.equal(planningPolicy({ model: "deepseek-v4-flash-vision-exp", reasoningEffort: "low" }).key, "flash/low");
});

test("规划与执行共用逐字段默认值，空项目选项不能覆盖全局模型", () => {
  assert.deepEqual(resolveDeepseekSelection({ reasoningEffort: "off" }, { model: "deepseek-v4-pro", modelProvider: "custom", reasoningEffort: "high" }), {
    provider: "custom", model: "deepseek-v4-pro", reasoningEffort: "off",
  });
});

test("JSON 任务契约无损解析；旧计划仍可读取，但未完成部分必须补齐", () => {
  const source = plan();
  assert.deepEqual(parsePlan(JSON.stringify(source)).tasks, source.tasks);
  assert.deepEqual(parsePlan(source).tasks, source.tasks);
  assert.equal(parsePlan('{"tasks": [}'), null);
  assert.equal(validatePlanContract(parsePlan("status: READY\ntasks:\n- id: TASK-001\n  description: 完成全部功能")).ok, false);
  const mock = new MockGptBridge({}, silent);
  assert.equal(validatePlanContract(parsePlan(mock.buildPlan("测试"))).ok, true);
});

test("弱档拒绝缺少操作预期、方案和边界指导，同时保持 ID/依赖校验", () => {
  for (const patch of [{ steps: [] }, { outputs: [] }, { acceptance_check: "" }, { failure_handling: "" }, { open_decisions: ["自行选择架构"] }, { files: ["src/**"] }, { files: ["src/"] }]) {
    assert.equal(validatePlanContract(plan([task(patch)])).ok, false, JSON.stringify(patch));
  }
  assert.equal(validatePlanContract(plan([task(), task()])).ok, false);
  assert.equal(validatePlanContract(plan([task({ dependencies: ["TASK-999"] })])).ok, false);
  const loop = plan([task({ dependencies: ["TASK-002"] }), task({ id: "TASK-002", dependencies: ["TASK-001"] })]);
  assert.match(validatePlanContract(loop).errors.join("\n"), /循环/);
  assert.equal(validatePlanContract(plan([null, 1, "TASK"])).ok, false);
  assert.equal(validatePlanContract({ tasks: {} }).ok, false);
});

test("不限制总任务数，已完成依赖可不重复列入增量计划", () => {
  const tasks = Array.from({ length: 12 }, (_, i) => task({ id: `TASK-${i + 1}`, dependencies: i ? [`TASK-${i}`] : [] }));
  assert.equal(validatePlanContract(plan(tasks)).ok, true);
  assert.equal(validatePlanContract(plan([task({ id: "TASK-002", dependencies: ["TASK-001"] })]), {}, ["TASK-001"]).ok, true);
});

test("Flash Off 可以收到长而详细的指令，不再因文件、步骤或交付物数量被拒绝", () => {
  const detailed = task({
    files: Array.from({ length: 12 }, (_, i) => `src/fixture-${i}.js`),
    steps: Array.from({ length: 40 }, (_, i) => ({ action: `按指定映射修改第 ${i} 项`, expected_result: `第 ${i} 项与映射一致` })),
    outputs: Array.from({ length: 6 }, (_, i) => `第 ${i} 个可验证输出`),
  });
  assert.equal(validatePlanContract(plan([detailed]), { model: "deepseek-v4-flash", reasoningEffort: "off" }).ok, true);
  assert.equal(validatePlanContract(plan([task({ steps: ["自己分析并完成全部功能"] })]), { model: "deepseek-v4-flash", reasoningEffort: "off" }).ok, false);
});

test("不合格计划不会覆盖有效计划；修正重试有上限且不能用 DONE 绕过", async (t) => {
  const { id, store, orch, messages } = fixture(t);
  orch.savePlan(id, JSON.stringify(plan()));
  const saved = store.readState(id).plan.raw;
  const bad = JSON.stringify(plan([task({ steps: [] })]));
  assert.equal(await orch.acceptPlan(id, bad, {}, "GPT_PLANNING"), false);
  assert.equal(store.readState(id).plan.raw, saved);
  assert.match(messages[0].text, /steps/);
  orch.waitForGpt = async () => "<GPT_RESPONSE><STATUS>DONE</STATUS></GPT_RESPONSE>";
  await orch.stepGptPlanning(id, store.readState(id));
  assert.notEqual(store.readState(id).state, "DONE");
  await orch.acceptPlan(id, bad, {}, "GPT_PLANNING");
  assert.equal(messages.length, 2);
  assert.equal(store.readState(id).state, "ERROR");
  await orch.retry(id);
  assert.equal(store.readState(id).planning_check.repair_attempts, 0);
  assert.equal(await orch.acceptPlan(id, JSON.stringify(plan()), {}, "GPT_PLANNING"), true);
  assert.equal(store.readState(id).planning_check.ok, true);
});

test("旧计划执行前强制补齐，修复后任务契约完整进入信封", async (t) => {
  const { id, store, orch, messages } = fixture(t);
  store.writeState(id, { state: "PLAN_READY", plan: { parsed: plan([{ id: "TASK-001", description: "完成整个系统" }]) } });
  let dispatches = 0;
  orch.dispatchExecutor = async () => { dispatches++; };
  await orch.stepPlanReady(id, store.readState(id));
  assert.equal(dispatches, 0);
  assert.equal(messages.length, 1);
  orch.savePlan(id, JSON.stringify(plan()));
  await orch.stepPlanReady(id, store.readState(id));
  assert.equal(dispatches, 1);
  const st = store.readState(id);
  const envelope = orch.buildEnvelope(id, st, "EXECUTE_PLAN", st.current_task, null, 1);
  assert.deepEqual(envelope.current_task.steps, task().steps);
  assert.deepEqual(envelope.current_task.files, task().files);
});

test("降档后重新检查指导深度，已完成任务不接受改写", async (t) => {
  const { id, store, orch } = fixture(t);
  const high = { model: "deepseek-v4-pro", reasoningEffort: "high" };
  store.writeState(id, { deepseek_selection: high });
  orch.savePlan(id, JSON.stringify(plan([autonomousTask()])));
  store.writeState(id, { deepseek_selection: { ...high, reasoningEffort: "off" } });
  assert.equal(await orch.checkPendingPlan(id, store.readState(id)), false);
  store.writeState(id, { completed_tasks: [{ id: "TASK-001", summary: "完成" }] });
  orch.savePlan(id, JSON.stringify(plan([task({ description: "恶意重写完成项" }), task({ id: "TASK-002", dependencies: ["TASK-001"] })])), { replan: true });
  assert.equal(store.readState(id).plan.parsed.tasks[0].description, autonomousTask().description);
  assert.equal(store.readState(id).completed_tasks.length, 1);
});

test("失败任务接受增量修正后能重新执行，恢复 EXECUTING 不派发旧契约", async (t) => {
  const { id, store, orch } = fixture(t);
  orch.savePlan(id, JSON.stringify(plan()));
  store.writeState(id, { current_task: task(), failed_tasks: [{ id: "TASK-001", summary: "旧方案失败" }] });
  const revised = task({ description: "按明确的新方案修复空输入" });
  orch.savePlan(id, JSON.stringify(plan([revised])), { replan: true });
  assert.deepEqual(store.readState(id).failed_tasks, []);
  let dispatched;
  orch.dispatchExecutor = async (_id, _type, next) => { dispatched = next; };
  await orch.stepExecuting(id, store.readState(id));
  assert.equal(dispatched.description, revised.description);
});

test("计划修正请求期间暂停，迟到发送不能恢复项目", async (t) => {
  const { id, store, orch } = fixture(t);
  store.writeState(id, { state: "GPT_PLANNING" });
  orch.runner = { kill() {} };
  let finish;
  orch.bridge = {
    page: { url: () => "https://chatgpt.com/c/test" },
    async ensureBrowser() {}, async newConversation() {},
    async detectState() { return { loggedIn: true }; },
    async assistantCount() { return 0; },
    async sendMessage() { await new Promise((resolve) => { finish = resolve; }); },
  };
  delete orch.sendToGpt;
  const pending = orch.acceptPlan(id, JSON.stringify(plan([task({ steps: [] })])), {}, "GPT_PLANNING");
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  await orch.pause(id);
  finish();
  await assert.rejects(pending, (error) => error.code === "PROJECT_CANCELLED");
  assert.equal(store.readState(id).state, "PAUSED");
});

test("模型选择/档位校验失败不能绕到 headless 执行", async (t) => {
  const { id, store } = fixture(t);
  const dirs = { projectDir: store.projectDir(id), workspaceDir: store.workspaceDir(id), sourceDir: store.sourceDir(id) };
  const runner = new DeepseekRunner({ mode: "real" }, silent);
  runner.runHeadless = () => assert.fail("不应退回其他执行档位");
  for (const code of ["MODEL_SELECTION", "PLAN_POLICY"]) {
    runner.runSessionPool = async () => { throw new RunnerError(code, "blocked"); };
    await assert.rejects(runner.run(id, dirs, { type: "EXECUTE_PLAN", current_task: task() }, store), (error) => error.code === code);
  }
  runner.cfg.useSessionPool = false;
  store.writeState(id, { deepseek_selection: { model: "deepseek-v4-pro", reasoningEffort: "max" } });
  await assert.rejects(runner.run(id, dirs, { type: "EXECUTE_PLAN", current_task: task() }, store), (error) => error.code === "MODEL_SELECTION");
});

test("真实派发读取到较低档位时，在提交前拒绝指导不足的任务", async (t) => {
  const { id, store } = fixture(t);
  const dirs = { projectDir: store.projectDir(id), workspaceDir: store.workspaceDir(id), sourceDir: store.sourceDir(id) };
  const runner = new DeepseekRunner({ mode: "real" }, silent);
  runner.ui = {
    async ensureServer() { return { url: "http://127.0.0.1:1" }; },
    async getOrCreateSession() { return { sessionId: "test" }; },
    async currentModel() { return { model: "deepseek-v4-flash", reasoningEffort: "off" }; },
    submitPrompt() { assert.fail("指导不足的任务不得提交给模型"); },
  };
  const large = autonomousTask();
  await assert.rejects(runner.runSessionPool(id, dirs, { type: "EXECUTE_PLAN", current_task: large }, store, ""), (error) => error.code === "PLAN_POLICY");
});

test("规范计划能完整走通规划、执行、分析和审查闭环", { timeout: 15000 }, async (t) => {
  const { id, store } = fixture(t);
  const cfg = { gpt: { mockDelayMs: 1 }, deepseek: { mode: "mock" }, orchestrator: { stepIntervalMs: 1 } };
  const runner = new DeepseekRunner(cfg.deepseek, silent);
  const orch = new Orchestrator(cfg, silent, new MockGptBridge(cfg.gpt, silent), runner, store);
  for (let i = 0; i < 30 && store.readState(id).state !== "COMPLETED"; i++) {
    await orch.step(id, store.readState(id));
    assert.notEqual(store.readState(id).state, "ERROR");
  }
  assert.equal(store.readState(id).state, "COMPLETED");
  assert.equal(store.readState(id).completed_tasks.length, 3);
  assert.equal(store.readState(id).planning_check.ok, true);
  assert.equal(store.readState(id).task_reviews.length, 3);
});

test("Flash Off 每项等待 GPT 检查再派发，恢复时不重复发送已提交的检查请求", async (t) => {
  const { id, store, orch, messages } = fixture(t);
  store.writeState(id, { deepseek_selection: { model: "deepseek-v4-flash", reasoningEffort: "off" }, state: "PLAN_READY" });
  orch.runner = new DeepseekRunner({ mode: "mock" }, silent);
  orch.savePlan(id, JSON.stringify(plan([task(), task({ id: "TASK-002", dependencies: ["TASK-001"] })])));
  await orch.stepPlanReady(id, store.readState(id));
  assert.equal(store.readState(id).state, "WAITING_FOR_GPT");
  assert.equal(store.readState(id).completed_tasks.length, 1);
  assert.equal(messages.at(-1).type, "TASK_REVIEW");
  assert.match(messages.at(-1).text, /实际报告/);
  const restarted = new Orchestrator(orch.cfg, silent, {}, orch.runner, store);
  restarted.sendToGpt = () => assert.fail("已发送的检查请求不能重发");
  assert.equal(await restarted.checkPendingPlan(id, store.readState(id)), false);
  assert.equal(store.readState(id).completed_tasks.length, 1);
  orch.waitForGpt = async () => "<GPT_RESPONSE><STATUS>CONTINUE</STATUS><NEXT_TASK>TASK-002</NEXT_TASK></GPT_RESPONSE>";
  await orch.stepWaitingGpt(id, store.readState(id));
  assert.equal(store.readState(id).pending_task_review, null);
  await orch.stepPlanReady(id, store.readState(id));
  assert.equal(store.readState(id).completed_tasks.length, 2);
  assert.equal(messages.filter((message) => message.type === "TASK_REVIEW").length, 2);
});

test("Pro Max 接受简短目标委托并自主连续执行，不插入每项 GPT 检查", async (t) => {
  const { id, store, orch, messages } = fixture(t);
  store.writeState(id, { deepseek_selection: { model: "deepseek-v4-pro", reasoningEffort: "max" } });
  orch.runner = new DeepseekRunner({ mode: "mock" }, silent);
  orch.savePlan(id, JSON.stringify(plan([autonomousTask()])));
  await orch.stepPlanReady(id, store.readState(id));
  assert.equal(store.readState(id).state, "PLAN_READY");
  assert.equal(store.readState(id).completed_tasks.length, 1);
  assert.equal(messages.length, 0);
  assert.equal(store.readState(id).pending_task_review, null);
});

test("详细指挥档首次失败交回 GPT 改指令，携带报告并禁止 CONTINUE 绕过修订", async (t) => {
  const { id, store, orch, messages } = fixture(t);
  const current = task({ max_attempts: 9 });
  orch.savePlan(id, JSON.stringify(plan([current])));
  const envelope = orch.buildEnvelope(id, store.readState(id), "EXECUTE_PLAN", current, null, 1);
  assert.equal(envelope.execution_guidance.gptRepairsFailures, true);
  await store.createCheckpoint(id, current.id, envelope.dispatch_id);
  store.writeWorkspaceFile(id, "executor_reports/failure.md", "normalize(null) 抛出了 TypeError");
  orch.dispatchExecutor = () => assert.fail("不应重发相同指令");
  await orch.retryTaskAfterFailure(id, envelope, "输入前提不成立", "TASK_FAILED", "executor_reports/failure.md");
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /TypeError/);
  assert.match(messages[0].text, /implementation_notes/);
  assert.equal(store.readState(id).planning_check.ok, false);
  orch.waitForGpt = async () => "<GPT_RESPONSE><STATUS>CONTINUE</STATUS></GPT_RESPONSE>";
  await orch.stepWaitingGpt(id, store.readState(id));
  assert.equal(messages.at(-1).type, "REPROMPT");
});

test("强档位失败仍可自主重试", async (t) => {
  const { id, store, orch, messages } = fixture(t);
  store.writeState(id, { deepseek_selection: { model: "deepseek-v4-pro", reasoningEffort: "max" } });
  const current = autonomousTask({ max_attempts: 2 });
  orch.savePlan(id, JSON.stringify(plan([current])));
  const envelope = orch.buildEnvelope(id, store.readState(id), "EXECUTE_PLAN", current, null, 1);
  await store.createCheckpoint(id, current.id, envelope.dispatch_id);
  let retries = 0;
  orch.dispatchExecutor = async (_id, _type, _task, next) => { retries++; assert.equal(next.attempt, 2); };
  await orch.retryTaskAfterFailure(id, envelope, "临时错误");
  assert.equal(retries, 1);
  assert.equal(messages.length, 0);
});

test("逐任务检查不能跳过剩余任务直接 DONE，错误回复有次数上限", async (t) => {
  const { id, store, orch } = fixture(t);
  orch.savePlan(id, JSON.stringify(plan([task(), task({ id: "TASK-002" })])));
  store.writeState(id, { completed_tasks: [{ id: "TASK-001" }], pending_task_review: { task: task(), dispatch_id: "review-1", sent: true, reprompts: 0 } });
  orch.waitForGpt = async () => "<GPT_RESPONSE><STATUS>DONE</STATUS></GPT_RESPONSE>";
  for (let i = 0; i < 3; i++) await orch.stepWaitingGpt(id, store.readState(id));
  assert.equal(store.readState(id).state, "ERROR");
  assert.equal(store.readState(id).completed_tasks.length, 1);
});

test("逐任务检查发送期间暂停，迟到回复不能恢复派发", async (t) => {
  const { id, store, orch } = fixture(t);
  orch.savePlan(id, JSON.stringify(plan()));
  store.writeState(id, { state: "PLAN_READY", completed_tasks: [{ id: "TASK-001" }], pending_task_review: { task: task(), dispatch_id: "review-pause", sent: false, reprompts: 0 } });
  let finish;
  orch.runner = { kill() {} };
  orch.bridge = {
    page: { url: () => "https://chatgpt.com/c/test" },
    async ensureBrowser() {}, async newConversation() {}, async detectState() { return { loggedIn: true }; },
    async assistantCount() { return 0; }, async sendMessage() { await new Promise((resolve) => { finish = resolve; }); },
  };
  delete orch.sendToGpt;
  const pending = orch.sendTaskReview(id);
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  await orch.pause(id);
  finish();
  await assert.rejects(pending, (error) => error.code === "PROJECT_CANCELLED");
  assert.equal(store.readState(id).state, "PAUSED");
  assert.equal(store.readState(id).pending_task_review.sent, false);
});

test("GPT 检查后追加修正任务，保留原执行记录并解除检查等待", async (t) => {
  const { id, store, orch } = fixture(t);
  orch.savePlan(id, JSON.stringify(plan()));
  store.writeState(id, { completed_tasks: [{ id: "TASK-001" }], pending_task_review: { task: task(), dispatch_id: "review-replan", sent: true } });
  const correction = task({ id: "TASK-002", description: "补充空值分支的处理", dependencies: ["TASK-001"] });
  orch.waitForGpt = async () => `<GPT_RESPONSE><STATUS>REPLAN</STATUS><UPDATED_PLAN>${JSON.stringify(plan([correction]))}</UPDATED_PLAN></GPT_RESPONSE>`;
  await orch.stepWaitingGpt(id, store.readState(id));
  assert.equal(store.readState(id).pending_task_review, null);
  assert.equal(store.readState(id).task_reviews[0].outcome, "replanned");
  assert.deepEqual(store.readState(id).completed_tasks.map((item) => item.id), ["TASK-001"]);
  assert.equal(orch.pickNextTask(store.readState(id)).id, "TASK-002");
});

test("升档重规划省略的详细步骤不会从旧计划重新继承", (t) => {
  const { id, store, orch } = fixture(t);
  orch.savePlan(id, JSON.stringify(plan()));
  store.writeState(id, { deepseek_selection: { model: "deepseek-v4-pro", reasoningEffort: "max" } });
  orch.savePlan(id, JSON.stringify(plan([autonomousTask()])), { replan: true });
  const current = store.readState(id).plan.parsed.tasks[0];
  assert.equal(current.steps, undefined);
  assert.equal(current.implementation_notes, undefined);
  assert.equal(current.scope, autonomousTask().scope);
});
