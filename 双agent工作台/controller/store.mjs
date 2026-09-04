// 项目存储：创建项目工作区、状态读写（project_state.json）、项目枚举
// 目录结构（每个项目）：
//   projects/<id>/
//     .gpt_workspace/
//       project_state.json      —— 状态机当前状态与历史（断点恢复的核心）
//       project_plan.md         —— GPT 最新规划（原始文本）
//       project_analysis.md     —— DeepSeek 生成的项目分析
//       gpt_context.md          —— 发送给 GPT 的项目上下文摘要
//       conversation/gpt/       —— 每条收发的消息日志（JSON）
//       analysis/               —— 历次分析报告
//       logs/                   —— 项目级日志
//       executor_reports/       —— DeepSeek 每项任务的执行报告
//       inbox/task.json         —— 编排器 → DeepSeek 的任务信封
//       inbox/task_prompt.txt   —— 编排器 → DeepSeek 的完整提示词
//       outbox/message.json     —— DeepSeek → 编排器的结果信封
//     source/                   —— DeepSeek 的工作目录（真实项目代码）
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const VALID_STATES = new Set([
  "INIT",
  "WAITING_FOR_LOGIN",
  "GPT_PLANNING",
  "PLAN_READY",
  "EXECUTING",
  "WAITING_FOR_EXECUTOR",
  "ANALYZING",
  "WAITING_FOR_GPT",
  "GPT_REVIEW",
  "DECISION_REQUIRED",
  "REPLANNING",
  "ERROR",
  "COMPLETED",
  "CANCELED",
  "PAUSED",
]);

export function slugify(name) {
  return String(name || "project")
    .trim()
    .replace(/[\\/:*?"<>|\r\n\t]+/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 40) || "project";
}

export function newProjectId(name) {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${date}-${slugify(name)}`;
}

export function initialProjectState(projectId, name, task) {
  return {
    schema: 3,
    project_id: projectId,
    project_name: name,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    user_task: task,
    source_dir: null, // 用户指定的项目文件夹（绝对路径）；null = 使用默认 projects/<id>/source
    state: "INIT",
    previous_state: null,
    error_count: 0,
    last_error: null,
    protocol_reprompts: 0,
    archived: false,     // 是否已归档
    deepseek_selection: null, // 项目级 DeepSeek 模型选择 {provider, model, reasoningEffort}
    gpt: {
      conversation_url: null,
      intro_sent: false,
      instructions: null, // 仅在规范附件随消息发送成功后记录；旧项目首次发送时补齐。
      last_reply_text: null,
      last_reply_ts: null,
      model_selected: null,
      models_available: [],
      assistant_message_count: 0,
    },
    plan: {
      raw: null,
      parsed: null,
      updated_at: null,
    },
    tasks: [],
    current_task: null,
    completed_tasks: [],
    failed_tasks: [],
    decisions: [],
    replans: [],
    gpt_messages: [],
    executor_runs: [],
    analysis_reports: [],
    usage: defaultUsage(),
    session_generations: [],
    session: null,
    current_dispatch_id: null,
    processed_dispatch_ids: [],
    validation_results: {},
    executor: {
      type: "deepseek",
      capabilities: { modelSelection: true, sessionResume: true, usage: true, visibleWindow: true },
    },
    pending_model_replan: null,
    pending_task_review: null,
    task_reviews: [],
    compaction: { pending: false, in_progress: false, count: 0, last: null },
    checkpoint: null,
    model_recommendations: [],
    pending: null, // 编排器内部挂起动作说明（人类可读）
    milestone: null,
  };
}

export function defaultUsage() {
  return {
    deepseek: {
      actual: true,
      totals: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      tasks: [],
      context: null,
    },
    gpt: {
      actual: false,
      estimate: true,
      sentCharacters: 0,
      receivedCharacters: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
    },
  };
}

/** 旧项目惰性补默认值：读取即可用，只有后续真实写入时才升级磁盘 schema。 */
export function normalizeProjectState(state) {
  if (!state) return null;
  const defaults = defaultUsage();
  const executorType = state.executor?.type || "deepseek";
  const executorDefaults = executorType === "cli"
    ? { modelSelection: false, sessionResume: false, usage: false, visibleWindow: false }
    : { modelSelection: true, sessionResume: true, usage: true, visibleWindow: true };
  return {
    ...state,
    schema: 3,
    usage: {
      ...defaults,
      ...(state.usage || {}),
      deepseek: { ...defaults.deepseek, ...(state.usage?.deepseek || {}) },
      gpt: { ...defaults.gpt, ...(state.usage?.gpt || {}) },
    },
    session_generations: state.session_generations || [],
    session: state.session || null,
    current_dispatch_id: state.current_dispatch_id || null,
    processed_dispatch_ids: state.processed_dispatch_ids || [],
    validation_results: state.validation_results || {},
    executor: {
      type: executorType,
      capabilities: {
        ...executorDefaults,
        ...(state.executor?.capabilities || {}),
      },
    },
    pending_model_replan: state.pending_model_replan || null,
    compaction: { pending: false, in_progress: false, count: 0, last: null, ...(state.compaction || {}) },
    checkpoint: state.checkpoint || null,
    model_recommendations: state.model_recommendations || [],
  };
}

export class ProjectStore {
  constructor(projectsRoot, logger) {
    this.projectsRoot = path.resolve(projectsRoot);
    this.logger = logger;
    fs.mkdirSync(this.projectsRoot, { recursive: true });
  }

  workspaceDir(projectId) {
    this.assertProjectId(projectId);
    return path.join(this.projectsRoot, projectId, ".gpt_workspace");
  }

  assertProjectId(projectId) {
    const id = String(projectId || "");
    if (!id || id === "." || id === ".." || /[\\/:*?"<>|\r\n\t]/.test(id)) {
      throw new Error("非法项目 ID");
    }
    return id;
  }

  resolveWorkspacePath(projectId, relPath) {
    const ws = path.resolve(this.workspaceDir(projectId));
    let rel = String(relPath || "").replace(/\\/g, "/");
    if (rel === ".gpt_workspace") rel = "";
    else if (rel.startsWith(".gpt_workspace/")) rel = rel.slice(".gpt_workspace/".length);
    const file = path.resolve(ws, rel);
    const relative = path.relative(ws, file);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      throw new Error("工作区路径越界");
    }
    return file;
  }

  /**
   * 项目源码目录：用户指定（绝对路径）优先，否则用默认 projects/<id>/source。
   * 执行者（DeepSeek）与项目分析都在此目录工作；路径失效时禁止静默切换目录。
   */
  sourceDir(projectId) {
    const status = this.sourceDirStatus(projectId);
    if (status.error) throw new Error(status.error);
    return status.path;
  }

  /** 列表和详情仍需展示失效路径，让用户能重新选择目录。读取不改写已有项目。 */
  sourceDirStatus(projectId) {
    const defaultDir = path.join(this.projectDir(projectId), "source");
    const st = this.readState(projectId);
    if (!st) return { path: defaultDir, error: `项目不存在: ${projectId}` };
    const raw = st.source_dir ? String(st.source_dir) : defaultDir;
    if (!path.isAbsolute(raw)) {
      return { path: raw, error: `项目文件夹必须是绝对路径，请重新选择项目文件夹: ${raw}` };
    }
    const resolved = path.resolve(raw);
    try {
      if (fs.statSync(resolved).isDirectory()) return { path: resolved, error: null };
    } catch { /* 目录已搬移、删除或不可访问，必须由用户重新选择。 */ }
    return {
      path: resolved,
      error: `项目文件夹不存在、不可访问或不是目录，请重新选择项目文件夹: ${resolved}`,
    };
  }

  projectDir(projectId) {
    return path.join(this.projectsRoot, this.assertProjectId(projectId));
  }

  createProject(name, task, sourceDir) {
    let id = newProjectId(name);
    let dir = this.projectDir(id);
    if (fs.existsSync(dir)) {
      dir = dir + "-" + Date.now().toString(36);
      id = path.basename(dir); // 目录冲突时以实际目录名为准
    }
    const ws = path.join(dir, ".gpt_workspace");
    for (const sub of [
      "", "conversation/gpt", "analysis", "logs", "executor_reports",
      "inbox", "outbox",
    ]) {
      fs.mkdirSync(path.join(ws, sub), { recursive: true });
    }
    fs.mkdirSync(path.join(dir, "source"), { recursive: true });
    const state = initialProjectState(id, name, task);
    // 用户指定项目文件夹：校验并创建
    if (sourceDir && String(sourceDir).trim()) {
      const raw = String(sourceDir).trim();
      if (!path.isAbsolute(raw)) {
        throw new Error(`项目文件夹必须是绝对路径: ${sourceDir}`);
      }
      const p = path.resolve(raw);
      fs.mkdirSync(p, { recursive: true });
      state.source_dir = p;
      this.logger?.info("store", `项目文件夹（用户指定）: ${p}`);
    }
    this.writeState(id, state);
    fs.writeFileSync(path.join(ws, "gpt_context.md"), `# 项目上下文：${name}\n\n创建时间：${new Date().toISOString()}\n\n用户任务：\n\n${task}\n`, "utf8");
    this.logger?.info("store", `项目已创建: ${id}（${name}）`);
    return id;
  }

  listProjects() {
    if (!fs.existsSync(this.projectsRoot)) return [];
    const out = [];
    for (const entry of fs.readdirSync(this.projectsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const state = this.readState(entry.name);
      if (!state) continue;
      const source = this.sourceDirStatus(entry.name);
      out.push({
        id: entry.name,
        name: state.project_name || entry.name,
        state: state.state,
        updated_at: state.updated_at,
        created_at: state.created_at,
        source_dir: source.path,
        source_dir_error: source.error,
        archived: !!state.archived,
      });
    }
    out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return out;
  }

  /** 删除项目目录（含 .gpt_workspace 与 source） */
  deleteProject(projectId) {
    const dir = this.projectDir(projectId);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      this.logger?.info("store", `项目目录已删除: ${projectId}`);
    } catch (e) {
      throw new Error(`删除项目目录失败: ${e.message}`);
    }
  }

  readState(projectId) {
    try {
      const file = path.join(this.workspaceDir(projectId), "project_state.json");
      return normalizeProjectState(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      return null;
    }
  }

  writeState(projectId, patchOrState) {
    const ws = this.workspaceDir(projectId);
    fs.mkdirSync(ws, { recursive: true });
    const file = path.join(ws, "project_state.json");
    let next = patchOrState;
    const cur = this.readState(projectId);
    if (cur && !Array.isArray(patchOrState) && patchOrState && !patchOrState.schema) {
      // 视为增量补丁：浅合并顶层 + 深合并嵌套对象
      next = { ...cur, ...patchOrState, updated_at: new Date().toISOString() };
      for (const key of ["gpt", "plan", "pending"]) {
        if (patchOrState[key] && typeof patchOrState[key] === "object") {
          next[key] = { ...(cur[key] || {}), ...patchOrState[key] };
        }
      }
    }
    next.updated_at = new Date().toISOString();
    if (next.state && !VALID_STATES.has(next.state)) {
      throw new Error(`非法状态: ${next.state}`);
    }
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return next;
  }

  /** 更新状态并记录 previous_state */
  transition(projectId, newState, extra = {}) {
    const cur = this.readState(projectId);
    if (!cur) throw new Error(`项目不存在: ${projectId}`);
    const patch = {
      state: newState,
      previous_state: cur.state,
      ...extra,
    };
    return this.writeState(projectId, patch);
  }

  recordGptMessage(projectId, dir, text, meta = {}) {
    const ws = this.workspaceDir(projectId);
    const folder = path.join(ws, "conversation", "gpt");
    fs.mkdirSync(folder, { recursive: true });
    const n = this.countFiles(folder) + 1;
    const file = path.join(folder, `${String(n).padStart(4, "0")}_${dir}.json`);
    const chars = String(text || "").length;
    // 内置规范移到附件仍需被模型读取，不能把附件排除后误报 token 节省。
    const attachmentChars = dir === "out" ? Number(meta.instruction_attachment?.characters || 0) : 0;
    const estimatedTokens = Math.ceil((chars + attachmentChars) / 4);
    const usage = {
      actual: false,
      estimate: true,
      characters: chars,
      attachmentCharacters: attachmentChars,
      estimatedTokens,
      direction: dir === "out" ? "input" : "output",
    };
    const rec = {
      dir, // "in" = GPT → 系统；"out" = 系统 → GPT
      ts: new Date().toISOString(),
      text,
      usage,
      ...meta,
    };
    fs.writeFileSync(file, JSON.stringify(rec, null, 2), "utf8");
    const state = this.readState(projectId);
    if (state) {
      const msgs = [...(state.gpt_messages || [])];
      msgs.push({ dir, ts: rec.ts, length: chars, file: path.basename(file), usage, ...meta });
      if (msgs.length > 200) msgs.splice(0, msgs.length - 200);
      const gptUsage = { ...(state.usage?.gpt || defaultUsage().gpt) };
      if (dir === "out") {
        gptUsage.sentCharacters += chars + attachmentChars;
        gptUsage.estimatedInputTokens += estimatedTokens;
      } else {
        gptUsage.receivedCharacters += chars;
        gptUsage.estimatedOutputTokens += estimatedTokens;
      }
      this.writeState(projectId, { gpt_messages: msgs, usage: { ...state.usage, gpt: gptUsage } });
    }
    return rec;
  }

  countFiles(dir) {
    try { return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length; } catch { return 0; }
  }

  listConversation(projectId, limit = Infinity) {
    const folder = path.join(this.workspaceDir(projectId), "conversation", "gpt");
    try {
      return fs.readdirSync(folder)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .slice(-limit)
        .map((f) => JSON.parse(fs.readFileSync(path.join(folder, f), "utf8")));
    } catch {
      return [];
    }
  }

  readFileSafe(projectId, relPath) {
    try {
      const file = this.resolveWorkspacePath(projectId, relPath);
      if (!fs.existsSync(file)) return null;
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  }

  writeWorkspaceFile(projectId, relPath, content) {
    const file = this.resolveWorkspacePath(projectId, relPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
    return file;
  }

  readOutbox(projectId) {
    return this.readOutboxStatus(projectId).data;
  }

  readOutboxStatus(projectId) {
    const file = path.join(this.workspaceDir(projectId), "outbox", "message.json");
    try {
      const raw = fs.readFileSync(file, "utf8");
      if (!raw.trim()) return { exists: true, complete: false, data: null, error: "empty" };
      return { exists: true, complete: true, data: JSON.parse(raw), error: null };
    } catch (error) {
      return { exists: fs.existsSync(file), complete: false, data: null, error: error.message };
    }
  }

  readInbox(projectId) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.workspaceDir(projectId), "inbox", "task.json"), "utf8"));
    } catch {
      return null;
    }
  }

  writeOutboxAtomic(projectId, value) {
    const file = path.join(this.workspaceDir(projectId), "outbox", "message.json");
    const tmp = file + `.tmp-${process.pid}-${Date.now()}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return file;
  }

  clearOutbox(projectId) {
    try {
      fs.unlinkSync(path.join(this.workspaceDir(projectId), "outbox", "message.json"));
    } catch { /* ignore */ }
  }

  checkpointExclusions(source) {
    const excluded = new Set([".git", ".gpt_workspace", "node_modules", ".pnpm-store", ".yarn", ".venv", "venv", "dist", "build", "out", "target", "coverage", ".cache"]);
    if (path.resolve(source) === path.dirname(path.resolve(this.projectsRoot))) {
      for (const name of ["browser-profile", path.basename(this.projectsRoot), "logs"]) excluded.add(name);
    }
    return excluded;
  }

  async createCheckpoint(projectId, taskId, dispatchId) {
    const source = path.resolve(this.sourceDir(projectId));
    if (source === path.parse(source).root) throw new Error("拒绝为磁盘根目录创建检查点");
    const safeTask = String(taskId || "task").replace(/[^a-z0-9_-]+/gi, "-");
    const safeDispatch = String(dispatchId || Date.now()).replace(/[^a-z0-9_-]+/gi, "-");
    const rel = path.join("checkpoints", `${safeTask}-${safeDispatch}`);
    const dir = this.resolveWorkspacePath(projectId, rel);
    const snapshot = path.join(dir, "source");
    const excluded = this.checkpointExclusions(source);
    await fs.promises.rm(dir, { recursive: true, force: true });
    await fs.promises.mkdir(snapshot, { recursive: true });
    try {
      if (fs.existsSync(source)) {
        // 逐个复制顶层条目，避免源码包含工作台时把检查点复制进自身。
        for (const entry of await fs.promises.readdir(source)) {
          if (excluded.has(entry)) continue;
          const from = path.join(source, entry);
          const relativeSnapshot = path.relative(from, snapshot);
          if (!relativeSnapshot || (!relativeSnapshot.startsWith(".." + path.sep) && relativeSnapshot !== ".." && !path.isAbsolute(relativeSnapshot))) {
            throw new Error("源码目录包含检查点目录，无法安全备份");
          }
          await fs.promises.cp(from, path.join(snapshot, entry), { recursive: true });
        }
      }
      const checkpoint = {
        task_id: String(taskId || ""),
        dispatch_id: String(dispatchId || ""),
        relative_path: rel.replace(/\\/g, "/"),
        source_dir: source,
        created_at: new Date().toISOString(),
        restored_at: null,
        status: "ready",
      };
      await fs.promises.writeFile(path.join(dir, "checkpoint.json"), JSON.stringify(checkpoint, null, 2), "utf8");
      if (!this.readState(projectId)) throw new Error("项目已删除，停止创建检查点");
      this.writeState(projectId, { checkpoint });
      return checkpoint;
    } catch (error) {
      await fs.promises.rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  restoreCheckpoint(projectId) {
    const st = this.readState(projectId);
    const checkpoint = st?.checkpoint;
    if (!checkpoint?.relative_path) throw new Error("没有可恢复的检查点");
    const dir = this.resolveWorkspacePath(projectId, checkpoint.relative_path);
    const snapshot = path.join(dir, "source");
    const source = path.resolve(this.sourceDir(projectId));
    if (source === path.parse(source).root || !fs.existsSync(snapshot)) throw new Error("检查点不可用或源码目录不安全");
    const excluded = this.checkpointExclusions(source);
    fs.mkdirSync(source, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      fs.rmSync(path.join(source, entry.name), { recursive: true, force: true });
    }
    for (const entry of fs.readdirSync(snapshot, { withFileTypes: true })) {
      fs.cpSync(path.join(snapshot, entry.name), path.join(source, entry.name), { recursive: true });
    }
    const restored = { ...checkpoint, restored_at: new Date().toISOString(), status: "restored" };
    this.writeState(projectId, { checkpoint: restored });
    return restored;
  }

  clearCheckpoint(projectId) {
    const checkpoint = this.readState(projectId)?.checkpoint;
    if (checkpoint?.relative_path) {
      const dir = this.resolveWorkspacePath(projectId, checkpoint.relative_path);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    this.writeState(projectId, { checkpoint: null });
  }

  exportAudit(projectId) {
    const st = this.readState(projectId);
    if (!st) throw new Error(`项目不存在: ${projectId}`);
    const lines = [
      `# ${st.project_name} 审计记录`,
      "",
      `- 导出时间：${new Date().toISOString()}`,
      `- 当前状态：${st.state}`,
      `- 执行器：${st.executor?.type || "deepseek"}`,
      `- 当前任务：${st.current_task?.id || "无"}`,
      `- 当前派发：${st.current_dispatch_id || "无"}`,
      "",
      "## 计划",
      "",
      st.plan?.raw || "（无）",
      "",
      "## 任务拆分校验",
      "",
      JSON.stringify(st.planning_check || { status: "尚未校验" }, null, 2),
      "",
      "## GPT 逐任务检查",
      "",
      JSON.stringify({ pending: st.pending_task_review || null, history: st.task_reviews || [] }, null, 2),
      "",
      "## 已完成任务",
      "",
      JSON.stringify(st.completed_tasks || [], null, 2),
      "",
      "## 失败任务",
      "",
      JSON.stringify(st.failed_tasks || [], null, 2),
      "",
      "## 验证结果",
      "",
      JSON.stringify(st.validation_results || {}, null, 2),
      "",
      "## 执行与恢复记录",
      "",
      JSON.stringify({ executor_runs: st.executor_runs || [], checkpoint: st.checkpoint, session_generations: st.session_generations || [] }, null, 2),
      "",
      "## 用量",
      "",
      JSON.stringify(st.usage || {}, null, 2),
    ];
    const content = lines.join("\n");
    this.writeWorkspaceFile(projectId, "audit-export.md", content);
    return { file: ".gpt_workspace/audit-export.md", content };
  }

  saveAttachment(projectId, name, mime, buffer) {
    if (!this.readState(projectId)) throw new Error(`项目不存在: ${projectId}`);
    const originalName = path.basename(String(name || "attachment")) || "attachment";
    const safeName = originalName.replace(/[\\/:*?"<>|\r\n\t]+/g, "-").slice(0, 120) || "attachment";
    const id = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
    const rel = path.join("attachments", `${id}-${safeName}`);
    const file = this.resolveWorkspacePath(projectId, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buffer);
    const rec = {
      id,
      name: originalName,
      mime: String(mime || "application/octet-stream"),
      size: buffer.length,
      relative_path: rel.replace(/\\/g, "/"),
      created_at: new Date().toISOString(),
    };
    fs.writeFileSync(this.resolveWorkspacePath(projectId, path.join("attachments", `${id}.json`)), JSON.stringify(rec, null, 2), "utf8");
    return rec;
  }

  getAttachments(projectId, ids) {
    const out = [];
    for (const rawId of Array.isArray(ids) ? ids : []) {
      const id = String(rawId || "");
      if (!/^[a-z0-9-]+$/i.test(id)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(this.resolveWorkspacePath(projectId, path.join("attachments", `${id}.json`)), "utf8"));
        const file = this.resolveWorkspacePath(projectId, meta.relative_path);
        if (fs.existsSync(file)) out.push(meta);
      } catch { /* 忽略无效或已删除附件 */ }
    }
    return out;
  }
}
