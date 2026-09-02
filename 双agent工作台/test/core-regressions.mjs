import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectStore } from "../controller/store.mjs";
import { mergePlan } from "../controller/protocol.mjs";
import { DeepseekRunner } from "../controller/deepseek_runner.mjs";
import { Orchestrator } from "../controller/orchestrator.mjs";
import { DashboardServer } from "../controller/server.mjs";

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

test("重规划以新任务列表为准，可删除旧任务", () => {
  const result = mergePlan(
    { tasks: [{ id: "TASK-001" }, { id: "TASK-002" }] },
    { tasks: [{ id: "TASK-002", description: "保留" }] },
  );
  assert.deepEqual(result.tasks.map((task) => task.id), ["TASK-002"]);
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

test("自动重试成功后不会同时留下失败记录", async () => {
  const f = fixture();
  try {
    const id = f.create();
    const task = { id: "TASK-001", description: "可重试", dependencies: [] };
    f.store.writeState(id, { state: "WAITING_FOR_EXECUTOR", current_task: task, plan: { parsed: { tasks: [task] } } });
    const runner = {
      async run(projectId, dirs, envelope, store) {
        store.writeWorkspaceFile(projectId, "outbox/message.json", JSON.stringify({ type: "TASK_DONE", task_id: task.id, summary: "重试成功" }));
        return { exitCode: 0, timedOut: false, ms: 1 };
      },
    };
    const orch = new Orchestrator(config(), silent, {}, runner, f.store);
    f.store.writeWorkspaceFile(id, "outbox/message.json", JSON.stringify({ type: "TASK_FAILED", task_id: task.id, summary: "首次失败" }));
    await orch.handleExecutorResult(id, { exitCode: 1, timedOut: false, ms: 1 }, { type: "EXECUTE_PLAN", current_task: task, attempt: 1 });
    const state = f.store.readState(id);
    assert.equal(state.failed_tasks.length, 0);
    assert.deepEqual(state.completed_tasks.map((item) => item.id), [task.id]);
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

test("附件 API 落盘并把真实路径注入消息", async () => {
  const f = fixture();
  const id = f.create();
  let injected = "";
  const orchestrator = { async injectMessage(projectId, text) { assert.equal(projectId, id); injected = text; } };
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
  } finally {
    if (server.server?.listening) await new Promise((resolve) => server.server.close(resolve));
    f.cleanup();
  }
});
