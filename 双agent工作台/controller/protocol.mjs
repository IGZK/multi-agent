// 通信协议：GPT ↔ DeepSeek 的机器可读协议（XML 标记 + Markdown + JSON 状态文件）
//
// GPT 回复格式（编排器解析）：
//   <GPT_RESPONSE>
//   <STATUS>READY|NEED_ANALYSIS|CONTINUE|REPLAN|DECISION_REQUIRED|DONE</STATUS>
//   <PLAN>...</PLAN>            （READY 时）
//   <UPDATED_PLAN>...</UPDATED_PLAN>  （REPLAN 时）
//   <NEXT_TASK>TASK-003</NEXT_TASK>   （CONTINUE 时）
//   <DECISION>...</DECISION>          （REPLAN 时）
//   <REQUEST>...</REQUEST>            （NEED_ANALYSIS / DECISION_REQUIRED 时）
//   </GPT_RESPONSE>
//
// 编排器发给 GPT 的包装：
//   <ORCHESTRATOR><MSG_TYPE>PLAN_REQUEST|ANALYSIS|QUERY|PROGRESS|REVIEW_REQUEST|REPROMPT|USER</MSG_TYPE>
//   <CONTENT>...</CONTENT></ORCHESTRATOR>
//
// DeepSeek 询问 GPT 的包装：
//   <DEEPSEEK_QUERY>type: DECISION_REQUIRED\ncontext:...\nproblem:...\noptions:\nA:...\nB:...\nrecommendation:...\nquestion:...</DEEPSEEK_QUERY>

const KNOWN_STATUSES = ["READY", "NEED_ANALYSIS", "CONTINUE", "REPLAN", "DECISION_REQUIRED", "DONE"];

function lastMatch(text, re) {
  let m;
  let last = null;
  while ((m = re.exec(text)) !== null) last = m;
  return last;
}

export function extractBlock(text, tag) {
  if (!text) return null;
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const m = lastMatch(text, re);
  if (!m) return null;
  let content = m[1].trim();
  // 去掉 Markdown 代码围栏
  content = content.replace(/^```[\w-]*\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
  // 去掉 CDATA
  if (content.startsWith("<![CDATA[") && content.endsWith("]]>")) {
    content = content.slice(9, -3).trim();
  }
  return content;
}

/** 从一条或多条 <GPT_RESPONSE> 中取最后一条并解析 */
export function parseGptResponse(text) {
  const result = {
    status: null,
    plan: null,
    updatedPlan: null,
    nextTask: null,
    decision: null,
    request: null,
    rawBlock: null,
    rawText: text || "",
  };
  if (!text) return result;
  const re = /<GPT_RESPONSE\b[^>]*>([\s\S]*?)<\/GPT_RESPONSE>/gi;
  const m = lastMatch(text, re);
  if (!m) return result;
  result.rawBlock = m[1].trim();

  const status = extractBlock(m[1], "STATUS");
  if (status) {
    const normalized = status.trim().toUpperCase().replace(/[\s:：]+$/, "");
    result.status = KNOWN_STATUSES.includes(normalized) ? normalized : null;
  }
  result.plan = extractBlock(m[1], "PLAN");
  result.updatedPlan = extractBlock(m[1], "UPDATED_PLAN");
  const next = extractBlock(m[1], "NEXT_TASK");
  if (next) result.nextTask = next.trim();
  result.decision = extractBlock(m[1], "DECISION");
  result.request = extractBlock(m[1], "REQUEST");
  return result;
}

/**
 * 解析计划文本（容忍格式变化）。
 * 支持 spec 中的格式：
 *   status: READY
 *   project_name: xxx
 *   objective: xxx
 *   goals:
 *   - xxx
 *   tasks:
 *   - id: TASK-001
 *     description: xxx
 *     priority: high
 *     dependencies:
 *     - TASK-000
 */
export function parsePlan(text) {
  if (!text) return null;
  const plan = {
    status: null,
    project_name: null,
    objective: null,
    goals: [],
    tasks: [],
    acceptance_criteria: [],
    constraints: [],
    questions_for_executor: [],
    raw: text,
  };
  const lines = text.split(/\r?\n/);
  let section = null;
  let currentTask = null;
  let expectingDeps = false; // "dependencies:" 后跨空行收集依赖（GPT 变体格式）
  const LIST_SECTIONS = new Set(["goals", "acceptance_criteria", "constraints", "questions_for_executor"]);
  const TASK_ATTRS = new Set(["description", "priority", "dependencies", "id", "kind", "validation", "timeout", "max_attempts"]);
  const newTask = (id, description = "") => ({
    id: String(id || "").toUpperCase(), description, priority: "medium", dependencies: [],
    kind: "coding", validation: null, timeout: null, max_attempts: null,
  });
  const assignTaskAttr = (task, key, val) => {
    if (key === "description") task.description = val;
    else if (key === "priority") task.priority = val;
    else if (key === "kind") task.kind = ["coding", "test", "analysis", "docs"].includes(val.toLowerCase()) ? val.toLowerCase() : "coding";
    else if (key === "validation") task.validation = val || null;
    else if (key === "timeout") task.timeout = Number.isFinite(Number(val)) && Number(val) > 0 ? Number(val) : null;
    else if (key === "max_attempts") task.max_attempts = Number.isFinite(Number(val)) && Number(val) > 0 ? Math.floor(Number(val)) : null;
  };

  const sectionOf = (line) => {
    const m = line.match(/^([a-z_]+)\s*:\s*$/i);
    return m ? m[1].toLowerCase() : null;
  };

  for (let rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    const trimmed = line.trim();
    if (!trimmed) {
      // 期待依赖时空行不断开任务（GPT 变体：dependencies 与依赖项之间有空行）
      if (!expectingDeps) currentTask = null;
      continue;
    }

    // A. 当前任务下的缩进子项：属性 / "- TASK-xxx" 依赖 / 续行
    if (currentTask && /^\s/.test(line)) {
      const sub = line.match(/^\s*([-*]\s+)?(.*)$/);
      const bullet = sub[1] || null;
      const inner = (sub[2] || "").trim();
      if (bullet && /^TASK-/i.test(inner)) {
        currentTask.dependencies.push(inner.replace(/,$/, "").toUpperCase());
      } else {
        const akv = inner.match(/^([a-z_]+)\s*:\s*(.*)$/i);
        if (akv) {
          const key = akv[1].toLowerCase();
          const val = akv[2].trim();
          if (key !== "dependencies") assignTaskAttr(currentTask, key, val);
          else {
            if (val) {
              for (const d of val.replace(/[\[\]]/g, "").split(/[,，]/)) {
                const dd = d.trim().replace(/,$/, "");
                if (dd) currentTask.dependencies.push(dd.toUpperCase());
              }
            } else {
              expectingDeps = true;
            }
          }
        } else if (inner) {
          currentTask.description += " " + inner;
        }
      }
      continue;
    }

    // B. 顶格纯任务 ID 行（GPT 变体：依赖不缩进）→ 当前任务的依赖
    if (currentTask && /^TASK-[\w-]+\s*$/.test(trimmed)) {
      currentTask.dependencies.push(trimmed.replace(/,$/, "").toUpperCase());
      continue;
    }

    // C. 顶格 key: value
    const kv = trimmed.match(/^([a-z_]+)\s*:\s*(.*)$/i);
    if (kv) {
      const key = kv[1].toLowerCase();
      const val = kv[2].trim();
      if (["status", "project_name", "objective"].includes(key)) {
        plan[key] = val || plan[key];
        section = null;
        currentTask = null;
        expectingDeps = false;
        continue;
      }
      // GPT 变体：顶格 "id: TASK-xxx" 新任务
      if (key === "id" && /^TASK-/i.test(val)) {
        currentTask = newTask(val.replace(/[,.:：].*$/, "").trim());
        plan.tasks.push(currentTask);
        section = "tasks";
        expectingDeps = false;
        continue;
      }
      // GPT 变体：任务属性顶格（未缩进）
      if (currentTask && TASK_ATTRS.has(key)) {
        if (key !== "dependencies") assignTaskAttr(currentTask, key, val);
        else {
          if (val) {
            for (const d of val.replace(/[\[\]]/g, "").split(/[,，]/)) {
              const dd = d.trim().replace(/,$/, "");
              if (dd) currentTask.dependencies.push(dd.toUpperCase());
            }
          } else {
            expectingDeps = true; // 依赖列表在后续行（可能隔空行）
          }
        }
        continue;
      }
    }

    // D. 小节标题（纯 key: 行；任务属性集除外）
    const sec = sectionOf(trimmed);
    if (sec && !(currentTask && TASK_ATTRS.has(sec))) {
      section = sec;
      currentTask = null;
      expectingDeps = false;
      continue;
    }

    // E. 任务行：- id: TASK-x / - TASK-x: 描述 / 纯 TASK-x（无 currentTask 时）
    const taskId = trimmed.match(/^[-*]\s*(?:id\s*:\s*)?(TASK-[\w-]+)(?:\s*[:：\-–—]\s*(.+))?$/i);
    const bareTask = !currentTask ? trimmed.match(/^(TASK-[\w-]+)(?:\s*[:：\-–—]\s*(.+))?$/i) : null;
    const taskMatch = taskId || bareTask;
    if (taskMatch) {
      currentTask = newTask(taskMatch[1], (taskMatch[2] || "").trim());
      plan.tasks.push(currentTask);
      section = "tasks";
      expectingDeps = false;
      continue;
    }

    // F. 列表项：带 "-" 前缀，或当前 section 为列表段（GPT 变体无横线）
    const li = trimmed.match(/^[-*]\s*(.+)$/);
    const val = li ? li[1].trim() : trimmed;
    if (li || (LIST_SECTIONS.has(section) && !kv)) {
      if (section === "goals") plan.goals.push(val);
      else if (section === "acceptance_criteria") plan.acceptance_criteria.push(val);
      else if (section === "constraints") plan.constraints.push(val);
      else if (section === "questions_for_executor") plan.questions_for_executor.push(val);
      else if (li && currentTask) currentTask.dependencies.push(val.toUpperCase());
      expectingDeps = false;
      continue;
    }

    // G. 其他：追加到当前小节或任务描述
    expectingDeps = false;
    if (section === "objective" || section === "project_name") {
      plan[section] = plan[section] ? plan[section] + " " + trimmed : trimmed;
    } else if (currentTask) {
      currentTask.description += " " + trimmed;
    }
  }

  // 兼容变体："TASKS:" 大写
  if (plan.tasks.length === 0) {
    // 宽松扫描：任何 "TASK-\d+" 行
    for (const line of lines) {
      const m = line.trim().match(/^(?:[-*]\s*)?(TASK-[\w-]+)\s*[:：\-–—]?\s*(.*)$/i);
      if (m && !plan.tasks.some((t) => t.id === m[1].toUpperCase())) {
        plan.tasks.push(newTask(m[1], m[2] || ""));
      }
    }
  }

  if (plan.tasks.length === 0 && !plan.status) return null;
  return plan;
}

/**
 * 执行者计划摘要：只保留项目级目标和约束，不重复携带任务列表。
 * 当前任务在信封 current_task 中；完整计划按需从 project_plan.md 读取。
 */
export function slimPlan(plan) {
  if (!plan || typeof plan !== "object") return plan;
  return {
    status: plan.status ?? null,
    project_name: plan.project_name ?? null,
    objective: plan.objective ?? null,
    goals: Array.isArray(plan.goals) ? plan.goals : [],
    acceptance_criteria: Array.isArray(plan.acceptance_criteria) ? plan.acceptance_criteria : [],
    constraints: Array.isArray(plan.constraints) ? plan.constraints : [],
    questions_for_executor: Array.isArray(plan.questions_for_executor) ? plan.questions_for_executor : [],
  };
}

/**
 * 合并重规划：UPDATED_PLAN 是新的权威任务列表。
 * 同 ID 任务继承旧字段和完成/失败状态；未出现在新列表中的旧任务视为已移除。
 * 完成/失败历史仍保存在 project_state.json 的独立数组中，不需要强塞回计划。
 */
export function mergePlan(current, updated, completedIds = [], failedIds = []) {
  const merged = {
    ...(updated || {}),
    tasks: [],
  };
  const newTasks = updated?.tasks || [];
  const done = new Set(completedIds);
  const failed = new Set(failedIds);
  const oldById = new Map((current?.tasks || []).map((t) => [String(t.id).toUpperCase(), t]));

  for (const t of newTasks) {
    const old = oldById.get(String(t.id).toUpperCase());
    merged.tasks.push({ ...(old || {}), ...t, id: t.id, status: "pending" });
  }
  // 状态回填
  for (const t of merged.tasks) {
    if (t.status === "pending" && done.has(t.id)) t.status = "completed";
    if (t.status === "pending" && failed.has(t.id)) t.status = "failed";
  }
  return merged;
}

export function wrapOrchestratorMsg(type, content) {
  return `<ORCHESTRATOR>\n<MSG_TYPE>${type}</MSG_TYPE>\n<CONTENT>\n${content}\n</CONTENT>\n</ORCHESTRATOR>`;
}

export function wrapDeepseekQuery(payload) {
  const fields = [
    `type: ${payload.type || "DECISION_REQUIRED"}`,
    payload.context ? `\ncontext:\n${payload.context}` : "",
    payload.problem ? `\nproblem:\n${payload.problem}` : "",
    payload.options ? `\noptions:\n${payload.options}` : "",
    payload.recommendation ? `\nrecommendation:\n${payload.recommendation}` : "",
    payload.question ? `\nquestion:\n${payload.question}` : "",
  ].join("");
  return `<DEEPSEEK_QUERY>\n${fields}\n</DEEPSEEK_QUERY>`;
}

const EXECUTOR_RESULT_TYPES = new Set(["TASK_DONE", "TASK_FAILED", "ASK_GPT"]);

/** v3 outbox 边界校验：拒绝旧、重复、未知或与当前派发不匹配的结果。 */
export function validateExecutorOutbox(outbox, envelope, processedDispatchIds = [], now = Date.now()) {
  if (!outbox || typeof outbox !== "object" || Array.isArray(outbox)) return { ok: false, code: "OUTBOX_INCOMPLETE", error: "结果信封不完整" };
  if (Number(outbox.schema_version) !== 3) return { ok: false, code: "OUTBOX_SCHEMA", error: "结果信封 schema_version 必须为 3" };
  if (!EXECUTOR_RESULT_TYPES.has(outbox.type)) return { ok: false, code: "OUTBOX_TYPE", error: `未知结果类型: ${outbox.type || "空"}` };
  if (!outbox.dispatch_id || outbox.dispatch_id !== envelope?.dispatch_id) return { ok: false, code: "OUTBOX_DISPATCH", error: "结果 dispatch_id 与当前派发不匹配" };
  if (processedDispatchIds.includes(outbox.dispatch_id)) return { ok: false, code: "OUTBOX_DUPLICATE", error: "结果 dispatch_id 已处理" };
  if (!outbox.project_id || outbox.project_id !== envelope?.project_id) return { ok: false, code: "OUTBOX_PROJECT", error: "结果 project_id 与当前项目不匹配" };
  const expectedTask = String(envelope?.task_id || envelope?.current_task?.id || envelope?.type || "").toUpperCase();
  if (!outbox.task_id || String(outbox.task_id).toUpperCase() !== expectedTask) return { ok: false, code: "OUTBOX_TASK", error: "结果 task_id 与当前任务不匹配" };
  const created = Date.parse(outbox.created_at || "");
  const dispatched = Date.parse(envelope?.created_at || envelope?.dispatched_at || "");
  const maxAge = Math.max(60000, Number(envelope?.timeoutMs || 2700000)) + 300000;
  if (!Number.isFinite(created) || (Number.isFinite(dispatched) && created + 1000 < dispatched) || created > now + 300000 || created < now - maxAge) {
    return { ok: false, code: "OUTBOX_STALE", error: "结果时间早于当前派发或无效" };
  }
  return { ok: true };
}

export function extractMsgType(text) {
  const m = text?.match(/<MSG_TYPE>([\s\S]*?)<\/MSG_TYPE>/i);
  return m ? m[1].trim().toUpperCase() : null;
}

/** 宽松回退：没有协议标签时，直接对全文做计划解析 */
export function fallbackParse(text) {
  if (!text) return { status: null, plan: null };
  const plan = parsePlan(text);
  if (plan && plan.tasks.length > 0) {
    return { status: "READY", plan };
  }
  return { status: null, plan: null };
}

// ---------- 自测 ----------
export function selftest() {
  let pass = 0;
  let fail = 0;
  const check = (name, cond) => {
    if (cond) { pass++; console.log(`PASS ${name}`); }
    else { fail++; console.log(`FAIL ${name}`); }
  };

  const reply1 = `
一些解释……
<GPT_RESPONSE>
<STATUS>READY</STATUS>
<PLAN>
status: READY
project_name: demo
objective: 做一个 Hello World

goals:
- 可运行
- 有文档

tasks:
- id: TASK-001
  description: 创建主程序
  priority: high
  dependencies: []

- id: TASK-002
  description: 写 README
  priority: medium
  dependencies:
  - TASK-001

acceptance_criteria:
- 运行成功

constraints:
- 标准库

questions_for_executor:
- 无
</PLAN>
<NEXT_ACTION>EXECUTE</NEXT_ACTION>
</GPT_RESPONSE>
`;
  const r1 = parseGptResponse(reply1);
  check("parse status READY", r1.status === "READY");
  check("parse plan exists", !!r1.plan);
  const p1 = parsePlan(r1.plan);
  check("plan tasks=2", p1.tasks.length === 2);
  check("plan task1 deps", p1.tasks[1].dependencies.includes("TASK-001"));
  check("plan objective", p1.objective.includes("Hello World"));

  const reply2 = `<GPT_RESPONSE><STATUS>CONTINUE</STATUS><NEXT_TASK>TASK-003</NEXT_TASK></GPT_RESPONSE>`;
  const r2 = parseGptResponse(reply2);
  check("parse CONTINUE", r2.status === "CONTINUE" && r2.nextTask === "TASK-003");

  // 多条回复取最后一条
  const reply3 = reply1 + "\n---新回复---\n" + reply2;
  const r3 = parseGptResponse(reply3);
  check("last response wins", r3.status === "CONTINUE");

  // 代码围栏包裹
  const reply4 = "```xml\n<GPT_RESPONSE>\n<STATUS>DONE</STATUS>\n</GPT_RESPONSE>\n```";
  const r4 = parseGptResponse(reply4);
  check("fenced DONE", r4.status === "DONE");

  // 合并计划
  const merged = mergePlan(p1, {
    ...p1,
    tasks: [
      { id: "TASK-001", description: "创建主程序（改）", priority: "high", dependencies: [] },
      { id: "TASK-002", description: "写 README", priority: "medium", dependencies: ["TASK-001"] },
      { id: "TASK-003", description: "测试", priority: "high", dependencies: ["TASK-002"] },
    ],
  }, ["TASK-001"], []);
  check("merge keeps completed", merged.tasks.find((t) => t.id === "TASK-001").status === "completed");
  check("merge adds new", merged.tasks.length === 3 && merged.tasks.some((t) => t.id === "TASK-003"));

  const removed = mergePlan(p1, { ...p1, tasks: [p1.tasks[1]] }, [], []);
  check("merge removes omitted task", removed.tasks.length === 1 && removed.tasks[0].id === "TASK-002");

  // 宽松回退解析（无标签）
  const loose = `
项目计划
objective: 测试项目
tasks:
- TASK-001: 做A
- TASK-002: 做B
`;
  const fb = fallbackParse(loose);
  check("fallback parse loose plan", fb.status === "READY" && fb.plan.tasks.length === 2);

  // 真实 GPT-5.6 Sol 变体：无横线、无缩进
  const gptVariant = `status: READY
project_name: E2E-HelloWorld
objective: 创建一个 Python Hello World 项目

goals:

创建最小可运行的 Python Hello World 程序

tasks:

id: TASK-001
description: 创建主程序文件
priority: high
dependencies:

id: TASK-002
description: 创建 README.md
priority: high
dependencies:

TASK-001

id: TASK-003
description: 运行验证
priority: high
dependencies:

TASK-002

acceptance_criteria:

项目包含可运行的 Python Hello World 程序

constraints:

使用 Python

questions_for_executor:

按依赖顺序执行
`;
  const pv = parsePlan(gptVariant);
  check("gpt-variant tasks=3", pv.tasks.length === 3);
  check("gpt-variant deps", pv.tasks[1].dependencies.includes("TASK-001") && pv.tasks[2].dependencies.includes("TASK-002"));
  check("gpt-variant desc", pv.tasks[0].description.includes("主程序") && pv.tasks[2].description === "运行验证");
  check("gpt-variant criteria", pv.acceptance_criteria.length === 1 && pv.constraints.length === 1);
  check("gpt-variant goals", pv.goals.length === 1);

  const taskFields = parsePlan(`status: READY\ntasks:\n- id: TASK-010\n  description: 修复问题\n  kind: test\n  validation: npm test\n  timeout: 120\n  max_attempts: 3\n  dependencies: []`);
  check("task fields", taskFields.tasks[0].kind === "test" && taskFields.tasks[0].validation === "npm test" && taskFields.tasks[0].timeout === 120 && taskFields.tasks[0].max_attempts === 3);

  const dispatchedAt = new Date().toISOString();
  const envelope = { schema_version: 3, project_id: "demo", task_id: "TASK-010", dispatch_id: "dispatch-10", created_at: dispatchedAt };
  const result = { schema_version: 3, type: "TASK_DONE", project_id: "demo", task_id: "TASK-010", dispatch_id: "dispatch-10", created_at: dispatchedAt };
  check("valid v3 outbox", validateExecutorOutbox(result, envelope).ok);
  check("reject wrong dispatch", validateExecutorOutbox({ ...result, dispatch_id: "wrong" }, envelope).code === "OUTBOX_DISPATCH");
  check("reject duplicate dispatch", validateExecutorOutbox(result, envelope, ["dispatch-10"]).code === "OUTBOX_DUPLICATE");
  check("reject expired outbox", validateExecutorOutbox({ ...result, created_at: "2020-01-01T00:00:00.000Z" }, { ...envelope, created_at: "2020-01-01T00:00:00.000Z", timeoutMs: 1000 }).code === "OUTBOX_STALE");

  // DeepSeek Query 包装
  const q = wrapDeepseekQuery({ type: "DECISION_REQUIRED", problem: "冲突", question: "选哪个?" });
  check("query wrap", q.includes("<DEEPSEEK_QUERY>") && q.includes("problem:"));

  console.log(`\n协议自测: ${pass} PASS / ${fail} FAIL`);
  return fail === 0;
}

// 直接运行本文件时执行自测
import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ok = selftest();
  process.exit(ok ? 0 : 1);
}
