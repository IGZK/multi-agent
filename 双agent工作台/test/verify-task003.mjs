// TASK-003 布局运行验证：加载 Dashboard，选中项目，检查布局与无控制台错误
import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

await page.goto("http://127.0.0.1:3700/", { waitUntil: "load" });
await page.waitForTimeout(2500); // 等 refresh() 填充项目列表

const listCount = await page.evaluate(() => document.querySelectorAll("#projList li").length);
let selected = false;
if (listCount > 0) {
  await page.click("#projList li"); // 选中第一个项目
  await page.waitForTimeout(1200);
  selected = true;
}

const info = await page.evaluate(() => {
  const g = (s) => document.querySelector(s);
  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) }; };
  const composer = g("#composer");
  const main = g(".main");
  const convo = g("#convoView");
  const chatList = g("#chatList");
  const sidebar = g(".sidebar");
  const detail = g("#detail");
  return {
    listCount: document.querySelectorAll("#projList li").length,
    sidebarWidth: sidebar ? sidebar.getBoundingClientRect().width : null,
    mainRect: main ? rect(main) : null,
    detailRect: detail ? rect(detail) : null,
    composerRect: composer ? rect(composer) : null,
    convoVisible: convo ? getComputedStyle(convo).display !== "none" : null,
    chatListVisible: chatList ? getComputedStyle(chatList).display !== "none" : null,
    composerAtMainBottom: composer && main ? Math.abs(composer.getBoundingClientRect().bottom - main.getBoundingClientRect().bottom) < 2 : null,
    composerBelowConvo: composer && convo ? composer.getBoundingClientRect().top >= convo.getBoundingClientRect().bottom - 1 : null,
    pageOverflowY: document.documentElement.scrollHeight > window.innerHeight,
    viewport: window.innerHeight,
  };
});
info.selected = selected;

console.log(JSON.stringify(info, null, 2));
console.log("consoleErrors:", JSON.stringify(errors, null, 2));
await browser.close();
