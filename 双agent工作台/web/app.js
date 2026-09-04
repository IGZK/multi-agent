const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const icon = (name, alt = "") => `<img class="ui-icon" src="/assets/icons/${name}.svg" alt="${escapeHtml(alt)}" />`;

let currentProjectId = null;
let projectsCache = [];
let modelCatalog = null;
let systemCache = null;
let showArchived = false;
let lastTasksSig = null;
let lastChatSig = null;
let lastChatCount = 0;
let windowVisible = null;
let refreshPromise = null;
let detailGeneration = 0;

const STATE_META = {
  INIT: ["初始化", "info"], WAITING_FOR_LOGIN: ["等待登录", "wait"], GPT_PLANNING: ["GPT 规划中", "run"],
  PLAN_READY: ["规划就绪", "info"], EXECUTING: ["执行中", "run"], WAITING_FOR_EXECUTOR: ["执行中", "run"],
  ANALYZING: ["分析中", "run"], WAITING_FOR_GPT: ["等待 GPT", "run"], GPT_REVIEW: ["GPT 审查中", "run"],
  DECISION_REQUIRED: ["决策中", "run"], REPLANNING: ["重新规划", "run"], ERROR: ["错误", "err"],
  COMPLETED: ["已完成", "ok"], CANCELED: ["已取消", "err"], PAUSED: ["已暂停", "wait"],
};

async function api(url, options) {
  let response;
  try { response = await fetch(url, options); }
  catch { throw new Error("工作台后台未运行，请重新启动后再试"); }
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try { message = (await response.json()).error || message; } catch { /* empty */ }
    throw new Error(message);
  }
  return response.json();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function fmtTokens(value) {
  const number = Number(value || 0);
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}k`;
  return String(number);
}

function tokenTotal(tokens) {
  return ["uncachedInputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]
    .reduce((sum, key) => sum + Number(tokens?.[key] || 0), 0);
}

function fmtDuration(seconds) {
  const value = Math.max(0, Number(seconds || 0));
  if (value < 60) return `${Math.round(value)}s`;
  const minutes = Math.floor(value / 60);
  if (minutes < 60) return `${minutes}分${Math.round(value % 60)}s`;
  return `${Math.floor(minutes / 60)}时${minutes % 60}分`;
}

function fmtTime(value) {
  return value ? String(value).replace("T", " ").slice(0, 19) : "—";
}

function stateMeta(state) { return STATE_META[state] || [state || "未知", "info"]; }

function updateBadge(state) {
  const [label, style] = stateMeta(state);
  for (const selector of ["#dState", "#curpState"]) {
    const node = $(selector);
    if (node) { node.textContent = label; node.className = `badge ${style}`; }
  }
}

function callout(node, visible, title, detail = "") {
  if (!node) return;
  node.classList.toggle("hidden", !visible);
  if (!visible) return;
  node.innerHTML = `<div class="callout-title">${escapeHtml(title)}</div>${detail ? `<div class="callout-sub">${detail}</div>` : ""}`;
}

function closeMenus() { $$('details[open]').forEach((details) => details.removeAttribute("open")); }

function modelValue(provider, model) { return `${provider}/${model}`; }
function splitModelValue(value) {
  const index = String(value || "").indexOf("/");
  return index < 0 ? null : { provider: value.slice(0, index), model: value.slice(index + 1) };
}

async function loadModelCatalog(force = false) {
  if (modelCatalog && !force) return modelCatalog;
  try { modelCatalog = await api("/api/deepseek/models"); }
  catch { modelCatalog = { groups: [], reasoningEfforts: ["off", "low", "high", "max"], fallback: true }; }
  return modelCatalog;
}

function fillModelSelect(select) {
  if (!select) return;
  const previous = select.value;
  select.innerHTML = '<option value="">跟随 DeepSeek 默认</option>';
  for (const group of modelCatalog?.groups || []) {
    for (const model of group.models || []) {
      const option = document.createElement("option");
      option.value = modelValue(group.id, model.id);
      option.textContent = `${model.name || model.id}（${group.name || group.id}）`;
      select.appendChild(option);
    }
  }
  if (previous) setModelValue(select, previous);
}

function setModelValue(select, value) {
  // 已保存的模型即时展示，不必等冷启动的模型目录探测。
  if (value && ![...select.options].some((option) => option.value === value)) {
    select.add(new Option(value, value));
  }
  select.value = value;
}

async function populateModelSelects() {
  await loadModelCatalog();
  fillModelSelect($("#dsModel"));
  fillModelSelect($("#cModel"));
}

function selectedModelPayload() {
  const selected = splitModelValue($("#dsModel").value);
  if (!selected) return null;
  return { ...selected, reasoningEffort: $("#dsReasoning").value };
}

async function refresh(force = false) {
  if (refreshPromise && !force) return refreshPromise;
  const running = (async () => {
    try {
      const data = await api("/api/projects");
      projectsCache = data.projects || [];
      systemCache = data.system || null;
      renderProjectList();
      renderSystem(data.system);
      if (currentProjectId) await refreshDetail();
    } catch (error) {
      $("#sysStatus").textContent = error.message;
    }
  })();
  refreshPromise = running;
  try { return await running; }
  finally { if (refreshPromise === running) refreshPromise = null; }
}

function renderSystem(system) {
  const bridge = system?.bridge || {};
  const runner = system?.runner || {};
  const running = runner.active?.length || 0;
  const healthy = bridge.browserOk !== false;
  const primary = running ? `${running} 个任务运行中` : healthy ? "系统正常" : "需要处理";
  $("#sysStatus").innerHTML = `
    <span class="status-item"><span class="status-mark ${healthy ? "ok" : "warn"}"></span>${escapeHtml(primary)}</span>
    <span class="status-item secondary-status"><span class="status-mark ${bridge.loggedIn ? "ok" : "warn"}"></span>${bridge.loggedIn ? "ChatGPT 已连接" : "ChatGPT 待登录"}</span>
    <span class="status-item hide-narrow">${escapeHtml(system?.mode?.gpt || "GPT")} · ${escapeHtml(system?.mode?.deepseek || "执行器")}</span>`;
  $("#sysInfo").textContent = `数据保存在 projects 目录\n${running ? `${running} 个执行任务正在运行` : "当前没有运行中的执行任务"}`;
}

function renderProjectList() {
  const list = $("#projList");
  list.innerHTML = "";
  const active = projectsCache.filter((project) => !project.archived);
  const archived = projectsCache.filter((project) => project.archived);
  if (!projectsCache.length) {
    list.innerHTML = '<li class="proj-empty">暂无项目</li>';
    return;
  }

  const addProject = (project) => {
    const row = document.createElement("li");
    row.className = `project-row${project.id === currentProjectId ? " active" : ""}${project.archived ? " archived" : ""}`;
    const [state, style] = stateMeta(project.state);
    row.innerHTML = `
      <button class="project-select" type="button" aria-label="打开项目 ${escapeHtml(project.name || project.id)}">
        <span class="project-name">${escapeHtml(project.name || project.id)}</span>
        <span class="project-meta"><span class="status-mark ${style === "ok" ? "ok" : style === "err" ? "bad" : style === "wait" ? "warn" : ""}"></span>${escapeHtml(state)} · ${escapeHtml(fmtTime(project.updated_at).slice(0, 16))}</span>
      </button>
      <details class="row-menu"><summary class="icon-button" title="项目操作" aria-label="${escapeHtml(project.name || project.id)} 的项目操作">${icon("ellipsis")}</summary>
        <div class="row-menu-panel"><button data-act="rename" type="button">${icon("square-pen")}重命名</button><button data-act="archive" type="button">${icon("archive")}${project.archived ? "取消归档" : "归档"}</button><button data-act="delete" class="danger" type="button">${icon("trash-2")}删除</button></div>
      </details>`;
    row.querySelector(".project-select").onclick = () => selectProject(project.id);
    row.querySelectorAll("[data-act]").forEach((button) => {
      button.onclick = (event) => { event.stopPropagation(); projectAction(project, button.dataset.act); };
    });
    list.appendChild(row);
  };

  active.forEach(addProject);
  if (archived.length) {
    const toggle = document.createElement("li");
    toggle.className = "archived-toggle";
    toggle.textContent = `${showArchived ? "隐藏" : "显示"}已归档（${archived.length}）`;
    toggle.onclick = () => { showArchived = !showArchived; renderProjectList(); };
    list.appendChild(toggle);
    if (showArchived) archived.forEach(addProject);
  }
}

async function projectAction(project, actionName) {
  if (actionName === "rename") {
    const name = prompt("重命名项目：", project.name || project.id);
    if (name?.trim()) await actionWith("rename", { name: name.trim() }, project.id);
  } else if (actionName === "archive") {
    await actionWith("archive", { archived: !project.archived }, project.id);
  } else if (actionName === "delete") {
    if (!confirm(`确认删除项目「${project.name}」？\n该操作不可恢复。`)) return;
    await actionWith("delete", {}, project.id);
    if (currentProjectId === project.id) showEmptyView();
  }
}

function showEmptyView() {
  currentProjectId = null;
  $("#detail").classList.add("hidden");
  $("#createView").classList.add("hidden");
  $("#emptyHint").classList.remove("hidden");
  $("#currentProjBox").classList.add("hidden");
}

async function actionWith(actionName, payload = {}, projectId = currentProjectId) {
  if (!projectId) return null;
  const result = await api(`/api/projects/${encodeURIComponent(projectId)}/action`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: actionName, ...payload }),
  });
  await refresh();
  return result;
}

function selectProject(projectId) {
  currentProjectId = projectId;
  detailGeneration++;
  lastChatSig = null; lastChatCount = 0; lastTasksSig = null;
  $("#emptyHint").classList.add("hidden");
  $("#createView").classList.add("hidden");
  $("#detail").classList.remove("hidden");
  $("#currentProjBox").classList.remove("hidden");
  refreshDetail();
}

async function refreshDetail() {
  if (!currentProjectId) return;
  const requestedId = currentProjectId;
  const generation = ++detailGeneration;
  try {
    const detail = await api(`/api/projects/${encodeURIComponent(requestedId)}`);
    if (requestedId !== currentProjectId || generation !== detailGeneration) return;
    $("#dName").textContent = detail.name || detail.id;
    $("#dName").title = detail.id;
    $("#curpName").textContent = detail.name || detail.id;
    updateBadge(detail.state);

    const sourceDir = detail.source_dir || "";
    $("#dirHint").textContent = sourceDir || "默认工作台目录";
    $("#dirHint").title = sourceDir || "默认工作台目录";
    $("#dirHint").dataset.path = sourceDir;
    $("#composerDirLabel").textContent = sourceDir || "默认工作目录";
    $("#composerDirLabel").title = sourceDir || "默认工作目录";

    const selection = detail.deepseek_selection;
    if (document.activeElement !== $("#cModel") && document.activeElement !== $("#cReasoning")) {
      setModelValue($("#cModel"), selection?.model ? modelValue(selection.provider || "deepseek-official", selection.model) : "");
      $("#cReasoning").value = selection?.reasoningEffort || "";
    }

    const pendingVisible = detail.pending?.text && detail.state !== "COMPLETED";
    const pendingTime = detail.pending_elapsed_s == null ? "" : `已等待 ${fmtDuration(detail.pending_elapsed_s)}`;
    callout($("#dPending"), pendingVisible, detail.pending?.text || "", pendingTime);

    const executorUi = detail.executor_ui;
    const isRunning = ["WAITING_FOR_EXECUTOR", "EXECUTING", "ANALYZING", "DECISION_REQUIRED"].includes(detail.state);
    callout(
      $("#dExecUi"), !!executorUi?.url,
      `DeepSeek 执行窗口${isRunning ? "正在运行" : "可供回顾"}`,
      executorUi?.url ? `<a href="${escapeHtml(executorUi.url)}" target="_blank" rel="noopener">打开执行窗口</a>${executorUi.sessions?.length ? ` · ${executorUi.sessions.length} 个会话` : ""}` : "",
    );

    const live = detail.gpt_live;
    const liveLabels = { navigating: "正在打开 ChatGPT", sending: "正在发送消息", waiting_reply: "等待 GPT 回复", thinking: "GPT 正在思考", answering: "GPT 正在回答", complete: "GPT 回复完成" };
    let liveDetail = "";
    if (live?.phase && live.phase !== "idle") {
      liveDetail = `已耗时 ${fmtDuration((live.elapsedMs || 0) / 1000)}${live.replyChars ? ` · 已生成 ${live.replyChars} 字` : ""}${live.slow ? " · 响应时间较长，可打开 GPT 浏览器查看" : ""}`;
    }
    callout($("#dGptLive"), !!live?.phase && live.phase !== "idle", liveLabels[live?.phase] || live?.phase || "", liveDetail);
    callout($("#dError"), detail.state === "ERROR" && !!detail.last_error, "任务已停止", escapeHtml(detail.last_error || ""));

    renderOverview(detail);
    renderTasks(detail);
    renderChat(detail.conversation || []);
    $("#planView").textContent = detail.plan_text || "（暂无规划）";
    $("#analysisView").textContent = detail.analysis_text || "（暂无分析）";
    $("#logView").textContent = detail.logs_tail || "（暂无日志）";

    const capabilities = detail.executor?.capabilities || {};
    $("#executorSelect").value = detail.executor?.type || "deepseek";
    $("#btnExecWindow").classList.toggle("hidden", capabilities.visibleWindow === false);
    $("#btnCompact").classList.toggle("hidden", capabilities.sessionResume === false);
    $("#composerModelSlot").classList.toggle("hidden", capabilities.modelSelection === false);
    const pauseUnavailable = ["COMPLETED", "CANCELED", "ERROR"].includes(detail.state);
    $("#btnPause").classList.toggle("hidden", detail.state === "PAUSED");
    $("#btnPause").disabled = pauseUnavailable;
    $("#btnPause").title = pauseUnavailable ? "当前项目无法暂停" : "暂停项目";
    $("#btnResume").classList.toggle("hidden", detail.state !== "PAUSED");
    $("#btnRetryTask").disabled = !detail.current_task && !(detail.failed_tasks || []).length;
    $("#btnOverviewRetry").disabled = $("#btnRetryTask").disabled;
    $("#btnRestore").disabled = !detail.checkpoint || isRunning;
    $("#btnOverviewRestore").disabled = $("#btnRestore").disabled;

    const entries = systemCache?.runner?.executors || [];
    for (const option of $("#executorSelect").options) {
      const entry = entries.find((item) => item.type === option.value);
      option.disabled = !!entry && !entry.configured;
      if (entry && !entry.configured && !option.textContent.includes("未配置")) option.textContent += "（未配置）";
    }
  } catch (error) {
    if (requestedId !== currentProjectId || generation !== detailGeneration) return;
    console.error(error);
    callout($("#dError"), true, "无法刷新项目", escapeHtml(error.message));
  }
}

function renderOverview(detail) {
  const tasks = detail.tasks || [];
  const completed = detail.completed_tasks || [];
  const totals = detail.usage?.deepseek?.totals || {};
  const gptUsage = detail.usage?.gpt || {};
  const context = detail.usage?.deepseek?.context;
  $("#oProgress").textContent = `${completed.length} / ${tasks.length}`;
  $("#oCurrentTask").textContent = detail.current_task?.id || "暂无";
  $("#oContext").textContent = context?.percentage == null ? "不可用" : `${context.percentage}%`;
  $("#oTokens").textContent = fmtTokens(tokenTotal(totals) + Number(gptUsage.estimatedInputTokens || 0) + Number(gptUsage.estimatedOutputTokens || 0));
  $("#oTask").textContent = detail.user_task || "";

  const gptLink = detail.gpt?.conversation_url
    ? `<a href="${escapeHtml(detail.gpt.conversation_url)}" target="_blank" rel="noopener">打开会话</a>` : "未创建";
  $("#oProjectMeta").innerHTML = `
    <dt>状态</dt><dd>${escapeHtml(detail.state || "—")}</dd>
    <dt>更新时间</dt><dd>${escapeHtml(fmtTime(detail.updated_at))}</dd>
    <dt>源码目录</dt><dd><code>${escapeHtml(detail.source_dir || "默认目录")}</code></dd>
    <dt>工作区</dt><dd><code>${escapeHtml(detail.workspace_dir || "—")}</code></dd>
    <dt>GPT 会话</dt><dd>${gptLink}</dd>
    <dt>派发 ID</dt><dd><code>${escapeHtml(detail.current_dispatch_id || "—")}</code></dd>`;

  const task = detail.current_task;
  const checkpoint = detail.checkpoint;
  $("#oCurrent").textContent = [
    `执行器：${detail.executor?.type === "cli" ? "通用命令行" : "DeepSeek Harness"}`,
    task ? `任务：${task.id} · ${task.kind || "coding"}\n${task.description || ""}` : "任务：暂无",
    task ? `依赖：${(task.dependencies || []).join(", ") || "无"}` : "",
    checkpoint ? `检查点：${checkpoint.task_id} · ${checkpoint.status || "ready"}` : "检查点：暂无",
  ].filter(Boolean).join("\n");

  const runs = (detail.executor_runs || []).slice(-8).reverse().map((run) =>
    `[${fmtTime(run.ts)}] ${run.type || "执行"} ${run.task_id || ""} · 第 ${run.attempt || 1} 次 · ${run.timedOut ? "超时" : `exit ${run.exitCode ?? "—"}`} · ${fmtDuration((run.ms || 0) / 1000)}`
  ).join("\n");
  $("#oRuns").textContent = runs || "（尚无执行记录）";
  $("#oUsage").textContent = `DeepSeek（Harness 真实投影）\n输入 ${totals.uncachedInputTokens || 0} · 输出 ${totals.outputTokens || 0} · 缓存读 ${totals.cacheReadTokens || 0} · 缓存写 ${totals.cacheWriteTokens || 0}\n上下文 ${context?.percentage == null ? "不可用" : `${context.percentage}%（${context.pressureTokens || 0}/${context.contextWindow || 0}）`} · 压缩 ${detail.compaction?.count || 0} 次\n\nGPT（网页字符折算，估算）\n发送 ${gptUsage.sentCharacters || 0} 字 / 约 ${gptUsage.estimatedInputTokens || 0} token · 接收 ${gptUsage.receivedCharacters || 0} 字 / 约 ${gptUsage.estimatedOutputTokens || 0} token`;
}

function renderTasks(detail) {
  const signature = JSON.stringify({
    tasks: detail.tasks, completed: detail.completed_tasks, failed: detail.failed_tasks,
    current: detail.current_task?.id, metrics: detail.usage?.deepseek?.tasks, validation: detail.validation_results,
  });
  if (signature === lastTasksSig) return;
  lastTasksSig = signature;
  const body = $("#taskTable tbody");
  body.innerHTML = "";
  const completed = new Set((detail.completed_tasks || []).map((item) => item.id));
  const failed = new Set((detail.failed_tasks || []).map((item) => item.id));
  const metrics = detail.usage?.deepseek?.tasks || [];
  for (const task of detail.tasks || []) {
    const taskMetrics = metrics.filter((item) => item.task_id === task.id);
    const last = taskMetrics.at(-1);
    const duration = taskMetrics.reduce((total, item) => total + Number(item.duration_ms || 0), 0);
    const tokens = taskMetrics.reduce((total, item) => total + Number(tokenTotal(item.tokens)), 0);
    const validation = detail.validation_results?.[task.id];
    let status = "待办", style = "pending";
    if (completed.has(task.id)) { status = "完成"; style = "completed"; }
    else if (failed.has(task.id)) { status = "失败"; style = "failed"; }
    else if (detail.current_task?.id === task.id) { status = "执行中"; style = "running"; }
    const execution = taskMetrics.length ? `${fmtDuration(duration / 1000)} · ${taskMetrics.length} 次` : "—";
    const validationSpec = task.validation_command || task.acceptance_check || task.validation;
    const validationText = !validationSpec ? "未配置" : !validation ? "待验证" : validation.skipped ? "自然语言标准（最终审查）" : validation.ok ? "通过" : `失败：${validation.output || validation.error || "命令未通过"}`;
    const row = document.createElement("tr");
    row.innerHTML = `<td><strong>${escapeHtml(task.id)}</strong></td><td>${escapeHtml(task.description || "")}</td><td>${escapeHtml(task.kind || "coding")}</td><td>${escapeHtml(execution)}</td><td>${taskMetrics.some((item) => item.actual) ? fmtTokens(tokens) : "不可用"}</td><td><div class="validation-result ${validation?.ok ? "ok" : validation ? "failed" : ""}" title="${escapeHtml(validationText)}">${escapeHtml(validationText)}</div></td><td><span class="task-status ${style}">${status}</span></td>`;
    body.appendChild(row);
  }
}

function renderChat(messages) {
  const signature = messages.length + ":" + messages.map((message) => `${message.dir}|${message.type || ""}|${message.length || message.text?.length || 0}|${message.ts || ""}`).join("~");
  if (signature === lastChatSig) return;
  const scroller = $("#convoView");
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
  const isNew = messages.length > lastChatCount;
  lastChatSig = signature;
  lastChatCount = messages.length;
  const list = $("#chatList");
  list.innerHTML = "";
  for (const message of messages) {
    const kind = String(message.type || "").toUpperCase().includes("EXECUTOR") ? "executor" : message.dir === "in" ? "in" : "system";
    const role = kind === "executor" ? "执行者" : kind === "in" ? "GPT" : message.type === "USER" ? "用户" : "工作台";
    const text = String(message.text || "");
    const body = text.length > 1800
      ? `<details class="message-details"><summary>展开完整消息（${text.length} 字）</summary><div class="c-body">${escapeHtml(text)}</div></details>`
      : `<div class="c-body">${escapeHtml(text)}</div>`;
    const node = document.createElement("article");
    node.className = `chat-msg ${kind}`;
    node.innerHTML = `<div class="c-head"><span class="c-role">${role}${message.type ? ` · ${escapeHtml(message.type)}` : ""}</span><time>${escapeHtml(fmtTime(message.ts))}</time></div>${body}`;
    list.appendChild(node);
  }
  if (isNew && nearBottom) scroller.scrollTop = scroller.scrollHeight;
}

function showCreateView() {
  currentProjectId = null;
  $("#emptyHint").classList.add("hidden");
  $("#detail").classList.add("hidden");
  $("#createView").classList.remove("hidden");
  $("#currentProjBox").classList.add("hidden");
  autoGrow($("#projTask"));
  $("#projTask").focus();
}

async function pickFolder(startDir) {
  return api("/api/pickdir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ start_dir: startDir || "" }) });
}

async function chooseProjectFolder() {
  const button = $("#btnPickDir");
  const original = button.innerHTML;
  try {
    button.disabled = true; button.textContent = "选择中…";
    const result = await pickFolder($("#projDir").value.trim());
    if (result?.path) {
      $("#projDir").value = result.path;
      $("#projDirLabel").textContent = result.path;
      $("#projDirLabel").title = result.path;
    }
  } catch (error) { alert(`选择文件夹失败：${error.message}`); }
  finally { button.disabled = false; button.innerHTML = original; }
}

async function createProject() {
  const task = $("#projTask").value.trim();
  if (!task) { alert("请先描述你想完成的工作"); $("#projTask").focus(); return; }
  if (createAttachments.some((item) => item.status === "failed")) return alert("有附件无法使用，请先移除后再创建项目。");
  const button = $("#btnCreate");
  const original = button.innerHTML;
  try {
    button.disabled = true; button.textContent = "创建中…";
    const payload = { task };
    const sourceDir = $("#projDir").value.trim();
    if (sourceDir) payload.source_dir = sourceDir;
    const selection = selectedModelPayload();
    if (selection) payload.deepseek_selection = selection;
    if (createAttachments.length) {
      payload.attachments = await Promise.all(createAttachments.map(async (item) => ({
        name: item.name,
        mime: item.type,
        data: await fileAsDataUrl(item.file),
      })));
    }
    const result = await api("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    $("#projTask").value = "";
    $("#projDir").value = "";
    $("#projDirLabel").textContent = "默认工作目录";
    $("#projDirLabel").removeAttribute("title");
    autoGrow($("#projTask"));
    clearCreateAttachments();
    currentProjectId = result.id;
    $("#createView").classList.add("hidden");
    $("#detail").classList.remove("hidden");
    await refresh();
  } catch (error) { alert(`创建失败：${error.message}`); }
  finally { button.disabled = false; button.innerHTML = original; }
}

async function action(actionName) {
  try { await actionWith(actionName); closeMenus(); }
  catch (error) { alert(`操作失败：${error.message}`); }
}

async function setCurrentFolder() {
  if (!currentProjectId) return;
  const button = $("#btnSetDir");
  const original = button.innerHTML;
  const currentPath = $("#dirHint")?.dataset.path || "";
  try {
    button.disabled = true; button.setAttribute("aria-busy", "true");
    const result = await pickFolder(currentPath);
    if (result?.path) await actionWith("setdir", { dir: result.path });
  } catch (error) { alert(`修改失败：${error.message}`); }
  finally { button.disabled = false; button.removeAttribute("aria-busy"); button.innerHTML = original; }
}

async function toggleGptWindow() {
  if (!currentProjectId) return;
  try {
    const show = windowVisible !== true;
    const result = await actionWith(show ? "window_show" : "window_hide");
    windowVisible = !!result.windowVisible;
    $("#btnWindow").innerHTML = `${icon("monitor")}${windowVisible ? "隐藏 GPT 浏览器" : "显示 GPT 浏览器"}`;
  } catch (error) { alert(`窗口操作失败：${error.message}`); }
}

async function openExecutorWindow() {
  if (!currentProjectId) return;
  const button = $("#btnExecWindow");
  try {
    button.disabled = true;
    const result = await actionWith("executor_window");
    if (result?.url && !result.opened) window.open(result.url, "_blank", "noopener");
    if (!result?.url) alert("当前没有可用的执行窗口。");
  } catch (error) { alert(`打开执行窗口失败：${error.message}`); }
  finally { button.disabled = false; }
}

async function exportAudit() {
  try {
    const result = await actionWith("export_audit");
    const blob = new Blob([result.content || ""], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `${currentProjectId || "project"}-audit.md`; link.click();
    URL.revokeObjectURL(url);
    closeMenus();
  } catch (error) { alert(`导出失败：${error.message}`); }
}

async function selectExecutor() {
  try { await actionWith("select_executor", { executor_type: $("#executorSelect").value }); }
  catch (error) { alert(`切换执行器失败：${error.message}`); await refreshDetail(); }
}

let saveStatusTimer = null;
async function saveComposerModelSelection() {
  if (!currentProjectId) return;
  const selected = splitModelValue($("#cModel").value);
  const effort = $("#cReasoning").value;
  try {
    await actionWith("deepseek_model", { selection: selected ? { ...selected, reasoningEffort: effort } : { provider: "", model: "", reasoningEffort: "" } });
    const status = $("#composerSaveStatus");
    status.textContent = "模型设置已保存"; status.classList.add("show");
    clearTimeout(saveStatusTimer);
    saveStatusTimer = setTimeout(() => { status.classList.remove("show"); status.textContent = ""; }, 2400);
  } catch (error) { alert(`保存失败：${error.message}`); }
}

$("#btnNewProject").onclick = showCreateView;
$("#btnPickDir").onclick = chooseProjectFolder;
$("#btnCreate").onclick = createProject;
$("#btnPause").onclick = () => action("pause");
$("#btnResume").onclick = () => action("resume");
$("#btnRetry").onclick = () => action("retry");
$("#btnRetryTask").onclick = () => action("retry_task");
$("#btnOverviewRetry").onclick = () => action("retry_task");
$("#btnRestore").onclick = () => action("restore_checkpoint");
$("#btnOverviewRestore").onclick = () => action("restore_checkpoint");
$("#btnCompact").onclick = () => action("compact_session");
$("#btnExportAudit").onclick = exportAudit;
$("#btnWindow").onclick = toggleGptWindow;
$("#btnExecWindow").onclick = openExecutorWindow;
$("#btnSetDir").onclick = setCurrentFolder;
$("#btnComposerDir").onclick = setCurrentFolder;
$("#executorSelect").onchange = selectExecutor;
$("#cModel").onchange = saveComposerModelSelection;
$("#cReasoning").onchange = saveComposerModelSelection;
$("#btnEnd").onclick = () => { if (confirm("确定结束这个项目？\n正在运行的任务会停止，项目记录会保留。")) action("end"); };

const composerInput = $("#composerInput");
const composerSend = $("#btnComposerSend");
const projectInput = $("#projTask");
const MAX_ATTACH_SIZE = 50 * 1024 * 1024;
let composerAttachments = [];
let createAttachments = [];
let attachSeq = 0;

function autoGrow(element) {
  element.style.height = "auto";
  element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
}

async function sendComposer() {
  if (!currentProjectId) return;
  const text = composerInput.value.trim();
  if (!text && !composerAttachments.length) return;
  if (composerAttachments.some((item) => item.status === "uploading")) return alert("附件仍在上传，请稍候再发送。");
  if (composerAttachments.some((item) => item.status === "failed")) return alert("有附件上传失败，请重试或移除。");
  try {
    composerSend.disabled = true;
    await api(`/api/projects/${encodeURIComponent(currentProjectId)}/message`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, attachment_ids: composerAttachments.map((item) => item.serverId).filter(Boolean) }),
    });
    composerInput.value = ""; autoGrow(composerInput); clearAttachments(); await refreshDetail();
  } catch (error) { alert(`发送失败：${error.message}`); }
  finally { composerSend.disabled = false; }
}

composerInput.addEventListener("input", () => autoGrow(composerInput));
composerInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendComposer(); }
});
for (const eventName of ["dragover", "drop"]) composerInput.addEventListener(eventName, (event) => event.preventDefault());
composerSend.onclick = sendComposer;
projectInput.addEventListener("input", () => autoGrow(projectInput));
projectInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); createProject(); }
});

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function fileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("无法读取文件"));
    reader.readAsDataURL(file);
  });
}

async function uploadAttachment(id) {
  const attachment = composerAttachments.find((item) => item.id === id);
  if (!attachment?.file || !currentProjectId) return;
  attachment.status = "uploading"; attachment.reason = ""; renderAttachments();
  try {
    const data = await fileAsDataUrl(attachment.file);
    const result = await api(`/api/projects/${encodeURIComponent(currentProjectId)}/attachments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: attachment.name, mime: attachment.type, data }),
    });
    Object.assign(attachment, { serverId: result.attachment.id, status: "success" });
  } catch (error) { Object.assign(attachment, { status: "failed", reason: error.message }); }
  renderAttachments();
}

function addFiles(fileList) {
  for (const file of Array.from(fileList || [])) {
    const attachment = { id: ++attachSeq, file, name: file.name, size: file.size, type: file.type, status: "uploading" };
    if (file.size > MAX_ATTACH_SIZE) Object.assign(attachment, { status: "failed", reason: "文件超过 50MB" });
    else if (file.type?.startsWith("image/")) {
      try { attachment.preview = URL.createObjectURL(file); } catch { /* preview optional */ }
    }
    composerAttachments.push(attachment);
    if (attachment.status === "uploading") uploadAttachment(attachment.id);
  }
  renderAttachments();
}

function removeAttachment(id) {
  const index = composerAttachments.findIndex((item) => item.id === id);
  if (index < 0) return;
  if (composerAttachments[index].preview) URL.revokeObjectURL(composerAttachments[index].preview);
  composerAttachments.splice(index, 1);
  renderAttachments();
}

function retryAttachment(id) { uploadAttachment(id); }

function clearAttachments() {
  for (const attachment of composerAttachments) if (attachment.preview) URL.revokeObjectURL(attachment.preview);
  composerAttachments = [];
  $("#attachList").innerHTML = "";
}

function addCreateFiles(fileList) {
  for (const file of Array.from(fileList || [])) {
    const attachment = { id: ++attachSeq, file, name: file.name, size: file.size, type: file.type, status: "ready" };
    if (file.size > MAX_ATTACH_SIZE) Object.assign(attachment, { status: "failed", reason: "文件超过 50MB" });
    else if (file.type?.startsWith("image/")) {
      try { attachment.preview = URL.createObjectURL(file); } catch { /* preview optional */ }
    }
    createAttachments.push(attachment);
  }
  renderCreateAttachments();
}

function removeCreateAttachment(id) {
  const index = createAttachments.findIndex((item) => item.id === id);
  if (index < 0) return;
  if (createAttachments[index].preview) URL.revokeObjectURL(createAttachments[index].preview);
  createAttachments.splice(index, 1);
  renderCreateAttachments();
}

function clearCreateAttachments() {
  for (const attachment of createAttachments) if (attachment.preview) URL.revokeObjectURL(attachment.preview);
  createAttachments = [];
  $("#createAttachList").innerHTML = "";
}

function renderCreateAttachments() {
  const list = $("#createAttachList");
  list.innerHTML = "";
  for (const attachment of createAttachments) {
    const card = document.createElement("div");
    card.className = `attach-card ${attachment.status}`;
    const preview = attachment.preview
      ? `<div class="attach-thumb"><img src="${attachment.preview}" alt="${escapeHtml(attachment.name)}" /></div>`
      : `<div class="attach-icon">${icon(attachment.type?.startsWith("image/") ? "image" : "paperclip")}</div>`;
    const state = attachment.status === "failed"
      ? `<span class="attach-state failed">失败：${escapeHtml(attachment.reason || "无法使用")}</span>`
      : '<span class="attach-state success">创建时上传</span>';
    card.innerHTML = `${preview}<div class="attach-info"><div class="attach-name" title="${escapeHtml(attachment.name)}">${escapeHtml(attachment.name)}</div><div class="attach-meta">${fmtSize(attachment.size)} · ${state}</div></div><div class="attach-actions"><button class="attach-act" type="button" title="移除" aria-label="移除附件">移除</button></div>`;
    card.querySelector("button").onclick = () => removeCreateAttachment(attachment.id);
    list.appendChild(card);
  }
}

function renderAttachments() {
  const list = $("#attachList");
  list.innerHTML = "";
  for (const attachment of composerAttachments) {
    const card = document.createElement("div");
    card.className = `attach-card ${attachment.status}`;
    card.dataset.id = attachment.id;
    const preview = attachment.preview
      ? `<div class="attach-thumb"><img src="${attachment.preview}" alt="${escapeHtml(attachment.name)}" /></div>`
      : `<div class="attach-icon">${icon(attachment.type?.startsWith("image/") ? "image" : "paperclip")}</div>`;
    const state = attachment.status === "uploading" ? '<span class="attach-state"><span class="spinner"></span>上传中</span>'
      : attachment.status === "success" ? '<span class="attach-state success">已就绪</span>'
      : `<span class="attach-state failed" title="${escapeHtml(attachment.reason || "")}">失败${attachment.reason ? `：${escapeHtml(attachment.reason)}` : ""}</span>`;
    card.innerHTML = `${preview}<div class="attach-info"><div class="attach-name" title="${escapeHtml(attachment.name)}">${escapeHtml(attachment.name)}</div><div class="attach-meta">${fmtSize(attachment.size)} · ${state}</div></div><div class="attach-actions">${attachment.status === "failed" ? '<button class="attach-act" data-act="retry" type="button" title="重试" aria-label="重试上传">重试</button>' : ""}<button class="attach-act" data-act="remove" type="button" title="移除" aria-label="移除附件">移除</button></div>`;
    card.querySelectorAll("[data-act]").forEach((button) => {
      button.onclick = () => button.dataset.act === "retry" ? retryAttachment(Number(card.dataset.id)) : removeAttachment(Number(card.dataset.id));
    });
    list.appendChild(card);
  }
}

$("#btnAttach").onclick = () => $("#fileInput").click();
$("#btnAttachPhoto").onclick = () => $("#photoInput").click();
$("#btnCreateAttach").onclick = () => $("#createFileInput").click();
$("#btnCreateAttachPhoto").onclick = () => $("#createPhotoInput").click();
$("#fileInput").onchange = () => { addFiles($("#fileInput").files); $("#fileInput").value = ""; };
$("#photoInput").onchange = () => { addFiles($("#photoInput").files); $("#photoInput").value = ""; };
$("#createFileInput").onchange = () => { addCreateFiles($("#createFileInput").files); $("#createFileInput").value = ""; };
$("#createPhotoInput").onchange = () => { addCreateFiles($("#createPhotoInput").files); $("#createPhotoInput").value = ""; };

function activateTab(tab) {
  const tabs = $$(".tab");
  for (const item of tabs) {
    const active = item === tab;
    item.classList.toggle("active", active);
    item.setAttribute("aria-selected", String(active));
    item.tabIndex = active ? 0 : -1;
  }
  const name = tab.dataset.tab;
  for (const panel of [$("#convoView"), ...$$(".tab-body")]) panel.classList.add("hidden");
  const panel = name === "chat" ? $("#convoView") : $(`#tab-${name}`);
  panel?.classList.remove("hidden");
}

for (const tab of $$(".tab")) {
  tab.onclick = () => activateTab(tab);
  tab.onkeydown = (event) => {
    const tabs = $$(".tab");
    let index = tabs.indexOf(tab);
    if (event.key === "ArrowRight") index = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") index = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") index = 0;
    else if (event.key === "End") index = tabs.length - 1;
    else return;
    event.preventDefault(); activateTab(tabs[index]); tabs[index].focus();
  };
}

for (const button of $$(".copy-button")) {
  button.onclick = async () => {
    const source = document.getElementById(button.dataset.copy);
    try { await navigator.clipboard.writeText(source?.textContent || ""); button.title = "已复制"; }
    catch { button.title = "复制失败"; }
    setTimeout(() => { button.title = "复制"; }, 1600);
  };
}

const themeButton = $("#btnTheme");
function applyTheme(value) {
  const theme = value === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  themeButton.innerHTML = icon(theme === "dark" ? "sun" : "moon");
  themeButton.title = theme === "dark" ? "切换到浅色主题" : "切换到深色主题";
  themeButton.setAttribute("aria-label", themeButton.title);
  try { localStorage.setItem("wb-theme", theme); } catch { /* local storage optional */ }
}
themeButton.onclick = () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
try { applyTheme(localStorage.getItem("wb-theme") || "light"); } catch { applyTheme("light"); }

// 模型目录会启动一次临时 Harness；用户首次操作模型控件时再加载，不与首屏/项目打开争抢资源。
let modelLoadStarted = false;
const ensureModels = () => {
  if (modelLoadStarted) return;
  modelLoadStarted = true;
  populateModelSelects();
};
for (const select of [$("#dsModel"), $("#cModel")]) {
  select?.addEventListener("focus", ensureModels, { once: true });
  select?.addEventListener("pointerenter", ensureModels, { once: true });
}

async function poll() {
  await refresh();
  setTimeout(poll, 1000);
}
poll();
