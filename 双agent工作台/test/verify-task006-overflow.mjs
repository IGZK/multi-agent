// TASK-006：多附件时 Composer 不溢出/不遮挡
import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("http://127.0.0.1:3700/", { waitUntil: "load" });
await page.waitForTimeout(2200);
const li = await page.evaluate(() => document.querySelectorAll("#projList li").length);
if (li > 0) { await page.click("#projList li"); await page.waitForTimeout(800); }
// 一次加入 8 个附件
await page.setInputFiles("#fileInput", Array.from({ length: 8 }, (_, i) => ({ name: `file${i}.txt`, mimeType: "text/plain", buffer: Buffer.from("x") })));
await page.waitForTimeout(900);
const r = await page.evaluate(() => {
  const composer = document.querySelector("#composer").getBoundingClientRect();
  const main = document.querySelector(".main").getBoundingClientRect();
  const convo = document.querySelector("#convoView").getBoundingClientRect();
  const input = document.querySelector("#composerInput").getBoundingClientRect();
  return {
    attachCount: document.querySelectorAll(".attach-card").length,
    composerAtMainBottom: Math.abs(composer.bottom - main.bottom) < 2,
    composerAboveConvoBottom: composer.top >= convo.bottom - 1,
    inputVisible: input.height > 0,
    docOverflowX: document.documentElement.scrollWidth > window.innerWidth,
    docOverflowY: document.documentElement.scrollHeight > window.innerHeight,
  };
});
console.log(JSON.stringify({ r, errors }, null, 2));
await browser.close();
