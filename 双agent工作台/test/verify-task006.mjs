// TASK-006 附件上传 UI 验证
import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
let sent = null;
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
await page.route("**/api/projects/*/message", async (route) => {
  const req = route.request();
  if (req.method() === "POST") { sent = req.postDataJSON(); await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }); }
  else await route.continue();
});
await page.goto("http://127.0.0.1:3700/", { waitUntil: "load" });
await page.waitForTimeout(2200);
const li = await page.evaluate(() => document.querySelectorAll("#projList li").length);
if (li > 0) { await page.click("#projList li"); await page.waitForTimeout(800); }

const R = {};

// 1) 多文件 + 图片
await page.setInputFiles("#fileInput", [
  { name: "报告.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-test") },
  { name: "截图.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") },
]);
await page.waitForTimeout(150);
R.cardsWhileUploading = await page.evaluate(() => Array.from(document.querySelectorAll(".attach-card")).map(c => c.className));
await page.waitForTimeout(800);
R.cardsAfterUpload = await page.evaluate(() => Array.from(document.querySelectorAll(".attach-card")).map(c => c.className));
R.imageThumb = await page.evaluate(() => {
  const img = document.querySelector(".attach-card .attach-thumb img");
  return img ? (img.src.startsWith("blob:") ? "blob" : img.src) : null;
});
R.names = await page.evaluate(() => Array.from(document.querySelectorAll(".attach-name")).map(n => n.textContent));

// 2) 删除一张
await page.evaluate(() => { document.querySelectorAll(".attach-card")[2].querySelector("[data-act=remove]").click(); });
await page.waitForTimeout(150);
R.afterRemove = await page.evaluate(() => document.querySelectorAll(".attach-card").length);

// 3) 发送时附件清单注记
await page.fill("#composerInput", "请看看这些附件");
await page.press("#composerInput", "Enter");
await page.waitForTimeout(400);
R.sentBody = sent;
R.attachmentsClearedAfterSend = await page.evaluate(() => document.querySelectorAll(".attach-card").length);

// 4) 失败 + 重试
R.failResult = await page.evaluate(() => {
  window.addFiles([{ name: "big.zip", size: 60 * 1024 * 1024, type: "application/zip" }]);
  const c = document.querySelector(".attach-card.failed");
  return { exists: !!c, reason: c ? c.querySelector(".attach-state.failed").textContent : null, hasRetry: !!c && !!c.querySelector("[data-act=retry]"), hasRemove: !!c && !!c.querySelector("[data-act=remove]") };
});
// 重试一个正常的失败? 用 big 无法重试成功(仍过大)。直接测 retry 逻辑把失败的置为上传中:模拟手动改为可重试
await page.evaluate(() => { const b = composerAttachments.find(a => a.name === "big.zip"); if (b) { b.size = 100; b.reason = ""; window.retryAttachment(b.id); } });
await page.waitForTimeout(800);
R.afterRetry = await page.evaluate(() => {
  const c = Array.from(document.querySelectorAll(".attach-card")).find(c => c.querySelector(".attach-name")?.textContent === "big.zip");
  return c ? c.className : null;
});

// 5) 拖拽高亮
R.dragHighlight = await page.evaluate(() => {
  const el = document.querySelector("#composer");
  el.dispatchEvent(new DragEvent("dragenter", { bubbles: true }));
  const on = el.classList.contains("dragging");
  el.dispatchEvent(new DragEvent("dragleave", { bubbles: true }));
  const off = !el.classList.contains("dragging");
  return { on, off };
});

console.log(JSON.stringify({ R, consoleErrors: errors }, null, 2));
await browser.close();
