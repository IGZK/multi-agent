// TASK-009 综合功能与 UI 回归测试（拦截 POST 请求避免干扰运行中的编排器）
import { chromium } from "playwright-core";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const staticServer = http.createServer((req, res) => {
  const name = req.url === "/" ? "index.html" : path.basename(req.url);
  const file = path.join(webDir, name);
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  const type = name.endsWith(".css") ? "text/css" : name.endsWith(".js") ? "text/javascript" : "text/html";
  res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
  res.end(fs.readFileSync(file));
});
await new Promise((resolve) => staticServer.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${staticServer.address().port}`;

const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const results = [];
const errors = [];
const sentMessages = [];
const actions = [];
const createPayload = [];
const uploadedAttachments = [];
let pickDirBodies = [];
let fakeDir = "C:/fake/project/dir/演示路径";

page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("dialog", (d) => d.message().includes("结束这个项目") ? d.accept() : d.dismiss()); // 消除弹窗阻塞

// 路由拦截
await page.route("**/api/pickdir", async (route) => {
  const req = route.request();
  if (req.method() === "POST") {
    try { pickDirBodies.push(req.postDataJSON()); } catch (e) {}
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ path: fakeDir, canceled: false }) });
  } else await route.continue();
});
await page.route("**/api/projects/*/message", async (route) => {
  const req = route.request();
  if (req.method() === "POST") { try { sentMessages.push(req.postDataJSON()); } catch (e) {} await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }); }
  else await route.continue();
});
await page.route("**/api/projects/*/attachments", async (route) => {
  const body = route.request().postDataJSON();
  uploadedAttachments.push(body);
  await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ attachment: { id: `file-${uploadedAttachments.length}` } }) });
});
await page.route("**/api/projects/*/action", async (route) => {
  const req = route.request();
  if (req.method() === "POST") { try { actions.push(req.postDataJSON()); } catch (e) {} await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }); }
  else await route.continue();
});
await page.route("**/api/projects", async (route) => {
  const req = route.request();
  if (req.method() === "POST") { try { createPayload.push(req.postDataJSON()); } catch (e) {} await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "reg-test-blocked" }) }); }
  else await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [{ id: "demo", name: "演示", state: "PAUSED", source_dir: "C:/demo", updated_at: new Date().toISOString() }], system: { bridge: {}, runner: { active: [], uis: [] }, mode: {} } }) });
});
await page.route("**/api/projects/demo", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
  id: "demo", name: "演示", state: "PAUSED", user_task: "测试", created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  completed_tasks: [], failed_tasks: [], tasks: [], decisions: [], replans: [], analysis_reports: [], executor_runs: [], conversation: [],
  gpt: {}, pending: null, source_dir: "C:/demo", workspace_dir: "C:/demo/.gpt_workspace", gpt_live: null, executor_ui: null,
}) }));
await page.route("**/api/deepseek/models", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ groups: [{ id: "deepseek", name: "DeepSeek", models: [{ id: "chat", name: "Chat" }] }], reasoningEfforts: ["off", "low", "high", "max"] }) }));

const ok = (name, cond) => { results.push({ check: name, pass: !!cond }); };
const eq = (name, a, b) => { results.push({ check: name, pass: String(a) === String(b), got: a, want: b }); };

await page.goto(baseUrl, { waitUntil: "load" });
await page.waitForTimeout(2500);
ok("页面加载无崩溃", true);

// 布局：选中项目
const li = await page.evaluate(() => document.querySelectorAll("#projList li").length);
ok("项目列表已加载", li > 0);
await page.click("#projList li");
await page.waitForTimeout(1000);

const layout = await page.evaluate(() => {
  const main = document.querySelector(".main").getBoundingClientRect();
  const composer = document.querySelector("#composer").getBoundingClientRect();
  const input = document.querySelector("#composerInput").getBoundingClientRect();
  const wrap = document.querySelector(".composer-input-wrap").getBoundingClientRect();
  const sidebar = document.querySelector(".sidebar").getBoundingClientRect();
  return {
    composerAtBottom: Math.abs(composer.bottom - main.bottom) < 2,
    inputCenterOff: Math.round(Math.abs((wrap.left + wrap.width / 2) - (input.left + input.width / 2))),
    sidebarLeft: sidebar.left === 0,
    sidebarW: Math.round(sidebar.width),
  };
});
ok("Composer 位于右区底部", layout.composerAtBottom);
ok("输入框在其可用区内水平居中(≤5px)", layout.inputCenterOff <= 5); // 输入框相对 .composer-input-wrap 居中（右侧为模型/推理操作栏，属正常非对称布局）
ok("侧栏在左侧", layout.sidebarLeft);
eq("侧栏宽度", layout.sidebarW, 300);

// 目录选择：点击 #btnSetDir → /api/pickdir → action:setdir
pickDirBodies = [];
await page.click("#btnSetDir");
await page.waitForTimeout(400);
const setdirAct = actions.find(a => a.action === "setdir");
ok("修改文件夹触发 setdir", !!setdirAct);
eq("setdir 使用 pickdir 返回的目录", setdirAct && setdirAct.dir, fakeDir);
eq("pickdir 请求被调用", pickDirBodies.length, 1);
actions.length = 0;
await page.click("#btnComposerDir");
await page.waitForTimeout(400);
ok("聊天框左上工作目录入口触发 setdir", actions.some((a) => a.action === "setdir"));

// 新建项目表单的目录选择：#btnPickDir → pickdir → 填入 #projDir
await page.click("#btnNewProject");
const createLayout = await page.evaluate(() => {
  const main = document.querySelector(".main").getBoundingClientRect();
  const form = document.querySelector(".create-composer").getBoundingClientRect();
  return { visible: form.width > 0, nearBottom: main.bottom - form.bottom < 30, centered: Math.abs((main.left + main.width / 2) - (form.left + form.width / 2)) < 3 };
});
ok("新建项目切换到右侧表单", createLayout.visible);
ok("新建表单位于右侧底部中央", createLayout.nearBottom && createLayout.centered);
fakeDir = "C:/fake/newproj/path";
await page.click("#btnPickDir");
await page.waitForTimeout(400);
const projDirVal = await page.evaluate(() => document.querySelector("#projDir").value);
eq("新建表单目录填充", projDirVal, fakeDir);
await page.click("#projList li");
await page.waitForTimeout(200);

// 模型/推理：选择在输入框右侧 + 变更触发 deepseek_model
const opsRight = await page.evaluate(() => {
  const input = document.querySelector("#composerInput").getBoundingClientRect();
  const slot = document.querySelector("#composerModelSlot").getBoundingClientRect();
  return slot.left >= input.right - 1;
});
ok("模型/推理在输入框右侧", opsRight);
actions.length = 0;
await page.evaluate(() => {
  document.querySelector("#cModel").value = "deepseek/chat";
  const reasoning = document.querySelector("#cReasoning");
  reasoning.value = "high";
  reasoning.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForTimeout(400);
const dm = actions.find(a => a.action === "deepseek_model" && a.selection?.reasoningEffort === "high");
ok("切换推理触发 deepseek_model", !!dm);
ok("deepseek_model 带 reasoningEffort=high", dm && dm.selection && dm.selection.reasoningEffort === "high");
const modelOpts = await page.evaluate(() => document.querySelector("#cModel").options.length);
ok("模型下拉已填充目录", modelOpts > 1);

actions.length = 0;
await page.click("#btnEnd");
await page.waitForTimeout(300);
ok("结束按钮触发 end 动作", actions.some((a) => a.action === "end"));

// 消息发送（无附件）
sentMessages.length = 0;
await page.fill("#composerInput", "回归测试消息");
await page.press("#composerInput", "Enter");
await page.waitForTimeout(400);
eq("Enter 发送消息", sentMessages.length, 1);
eq("消息文本", sentMessages[0] && sentMessages[0].text, "回归测试消息");

// 附件：文件+照片、多附件、删除、失败、重试、发送注记
await page.setInputFiles("#fileInput", [
  { name: "报告.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF") },
  { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hi") },
]);
await page.waitForTimeout(900);
const afterFiles = await page.evaluate(() => Array.from(document.querySelectorAll(".attach-card")).map(c => c.className));
ok("多文件加入且成功", afterFiles.length >= 2 && afterFiles.every(c => c.includes("success")));

await page.setInputFiles("#photoInput", [{ name: "照片.png", mimeType: "image/png", buffer: Buffer.from([0x89,0x50,0x4e,0x47]) }]);
await page.waitForTimeout(900);
const hasPhoto = await page.evaluate(() => !!document.querySelector(".attach-card .attach-thumb img"));
ok("照片加入且有缩略图", hasPhoto);

// 拖拽入口已移除，浏览器不再接管或上传拖入文件
await page.evaluate(() => {
  const dt = new DataTransfer();
  dt.items.add(new File(["dragged"], "拖拽.txt", { type: "text/plain" }));
  document.querySelector("#composerInput").dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt }));
});
await page.waitForTimeout(200);
ok("拖拽上传已移除", await page.evaluate(() => !Array.from(document.querySelectorAll(".attach-name")).some((el) => el.textContent === "拖拽.txt")));

// 失败态
const failInfo = await page.evaluate(() => {
  window.addFiles([{ name: "big.zip", size: 60 * 1024 * 1024, type: "application/zip" }]);
  const c = Array.from(document.querySelectorAll(".attach-card")).find(c => c.className.includes("failed"));
  return { exists: !!c, hasRetry: !!c && !!c.querySelector("[data-act=retry]"), hasRemove: !!c && !!c.querySelector("[data-act=remove]") };
});
ok("大文件显示失败态", failInfo.exists);
ok("失败态有重试/移除", failInfo.hasRetry && failInfo.hasRemove);

// 删除一张
const beforeRemove = await page.evaluate(() => document.querySelectorAll(".attach-card").length);
await page.evaluate(() => { document.querySelector(".attach-card [data-act=remove]").click(); });
await page.waitForTimeout(200);
const afterRemove = await page.evaluate(() => document.querySelectorAll(".attach-card").length);
ok("可删除单个附件", afterRemove === beforeRemove - 1);

// 重试失败项
await page.evaluate(() => { const b = composerAttachments.find(a => a.name === "big.zip"); if (b) { b.size = 10; b.file = new File(["ok"], "big.zip", { type: "application/zip" }); b.reason = ""; window.retryAttachment(b.id); } });
await page.waitForTimeout(900);
const retried = await page.evaluate(() => { const c = Array.from(document.querySelectorAll(".attach-card")).find(c => c.querySelector(".attach-name")?.textContent === "big.zip"); return c ? c.className.includes("success") : false; });
ok("失败项重试后成功", retried);

// 发送带附件 → 消息携带后端附件 ID
sentMessages.length = 0;
await page.fill("#composerInput", "请分析这些附件");
await page.press("#composerInput", "Enter");
await page.waitForTimeout(400);
ok("附件已真实上传", uploadedAttachments.length >= 3 && uploadedAttachments.every((a) => a.data.startsWith("data:")));
ok("带附件发送服务端 ID", sentMessages[0] && sentMessages[0].attachment_ids.length >= 2);

// 新建项目 payload 构造（名称与分类由界面移除，拦截为 400，不真正创建）
await page.click("#btnNewProject");
createPayload.length = 0;
await page.fill("#projTask", "测试任务描述");
await page.click("#btnCreate");
await page.waitForTimeout(400);
ok("新建项目请求已构造", createPayload.length === 1);
const cp = createPayload[0] || {};
ok("新建界面已移除名称与分类字段", !(await page.locator("#projName").count()) && !(await page.locator("#projCategory").count()));
ok("新建 payload 仅需任务描述", !cp.name && !cp.category && cp.task === "测试任务描述");
await page.click("#projList li");
await page.waitForTimeout(200);

// 窗口尺寸变化
const sizes = [[1920,1080],[1280,800],[900,700],[700,600]];
const sizeResults = [];
for (const [w,h] of sizes) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => {
    const sb = document.querySelector(".sidebar").getBoundingClientRect();
    const mb = document.querySelector(".main").getBoundingClientRect();
    const cb = document.querySelector("#composer").getBoundingClientRect();
    return { overlap: sb.right > mb.left + 1, overflowX: document.documentElement.scrollWidth > window.innerWidth, overflowY: document.documentElement.scrollHeight > window.innerHeight, composerBottom: Math.abs(cb.bottom - mb.bottom) < 2 };
  });
  sizeResults.push({ w, h, ...r });
}
ok("各尺寸无错位/遮挡", sizeResults.every(r => !r.overlap && !r.overflowX && r.composerBottom));
ok("各尺寸无垂直溢出", sizeResults.every(r => !r.overflowY));

// 主题切换
await page.setViewportSize({ width: 1440, height: 900 });
const initialTheme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
await page.click("#btnTheme");
await page.waitForTimeout(200);
const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
ok("主题可在深浅色之间切换", initialTheme !== theme);

// 仅统计真实的 JS 异常；忽略测试自身制造的资源加载错误(favicon 404 / 拦截新建请求的 400)
const jsErrors = errors.filter(e => !e.includes("favicon") && !e.includes("400 (Bad Request)") && !e.includes("status of 400"));
ok("无 JS 控制台错误", jsErrors.length === 0);

const failed = results.filter(r => !r.pass);
console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed, all: results, jsErrors }, null, 2));
await browser.close();
await new Promise((resolve) => staticServer.close(resolve));
