import { testBrowserPath } from "./browser-test-support.mjs";
// TASK-005 验证：模型/推理下拉位于输入框右侧；目录填充；change 即持久化(deepseek_model)
import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: testBrowserPath(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

const saves = [];
await page.route("**/api/projects/*/action", async (route) => {
  const req = route.request();
  if (req.method() === "POST") {
    let b = {};
    try { b = req.postDataJSON(); } catch (e) {}
    if (b && b.action === "deepseek_model") saves.push(b);
  }
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
});

await page.goto("http://127.0.0.1:3700/", { waitUntil: "load" });
await page.waitForTimeout(2200);
const li = await page.evaluate(() => document.querySelectorAll("#projList li").length);
if (li > 0) { await page.click("#projList li"); await page.waitForTimeout(1200); }

const results = {};
results.hasSelects = await page.evaluate(() => {
  const m = document.querySelector("#cModel");
  const r = document.querySelector("#cReasoning");
  return { model: !!m, reasoning: !!r };
});
results.catalogOptions = await page.evaluate(() => {
  const m = document.querySelector("#cModel");
  return { modelOptions: m ? m.options.length : 0, sample: m && m.options.length ? Array.from(m.options).map(o => o.value).slice(0, 5) : [] };
});
results.opsToRightOfInput = await page.evaluate(() => {
  const input = document.querySelector("#composerInput").getBoundingClientRect();
  const ops = document.querySelector(".composer-ops").getBoundingClientRect();
  const slot = document.querySelector("#composerModelSlot").getBoundingClientRect();
  return { inputRight: Math.round(input.right), opsLeft: Math.round(ops.left), slotLeft: Math.round(slot.left), opsRightOfInput: slot.left >= input.right - 1 };
});

// 变更推理等级 → 触发保存
await page.selectOption("#cReasoning", "high");
await page.waitForTimeout(600);
results.afterReasoningChange = { saves: JSON.parse(JSON.stringify(saves)), saveStatus: await page.evaluate(() => document.querySelector("#composerSaveStatus").textContent) };

// 变更模型 → 触发保存
await page.selectOption("#cModel", { index: 1 }); // 首个非默认模型
await page.waitForTimeout(600);
results.afterModelChange = JSON.parse(JSON.stringify(saves));

// disabled 样式存在性
results.hasDisabledStyle = await page.evaluate(() => {
  const s = document.querySelector("#cModel");
  return !!getComputedStyle(s).disabled; // 属性不可用，改查样式规则存在
});
results.reasoningValue = await page.evaluate(() => document.querySelector("#cReasoning").value);

console.log(JSON.stringify({ results, consoleErrors: errors }, null, 2));
await browser.close();
