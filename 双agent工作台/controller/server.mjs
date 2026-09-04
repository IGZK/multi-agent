// 本地 Dashboard Web 服务器：项目总览、状态、计划、分析、对话、日志 + 控制按钮
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pickFolder } from "./folder_picker.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, "..", "web");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error("请求体过大")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { reject(new Error("JSON 解析失败")); }
    });
    req.on("error", reject);
  });
}

function decodeAttachment(input) {
  const encoded = String(input?.data || "").replace(/^data:[^,]*;base64,/, "").replace(/\s/g, "");
  if (!input?.name || !encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw Object.assign(new Error("附件数据无效"), { statusCode: 400 });
  }
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length > 50 * 1024 * 1024) throw Object.assign(new Error("附件超过 50MB"), { statusCode: 413 });
  return { name: String(input.name), mime: String(input.mime || "application/octet-stream"), buffer };
}

function readTextTail(file, maxBytes = 64 * 1024) {
  // ponytail: 64KB 足够容纳常规 60 行日志；超长单行出现时再改为分块向前读取。
  const size = fs.statSync(file).size;
  const length = Math.min(size, maxBytes);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, "r");
  try { fs.readSync(fd, buffer, 0, length, size - length); }
  finally { fs.closeSync(fd); }
  return buffer.toString("utf8").replace(/^\uFFFD/, "");
}

export class DashboardServer {
  constructor(config, logger, orchestrator, store, bridge, runner) {
    this.cfg = config;
    this.logger = logger;
    this.orchestrator = orchestrator;
    this.store = store;
    this.bridge = bridge;
    this.runner = runner;
    this.server = null;
  }

  projectDetail(projectId) {
    const st = this.store.readState(projectId);
    if (!st) return null;
    const dir = this.store.projectDir(projectId);
    const logFile = path.join(dir, ".gpt_workspace", "logs");
    let logsTail = "";
    try {
      const files = fs.readdirSync(logFile).filter((f) => f.endsWith(".log")).sort();
      const last = files[files.length - 1];
      if (last) {
        const content = readTextTail(path.join(logFile, last));
        logsTail = content.split(/\r?\n/).slice(-60).join("\n");
      }
    } catch { /* ignore */ }
    return {
      id: projectId,
      state: st.state,
      previous_state: st.previous_state,
      name: st.project_name,
      user_task: st.user_task,
      created_at: st.created_at,
      updated_at: st.updated_at,
      error_count: st.error_count,
      last_error: st.last_error,
      protocol_reprompts: st.protocol_reprompts,
      current_task: st.current_task,
      completed_tasks: st.completed_tasks,
      failed_tasks: st.failed_tasks,
      tasks: st.plan?.parsed?.tasks || [],
      decisions: st.decisions,
      replans: st.replans,
      analysis_reports: st.analysis_reports,
      executor_runs: (st.executor_runs || []).slice(-20),
      gpt: st.gpt,
      pending: st.pending,
      review_requested: !!st.review_requested,
      plan_text: this.store.readFileSafe(projectId, "project_plan.md"),
      analysis_text: this.store.readFileSafe(projectId, "project_analysis.md"),
      final_report: this.store.readFileSafe(projectId, "FINAL_REPORT.md"),
      gpt_context: this.store.readFileSafe(projectId, "gpt_context.md"),
      conversation: this.store.listConversation(projectId, 40),
      logs_tail: logsTail,
      source_dir: this.store.sourceDir(projectId),
      workspace_dir: this.store.workspaceDir(projectId),
      gpt_live: this.bridge?.getLive?.() || null,
      executor_ui: this.runner?.uiInfo?.(projectId) || null,
      archived: !!st.archived,
      deepseek_selection: st.deepseek_selection || null,
      usage: st.usage,
      session_generations: st.session_generations,
      pending_model_replan: st.pending_model_replan,
      compaction: st.compaction,
      checkpoint: st.checkpoint,
      current_dispatch_id: st.current_dispatch_id,
      validation_results: st.validation_results,
      executor: st.executor,
      model_recommendations: st.model_recommendations,
      pending_elapsed_s: ["COMPLETED", "CANCELED", "PAUSED"].includes(st.state)
        ? null
        : st.pending?.ts ? Math.round((Date.now() - new Date(st.pending.ts).getTime()) / 1000) : null,
    };
  }

  async handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    try {
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        const origin = req.headers?.origin;
        const port = this.cfg.dashboard?.port;
        const host = this.cfg.dashboard?.host || "127.0.0.1";
        const allowed = new Set([`http://${host}:${port}`, `http://127.0.0.1:${port}`, `http://localhost:${port}`]);
        if (origin && !allowed.has(origin)) return sendJson(res, 403, { error: "拒绝非本机 Dashboard 的写入请求" });
      }
      if (req.method === "GET" && p === "/") {
        return this.serveStatic(res, "index.html");
      }
      if (req.method === "GET" && (p === "/app.js" || p === "/style.css")) {
        return this.serveStatic(res, path.basename(p));
      }
      if (req.method === "GET" && p.startsWith("/assets/")) {
        return this.serveStatic(res, p.slice(1));
      }
      if (req.method === "GET" && p === "/api/projects") {
        return sendJson(res, 200, {
          projects: this.store.listProjects(),
          system: {
            bridge: await this.bridge.getSystemState({ probe: false }).catch(() => ({})),
            runner: this.runner.status(),
            mode: { gpt: this.cfg.gpt?.mode, deepseek: this.cfg.deepseek?.mode },
          },
        });
      }
      const m = p.match(/^\/api\/projects\/([^/]+)$/);
      if (m && req.method === "GET") {
        const detail = this.projectDetail(decodeURIComponent(m[1]));
        if (!detail) return sendJson(res, 404, { error: "项目不存在" });
        return sendJson(res, 200, detail);
      }
      if (p === "/api/pickdir" && req.method === "POST") {
        const body = await readBody(req);
        const startDir = body?.start_dir && String(body.start_dir).trim() ? String(body.start_dir).trim() : "";
        try {
          const dir = await pickFolder(startDir);
          return sendJson(res, 200, { path: dir || null, canceled: !dir });
        } catch (e) {
          return sendJson(res, 500, { error: String(e.message || e) });
        }
      }
      if (p === "/api/projects" && req.method === "POST") {
        const body = await readBody(req, 72 * 1024 * 1024);
        const task = String(body.task || "").trim();
        if (!task) return sendJson(res, 400, { error: "需要 task" });
        let sourceDir = null;
        if (body.source_dir && String(body.source_dir).trim()) {
          const raw = String(body.source_dir).trim();
          if (!path.isAbsolute(raw)) return sendJson(res, 400, { error: "项目文件夹必须是绝对路径" });
          const p = path.resolve(raw);
          try {
            fs.mkdirSync(p, { recursive: true });
            sourceDir = p;
          } catch (e) {
            return sendJson(res, 400, { error: `无法创建项目文件夹: ${e.message}` });
          }
        }
        // 项目名称不再由新建对话框单独填写：优先使用工作目录名，否则取任务首行。
        const firstTaskLine = task.split(/\r?\n/, 1)[0].trim();
        const inferredName = sourceDir ? path.basename(sourceDir) : firstTaskLine.slice(0, 40);
        const name = String(body.name || inferredName || "新项目").trim().slice(0, 80) || "新项目";
        const opts = {};
        if (body.deepseek_selection && typeof body.deepseek_selection === "object") {
          opts.deepseek_selection = {
            provider: String(body.deepseek_selection.provider || ""),
            model: String(body.deepseek_selection.model || ""),
            reasoningEffort: String(body.deepseek_selection.reasoningEffort || ""),
          };
        }
        if (body.executor_type) opts.executor_type = String(body.executor_type);
        try {
          opts.attachments = (Array.isArray(body.attachments) ? body.attachments : []).map(decodeAttachment);
        } catch (error) {
          return sendJson(res, error.statusCode || 400, { error: error.message });
        }
        const id = await this.orchestrator.createProject(name, task, sourceDir, opts);
        return sendJson(res, 201, { id });
      }
      const m2 = p.match(/^\/api\/projects\/([^/]+)\/action$/);
      if (m2 && req.method === "POST") {
        const body = await readBody(req);
        const id = decodeURIComponent(m2[1]);
        if (body.action === "pause") await this.orchestrator.pause(id);
        else if (body.action === "end") await this.orchestrator.endProject(id);
        else if (body.action === "resume") await this.orchestrator.resume(id);
        else if (body.action === "retry") await this.orchestrator.retry(id);
        else if (body.action === "retry_task") await this.orchestrator.retryTask(id);
        else if (body.action === "restore_checkpoint") {
          const checkpoint = await this.orchestrator.restoreCheckpoint(id);
          return sendJson(res, 200, { ok: true, checkpoint });
        }
        else if (body.action === "export_audit") {
          const audit = this.orchestrator.exportAudit(id);
          return sendJson(res, 200, { ok: true, ...audit });
        }
        else if (body.action === "compact_session") {
          const result = await this.orchestrator.compactSession(id);
          return sendJson(res, 200, { ok: true, ...result });
        }
        else if (body.action === "setdir") {
          try { await this.orchestrator.setSourceDir(id, body.dir); }
          catch (e) { return sendJson(res, 400, { error: String(e.message) }); }
        } else if (body.action === "rename") {
          try { await this.orchestrator.renameProject(id, body.name); }
          catch (e) { return sendJson(res, 400, { error: String(e.message) }); }
        } else if (body.action === "archive") {
          try { await this.orchestrator.setProjectArchived(id, body.archived); }
          catch (e) { return sendJson(res, 400, { error: String(e.message) }); }
        } else if (body.action === "deepseek_model") {
          try { await this.orchestrator.setProjectDeepseekSelection(id, body.selection); }
          catch (e) { return sendJson(res, 400, { error: String(e.message) }); }
        } else if (body.action === "select_executor") {
          try { await this.orchestrator.selectExecutor(id, body.executor_type); }
          catch (e) { return sendJson(res, 400, { error: String(e.message) }); }
        } else if (body.action === "delete") {
          try { await this.orchestrator.deleteProject(id); }
          catch (e) { return sendJson(res, 400, { error: String(e.message) }); }
          return sendJson(res, 200, { ok: true, deleted: true });
        } else if (body.action === "window_show") {
          const v = await this.orchestrator.toggleWindow(true);
          return sendJson(res, 200, { ok: true, windowVisible: v });
        } else if (body.action === "window_hide") {
          const v = await this.orchestrator.toggleWindow(false);
          return sendJson(res, 200, { ok: true, windowVisible: v });
        } else if (body.action === "executor_window") {
          // 重新打开（或查询）本项目的 DeepSeek 执行窗口
          const ui = this.runner?.openUiWindow?.(id) || null;
          if (!ui) return sendJson(res, 200, { ok: true, url: null, hint: "当前没有运行中的执行窗口（仅在 DeepSeek 执行任务时存在）。" });
          return sendJson(res, 200, { ok: true, url: ui.url, opened: ui.opened });
        } else return sendJson(res, 400, { error: "未知 action" });
        return sendJson(res, 200, { ok: true });
      }
      const ma = p.match(/^\/api\/projects\/([^/]+)\/attachments$/);
      if (ma && req.method === "POST") {
        const body = await readBody(req, 72 * 1024 * 1024);
        const id = decodeURIComponent(ma[1]);
        let decoded;
        try { decoded = decodeAttachment(body); }
        catch (error) { return sendJson(res, error.statusCode || 400, { error: error.message }); }
        const attachment = this.store.saveAttachment(id, decoded.name, decoded.mime, decoded.buffer);
        return sendJson(res, 201, { attachment });
      }
      const m3 = p.match(/^\/api\/projects\/([^/]+)\/message$/);
      if (m3 && req.method === "POST") {
        const body = await readBody(req);
        const id = decodeURIComponent(m3[1]);
        const attachments = this.store.getAttachments(id, body.attachment_ids);
        const text = String(body.text || "").trim();
        if (!text && attachments.length === 0) return sendJson(res, 400, { error: "需要消息或附件" });
        const files = attachments.map((a) => `- ${a.name}: ${this.store.resolveWorkspacePath(id, a.relative_path)}`).join("\n");
        const message = files ? `[本地附件]\n${files}\n\n${text || "请读取并分析这些附件。"}` : text;
        await this.orchestrator.injectMessage(id, message, attachments);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "GET" && p === "/api/deepseek/models") {
        try {
          const catalog = await this.runner.probeModels();
          return sendJson(res, 200, catalog);
        } catch (e) {
          return sendJson(res, 500, { error: String(e.message || e) });
        }
      }
      const m4 = p.match(/^\/api\/projects\/([^/]+)$/);
      if (m4 && req.method === "DELETE") {
        const id = decodeURIComponent(m4[1]);
        try {
          await this.orchestrator.deleteProject(id);
          return sendJson(res, 200, { ok: true, deleted: true });
        } catch (e) {
          return sendJson(res, 400, { error: String(e.message || e) });
        }
      }
      if (req.method === "GET" && p === "/api/system") {
        return sendJson(res, 200, {
          bridge: await this.bridge.getSystemState().catch(() => ({})),
          runner: this.runner.status(),
          mode: { gpt: this.cfg.gpt?.mode, deepseek: this.cfg.deepseek?.mode },
          log: this.logger.tailText(300),
        });
      }
      return sendJson(res, 404, { error: `未知路径: ${p}` });
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  }

  serveStatic(res, name) {
    const file = path.resolve(WEB_DIR, name);
    if (file !== WEB_DIR && !file.startsWith(WEB_DIR + path.sep)) { res.writeHead(403); return res.end("forbidden"); }
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    return res.end(fs.readFileSync(file));
  }

  start() {
    const { host, port } = this.cfg.dashboard;
    this.server = http.createServer((req, res) => this.handle(req, res));
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.logger.info("dashboard", `Dashboard: http://${host}:${port}`);
        resolve(this.server);
      });
    });
  }
}
