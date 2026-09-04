// 原生系统文件夹选择器：由后端 Node 进程弹出 Windows 文件夹选择对话框，
// 返回用户选中的绝对路径，供前端「点击选择项目文件夹」使用。
//
// 说明：
// - 工作台前端是纯 Web 页面，浏览器出于安全设计无法把本地文件夹的「绝对路径」
//   交给后端（showDirectoryPicker 只返回句柄、input[webkitdirectory] 不暴露路径），
//   因此必须由与用户同机运行、具备本地权限的后端来弹出系统级目录选择器。
// - 这里复用 Windows 自带的 System.Windows.Forms.FolderBrowserDialog（经
//   powershell.exe -STA 承载，WinForms 对话框要求单线程套间）。
// - 只在 Windows 上可用；其它平台会返回明确错误，前端可回退到手动输入路径。

import { spawn } from "node:child_process";
import path from "node:path";

const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue

$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = '请选择项目文件夹（DeepSeek 将在此目录中执行任务）'
$dlg.ShowNewFolderButton = $true

$StartPath = '__START_PATH__'
if ($StartPath -ne '' -and (Test-Path -LiteralPath $StartPath -PathType Container)) {
    $dlg.SelectedPath = $StartPath
}

# 用一个置顶宿主窗口作 owner，确保对话框弹到前台
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
$owner.Show()

$res = $dlg.ShowDialog($owner)
$owner.Close()

if ($res -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.Write($dlg.SelectedPath)
} else {
    [Console]::Out.Write('')
}
`;

/** 生成完整 PowerShell 脚本（把起始路径安全地塞进单引号字符串） */
export function buildScript(startPath = "") {
  const safe = String(startPath || "").replace(/'/g, "''");
  return PS_SCRIPT.replace("__START_PATH__", () => safe);
}

/** 把脚本编码为 powershell.exe -EncodedCommand 所需的 UTF-16LE base64 */
export function toEncodedCommand(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function defaultPsExe() {
  const sysRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  return path.join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * 启动 powershell.exe 并收集 stdout/stderr。
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
export function spawnPowerShell(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const psExe = opts.psExe || defaultPsExe();
    const timeoutMs = opts.timeoutMs || 300000;
    let child;
    try {
      child = spawn(psExe, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      reject(new Error(`无法启动文件夹选择器: ${e.message}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error("选择文件夹超时（对话框已关闭）"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d) => { stdout += d; });
    child.stderr.setEncoding("utf8").on("data", (d) => { stderr += d; });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`文件夹选择器进程错误: ${e.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * 弹出系统文件夹选择器。
 * @param {string} startPath 初始定位的目录（可选）
 * @param {object} opts {psExe, timeoutMs}
 * @returns {Promise<string|null>} 选中的绝对路径；用户取消时返回 null
 */
export async function pickFolder(startPath = "", opts = {}) {
  if (process.platform !== "win32") {
    throw new Error("原生文件夹选择仅在 Windows 环境可用");
  }
  const encoded = toEncodedCommand(buildScript(startPath));
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-EncodedCommand", encoded];
  const { code, stdout, stderr } = await spawnPowerShell(args, opts);
  const out = stdout.replace(/[\r\n]+$/, "").trim();
  if (code !== 0 && out === "") {
    throw new Error(stderr.trim() || `文件夹选择器异常退出（code=${code}）`);
  }
  return out || null;
}

// ---------- 自测（不弹对话框：仅校验脚本语法与 spawn 管道） ----------
export async function selftest() {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  };

  // 1. 脚本生成：起始路径被正确转义
  const s1 = buildScript("C:\\Users\\O'Brien");
  check("buildScript 转义单引号", s1.includes("C:\\Users\\O''Brien"), "");

  // 2. 脚本语法：用 powershell 解析器检查（不执行 ShowDialog）
  const script = buildScript("C:\\Windows");
  const parseEncoded = toEncodedCommand(
    `$ErrorActionPreference='Stop'\n` +
    `$tokens=$null; $errors=$null\n` +
    `[System.Management.Automation.Language.Parser]::ParseInput(@'\n${script}\n'@, [ref]$tokens, [ref]$errors) | Out-Null\n` +
    `if ($errors -and $errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; [Console]::Out.Write('SYNTAX_ERROR') } else { [Console]::Out.Write('SYNTAX_OK') }`
  );
  const pr = await spawnPowerShell(["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-EncodedCommand", parseEncoded], { timeoutMs: 30000 });
  check("PowerShell 脚本语法", pr.stdout.trim() === "SYNTAX_OK", pr.stdout.trim() || pr.stderr.trim());

  // 3. spawn 管道：真实启动 powershell 并回读路径（不弹窗）
  const echoEncoded = toEncodedCommand(`[Console]::Out.Write('C:\\fake\\picked\\dir')`);
  const er = await spawnPowerShell(["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-EncodedCommand", echoEncoded], { timeoutMs: 30000 });
  check("spawn+stdout 管道回读", er.code === 0 && er.stdout.trim() === "C:\\fake\\picked\\dir", `code=${er.code} out=${JSON.stringify(er.stdout.trim())}`);

  // 4. Windows PowerShell 在重定向 stdout 时默认可能使用系统代码页；显式固定 UTF-8，
  // 防止中文项目目录被 Node 误解码成乱码路径。
  const unicodePath = "C:\\用户\\双agent工作台";
  const unicodeEncoded = toEncodedCommand(`[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);[Console]::Out.Write('${unicodePath}')`);
  const ur = await spawnPowerShell(["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-EncodedCommand", unicodeEncoded], { timeoutMs: 30000 });
  check("中文路径 UTF-8 回读", ur.code === 0 && ur.stdout.trim() === unicodePath, `code=${ur.code} out=${JSON.stringify(ur.stdout.trim())}`);

  const allOk = results.every((r) => r.ok);
  console.log(`\nFolderPicker 自测: ${allOk ? "ALL PASS" : "FAIL"}`);
  return allOk;
}

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ok = await selftest();
  process.exit(ok ? 0 : 1);
}
