import { testBrowserPath } from "./browser-test-support.mjs";
// TASK-003 响应式验证：不同窗口尺寸下布局不错位/遮挡/溢出
import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: testBrowserPath(),
  headless: true,
});
const page = await browser.newPage();
await page.goto("http://127.0.0.1:3700/", { waitUntil: "load" });
await page.waitForTimeout(2200);
const li = await page.evaluate(() => document.querySelectorAll("#projList li").length);
if (li > 0) { await page.click("#projList li"); await page.waitForTimeout(800); }

const sizes = [[1920,1080],[1440,900],[1280,800],[1100,700],[900,700],[700,600]];
const results = [];
for (const [w,h] of sizes) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(350);
  const r = await page.evaluate(() => {
    const sidebar = document.querySelector(".sidebar");
    const main = document.querySelector(".main");
    const composer = document.querySelector("#composer");
    const sb = sidebar.getBoundingClientRect();
    const mb = main.getBoundingClientRect();
    const cb = composer ? composer.getBoundingClientRect() : null;
    return {
      sidebarRight: Math.round(sb.right),
      mainLeft: Math.round(mb.left),
      horizontalOverlap: sb.right > mb.left + 1,
      composerAtMainBottom: cb ? Math.abs(cb.bottom - mb.bottom) < 2 : null,
      composerHeight: cb ? Math.round(cb.height) : null,
      docOverflowX: document.documentElement.scrollWidth > window.innerWidth,
      docOverflowY: document.documentElement.scrollHeight > window.innerHeight,
      convoVisible: getComputedStyle(document.querySelector("#convoView")).display !== "none",
    };
  });
  results.push({ w, h, ...r });
}
console.log(JSON.stringify(results, null, 2));
await browser.close();
