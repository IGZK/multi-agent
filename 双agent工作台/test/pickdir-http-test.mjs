// /api/pickdir 集成测试：真实 HTTP、替换选择器方法，不弹系统对话框。
import assert from "node:assert/strict";
import test from "node:test";
import { DashboardServer } from "../controller/server.mjs";

test("目录选择 API 覆盖路径透传、取消、进程异常和非法 JSON", async (t) => {
  const server = new DashboardServer({ dashboard: { host: "127.0.0.1", port: 0 } }, { info() {} }, {}, {}, {}, {});
  let picked = "C:\\用户\\测试目录", failed = false, lastStart;
  server.pickFolder = async (start) => {
    lastStart = start;
    if (failed) throw new Error("选择器进程崩溃");
    return picked;
  };
  await server.start();
  t.after(() => new Promise((resolve) => server.server.close(resolve)));
  const base = `http://127.0.0.1:${server.server.address().port}`;
  async function request(body, expectedStatus, expectedBody) {
    const response = await fetch(`${base}/api/pickdir`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body });
    assert.equal(response.status, expectedStatus);
    assert.deepEqual(await response.json(), expectedBody);
  }
  await request(JSON.stringify({ start_dir: " C:\\Users\\Test " }), 200, { path: picked, canceled: false });
  assert.equal(lastStart, "C:\\Users\\Test");
  picked = null;
  await request("{}", 200, { path: null, canceled: true });
  failed = true;
  await request("{}", 500, { error: "选择器进程崩溃" });
  await request("not-json{{", 400, { error: "请求体必须为有效 JSON 对象" });
  await request(" ".repeat(1024 * 1024 + 1), 413, { error: "请求体过大" });
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
});
