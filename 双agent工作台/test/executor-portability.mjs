import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findDshBin, requireDshBin } from "../controller/executor_runtime.mjs";
import { DeepseekRunner } from "../controller/deepseek_runner.mjs";
import { UiExecutor } from "../controller/dsh_ui.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "工作台 executor test "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(file, content = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return file;
}

function install(prefix) {
  const dir = path.join(prefix, "node_modules", "@deepseek-ai", "dsh");
  write(path.join(dir, "package.json"), JSON.stringify({ bin: { dsh: "lib/bin.js" } }));
  return write(path.join(dir, "lib", "bin.js"), "process.exit(0);\n");
}

function clearOverride(t) {
  const before = process.env.DSH_BIN;
  delete process.env.DSH_BIN;
  t.after(() => { if (before === undefined) delete process.env.DSH_BIN; else process.env.DSH_BIN = before; });
}

test("执行器环境覆盖优先，相对路径锚定项目目录，坏覆盖明确缺失", (t) => {
  const rootDir = fixture(t);
  const configured = write(path.join(rootDir, "配置", "bin.js"));
  const overridden = write(path.join(rootDir, "环境", "bin.js"));
  assert.equal(findDshBin(configured, { rootDir, env: { DSH_BIN: "环境/bin.js" }, npmRoot: false }), overridden);
  assert.equal(findDshBin("配置/bin.js", { rootDir, env: {}, npmRoot: false }), configured);
  assert.equal(findDshBin(configured, { rootDir, env: { DSH_BIN: "不存在.js" }, npmRoot: false }), null);
});

test("拉取到中文空格目录后可发现仓库根的本地 npm 安装", (t) => {
  const root = fixture(t);
  const bin = install(root);
  const app = path.join(root, "双 agent 工作台");
  fs.mkdirSync(app);
  assert.equal(findDshBin("", { rootDir: app, env: {}, npmRoot: false }), bin);
});

test("当前用户全局安装和自定义 npm prefix 不依赖作者用户名", (t) => {
  const root = fixture(t);
  const app = path.join(root, "app");
  fs.mkdirSync(app);
  const userData = path.join(root, "另一个用户", "Roaming");
  const userBin = install(path.join(userData, "npm"));
  assert.equal(findDshBin("", { rootDir: app, env: { APPDATA: userData }, nodePath: path.join(root, "node.exe"), npmRoot: false }), userBin);
  const custom = path.join(root, "自定义 npm");
  const customBin = install(custom);
  assert.equal(findDshBin("", { rootDir: app, env: { NPM_CONFIG_PREFIX: custom }, npmRoot: false }), customBin);
  assert.equal(findDshBin("", { rootDir: app, env: { Path: custom }, npmRoot: false }), customBin);
});

test("npmrc 自定义全局目录由 npm root 解析，完整保留空格", (t) => {
  const root = fixture(t);
  const app = path.join(root, "app");
  fs.mkdirSync(app);
  const prefix = path.join(root, "npmrc 目录");
  const bin = install(prefix);
  const cli = write(path.join(root, "npm-cli.js"), "process.stdout.write(" + JSON.stringify(path.join(prefix, "node_modules")) + ");");
  assert.equal(findDshBin("", { rootDir: app, env: { npm_execpath: cli }, nodePath: process.execPath }), bin);
});

test("未安装时真实执行返回安装指引，mock 构造不要求 Harness", (t) => {
  clearOverride(t);
  const missing = path.join(fixture(t), "missing.js");
  assert.throws(() => requireDshBin({ dshBin: missing }), (error) => error.code === "RUNNER_NOT_INSTALLED" && error.message.includes("DSH_BIN"));
  assert.doesNotThrow(() => new DeepseekRunner({ mode: "mock", dshBin: missing }, null));
});

test("新用户专用 profile 自动初始化，补齐缺文件且保留已有用户配置", (t) => {
  const root = fixture(t);
  const ui = new UiExecutor({}, null);
  ui.dshHome = () => root;
  const profile = ui.ensureProfile();
  const manifest = JSON.parse(fs.readFileSync(path.join(profile.dir, "package.json"), "utf8"));
  assert.deepEqual(manifest.dsh.profile.bundles, ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]);
  assert.equal(fs.existsSync(path.join(profile.skillRoot, "workbench-executor", "SKILL.md")), true);
  write(path.join(profile.dir, "cordis.patch.yml"), "# 保留用户设置\n[]\n");
  fs.unlinkSync(path.join(profile.dir, "pnpm-workspace.yaml"));
  ui.ensureProfile();
  assert.equal(fs.readFileSync(path.join(profile.dir, "cordis.patch.yml"), "utf8"), "# 保留用户设置\n[]\n");
  assert.equal(fs.existsSync(path.join(profile.dir, "pnpm-workspace.yaml")), true);
  ui.cfg.uiProfile = "../escape";
  assert.throws(() => ui.ensureProfile(), /合法文件夹/);
});

test("headless 使用当前 Node，中文空格路径和任务提示词原样传入", async (t) => {
  clearOverride(t);
  const root = fixture(t);
  const dshBin = write(path.join(root, "执行器 安装", "bin.cjs"),
    "console.log(JSON.stringify({ node: process.execPath, cwd: process.cwd(), args: process.argv.slice(2) }));");
  const runner = new DeepseekRunner({ mode: "real", dshBin }, null);
  runner.ui.dshHome = () => path.join(root, "独立配置");
  const dirs = { projectDir: root, workspaceDir: path.join(root, ".gpt_workspace"), sourceDir: path.join(root, "源码 空格") };
  fs.mkdirSync(dirs.sourceDir);
  const prompt = '处理 "中文 文件" & 保留参数';
  const result = await runner.runHeadless("test", dirs, { type: "ANALYZE", timeoutMs: 5000 }, prompt);
  assert.equal(result.exitCode, 0);
  const output = JSON.parse(fs.readFileSync(result.logFile, "utf8"));
  assert.equal(output.node, process.execPath);
  assert.equal(output.cwd, dirs.sourceDir);
  assert.deepEqual(output.args, ["--profile", "headless", prompt]);
});

test("可见服务的 Node 启动失败能快速返回并清理服务记录", async (t) => {
  clearOverride(t);
  const root = fixture(t);
  const dshBin = write(path.join(root, "bin.js"));
  const ui = new UiExecutor({ dshBin, nodeBin: path.join(root, "不存在-node.exe"), uiBootTimeoutMs: 30000 }, null);
  ui.dshHome = () => path.join(root, "profile");
  const started = Date.now();
  assert.equal(await ui.ensureServer("test", path.join(root, "logs")), null);
  assert.equal(ui.servers.size, 0);
  assert.ok(Date.now() - started < 5000);
});
