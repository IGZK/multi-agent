import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GptBridge } from "../controller/gpt_bridge.mjs";
import { testBrowserPath } from "./browser-test-support.mjs";

test("启动不恢复历史窗口、不创建空白首页；失败重试不重复启动", async () => {
  const bridge = Object.assign(Object.create(GptBridge.prototype), {
    cfg: { debugPort: 9333 }, profileDir: "C:/isolated-profile", baseUrl: "https://chatgpt.com/",
  });
  const args = bridge.chromeArgs();
  assert.ok(args.includes("--no-startup-window"));
  assert.ok(!args.some((arg) => arg.startsWith("--restore-last-session")));
  assert.ok(!args.includes("about:blank"));
  let launches = 0;
  bridge.launchChromeOnce = async () => { launches++; await new Promise((resolve) => setImmediate(resolve)); return true; };
  await Promise.all(Array.from({ length: 12 }, () => bridge.launchChrome()));
  assert.equal(launches, 1);
  delete bridge.launchChromeOnce;
  bridge.isDebugPortUp = async () => false;
  bridge.lastLaunchAt = Date.now();
  await assert.rejects(bridge.launchChrome(), /停止重复唤起/);
});

test("空白页导航失败会关闭新页；已有非空白页不受影响", async () => {
  let closed = 0;
  const other = { isClosed: () => false, url: () => "https://unrelated.test/" };
  const blank = { url: () => "about:blank", goto: async () => { throw new Error("offline"); }, close: async () => { closed++; } };
  const bridge = Object.assign(Object.create(GptBridge.prototype), {
    cfg: {}, baseUrl: "https://chatgpt.com/", browser: {
      close: async () => {},
      isConnected: () => true, contexts: () => [{ pages: () => [other], newPage: async () => blank }],
    },
  });
  await assert.rejects(bridge.ensureBrowser(), /offline/);
  assert.equal(closed, 1);
  assert.equal(bridge.page, null);
});

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

test("隔离真实 Chrome：并发唤起、重连、关闭后重建均只保留一个工作页", { timeout: 60000 }, async (t) => {
  if (!testBrowserPath(t)) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-browser-"));
  const server = http.createServer((_req, res) => res.end('<html><body><div id="prompt-textarea" contenteditable="true"></div></body></html>'));
  const webPort = await listen(server);
  const reservation = http.createServer();
  const debugPort = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const bridge = new GptBridge({ debugPort, profileDir: "profile", baseUrl: `http://127.0.0.1:${webPort}/` }, null, root);
  const originalArgs = bridge.chromeArgs.bind(bridge);
  bridge.chromeArgs = () => [...originalArgs(), "--headless=new"];
  let browser;
  try {
    await Promise.all(Array.from({ length: 12 }, () => bridge.ensureBrowser()));
    browser = bridge.browser;
    const ctx = browser.contexts()[0];
    const keep = bridge.page;
    assert.equal(ctx.pages().length, 1);
    assert.equal(keep.url(), bridge.baseUrl);
    await ctx.newPage();
    await ctx.newPage();
    const populatedBlank = await ctx.newPage();
    await populatedBlank.setContent("<p>未提交的内容</p>");
    const other = await ctx.newPage();
    await other.goto("data:text/html,other");
    bridge.page = null;
    await Promise.all(Array.from({ length: 10 }, () => bridge.ensureBrowser()));
    assert.equal(bridge.page, keep);
    assert.equal(ctx.pages().length, 3, "清理空白页，保留有内容的 about:blank 及其他网站");
    assert.equal(populatedBlank.isClosed(), false);
    await keep.close();
    await bridge.ensureBrowser();
    assert.equal(ctx.pages().length, 3);
    assert.equal(bridge.page.url(), bridge.baseUrl);
    assert.equal(other.isClosed(), false);
    assert.equal(await populatedBlank.textContent("body"), "未提交的内容", "重建工作页不占用有内容的 about:blank");
    await populatedBlank.close();
    const pid = bridge.chromeProcess?.pid;
    await bridge.dispose();
    await bridge.ensureBrowser();
    browser = bridge.browser;
    assert.equal(bridge.chromeProcess?.pid, pid, "CDP 断线重连不能重新启动 Chrome");
    assert.equal(browser.contexts()[0].pages().length, 2);
  } finally {
    try { const cdp = await (browser || bridge.browser)?.newBrowserCDPSession(); await cdp?.send("Browser.close"); } catch { /* already closed */ }
    bridge.chromeProcess?.kill();
    await bridge.dispose();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
