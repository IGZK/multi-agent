import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));

export const BROWSER_HELP = "未找到 Chrome/Edge/Chromium。请安装浏览器，或将 CHROME_PATH 环境变量（也可在 config/config.local.json 的 gpt.chromePath）设为浏览器可执行文件的完整路径。";

function isFile(filename) {
  try { return fs.statSync(filename).isFile(); } catch { return false; }
}

export function findBrowser(hint = "") {
  const explicit = (process.env.CHROME_PATH || hint || "").trim();
  if (explicit) {
    const filename = path.resolve(rootDir, explicit);
    if (!isFile(filename)) throw new Error(`浏览器路径无效：${explicit}。请检查 ${process.env.CHROME_PATH ? "CHROME_PATH" : "gpt.chromePath"}。`);
    return filename;
  }

  const candidates = [];
  for (const directory of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const executable of ["chrome.exe", "msedge.exe", "chromium.exe"]) {
      candidates.push(path.join(directory.replace(/^"|"$/g, ""), executable));
    }
  }
  const systemDrive = process.env.SystemDrive;
  const programDirs = [process.env.ProgramW6432, process.env.ProgramFiles, process.env["ProgramFiles(x86)"],
    systemDrive && path.join(systemDrive + path.sep, "Program Files"),
    systemDrive && path.join(systemDrive + path.sep, "Program Files (x86)"), process.env.LOCALAPPDATA];
  for (const directory of new Set(programDirs.filter(Boolean))) {
    for (const executable of ["Google/Chrome/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe", "Chromium/Application/chrome.exe"]) {
      candidates.push(path.join(directory, executable));
    }
  }
  return candidates.find(isFile) || null;
}

export async function openBrowserWindow(url, hint = "") {
  const executable = findBrowser(hint);
  if (!executable) return false;
  const child = spawn(executable, ["--new-window", url], { detached: true, stdio: "ignore", windowsHide: true });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (error) => reject(new Error(`浏览器启动失败：${error.message}`)));
  });
  child.unref();
  return true;
}
