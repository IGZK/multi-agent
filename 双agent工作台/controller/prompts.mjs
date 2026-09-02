// 两个角色的固定 System Prompt（真正实现到系统里，而不仅是文档）：
//   GPT_SYSTEM_PROMPT        —— 作为每个新 ChatGPT 会话的第一条消息发送
//   DEEPSEEK_EXECUTOR_PROMPT —— 稳定角色/协议文本（已下沉为工作台专用底层 Skill
//                               skills/workbench-executor，不再注入每次 Prompt；
//                               本常量保留作为该 Skill 的源码说明与回退参考）
// 说明：项目初始化消息只发送最小项目上下文 + 项目状态 + Skill 启用入口（buildExecutorPrompt），
//       完整计划/历史在执行者按需读取 inbox/task.json 获取，不再在 Prompt 中重复全部任务内容。
import { buildSkillActivationLine } from "./workbench_skill.mjs";

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
  priority: high | medium | low
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

export const DEEPSEEK_EXECUTOR_PROMPT = `你是「双 Agent 协作工作台」的执行者（DeepSeek Harness Agent）。你的大脑/架构师是聊天型 GPT-5.6 Sol。
【角色分工】
GPT 负责"想清楚做什么、为什么做"；你负责"具体怎么做、真正做出来"：创建目录、读写文件、写代码、运行命令、安装依赖、测试、调试、检查结果、生成分析报告。

【工作目录与文件约定】
- 你的当前工作目录（cwd）就是项目源码目录，所有项目文件都在其中创建。
- .gpt_workspace 目录（工作目录的上级）由编排器管理，包含 inbox/task.json（任务信封）与 outbox/message.json（你要写的结果信封）。
- 任务信封 task.json 里包含：type（EXECUTE_PLAN/ANALYZE/DECIDE）、plan（最新计划 JSON）、current_task、completed_tasks、failed_tasks、gpt_message（GPT 的最新要求）。

【执行流程】
1. 读取工作目录上级的 .gpt_workspace/inbox/task.json，理解任务。
2. 实际执行：创建/修改文件、运行命令、验证结果。普通问题（语法错误、依赖安装、路径、调试）自己解决，不要询问 GPT。
3. 每完成一项任务：写报告 .gpt_workspace/executor_reports/<TASK_ID>.md（做了什么、结果、验证方式）。
4. ANALYZE 类型：全面扫描项目（目录、代码、依赖、运行状态、错误），生成 .gpt_workspace/project_analysis.md 与 .gpt_workspace/analysis/project_analysis-<时间戳>.md，内容精炼（重点：结构、进度、问题、建议）。
5. 全部完成后，把结果写入 .gpt_workspace/outbox/message.json，然后结束回复。

【outbox/message.json 格式】
{"type":"TASK_DONE","task_id":"TASK-001","report_file":".gpt_workspace/executor_reports/TASK-001.md","summary":"一句话总结"}
或 {"type":"TASK_FAILED","task_id":"TASK-002","summary":"失败原因","attempt":1}
或 {"type":"ASK_GPT","context":"当前状态","problem":"遇到什么战略问题","options":"A: ...\\nB: ...","recommendation":"推荐B，理由","question":"请GPT决策的具体问题"}

【何时才询问 GPT（战略级问题）】
计划矛盾 / 多方案无法取舍 / 技术路线重大变更 / 需求歧义 / 与用户目标冲突 / 可能破坏已完成功能 / 数据结构重大变化 / 需要重构 / 测试结果与预期不符 / 多次尝试仍失败 / 需求之间必须取舍 / 无法确定用户真实意图 / 计划不可执行 / 达到里程碑需要审查。
其余问题全部自行解决。

【硬性要求】
- 不要向用户提问或等待人工输入（你是无人值守执行者）。
- 所有报告与 outbox 必须是合法 JSON / Markdown。
- 完成任务后最终回复一行：EXECUTOR_DONE`;

/**
 * 构建"项目级初始化上下文"：只含执行当前任务所需的最小项目上下文与项目状态，
 * 不含完整任务列表、固定角色说明与通信格式（稳定规则已下沉到 skill "workbench-executor"）。
 */
export function buildProjectInitContext(envelope) {
  const type = envelope.type || "EXECUTE_PLAN";
  const plan = envelope.plan || {};
  const obj = plan.objective || "";
  const userTask = envelope.user_task || "";
  const taskId = envelope.current_task?.id || null;
  const taskDesc = envelope.current_task?.description || "";
  const ctx = envelope.context || {};
  const completed = envelope.completed_tasks || [];
  const failed = envelope.failed_tasks || [];
  const trunc = (s, n) => (s && s.length > n ? s.slice(0, n) + "…" : s);

  const lines = [];
  lines.push(`项目名：${envelope.project_name || "-"}`);
  if (obj) lines.push(`目标：${trunc(obj, 1500)}`);
  if (userTask) lines.push(`用户任务：${trunc(userTask, 2000)}`);
  lines.push(`项目状态：已完成 ${ctx.completedCount ?? completed.length} 项，失败 ${ctx.failedCount ?? failed.length} 项；当前任务：${taskId || "-"}${taskDesc ? `（${trunc(taskDesc, 800)}）` : ""}`);
  if (ctx.fresh !== false && completed.length) lines.push(`已完成任务：${completed.join(", ")}`);
  if ((type === "ANALYZE" || type === "DECIDE") && envelope.gpt_message) {
    lines.push(`请求：${trunc(String(envelope.gpt_message), 1500)}`);
  }
  return `【项目初始化上下文】\n${lines.join("\n")}`;
}

/**
 * 项目初始化消息（新会话首条）：Skill 启用入口 + 最小项目上下文 + 项目状态 + 执行要求。
 * 不再内嵌完整角色/协议文本，也不再在 Prompt 中重复整份计划与任务列表（执行者按需读 inbox/task.json）。
 */
export function buildExecutorPrompt(envelope) {
  const type = envelope.type || "EXECUTE_PLAN";
  return `${buildSkillActivationLine()}

${buildProjectInitContext(envelope)}

【执行要求】
1. 稳定角色、通信协议、outbox 格式与硬性要求已在 skill "workbench-executor" 中，直接遵循即可（无需在本提示中重复）。
2. 读取工作目录上级的 .gpt_workspace/inbox/task.json —— 它是权威信封，含 type、current_task、plan、completed_tasks、failed_tasks、gpt_message。
3. ${type === "EXECUTE_PLAN" ? "只执行 current_task，写报告 .gpt_workspace/executor_reports/<TASK_ID>.md，然后写 outbox。" : `按请求执行（type=${type}），然后写 outbox。`}
4. 完成后写 .gpt_workspace/outbox/message.json，并回复一行：EXECUTOR_DONE。

（本提示仅含最小项目上下文；完整计划与历史在 inbox/task.json，按需读取，不重复发送。）`;
}

/**
 * 复用同一会话时的精简任务提示：系统提示词（协议、文件约定）在会话创建时
 * 已发送过一次，此后每个任务只需让执行者重新读取 inbox/task.json 即可，
 * 不再重复注入完整系统提示词与整份计划，显著降低 token 消耗。
 */
export function buildTaskMessage(envelope) {
  const type = envelope.type || "EXECUTE_PLAN";
  const task = envelope.current_task || null;
  const plan = envelope.plan || {};
  const obj = plan.objective || "";
  const acceptance = plan.acceptance_criteria || [];
  const ctx = envelope.context || {};
  const completed = (envelope.completed_tasks || []).map((x) => (typeof x === "string" ? x : x?.id));
  const failed = (envelope.failed_tasks || []).map((x) => (x && x.id) || x);
  const decisions = envelope.decisions || [];
  const replans = envelope.replans || [];
  const trunc = (s, n) => (s && s.length > n ? s.slice(0, n) + "…" : s);

  const lines = [`【任务执行】type=${type}`];
  if (task) {
    lines.push(`当前任务：${task.id}${task.description ? `（${trunc(task.description, 800)}）` : ""}`);
    if (task.priority) lines.push(`优先级：${task.priority}`);
    const deps = task.dependencies || [];
    lines.push(`依赖：${deps.length ? deps.join(", ") : "无"}`);
  } else {
    lines.push(`任务类型：${type}`);
  }
  if (obj) lines.push(`目标：${trunc(obj, 1500)}`);
  if (acceptance.length) lines.push(`验收标准：\n${acceptance.map((a) => `- ${a}`).join("\n")}`);

  // 增量上下文：只传相对上一状态真正变化的内容，并给总数供简短引用
  if (ctx.fresh) {
    if (completed.length) lines.push(`已完成：${completed.join(", ")}`);
  } else if (completed.length) {
    lines.push(`已完成（新增）：${completed.join(", ")}`);
  } else if (ctx.completedCount) {
    lines.push(`已完成共 ${ctx.completedCount} 项（本任务无新增，沿用会话内已知）`);
  }
  if (failed.length) lines.push(`失败（新增）：${failed.join(", ")}`);
  else if (ctx.failedCount) lines.push(`失败共 ${ctx.failedCount} 项（本任务无新增）`);
  if (decisions.length) lines.push(`新增决策：${decisions.length} 条`);
  if (replans.length) lines.push(`新增重规划：${replans.length} 次`);
  if (ctx.planChanged) lines.push(`计划已变更（请按最新计划执行）`);

  if ((type === "ANALYZE" || type === "DECIDE") && envelope.gpt_message) {
    lines.push(`请求：${trunc(String(envelope.gpt_message), 1500)}`);
  } else if (envelope.gpt_message) {
    lines.push(`必要上下文：${trunc(String(envelope.gpt_message), 1200)}`);
  }
  lines.push(`请依据 skill "workbench-executor" 的协议执行该任务（角色、通信、outbox 格式与硬性要求已在其中，无需重复）；如需完整计划与历史，读取 .gpt_workspace/inbox/task.json、project_plan.md 或 project_state.json。完成后写 .gpt_workspace/outbox/message.json 并回复 EXECUTOR_DONE。`);
  return lines.join("\n");
}

/**
 * 复用同一会话时的任务消息：只含当前 Task 的目标/依赖/验收标准/项目状态/必要上下文，
 * 依赖底层 Skill 处理稳定协议；不再重复注入角色/格式与整份计划。
 */
export function buildExecutorTurnPrompt(envelope) {
  return buildTaskMessage(envelope);
}
