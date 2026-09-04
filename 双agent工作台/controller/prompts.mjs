// GPT 规范维护在 docs/gpt-workbench-rules.md；DeepSeek 协议维护在 workbench-executor Skill。
import { buildSkillActivationLine, WORKBENCH_DISPATCH_MARKER } from "./workbench_skill.mjs";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { buildPlanningGuidance, planningPolicy } from "./planning_policy.mjs";

/** 随程序定位规则，不受启动目录或项目源码目录影响。每次发送读取，修改后下一轮生效。 */
export function buildGptInstructions(selection = {}) {
  const rules = fs.readFileSync(new URL("../docs/gpt-workbench-rules.md", import.meta.url), "utf8").trim();
  if (!rules) throw new Error("GPT 内置规范文档为空，无法初始化会话");
  const text = `${rules}\n\n## 当前执行者的指挥规则\n\n${buildDeepseekPlanningGuidance(selection)}\n`;
  const hash = createHash("sha256").update(text).digest("hex");
  const name = `gpt-workbench-rules-${hash.slice(0, 12)}.md`;
  const p = planningPolicy(selection);
  return {
    text, hash, name, relative_path: `instructions/${name}`,
    reminder: `当前指挥档：${p.key} · ${p.label}；model=${p.model}；reasoning=${p.reasoningEffort}。沿用规范 ${hash.slice(0, 12)}，回复仅含一个 <GPT_RESPONSE> 块。`,
  };
}

export const PLAN_TEMPLATES = {
  coding: "编码计划：按可验收目标和边界拆分，具体文件、方案与步骤的详细程度遵循当前指挥档；可自动检查时填写 validation_command。",
  bugfix: "Bug 修复计划：先定位根因，再做最小修复，最后用能复现问题的 validation 验证。",
  analysis: "分析计划：先收集证据，再形成结论；通常不填写会修改源码的验证命令。",
  docs: "文档计划：先核对现状与受众，再更新文档；validation 使用链接、格式或示例检查。",
};

export function buildPlanTemplateHint(task = "") {
  const text = String(task).toLowerCase();
  if (/bug|修复|故障|报错|错误/.test(text)) return PLAN_TEMPLATES.bugfix;
  if (/分析|调研|评估|报告/.test(text)) return PLAN_TEMPLATES.analysis;
  if (/文档|readme|说明/.test(text)) return PLAN_TEMPLATES.docs;
  return PLAN_TEMPLATES.coding;
}

/** 与计划校验共用同一规则，禁止提示与执行预算漂移。 */
export function buildDeepseekPlanningGuidance(selection = {}) {
  return buildPlanningGuidance(selection);
}

/**
 * 项目初始化消息（新会话首条）：Skill 启用入口 + 最小项目上下文 + 项目状态 + 执行要求。
 * 不再内嵌完整角色/协议文本，也不再在 Prompt 中重复整份计划与任务列表（执行者按需读 inbox/task.json）。
 */
export function buildExecutorPrompt(envelope) {
  if (envelope.result_repair) return buildExecutorTurnPrompt(envelope);
  return `${buildSkillActivationLine()}
这是工作台管理会话的首次任务。读取 ${envelope.workspace_dir}/inbox/task.json，以其中 type/current_task 为唯一执行指令；按 execution_guidance 确定应逐步执行还是自主实现，只处理本次任务。结果 created_at 必须由 new Date().toISOString() 或 [DateTime]::UtcNow.ToString('o') 生成，禁止给本地时间追加 Z。outbox 写成功即结束，系统会消费并删除它；不得再检查或补写，也不要继续检查项目状态。`;
}

/**
 * 复用同一会话时的精简任务提示：系统提示词（协议、文件约定）在会话创建时
 * 已发送过一次，此后每个任务只需让执行者重新读取 inbox/task.json 即可，
 * 不再重复注入完整系统提示词与整份计划，显著降低 token 消耗。
 */
export function buildExecutorTurnPrompt(envelope) {
  if (envelope.result_repair) return `[${WORKBENCH_DISPATCH_MARKER}] 只修复结果时间格式：读取 ${envelope.workspace_dir}/inbox/task.json 的 result_repair.original，保留其所有结果字段，仅用 new Date().toISOString() 或 [DateTime]::UtcNow.ToString('o') 生成真实 UTC created_at，原子写入 outbox/message.json。不要重新编码、不要修改源码、不要重做任务。禁止给本地时间追加 Z。完成后只回复 EXECUTOR_DONE。`;
  return `[${WORKBENCH_DISPATCH_MARKER}] 任务信封已更新：${envelope.workspace_dir}/inbox/task.json。只执行本次 type/current_task，按本轮信封 execution_guidance 决定指令深度与自主空间；沿用已加载协议。结果 created_at 用 new Date().toISOString() 或 [DateTime]::UtcNow.ToString('o')，禁止给本地时间追加 Z。outbox 写成功后立刻结束，不得因系统消费删除而补写或继续查状态。${envelope.attempt > 1 ? "这是重试，先读 executor_context_file 中的上次失败原因。" : ""}`;
}
