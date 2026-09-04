import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, parseArgs } from "../controller/config.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "工作台 配置="));
  fs.mkdirSync(path.join(root, "config"));
  fs.copyFileSync(new URL("../config/config.json", import.meta.url), path.join(root, "config/config.json"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("fresh defaults use the new user's runtime and remain rooted after relocation", (t) => {
  const root = fixture(t);
  const config = loadConfig({}, root, {});
  assert.equal(config.deepseek.nodeBin, process.execPath);
  assert.equal(config.deepseek.dshBin, "");
  assert.equal(config.gpt.modelName, "");
  assert.equal(config.projectsRoot, path.join(root, "projects"));
  assert.equal(config.gpt.profileDir, path.join(root, "browser-profile"));
});

test("BOM local overrides merge without discarding defaults; CLI paths preserve equals", (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "config/config.local.json"), '\uFEFF' + JSON.stringify({ dashboard: { port: 4010 }, gpt: { modelMatch: ["Example"] }, deepseek: { dshBin: "tools/dsh/lib/bin.js" } }));
  const config = loadConfig(parseArgs(["--port=4020", "--projects=团队 项目=a", "--data-dir=本机数据", "--gpt=mock"]), root, {});
  assert.equal(config.dashboard.host, "127.0.0.1");
  assert.equal(config.dashboard.port, 4020);
  assert.deepEqual(config.gpt.modelMatch, ["Example"]);
  assert.equal(config.projectsRoot, path.join(root, "团队 项目=a"));
  assert.equal(config.logsDir, path.join(root, "本机数据/logs"));
  assert.equal(config.deepseek.dshBin, path.join(root, "tools/dsh/lib/bin.js"));
});

test("environment overrides config and invalid ports/modes fail before startup", (t) => {
  const root = fixture(t);
  const config = loadConfig({}, root, { WORKBENCH_PORT: "4011", DSH_BIN: "custom/lib/bin.js", CHROME_PATH: "browser/chrome.exe" });
  assert.equal(config.dashboard.port, 4011);
  assert.equal(config.deepseek.dshBin, path.join(root, "custom/lib/bin.js"));
  assert.equal(config.gpt.chromePath, path.join(root, "browser/chrome.exe"));
  for (const port of ["abc", "0", "65536", "3.5"]) assert.throws(() => loadConfig({ port }, root, {}), /port/);
  assert.throws(() => loadConfig({ gpt: "typo" }, root, {}), /mode/);
  assert.throws(() => parseArgs(["--pot=42"]), /未知参数/);
});
