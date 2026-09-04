import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { findBrowser } from "../controller/browser_runtime.mjs";
import { GptBridge } from "../controller/gpt_bridge.mjs";
import { testBrowserPath } from "./browser-test-support.mjs";

const environmentKeys = ["CHROME_PATH", "PATH", "SystemDrive", "ProgramW6432", "ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"];
const rootDir = fileURLToPath(new URL("../", import.meta.url));

function fixture(t) {
  const saved = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  for (const key of environmentKeys) delete process.env[key];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-discovery-"));
  t.after(() => {
    for (const key of environmentKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return (relative) => {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, "discovery fixture; never execute");
    return filename;
  };
}

test("浏览器发现：CHROME_PATH 优先，显式失效路径不静默回退", (t) => {
  const file = fixture(t);
  const configured = file("configured/chrome.exe");
  const environment = file("environment/msedge.exe");
  process.env.CHROME_PATH = environment;
  assert.equal(findBrowser(configured), environment);
  process.env.CHROME_PATH = path.join(path.dirname(environment), "missing.exe");
  assert.throws(() => findBrowser(configured), /CHROME_PATH/);
  delete process.env.CHROME_PATH;
  assert.equal(findBrowser(configured), configured);
  assert.throws(() => findBrowser(path.dirname(configured)), /gpt.chromePath/);
});

test("浏览器发现：PATH、用户目录及自定义 Program Files，无固定系统盘", (t) => {
  const file = fixture(t);
  const fromPath = file("custom path/msedge.exe");
  process.env.PATH = `"${path.dirname(fromPath)}"`;
  assert.equal(findBrowser(), fromPath);
  delete process.env.PATH;
  const local = file("user profile/Google/Chrome/Application/chrome.exe");
  process.env.LOCALAPPDATA = path.resolve(local, "../../../..");
  assert.equal(findBrowser(), local);
  delete process.env.LOCALAPPDATA;
  const program = file("Applications/Microsoft/Edge/Application/msedge.exe");
  process.env.ProgramFiles = path.resolve(program, "../../../..");
  assert.equal(findBrowser(), program);
});

test("浏览器发现：相对环境路径按应用根目录解析，未安装返回 null", (t) => {
  const file = fixture(t);
  assert.equal(findBrowser(), null);
  const executable = file("browser/chrome.exe");
  process.env.CHROME_PATH = path.relative(rootDir, executable);
  assert.equal(findBrowser(), executable);
});

test("未指定 GPT 模型时保留当前模型，不打开菜单或启动浏览器", async () => {
  const bridge = Object.assign(Object.create(GptBridge.prototype), {
    logger: null, ensureBrowser() { throw new Error("不应启动浏览器"); },
  });
  assert.equal((await bridge.selectModel("", [])).chosenBy, "current");
});

test("无浏览器时集成测试明确跳过，UI 脚本提示安装方法", (t) => {
  fixture(t);
  let reason;
  assert.equal(testBrowserPath({ skip(message) { reason = message; } }), null);
  assert.match(reason, /CHROME_PATH/);
  assert.throws(() => testBrowserPath(), /请安装浏览器/);
});
