// ChatGPT Browser Bridge（无 API Key，纯浏览器自动化）
//
// 架构：Chrome（独立 Profile，登录态持久化）以 --remote-debugging-port 启动
//       → playwright-core 通过 CDP 连接（不下载浏览器、不碰用户主 Chrome）
// 能力：自动打开 ChatGPT、登录态检测、选择 GPT-5.6 Sol、新建会话、
//       自动输入/发送、生成完成检测（停止按钮 + 文本稳定，非固定 sleep）、
//       读取完整回复、项目级会话隔离（会话 URL 持久化）。
// 多级回退：data-testid → aria-label → 语义角色 → 键盘事件；全部失败不崩溃，
//       记录可用选择并继续（Adapter 模式，DOM 变化时可持续维护）。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { sleep } from "./logger.mjs";

export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // GPT_TIMEOUT | GPT_LOGIN_REQUIRED | GPT_CHALLENGE | GPT_PAGE_ERROR | GPT_BROWSER_ERROR
    this.name = "BridgeError";
  }
}

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  process.env.LOCALAPPDATA + "/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

function findChrome(cfgPath) {
  if (cfgPath && fs.existsSync(cfgPath)) return cfgPath;
  for (const p of CHROME_CANDIDATES) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
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
    this.chromePath = findChrome(this.cfg.chromePath);
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
  async isDebugPortUp() {
    try {
      await httpGetJson(`http://127.0.0.1:${this.cfg.debugPort}/json/version`, 1500);
      return true;
    } catch {
      return false;
    }
  }

  async launchChrome() {
    if (!this.chromePath) {
      throw new BridgeError("GPT_BROWSER_ERROR", "未找到 Chrome/Edge。请在 config/config.json 的 gpt.chromePath 中指定浏览器路径。");
    }
    const args = [
      `--remote-debugging-port=${this.cfg.debugPort}`,
      `--user-data-dir=${this.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate",
      "--window-size=1280,900",
      "--window-position=60,60",
      "--restore-last-session=false",
      "--disable-session-crashed-bubble",
      "about:blank",
    ];
    this.log("info", `启动浏览器: ${this.chromePath}（调试端口 ${this.cfg.debugPort}，Profile: ${this.profileDir}）`);
    const child = spawn(this.chromePath, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", (e) => this.log("error", `浏览器启动失败: ${e.message}`));
    child.unref();
    for (let i = 0; i < 40; i++) {
      if (await this.isDebugPortUp()) return true;
      await sleep(1000);
    }
    throw new BridgeError("GPT_BROWSER_ERROR", `Chrome 启动后调试端口 ${this.cfg.debugPort} 未就绪。`);
  }

  async ensureBrowser() {
    if (this.browser?.isConnected?.()) return true;
    try {
      if (!(await this.isDebugPortUp())) await this.launchChrome();
      this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.cfg.debugPort}`);
      const contexts = this.browser.contexts();
      const ctx = contexts[0] || (await this.browser.newContext());
      this.page = ctx.pages()[0] || (await ctx.newPage());
      this.page.setDefaultTimeout(30000);
      this.page.on("close", () => { this.page = null; });
      this.log("info", "CDP 连接成功");
      return true;
    } catch (e) {
      this.browser = null;
      this.page = null;
      throw new BridgeError("GPT_BROWSER_ERROR", `浏览器连接失败: ${e.message}`);
    }
  }

  async dispose() {
    try { await this.browser?.close(); } catch { /* ignore */ }
    this.browser = null;
    this.page = null;
  }

  // ---------- 页面状态 ----------
  async gotoChat() {
    await this.ensureBrowser();
    this.setLive("navigating", "打开 ChatGPT…");
    try {
      await this.page.goto(this.baseUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch { /* 导航超时也要继续检测 */ }
    await sleep(3000);
    return await this.detectState();
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

  async getSystemState() {
    let browserOk = false;
    try { browserOk = await this.isDebugPortUp(); } catch { /* ignore */ }
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
    await this.gotoChat();
    const state = await this.detectState();
    if (!state.loggedIn) {
      throw new BridgeError("GPT_LOGIN_REQUIRED", state.challenge ? "页面出现 Cloudflare 验证/挑战" : "未登录 ChatGPT");
    }
    const beforeUrl = this.page.url();
    const selectors = [
      { loc: this.page.locator('a[href="/"]', { hasText: "新聊天" }).first(), name: 'a[href="/"]:has-text(新聊天)' },
      { loc: this.page.locator('[aria-label="新聊天"]').first(), name: 'aria-label=新聊天' },
      { loc: this.page.locator('button[data-testid="new-chat-button"]').first(), name: "new-chat-button" },
      { loc: this.page.locator('button[aria-label*="New chat" i]').first(), name: "New chat" },
    ];
    for (const { loc, name } of selectors) {
      try {
        if (await loc.isVisible({ timeout: 2000 })) {
          await loc.click();
          this.log("info", `新建会话（${name}）`);
          break;
        }
      } catch { /* 尝试下一个 */ }
    }
    await sleep(2500);
    const afterUrl = this.page.url();
    // 验证：会话切换成功（URL 离开旧 /c/ 会话，或仍是首页空白）
    if (beforeUrl.includes("/c/") && afterUrl === beforeUrl) {
      // 点击可能没生效：再试一次
      for (const { loc } of selectors) {
        try { if (await loc.isVisible({ timeout: 1500 })) { await loc.click(); break; } } catch { /* ignore */ }
      }
      await sleep(2500);
      if (this.page.url() === beforeUrl) {
        throw new BridgeError("GPT_PAGE_ERROR", "无法新建会话（页面仍停留在旧会话，为防止污染已中止）");
      }
    }
    // 再验证消息区为空（防 SPA 静默失败）
    const counts = await this.page.evaluate(() => ({
      user: document.querySelectorAll('[data-message-author-role="user"]').length,
      assistant: document.querySelectorAll('[data-message-author-role="assistant"]').length,
    })).catch(() => null);
    if (counts && (counts.user > 0 || counts.assistant > 0)) {
      this.log("warn", `新会话页面仍有 ${counts.user + counts.assistant} 条消息（可能是首页预览），继续`);
    }
    this.log("info", `会话就绪: ${this.page.url()}`);
    return this.page.url();
  }

  // ---------- 模型选择 ----------
  async selectModel(modelName, matchPatterns) {
    await this.ensureBrowser();
    const chosen = { selected: null, available: [], chosenBy: null };
    try {
      // 0. 页面是否已显示目标模型（账号默认即 GPT-5.6 Sol 时无需切换）
      const pageHas = await this.page.evaluate((name) => {
        const pats = ["GPT-5.6", "GPT-5\\.6", "5\\.6", "Sol", name].filter(Boolean);
        const re = new RegExp(pats.join("|"), "i");
        const bodyText = document.body ? document.body.innerText : "";
        const labels = [...document.querySelectorAll("[aria-label], button, [role='menuitem']")]
          .map((el) => el.getAttribute("aria-label") || el.innerText || "").join(" ");
        return re.test(bodyText.slice(0, 30000)) || re.test(labels.slice(0, 20000));
      }, modelName).catch(() => false);

      // 1. 找模型切换按钮：优先"切换模型"按钮（助手消息旁/当前会话的），
      //    其次 composer 区域含模型名文本的可点击元素
      const switcher = this.page.locator(
        'button[aria-label="切换模型"], button[aria-label*="Switch model" i], [data-testid*="model-switcher"]'
      ).last(); // 最后一个 = 最新消息旁的
      let clicked = false;
      try {
        if (await switcher.isVisible({ timeout: 1500 })) {
          await switcher.click();
          clicked = true;
          this.log("info", "已点击“切换模型”按钮");
        }
      } catch { /* ignore */ }
      if (!clicked) {
        // composer 附近带模型名的按钮
        const near = this.page.locator('button:has-text("ChatGPT"), button:has-text("GPT"), [role="button"]:has-text("GPT")').last();
        try {
          if (await near.isVisible({ timeout: 1500 })) {
            await near.click();
            clicked = true;
            this.log("info", "已点击模型标签按钮");
          }
        } catch { /* ignore */ }
      }
      if (clicked) {
        await sleep(1300);
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
          await sleep(1500);
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
    if (await composer.isVisible({ timeout: 1500 }).catch(() => false)) {
      const box = await composer.boundingBox().catch(() => null);
      if (box && box.height < 400) return composer; // 正常高度（排除全屏编辑器等异常元素）
    }
    // 回退：逐个检查 contenteditable，选可见且高度合理者
    const all = this.page.locator('div[contenteditable="true"], textarea[contenteditable="true"], textarea');
    const n = await all.count();
    for (let i = 0; i < n; i++) {
      const c = all.nth(i);
      if (!(await c.isVisible({ timeout: 800 }).catch(() => false))) continue;
      const box = await c.boundingBox().catch(() => null);
      if (box && box.width > 200 && box.height > 20 && box.height < 400) return c;
    }
    return null;
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
    const state = await this.detectState();
    if (!state.loggedIn) throw new BridgeError("GPT_LOGIN_REQUIRED", "未登录，无法发送");
    if (state.challenge) throw new BridgeError("GPT_CHALLENGE", "页面出现验证挑战");
    this.setLive("sending", "正在输入消息…");

    let composer = null;
    for (let i = 0; i < 10; i++) {
      composer = await this.findComposer();
      if (composer) break;
      await sleep(2000);
    }
    if (!composer) throw new BridgeError("GPT_PAGE_ERROR", "找不到输入框（composer）");

    const userBefore = await this.page.evaluate(() =>
      document.querySelectorAll('[data-message-author-role="user"]').length
    ).catch(() => -1);

    await composer.click();
    await sleep(400);
    // 清空草稿
    try {
      await this.page.keyboard.press("Control+a");
      await this.page.keyboard.press("Delete");
      await sleep(200);
    } catch { /* ignore */ }

    if (Array.isArray(options.files) && options.files.length) {
      await this.attachFiles(options.files);
      // 文件选择会让浏览器焦点离开消息输入框，重新聚焦后再插入文字。
      await composer.click();
      await sleep(300);
    }

    // 主路径：insertText（换行安全、长文本可靠）
    await this.page.keyboard.insertText(text);
    await sleep(800);
    const tail = text.slice(-25).replace(/\s+/g, " ").slice(0, 15);
    let got = (await composer.innerText().catch(() => "")).replace(/\s+/g, " ");
    if (!got.includes(tail)) {
      // 回退路径：剪贴板粘贴（同样换行安全；绝不使用 keyboard.type——\n 会被当成回车发出）
      this.log("warn", "insertText 校验失败，改用剪贴板粘贴");
      try {
        await this.page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
          origin: new URL(this.baseUrl).origin,
        });
      } catch { /* ignore */ }
      await this.page.keyboard.press("Control+a");
      await this.page.keyboard.press("Delete");
      await this.page.evaluate((t) => navigator.clipboard.writeText(t), text).catch(async () => {
        // 页面上下文无剪贴板权限时，退回 CDP 输入（仅当失败才用，且不做逐字符 type）
        await this.page.keyboard.insertText(text);
      });
      await sleep(500);
      await this.page.keyboard.press("Control+v");
      await sleep(1000);
      got = (await composer.innerText().catch(() => "")).replace(/\s+/g, " ");
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
    let sent = false;
    for (const sel of sendSels) {
      const btn = this.page.locator(sel).first();
      const ok = await btn.isVisible({ timeout: 1200 }).catch(() => false);
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
      await this.page.keyboard.press("Enter");
    }
    this.setLive("sending", "消息已提交，等待生成…");

    // 发送验证：用户消息数应增加；若 15s 内未增加则报错（防静默失败/发进错误会话）
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      const userNow = await this.page.evaluate(() =>
        document.querySelectorAll('[data-message-author-role="user"]').length
      ).catch(() => -1);
      if (userBefore >= 0 && userNow > userBefore) break;
      if (i === 14) {
        throw new BridgeError("GPT_PAGE_ERROR", "消息发送后未检测到用户消息增加（可能未成功发送）");
      }
    }
    await sleep(1500);
    return { sent: true, url: this.page.url() };
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
    const poll = cfg.replyPollMs || 2500;
    const stableNeeded = cfg.stableChecks || 2;
    const start = Date.now();
    let lastText = "";
    let stable = 0;
    let sawNew = false;
    let noReplyWarned = false;
    this.setLive("waiting_reply", "等待 GPT 回复…");

    while (Date.now() - start < timeout) {
      await sleep(poll);
      if (shouldAbort?.()) throw new BridgeError("PROJECT_CANCELLED", "项目已暂停或删除");
      const info = await this.page.evaluate(() => {
        const arts = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
        const last = arts[arts.length - 1];
        const md = last ? last.querySelector(".markdown") || last : null;
        const text = md ? (md.innerText || "").trim() : "";
        const stop = !!document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop generating" i], button[aria-label*="停止" i]');
        const bodyText = document.body ? document.body.innerText.slice(0, 2000) : "";
        const challenge = /just a moment|verify you are human|checking your browser|access denied/i.test(bodyText);
        const pageError = /something went wrong|hmm\.\.\.something seems to have gone wrong|an error occurred/i.test(bodyText.slice(-1500));
        return { count: arts.length, text, stop, challenge, pageError };
      }).catch(() => null);

      if (!info) { await this.ensureBrowser().catch(() => {}); continue; }
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
            stable++;
            this.setLive("answering", `GPT 回答完成前校验（${stable}/${stableNeeded}）…`);
            if (stable >= stableNeeded) {
              this.live.replyChars = info.text.length;
              this.setLive("complete", `回复完成（${info.text.length} 字符）`);
              this.log("info", `回复完成（文本稳定 ${stableNeeded} 次，耗时 ${Math.round((Date.now() - start) / 1000)}s，${info.text.length} 字符）`);
              return { text: info.text, count: info.count, ms: Date.now() - start };
            }
          } else {
            lastText = info.text;
            stable = 0;
            this.live.replyChars = info.text.length;
          }
        } else {
          stable = 0;
        }
      }
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
  priority: high
  dependencies: []

- id: TASK-002
  description: 编写 README.md，说明项目用途、结构与运行方法
  priority: medium
  dependencies:
  - TASK-001

- id: TASK-003
  description: 运行验证：执行/检查产出，修复发现的问题
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

  const real = new GptBridge({ debugPort: 9333, profileDir: "browser-profile" }, mockLogger, process.cwd());
  check("find chrome", !!real.chromePath);
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
