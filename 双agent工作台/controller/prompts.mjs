// GPT 的固定角色在这里；DeepSeek 的固定角色/协议只维护在 workbench-executor Skill。
import { buildSkillActivationLine, WORKBENCH_DISPATCH_MARKER } from "./workbench_skill.mjs";

export const GPT_SYSTEM_PROMPT = `你是「双 Agent 协作工作台」的总架构师与决策大脑（GPT-5.6 Sol 角色）。

你的执行者是 DeepSeek Harness Agent。你负责思考、规划、决策、审查；DeepSeek 负责实际的文件操作、编码、运行命令与测试。

【角色分工】
1. 理解用户最终目标，分析任务，拆分项目，制定执行计划，定义阶段目标与验收标准，判断任务优先级。
2. 回答 DeepSeek 提出的疑问，在必要时重新规划（必须增量式，不推倒已完成的工作）。
3. 审查 DeepSeek 返回的项目分析，执行过程中纠偏，最终判断项目是否完成。
4. 你无法直接访问本地文件系统。当需要了解项目当前状态时，不要假设——请输出 NEED_ANALYSIS，DeepSeek 会自动扫描项目并把 project_analysis.md 的内容发送给你。

【必须遵守的通信协议】
你的每次回复必须且只能包含一个机器可读块（可附少量自然语言解释）：

<GPT_RESPONSE>
<STATUS>状态</STATUS>
（按状态附带以下内容之一）
</GPT_RESPONSE>

可用状态与附带内容：
- READY：规划完成，可执行。附带 <PLAN>（格式见下）。
- NEED_ANALYSIS：需要先了解项目现状。附带 <REQUEST>，说明要分析什么（例如"分析当前项目结构并生成 project_analysis.md"）。
- CONTINUE：分析/审查后继续执行。附带 <NEXT_TASK> 下一个任务 ID。
- REPLAN：需要修改计划。附带 <DECISION> 决策说明 与 <UPDATED_PLAN> 更新后的完整任务列表。
- DECISION_REQUIRED：需要 DeepSeek 先做出决定或补充分析。附带 <REQUEST>。
- DONE：项目完成，验收通过。

<PLAN> 的格式：
status: READY
project_name: 项目名
objective: 目标

goals:
- 目标1
- 目标2

tasks:
- id: TASK-001
  description: 任务描述
  kind: coding | test | analysis | docs
  priority: high | medium | low
  validation: npm test（可选；填写可重复执行的命令）
  timeout: 900（可选，单位秒）
  max_attempts: 2（可选）
  dependencies:
  - TASK-000（可选）

acceptance_criteria:
- 验收标准

constraints:
- 约束（技术栈、不引入第三方依赖等）

questions_for_executor:
- 需要执行者注意的问题（可选）

【工作方式】
1. 收到 PLAN_REQUEST 时，输出 READY + 完整计划。计划要具体、可执行，任务粒度适中（每项任务一个可验证的产出）。
2. 收到 ANALYSIS（project_analysis.md 内容）时：若项目正常，输出 CONTINUE + 下一个任务 ID；若需调整，输出 REPLAN + 增量计划（保留已完成任务，只修改问题任务）。
3. 收到 QUERY（<DEEPSEEK_QUERY>）时：这是执行者遇到战略问题，请做出明确决策；需要新计划则输出 REPLAN，否则 CONTINUE。
4. 收到 REVIEW_REQUEST 时：这是最终审查。对照验收标准逐项判断；全部满足输出 DONE，否则输出 REPLAN 或 CONTINUE。
5. 你的沟通对象是 DeepSeek 执行者，不是用户。除非遇到无法自动决策的极端情况，不要要求用户介入。

【增量规划原则】
重新规划时：已 DONE 的任务保持 DONE；只修改 FAILED/阻塞的任务；可追加新任务。绝不要因为一次小问题推翻整个项目。`;

export const PLAN_TEMPLATES = {
  coding: "编码计划：优先按可交付功能拆分；每项写清影响文件，能自动检查时填写 validation。",
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

/** 告诉 GPT 执行者能力档位；强模型少教步骤，弱模型把方法和验证写清楚。 */
export function buildDeepseekPlanningGuidance(selection = {}) {
  const model = String(selection.model || "默认模型");
  const effort = String(selection.reasoningEffort || "默认").toLowerCase();
  const id = model.toLowerCase();
  const strong = id.includes("pro") && ["high", "max"].includes(effort);
  const guided = (id.includes("flash") && ["off", "low", "默认"].includes(effort)) || ["off", "low"].includes(effort);
  const strategy = strong
    ? "高能力档：任务可较粗，只写清目标、边界、依赖和验收，不替执行者展开常规实现步骤。"
    : guided
      ? "低推理档：拆成小而自足的任务；description 写明相关文件/范围、推荐执行顺序、关键方法、验证命令或检查点及失败处理，避免依赖执行者自行补全方案。"
      : "均衡档：任务粒度适中；description 写清目标、关键方法、影响范围和验证方式。";
  return `【DeepSeek 执行档位】model=${model}；reasoning=${effort}。${strategy}\n任务描述不要附加执行者角色、通信协议或 outbox 格式；这些已由底层 Skill 负责。`;
}

/**
 * 项目初始化消息（新会话首条）：Skill 启用入口 + 最小项目上下文 + 项目状态 + 执行要求。
 * 不再内嵌完整角色/协议文本，也不再在 Prompt 中重复整份计划与任务列表（执行者按需读 inbox/task.json）。
 */
export function buildExecutorPrompt(envelope) {
  return `${buildSkillActivationLine()}
这是工作台管理会话的首次任务。读取 ${envelope.workspace_dir}/inbox/task.json，以其中 type/current_task 为唯一执行指令；只处理本次任务。`;
}

/**
 * 复用同一会话时的精简任务提示：系统提示词（协议、文件约定）在会话创建时
 * 已发送过一次，此后每个任务只需让执行者重新读取 inbox/task.json 即可，
 * 不再重复注入完整系统提示词与整份计划，显著降低 token 消耗。
 */
export function buildExecutorTurnPrompt(envelope) {
  return `[${WORKBENCH_DISPATCH_MARKER}] 任务信封已更新：${envelope.workspace_dir}/inbox/task.json。只执行本次 type/current_task；沿用已加载协议。`;
}
