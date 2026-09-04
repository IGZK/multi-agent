import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectStore } from "../controller/store.mjs";
import { Orchestrator, runValidationCommand } from "../controller/orchestrator.mjs";
import { DashboardServer } from "../controller/server.mjs";
import { parsePlan } from "../controller/protocol.mjs";
import { buildScript } from "../controller/folder_picker.mjs";

const silent = { info() {}, warn() {}, error() {} };
const config = { dashboard: { host: "127.0.0.1", port: 0 }, deepseek: { mode: "mock" }, orchestrator: {} };
function fixture(t, runner = { kill() {} }, bridge = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-backend-safety-"));
  const store = new ProjectStore(path.join(root, "projects"), silent);
  const id = store.createProject("测试", "测试任务");
  const orch = new Orchestrator(config, silent, bridge, runner, store);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store, id, orch, source: store.sourceDir(id) };
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function until(predicate) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("等待测试条件超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function envelope(id, task) {
  return { schema_version: 3, project_id: id, task_id: task.id, current_task: task,
    dispatch_id: "test-dispatch", created_at: new Date().toISOString(), type: "EXECUTE_PLAN", timeoutMs: 5000 };
}

test("恢复检查点不能清空重新选择的源码目录", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, "old.txt"), "old");
  await f.store.createCheckpoint(f.id, "TASK-1", "dispatch-1");
  const other = path.join(f.root, "other");
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, "keep.txt"), "keep");
  f.store.writeState(f.id, { source_dir: other });
  assert.throws(() => f.store.restoreCheckpoint(f.id), /不匹配/);
  assert.equal(fs.readFileSync(path.join(other, "keep.txt"), "utf8"), "keep");
});

test("检查点路径必须指向专用子目录，不能清空整个工作区", (t) => {
  const f = fixture(t);
  for (const relative_path of [".", ".gpt_workspace", "checkpoints", "checkpoints/..", "attachments/anything"]) {
    f.store.writeState(f.id, { checkpoint: { relative_path } });
    assert.throws(() => f.store.clearCheckpoint(f.id), /检查点路径无效/);
    assert.ok(f.store.readState(f.id));
  }
});

test("工作区读写与项目删除不能穿越目录联接", (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
  fs.symlinkSync(outside, path.join(f.store.workspaceDir(f.id), "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => f.store.writeWorkspaceFile(f.id, "linked/keep.txt", "overwrite"), /符号链接|目录联接/);
  assert.equal(f.store.readFileSafe(f.id, "linked/keep.txt"), null);
  fs.symlinkSync(outside, path.join(f.store.projectsRoot, "linked-project"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => f.store.deleteProject("linked-project"), /符号链接|目录联接/);
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "keep");
});

test("Windows 路径别名及控制字符不能绕过项目 ID 校验", (t) => {
  const f = fixture(t);
  for (const id of [".", "..", ".. ", "x.", " x", "x\u0000", "x\u0001"]) {
    assert.throws(() => f.store.deleteProject(id), /非法项目 ID/);
  }
  assert.ok(f.store.readState(f.store.createProject("末尾有点...", "任务")));
});

test("非法源码路径的新建请求不留下空项目目录", (t) => {
  const f = fixture(t);
  const before = fs.readdirSync(f.store.projectsRoot);
  assert.throws(() => f.store.createProject("bad", "task", "relative-path"), /绝对路径/);
  assert.deepEqual(fs.readdirSync(f.store.projectsRoot), before);
});

test("已删除或损坏的状态不会被迟到补丁重新创建", (t) => {
  const f = fixture(t);
  f.store.deleteProject(f.id);
  assert.throws(() => f.store.writeState(f.id, { state: "PLAN_READY" }), /不存在或状态损坏/);
  assert.equal(fs.existsSync(f.store.projectDir(f.id)), false);
});

test("对话文件有缺号或单条损坏时不会覆盖或隐藏其它历史", (t) => {
  const f = fixture(t);
  f.store.recordGptMessage(f.id, "in", "first");
  f.store.recordGptMessage(f.id, "in", "second");
  fs.unlinkSync(f.store.resolveWorkspacePath(f.id, "conversation/gpt/0001_in.json"));
  f.store.recordGptMessage(f.id, "in", "third");
  f.store.writeWorkspaceFile(f.id, "conversation/gpt/0004_in.json", "broken");
  assert.deepEqual(f.store.listConversation(f.id).map((item) => item.text), ["second", "third"]);
});

for (const action of ["pause", "endProject", "deleteProject"]) {
  test(`实际验证进程中 ${action} 会停止进程树并拒绝迟到结果`, { timeout: 15000 }, async (t) => {
    const f = fixture(t);
    const marker = path.join(f.source, "started.txt");
    const late = path.join(f.source, "late.txt");
    fs.writeFileSync(path.join(f.source, "validate.cjs"), 'const fs=require("node:fs"); fs.writeFileSync("started.txt","started"); setTimeout(()=>fs.writeFileSync("late.txt","bad"),4000);');
    const task = { id: "TASK-1", validation_command: "node validate.cjs" };
    const env = envelope(f.id, task);
    f.store.writeState(f.id, { state: "WAITING_FOR_EXECUTOR", current_task: task });
    f.store.writeOutboxAtomic(f.id, { ...env, type: "TASK_DONE" });
    const outcome = f.orch.handleExecutorResult(f.id, { exitCode: 0 }, env).catch((error) => error);
    await until(() => fs.existsSync(marker));
    await f.orch[action](f.id);
    assert.equal((await outcome).code, "PROJECT_CANCELLED");
    assert.equal(fs.existsSync(late), false);
    if (action === "deleteProject") assert.equal(fs.existsSync(f.store.projectDir(f.id)), false);
    else {
      assert.equal(f.store.readState(f.id).state, action === "pause" ? "PAUSED" : "CANCELED");
      assert.deepEqual(f.store.readState(f.id).completed_tasks, []);
    }
  });
}

test("验证超时会终止真实进程树并返回超时状态", { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, "timeout.cjs"), "setInterval(()=>{},1000)");
  const result = await runValidationCommand("node timeout.cjs", f.source, 100);
  assert.equal(result.timed_out, true);
  assert.equal(result.ok, false);
  assert.ok(result.duration_ms < 5000);
});

test("执行器在暂停后抛错不得回滚或重新派发", async (t) => {
  const started = deferred(), finished = deferred();
  const f = fixture(t, { kill() {}, async run() { started.resolve(); return finished.promise; } });
  const task = { id: "TASK-1", description: "task" };
  f.store.writeState(f.id, { state: "EXECUTING", current_task: task });
  const outcome = f.orch.dispatchExecutor(f.id, "EXECUTE_PLAN", task, null).catch((error) => error);
  await started.promise;
  fs.writeFileSync(path.join(f.source, "partial.txt"), "keep until resume");
  await f.orch.pause(f.id);
  finished.reject(new Error("runner stopped"));
  assert.equal((await outcome).code, "PROJECT_CANCELLED");
  assert.equal(f.store.readState(f.id).state, "PAUSED");
  assert.equal(fs.readFileSync(path.join(f.source, "partial.txt"), "utf8"), "keep until resume");
});

test("GPT 选择模型期间删除项目不会重新写状态或发送消息", async (t) => {
  const selected = deferred(), started = deferred();
  const bridge = { async ensureBrowser() {}, async newConversation() {}, async selectModel() { started.resolve(); return selected.promise; }, sendMessage() { assert.fail("不得发送"); } };
  const f = fixture(t, { kill() {} }, bridge);
  const outcome = f.orch.sendToGpt(f.id, "USER", "test").catch((error) => error);
  await started.promise;
  await f.orch.deleteProject(f.id);
  selected.resolve({ selected: "test" });
  assert.equal((await outcome).code, "PROJECT_CANCELLED");
  assert.equal(fs.existsSync(f.store.projectDir(f.id)), false);
});

test("排队等待 GPT 的已结束项目不能取得租约", async (t) => {
  const f = fixture(t);
  const other = f.store.createProject("other", "task");
  await f.orch.acquireGpt(other);
  const waiting = f.orch.acquireGpt(f.id).catch((error) => error);
  await f.orch.endProject(f.id);
  f.orch.releaseGpt(other);
  assert.equal((await waiting).code, "PROJECT_CANCELLED");
  assert.equal(f.orch.gptOwner, null);
});

test("修改源码目录先要求暂停，并清除旧检查点和执行会话", async (t) => {
  const f = fixture(t);
  await f.store.createCheckpoint(f.id, "TASK-1", "dispatch-1");
  f.store.writeState(f.id, { state: "EXECUTING", session: { session_id: "old" } });
  const other = path.join(f.root, "other");
  await assert.rejects(f.orch.setSourceDir(f.id, other), /先暂停/);
  assert.equal(fs.existsSync(other), false);
  await f.orch.pause(f.id);
  await f.orch.setSourceDir(f.id, other);
  const state = f.store.readState(f.id);
  assert.equal(state.checkpoint, null);
  assert.equal(state.session, null);
  assert.equal(state.source_dir, other);
});

test("恢复暂停的分析保留原分析步骤，执行等待保留原派发", async (t) => {
  const f = fixture(t);
  for (const state of ["WAITING_FOR_EXECUTOR", "ANALYZING", "DECISION_REQUIRED"]) {
    f.store.writeState(f.id, { state, current_dispatch_id: "keep", pending: { type: state === "ANALYZING" ? "ANALYZE" : state === "DECISION_REQUIRED" ? "DECIDE" : "EXECUTE_PLAN" } });
    await f.orch.pause(f.id);
    await f.orch.resume(f.id);
    assert.equal(f.store.readState(f.id).state, state);
    assert.equal(f.store.readState(f.id).current_dispatch_id, "keep");
  }
});

test("Dashboard 的真实监听端口允许同源请求，非法 JSON 返回 400", async (t) => {
  const server = new DashboardServer(config, silent, { async createProject() { return "test"; } }, {}, {}, {});
  await server.start();
  t.after(() => new Promise((resolve) => server.server.close(resolve)));
  const base = `http://127.0.0.1:${server.server.address().port}`;
  for (const body of ["null", "[]", "broken"] ) {
    const response = await fetch(`${base}/api/projects`, { method: "POST", headers: { Origin: base }, body });
    assert.equal(response.status, 400);
  }
  const response = await fetch(`${base}/api/projects`, { method: "POST", headers: { Origin: base }, body: JSON.stringify({ task: "test" }) });
  assert.equal(response.status, 201);
});

test("文件夹路径中的替换符按字面保留，引用的计划依赖正确解析", () => {
  const folder = "C:\\用户\\$&\\$`\\$'";
  assert.ok(buildScript(folder).includes(folder.replace(/'/g, "''")));
  const plan = parsePlan('tasks:\n- id: TASK-1\n  description: first\n  dependencies: []\n\n- id: TASK-2\n  description: second\n  dependencies: ["TASK-1"]');
  assert.deepEqual(plan.tasks[1].dependencies, ["TASK-1"]);
});

test("GPT 明确选择的下一任务在满足依赖时优先派发", () => {
  const orch = new Orchestrator(config, silent, {}, {}, {});
  const tasks = [{ id: "TASK-1", dependencies: [] }, { id: "TASK-2", dependencies: [] }];
  assert.equal(orch.pickNextTask({ plan: { parsed: { tasks } }, current_task: tasks[1] }).id, "TASK-2");
});

test("活跃与暂停项目的消息持久排队，安全边界才发送且保留途中新增消息", async (t) => {
  const f = fixture(t);
  f.orch.startLoop = () => {};
  const sending = deferred(), sent = deferred();
  let calls = 0;
  f.orch.sendToGpt = async (_id, _type, text) => { calls++; assert.match(text, /第一条/); sending.resolve(); await sent.promise; };
  for (const state of ["GPT_PLANNING", "WAITING_FOR_GPT", "WAITING_FOR_EXECUTOR", "ANALYZING", "PAUSED"]) {
    f.store.writeState(f.id, { state, pending_user_messages: [] });
    const reply = await f.orch.injectMessage(f.id, "第一条");
    assert.deepEqual(reply, { queued: true, paused: state === "PAUSED" });
    assert.equal(await f.orch.flushUserMessages(f.id, f.store.readState(f.id)), false);
    assert.equal(f.store.readState(f.id).pending_user_messages.length, 1);
  }
  assert.equal(calls, 0);
  f.store.writeState(f.id, { state: "PLAN_READY" });
  const flushing = f.orch.flushUserMessages(f.id, f.store.readState(f.id));
  await sending.promise;
  await f.orch.injectMessage(f.id, "第二条");
  sent.resolve();
  assert.equal(await flushing, true);
  assert.equal(calls, 1);
  assert.deepEqual(f.store.readState(f.id).pending_user_messages.map((message) => message.text), ["第二条"]);
  assert.equal(f.store.readState(f.id).state, "WAITING_FOR_GPT");
});

test("只有用户显式追加消息才会重启已完成或已结束项目的对话", async (t) => {
  const f = fixture(t);
  f.orch.startLoop = () => {};
  let calls = 0;
  f.orch.sendToGpt = async () => { f.orch.assertProjectActive(f.id, f.orch.projectEpoch(f.id)); calls++; };
  for (const state of ["COMPLETED", "CANCELED"]) {
    f.store.writeState(f.id, { state });
    assert.equal(await f.orch.flushUserMessages(f.id, f.store.readState(f.id)), false);
    await f.orch.injectMessage(f.id, "补充一个问题");
    const before = f.orch.projectEpoch(f.id);
    assert.equal(await f.orch.flushUserMessages(f.id, f.store.readState(f.id)), true);
    assert.equal(f.orch.projectEpoch(f.id), before + 1);
    assert.equal(f.store.readState(f.id).state, "WAITING_FOR_GPT");
    assert.deepEqual(f.store.readState(f.id).pending_user_messages, []);
  }
  assert.equal(calls, 2);
});

test("无法确认执行器已停止时保留检查点，禁止自动回滚和手动重试", async (t) => {
  const f = fixture(t);
  const task = { id: "TASK-1" };
  f.store.writeState(f.id, { state: "WAITING_FOR_EXECUTOR", current_task: task });
  await f.store.createCheckpoint(f.id, task.id, "test-dispatch");
  fs.writeFileSync(path.join(f.source, "keep.txt"), "keep");
  await f.orch.retryTaskAfterFailure(f.id, envelope(f.id, task), "进程未停止", "RUNNER_STOP_FAILED");
  assert.equal(fs.readFileSync(path.join(f.source, "keep.txt"), "utf8"), "keep");
  assert.ok(f.store.readState(f.id).checkpoint);
  await assert.rejects(f.orch.restoreCheckpoint(f.id), /尚未确认/);
  await assert.rejects(f.orch.retryTask(f.id), /尚未确认/);
});

test("退出冻结不改项目持久状态，并阻止新任务及消息操作", async (t) => {
  const f = fixture(t);
  f.store.writeState(f.id, { state: "WAITING_FOR_EXECUTOR" });
  const before = fs.readFileSync(f.store.resolveWorkspacePath(f.id, "project_state.json"), "utf8");
  f.orch.loops.set(f.id, Promise.resolve());
  const epoch = f.orch.projectEpoch(f.id);
  await f.orch.beginShutdown();
  assert.ok(f.orch.projectEpoch(f.id) > epoch);
  assert.equal(fs.readFileSync(f.store.resolveWorkspacePath(f.id, "project_state.json"), "utf8"), before);
  await assert.rejects(f.orch.injectMessage(f.id, "不会写入"), /正在退出/);
  await assert.rejects(f.orch.createProject("不创建", "任务"), /正在退出/);
});

test("先排队后手动结束会撤销旧消息，不能自动复活已取消项目", async (t) => {
  const f = fixture(t);
  f.orch.startLoop = () => {};
  f.orch.sendToGpt = () => assert.fail("旧队列不得发送");
  f.store.writeState(f.id, { state: "WAITING_FOR_GPT" });
  await f.orch.injectMessage(f.id, "先前排队的消息");
  await f.orch.endProject(f.id);
  assert.deepEqual(f.store.readState(f.id).pending_user_messages, []);
  assert.equal(await f.orch.flushUserMessages(f.id, f.store.readState(f.id)), false);
  assert.equal(f.store.readState(f.id).state, "CANCELED");
});

test("启动时恢复终态后的显式消息队列，空终态项目保持结束", async (t) => {
  const f = fixture(t);
  const ended = f.store.createProject("不启动", "任务");
  f.store.writeState(ended, { state: "CANCELED" });
  f.store.writeState(f.id, { state: "COMPLETED", pending_user_messages: [{ id: "queued", text: "追加" }] });
  const started = [];
  f.orch.startLoop = (id) => started.push(id);
  await f.orch.boot();
  assert.deepEqual(started, [f.id]);
});

test("退出清理失败保留真实停止句柄，重试成功后才清除", async (t) => {
  const f = fixture(t);
  const run = new AbortController();
  run.stopFailed = true;
  run.completion = Promise.reject(Object.assign(new Error("第一次清理失败"), { code: "RUNNER_STOP_FAILED" }));
  run.completion.catch(() => {});
  let attempts = 0;
  run.completion.stop = async () => ++attempts >= 2;
  f.orch.validationRuns.set(f.id, run);
  await assert.rejects(f.orch.beginShutdown(), { code: "RUNNER_STOP_FAILED" });
  assert.equal(f.orch.validationRuns.get(f.id), run);
  await f.orch.beginShutdown();
  assert.equal(attempts, 2);
  assert.equal(f.orch.validationRuns.has(f.id), false);
});

for (const action of ["pause", "endProject"]) {
  test(`${action} 清理失败后再次操作能够重试真实进程停止`, async (t) => {
    const f = fixture(t);
    const run = new AbortController();
    run.stopFailed = true;
    run.completion = Promise.resolve();
    let attempts = 0;
    run.completion.stop = async () => ++attempts >= 2;
    f.orch.validationRuns.set(f.id, run);
    await assert.rejects(f.orch[action](f.id), { code: "RUNNER_STOP_FAILED" });
    assert.equal(f.orch.validationRuns.has(f.id), true);
    if (action === "endProject") f.store.writeState(f.id, { pending_user_messages: [{ id: "new", text: "再次结束前排队" }] });
    await f.orch[action](f.id);
    assert.equal(attempts, 2);
    assert.equal(f.orch.validationRuns.has(f.id), false);
    if (action === "endProject") assert.deepEqual(f.store.readState(f.id).pending_user_messages, []);
  });
}

test("重复结束清理期间新提交的消息在清理成功后重新调度", async (t) => {
  const f = fixture(t);
  const stop = deferred();
  const run = new AbortController();
  run.stopFailed = true;
  run.completion = Promise.resolve();
  run.completion.stop = () => stop.promise;
  f.orch.validationRuns.set(f.id, run);
  f.store.writeState(f.id, { state: "CANCELED", pending_user_messages: [{ id: "old", text: "撤销旧消息" }] });
  let starts = 0;
  f.orch.startLoop = () => { starts++; };
  const ending = f.orch.endProject(f.id);
  await f.orch.injectMessage(f.id, "清理期间的新消息");
  const beforeFinish = starts;
  stop.resolve(true);
  await ending;
  assert.equal(starts, beforeFinish + 1);
  assert.deepEqual(f.store.readState(f.id).pending_user_messages.map((message) => message.text), ["清理期间的新消息"]);
});
