// 控制 GPT 要交代多深、DeepSeek 可自行决定多少，不以文件/步骤数量代替指导质量。
export const PLANNING_POLICY_VERSION = 2;
export const PLANNING_MATRIX = {
  flash: { off: "recipe", low: "detailed", high: "guided", max: "delegated" },
  pro: { off: "detailed", low: "guided", high: "delegated", max: "autonomous" },
};

const PROFILES = {
  recipe: {
    label: "逐步指挥", reviewEachTask: true, gptRepairsFailures: true,
    instruction: "GPT 先完成方案推导、算法/接口设计和边界判断，再拆为无需重新设计的小任务。提供已知输入、准确文件/符号、具体实现说明（代码任务宜给伪代码，文档任务给示例）、逐步动作和每步预期结果、正常/异常验证与失败处理。未交代的设计决策交回 GPT，不让执行者猜测。",
  },
  detailed: {
    label: "详细指导", reviewEachTask: true, gptRepairsFailures: true,
    instruction: "GPT 明确方案、接口、输入、文件范围、关键分支与验证实例，按一个清晰子问题拆任务并给可直接执行的步骤。DeepSeek 自行完成局部语法和实现细节，不承担未定的设计取舍。",
  },
  guided: {
    label: "关键点指导", reviewEachTask: true, gptRepairsFailures: false,
    instruction: "GPT 按可验收功能拆任务，明确关键方案、接口约束、难点与验证实例；常规步骤、具体文件定位和局部实现交给 DeepSeek。只展开复杂或容易出错的部分。",
  },
  delegated: {
    label: "模块委托", reviewEachTask: false, gptRepairsFailures: false,
    instruction: "GPT 按模块/可交付功能交代目标、范围、依赖、必须保持的接口和验收标准；DeepSeek 自主选择算法、组织文件、展开步骤和测试，自行排查常规失败。GPT 不预写常规实现细节，关键里程碑可以作为任务单独交付。",
  },
  autonomous: {
    label: "目标委托", reviewEachTask: false, gptRepairsFailures: false,
    instruction: "GPT 只明确目标、业务背景、不可突破的边界、交付物、依赖和验收。DeepSeek 自主分析、设计、内部拆分、实现、测试和改进；除用户硬约束或已确定接口外，不要求 GPT 面面俱到或提前锁定实现。",
  },
};

export function resolveDeepseekSelection(selection = {}, defaults = {}) {
  return {
    provider: selection?.provider || defaults.modelProvider || "deepseek-official",
    model: selection?.model || defaults.model || "",
    reasoningEffort: selection?.reasoningEffort || defaults.reasoningEffort || "",
  };
}

export function planningPolicy(selection = {}) {
  const model = String(selection.model || "").toLowerCase();
  const family = model === "deepseek-v4-pro" ? "pro"
    : ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"].includes(model) ? "flash" : "unknown";
  const effort = String(selection.reasoningEffort || "").toLowerCase();
  const known = Object.hasOwn(PLANNING_MATRIX, family) && Object.hasOwn(PLANNING_MATRIX[family], effort);
  const mode = known ? PLANNING_MATRIX[family][effort] : "recipe";
  return {
    version: PLANNING_POLICY_VERSION,
    key: known ? `${family}/${effort}` : "conservative",
    model: selection.model || "默认模型（未确认）",
    reasoningEffort: effort || "默认档位（未确认）",
    mode, ...PROFILES[mode],
  };
}

const nonempty = (v) => typeof v === "string" && v.trim().length > 0;
const stringList = (v) => Array.isArray(v) && v.length > 0 && v.every(nonempty);
const explicitStep = (v) => v && typeof v === "object" && nonempty(v.action) && nonempty(v.expected_result);
const checks = (v) => Array.isArray(v) && v.length > 0 && v.every(explicitStep);

export function validateTaskContract(task, policy) {
  if (!task || typeof task !== "object") return ["任务必须是对象"];
  const errors = [];
  const add = (text) => errors.push(`${task.id || "无 ID"}: ${text}`);
  const directed = ["recipe", "detailed"].includes(policy.mode);
  if (!nonempty(task.description)) add("description 必须描述一个可独立验收的目标");
  if (!["coding", "test", "analysis", "docs"].includes(task.kind)) add("kind 必须是 coding/test/analysis/docs");
  if (!nonempty(task.scope)) add("scope 必须说明任务范围和不可突破的边界");
  if (!stringList(task.outputs)) add("outputs 必须列出可检查的交付物");
  if (!nonempty(task.acceptance_check)) add("缺少 acceptance_check：具体说明如何判断成功");
  if (!Array.isArray(task.dependencies) || !task.dependencies.every(nonempty)) add("dependencies 必须是任务 ID 数组，无依赖用 []");
  if (directed) {
    if (!stringList(task.files)) add("files 必须指出具体文件；现状未知先请求 NEED_ANALYSIS");
    else if (task.files.some((file) => /[*?]/.test(file) || /^(?:\.|全项目|整个项目|all)$/i.test(file.trim()) || /[\\/]$/.test(file))) add("files 需要具体路径，不能把查找整个目录的工作留给低档执行者");
    if (!stringList(task.inputs)) add("inputs 必须说明已知输入、现有接口或前置结果，不能让执行者猜测");
    if (!stringList(task.edge_cases)) add("edge_cases 必须明确异常/边界情况及处理；确无异常分支也需说明原因");
    if (!nonempty(task.failure_handling)) add("failure_handling 必须交代失败时保留的证据和上报 GPT 的条件");
    if (!Array.isArray(task.open_decisions) || task.open_decisions.length) add("open_decisions 必须为 []；GPT 先决定方案，再向低档执行者下达明确指令");
    const validSteps = policy.mode === "recipe" ? checks(task.steps)
      : Array.isArray(task.steps) && task.steps.length > 0 && task.steps.every((step) => nonempty(step) || explicitStep(step));
    if (!validSteps) add(policy.mode === "recipe"
      ? "steps 每步必须包含 action 与 expected_result，让执行者知道做什么、做到什么算对"
      : "steps 必须给出可直接执行的具体步骤");
  }
  if (directed || policy.mode === "guided") {
    if (!nonempty(task.implementation_notes)) add("implementation_notes 必须给出 GPT 已确定的方案/接口/方法，不能只写目标");
    if (!checks(task.verification)) add("verification 必须给出验证动作 action 和预期结果 expected_result");
  }
  // 委托档的 files/steps/implementation_notes/open_decisions 不强制填写或限数。
  return errors;
}

export function validatePlanContract(plan, selection = {}, completedIds = []) {
  const policy = planningPolicy(selection);
  const errors = [];
  const done = new Set(completedIds.map((id) => String(id).toUpperCase()));
  const tasks = plan?.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) return { ok: false, policy, errors: ["计划必须包含 tasks 数组和至少一项任务"] };
  if (!stringList(plan.acceptance_criteria)) errors.push("计划缺少 acceptance_criteria：项目最终验收标准");
  const byId = new Map();
  for (const task of tasks) {
    if (!task || typeof task !== "object" || Array.isArray(task)) { errors.push("tasks 中每项必须是任务对象"); continue; }
    if (!/^TASK-[\w-]+$/.test(task.id || "")) errors.push(`无效任务 ID: ${task.id || "空"}`);
    if (byId.has(task.id)) errors.push(`重复任务 ID: ${task.id}`);
    byId.set(task.id, task);
    if (!done.has(task.id)) errors.push(...validateTaskContract(task, policy));
  }
  const visited = new Set();
  const visiting = new Set();
  const visit = (id) => {
    if (done.has(id) || visited.has(id)) return;
    if (visiting.has(id)) { errors.push(`${id}: 存在循环依赖`); return; }
    visiting.add(id);
    const deps = byId.get(id)?.dependencies;
    for (const dep of Array.isArray(deps) ? deps : []) {
      if (!byId.has(dep) && !done.has(dep)) errors.push(`${id}: 缺失依赖 ${dep}`);
      else visit(dep);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
  return { ok: errors.length === 0, policy, errors: [...new Set(errors)] };
}

export function executorGuidance(selection = {}) {
  const p = planningPolicy(selection);
  return {
    version: p.version, mode: p.mode, label: p.label,
    reviewEachTask: p.reviewEachTask, gptRepairsFailures: p.gptRepairsFailures,
    instruction: ["recipe", "detailed"].includes(p.mode)
      ? "依据 GPT 给出的 inputs、implementation_notes、steps、edge_cases 和 verification 执行。步骤是操作清单，预期结果是检查依据；前提不符或需另选方案时保留证据并 ASK_GPT，不自行猜测。报告写出实际动作、结果与预期的差异。"
      : "在 scope、依赖和验收边界内自主选择文件、算法、步骤和测试。执行任务中明确的硬约束；常规实现不必逐项向 GPT 请示。交付时提供可核对的验证证据，重大需求冲突再 ASK_GPT。",
  };
}

export function buildPlanningGuidance(selection = {}) {
  const p = planningPolicy(selection);
  const directed = ["recipe", "detailed"].includes(p.mode);
  return `【程序化指挥规则 v${p.version} · ${p.key} · ${p.label}】
model=${p.model}；reasoning=${p.reasoningEffort}。
${p.instruction}
所有任务必填 id、description、kind、scope、outputs、dependencies、acceptance_check。PLAN/UPDATED_PLAN 用 JSON，项目还需 acceptance_criteria。
${directed ? "当前档额外必填 files、inputs、implementation_notes、steps、edge_cases、verification、failure_handling、open_decisions: []。" : p.mode === "guided" ? "当前档额外必填 implementation_notes（关键方案）和 verification（验证实例）；其他实现细节可省略。" : "files、steps、inputs、implementation_notes、edge_cases、verification、failure_handling、open_decisions 均可省略，不为满足格式而替执行者展开常规实现。"}
${p.mode === "recipe" ? 'steps 用 [{"action":"准确的操作/文件/符号","expected_result":"该步可观察的预期"}]；不要只写“完成核心功能”。' : directed ? "steps 给明确操作步骤（字符串或 action/expected_result 对象）；方案已确定，常规语法由执行者处理。" : "只按目标和依赖拆分，不强制逐步操作清单。"}
${directed || p.mode === "guided" ? 'verification 用 [{"action":"具体输入/检查动作/命令","expected_result":"预期输出或表现"}]，覆盖必要的正常与异常行为。' : "让执行者自行设计验证，GPT 最终对照同一验收目标检查证据。"}
不限制文件数、步骤数、交付物数或任务总数。弱档每项聚焦一个已定方案的子问题，需要多少说明就写多少；强档允许包含完整模块和自主内部拆分。实现与对应测试放在同一任务，不机械地拆出没有交付物的空任务。
文件、接口或前置结论未知时先 NEED_ANALYSIS，收到证据后 GPT 再给方案。低档缺少指导则退回 GPT 补齐；不能只把难任务删除、降低验收标准或偷偷升档。
${p.reviewEachTask ? "每项执行后系统将发送 TASK_REVIEW，GPT 要比较计划、实际报告与验证证据，确认后才继续；不符合则新增修正任务并完善后续指令。" : "执行者自行完成任务内部迭代；GPT 在整体验收或执行者提出重大问题时介入。"}
${p.gptRepairsFailures ? "执行或验证失败会先回滚并交回 GPT：根据失败证据修改方案、补充说明或继续拆小，不原样重发同一任务。" : "执行者可自行重试局部问题，耗尽次数后由 GPT 调整方向。"}
已完成记录保留；重新规划只修改未完成任务或追加修正任务。结构校验不能证明语义质量，GPT 必须检查需求覆盖和指令是否足以让当前执行者完成。`;
}
