import { testBrowserPath } from "./browser-test-support.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const sourceArg = process.argv[2] || process.env.SNAKE_SOURCE_DIR;
if (!sourceArg) {
  console.error("用法：node test/snake-browser-smoke.mjs <贪吃蛇项目源码目录>（或设置 SNAKE_SOURCE_DIR）");
  process.exit(1);
}
const source = path.resolve(sourceArg);
const browser = await chromium.launch({ executablePath: testBrowserPath(), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 850 } });
  const errors = [];
  const network = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => { if (/^https?:/.test(r.url())) network.push(r.url()); });
  // 仅在测试页面包装逻辑入口，观察真实键盘/按钮驱动的状态，不修改产物。
  await page.addInitScript(() => {
    let api;
    Object.defineProperty(window, "SnakeGame", {
      get: () => api,
      set(value) {
        api = value;
        for (const name of ["step", "turn"]) {
          const original = api[name];
          api[name] = function (state, ...args) {
            const result = original.call(this, state, ...args);
            window.__snake = JSON.parse(JSON.stringify(state));
            return result;
          };
        }
      },
    });
  });
  const start = performance.now();
  await page.goto(pathToFileURL(path.join(source, "index.html")).href);
  assert.equal(await page.locator("#status").innerText(), "待开始");
  const loadMs = Math.round(performance.now() - start);
  await page.click("#btn-start");
  await page.waitForFunction(() => window.__snake?.status === "running");
  await page.click("#btn-pause");
  assert.equal(await page.locator("#status").innerText(), "已暂停");
  const still = await page.locator("#board").evaluate((canvas) => canvas.toDataURL());
  await page.waitForTimeout(400);
  assert.equal(await page.locator("#board").evaluate((canvas) => canvas.toDataURL()), still);
  await page.click("#btn-resume");
  assert.equal(await page.locator("#status").innerText(), "进行中");
  await page.keyboard.press("ArrowUp");
  await page.waitForFunction(() => window.__snake?.direction?.y === -1);
  await page.keyboard.press("a");
  await page.waitForFunction(() => window.__snake?.direction?.x === -1);
  await page.keyboard.press("d");
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.__snake.direction.x), -1, "拒绝反向转弯");
  await page.click("#btn-restart");
  assert.equal(await page.locator("#score").innerText(), "0");
  await page.waitForFunction(() => document.querySelector("#status").textContent === "游戏结束", null, { timeout: 6000 });
  assert.equal(errors.length, 0, errors.join("\n"));
  assert.equal(network.length, 0, "直接打开不请求外部网络资源");
  await page.click("#btn-restart");
  await page.click("#btn-pause");
  await page.screenshot({ path: path.resolve("test/snake-speed.png"), fullPage: true });
  console.log(JSON.stringify({ pass: true, loadMs, checks: ["file:// 直接打开", "开始", "暂停画面静止", "继续", "方向键", "WASD", "禁止反向", "重置得分", "撞墙结束", "无脚本错误", "无外网依赖"] }));
} finally { await browser.close(); }
