import { testBrowserPath } from "./browser-test-support.mjs";
// 隔离浏览器中的可控 DOM，不连接用户账号；测量桥自身延迟与流式完成保护。
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright-core";
import { GptBridge } from "../controller/gpt_bridge.mjs";

test("GPT 桥：空白页复用、快速发送、稳定收包与流式保护", async (t) => {
  const executablePath = testBrowserPath(t);
  if (!executablePath) return;
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://bridge.test/**", (route) => route.fulfill({ contentType: "text/html", body: `
      <div id="prompt-textarea" contenteditable="true" style="width:600px;height:80px"></div>
      <button data-testid="send-button">发送</button>
      <script>document.querySelector('button').onclick = () => {
        const el = document.createElement('div'); el.dataset.messageAuthorRole = 'user';
        el.textContent = document.querySelector('#prompt-textarea').innerText; el.style.whiteSpace = 'pre-wrap';
        document.body.append(el); document.querySelector('#prompt-textarea').textContent = '';
      };</script>` }));
    await page.goto("https://bridge.test/");
    const bridge = Object.assign(Object.create(GptBridge.prototype), {
      cfg: { replyPollMs: 100, replyStableMs: 500 }, baseUrl: "https://bridge.test/", page,
      ensureBrowser: async () => {}, detectState: async () => ({ loggedIn: true, url: page.url() }),
      live: {}, logger: null,
      gotoChat: async () => { throw new Error("不应重复导航"); },
    });
    const start = performance.now();
    assert.equal(await bridge.newConversation(), "https://bridge.test/");
    await bridge.sendMessage("速度测试\n第二行：你好");
    const sendMs = performance.now() - start;
    assert.ok(sendMs < 1500, `发送不应附加固定秒级等待：${sendMs}ms`);
    assert.equal(await page.locator('[data-message-author-role="user"]').innerText(), "速度测试\n第二行：你好");
    await page.evaluate(() => {
      const el = document.createElement("div"); el.dataset.messageAuthorRole = "assistant";
      el.textContent = "完整回复"; document.body.append(el);
    });
    const reply = await bridge.waitForReply(0, 2000);
    assert.equal(reply.text, "完整回复");
    assert.ok(reply.ms < 1300, `稳定收包耗时 ${reply.ms}ms`);
    t.diagnostic(`空白页复用+发送 ${sendMs.toFixed(0)}ms；已完成回复收包 ${reply.ms}ms`);
    await page.evaluate(() => {
      const stop = document.createElement("button"); stop.dataset.testid = "stop-button"; document.body.append(stop);
      setTimeout(() => {
        document.querySelector('[data-message-author-role="assistant"]').textContent = "最终完整回复";
        stop.remove();
      }, 650);
    });
    const streaming = await bridge.waitForReply(0, 2500);
    assert.equal(streaming.text, "最终完整回复");
    assert.ok(streaming.ms >= 1100, "生成停止前不得提前截断回复");
  } finally { await browser.close(); }
});
