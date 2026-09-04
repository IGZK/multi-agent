import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { UiExecutor } from "../controller/dsh_ui.mjs";

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-group-test-"));
  const projectId = "2026-09-04-分组测试";
  const source = path.join(root, projectId, "source");
  fs.mkdirSync(source, { recursive: true });
  const calls = [], sessions = new Map();
  let workspace = null, failure = null, sequence = 0;
  const host = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { method, payload, rpcId } = JSON.parse(body);
    calls.push({ method, payload });
    let value;
    if (method === failure) {
      res.end(JSON.stringify({ type: "server-response", rpcId, result: { ok: false, error: "test failure" } })); return;
    }
    if (method === "host.describe") value = {};
    if (method === "workspace.create") {
      const created = !workspace;
      workspace ||= { workspaceId: "workspace-test", path: fs.realpathSync(payload.path), title: "source", sessionIds: [] };
      value = { workspace, created };
    }
    if (method === "workspace.rename") { workspace.title = payload.title; value = { workspace }; }
    if (method === "session.list") value = { items: [...sessions.values()] };
    if (method === "session.create") {
      assert.equal(payload.workspaceId, workspace.workspaceId);
      assert.equal(payload.cwd, undefined);
      const sessionId = payload.sessionId || `session-${++sequence}`;
      sessions.set(sessionId, sessions.get(sessionId) || { sessionId, cwd: source, running: false });
      if (!workspace.sessionIds.includes(sessionId)) workspace.sessionIds.push(sessionId);
      value = { sessionId };
    }
    res.end(JSON.stringify({ type: "server-response", rpcId, result: { ok: true, value } }));
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
  const server = { port: host.address().port, sessionId: null };
  const ui = new UiExecutor({}, null);
  ui.servers.set(projectId, server);
  return { ui, server, projectId, source, root, calls, sessions,
    get workspace() { return workspace; }, fail(method) { failure = method; },
    async close() { await new Promise((resolve) => host.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test("新建、复用、压缩后的会话均属于同一官方工作区", async () => {
  const f = await fixture();
  try {
    const first = await f.ui.getOrCreateSession(f.projectId, f.source);
    assert.equal(f.workspace.title, "分组测试");
    const reused = await f.ui.getOrCreateSession(f.projectId, f.source);
    assert.equal(reused.sessionId, first.sessionId);
    assert.equal(reused.reused, true);
    const compacted = await f.ui.replaceSession(f.projectId, f.source);
    assert.equal(compacted.previousSessionId, first.sessionId);
    assert.deepEqual(f.workspace.sessionIds, [first.sessionId, compacted.sessionId]);
    assert.equal(f.sessions.size, 2);
    assert.equal(f.calls.filter((c) => c.method === "session.create").length, 2);
  } finally { await f.close(); }
});

test("旧未分组会话原 ID 补关联，不覆盖已有工作区标题", async () => {
  const f = await fixture();
  try {
    await f.ui.ensureWorkspace(f.server, f.projectId, f.source);
    f.workspace.title = "用户自定义标题";
    f.sessions.set("old", { sessionId: "old", cwd: f.source, history: "keep", running: false });
    f.server.sessionId = "old";
    const result = await f.ui.getOrCreateSession(f.projectId, f.source);
    assert.equal(result.sessionId, "old");
    assert.equal(f.sessions.size, 1);
    assert.equal(f.sessions.get("old").history, "keep");
    assert.deepEqual(f.workspace.sessionIds, ["old"]);
    assert.equal(f.workspace.title, "用户自定义标题");
  } finally { await f.close(); }
});

test("重启接管补关联，但不能把父目录会话归入子项目", async () => {
  const f = await fixture();
  try {
    f.sessions.set("saved", { sessionId: "saved", cwd: f.source, running: true });
    const saved = { service_url: `http://127.0.0.1:${f.server.port}`, session_id: "saved", cwd: f.source };
    assert.equal((await f.ui.adoptSession(f.projectId, saved, f.source)).running, true);
    assert.deepEqual(f.workspace.sessionIds, ["saved"]);
    f.sessions.get("saved").cwd = f.root;
    assert.equal(await f.ui.adoptSession(f.projectId, saved, f.source), null);
  } finally { await f.close(); }
});

test("工作区注册失败明确报错，不能静默创建未分组会话", async () => {
  const f = await fixture();
  try {
    f.fail("workspace.create");
    await assert.rejects(f.ui.getOrCreateSession(f.projectId, f.source), { code: "RUNNER_WORKSPACE" });
    assert.equal(f.calls.some((c) => c.method === "session.create"), false);
  } finally { await f.close(); }
});
