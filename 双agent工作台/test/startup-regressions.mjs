import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const entry = new URL("../controller/index.mjs", import.meta.url).href;
const windows = { skip: process.platform !== "win32", timeout: 20000 };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workbench 启动回归-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}

async function lockWorker(t, root, logs) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { acquireInstanceLock } from ${JSON.stringify(entry)};
    const messages = [];
    const acquired = await acquireInstanceLock({ dir: process.env.TEST_LOGS, error: (_, text) => messages.push(text) }, process.env.TEST_PROJECTS);
    process.on('message', () => process.exit(0));
    process.send({ acquired, messages });
  `], { env: { ...process.env, TEST_PROJECTS: root, TEST_LOGS: logs }, stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  });
  const [result] = await once(child, "message");
  return { child, ...result };
}

test("并发启动按真实项目路径互斥，日志目录不影响锁，进程退出自动释放", windows, async (t) => {
  const root = fixture(t);
  const projects = path.join(root, "Projects");
  fs.mkdirSync(projects);
  const contenders = await Promise.all([
    lockWorker(t, projects, path.join(root, "logs-a")),
    lockWorker(t, projects.toUpperCase().replace(/\\/g, "/"), path.join(root, "logs-b")),
  ]);
  assert.equal(contenders.filter((worker) => worker.acquired).length, 1);
  const holder = contenders.find((worker) => worker.acquired);
  const alias = path.join(root, "项目联接");
  fs.symlinkSync(projects, alias, "junction");
  assert.equal((await lockWorker(t, alias, root)).acquired, false);
  assert.equal((await lockWorker(t, path.join(root, "other-projects"), root)).acquired, true);
  const exited = once(holder.child, "exit");
  holder.child.kill();
  await exited;
  assert.equal((await lockWorker(t, projects, root)).acquired, true);
});

test("无法建立项目锁时停止启动，不继续操作数据", windows, async (t) => {
  const root = fixture(t);
  const invalid = path.join(root, "file.txt");
  fs.writeFileSync(invalid, "keep");
  const worker = await lockWorker(t, invalid, root);
  assert.equal(worker.acquired, false);
  assert.match(worker.messages.join("\n"), /已停止启动/);
  assert.equal(fs.readFileSync(invalid, "utf8"), "keep");
});

test("统一启动器支持异地调用、中文空格路径、参数与退出码透传", windows, async (t) => {
  const root = fixture(t);
  const app = path.join(root, "应用 带空格");
  fs.mkdirSync(path.join(app, "controller"), { recursive: true });
  fs.copyFileSync(path.join(appRoot, "start.ps1"), path.join(app, "start.ps1"));
  fs.copyFileSync(path.join(appRoot, "..", "start.bat"), path.join(root, "start.bat"));
  const dependency = path.join(root, "node_modules", "playwright-core");
  fs.mkdirSync(dependency, { recursive: true });
  fs.writeFileSync(path.join(dependency, "index.js"), "");
  fs.writeFileSync(path.join(app, "controller", "index.mjs"), `
    import fs from 'node:fs';
    fs.writeFileSync(process.env.TEST_OUTPUT, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));
    process.exit(7);
  `);
  const output = path.join(root, "result.json");
  const dataDir = path.join(root, "数据 目录=a");
  const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${path.join(root, "start.bat")}" "--data-dir=${dataDir}" --port=3801 --no-open"`], {
    cwd: os.tmpdir(), env: { ...process.env, TEST_OUTPUT: output }, windowsHide: true, windowsVerbatimArguments: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stdout.on("data", (chunk) => { diagnostics += chunk; });
  child.stderr.on("data", (chunk) => { diagnostics += chunk; });
  child.stdin.end("\r\n");
  const [code] = await once(child, "exit");
  assert.equal(code, 7, diagnostics);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), {
    cwd: root,
    args: ["--open", `--data-dir=${dataDir}`, "--port=3801", "--no-open"],
  });
});
