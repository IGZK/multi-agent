// TASK-004 Composer 验证：输入框居中/auto-grow/Enter 发送/Shift+Enter 换行/长文本滚动
import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

// 拦截 /message 发送：捕获请求体但不下发到编排器（避免干扰运行中的任务流）
let sent = null;
await page.route("**/api/projects/*/message", async (route) => {
  const req = route.request();
  if (req.method() === "POST") {
    try { sent = { url: req.url(), body: req.postDataJSON() }; } catch (e) { sent = { url: req.url(), error: e.message }; }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  } else {
    await route.continue();
  }
});

await page.goto("http://127.0.0.1:3700/", { waitUntil: "load" });
await page.waitForTimeout(2200);
const li = await page.evaluate(() => document.querySelectorAll("#projList li").length);
if (li > 0) { await page.click("#projList li"); await page.waitForTimeout(800); }

const results = {};
results.hasComposer = await page.evaluate(() => !!document.querySelector("#composerInput"));

// 居中检测
results.center = await page.evaluate(() => {
  const main = document.querySelector(".main").getBoundingClientRect();
  const input = document.querySelector("#composerInput").getBoundingClientRect();
  const mainCx = main.left + main.width / 2;
  const inputCx = input.left + input.width / 2;
  return { mainCx: Math.round(mainCx), inputCx: Math.round(inputCx), offBy: Math.round(Math.abs(mainCx - inputCx)) };
});

// auto-grow：输入多行
const h1 = await page.evaluate(() => document.querySelector("#composerInput").getBoundingClientRect().height);
await page.fill("#composerInput", "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8");
const h2 = await page.evaluate(() => document.querySelector("#composerInput").getBoundingClientRect().height);
results.autoGrow = { h1: Math.round(h1), h2: Math.round(h2), grew: h2 > h1 };

// 长文本：高度应封顶在 ~180 且可内部滚动
await page.fill("#composerInput", Array(60).fill("这是一行比较长的测试文本，用来验证输入较多内容时的表现。").join("\n"));
const h3 = await page.evaluate(() => {
  const el = document.querySelector("#composerInput");
  return { h: Math.round(el.getBoundingClientRect().height), scrollable: el.scrollHeight > el.clientHeight };
});
results.longInput = h3;

// Shift+Enter 换行（不应触发发送）
await page.fill("#composerInput", "");
await page.press("#composerInput", "Shift+Enter");
const shiftEnterVal = await page.evaluate(() => document.querySelector("#composerInput").value);
results.shiftEnterKeepsText = shiftEnterVal.includes("\n");
results.sentAfterShift = sent; // 应为 null（未发送）

// Enter 发送
sent = null;
await page.fill("#composerInput", "测试消息，确认发送通道");
await page.press("#composerInput", "Enter");
await page.waitForTimeout(500);
results.enterSend = sent;
results.inputClearedAfterSend = await page.evaluate(() => document.querySelector("#composerInput").value === "");
results.sendDisabledAfter = await page.evaluate(() => document.querySelector("#btnComposerSend").disabled);

// 点击发送按钮
sent = null;
await page.fill("#composerInput", "点击按钮发送");
await page.click("#btnComposerSend");
await page.waitForTimeout(500);
results.buttonSend = sent;

console.log(JSON.stringify({ results, consoleErrors: errors }, null, 2));
await browser.close();
