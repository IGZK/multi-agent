import { testBrowserPath } from "./browser-test-support.mjs";
import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: testBrowserPath(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const logs = [];
page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
let saves = 0;
await page.route("**/api/projects/*/action", (route) => { saves++; return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }); });
await page.goto("http://127.0.0.1:3700/", { waitUntil: "load" });
await page.waitForTimeout(2200);
const li = await page.evaluate(() => document.querySelectorAll("#projList li").length);
if (li > 0) { await page.click("#projList li"); await page.waitForTimeout(1000); }

// 通过真实 change 事件触发
await page.selectOption("#cReasoning", "max");
await page.waitForTimeout(250);
const t1 = await page.evaluate(() => document.querySelector("#composerSaveStatus").textContent);
await page.waitForTimeout(300);
const t2 = await page.evaluate(() => document.querySelector("#composerSaveStatus").textContent);
const t3 = await page.evaluate(() => document.querySelector("#composerSaveStatus").classList.contains("show"));
console.log(JSON.stringify({ saves, t1, t2, t3, logs }, null, 2));
await browser.close();
