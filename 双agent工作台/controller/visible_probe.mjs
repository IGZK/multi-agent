// 可见执行模式回归探针：直接驱动 DeepseekRunner 的可见执行路径
// （独立 dsh web 服务 → session.create → session.prompt → 轮询 outbox → 清理）。
// 运行：node controller/visible_probe.mjs [--open-window]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { DeepseekRunner } from "./deepseek_runner.mjs";

const DSH_BIN = process.env.DSH_BIN || "C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js";
const PROFILE = process.env.UI_PROFILE || "workbench-exec";

async function main() {
  const openWindow = process.argv.includes("--open-window");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "visible-runner-"));
  const dirs = {
    projectDir: tmp,
    workspaceDir: path.join(tmp, ".gpt_workspace"),
    sourceDir: path.join(tmp, "source"),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(dirs.workspaceDir, "inbox"), { recursive: true });
  fs.mkdirSync(path.join(dirs.workspaceDir, "outbox"), { recursive: true });
  fs.mkdirSync(path.join(dirs.workspaceDir, "logs"), { recursive: true });

  const logger = {
    info: (s, m) => console.log(`[runner] INFO [${s}] ${m}`),
    warn: (s, m) => console.log(`[runner] WARN [${s}] ${m}`),
    error: (s, m) => console.log(`[runner] ERROR [${s}] ${m}`),
  };
  const cfg = {
    mode: "real",
    visible: true,
    uiOpenWindow: openWindow,
    nodeBin: "node",
    dshBin: DSH_BIN,
    profile: "headless",
    uiProfile: PROFILE,
    uiBootTimeoutMs: 180000,
    executorTimeoutMs: 300000,
  };
  const runner = new DeepseekRunner(cfg, logger);

  const envelope = {
    type: "EXECUTE_PLAN",
    plan: { tasks: [] },
    current_task: { id: "TASK-PROBE", description: "在 source 目录创建 ui-probe.txt，内容 ui-ok" },
    completed_tasks: [],
    failed_tasks: [],
    gpt_message: null,
    attempt: 1,
    project_name: "可见执行探针",
    user_task: "探针任务",
  };

  const t0 = Date.now();
  const result = await runner.run("probe", dirs, envelope, null);
  const artifact = path.join(dirs.sourceDir, "ui-probe.txt");
  const fileOk = fs.existsSync(artifact) && fs.readFileSync(artifact, "utf8").includes("ui-ok");
  const outbox = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(dirs.workspaceDir, "outbox", "message.json"), "utf8")); }
    catch { return null; }
  })();

  console.log(`[probe] result: exitCode=${result.exitCode} timedOut=${result.timedOut} visible=${result.visible} ms=${result.ms}`);
  console.log(`[probe] uiInfo: ${JSON.stringify(runner.uiInfo("probe"))}`);
  console.log(`[probe] 文件产出: ${fileOk ? "PASS" : "FAIL"}（${artifact}）`);
  console.log(`[probe] outbox 信封: ${outbox ? `PASS（type=${outbox.type}, task=${outbox.task_id}）` : "FAIL（未写 outbox）"}`);
  console.log(`[probe] 总耗时: ${Math.round((Date.now() - t0) / 1000)}s`);

  const ok = result.exitCode === 0 && result.visible && fileOk && !!outbox && outbox.type === "TASK_DONE";
  runner.shutdownAll();
  await new Promise((r) => setTimeout(r, 1500));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\n可见执行模式自测: ${ok ? "ALL PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error("[probe] fatal:", e); process.exit(1); });
}
