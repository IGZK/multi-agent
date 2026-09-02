# TASK-005 执行报告：重构 Task 消息生成与发送逻辑

## 做了什么
1. **精简计划视图**（`controller/protocol.mjs`）：新增 `slimPlan(plan)`，把完整计划压缩为最小视图——保留 objective/goals/验收标准/约束/执行问题；任务列表只留 id/priority/status/依赖 与 ≤200 字符描述；去除 `raw`。完整计划仍在 project_state.json / project_plan.md 中可读。
2. **精简任务信封**（`controller/orchestrator.mjs`）：`buildEnvelope()` 改用 `slimPlan`，并把 `user_task` 截断到 1200 字符。从此每任务写入 inbox/task.json 的内容不再携带完整任务描述/计划文本。
3. **Task 执行消息**（`controller/prompts.mjs`）：新增 `buildTaskMessage(envelope)`，作为每次执行具体 Task 的消息，只包含：
   - 当前 Task ID、描述、优先级、依赖；
   - 项目目标、验收标准；
   - 项目状态摘要（已完成/失败）；
   - 必要上下文（gpt_message，ANALYZE/DECIDE 附请求）；
   - 依赖底层 Skill "workbench-executor" 处理稳定协议，并提示如需完整计划可读 task.json / project_plan.md。
   - `buildExecutorTurnPrompt` 现在直接返回 `buildTaskMessage`（复用会话的任务消息）。

## 结果
- 三个改动模块 `node --check` 通过。
- 实跑验证：
  - `slimPlan`：保留 objective/验收标准，任务描述被精简，`raw` 被移除，依赖/状态保留。
  - `buildTaskMessage`：包含 TASK 号、目标、依赖、验收标准、已完成状态、Skill 引用；**不包含**长任务描述/完整计划/角色文本。
  - `buildEnvelope` 已确认改用 `slimPlan`。
- 每 Task 消息不再重复追加角色要求、通信格式、完整计划；稳定协议交给底层 Skill。

## 验证方式
- 语法校验 + 构造真实信封渲染 `slimPlan`/`buildTaskMessage` 并断言关键字段。
- grep 确认 buildEnvelope 使用 slimPlan。
- 说明：运行中的工作台进程仍跑旧代码，改动将在重启后生效；完整端到端（多 Task 连续执行、Token 下降）在 TASK-007 统一验证。

## 风险 / 说明
- 执行者如需相邻任务详情/完整计划，仍可读 project_plan.md 或 task.json（task.json 现为精简版）；状态机、REPLAN、失败重试语义未改动。
- `stripPlanRaw` 仍从 protocol 导出（兼容），orchestrator 现主要用 `slimPlan`。
