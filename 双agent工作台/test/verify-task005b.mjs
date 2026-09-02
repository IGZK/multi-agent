// TASK-005b：确认保存状态提示与刷新回显（echo stub，模拟后端已持久化）
import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

let lastSel = null;
await page.route("**/api/projects/*/action", async (route) => {
  const req = route.request();
  if (req.method() === "POST") {
    let b = {};
    try { b = req.postDataJSON(); } catch (e) {}
    if (b && b.action === "deepseek_model") lastSel = b.selection;
  }
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
});

// 让 GET /api/projects/:id 返回的 deepseek_selection 反映最近保存，模拟持久化回显
await page.route("**/api/projects/*", async (route) => {
  const req = route.request();
  if (req.method() === "GET") {
    const resp = await route.fetch();
    const json = await resp.json();
    if (lastSel) json.deepseek_selection = lastSel;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
  } else {
    await route.continue();
  }
});

await page.goto("http://127.0.0.1:3700/", { waitUntil: "load" });
await page.waitForTimeout(2200);
const li = await page.evaluate(() => document.querySelectorAll("#projList li").length);
if (li > 0) { await page.click("#projList li"); await page.waitForTimeout(1200); }

await page.selectOption("#cReasoning", "max");
await page.waitForTimeout(400);
const afterMax = await page.evaluate(() => {
  const s = document.querySelector("#composerSaveStatus");
  return { text: s.textContent, show: s.classList.contains("show") };
});
await page.waitForTimeout(800);
const reasoningKept = await page.evaluate(() => document.querySelector("#cReasoning").value);
const afterRefresh = await page.evaluate(() => {
  const s = document.querySelector("#composerSaveStatus");
  return { text: s.textContent, show: s.classList.contains("show") };
});

console.log(JSON.stringify({ afterMax, reasoningKept, afterRefresh, lastSel, consoleErrors: errors }, null, 2));
await browser.close();
