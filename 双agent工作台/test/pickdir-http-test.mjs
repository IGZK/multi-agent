// /api/pickdir 端点集成测试（确定性，不弹真实对话框）
// 运行：node --import ./test/register-pickdir-mock.mjs test/pickdir-http-test.mjs
import { DashboardServer } from "../controller/server.mjs";
import { state } from "./mock-folder-picker.mjs";

// ---------- 最小依赖桩 ----------
const store = {
  listProjects: () => [],
  readState: () => null,
  projectDir: () => "",
  workspaceDir: () => "",
  sourceDir: () => "",
  readFileSafe: () => "",
  listConversation: () => [],
};
const bridge = { getSystemState: async () => ({}), getLive: () => null };
const runner = { status: () => ({}), uiInfo: () => null };
const logger = { info: () => {}, tailText: () => "" };
const orchestrator = {};
const srv = new DashboardServer(
  { dashboard: { host: "127.0.0.1", port: 0 }, gpt: { mode: "mock" }, deepseek: { mode: "mock" } },
  logger, orchestrator, store, bridge, runner
);

// ---------- 模拟 req/res ----------
function mockReq(method, url, rawBody) {
  const listeners = {};
  const req = {
    method, url,
    on(ev, fn) { (listeners[ev] ||= []).push(fn); return req; },
    destroy() {},
    emit(ev, ...args) { (listeners[ev] || []).forEach((f) => f(...args)); },
  };
  queueMicrotask(() => {
    if (rawBody !== undefined) req.emit("data", Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody));
    req.emit("end");
  });
  return req;
}
function mockRes() {
  return {
    statusCode: 0, headers: {}, body: "",
    writeHead(code, h) { this.statusCode = code; Object.assign(this.headers, h); },
    end(s) { this.body += String(s); },
  };
}

let pass = 0, fail = 0;
async function check(name, fn, expect) {
  const res = mockRes();
  await fn(mockReq(expect.method, expect.url, expect.body), res);
  let j = null;
  try { j = JSON.parse(res.body); } catch { /* ignore */ }
  const ok = res.statusCode === expect.status && JSON.stringify(j) === JSON.stringify(expect.json);
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name} → HTTP ${res.statusCode} ${res.body}`);
  if (!ok) { console.log(`      期望: HTTP ${expect.status} ${JSON.stringify(expect.json)}`); fail++; }
  else pass++;
}

await check("成功路径返回选中目录", srv.handle.bind(srv), {
  method: "POST", url: "/api/pickdir",
  body: JSON.stringify({ start_dir: "C:\\Users\\Test" }),
  status: 200, json: { path: "C:\\mock\\picked\\dir", canceled: false },
});
if (state.lastStart !== "C:\\Users\\Test") { console.log("  [FAIL] start_dir 未透传给选择器: " + JSON.stringify(state.lastStart)); fail++; }
else { console.log("  [PASS] start_dir 透传给选择器"); pass++; }

state.path = null;
await check("用户取消返回 canceled", srv.handle.bind(srv), {
  method: "POST", url: "/api/pickdir", body: JSON.stringify({}),
  status: 200, json: { path: null, canceled: true },
});

state.path = "C:\\x";
state.error = "选择器进程崩溃";
await check("选择器异常返回 500 且不崩溃", srv.handle.bind(srv), {
  method: "POST", url: "/api/pickdir", body: JSON.stringify({ start_dir: "" }),
  status: 500, json: { error: "选择器进程崩溃" },
});
state.error = null;

await check("非 JSON 请求体返回 500", srv.handle.bind(srv), {
  method: "POST", url: "/api/pickdir", body: "not-json{{",
  status: 500, json: { error: "JSON 解析失败" },
});

await check("未知路径返回 404", srv.handle.bind(srv), {
  method: "GET", url: "/api/nope",
  status: 404, json: { error: "未知路径: /api/nope" },
});

console.log(`\n/api/pickdir HTTP 层测试: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
