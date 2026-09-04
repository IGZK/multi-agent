import { testBrowserPath } from "./browser-test-support.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectStore } from "../controller/store.mjs";
import { Orchestrator } from "../controller/orchestrator.mjs";
import { buildGptInstructions } from "../controller/prompts.mjs";
import { GptBridge } from "../controller/gpt_bridge.mjs";
import { chromium } from "playwright-core";

const silent = { info() {}, warn() {}, error() {} };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-rules-test-"));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("gpt-rules-test-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = path.join(root, "外部源码 目录");
  fs.mkdirSync(source);
  const store = new ProjectStore(path.join(root, "工作台", "projects"), silent);
  const id = store.createProject("外部项目", "实现计数器", source);
  const messages = [];
  let url = "https://chatgpt.com/", sequence = 0;
  const bridge = {
    page: { url: () => url, async goto(target) { url = target; } },
    async ensureBrowser() {}, async newConversation() { url = `https://chatgpt.com/c/test-${++sequence}`; },
    async gotoChat() { return this.detectState(); }, async setWindowVisible() {},
    async detectState() { return { loggedIn: true, challenge: false }; },
    async assistantCount() { return 0; },
    async sendMessage(text, { files }) { messages.push({ text, files, documents: files.map((file) => fs.readFileSync(file, "utf8")) }); },
  };
  const config = { gpt: {}, deepseek: { model: "deepseek-v4-flash", reasoningEffort: "off" } };
  const restart = () => new Orchestrator(config, silent, bridge, {}, store);
  return { root, source, store, id, messages, bridge, config, restart, orch: restart() };
}

test("外部目录新项目首条附规范和用户附件，正文不再内嵌长规则", async (t) => {
  const f = fixture(t);
  const attachment = f.store.saveAttachment(f.id, "需求.txt", "text/plain", Buffer.from("计数器需求"));
  f.store.writeState(f.id, { initial_attachment_ids: [attachment.id] });
  await f.orch.stepInit(f.id, f.store.readState(f.id));
  const sent = f.messages[0];
  assert.equal(sent.files.length, 2);
  assert.match(sent.documents[0], /总架构师与决策大脑/);
  assert.match(sent.documents[0], /files、inputs、implementation_notes、steps/);
  assert.match(sent.documents[0], /flash\/off/);
  assert.equal(sent.documents[1], "计数器需求");
  assert.match(sent.text, /实现计数器/);
  assert.doesNotMatch(sent.text, /【角色分工】|【程序化指挥规则/);
  assert.ok(sent.text.length < 800);
  assert.ok(sent.files[0].startsWith(f.store.workspaceDir(f.id) + path.sep));
  assert.deepEqual(fs.readdirSync(f.source), []);
  const st = f.store.readState(f.id);
  assert.equal(st.state, "GPT_PLANNING");
  assert.deepEqual(st.initial_attachment_ids, []);
  assert.equal(st.gpt.instructions.characters, sent.documents[0].length);
  assert.equal(st.usage.gpt.sentCharacters, sent.text.length + sent.documents[0].length);
  assert.equal(st.usage.gpt.estimatedInputTokens, Math.ceil((sent.text.length + sent.documents[0].length) / 4));
});

test("重启恢复和后续消息复用规范，各项目及新会话独立初始化", async (t) => {
  const f = fixture(t);
  await f.orch.sendToGpt(f.id, "PLAN_REQUEST", "开始");
  const originalUrl = f.store.readState(f.id).gpt.conversation_url;
  const restarted = f.restart();
  await restarted.stepInit(f.id, f.store.readState(f.id));
  assert.equal(f.messages.length, 1, "恢复等待中的首条任务不能重发");
  await restarted.sendToGpt(f.id, "TASK_REVIEW", "检查结果");
  assert.equal(f.messages[1].files.length, 0);
  assert.equal(f.store.readState(f.id).gpt.conversation_url, originalUrl);
  restarted.releaseGpt(f.id);
  const other = f.store.createProject("第二个项目", "另一项任务");
  await restarted.sendToGpt(other, "USER", "从消息入口开始");
  assert.equal(f.messages[2].files.length, 1);
  assert.notEqual(f.messages[2].files[0], f.messages[0].files[0]);
  restarted.releaseGpt(other);
  await restarted.sendToGpt(f.id, "USER", "新会话", { intro: true });
  assert.equal(f.messages[3].files.length, 1);
  assert.notEqual(f.store.readState(f.id).gpt.conversation_url, originalUrl);
});

test("切换档位及旧规范升级只补发一次，使用合并后的全局默认值", async (t) => {
  const f = fixture(t);
  await f.orch.sendToGpt(f.id, "PLAN_REQUEST", "开始");
  const oldHash = f.store.readState(f.id).gpt.instructions.hash;
  f.store.writeState(f.id, { deepseek_selection: { model: "deepseek-v4-pro", reasoningEffort: "max" } });
  await f.orch.sendToGpt(f.id, "QUERY", "按新模型调整");
  assert.equal(f.messages[1].files.length, 1);
  assert.match(f.messages[1].documents[0], /pro\/max.*目标委托/);
  assert.notEqual(f.store.readState(f.id).gpt.instructions.hash, oldHash);
  await f.orch.sendToGpt(f.id, "ANALYSIS", "继续");
  assert.deepEqual(f.messages[2].files, []);
  f.store.writeState(f.id, { gpt: { instructions: { hash: "旧规范版本" } } });
  await f.orch.sendToGpt(f.id, "USER", "升级规范");
  await f.orch.sendToGpt(f.id, "USER", "继续");
  assert.equal(f.messages[3].files.length, 1);
  assert.equal(f.messages[4].files.length, 0);
  f.store.writeState(f.id, { deepseek_selection: { model: "deepseek-v4-pro", reasoningEffort: "" } });
  f.config.deepseek.reasoningEffort = "low";
  await f.orch.sendToGpt(f.id, "QUERY", "使用默认档位");
  assert.match(f.messages[5].documents[0], /pro\/low.*关键点指导/);
});

test("旧项目不新开会话，发送失败不记为已初始化，重试仍附规范", async (t) => {
  const f = fixture(t);
  const url = "https://chatgpt.com/c/legacy";
  f.store.writeState(f.id, { gpt: { intro_sent: true, conversation_url: url } });
  const send = f.bridge.sendMessage;
  f.bridge.sendMessage = async () => { throw new Error("附件上传失败"); };
  await assert.rejects(f.orch.sendToGpt(f.id, "USER", "继续"), /附件上传失败/);
  assert.equal(f.store.readState(f.id).gpt.instructions, null);
  assert.equal(f.store.readState(f.id).gpt_messages.length, 0);
  assert.equal(f.orch.gptOwner, null);
  f.bridge.sendMessage = send;
  await f.orch.sendToGpt(f.id, "USER", "重试");
  assert.equal(f.messages[0].files.length, 1);
  assert.equal(f.store.readState(f.id).gpt.conversation_url, url);
  assert.ok(f.store.readState(f.id).gpt.instructions.hash);
});

test("规范摘要由实际文档与指挥规则共同生成", () => {
  const weak = buildGptInstructions({ model: "deepseek-v4-flash", reasoningEffort: "off" });
  const strong = buildGptInstructions({ model: "deepseek-v4-pro", reasoningEffort: "max" });
  const source = fs.readFileSync(new URL("../docs/gpt-workbench-rules.md", import.meta.url), "utf8").trim();
  assert.ok(weak.text.startsWith(source));
  assert.equal(weak.hash, buildGptInstructions({ model: "deepseek-v4-flash", reasoningEffort: "off" }).hash);
  assert.notEqual(weak.hash, strong.hash);
  assert.ok(weak.reminder.length < 220);
});

test("隔离 Chrome 的真实附件入口可以同时发送规范和用户文件", async (t) => {
  const executablePath = testBrowserPath(t);
  if (!executablePath) return;
  const f = fixture(t);
  const rules = buildGptInstructions();
  const rulesFile = f.store.writeWorkspaceFile(f.id, rules.relative_path, rules.text);
  const userFile = f.store.writeWorkspaceFile(f.id, "attachments/需求.txt", "实现计数器");
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://bridge.test/**", (route) => route.fulfill({ contentType: "text/html", body: `
      <input type="file" multiple>
      <div id="prompt-textarea" contenteditable="true" style="width:600px;height:80px"></div>
      <button data-testid="send-button">发送</button>
      <script>document.querySelector('button').onclick = () => {
        window.sentFiles = [...document.querySelector('input').files].map(file => file.name);
        const message = document.createElement('div'); message.dataset.messageAuthorRole = 'user';
        message.textContent = document.querySelector('#prompt-textarea').innerText;
        document.body.append(message);
      };</script>` }));
    await page.goto("https://bridge.test/");
    const bridge = Object.assign(Object.create(GptBridge.prototype), {
      cfg: {}, page, live: {}, logger: silent,
      async ensureBrowser() {}, async detectState() { return { loggedIn: true }; },
    });
    await bridge.sendMessage("读取附带规范，然后实现计数器。", { files: [rulesFile, userFile] });
    assert.deepEqual(await page.evaluate(() => window.sentFiles), [rules.name, "需求.txt"]);
    assert.equal(await page.locator('[data-message-author-role="user"]').innerText(), "读取附带规范，然后实现计数器。");
  } finally { await browser.close(); }
});
