// ChatGPT Browser Bridge（无 API Key，纯浏览器自动化）
//
// 架构：Chrome（独立 Profile，登录态持久化）以 --remote-debugging-port 启动
//       → playwright-core 通过 CDP 连接（不下载浏览器、不碰用户主 Chrome）
// 能力：自动打开 ChatGPT、登录态检测、按配置选择模型、新建会话、
//       自动输入/发送、生成完成检测（停止按钮 + 文本稳定，非固定 sleep）、
//       读取完整回复、项目级会话隔离（会话 URL 持久化）。
// 多级回退：data-testid → aria-label → 语义角色 → 键盘事件；全部失败不崩溃，
//       记录可用选择并继续（Adapter 模式，DOM 变化时可持续维护）。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { sleep } from "./logger.mjs";
import { findBrowser, BROWSER_HELP } from "./browser_runtime.mjs";

export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // GPT_TIMEOUT | GPT_LOGIN_REQUIRED | GPT_CHALLENGE | GPT_PAGE_ERROR | GPT_BROWSER_ERROR
    this.name = "BridgeError";
  }
}

async function httpGetJson(url, timeoutMs = 2000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export class GptBridge {
  constructor(config, logger, rootDir) {
    this.cfg = config; // config.gpt
    this.logger = logger;
    this.rootDir = rootDir;
    this.browser = null;
    this.page = null;
    this.connectPromise = null;
    this.navigationPromise = null;
    this.lastDebugProbe = { at: 0, up: false };
    this.chromePath = findBrowser(this.cfg.chromePath);
    this.profileDir = path.resolve(rootDir, this.cfg.profileDir || "browser-profile");
    this.baseUrl = this.cfg.baseUrl || "https://chatgpt.com/";
    this.live = this.newLive(); // GPT 实时状态（供 Dashboard 展示）
    this.windowVisible = null; // 浏览器窗口是否可见（null=未知）
    fs.mkdirSync(this.profileDir, { recursive: true });
  }

  newLive() {
    return {
      phase: "idle",        // idle | navigating | sending | waiting_reply | thinking | answering | complete
      since: Date.now(),
      detail: "",
      replyChars: 0,
      elapsedMs: 0,
      slow: false,          // 疑似卡住（长时间无进展）
      windowVisible: null,
    };
  }

  setLive(phase, detail) {
    const prev = this.live.phase;
    if (prev !== phase) this.live.since = Date.now();
    this.live.phase = phase;
    if (detail !== undefined) this.live.detail = detail;
    this.live.elapsedMs = Date.now() - this.live.since;
    this.live.slow = this.live.elapsedMs > 120000 && ["waiting_reply", "thinking", "answering"].includes(phase);
    return this.live;
  }

  getLive() {
    this.live.elapsedMs = Date.now() - this.live.since;
    this.live.slow = this.live.elapsedMs > 120000 && ["waiting_reply", "thinking", "answering"].includes(this.live.phase);
    this.live.windowVisible = this.windowVisible;
    return this.live;
  }

  log(level, msg) { this.logger?.[level]?.("gpt-bridge", msg); }

  // ---------- 浏览器生命周期 ----------
  async isDebugPortUp(force = false) {
    if (this.browser?.isConnected?.()) return true;
    if (!force && Date.now() - this.lastDebugProbe.at < 1000) return this.lastDebugProbe.up;
    try {
      await httpGetJson(`http://127.0.0.1:${this.cfg.debugPort}/json/version`, 1500);
      this.lastDebugProbe = { at: Date.now(), up: true };
      return true;
    } catch {
      this.lastDebugProbe = { at: Date.now(), up: false };
      return false;
    }
  }

  async launchChrome() {
    if (this.launchPromise) return this.launchPromise;
    this.launchPromise = this.launchChromeOnce();
    try { return await this.launchPromise; }
    finally { this.launchPromise = null; }
  }

  chromeArgs() {
    return [
      `--remote-debugging-port=${this.cfg.debugPort}`,
      `--user-data-dir=${this.profileDir}`,
      "--no-first-run", "--no-default-browser-check", "--disable-features=Translate",
      "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows", "--window-size=1280,900",
      "--window-position=60,60", "--disable-session-crashed-bubble",
      // restore-last-session=false 仍被 Chrome 视为开启；不传此开关。
      // 启动/重复唤起都不创建窗口，连接后由桥选择或创建唯一工作页。
      "--no-startup-window", "--enable-automation",
    ];
  }

  async launchChromeOnce() {
    if (await this.isDebugPortUp(true)) return true;
    if (this.chromeProcess || Date.now() - (this.lastLaunchAt || 0) < 60000) {
      throw new BridgeError("GPT_BROWSER_ERROR", "浏览器已启动但连接暂不可用；停止重复唤起，请稍后重试或检查工作台专用浏览器。");
    }
    if (!this.chromePath) {
      throw new BridgeError("GPT_BROWSER_ERROR", BROWSER_HELP);
    }
    const args = this.chromeArgs();
    this.log("info", `启动浏览器: ${this.chromePath}（调试端口 ${this.cfg.debugPort}，Profile: ${this.profileDir}）`);
    this.lastLaunchAt = Date.now();
    const child = spawn(this.chromePath, args, { detached: true, stdio: "ignore", windowsHide: true });
    this.chromeProcess = child;
    child.on("exit", () => { if (this.chromeProcess === child) this.chromeProcess = null; });
    child.on("error", (e) => {
      if (this.chromeProcess === child) this.chromeProcess = null;
      this.log("error", `浏览器启动失败: ${e.message}`);
    });
    child.unref();
    for (let i = 0; i < 40; i++) {
      if (await this.isDebugPortUp(true)) return true;
      await sleep(250);
    }
    throw new BridgeError("GPT_BROWSER_ERROR", `Chrome 启动后调试端口 ${this.cfg.debugPort} 未就绪。`);
  }

  async ensureBrowser() {
    if (this.browser?.isConnected?.() && this.page && !this.page.isClosed?.()) return true;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectBrowser();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async connectBrowser() {
    try {
      if (!this.browser?.isConnected?.()) {
        if (!(await this.isDebugPortUp(true))) await this.launchChrome();
        this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.cfg.debugPort}`);
      }
      const contexts = this.browser.contexts();
      const ctx = contexts[0];
      if (!ctx) throw new Error("浏览器缺少持久化工作上下文");
      const pages = ctx.pages().filter((candidate) => !candidate.isClosed());
      const targetOrigin = new URL(this.baseUrl).origin;
      let page = pages.find((candidate) => {
        try { return new URL(candidate.url()).origin === targetOrigin; } catch { return false; }
      });
      if (!page) {
        for (const candidate of pages) {
          if (candidate.url() === "about:blank" && await candidate.evaluate(() => !document.body?.innerHTML.trim()).catch(() => false)) {
            page = candidate;
            break;
          }
        }
      }
      page ||= await ctx.newPage();
      this.page = page;
      // 不占用任意已打开页面；新建/复用空白页后立即导航，失败不能遗留空白窗口。
      if (page.url() === "about:blank") {
        try { await page.goto(this.baseUrl, { waitUntil: "domcontentloaded", timeout: 60000 }); }
        catch (error) {
          if (page.url() === "about:blank") { await page.close().catch(() => {}); throw error; }
          this.log("warn", `ChatGPT 导航未完成，继续检测页面: ${error.message}`);
        }
      }
      page.setDefaultTimeout(30000);
      page.on("close", () => { if (this.page === page) this.page = null; });
      await this.closeEmptyStartupPages(ctx, page);
      this.log("info", "CDP 连接成功");
      return true;
    } catch (e) {
      await this.browser?.close().catch(() => {});
      this.browser = null;
      this.page = null;
      throw new BridgeError("GPT_BROWSER_ERROR", `浏览器连接失败: ${e.message}`);
    }
  }

  async closeEmptyStartupPages(ctx, keep) {
    // 只有 CDP 明确证明属于此工作台 Profile 时才清理；不改登录态文件。
    let cdp;
    try {
      cdp = await this.browser.newBrowserCDPSession();
      const { arguments: args } = await cdp.send("Browser.getBrowserCommandLine");
      const profile = args.find((arg) => arg.startsWith("--user-data-dir="))?.slice(16);
      if (!profile || path.resolve(profile).toLowerCase() !== this.profileDir.toLowerCase()) return;
      for (const page of ctx.pages()) {
        if (page === keep || page.isClosed() || page.url() !== "about:blank") continue;
        const empty = await page.evaluate(() => !document.body?.innerHTML.trim()).catch(() => false);
        if (empty && page.url() === "about:blank") await page.close().catch(() => {});
      }
    } catch { /* 旧浏览器未开放命令行信息时不清理其他页面 */ }
    finally { await cdp?.detach().catch(() => {}); }
  }

  async dispose() {
    try { await this.browser?.close(); } catch { /* ignore */ }
    this.browser = null;
    this.page = null;
    this.connectPromise = null;
    this.navigationPromise = null;
  }

  // ---------- 页面状态 ----------
  async gotoChat() {
    await this.ensureBrowser();
    const current = await this.detectState();
    let sameOrigin = false;
    try { sameOrigin = new URL(current.url).origin === new URL(this.baseUrl).origin; } catch { /* navigate below */ }
    if (sameOrigin && (current.loggedIn || current.challenge || current.loginButton || !current.loading)) return current;
    if (this.navigationPromise) return this.navigationPromise;
    this.navigationPromise = this.navigateToChat();
    try {
      return await this.navigationPromise;
    } finally {
      this.navigationPromise = null;
    }
  }

  async waitForChatReady(timeoutMs = 45000, page = this.page) {
    if (!page) return this.detectState();
    await page.waitForFunction(() => {
      const body = document.body;
      const title = document.title || "";
      const hasComposer = !!document.querySelector('#prompt-textarea, div[contenteditable="true"], textarea[contenteditable="true"]');
      const hasLogin = !!document.querySelector('[data-testid="login-button"], a[href*="auth/login"]');
      const hasChallenge = /just a moment|verify you are human|checking your browser|access denied|blocked/i.test(title)
        || !!document.querySelector('iframe[src*="challenge"], #challenge-running, [data-testid*="challenge"]');
      return document.readyState === "complete" && (!!body && (hasComposer || hasLogin || hasChallenge));
    }, null, { timeout: timeoutMs, polling: 100 }).catch(() => {});
    return this.detectState();
  }

  async navigateToChat() {
    this.setLive("navigating", "打开 ChatGPT…");
    try {
      await this.page.goto(this.baseUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch { /* 导航超时也要继续检测 */ }
    return this.waitForChatReady(this.cfg.loginGraceMs || 45000);
  }

  /**
   * 检测页面状态：区分「已登录 / 未登录 / 页面加载中 / 验证挑战」，
   * 避免页面尚未加载完成时误判为"需要登录"。
   */
  async detectState() {
    if (!this.page) return { loggedIn: false, loading: false, challenge: false, url: null, error: "无页面", loginButton: false };
    try {
      return await this.page.evaluate(() => {
        const bodyText = document.body ? document.body.innerText.slice(0, 2500) : "";
        const hasComposer = !!document.querySelector('#prompt-textarea, div[contenteditable="true"], textarea[contenteditable="true"]');
        const loginButton = !!document.querySelector('[data-testid="login-button"], a[href*="auth/login"]')
          || /log\s*in|登\s*录|sign\s*up|注\s*册/i.test(bodyText.slice(0, 500));
        const onAuthPage = /\/auth\/|login\?/i.test(location.href);
        const challenge = /just a moment|verify you are human|checking your browser|access denied|you have been blocked|cf-challenge|人机验证/i.test(bodyText);
        const url = location.href;
        const ready = document.readyState === "complete";
        // 加载中：页面没渲染出任何关键元素，且也不是明确未登录
        const loading = !ready || (!hasComposer && !loginButton && !onAuthPage && !challenge);
        return {
          loggedIn: hasComposer && !loginButton && !challenge && !onAuthPage,
          loading,
          challenge,
          pageError: /something went wrong|hmm\.\.\.something seems to have gone wrong/i.test(bodyText.slice(-1500)),
          hasComposer,
          loginButton,
          url,
          title: document.title,
        };
      });
    } catch {
      return { loggedIn: false, loading: true, challenge: false, url: null, error: "页面不可访问", loginButton: false };
    }
  }

  /**
   * 显示/隐藏浏览器窗口（CDP）。已登录时静默唤起（最小化），
   * 只有确实需要登录/处理验证码时才把窗口带到前台。
   */
  async setWindowVisible(visible) {
    if (!this.page || !this.browser) return false;
    try {
      const cdp = await this.page.context().newCDPSession(this.page);
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: visible ? "normal" : "minimized" },
      });
      this.windowVisible = !!visible;
      this.log("info", `浏览器窗口已${visible ? "显示" : "最小化（静默运行）"}`);
      await cdp.detach().catch(() => {});
      return true;
    } catch (e) {
      this.log("warn", `窗口控制失败: ${e.message}`);
      return false;
    }
  }

  async getSystemState({ probe = true } = {}) {
    let browserOk = !!this.browser?.isConnected?.() || this.lastDebugProbe.up;
    if (!browserOk && probe) {
      try { browserOk = await this.isDebugPortUp(); } catch { /* ignore */ }
    }
    let page = { loggedIn: false, challenge: false, loading: false, url: null };
    if (this.page) page = await this.detectState().catch(() => page);
    return {
      browserOk,
      connected: !!(this.browser?.isConnected?.()),
      loggedIn: !!page.loggedIn,
      loading: !!page.loading,
      challenge: !!page.challenge,
      url: page.url || null,
      chromePath: this.chromePath,
      live: this.getLive(),
    };
  }

  // ---------- 会话管理 ----------
  /**
   * 新建会话（项目级隔离的关键）。
   * 注意：chatgpt.com/ 会自动重定向到最近的历史会话，因此绝不能靠 goto(/) 新建会话，
   * 必须点击侧边栏「新聊天」链接，并验证会话确实切换成功（防止把消息发进用户旧会话）。
   */
  async newConversation() {
    await this.ensureBrowser();
    let state = await this.detectState();
    if (state.loading || !state.url?.startsWith(new URL(this.baseUrl).origin)) state = await this.gotoChat();
    if (!state.loggedIn) {
      throw new BridgeError("GPT_LOGIN_REQUIRED", state.challenge ? "页面出现 Cloudflare 验证/挑战" : "未登录 ChatGPT");
    }
    const beforeUrl = this.page.url();
    const beforeCounts = await this.page.evaluate(() => ({
      user: document.querySelectorAll('[data-message-author-role="user"]').length,
      assistant: document.querySelectorAll('[data-message-author-role="assistant"]').length,
    })).catch(() => ({ user: -1, assistant: -1 }));

    // 首页本身就是一个空白新会话，无需再点击、更不能再次导航。
    if (!beforeUrl.includes("/c/") && beforeCounts.user === 0 && beforeCounts.assistant === 0) {
      this.log("info", `空白新会话已就绪: ${beforeUrl}`);
      return beforeUrl;
    }
    const selectors = [
      { loc: this.page.locator('a[href="/"]', { hasText: "新聊天" }).first(), name: 'a[href="/"]:has-text(新聊天)' },
      { loc: this.page.locator('[aria-label="新聊天"]').first(), name: 'aria-label=新聊天' },
      { loc: this.page.locator('[aria-label="新建聊天"]').first(), name: 'aria-label=新建聊天' },
      { loc: this.page.locator('button[data-testid="new-chat-button"]').first(), name: "new-chat-button" },
      { loc: this.page.locator('button[aria-label*="New chat" i]').first(), name: "New chat" },
    ];
    let clicked = false;
    for (const { loc, name } of selectors) {
      try {
        if (await loc.isVisible()) {
          await loc.click();
          clicked = true;
          this.log("info", `新建会话（${name}）`);
          break;
        }
      } catch { /* 尝试下一个 */ }
    }
    if (!clicked) throw new BridgeError("GPT_PAGE_ERROR", "找不到新建会话入口，为防止消息发进旧会话已中止");

    await this.page.waitForFunction((oldUrl) => {
      const empty = !document.querySelector('[data-message-author-role="user"], [data-message-author-role="assistant"]');
      return location.href !== oldUrl && empty;
    }, beforeUrl, { timeout: 8000, polling: 100 }).catch(() => {});
    if (beforeUrl.includes("/c/") && this.page.url() === beforeUrl) {
      throw new BridgeError("GPT_PAGE_ERROR", "无法新建会话（页面仍停留在旧会话，为防止污染已中止）");
    }
    // 再验证消息区为空（防 SPA 静默失败）
    const counts = await this.page.evaluate(() => ({
      user: document.querySelectorAll('[data-message-author-role="user"]').length,
      assistant: document.querySelectorAll('[data-message-author-role="assistant"]').length,
    })).catch(() => null);
    if (counts && (counts.user > 0 || counts.assistant > 0)) {
      throw new BridgeError("GPT_PAGE_ERROR", "新会话仍残留旧消息，为防止发进错误会话已中止");
    }
    this.log("info", `会话就绪: ${this.page.url()}`);
    return this.page.url();
  }

  // ---------- 模型选择 ----------
  async selectModel(modelName, matchPatterns) {
    if (!modelName && !matchPatterns?.length) {
      this.log("info", "未指定模型，保留 ChatGPT 当前模型");
      return { selected: null, available: [], chosenBy: "current" };
    }
    await this.ensureBrowser();
    const chosen = { selected: null, available: [], chosenBy: null };
    try {
      // 0. 页面是否已显示用户配置的目标模型。
      const pageHas = await this.page.evaluate((name) => {
        if (!name) return false;
        const labels = [...document.querySelectorAll('button[aria-label*="model" i], button[aria-label*="模型"], [data-testid*="model-switcher"]')]
          .filter((el) => el.getClientRects().length > 0)
          .map((el) => `${el.getAttribute("aria-label") || ""} ${el.innerText || ""}`).join(" ");
        return labels.toLowerCase().includes(name.toLowerCase());
      }, modelName).catch(() => false);

      if (pageHas) {
        chosen.selected = `${modelName}（页面已确认）`;
        chosen.chosenBy = "page-confirmed";
        this.log("info", `页面已显示模型 ${modelName}，无需切换`);
        return chosen;
      }

      // 1. 找模型切换按钮：优先"切换模型"按钮（助手消息旁/当前会话的），
      //    其次 composer 区域含模型名文本的可点击元素
      const switcher = this.page.locator(
        'button[aria-label="切换模型"], button[aria-label*="Switch model" i], [data-testid*="model-switcher"]'
      ).last(); // 最后一个 = 最新消息旁的
      let clicked = false;
      try {
        await switcher.waitFor({ state: "visible", timeout: 1200 });
        if (await switcher.isVisible()) {
          await switcher.click();
          clicked = true;
          this.log("info", "已点击“切换模型”按钮");
        }
      } catch { /* ignore */ }
      if (!clicked) {
        // composer 附近带模型名的按钮
        const near = this.page.locator('button:has-text("ChatGPT"), button:has-text("GPT"), [role="button"]:has-text("GPT")').last();
        try {
          await near.waitFor({ state: "visible", timeout: 1200 });
          if (await near.isVisible()) {
            await near.click();
            clicked = true;
            this.log("info", "已点击模型标签按钮");
          }
        } catch { /* ignore */ }
      }
      if (clicked) {
        await this.page.locator('[role="menuitem"], [role="option"], [role="menu"] li, [role="listbox"] [role="option"]').first()
          .waitFor({ state: "visible", timeout: 2500 }).catch(() => {});
        const labels = await this.page.evaluate(() => {
          const items = [...document.querySelectorAll('[role="menuitem"], [role="option"], [role="menu"] li, [role="listbox"] [role="option"]')];
          return items.map((el) => (el.innerText || el.textContent || "").trim()).filter((t) => t && t.length < 80);
        });
        chosen.available = [...new Set(labels)];
        const { best, by } = this.pickModel(chosen.available, modelName, matchPatterns);
        if (best) {
          const item = this.page.locator('[role="menuitem"], [role="option"], li').filter({ hasText: best.slice(0, 30) }).first();
          await item.click();
          chosen.selected = best;
          chosen.chosenBy = by;
          this.log("info", `模型已选择: ${best}（${by}）`);
          await item.waitFor({ state: "hidden", timeout: 800 }).catch(() => {});
        } else {
          this.log("warn", `菜单中未找到目标模型 "${modelName}"。可用: ${chosen.available.join(", ") || "（未枚举到）"}`);
          // 菜单未点选则按 Esc 关闭，避免遮挡
          await this.page.keyboard.press("Escape").catch(() => {});
          // 回退：页面本身已显示目标模型（账号默认即是）
          if (pageHas) {
            chosen.selected = `${modelName}（页面已确认）`;
            chosen.chosenBy = "page-confirmed";
            this.log("info", `页面已显示模型 ${modelName}，视为已选择`);
          }
        }
      } else {
        if (pageHas) {
          chosen.selected = `${modelName}（页面已确认）`;
          chosen.chosenBy = "page-confirmed";
          this.log("info", `页面已显示模型 ${modelName}，无需切换`);
        } else {
          this.log("warn", "未找到模型切换按钮，保持默认模型");
        }
      }
    } catch (e) {
      this.log("warn", `模型选择失败（继续使用默认模型）: ${e.message}`);
    }
    return chosen;
  }

  pickModel(available, modelName, patterns) {
    const pats = (patterns || []).map((p) => { try { return new RegExp(p, "i"); } catch { return null; } }).filter(Boolean);
    let best = null;
    let bestScore = 0;
    let by = null;
    for (const label of available) {
      if (modelName && label === modelName) {
        if (bestScore < 1000) { best = label; bestScore = 1000; by = "exact"; }
        continue;
      }
      pats.forEach((re, i) => {
        if (re.test(label)) {
          const score = 500 - i * 50;
          if (score > bestScore) { best = label; bestScore = score; by = `pattern:${re.source}`; }
        }
      });
    }
    return { best, by };
  }

  // ---------- 消息发送 ----------
  /** 定位真正的输入框（ChatGPT 的 ProseMirror：#prompt-textarea） */
  async findComposer() {
    // 优先精确 id
    let composer = this.page.locator("#prompt-textarea").first();
    if (await composer.isVisible().catch(() => false)) {
      const box = await composer.boundingBox().catch(() => null);
      if (box && box.height < 400) return composer; // 正常高度（排除全屏编辑器等异常元素）
    }
    // 回退：逐个检查 contenteditable，选可见且高度合理者
    const all = this.page.locator('div[contenteditable="true"], textarea[contenteditable="true"], textarea');
    const n = await all.count();
    for (let i = 0; i < n; i++) {
      const c = all.nth(i);
      if (!(await c.isVisible().catch(() => false))) continue;
      const box = await c.boundingBox().catch(() => null);
      if (box && box.width > 200 && box.height > 20 && box.height < 400) return c;
    }
    return null;
  }

  async waitForComposer(timeoutMs = 20000) {
    const ready = await this.findComposer();
    if (ready) return ready;
    await this.page.waitForFunction(() => {
      const nodes = [...document.querySelectorAll('#prompt-textarea, div[contenteditable="true"], textarea[contenteditable="true"], textarea')];
      return nodes.some((node) => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return box.width > 200 && box.height > 20 && box.height < 400 && style.visibility !== "hidden" && style.display !== "none";
      });
    }, null, { timeout: timeoutMs, polling: 100 }).catch(() => {});
    return this.findComposer();
  }

  async attachFiles(files) {
    const paths = (Array.isArray(files) ? files : []).filter((file) => typeof file === "string" && fs.existsSync(file));
    if (!paths.length) return;
    let inputs = this.page.locator('input[type="file"]');
    let count = await inputs.count();
    if (!count) {
      const attachButtons = [
        'button[aria-label*="Attach" i]',
        'button[aria-label*="附件" i]',
        'button[data-testid*="attach" i]',
      ];
      for (const selector of attachButtons) {
        const button = this.page.locator(selector).first();
        if (await button.isVisible({ timeout: 800 }).catch(() => false)) {
          await button.click().catch(() => {});
          await sleep(400);
          break;
        }
      }
      inputs = this.page.locator('input[type="file"]');
      count = await inputs.count();
    }
    for (let i = 0; i < count; i++) {
      const input = inputs.nth(i);
      const multiple = await input.getAttribute("multiple").catch(() => null);
      if (count > 1 && multiple === null) continue;
      try {
        await input.setInputFiles(paths);
        await sleep(700);
        this.log("info", `已将 ${paths.length} 个附件上传到 GPT composer`);
        return;
      } catch (e) {
        this.log("warn", `GPT 附件入口不可用（${e.message}），尝试下一个`);
      }
    }
    throw new BridgeError("GPT_PAGE_ERROR", "找不到 ChatGPT 附件上传入口");
  }

  async sendMessage(text, options = {}) {
    await this.ensureBrowser();
    const page = this.page;
    const state = await this.detectState();
    if (!state.loggedIn) throw new BridgeError("GPT_LOGIN_REQUIRED", "未登录，无法发送");
    if (state.challenge) throw new BridgeError("GPT_CHALLENGE", "页面出现验证挑战");
    this.setLive("sending", "正在输入消息…");

    const composer = await this.waitForComposer(this.cfg.composerTimeoutMs || 20000);
    if (!composer) throw new BridgeError("GPT_PAGE_ERROR", "找不到输入框（composer）");

    const userBefore = await page.evaluate(() =>
      document.querySelectorAll('[data-message-author-role="user"]').length
    ).catch(() => -1);

    if (Array.isArray(options.files) && options.files.length) {
      await this.attachFiles(options.files);
    }

    // fill 可在一次 CDP 往返中完成清空与填充，并且对换行安全。
    try {
      await composer.fill(text);
    } catch {
      await composer.click();
      await page.keyboard.press("Control+a");
      await page.keyboard.press("Delete");
      await page.keyboard.insertText(text);
    }
    const tail = text.slice(-25).replace(/\s+/g, " ").slice(0, 15);
    const composerText = () => composer.evaluate((node) => node.value ?? node.innerText ?? "");
    let got = (await composerText().catch(() => "")).replace(/\s+/g, " ");
    if (!got.includes(tail)) {
      this.log("warn", "fill 校验失败，改用 CDP insertText");
      await composer.click();
      await page.keyboard.press("Control+a");
      await page.keyboard.press("Delete");
      await page.keyboard.insertText(text);
      await page.waitForFunction((expected) => {
        const node = document.querySelector('#prompt-textarea')
          || [...document.querySelectorAll('div[contenteditable="true"], textarea')].find((item) => item.getBoundingClientRect().width > 200);
        return String(node?.innerText || node?.value || "").replace(/\s+/g, " ").includes(expected);
      }, tail, { timeout: 1200, polling: 50 }).catch(() => {});
      got = (await composerText().catch(() => "")).replace(/\s+/g, " ");
      if (!got.includes(tail)) {
        throw new BridgeError("GPT_PAGE_ERROR", `消息输入校验两次失败（composer 内容与预期不符，已中止防止误发）`);
      }
    }

    // 发送：优先按钮，回退回车
    const sendSels = [
      'button[data-testid="send-button"]',
      'button[aria-label*="Send prompt" i]',
      'button[aria-label*="发送" i]',
      'button[aria-label*="Send message" i]',
    ];
    await page.waitForFunction((selectors) => selectors.some((selector) => {
      const button = document.querySelector(selector);
      return button && button.getClientRects().length > 0 && button.getAttribute("aria-disabled") !== "true" && !button.disabled;
    }), sendSels, { timeout: 5000, polling: 50 }).catch(() => {});
    let sent = false;
    for (const sel of sendSels) {
      const btn = page.locator(sel).first();
      const ok = await btn.isVisible().catch(() => false);
      const disabled = await btn.getAttribute("aria-disabled").catch(() => null);
      const disabled2 = await btn.isDisabled().catch(() => false);
      if (ok && disabled !== "true" && !disabled2) {
        await btn.click();
        sent = true;
        this.log("info", `消息已发送（${sel}）`);
        break;
      }
    }
    if (!sent) {
      this.log("info", "未找到可用的发送按钮，使用回车键发送");
      await page.keyboard.press("Enter");
    }
    this.setLive("sending", "消息已提交，等待生成…");

    // 发送验证：DOM 一出现新用户消息就立即继续，不再额外固定等待。
    const confirmed = await page.waitForFunction((before) =>
      before >= 0 && document.querySelectorAll('[data-message-author-role="user"]').length > before,
    userBefore, { timeout: 15000, polling: 50 }).then(() => true).catch(() => false);
    if (!confirmed) throw new BridgeError("GPT_PAGE_ERROR", "消息发送后未检测到用户消息增加（可能未成功发送）");
    return { sent: true, url: page.url() };
  }

  // ---------- 回复检测 ----------
  async assistantCount() {
    try {
      return await this.page.evaluate(() =>
        document.querySelectorAll('[data-message-author-role="assistant"]').length
      );
    } catch {
      return -1;
    }
  }

  async lastAssistantText() {
    try {
      return await this.page.evaluate(() => {
        const arts = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
        const last = arts[arts.length - 1];
        if (!last) return "";
        const md = last.querySelector(".markdown") || last;
        return (md.innerText || "").trim();
      });
    } catch {
      return "";
    }
  }

  /**
   * 等待 GPT 新回复完成。
   * 检测机制：消息数量变化（新回复出现）+ 停止按钮消失（生成结束）+ 文本连续稳定（真正的结束），
   * 而非固定 sleep；同时带 timeout 与异常页面检测。
   */
  async waitForReply(beforeCount, timeoutMs, shouldAbort) {
    const cfg = this.cfg;
    const timeout = timeoutMs || cfg.replyTimeoutMs || 900000;
    const poll = Math.max(100, cfg.replyPollMs || 300);
    const stableForMs = Math.max(poll, cfg.replyStableMs || 500);
    const start = Date.now();
    let lastText = "";
    let stableSince = 0;
    let sawNew = false;
    let page = this.page;
    this.setLive("waiting_reply", "等待 GPT 回复…");

    while (Date.now() - start < timeout) {
      if (shouldAbort?.()) throw new BridgeError("PROJECT_CANCELLED", "项目已暂停或删除");
      const info = await page.evaluate(() => {
        const arts = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
        const last = arts[arts.length - 1];
        const md = last ? last.querySelector(".markdown") || last : null;
        const text = md ? (md.innerText || "").trim() : "";
        const stop = !!document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop generating" i], button[aria-label*="停止" i]');
        const challenge = /just a moment|verify you are human|checking your browser|access denied|blocked/i.test(document.title || "")
          || !!document.querySelector('iframe[src*="challenge"], #challenge-running, [data-testid*="challenge"]');
        const alerts = [...document.querySelectorAll('[role="alert"], [data-testid*="error"]')]
          .map((node) => node.textContent || "").join(" ").slice(-2000);
        const pageError = /something went wrong|something seems to have gone wrong|an error occurred/i.test(alerts);
        return { count: arts.length, text, stop, challenge, pageError };
      }).catch(() => null);

      if (!info) {
        await this.ensureBrowser().catch(() => {});
        page = this.page;
        await sleep(poll);
        continue;
      }
      if (info.challenge) {
        this.setLive("waiting_reply", "⚠️ 出现验证挑战，需人工处理");
        throw new BridgeError("GPT_CHALLENGE", "等待回复期间出现验证挑战");
      }
      if (info.pageError) {
        this.setLive("waiting_reply", "⚠️ ChatGPT 页面报错");
        throw new BridgeError("GPT_PAGE_ERROR", "ChatGPT 页面报告错误（Something went wrong）");
      }

      if (info.count > beforeCount) {
        if (!sawNew) {
          sawNew = true;
          this.log("info", `检测到新回复开始生成（消息数 ${beforeCount} → ${info.count}）`);
        }
        if (info.stop && !info.text) {
          this.setLive("thinking", "GPT 正在思考…");
        } else if (info.text) {
          this.setLive("answering", "GPT 正在回答…");
          this.live.replyChars = info.text.length;
        }
      } else if (!sawNew) {
        this.setLive("waiting_reply", "等待 GPT 回复…");
      }

      if (sawNew) {
        if (!info.stop && info.text) {
          if (info.text === lastText) {
            if (!stableSince) stableSince = Date.now();
            const stableMs = Date.now() - stableSince;
            this.setLive("answering", `GPT 回答完成前校验（${stableMs}/${stableForMs}ms）…`);
            if (stableMs >= stableForMs) {
              this.live.replyChars = info.text.length;
              this.setLive("complete", `回复完成（${info.text.length} 字符）`);
              this.log("info", `回复完成（文本稳定 ${stableMs}ms，耗时 ${Math.round((Date.now() - start) / 1000)}s，${info.text.length} 字符）`);
              return { text: info.text, count: info.count, ms: Date.now() - start };
            }
          } else {
            lastText = info.text;
            stableSince = Date.now();
            this.live.replyChars = info.text.length;
          }
        } else {
          stableSince = 0;
        }
      }
      await sleep(poll);
    }
    this.setLive("waiting_reply", "GPT 回复超时");
    throw new BridgeError("GPT_TIMEOUT", `等待 GPT 回复超时（${Math.round(timeout / 1000)}s）`);
  }

  /** 完整一次问答：发送 + 等待完成 */
  async ask(text, timeoutMs) {
    const before = await this.assistantCount();
    await this.sendMessage(text);
    const reply = await this.waitForReply(before, timeoutMs);
    return { sentText: text, replyText: reply.text, conversationUrl: this.page?.url() || null };
  }
}

// ================= Mock GPT（无浏览器闭环测试 / 断网演练） =================
export class MockGptBridge {
  constructor(config, logger) {
    this.cfg = config;
    this.logger = logger;
    this.delay = config.mockDelayMs || 200;
    this.count = 0;
    this.pendingTasks = [];
    this.messages = [];
    this.lastReply = null;
    this.conversationUrl = null;
    this.live = { phase: "idle", since: Date.now(), detail: "", replyChars: 0, elapsedMs: 0, slow: false, windowVisible: true };
    // 供 sendToGpt 读取会话 URL（与真实桥接口一致）
    this.page = { url: () => this.conversationUrl };
  }

  setLive(phase, detail) { this.live.phase = phase; this.live.detail = detail || ""; this.live.since = Date.now(); }
  getLive() { return this.live; }
  async setWindowVisible(v) { this.live.windowVisible = v; return true; }

  log(level, msg) { this.logger?.[level]?.("gpt-bridge(mock)", msg); }

  buildPlan(taskText) {
    return `status: READY
project_name: mock-project
objective: ${String(taskText || "").replace(/\s+/g, " ").slice(0, 200)}

goals:
- 实现任务核心功能
- 提供 README 文档
- 通过运行验证

tasks:
- id: TASK-001
  description: 实现任务核心功能（按 objective 创建代码/文件）
  scope: 只实现当前目标的核心函数，保持既有接口
  inputs: ["用户目标与已有函数接口"]
  implementation_notes: 按目标实现纯函数，用相同输入验证输出；本计划仅用于模拟闭环
  edge_cases: ["空输入按接口约定返回空结果"]
  files: ["main.js", "test/main.test.js"]
  steps: [{"action":"检查目标和输入","expected_result":"确认接口约定"},{"action":"实现核心函数及对应测试","expected_result":"正常与空输入均有测试"},{"action":"运行测试核对输出","expected_result":"测试通过"}]
  verification: [{"action":"运行核心函数测试","expected_result":"正常与空输入结果符合约定"}]
  outputs: ["核心实现与测试结果"]
  open_decisions: []
  acceptance_check: 核心功能的正常及异常输入符合预期
  failure_handling: 保留失败输出并请求重规划
  priority: high
  dependencies: []

- id: TASK-002
  description: 编写 README.md，说明项目用途、结构与运行方法
  scope: 只更新 README.md，保持代码行为
  inputs: ["已完成的核心实现与实际运行入口"]
  implementation_notes: 按用途、运行方式、输入输出示例的顺序编写 README
  edge_cases: ["入口缺失时记录证据并请求 GPT 指导"]
  kind: docs
  files: ["README.md"]
  steps: [{"action":"核对实际运行入口","expected_result":"找到可执行入口"},{"action":"编写用途和使用示例","expected_result":"README 包含三部分"},{"action":"检查示例与代码一致","expected_result":"示例能复现"}]
  verification: [{"action":"按文档示例检查输入输出","expected_result":"与核心实现一致"}]
  outputs: ["README.md"]
  open_decisions: []
  acceptance_check: 文档包含可操作的使用示例
  failure_handling: 记录不一致之处并请求重规划
  priority: medium
  dependencies:
  - TASK-001

- id: TASK-003
  description: 运行验证：执行/检查产出，修复发现的问题
  scope: 只验证已实现的核心函数，发现问题交回 GPT
  inputs: ["核心函数与对应测试"]
  implementation_notes: 执行已有测试并保存输出，对照预期汇总结果
  edge_cases: ["任一测试失败时保留错误输出，不改变验收标准"]
  kind: test
  files: ["main.js", "test/main.test.js"]
  steps: [{"action":"读取对应测试","expected_result":"确认覆盖正常与空输入"},{"action":"运行并核对测试结果","expected_result":"所有测试通过"},{"action":"汇总验证结论","expected_result":"报告包含实际输出"}]
  verification: [{"action":"查看测试输出","expected_result":"无失败用例"}]
  outputs: ["验证报告"]
  open_decisions: []
  acceptance_check: 所有检查通过且记录结果
  failure_handling: 记录失败证据并请求重规划
  priority: high
  dependencies:
  - TASK-002

acceptance_criteria:
- 核心功能文件存在且内容完整
- README.md 存在
- 运行/静态检查通过

constraints:
- 优先使用标准库，避免不必要的第三方依赖

questions_for_executor: []`;
  }

  buildReply(status, extra) {
    let block = `<GPT_RESPONSE>\n<STATUS>${status}</STATUS>`;
    if (extra.plan) block += `\n<PLAN>\n${extra.plan}\n</PLAN>`;
    if (extra.nextTask) block += `\n<NEXT_TASK>${extra.nextTask}</NEXT_TASK>`;
    if (extra.decision) block += `\n<DECISION>${extra.decision}</DECISION>`;
    if (extra.request) block += `\n<REQUEST>${extra.request}</REQUEST>`;
    block += `\n</GPT_RESPONSE>`;
    return block;
  }

  async ensureBrowser() { return true; }
  async gotoChat() { return { loggedIn: true, challenge: false, url: "mock://chatgpt.com" }; }
  async detectState() { return { loggedIn: true, loading: false, challenge: false, url: "mock://chatgpt.com", title: "mock" }; }
  async getSystemState() { return { browserOk: true, connected: true, loggedIn: true, loading: false, challenge: false, url: "mock://chatgpt.com", live: this.getLive() }; }
  async newConversation() { this.log("info", "（mock）新建会话"); this.conversationUrl = "mock://conversation/1"; return this.conversationUrl; }
  async selectModel(modelName) {
    this.log("info", `（mock）选择模型: ${modelName}`);
    return { selected: modelName, available: [modelName], chosenBy: "exact(mock)" };
  }
  async assistantCount() { return this.count; }

  async sendMessage(text, options = {}) {
    await sleep(this.delay);
    this.setLive("sending", "（mock）发送消息…");
    this.messages.push({ ts: Date.now(), dir: "out", text, files: options.files || [] });
    this.log("info", `（mock）消息已发送（${text.length} 字符）`);
    // 依据消息类型生成回复
    const type = (text.match(/<MSG_TYPE>([\s\S]*?)<\/MSG_TYPE>/) || [])[1]?.trim().toUpperCase();
    const content = (text.match(/<CONTENT>([\s\S]*?)<\/CONTENT>/) || [])[1] || "";
    let reply;
    switch (type) {
      case "PLAN_REQUEST":
      case "USER": {
        this.pendingTasks = ["TASK-001", "TASK-002", "TASK-003"];
        reply = this.buildReply("READY", { plan: this.buildPlan(content) });
        break;
      }
      case "ANALYSIS": {
        if (this.pendingTasks.length > 0) {
          const next = this.pendingTasks.shift();
          reply = this.buildReply("CONTINUE", { nextTask: next });
        } else {
          reply = this.buildReply("DONE", {});
        }
        break;
      }
      case "QUERY": {
        reply = this.buildReply("REPLAN", {
          decision: "采纳执行者推荐方案，维持增量计划。",
          plan: undefined,
        });
        // REPLAN 时附带 UPDATED_PLAN：mock 用原计划
        reply = reply.replace("</GPT_RESPONSE>", `\n<UPDATED_PLAN>\n${this.buildPlan(this.messages[0]?.text || "")}\n</UPDATED_PLAN>\n</GPT_RESPONSE>`);
        break;
      }
      case "REVIEW_REQUEST":
        reply = this.buildReply("DONE", {});
        break;
      case "TASK_REVIEW":
        reply = this.buildReply("CONTINUE", {});
        break;
      case "REPROMPT":
        reply = this.buildReply("READY", { plan: this.buildPlan(this.messages[0]?.text || "") });
        break;
      default:
        reply = this.buildReply("CONTINUE", { nextTask: this.pendingTasks.shift() || null });
        break;
    }
    this.lastReply = { text: reply, count: ++this.count };
    return { sent: true, url: "mock://conversation/1" };
  }

  async waitForReply() {
    await sleep(this.delay);
    // 断点恢复场景：进程重启后 mock 内存里没有待回复 → 模拟真实桥的超时行为，
    // 由编排器的错误恢复路径处理（重新发送），而不是抛 null 崩溃。
    if (!this.lastReply) {
      this.setLive("waiting_reply", "mock：无待回复（进程重启后内存丢失）");
      throw new BridgeError("GPT_TIMEOUT", "mock：无待回复（进程重启后内存丢失）");
    }
    this.setLive("complete", `（mock）回复完成（${this.lastReply.text.length} 字符）`);
    return { text: this.lastReply.text, count: this.lastReply.count, ms: this.delay };
  }

  async ask(text) {
    const before = this.count;
    await this.sendMessage(text);
    const reply = await this.waitForReply();
    return { sentText: text, replyText: reply.text, conversationUrl: "mock://conversation/1", before };
  }

  async dispose() { /* noop */ }
}

// ---------- 自测 ----------
export async function selftest() {
  const mockLogger = { info: () => {}, warn: () => {}, error: () => {} };
  const mock = new MockGptBridge({ mockDelayMs: 10 }, mockLogger);
  let pass = 0, fail = 0;
  const check = (name, cond) => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}`); } };

  const r1 = await mock.ask("<ORCHESTRATOR><MSG_TYPE>PLAN_REQUEST</MSG_TYPE><CONTENT>做一个计算器</CONTENT></ORCHESTRATOR>");
  const { parseGptResponse, parsePlan } = await import("./protocol.mjs");
  const p1 = parseGptResponse(r1.replyText);
  check("mock READY", p1.status === "READY");
  check("mock plan tasks", parsePlan(p1.plan)?.tasks?.length === 3);

  const r2 = await mock.ask("<ORCHESTRATOR><MSG_TYPE>ANALYSIS</MSG_TYPE><CONTENT>分析完成</CONTENT></ORCHESTRATOR>");
  const p2 = parseGptResponse(r2.replyText);
  check("mock CONTINUE", p2.status === "CONTINUE" && p2.nextTask === "TASK-001");

  const r3 = await mock.ask("<ORCHESTRATOR><MSG_TYPE>REVIEW_REQUEST</MSG_TYPE><CONTENT>审查</CONTENT></ORCHESTRATOR>");
  check("mock DONE", parseGptResponse(r3.replyText).status === "DONE");

  const real = Object.assign(Object.create(GptBridge.prototype), { logger: mockLogger });
  check("keep current model by default", (await real.selectModel("", [])).chosenBy === "current");
  const picked = real.pickModel(["GPT-5.6 Sol", "GPT-5.6", "ChatGPT Plus"], "GPT-5.6 Sol", ["GPT-5\\.6", "Sol"]);
  check("model pick exact", picked.best === "GPT-5.6 Sol");
  const picked2 = real.pickModel(["o3", "GPT-5.6", "GPT-4.5"], null, ["5\\.6"]);
  check("model pick pattern", picked2.best === "GPT-5.6");

  console.log(`\nGPT Bridge 自测: ${pass} PASS / ${fail} FAIL`);
  return fail === 0;
}

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ok = await selftest();
  process.exit(ok ? 0 : 1);
}
