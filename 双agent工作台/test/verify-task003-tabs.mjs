import { testBrowserPath } from "./browser-test-support.mjs";
import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: testBrowserPath(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
await page.goto("http://127.0.0.1:3700/", { waitUntil: "load" });
await page.waitForTimeout(2200);
const li = await page.evaluate(() => document.querySelectorAll("#projList li").length);
if (li > 0) { await page.click("#projList li"); await page.waitForTimeout(800); }
const out = [];
for (const tab of ["chat", "overview", "tasks", "plan", "analysis", "logs", "chat"]) {
  await page.click(`.tab[data-tab="${tab}"]`);
  await page.waitForTimeout(250);
  const r = await page.evaluate(() => {
    const convo = document.querySelector("#convoView");
    const active = document.querySelector(".tab.active")?.dataset.tab;
    return { active, convoVisible: getComputedStyle(convo).display !== "none" };
  });
  out.push({ tab, ...r });
}
console.log(JSON.stringify({ tabs: out, consoleErrors: errors.filter(e => !e.includes("favicon")), allErrors: errors }, null, 2));
await browser.close();
