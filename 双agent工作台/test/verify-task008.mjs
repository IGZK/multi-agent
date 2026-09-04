import { testBrowserPath } from "./browser-test-support.mjs";
// TASK-008 视觉统一验证：深浅主题切换、令牌生效、无 JS 错误
import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: testBrowserPath(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
await page.goto("http://127.0.0.1:3700/", { waitUntil: "load" });
await page.waitForTimeout(2200);

const R = {};
R.defaultTheme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
R.themeBtnLabel = await page.evaluate(() => document.querySelector("#btnTheme").textContent);
R.darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

// 切到浅色
await page.click("#btnTheme");
await page.waitForTimeout(200);
R.lightTheme = await page.evaluate(() => ({
  attr: document.documentElement.getAttribute("data-theme"),
  btn: document.querySelector("#btnTheme").textContent,
  bg: getComputedStyle(document.body).backgroundColor,
}));
R.lightAccent = await page.evaluate(() => {
  const b = document.querySelector(".btn.primary");
  return getComputedStyle(b).backgroundColor;
});

// 持久化
const stored = await page.evaluate(() => localStorage.getItem("wb-theme"));
R.storedLight = stored;

// 切回深色
await page.click("#btnTheme");
await page.waitForTimeout(200);
R.backToDark = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));

// 令牌生效检查（深色下）：圆角变量、focus-ring、scrollbar 规则存在
R.tokenCss = await page.evaluate(() => {
  const cs = getComputedStyle(document.querySelector(".btn"));
  const inp = getComputedStyle(document.querySelector("#composerInput"));
  return { btnRadius: cs.borderRadius, composerRadius: inp.borderRadius };
});

// 深浅色下 body 背景不同
R.darkBgAfter = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

console.log(JSON.stringify({ R, consoleErrors: errors }, null, 2));
await browser.close();
