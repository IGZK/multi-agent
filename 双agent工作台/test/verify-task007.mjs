// TASK-007 文件夹选择 UI 验证：当前项目展示、切换、空路径占位、长路径省略、选择逻辑不破坏
import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
let setdirBody = null;
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
await page.route("**/api/projects/*/action", async (route) => {
  const req = route.request();
  if (req.method() === "POST") {
    let b = {}; try { b = req.postDataJSON(); } catch (e) {}
    if (b && b.action === "setdir") setdirBody = b;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  } else await route.continue();
});
// 长路径注入：拦截 GET /:id 把 source_dir 改成超长路径，模拟长路径
await page.route("**/api/projects/*", async (route) => {
  const req = route.request();
  if (req.method() === "GET") {
    const resp = await route.fetch();
    const json = await resp.json();
    json.source_dir = "C:/very/long/path/to/project/folder/with/many/segments/that/exceeds/the/sidebar/width/和中文/还有一些更长的路径段用来测试省略展示效果/0123456789/abcdefghijklmnopqrstuvwxyz";
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
  } else await route.continue();
});

await page.goto("http://127.0.0.1:3700/", { waitUntil: "load" });
await page.waitForTimeout(2200);

const R = {};
R.noProjectState = await page.evaluate(() => {
  const box = document.querySelector("#currentProjBox");
  return { hidden: box.classList.contains("hidden"), display: getComputedStyle(box).display };
});

const li = await page.evaluate(() => document.querySelectorAll("#projList li").length);
if (li > 0) { await page.click("#projList li"); await page.waitForTimeout(900); }

R.afterSelect = await page.evaluate(() => {
  const box = document.querySelector("#currentProjBox");
  const dir = document.querySelector("#dirHint");
  const rect = dir.getBoundingClientRect();
  const isOverflowing = dir.scrollWidth > dir.clientWidth;
  return {
    boxShown: !box.classList.contains("hidden"),
    name: document.querySelector("#curpName").textContent,
    dirText: dir.textContent,
    title: dir.title,
    ellipsized: isOverflowing && getComputedStyle(dir).textOverflow === "ellipsis",
    clipWiderThanView: rect.width <= document.querySelector(".sidebar").getBoundingClientRect().width,
    hasFolderTitle: !!document.querySelector(".curp-folder-title"),
  };
});

// 空路径占位：构造一个 source_dir 为空的 GET 响应
await page.route("**/api/projects/*", async (route) => {
  const req = route.request();
  if (req.method() === "GET") {
    const resp = await route.fetch();
    const json = await resp.json();
    json.source_dir = "";
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
  } else await route.continue();
});
await page.click("#projList li"); // 重新选择触发刷新
await page.waitForTimeout(900);
R.emptyPath = await page.evaluate(() => {
  const dir = document.querySelector("#dirHint");
  return { text: dir.textContent, empty: dir.classList.contains("empty"), dataPath: dir.dataset.path, title: dir.title };
});

// 切换项目（选另一个）——验证 curpName 更新
R.switch = await page.evaluate(async () => {
  const items = document.querySelectorAll("#projList li");
  if (items.length > 1) { items[1].click(); }
  return { listCount: items.length };
});

console.log(JSON.stringify({ R, setdirBody, consoleErrors: errors }, null, 2));
await browser.close();
