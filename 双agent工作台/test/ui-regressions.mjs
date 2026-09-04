import assert from "node:assert/strict";
import test from "node:test";
import { dashboardFixture } from "./dashboard-fixture.mjs";

async function setup(t) {
  const fixture = await dashboardFixture();
  const { page, baseUrl } = fixture;
  const env = { ...fixture, requests: [], dialogs: [], errors: [], gates: new Map(), failActions: new Set(), acceptDialogs: true };
  env.hold = (key) => {
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    const gate = { promise, release };
    env.gates.set(key, gate);
    return gate;
  };
  t.after(async () => {
    for (const gate of env.gates.values()) gate.release();
    await fixture.close();
  });
  env.projects = new Map(["alpha", "beta"].map((id) => [id, {
    id, name: id, state: "PAUSED", source_dir: `C:/${id}`, user_task: "测试任务", updated_at: "2026-09-04T00:00:00Z",
    tasks: [{ id: "TASK-001", description: "当前任务" }], current_task: { id: "TASK-001" },
    conversation: [{ dir: "in", type: "READY", text: "旧消息", ts: "2026-09-04T00:00:00Z" }],
  }]));
  page.on("pageerror", (error) => env.errors.push(error.message));
  page.on("dialog", async (dialog) => {
    env.dialogs.push(dialog.message());
    if (env.acceptDialogs) await dialog.accept(dialog.type() === "prompt" ? "renamed" : undefined);
    else await dialog.dismiss();
  });
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const pathname = new URL(req.url()).pathname;
    const body = req.method() === "POST" ? req.postDataJSON() : null;
    const projectId = pathname.split("/")[3];
    const endpoint = pathname.split("/").at(-1);
    env.requests.push({ pathname, projectId, endpoint, body });
    const reply = (data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    await env.gates.get(body?.action || (pathname === "/api/projects" && body ? "create" : endpoint))?.promise;
    if (pathname === "/api/pickdir") return reply({ path: "C:/chosen", canceled: false });
    if (pathname === "/api/deepseek/models") return reply({ groups: [{ id: "deepseek", models: [{ id: "chat", name: "Chat" }] }] });
    if (pathname === "/api/projects") {
      if (body) {
        const project = { id: "created", name: "created", state: "INIT", user_task: body.task };
        env.projects.set(project.id, project);
        return reply(project, 201);
      }
      return reply({ projects: [...env.projects.values()].map(({ id, name, state, archived, updated_at }) => ({ id, name, state, archived, updated_at })), system: { bridge: { browserOk: true, loggedIn: true }, runner: { active: [] } } });
    }
    const project = env.projects.get(projectId);
    if (!project) return reply({ error: "项目不存在" }, 404);
    if (endpoint === "message") return reply(env.messageResponse || { ok: true });
    if (endpoint === "attachments") return reply({ attachment: { id: `${projectId}-file-${env.requests.length}` } }, 201);
    if (endpoint === "action") {
      if (env.failActions.has(body.action)) return reply({ error: "模拟操作失败" }, 409);
      if (body.action === "delete") env.projects.delete(projectId);
      if (body.action === "rename") project.name = body.name;
      if (body.action === "archive") project.archived = body.archived;
      if (body.action === "pause") project.state = "PAUSED";
      if (body.action === "resume") project.state = "EXECUTING";
      if (body.action === "deepseek_model") project.deepseek_selection = body.selection;
      return reply({ ok: true });
    }
    return reply(project);
  });
  await page.goto(baseUrl);
  await page.locator('.project-row[data-id="alpha"] .project-select').waitFor();
  await page.evaluate(() => selectProject("alpha"));
  return env;
}

test("选择目录期间切换项目，修改仍属于原项目", { timeout: 20000 }, async (t) => {
  const env = await setup(t);
  const gate = env.hold("pickdir");
  await env.page.click("#btnComposerDir");
  await env.page.waitForFunction(() => choosingFolder);
  await env.page.evaluate(() => selectProject("beta"));
  gate.release();
  await env.page.waitForFunction(() => !choosingFolder);
  assert.deepEqual(env.requests.filter((req) => req.body?.action === "setdir").map((req) => [req.projectId, req.body.dir]), [["alpha", "C:/chosen"]]);
  assert.equal(await env.page.textContent("#dName"), "beta");
});

test("异步附件读取和草稿按项目隔离，超大附件重试仍被拦截", { timeout: 20000 }, async (t) => {
  const env = await setup(t);
  const { page } = env;
  await page.fill("#composerInput", "alpha 草稿");
  await page.evaluate(() => {
    window.originalFileReader = fileAsDataUrl;
    fileAsDataUrl = () => new Promise((resolve) => { window.finishFileRead = resolve; });
    addFiles([new File(["test"], "alpha.txt", { type: "text/plain" })]);
  });
  await page.evaluate(() => selectProject("beta"));
  assert.equal(await page.inputValue("#composerInput"), "");
  assert.equal(await page.locator("#attachList .attach-card").count(), 0);
  await page.fill("#composerInput", "beta 草稿");
  await page.evaluate(() => { window.finishFileRead("data:text/plain;base64,dGVzdA=="); fileAsDataUrl = window.originalFileReader; });
  await page.waitForFunction(() => composerDrafts.get("alpha").attachments[0].status === "success");
  assert.equal(env.requests.find((req) => req.endpoint === "attachments").projectId, "alpha");
  await page.evaluate(() => selectProject("alpha"));
  assert.equal(await page.inputValue("#composerInput"), "alpha 草稿");
  assert.equal(await page.locator("#attachList .attach-card.success").count(), 1);
  await page.evaluate(async () => {
    addFiles([{ name: "large.zip", size: 60 * 1024 * 1024 }]);
    await retryAttachment(composerAttachments.at(-1).id);
  });
  assert.equal(env.requests.filter((req) => req.endpoint === "attachments").length, 1);
  assert.deepEqual(env.errors, []);
});

test("中文输入确认不发送，重复 Enter 只发一次，迟到响应不清空其他项目草稿", { timeout: 20000 }, async (t) => {
  const env = await setup(t);
  const { page } = env;
  await page.fill("#composerInput", "中文消息");
  await page.dispatchEvent("#composerInput", "keydown", { key: "Enter", isComposing: true });
  assert.equal(env.requests.filter((req) => req.endpoint === "message").length, 0);
  const gate = env.hold("message");
  await page.evaluate(() => { sendComposer(); sendComposer(); });
  await page.waitForFunction(() => pendingSends.has("alpha"));
  await page.evaluate(() => selectProject("beta"));
  await page.fill("#composerInput", "保留 beta 草稿");
  gate.release();
  await page.waitForFunction(() => !pendingSends.has("alpha"));
  assert.equal(env.requests.filter((req) => req.endpoint === "message").length, 1);
  assert.equal(await page.inputValue("#composerInput"), "保留 beta 草稿");
  await page.evaluate(() => selectProject("alpha"));
  assert.equal(await page.inputValue("#composerInput"), "");
});

test("消息发送中新增文字和附件不会被成功响应清空", { timeout: 20000 }, async (t) => {
  const env = await setup(t);
  const { page } = env;
  const gate = env.hold("message");
  await page.fill("#composerInput", "第一条");
  await page.click("#btnComposerSend");
  await page.fill("#composerInput", "第二条草稿");
  await page.setInputFiles("#fileInput", [{ name: "next.txt", mimeType: "text/plain", buffer: Buffer.from("next") }]);
  gate.release();
  await page.waitForFunction(() => !pendingSends.has("alpha"));
  assert.equal(await page.inputValue("#composerInput"), "第二条草稿");
  assert.equal(await page.locator("#attachList .attach-card").count(), 1);
});

test("创建防重复与中文输入确认，创建成功后当前项目完整展示", { timeout: 20000 }, async (t) => {
  const env = await setup(t);
  const { page } = env;
  await page.click("#btnNewProject");
  await page.fill("#projTask", "创建项目");
  await page.dispatchEvent("#projTask", "keydown", { key: "Enter", isComposing: true });
  assert.equal(env.requests.filter((req) => req.pathname === "/api/projects" && req.body).length, 0);
  const gate = env.hold("create");
  await page.evaluate(() => { createProject(); createProject(); });
  gate.release();
  await page.waitForFunction(() => !creatingProject && currentProjectId === "created");
  assert.equal(env.requests.filter((req) => req.pathname === "/api/projects" && req.body).length, 1);
  assert.equal(await page.locator("#currentProjBox").isVisible(), true);
  assert.equal(await page.textContent("#curpName"), "created");
});

test("轮询保留菜单与键盘焦点；重命名、归档、取消和失败删除保留正确状态", { timeout: 20000 }, async (t) => {
  const env = await setup(t);
  const { page } = env;
  await page.click('.project-row[data-id="alpha"] summary');
  await page.focus('.project-row[data-id="alpha"] [data-act="rename"]');
  env.projects.get("alpha").updated_at = "2026-09-04T00:01:00Z";
  await page.evaluate(() => refresh());
  assert.equal(await page.locator('.project-row[data-id="alpha"] details').getAttribute("open"), "");
  assert.equal(await page.evaluate(() => document.activeElement.dataset.act), "rename");
  await page.evaluate(() => projectAction(projectsCache.find((project) => project.id === "alpha"), "rename"));
  assert.equal(await page.textContent("#dName"), "renamed");
  env.acceptDialogs = false;
  await page.evaluate(() => projectAction(projectsCache.find((project) => project.id === "alpha"), "delete"));
  assert.equal(env.requests.filter((req) => req.body?.action === "delete").length, 0);
  env.acceptDialogs = true;
  env.failActions.add("delete");
  await page.evaluate(() => projectAction(projectsCache.find((project) => project.id === "alpha"), "delete"));
  assert.equal(await page.evaluate(() => currentProjectId), "alpha");
  assert.ok(env.dialogs.some((message) => message.includes("操作失败：模拟操作失败")));
  env.failActions.delete("delete");
  await page.evaluate(() => projectAction(projectsCache.find((project) => project.id === "alpha"), "archive"));
  await page.focus(".archived-toggle button");
  await page.keyboard.press("Enter");
  assert.equal(await page.locator('.project-row[data-id="alpha"]').isVisible(), true);
  await page.evaluate(() => projectAction(projectsCache.find((project) => project.id === "alpha"), "delete"));
  assert.equal(await page.locator("#emptyHint").isVisible(), true);
  assert.equal(await page.locator('.project-row[data-id="alpha"]').count(), 0);
  assert.deepEqual(env.errors, []);
});

test("暂停与继续只提交一次并同步任务状态；同长度消息变更可刷新", { timeout: 20000 }, async (t) => {
  const env = await setup(t);
  const { page } = env;
  await page.evaluate(() => action("resume"));
  assert.equal(await page.locator("#taskTable .task-status").textContent(), "执行中");
  const gate = env.hold("pause");
  await page.evaluate(() => { action("pause"); action("pause"); });
  gate.release();
  await page.waitForFunction(() => !pendingActions.has("alpha/pause"));
  assert.equal(env.requests.filter((req) => req.body?.action === "pause").length, 1);
  assert.equal(await page.locator("#btnResume").isVisible(), true);
  assert.equal(await page.locator("#taskTable .task-status").textContent(), "已暂停");
  env.projects.get("alpha").conversation[0].text = "新消息";
  await page.evaluate(() => refreshDetail());
  assert.equal(await page.locator("#chatList .c-body").textContent(), "新消息");
});

test("连续模型修改按顺序保存并回显，保存提示不会被轮询清除", { timeout: 20000 }, async (t) => {
  const env = await setup(t);
  const { page } = env;
  await page.focus("#cModel");
  await page.waitForFunction(() => document.querySelector('#cModel option[value="deepseek/chat"]'));
  const gate = env.hold("deepseek_model");
  await page.evaluate(() => {
    document.querySelector("#cModel").value = "deepseek/chat";
    document.querySelector("#cReasoning").value = "low";
    saveComposerModelSelection();
    document.querySelector("#cReasoning").value = "high";
    saveComposerModelSelection();
  });
  gate.release();
  await page.waitForFunction(() => !pendingModelSaves.size);
  assert.deepEqual(env.requests.filter((req) => req.body?.action === "deepseek_model").map((req) => req.body.selection.reasoningEffort), ["low", "high"]);
  await page.focus("#composerInput");
  await page.evaluate(() => refreshDetail());
  assert.equal(await page.inputValue("#cReasoning"), "high");
  assert.equal(await page.textContent("#composerSaveStatus"), "模型设置已保存");
  assert.equal(await page.locator("#composerSaveStatus").isVisible(), true);
});

test("暂停与运行时的消息队列反馈可见", { timeout: 20000 }, async (t) => {
  const env = await setup(t);
  env.projects.get("alpha").queued_messages = 1;
  env.messageResponse = { ok: true, queued: true, paused: true };
  await env.page.fill("#composerInput", "暂停后追加说明");
  await env.page.evaluate(() => sendComposer());
  assert.equal(await env.page.textContent("#composerMessageStatus"), "已保存，继续项目后发送");
  assert.equal(await env.page.locator("#composerMessageStatus").isVisible(), true);
  assert.equal(await env.page.textContent("#dQueued .callout-title"), "1 条消息等待发送");
  assert.equal(await env.page.textContent("#dQueued .callout-sub"), "继续项目后发送");
  env.messageResponse = { ok: true, queued: true, paused: false };
  env.projects.get("alpha").state = "EXECUTING";
  await env.page.fill("#composerInput", "继续追加说明");
  await env.page.evaluate(() => sendComposer());
  assert.equal(await env.page.textContent("#composerMessageStatus"), "已加入消息队列，会在当前步骤完成后发送");
  assert.equal(await env.page.textContent("#dQueued .callout-sub"), "将在当前步骤完成后发送");
  env.projects.get("alpha").queued_messages = 0;
  await env.page.evaluate(() => refreshDetail());
  assert.equal(await env.page.locator("#dQueued").isVisible(), false);
});

test("长文本、Shift+Enter 和多附件无溢出，主题设置在重新加载后保留", { timeout: 20000 }, async (t) => {
  const env = await setup(t);
  const { page } = env;
  await page.fill("#composerInput", "换行");
  await page.press("#composerInput", "Shift+Enter");
  assert.ok((await page.inputValue("#composerInput")).includes("\n"));
  assert.equal(env.requests.filter((req) => req.endpoint === "message").length, 0);
  const shortHeight = await page.locator("#composerInput").evaluate((element) => element.clientHeight);
  await page.fill("#composerInput", Array.from({ length: 20 }, (_, i) => `第 ${i} 行 ${"文本".repeat(40)}`).join("\n"));
  assert.ok(await page.locator("#composerInput").evaluate((element) => element.clientHeight) > shortHeight);
  await page.setInputFiles("#fileInput", Array.from({ length: 8 }, (_, i) => ({ name: `file-${i}.txt`, mimeType: "text/plain", buffer: Buffer.from("test") })));
  for (const width of [1440, 900, 700]) {
    await page.setViewportSize({ width, height: 700 });
    const layout = await page.evaluate(() => {
      const composer = document.querySelector("#composer").getBoundingClientRect();
      const main = document.querySelector(".main").getBoundingClientRect();
      const input = document.querySelector("#composerInput");
      return { overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight, fits: composer.top >= main.top && composer.bottom <= main.bottom, scrolls: input.scrollHeight > input.clientHeight };
    });
    assert.deepEqual(layout, { overflow: false, fits: true, scrolls: true });
  }
  const background = await page.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor);
  await page.click("#btnTheme");
  assert.notEqual(await page.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor), background);
  const theme = await page.getAttribute("html", "data-theme");
  await page.reload();
  assert.equal(await page.getAttribute("html", "data-theme"), theme);
});

test("长工作目录省略展示且保留完整标题，空目录显示默认提示", { timeout: 20000 }, async (t) => {
  const env = await setup(t);
  const longPath = `C:/${"很长的文件夹名称/".repeat(25)}`;
  env.projects.get("alpha").source_dir = longPath;
  await env.page.evaluate(() => refreshDetail());
  assert.equal(await env.page.getAttribute("#dirHint", "title"), longPath);
  assert.equal(await env.page.locator("#dirHint").evaluate((element) => element.scrollWidth > element.clientWidth && getComputedStyle(element).textOverflow === "ellipsis"), true);
  env.projects.get("alpha").source_dir = "";
  await env.page.evaluate(() => refreshDetail());
  assert.equal(await env.page.textContent("#dirHint"), "默认工作台目录");
  assert.equal(await env.page.getAttribute("#dirHint", "data-path"), "");
});

test("会话和执行窗口拒绝脚本协议链接", { timeout: 20000 }, async (t) => {
  const env = await setup(t);
  env.projects.get("alpha").gpt = { conversation_url: "javascript:alert('unsafe')" };
  env.projects.get("alpha").executor_ui = { url: "javascript:alert('unsafe')" };
  await env.page.evaluate(() => refreshDetail());
  assert.equal(await env.page.locator('a[href^="javascript:"]').count(), 0);
  assert.equal(await env.page.locator("#dExecUi").isVisible(), false);
});
