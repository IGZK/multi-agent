import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CliRunner } from "../controller/cli_runner.mjs";
import { DeepseekRunner, createFileWake } from "../controller/deepseek_runner.mjs";
import { GptBridge } from "../controller/gpt_bridge.mjs";
import { UiExecutor, rpc } from "../controller/dsh_ui.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime 安全 "));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const dirs = { projectDir: root, workspaceDir: path.join(root, ".gpt_workspace"), sourceDir: path.join(root, "source") };
  for (const dir of [dirs.sourceDir, ...["inbox", "outbox", "logs"].map((name) => path.join(dirs.workspaceDir, name))]) fs.mkdirSync(dir, { recursive: true });
  return { root, dirs };
}

async function serve(t, handle) {
  const server = http.createServer(handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return server.address().port;
}

test("RPC 使用总超时，持续分片响应不能无限延长等待", async (t) => {
  const port = await serve(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    const tick = setInterval(() => res.write(" "), 10);
    res.on("close", () => clearInterval(tick));
  });
  const started = Date.now();
  await assert.rejects(rpc(port, "slow", {}, 120), /timeout/);
  assert.ok(Date.now() - started < 1200);
});

test("RPC 拒绝中途断开的响应并完整解码跨分片中文", async (t) => {
  const port = await serve(t, (req, res) => {
    if (req.url.endsWith("broken")) { res.write('{"type":'); setImmediate(() => res.destroy()); return; }
    const body = Buffer.from(JSON.stringify({ type: "server-response", result: { ok: true, value: "中文回复" } }));
    const split = body.indexOf(Buffer.from("中文")) + 1;
    res.write(body.subarray(0, split));
    setImmediate(() => res.end(body.subarray(split)));
  });
  await assert.rejects(rpc(port, "broken", {}, 1000));
  assert.equal(await rpc(port, "unicode", {}, 1000), "中文回复");
});

for (const phase of ["ensureServer", "getOrCreateSession", "currentModel"]) {
  test(`在 ${phase} 等待时暂停，不提交任务也不回退到新进程`, async (t) => {
    const { dirs } = fixture(t);
    const runner = new DeepseekRunner({ mode: "real", visible: false }, null);
    let entered;
    let release;
    const reached = new Promise((resolve) => { entered = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    const responses = { ensureServer: { url: "test" }, getOrCreateSession: { sessionId: "test", reused: false }, currentModel: null };
    runner.ui = {
      ...Object.fromEntries(Object.entries(responses).map(([name, value]) => [name, async () => {
        if (name === phase) { entered(); await held; }
        return value;
      }])),
      sessionProjection: async () => null,
      submitPrompt: () => assert.fail("暂停后不得提交"),
      disposeServer: async () => {},
    };
    runner.runHeadless = () => assert.fail("暂停后不得回退到新进程");
    const pending = runner.run("test", dirs, { type: "ANALYZE" });
    await reached;
    await runner.kill("test");
    release();
    await assert.rejects(pending, { code: "PROJECT_CANCELLED" });
  });
}

test("服务启动探测期间释放项目，不会返回已移除的旧服务", async () => {
  const ui = new UiExecutor({}, null);
  let release;
  let entered;
  const reached = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  ui.servers.set("test", { child: null, url: "test" });
  ui.isAlive = async () => { entered(); await held; return true; };
  const pending = ui.ensureServer("test", "unused");
  await reached;
  await ui.disposeServer("test");
  release();
  assert.equal(await pending, null);
  assert.equal(ui.servers.size, 0);
});

test("无法停止进程或接管会话时明确失败并保留句柄供重试", async () => {
  // The helper refuses its own PID; no actual test process is terminated.
  const child = { pid: process.pid, exitCode: null, signalCode: null };
  const cli = new CliRunner();
  cli.running.set("test", { child });
  await assert.rejects(cli.kill("test"), { code: "RUNNER_STOP_FAILED" });
  assert.equal(cli.isRunning("test"), true);

  const ui = new UiExecutor({}, null);
  const service = { child, url: "test" };
  ui.servers.set("test", service);
  await assert.rejects(ui.disposeServer("test"), { code: "RUNNER_STOP_FAILED" });
  assert.equal(ui.servers.get("test"), service);

  const runner = new DeepseekRunner({ mode: "real" }, null);
  runner.running.set("test", { sessionId: "adopted" });
  runner.ui = { cancelSession: async () => false, disposeServer: () => assert.fail("取消未确认，保留接管记录") };
  await assert.rejects(runner.kill("test"), { code: "RUNNER_STOP_FAILED" });
  assert.equal(runner.isRunning("test"), true);
  assert.equal(runner.cancelled.has("test"), true);
});

test("关闭文件监听会释放正在等待的调用", async (t) => {
  const { root } = fixture(t);
  const wake = createFileWake(root, "message.json");
  const pending = wake.wait(60000);
  wake.close();
  await pending;
});

for (const action of ["cancel", "timeout"]) {
  test(`CLI ${action} 会等待整个进程树停止且结果保留终止原因`, { timeout: 10000 }, async (t) => {
    const { root, dirs } = fixture(t);
    const marker = path.join(root, "late.txt");
    const ready = path.join(root, "ready.txt");
    const script = path.join(root, "executor.cjs");
    const childCode = `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 1500); setInterval(() => {}, 1000);`;
    fs.writeFileSync(script, `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});setInterval(()=>{},1000);`);
    const runner = new CliRunner({ command: `"${process.execPath}" "${script}"`, timeoutMs: action === "timeout" ? 500 : 5000 });
    t.after(() => runner.shutdownAll());
    const pending = runner.run("test", dirs, { type: "ANALYZE", dispatch_id: "test" });
    if (action === "cancel") {
      for (let i = 0; i < 200 && !fs.existsSync(ready); i++) await sleep(10);
      assert.ok(fs.existsSync(ready));
      await runner.kill("test");
    }
    const result = await pending;
    assert.equal(result.cancelled, action === "cancel");
    assert.equal(result.timedOut, action === "timeout");
    assert.equal(runner.isRunning("test"), false);
    await sleep(1700);
    assert.equal(fs.existsSync(marker), false, "停止返回后不能有子进程继续写文件");
  });
}

test("浏览器重连失败暂时没有页面时继续等待，不抛空页面 TypeError", async () => {
  const bridge = Object.assign(Object.create(GptBridge.prototype), {
    cfg: { replyPollMs: 100 }, page: null, live: {},
    ensureBrowser: async () => { throw new Error("离线"); },
  });
  await assert.rejects(bridge.waitForReply(0, 150), { code: "GPT_TIMEOUT" });
});

test("首次 ask 先连接页面再记录已有回复，防止把历史回复当成本轮答案", async () => {
  let ready = false;
  const bridge = Object.assign(Object.create(GptBridge.prototype), {
    ensureBrowser: async () => { ready = true; },
    assistantCount: async () => ready ? 5 : -1,
    sendMessage: async () => {},
    waitForReply: async (before) => { assert.equal(before, 5); return { text: "new" }; },
  });
  assert.equal((await bridge.ask("test")).replyText, "new");
});
