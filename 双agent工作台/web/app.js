// Dashboard 前端：轮询 API，展示项目状态并支持控制
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let currentProjectId = null;
let projectsCache = [];
let modelCatalog = null; // { groups:[{id,name,models:[{id,name}]}], reasoningEfforts, current, fallback }
let showArchived = false;

const STATE_META = {
  INIT: ["初始化", "info"],
  WAITING_FOR_LOGIN: ["等待登录 ChatGPT", "wait"],
  GPT_PLANNING: ["GPT 规划中", "run"],
  PLAN_READY: ["规划就绪", "info"],
  EXECUTING: ["DeepSeek 执行中", "run"],
  WAITING_FOR_EXECUTOR: ["DeepSeek 执行中", "run"],
  ANALYZING: ["DeepSeek 分析中", "run"],
  WAITING_FOR_GPT: ["等待 GPT 决策", "run"],
  GPT_REVIEW: ["GPT 审查中", "run"],
  DECISION_REQUIRED: ["决策中", "run"],
  REPLANNING: ["GPT 重规划", "run"],
  ERROR: ["错误", "err"],
  COMPLETED: ["已完成", "ok"],
  CANCELED: ["已取消", "err"],
  PAUSED: ["已暂停", "wait"],
};

function badge(state) {
  const [label, cls] = STATE_META[state] || [state, ""];
  const el = $("#dState");
  el.textContent = label;
  el.className = `badge ${cls}`;
  const cp = $("#curpState");
  if (cp) { cp.textContent = label; cp.className = `badge ${cls}`; }
}

async function api(path, opts) {
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new Error("工作台后台未运行，请重新运行 start.bat 后重试");
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

// 调用后端原生文件夹选择器，返回 { path, canceled }
async function pickFolder(startDir) {
  return await api("/api/pickdir", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ start_dir: startDir || "" }),
  });
}

// 模型下拉框选项值格式：`provider/model`
function modelValue(provider, model) { return `${provider}/${model}`; }
function splitModelValue(v) {
  const i = (v || "").indexOf("/");
  if (i < 0) return null;
  return { provider: v.slice(0, i), model: v.slice(i + 1) };
}

function tokenTotal(tokens) {
  if (!tokens) return null;
  return ["uncachedInputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]
    .reduce((sum, key) => sum + Number(tokens[key] || 0), 0);
}

function fmtTokens(value) {
  const n = Number(value || 0);
  return n >= 1000000 ? `${(n / 1000000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// 拉取 DeepSeek 可用模型目录并填充所有下拉框（一次探测，多次复用）
async function loadModelCatalog(force = false) {
  if (modelCatalog && !force) return modelCatalog;
  try {
    modelCatalog = await api("/api/deepseek/models");
  } catch (e) {
    console.error("加载 DeepSeek 模型目录失败", e);
    modelCatalog = { groups: [], reasoningEfforts: ["off", "low", "high", "max"], current: null, fallback: true };
  }
  return modelCatalog;
}

function fillModelSelect(select) {
  if (!select) return;
  const prev = select.value;
  select.innerHTML = '<option value="">跟随 DeepSeek 默认</option>';
  for (const g of (modelCatalog?.groups || [])) {
    for (const m of (g.models || [])) {
      const opt = document.createElement("option");
      opt.value = modelValue(g.id, m.id);
      opt.textContent = `${m.name || m.id}（${g.name || g.id}）`;
      select.appendChild(opt);
    }
  }
  if (prev) select.value = prev;
}

async function populateModelSelects() {
  await loadModelCatalog();
  fillModelSelect($("#dsModel"));
  fillModelSelect($("#cModel"));
}

function selectedModelPayload() {
  const v = splitModelValue($("#dsModel").value);
  const effort = $("#dsReasoning").value;
  if (!v) return null;
  return { provider: v.provider, model: v.model, reasoningEffort: effort };
}

async function refresh() {
  try {
    const data = await api("/api/projects");
    projectsCache = data.projects || [];
    renderProjectList();
    renderSysStatus(data.system);
    if (currentProjectId) {
      await refreshDetail();
    }
  } catch (e) {
    console.error("refresh failed", e);
    $("#sysStatus").textContent = e.message;
  }
}

function renderSysStatus(system) {
  const parts = [];
  if (system) {
    const b = system.bridge || {};
    const r = system.runner || {};
    const live = b.live || {};
    if (live.phase && live.phase !== "idle") {
      const labels = {
        navigating: "🧭 打开 ChatGPT…",
        sending: "📤 发送消息…",
        waiting_reply: "⏳ 等待 GPT 回复…",
        thinking: "💭 GPT 正在思考…",
        answering: "✍️ GPT 正在回答…",
        complete: "✅ GPT 回复完成",
      };
      const t = Math.max(0, Math.round((live.elapsedMs || 0) / 1000));
      const chars = live.replyChars ? ` · ${live.replyChars} 字` : "";
      parts.push(`<span class="${live.slow ? "live-slow" : ""}">${live.slow ? "⚠️ 可能卡住 · " : ""}${labels[live.phase] || live.phase} ${t}s${chars}</span>`);
    }
    parts.push(`<span>${b.browserOk ? '<span class="dot ok"></span>浏览器' : '<span class="dot bad"></span>浏览器未连接'}</span>`);
    parts.push(`<span>${b.loggedIn ? '<span class="dot ok"></span>ChatGPT 已登录' : b.loading ? '<span class="dot wait"></span>ChatGPT 加载中' : '<span class="dot wait"></span>ChatGPT 未登录/需处理'}</span>`);
    parts.push(`<span>GPT桥: ${system.mode?.gpt || "?"}</span>`);
    parts.push(`<span>执行者: ${system.mode?.deepseek || "?"}${(r.active || []).length ? `（${r.active.length} 个运行中）` : ""}${(r.uis || []).length ? ` · 🖥 ${r.uis.length} 个执行窗口` : ""}</span>`);
  }
  $("#sysStatus").innerHTML = parts.join("");
  $("#sysInfo").textContent = "工作台运行中。\n项目数据保存在 projects/ 目录，\n重启后自动断点恢复。";
}

function renderProjectList() {
  const ul = $("#projList");
  ul.innerHTML = "";
  const active = projectsCache.filter((p) => !p.archived);
  const archived = projectsCache.filter((p) => p.archived);

  if (projectsCache.length === 0) {
    ul.innerHTML = '<li class="p-name" style="color:var(--dim)">暂无项目</li>';
    return;
  }

  const renderItem = (p) => {
    const li = document.createElement("li");
    if (p.id === currentProjectId) li.classList.add("active");
    if (p.archived) li.classList.add("archived");
    const [label, cls] = STATE_META[p.state] || [p.state, ""];
    li.innerHTML = `
      <div class="p-name">${escapeHtml(p.name || p.id)}</div>
      <div class="p-meta"><span class="badge ${cls}" style="padding:2px 8px;font-size:11px">${label}</span> · ${(p.updated_at || "").replace("T", " ").slice(0, 16)}</div>
      <div class="p-actions">
        <button data-act="rename" title="重命名">✎ 重命名</button>
        <button data-act="archive" title="归档/取消归档">${p.archived ? "🗂 取消归档" : "🗄 归档"}</button>
        <button data-act="delete" class="danger" title="删除项目（不可恢复）">🗑 删除</button>
      </div>`;
    li.onclick = () => selectProject(p.id);
    li.querySelectorAll("button[data-act]").forEach((btn) => {
      btn.onclick = (e) => { e.stopPropagation(); projectAction(p, btn.dataset.act); };
    });
    ul.appendChild(li);
  };

  // 分组：按项目源码所在工作目录分组，避免维护与文件位置脱节的额外配置。
  const groups = new Map();
  for (const p of active) {
    const key = p.source_dir || "工作台默认目录";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  for (const [location, items] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh-CN"))) {
    const h = document.createElement("div");
    h.className = "proj-group";
    h.title = location;
    h.textContent = `⌂ ${location}（${items.length}）`;
    ul.appendChild(h);
    items.forEach(renderItem);
  }

  // 归档区
  if (archived.length > 0) {
    const toggle = document.createElement("div");
    toggle.className = "archived-toggle";
    toggle.textContent = `${showArchived ? "▾" : "▸"} 已归档（${archived.length}）`;
    toggle.onclick = () => { showArchived = !showArchived; renderProjectList(); };
    ul.appendChild(toggle);
    if (showArchived) archived.forEach(renderItem);
  }
}

async function projectAction(p, act) {
  const id = p.id;
  if (act === "rename") {
    const name = prompt("重命名项目：", p.name || p.id);
    if (!name || !name.trim()) return;
    await actionWith("rename", { name: name.trim() }, id);
  } else if (act === "archive") {
    await actionWith("archive", { archived: !p.archived }, id);
  } else if (act === "delete") {
    if (!confirm(`确认删除项目「${p.name}」？\n该操作会删除项目目录与全部执行记录，不可恢复。`)) return;
    await actionWith("delete", {}, id);
    if (currentProjectId === id) {
      currentProjectId = null;
      $("#detail").classList.add("hidden");
      $("#createView").classList.add("hidden");
      $("#emptyHint").classList.remove("hidden");
      const curpBox = $("#currentProjBox");
      if (curpBox) curpBox.classList.add("hidden");
    }
  }
}

// 针对指定项目发 action 请求（区别于当前项目）
async function actionWith(action, payload, id = currentProjectId) {
  if (!id) return;
  try {
    await api(`/api/projects/${encodeURIComponent(id)}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
    });
    await refresh();
  } catch (e) { alert(`操作失败: ${e.message}`); }
}

function selectProject(id) {
  currentProjectId = id;
  lastChatSig = null;
  lastChatCount = 0;
  lastTasksSig = null;
  $("#emptyHint").classList.add("hidden");
  $("#createView").classList.add("hidden");
  $("#detail").classList.remove("hidden");
  const curpBox = $("#currentProjBox");
  if (curpBox) curpBox.classList.remove("hidden");
  refreshDetail();
}

async function refreshDetail() {
  if (!currentProjectId) return;
  try {
    const d = await api(`/api/projects/${encodeURIComponent(currentProjectId)}`);
    $("#dName").textContent = `${d.name}（${d.id}）`;
    const curpName = $("#curpName");
    if (curpName) curpName.textContent = d.name;
    const curpBox = $("#currentProjBox");
    if (curpBox) curpBox.classList.remove("hidden");
    badge(d.state);
    $("#dMeta").innerHTML = `
      状态机：<b>${d.state}</b> ← ${d.previous_state || "-"} ｜ 更新：${(d.updated_at || "").replace("T", " ").slice(0, 19)}
      ｜ 错误次数：${d.error_count} ｜ GPT 会话：${d.gpt?.conversation_url ? `<a href="${escapeHtml(d.gpt.conversation_url)}" target="_blank">打开</a>` : "（未创建）"}
      ｜ 模型：${escapeHtml(d.gpt?.model_selected || "默认")}`;
    $("#dMeta").innerHTML += `<br>GPT 上下文文件: <code>${escapeHtml(d.workspace_dir || "")}</code> ｜ 源码目录: <code>${escapeHtml(d.source_dir || "")}</code>`;
    $("#dMeta").innerHTML += `<br>${d.archived ? "已归档 ｜ " : ""}DeepSeek 模型：${d.deepseek_selection?.model ? escapeHtml(`${d.deepseek_selection.provider || "deepseek-official"}/${d.deepseek_selection.model}${d.deepseek_selection.reasoningEffort ? " · 推理=" + d.deepseek_selection.reasoningEffort : ""}`) : "跟随默认"}`;
    const dst = d.usage?.deepseek?.totals || {};
    const ctx = d.usage?.deepseek?.context;
    const gu = d.usage?.gpt || {};
    $("#dMeta").innerHTML += `<br>DeepSeek Token（真实）：输入 ${fmtTokens(dst.uncachedInputTokens)} · 输出 ${fmtTokens(dst.outputTokens)} · 缓存读 ${fmtTokens(dst.cacheReadTokens)} · 缓存写 ${fmtTokens(dst.cacheWriteTokens)}${ctx?.percentage != null ? ` ｜ 上下文 ${ctx.percentage}%` : " ｜ 上下文投影不可用"} ｜ GPT Token（估算）：输入 ${fmtTokens(gu.estimatedInputTokens)} · 输出 ${fmtTokens(gu.estimatedOutputTokens)}`;
    if (d.compaction?.pending) $("#dMeta").innerHTML += "<br>会话压缩：已排队，将在当前任务结束后执行";
    // 项目文件夹：空路径显示占位，长路径 title 全文
    const dirHint = $("#dirHint");
    if (dirHint) {
      const src = d.source_dir || "";
      dirHint.textContent = src || "默认工作台目录（未指定）";
      dirHint.title = src || "默认工作台目录（未指定）";
      dirHint.dataset.path = src;
      dirHint.classList.toggle("empty", !src);
    }
    const composerDirLabel = $("#composerDirLabel");
    if (composerDirLabel) {
      composerDirLabel.textContent = d.source_dir || "默认工作目录";
      composerDirLabel.title = d.source_dir || "默认工作目录";
    }

    // 同步本项目 DeepSeek 模型选择到 Composer（正在编辑时不做覆盖）
    if (document.activeElement !== $("#cModel") && document.activeElement !== $("#cReasoning")) {
      const sel = d.deepseek_selection;
      const val = sel?.model ? modelValue(sel.provider || "deepseek-official", sel.model) : "";
      if ($("#cModel").value !== val) $("#cModel").value = val;
      const eff = sel?.reasoningEffort || "";
      if ($("#cReasoning").value !== eff) $("#cReasoning").value = eff;
    }

    const pending = d.pending;
    if (pending && pending.text && !["COMPLETED"].includes(d.state)) {
      $("#dPending").classList.remove("hidden");
      const elapsed = d.pending_elapsed_s != null ? `（已等待 ${fmtDuration(d.pending_elapsed_s)}）` : "";
      $("#dPending").textContent = `📌 ${pending.text}${elapsed}`;
    } else {
      $("#dPending").classList.add("hidden");
    }

    // DeepSeek 执行窗口（实时可见执行过程）
    const eui = d.executor_ui;
    if (eui && eui.url) {
      $("#dExecUi").classList.remove("hidden");
      const running = d.state === "WAITING_FOR_EXECUTOR" || d.state === "EXECUTING" || d.state === "ANALYZING" || d.state === "DECISION_REQUIRED";
      const sessions = (eui.sessions || []).map((s) => `${escapeHtml(s.taskId || "")}`).join("、");
      $("#dExecUi").innerHTML = `
        <span class="pulse"></span>
        <div class="l-text">🖥 DeepSeek 执行窗口${running ? "（执行中，实时可见）" : "（最近执行可回顾）"}</div>
        <div class="l-sub"><a href="${escapeHtml(eui.url)}" target="_blank" rel="noopener">${escapeHtml(eui.url)}</a>${sessions ? ` · 会话任务: ${sessions}` : ""} · 首个任务会自动打开，后续任务复用同一窗口</div>`;
    } else {
      $("#dExecUi").classList.add("hidden");
    }

    // GPT 实时状态
    const live = d.gpt_live;
    if (live && live.phase && live.phase !== "idle") {
      const el = $("#dGptLive");
      el.classList.remove("hidden");
      el.className = "gpt-live";
      const labels = {
        navigating: "🧭 正在打开 ChatGPT…",
        sending: "📤 正在发送消息…",
        waiting_reply: "⏳ 等待 GPT 回复…",
        thinking: "💭 GPT 正在思考（推理中）…",
        answering: "✍️ GPT 正在回答…",
        complete: "✅ GPT 回复完成",
      };
      let label = labels[live.phase] || live.phase;
      const t = fmtDuration(Math.max(0, Math.round((live.elapsedMs || 0) / 1000)));
      let sub = `已耗时 ${t}`;
      if (live.replyChars) sub += ` · 已生成 ${live.replyChars} 字`;
      if (live.slow) {
        sub += " · ⚠️ 长时间无进展：可能是长回答，超时机制会自动兜底；也可点击“显示浏览器”查看";
        el.classList.add("slow");
      }
      if (["thinking", "answering", "waiting_reply", "sending", "navigating"].includes(live.phase)) {
        el.innerHTML = `<span class="pulse"></span><div class="l-text">${label}</div><div class="l-sub">${sub}</div>`;
      } else {
        el.innerHTML = `<div class="l-text">${label}</div><div class="l-sub">${sub}</div>`;
      }
      if (live.phase === "thinking") el.classList.add("thinking");
      if (live.phase === "answering") el.classList.add("answering");
      if (live.phase === "complete") el.classList.add("complete");
    } else {
      $("#dGptLive").classList.add("hidden");
    }
    if (d.last_error && d.state === "ERROR") {
      $("#dError").classList.remove("hidden");
      $("#dError").textContent = `❌ ${d.last_error}`;
    } else {
      $("#dError").classList.add("hidden");
    }

    $("#oTask").textContent = d.user_task || "";
    $("#oCurrent").textContent = d.current_task
      ? `${d.current_task.id}（${d.current_task.priority}）\n${d.current_task.description || ""}\n依赖: ${(d.current_task.dependencies || []).join(", ") || "无"}`
      : "（无）";
    const runs = (d.executor_runs || []).slice(-8).reverse().map((r) =>
      `[${(r.ts || "").replace("T", " ").slice(0, 19)}] ${r.type} ${r.task_id || ""} attempt=${r.attempt} exit=${r.exitCode}${r.timedOut ? "（超时）" : ""}${r.visible ? "（可见窗口）" : ""} ${r.ms ? Math.round(r.ms / 1000) + "s" : ""}`
    ).join("\n");
    $("#oRuns").textContent = runs || "（尚无执行记录）";
    $("#oUsage").textContent = `DeepSeek（Harness 真实投影）\n输入 ${dst.uncachedInputTokens || 0} ｜ 输出 ${dst.outputTokens || 0} ｜ 缓存读 ${dst.cacheReadTokens || 0} ｜ 缓存写 ${dst.cacheWriteTokens || 0}\n上下文 ${ctx?.percentage != null ? `${ctx.percentage}%（${ctx.pressureTokens}/${ctx.contextWindow}）` : "投影不可用"} ｜ 压缩 ${d.compaction?.count || 0} 次\n\nGPT（网页字符折算，估算）\n发送 ${gu.sentCharacters || 0} 字 / 约 ${gu.estimatedInputTokens || 0} token ｜ 接收 ${gu.receivedCharacters || 0} 字 / 约 ${gu.estimatedOutputTokens || 0} token`;

    renderTasks(d);
    $("#planView").textContent = d.plan_text || "（暂无规划）";
    $("#analysisView").textContent = d.analysis_text || "（暂无分析，任务执行中自动生成）";
    renderChat(d.conversation || []);
    $("#logView").textContent = d.logs_tail || "（暂无日志）";
  } catch (e) {
    console.error(e);
  }
}

let lastTasksSig = null;
function renderTasks(d) {
  const sig = JSON.stringify({
    tasks: (d.tasks || []).map((t) => [t.id, t.description, t.priority, t.dependencies]),
    completed: (d.completed_tasks || []).map((t) => t.id),
    failed: (d.failed_tasks || []).map((t) => t.id),
    current: d.current_task?.id || null,
    metrics: (d.usage?.deepseek?.tasks || []).map((m) => [m.task_id, m.attempt, m.duration_ms, m.model, m.tokens, m.context]),
  });
  if (sig === lastTasksSig) return;
  lastTasksSig = sig;
  const tbody = $("#taskTable tbody");
  tbody.innerHTML = "";
  const completed = new Set((d.completed_tasks || []).map((t) => t.id));
  const failed = new Set((d.failed_tasks || []).map((t) => t.id));
  const metrics = d.usage?.deepseek?.tasks || [];
  for (const t of d.tasks || []) {
    let status = "pending";
    let cls = "pending";
    if (completed.has(t.id)) { status = "completed"; cls = "completed"; }
    else if (failed.has(t.id)) { status = "failed"; cls = "failed"; }
    else if (d.current_task && d.current_task.id === t.id) { status = "running"; cls = "running"; }
    const taskMetrics = metrics.filter((m) => m.task_id === t.id);
    const last = taskMetrics.at(-1);
    const model = last?.model;
    const modelText = model ? `${model.model || "默认"}${model.reasoningEffort ? ` / ${model.reasoningEffort}` : ""}` : "-";
    const duration = taskMetrics.reduce((sum, m) => sum + Number(m.duration_ms || 0), 0);
    const tokens = taskMetrics.reduce((sum, m) => sum + Number(tokenTotal(m.tokens) || 0), 0);
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><b>${escapeHtml(t.id)}</b></td><td>${escapeHtml(t.description || "")}</td><td>${escapeHtml(modelText)}</td><td>${duration ? fmtDuration(Math.round(duration / 1000)) : "-"}</td><td>${taskMetrics.length ? `${taskMetrics.length} 次${taskMetrics.length > 1 ? `（重试 ${taskMetrics.length - 1}）` : ""}` : "-"}</td><td>${taskMetrics.some((m) => m.actual) ? fmtTokens(tokens) : "不可用"}</td><td>${last?.context?.percentage != null ? `${last.context.percentage}%` : "-"}</td><td><span class="task-status ${cls}">${status === "running" ? "▶ 执行中" : status === "completed" ? "✔ 完成" : status === "failed" ? "✖ 失败" : "… 待办"}</span></td>`;
    tbody.appendChild(tr);
  }
}

let lastChatSig = null;
let lastChatCount = 0;
function renderChat(messages) {
  const list = messages || [];
  const box = $("#chatList");
  // 内容签名：无变化则跳过重渲染，避免每 2s 清空重建导致滚动条跳回顶部
  const sig = list.length + ":" + list.map((m) => `${m.dir}|${m.type || ""}|${m.length}|${m.ts || ""}`).join("~");
  if (sig === lastChatSig) return;
  const isNew = list.length > lastChatCount;
  const scroller = $("#convoView") || $(".main");
  const nearBottom = scroller && (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140);
  lastChatSig = sig;
  lastChatCount = list.length;
  box.innerHTML = "";
  for (const m of list) {
    const div = document.createElement("div");
    div.className = `chat-msg ${m.dir}`;
    const who = m.dir === "in" ? "GPT-5.6 Sol → 系统" : "系统 → GPT-5.6 Sol";
    div.innerHTML = `<div class="c-head"><span>${who}${m.type ? `（${escapeHtml(m.type)}）` : ""}</span><span>${(m.ts || "").replace("T", " ").slice(0, 19)}</span></div><div class="c-body">${escapeHtml(m.text || "")}</div>`;
    box.appendChild(div);
  }
  // 仅当新增消息且用户本就停在底部时自动跟随到底，其余情况保持用户当前滚动位置
  if (isNew && nearBottom && scroller) scroller.scrollTop = scroller.scrollHeight;
}

function fmtDuration(s) {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60}s`;
  return `${Math.floor(m / 60)}时${m % 60}分`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- 交互 ----------
function showCreateView() {
  currentProjectId = null;
  $("#emptyHint").classList.add("hidden");
  $("#detail").classList.add("hidden");
  $("#createView").classList.remove("hidden");
  $("#currentProjBox").classList.add("hidden");
  $("#projTask").focus();
}
$("#btnNewProject").addEventListener("click", showCreateView);

// 新建项目：点击选择本地项目文件夹（代替手动复制/输入路径）
$("#btnPickDir").onclick = async () => {
  try {
    $("#btnPickDir").disabled = true;
    $("#btnPickDir").textContent = "选择中…";
    const res = await pickFolder($("#projDir").value.trim());
    if (res && res.path) {
      $("#projDir").value = res.path;
      $("#projDirLabel").textContent = res.path;
      $("#projDir").style.borderColor = "var(--green)";
    }
  } catch (e) {
    alert(`选择文件夹失败：${e.message}\n\n你也可以直接在左侧输入框中手动填写绝对路径。`);
  } finally {
    $("#btnPickDir").disabled = false;
    $("#btnPickDir").textContent = "📁";
  }
};
$("#btnCreate").onclick = async () => {
  const task = $("#projTask").value.trim();
  const dir = $("#projDir").value.trim();
  if (!task) { alert("请先描述你想构建的内容"); $("#projTask").focus(); return; }
  try {
    $("#btnCreate").disabled = true;
    $("#btnCreate").textContent = "创建中…";
    const payload = { task };
    if (dir) payload.source_dir = dir;
    const sel = selectedModelPayload();
    if (sel) payload.deepseek_selection = sel;
    const res = await api("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    $("#projTask").value = "";
    $("#projDir").value = "";
    $("#projDirLabel").textContent = "未选择文件夹（将使用工作台默认目录）";
    $("#projDir").style.borderColor = "";
    currentProjectId = res.id;
    $("#emptyHint").classList.add("hidden");
    $("#createView").classList.add("hidden");
    $("#detail").classList.remove("hidden");
    await refresh();
  } catch (e) {
    alert(`创建失败: ${e.message}`);
  } finally {
    $("#btnCreate").disabled = false;
    $("#btnCreate").textContent = "↑";
  }
};

async function action(name) {
  if (!currentProjectId) return;
  try {
    await api(`/api/projects/${encodeURIComponent(currentProjectId)}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: name }),
    });
    await refreshDetail();
  } catch (e) { alert(`操作失败: ${e.message}`); }
}
$("#btnPause").onclick = () => action("pause");
$("#btnResume").onclick = () => action("resume");
$("#btnRetry").onclick = () => action("retry");
$("#btnCompact").onclick = () => action("compact_session");
$("#btnEnd").onclick = () => {
  if (confirm("确定结束这个项目？\n正在运行的任务会被终止，项目记录会保留，但结束后不能继续。")) action("end");
};

// 修改项目文件夹：改为点击按钮 → 弹出系统文件夹选择器（不再用 prompt 输入）
$("#btnSetDir").onclick = async () => {
  if (!currentProjectId) return;
  const dh = $("#dirHint");
  const cur = (dh && dh.dataset.path) || "";
  try {
    $("#btnSetDir").disabled = true;
    $("#btnSetDir").textContent = "选择中…";
    const res = await pickFolder(cur);
    if (!res || !res.path) return; // 用户取消
    await api(`/api/projects/${encodeURIComponent(currentProjectId)}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "setdir", dir: res.path }),
    });
    await refreshDetail();
  } catch (e) {
    alert(`修改失败: ${e.message}`);
  } finally {
    $("#btnSetDir").disabled = false;
    $("#btnSetDir").textContent = "修改";
  }
};
$("#btnComposerDir").onclick = () => $("#btnSetDir").click();

// 显示/隐藏浏览器窗口
let windowVisible = null;
$("#btnWindow").onclick = async () => {
  try {
    const show = windowVisible !== true; // 未知状态默认先显示
    const res = await api(`/api/projects/${encodeURIComponent(currentProjectId)}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: show ? "window_show" : "window_hide" }),
    });
    windowVisible = !!res.windowVisible;
    $("#btnWindow").textContent = windowVisible ? "🙈 隐藏浏览器" : "🖥 显示浏览器";
  } catch (e) { alert(`窗口操作失败: ${e.message}`); }
};

// 打开本项目的 DeepSeek 执行窗口（首个任务自动打开，此处用于手动重开/查看）
$("#btnExecWindow").onclick = async () => {
  if (!currentProjectId) return;
  try {
    $("#btnExecWindow").disabled = true;
    const res = await api(`/api/projects/${encodeURIComponent(currentProjectId)}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "executor_window" }),
    });
    if (res && res.url) {
      if (!res.opened) window.open(res.url, "_blank");
    } else {
      alert("当前没有运行中的执行窗口。\n执行窗口会在本项目首个 DeepSeek 任务开始时自动打开。");
    }
  } catch (e) {
    alert(`打开执行窗口失败: ${e.message}`);
  } finally {
    $("#btnExecWindow").disabled = false;
  }
};

// 保存本项目的 DeepSeek 模型选择：Composer 内模型/推理下拉变化即持久化（实际请求用所选配置）
let saveStatusTimer = null;
async function saveComposerModelSelection() {
  if (!currentProjectId) return;
  const v = splitModelValue($("#cModel").value);
  const effort = $("#cReasoning").value;
  const status = $("#composerSaveStatus");
  try {
    await api(`/api/projects/${encodeURIComponent(currentProjectId)}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "deepseek_model",
        selection: v ? { provider: v.provider, model: v.model, reasoningEffort: effort } : { provider: "", model: "", reasoningEffort: "" },
      }),
    });
    if (status) {
      status.textContent = `✓ 已保存 ${v ? `${v.provider}/${v.model}` : "默认"}${effort ? ` · 推理 ${effort}` : ""}`;
      status.classList.add("show");
      clearTimeout(saveStatusTimer);
      saveStatusTimer = setTimeout(() => { status.classList.remove("show"); status.textContent = ""; }, 3000);
    }
    await refreshDetail();
  } catch (e) {
    alert(`保存失败: ${e.message}`);
  }
}
const composerModel = $("#cModel");
const composerReasoning = $("#cReasoning");
if (composerModel) composerModel.addEventListener("change", saveComposerModelSelection);
if (composerReasoning) composerReasoning.addEventListener("change", saveComposerModelSelection);

// ---------- 底部输入区（Composer，TASK-004） ----------
const composerInput = $("#composerInput");
const composerSend = $("#btnComposerSend");

function autoGrow(el) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 180) + "px";
}

async function sendComposer() {
  if (!composerInput || !currentProjectId) return;
  const text = composerInput.value.trim();
  if (!text && composerAttachments.length === 0) return;
  if (composerSend) composerSend.disabled = true;
  const ready = composerAttachments.filter((a) => a.status === "success");
  const pending = composerAttachments.filter((a) => a.status === "uploading");
  if (pending.length) { alert("附件仍在上传，请稍候再发送。"); if (composerSend) composerSend.disabled = false; return; }
  const failed = composerAttachments.filter((a) => a.status === "failed");
  if (failed.length) { alert("有附件上传失败，请重试或移除后再发送。"); if (composerSend) composerSend.disabled = false; return; }
  try {
    await api(`/api/projects/${encodeURIComponent(currentProjectId)}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, attachment_ids: ready.map((a) => a.serverId) }),
    });
    composerInput.value = "";
    autoGrow(composerInput);
    clearAttachments();
    await refreshDetail();
  } catch (e) {
    alert(`发送失败: ${e.message}`);
  } finally {
    if (composerSend) composerSend.disabled = false;
  }
}

if (composerInput) {
  composerInput.addEventListener("input", () => autoGrow(composerInput));
  // 拖拽上传已关闭，但阻止浏览器默认打开文件，避免误离开工作台。
  ["dragover", "drop"].forEach((eventName) => composerInput.addEventListener(eventName, (e) => e.preventDefault()));
  composerInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendComposer();
    }
  });
}
if (composerSend) composerSend.addEventListener("click", sendComposer);

// ---------- 附件上传 ----------
const MAX_ATTACH_SIZE = 50 * 1024 * 1024; // 50MB
let composerAttachments = []; // {id,file,name,size,type,status,serverId?,reason?,preview?}
let attachSeq = 0;

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function fileIcon(name, type) {
  if (type && type.startsWith("image/")) return "🖼";
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (["pdf"].includes(ext)) return "📕";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "🗜";
  if (["doc", "docx", "txt", "md"].includes(ext)) return "📄";
  if (["xls", "xlsx", "csv"].includes(ext)) return "📊";
  return "📎";
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
  const a = composerAttachments.find((x) => x.id === id);
  if (!a || !a.file || !currentProjectId) return;
  a.status = "uploading";
  a.reason = "";
  renderAttachments();
  try {
    const data = await fileAsDataUrl(a.file);
    const res = await api(`/api/projects/${encodeURIComponent(currentProjectId)}/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: a.name, mime: a.type, data }),
    });
    const cur = composerAttachments.find((x) => x.id === id);
    if (cur) { cur.serverId = res.attachment.id; cur.status = "success"; }
  } catch (e) {
    const cur = composerAttachments.find((x) => x.id === id);
    if (cur) { cur.status = "failed"; cur.reason = e.message; }
  }
  renderAttachments();
}

function addFiles(fileList) {
  const files = Array.from(fileList || []);
  for (const f of files) {
    if (f.size > MAX_ATTACH_SIZE) {
      composerAttachments.push({ id: ++attachSeq, name: f.name, size: f.size, type: f.type, status: "failed", reason: "文件超过 50MB" });
      continue;
    }
    const id = ++attachSeq;
    const a = { id, file: f, name: f.name, size: f.size, type: f.type, status: "uploading" };
    if (f.type && f.type.startsWith("image/")) {
      try { a.preview = URL.createObjectURL(f); } catch (e) {}
    }
    composerAttachments.push(a);
    uploadAttachment(id);
  }
  renderAttachments();
}

function removeAttachment(id) {
  const i = composerAttachments.findIndex((x) => x.id === id);
  if (i < 0) return;
  if (composerAttachments[i].preview) URL.revokeObjectURL(composerAttachments[i].preview);
  composerAttachments.splice(i, 1);
  renderAttachments();
}

function retryAttachment(id) {
  const a = composerAttachments.find((x) => x.id === id);
  if (!a) return;
  uploadAttachment(id);
}

function clearAttachments() {
  for (const a of composerAttachments) { if (a.preview) URL.revokeObjectURL(a.preview); }
  composerAttachments = [];
  const list = $("#attachList");
  if (list) list.innerHTML = "";
}

function renderAttachments() {
  const list = $("#attachList");
  if (!list) return;
  if (composerAttachments.length === 0) { list.innerHTML = ""; return; }
  list.innerHTML = "";
  for (const a of composerAttachments) {
    const card = document.createElement("div");
    card.className = `attach-card ${a.status}`;
    card.dataset.id = a.id;
    const left = a.preview
      ? `<div class="attach-thumb"><img src="${a.preview}" alt="" /></div>`
      : `<div class="attach-icon">${fileIcon(a.name, a.type)}</div>`;
    let statusHtml;
    if (a.status === "uploading") statusHtml = `<span class="attach-state uploading"><span class="spinner"></span>上传中</span>`;
    else if (a.status === "success") statusHtml = `<span class="attach-state success">✓ 已就绪</span>`;
    else statusHtml = `<span class="attach-state failed" title="${escapeHtml(a.reason || "")}">✖ 失败${a.reason ? `：${escapeHtml(a.reason)}` : ""}</span>`;
    const actionsHtml = a.status === "failed"
      ? `<button class="attach-act retry" data-act="retry" title="重试">↻</button><button class="attach-act remove" data-act="remove" title="移除">×</button>`
      : `<button class="attach-act remove" data-act="remove" title="移除">×</button>`;
    card.innerHTML = `
      ${left}
      <div class="attach-info">
        <div class="attach-name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</div>
        <div class="attach-meta">${fmtSize(a.size)} · ${statusHtml}</div>
      </div>
      <div class="attach-actions">${actionsHtml}</div>`;
    card.querySelectorAll("[data-act]").forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const id = Number(card.dataset.id);
        if (btn.dataset.act === "remove") removeAttachment(id);
        else if (btn.dataset.act === "retry") retryAttachment(id);
      };
    });
    list.appendChild(card);
  }
}

// 上传入口
const fileInput = $("#fileInput");
const photoInput = $("#photoInput");
const btnAttach = $("#btnAttach");
const btnAttachPhoto = $("#btnAttachPhoto");
if (btnAttach && fileInput) btnAttach.addEventListener("click", () => fileInput.click());
if (btnAttachPhoto && photoInput) btnAttachPhoto.addEventListener("click", () => photoInput.click());
if (fileInput) fileInput.addEventListener("change", () => { addFiles(fileInput.files); fileInput.value = ""; });
if (photoInput) photoInput.addEventListener("change", () => { addFiles(photoInput.files); photoInput.value = ""; });

// Tabs
$$(".tab").forEach((t) => {
  t.onclick = () => {
    $$(".tab").forEach((x) => x.classList.remove("active"));
    $$(".tab-body").forEach((x) => x.classList.add("hidden"));
    t.classList.add("active");
    const name = t.dataset.tab;
    const convo = $("#convoView");
    if (name === "chat") {
      if (convo) convo.classList.remove("hidden");
    } else {
      if (convo) convo.classList.add("hidden");
      const body = $(`#tab-${name}`);
      if (body) body.classList.remove("hidden");
    }
  };
});

// 主题切换（深浅色，默认浅色，贴近创建页的 Harness 风格）
const themeBtn = $("#btnTheme");
function applyTheme(t) {
  const theme = t === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem("wb-theme", theme); } catch (e) {}
  if (themeBtn) themeBtn.textContent = theme === "light" ? "☀️ 浅色" : "🌙 深色";
}
if (themeBtn) {
  themeBtn.addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    applyTheme(cur === "light" ? "dark" : "light");
  });
}
(function initTheme() {
  let t = "light";
  try { t = localStorage.getItem("wb-theme") || "light"; } catch (e) {}
  applyTheme(t);
})();

// 轮询
populateModelSelects();
refresh();
setInterval(refresh, 2000);
