// 可见执行模块：为每个项目维护一个独立的 DeepSeek Harness Web 服务（专属端口），
// 通过官方 HTTP RPC（/api/<method>）创建会话并提交任务，让用户能在浏览器窗口中
// 实时看到"当前正在执行的任务"。会话内容、工具调用、思考过程全部实时可见。
//
// RPC 信封：POST /api/<method>
//   {"type":"client-request","rpcId":"...","method":"<method>","payload":{...}}
// 响应：
//   {"type":"server-response","rpcId":"...","result":{"ok":true,"value":...}}
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { spawn, execFile } from "node:child_process";
import { sleep, ROOT_DIR } from "./logger.mjs";
import { ensureProfileSkill } from "./workbench_skill.mjs";
import { openBrowserWindow } from "./browser_runtime.mjs";
import { requireDshBin } from "./executor_runtime.mjs";
export { openBrowserWindow } from "./browser_runtime.mjs";

/** 与 dsh Web GUI 通信的官方 RPC 客户端。 */
export function rpc(port, method, payload, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      type: "client-request",
      rpcId: `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      method,
      payload,
    });
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: `/api/${method}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          if (j && j.type === "server-response" && j.result && j.result.ok === true) {
            return resolve(j.result.value);
          }
          reject(new Error(`${method} failed: ${data.slice(0, 300)}`));
        } catch (e) {
          reject(new Error(`${method} bad json: ${data.slice(0, 300)}`));
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${method} timeout`)));
    req.on("error", reject);
    req.end(body);
  });
}

/** 找到一个空闲端口（OS 分配后立刻释放，小概率竞争可接受）。 */
export function findFreePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, host, () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

/** 轮询等待 dsh web 服务就绪（/api/host.describe 可响应）。 */
export async function waitPort(port, timeoutMs, signal) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs && !signal?.aborted) {
    try {
      await rpc(port, "host.describe", {}, 3000);
      return true;
    } catch {
      await sleep(100);
    }
  }
  return false;
}

const DEFAULT_BUNDLES = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];

/**
 * 每个项目一个可见执行服务（专属端口的 dsh web 进程 + 会话池）。
 * 服务在项目首次执行任务时启动，随任务复用；项目完成/暂停后释放。
 */
export class UiExecutor {
  constructor(cfg, logger) {
    this.cfg = cfg; // config.deepseek（含 visible/uiProfile/uiOpenWindow/uiBootTimeoutMs/uiChromePath）
    this.logger = logger;
    this.servers = new Map(); // projectId -> {port,url,child,fd,logFile,startedAt,sessions:Map}
    this.serverStarts = new Map(); // projectId -> Promise，防止预热与正式派发重复启服务
    this.disposeTimers = new Map(); // projectId -> timeout
    this.catalogPromise = null;
  }

  log(level, msg) { this.logger?.[level]?.("dsh-ui", msg); }

  get profileName() { return this.cfg.uiProfile || "workbench-exec"; }

  dshHome() { return path.resolve(ROOT_DIR, process.env.DSH_HOME || path.join(os.homedir(), ".dsh")); }

  /** 确保专用可见执行 profile 存在（首次自动创建，结构与 headless profile 一致）。 */
  ensureProfile() {
    const name = this.profileName;
    if (!name || name === "." || name === ".." || name === "node_modules" || /[\\/:*?"<>|]/.test(name)) {
      throw new Error("执行器 uiProfile 必须是单个合法文件夹名称");
    }
    const dir = path.join(this.dshHome(), "profiles", name);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(path.join(dir, "package.json"))) {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
        name: `dsh-profile-${name}`,
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: DEFAULT_BUNDLES } },
      }, null, 2), "utf8");
      this.log("info", `已创建可见执行 profile: ${dir}`);
    }
    for (const [file, content] of [
      ["pnpm-workspace.yaml", "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n"],
      ["cordis.yml", "[]\n"], ["cordis.patch.yml", "[]\n"],
    ]) {
      if (!fs.existsSync(path.join(dir, file))) fs.writeFileSync(path.join(dir, file), content, "utf8");
    }
    const skill = ensureProfileSkill(dir);
    return { name, dir, skillRoot: path.join(dir, "skills"), skill };
  }

  /** 服务进程是否存活且 API 可用。 */
  async isAlive(server, timeoutMs = 4000) {
    if (!server || (server.child && server.child.exitCode !== null)) return false;
    try {
      await rpc(server.port, "host.describe", {}, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 获取（必要时启动）某项目的可见执行服务。
   * @returns {port,url,...} 或 null（启动失败，调用方应回退 headless）
   */
  async ensureServer(projectId, logDir) {
    if (this.serverStarts.has(projectId)) return this.serverStarts.get(projectId);
    const starting = this.ensureServerOnce(projectId, logDir);
    this.serverStarts.set(projectId, starting);
    try {
      return await starting;
    } finally {
      if (this.serverStarts.get(projectId) === starting) this.serverStarts.delete(projectId);
    }
  }

  async ensureServerOnce(projectId, logDir) {
    const existing = this.servers.get(projectId);
    if (existing) {
      if (await this.isAlive(existing, 1000)) {
        this.cancelDispose(projectId);
        return existing;
      }
      this.disposeServer(projectId);
    }
    const dshBin = requireDshBin(this.cfg);
    const profile = this.ensureProfile();
    const port = await findFreePort();
    const logFile = path.join(logDir, `executor-ui-${Date.now()}.log`);
    fs.mkdirSync(logDir, { recursive: true });
    const fd = fs.openSync(logFile, "a");
    const args = [
      dshBin,
      "--profile", this.profileName,
      "--port", String(port),
      "--no-open",
    ];
    this.log("info", `启动可见执行服务: port=${port} profile=${this.profileName}（project=${projectId}）`);
    let child;
    try {
      child = spawn(this.cfg.nodeBin || process.execPath, args, {
        cwd: os.homedir(),
        stdio: ["ignore", fd, fd],
        env: { ...process.env, DSH_HOME: this.dshHome(), DSH_BUNDLED_SKILL_DIR: profile.skillRoot },
        windowsHide: true,
      });
    } catch (e) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      throw e;
    }
    const server = {
      port,
      url: `http://127.0.0.1:${port}`,
      child,
      fd,
      logFile,
      startedAt: Date.now(),
      sessionId: null, // 项目级复用会话（一个项目一个会话）
      needsBootstrap: false,
      sessions: new Map(), // sessionId -> {taskId, startedAt}
    };
    this.servers.set(projectId, server);
    this.cancelDispose(projectId);

    const boot = new AbortController();
    const up = await Promise.race([
      waitPort(port, this.cfg.uiBootTimeoutMs ?? 90000, boot.signal),
      new Promise((resolve) => {
        child.once("exit", () => resolve(false));
        child.once("error", (error) => { this.log("error", "无法启动执行器: " + error.message); resolve(false); });
      }), // 服务启动即崩溃 → 快速失败
    ]);
    boot.abort();
    if (!up) {
      const bootMs = Date.now() - server.startedAt;
      this.log("error", `可见执行服务 ${port} 启动失败（${Math.round(bootMs / 1000)}s），日志: ${logFile}`);
      this.disposeServer(projectId);
      return null;
    }
    this.log("info", `可见执行服务就绪: ${server.url}`);
    return server;
  }

  /** 接管工作台重启前遗留的 Harness 服务与会话，不创建新会话也不重复提交任务。 */
  async adoptSession(projectId, saved, sourceDir) {
    if (!saved?.service_url || !saved?.session_id) return null;
    let url;
    try { url = new URL(saved.service_url); } catch { return null; }
    const port = Number(url.port);
    if (!port || !["127.0.0.1", "localhost"].includes(url.hostname)) return null;
    const server = {
      port,
      url: `http://127.0.0.1:${port}`,
      child: null,
      fd: undefined,
      logFile: saved.log_file || null,
      startedAt: saved.started_at ? new Date(saved.started_at).getTime() : Date.now(),
      sessionId: saved.session_id,
      needsBootstrap: false,
      adopted: true,
      sessions: new Map([[saved.session_id, { taskId: saved.task_id || "-", startedAt: Date.now() }]]),
    };
    if (!(await this.isAlive(server))) return null;
    const list = await rpc(port, "session.list", {}, 15000).catch(() => null);
    const row = (list?.items || []).find((item) => item.sessionId === saved.session_id);
    if (!row) return null;
    if (saved.cwd && path.resolve(saved.cwd) !== path.resolve(sourceDir)) return null;
    if (!row.cwd || fs.realpathSync(row.cwd) !== fs.realpathSync(sourceDir)) return null;
    await this.ensureWorkspace(server, projectId, sourceDir, saved.session_id);
    this.servers.set(projectId, server);
    this.cancelDispose(projectId);
    return { server, sessionId: saved.session_id, running: !!row.running };
  }

  /** 官方工作区归属必须显式关联；cwd 相同并不会自动归组。 */
  async ensureWorkspace(server, projectId, sourceDir, sessionId = null) {
    try {
      const canonical = await fs.promises.realpath(sourceDir);
      const { workspace, created } = await rpc(server.port, "workspace.create", { path: canonical }, 15000);
      if (!workspace?.workspaceId || workspace.path !== canonical) throw new Error("工作区路径或 ID 与请求不匹配");
      // 默认源码目录统一叫 source，用项目名命名新工作区；已有自定义名称不覆盖。
      if (created && path.basename(canonical) === "source" && path.basename(path.dirname(canonical)) === projectId) {
        await rpc(server.port, "workspace.rename", {
          workspaceId: workspace.workspaceId,
          title: projectId.replace(/^\d{4}-\d{2}-\d{2}-/, ""),
        }, 15000);
      }
      if (sessionId && !(workspace.sessionIds || []).includes(sessionId)) {
        // 官方支持同 ID、同 cwd 的幂等创建：补归属，不重建会话/历史。
        const result = await rpc(server.port, "session.create", { workspaceId: workspace.workspaceId, sessionId }, 60000);
        if (result?.sessionId !== sessionId) throw new Error("补关联返回了不同会话 ID");
      }
      return workspace.workspaceId;
    } catch (cause) {
      const error = new Error(`Harness 工作区关联失败: ${cause.message}`, { cause });
      error.code = "RUNNER_WORKSPACE";
      throw error;
    }
  }

  /**
   * 获取（必要时创建）项目的执行会话 —— 一个项目一个会话。
   * 若已有会话且仍在 session.list 中则直接复用（跨任务不重开会话、不重复注入系统提示词）；
   * 否则新建会话并记录。返回 {sessionId, reused}。
   */
  async getOrCreateSession(projectId, sourceDir) {
    const s = this.servers.get(projectId);
    if (!s) throw new Error("可见执行服务未就绪");
    if (s.sessionId) {
      let row;
      try {
        const list = await rpc(s.port, "session.list", {}, 15000);
        row = (list.items || []).find((x) => x.sessionId === s.sessionId);
      } catch { /* 单次查询失败按失效处理 */ }
      if (row?.cwd && fs.realpathSync(row.cwd) === fs.realpathSync(sourceDir)) {
        await this.ensureWorkspace(s, projectId, sourceDir, s.sessionId);
        return { sessionId: s.sessionId, reused: true, bootstrap: !!s.needsBootstrap };
      }
      s.sessionId = null;
    }
    const workspaceId = await this.ensureWorkspace(s, projectId, sourceDir);
    const created = await rpc(s.port, "session.create", { workspaceId }, 60000);
    if (!created || !created.sessionId) throw new Error("session.create 未返回 sessionId");
    s.sessionId = created.sessionId;
    s.needsBootstrap = false;
    s.modelSelectionKey = null;
    s.selectedModel = null;
    return { sessionId: created.sessionId, reused: false, bootstrap: false };
  }

  /** 在现有服务内换成空白会话；保留同一窗口，下一次任务重新加载 Skill 与摘要。 */
  async replaceSession(projectId, sourceDir) {
    const s = this.servers.get(projectId);
    if (!s) throw new Error("可见执行服务未就绪");
    const previousSessionId = s.sessionId || null;
    const workspaceId = await this.ensureWorkspace(s, projectId, sourceDir);
    const created = await rpc(s.port, "session.create", { workspaceId }, 60000);
    if (!created?.sessionId) throw new Error("session.create 未返回 sessionId");
    s.sessionId = created.sessionId;
    s.needsBootstrap = true;
    s.modelSelectionKey = null;
    s.selectedModel = null;
    return { sessionId: created.sessionId, previousSessionId };
  }

  clearBootstrap(projectId, sessionId) {
    const s = this.servers.get(projectId);
    if (s?.sessionId === sessionId) s.needsBootstrap = false;
  }

  /** 读取 Harness 尾页投影；能力缺失时返回 null，由编排器使用任务数后备阈值。 */
  async sessionProjection(projectId, sessionId, timeoutMs = 30000) {
    const s = this.servers.get(projectId);
    if (!s) return null;
    const history = await rpc(s.port, "session.history", { sessionId, maxMessages: 1 }, timeoutMs);
    const values = history?.projections?.values;
    if (!values?.tokenUsage && !values?.contextPressure) return null;
    return {
      tokenUsage: values.tokenUsage || null,
      contextPressure: values.contextPressure || null,
      asOfSeq: history.projections.asOfSeq,
    };
  }

  async currentModel(projectId, sessionId, timeoutMs = 30000) {
    const s = this.servers.get(projectId);
    if (!s) return null;
    return (await rpc(s.port, "session.models", { sessionId }, timeoutMs))?.current || null;
  }

  /** 为会话选择模型/推理等级。selection = {provider, model, reasoningEffort?}。 */
  async selectModel(projectId, sessionId, selection) {
    const s = this.servers.get(projectId);
    if (!s) throw new Error("可见执行服务未就绪");
    const selectionKey = JSON.stringify(selection || {});
    if (s.modelSelectionKey === selectionKey) return s.selectedModel || null;
    const res = await rpc(s.port, "session.selectModel", {
      sessionId,
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === void 0 || selection.reasoningEffort === "" ? {} : { reasoningEffort: selection.reasoningEffort }),
    }, 5000);
    s.modelSelectionKey = selectionKey;
    s.selectedModel = res?.selected || null;
    return s.selectedModel;
  }

  /**
   * 探测可用的 DeepSeek 模型目录（用于 Dashboard 下拉框）。
   * 起一个临时 dsh web 服务 + 临时会话查询 session.models，用完即关；
   * 结果缓存，失败时回退到内置目录。
   */
  async probeModels() {
    if (this.catalogCache) return this.catalogCache;
    if (this.catalogPromise) return this.catalogPromise;
    this.catalogPromise = this.probeModelsOnce();
    try {
      return await this.catalogPromise;
    } finally {
      this.catalogPromise = null;
    }
  }

  async probeModelsOnce() {
    const FALLBACK = {
      current: null,
      groups: [{
        id: "deepseek-official",
        name: "DeepSeek 官方",
        models: [
          { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" },
          { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" },
          { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek-V4-Flash-Vision-Exp" },
        ],
      }],
      reasoningEfforts: ["off", "low", "high", "max"],
      fallback: true,
    };
    let port;
    let fd;
    let child;
    const boot = new AbortController();
    try {
      const dshBin = requireDshBin(this.cfg);
      const profile = this.ensureProfile();
      port = await findFreePort();
      const logFile = path.join(os.tmpdir(), `dsh-model-probe-${Date.now()}.log`);
      fd = fs.openSync(logFile, "a");
      child = spawn(this.cfg.nodeBin || process.execPath, [
        dshBin, "--profile", this.profileName, "--port", String(port), "--no-open",
      ], { cwd: os.homedir(), stdio: ["ignore", fd, fd], windowsHide: true,
        env: { ...process.env, DSH_HOME: this.dshHome(), DSH_BUNDLED_SKILL_DIR: profile.skillRoot } });
      const up = await Promise.race([
        waitPort(port, this.cfg.uiBootTimeoutMs ?? 60000, boot.signal),
        new Promise((resolve) => { child.once("exit", () => resolve(false)); child.once("error", () => resolve(false)); }),
      ]);
      if (!up) return FALLBACK;
      const created = await rpc(port, "session.create", { cwd: os.homedir() }, 60000);
      const res = await rpc(port, "session.models", { sessionId: created.sessionId }, 30000);
      this.catalogCache = {
        current: res.current || null,
        groups: res.groups || FALLBACK.groups,
        reasoningEfforts: ["off", "low", "high", "max"],
        fallback: !(res.groups && res.groups.length),
      };
      return this.catalogCache;
    } catch (e) {
      this.log("warn", `模型目录探测失败（使用内置目录）: ${e.message}`);
      return FALLBACK;
    } finally {
      boot.abort();
      if (child && child.exitCode === null) {
        execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }, () => {});
      }
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    }
  }

  /** 向会话提交任务提示词（等价于用户在窗口里输入并回车）。 */
  async submitPrompt(projectId, sessionId, prompt, taskId) {
    const s = this.servers.get(projectId);
    if (!s) throw new Error("可见执行服务未就绪");
    const res = await rpc(s.port, "session.prompt", {
      sessionId,
      mode: "queue",
      content: [{ type: "text", text: prompt }],
    }, 60000);
    s.sessions.set(sessionId, { taskId: taskId || "-", startedAt: Date.now() });
    return res;
  }

  /** 查询会话运行状态；服务不可用返回 null。 */
  async sessionState(projectId, sessionId, timeoutMs = 15000) {
    const s = this.servers.get(projectId);
    if (!s) return null;
    const list = await rpc(s.port, "session.list", {}, timeoutMs);
    const row = (list.items || []).find((x) => x.sessionId === sessionId);
    if (!row) return null;
    return { running: !!row.running, blank: !!row.blank, updatedAt: row.updatedAt };
  }

  /** 取消正在运行的会话。 */
  async cancelSession(projectId, sessionId) {
    const s = this.servers.get(projectId);
    if (!s) return false;
    try {
      await rpc(s.port, "session.cancel", { sessionId }, 15000);
      return true;
    } catch {
      return false;
    }
  }

  /** 打开该项目的执行窗口（新浏览器窗口）。 */
  async openWindow(projectId) {
    const s = this.servers.get(projectId);
    if (!s) return null;
    const opened = await openBrowserWindow(s.url, this.cfg.uiChromePath || "");
    return { url: s.url, opened };
  }

  /** 关闭某项目的可见执行服务。 */
  disposeServer(projectId) {
    this.cancelDispose(projectId);
    const s = this.servers.get(projectId);
    if (!s) return;
    this.servers.delete(projectId);
    try {
      if (s.child && s.child.exitCode === null) {
        execFile("taskkill", ["/PID", String(s.child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }, () => {});
      }
    } catch { /* ignore */ }
    if (s.fd !== undefined) { try { fs.closeSync(s.fd); } catch { /* ignore */ } }
    this.log("info", `可见执行服务已关闭: ${s.url}（project=${projectId}）`);
  }

  /** 延时关闭（项目完成后给用户留出查看窗口的时间；新任务到来会取消延时）。 */
  scheduleDispose(projectId, delayMs = 30000) {
    if (!this.servers.has(projectId)) return;
    this.cancelDispose(projectId);
    const t = setTimeout(() => this.disposeServer(projectId), delayMs);
    t.unref?.();
    this.disposeTimers.set(projectId, t);
  }

  cancelDispose(projectId) {
    const t = this.disposeTimers.get(projectId);
    if (t) {
      clearTimeout(t);
      this.disposeTimers.delete(projectId);
    }
  }

  /** 项目级信息（Dashboard 用）。 */
  info(projectId) {
    const s = this.servers.get(projectId);
    if (!s) return null;
    return {
      url: s.url,
      port: s.port,
      startedAt: s.startedAt,
      sessionId: s.sessionId || null,
      adopted: !!s.adopted,
      sessions: [...s.sessions.values()].map((v) => ({ taskId: v.taskId, startedAt: v.startedAt })),
    };
  }

  /** 全部服务清单（Dashboard 系统状态用）。 */
  list() {
    return [...this.servers.entries()].map(([projectId, s]) => ({
      projectId,
      url: s.url,
      port: s.port,
      startedAt: s.startedAt,
    }));
  }

  /** 退出前关闭全部服务。 */
  shutdownAll() {
    for (const id of [...this.servers.keys()]) this.disposeServer(id);
  }

  /** 工作台正常退出时仅放下本地句柄，让 Harness 服务可被下一进程接管。 */
  detachAll() {
    for (const s of this.servers.values()) {
      if (s.fd !== undefined) { try { fs.closeSync(s.fd); } catch { /* ignore */ } }
    }
    this.servers.clear();
  }
}
