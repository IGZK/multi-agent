# TASK-004 执行报告：重构项目初始化消息生成逻辑

## 做了什么
1. **区分"项目级初始化上下文"与"Task 执行指令"**（`controller/prompts.mjs`）：
   - 新增 `buildProjectInitContext(envelope)`：只生成最小项目上下文（项目名、目标、用户任务、项目状态=已完成/失败计数、当前任务 id+描述），并针对 ANALYZE/DECIDE 附加 `gpt_message` 请求；对长文本做截断。
   - 重构 `buildExecutorPrompt(envelope)`（新会话首条 / 项目初始化消息）：改为【Skill 启用入口 + 最小项目上下文 + 执行要求 + 指向 inbox/task.json】。
2. **不再在初始化 Prompt 中重复发送**：
   - 移除内嵌的完整 `DEEPSEEK_EXECUTOR_PROMPT`（约 95 行稳定角色/协议/格式文本，已下沉到 skill "workbench-executor"）。
   - 移除整份计划/任务列表的 JSON 转储；完整计划与历史由执行者按需读取 `.gpt_workspace/inbox/task.json`。
   - `DEEPSEEK_EXECUTOR_PROMPT` 常量保留导出，作为该 Skill 的源码说明与回退参考（不再注入每次 Prompt）。
3. **Skill 启用标识/入口**：提示开头 `buildSkillActivationLine()` 明确要求先加载并遵循 "workbench-executor"；执行要求点明稳定协议在 Skill 中、无需重复，并保留最小安全网（读 task.json、只执行 current_task、写报告、写 outbox、回复 EXECUTOR_DONE），保证即使 Skill 正文未载入也能让循环继续。

## 结果
- `node --check prompts.mjs` 通过。
- 实跑渲染验证：
  - 输出以 Skill 激活行开头，含【项目初始化上下文】（项目名/目标/用户任务/项目状态/当前任务）。
  - `containsDEEPSEEKrole=false`（不再内嵌完整角色文本）。
  - `containsFullPlanDump=false`（不再转储完整任务列表）。
  - ANALYZE 变体正确附带"请求：…"。
- 复用会话的精简提示 `buildExecutorTurnPrompt` 保持不变（TASK-005 进一步处理 Task 消息）。

## 验证方式
- 语法校验 + 构造真实信封渲染 `buildExecutorPrompt`/`buildProjectInitContext` 并断言关键字段。
- 说明：运行中的工作台进程仍跑旧代码，本次改动将在重启后生效；全量端到端（新项目首任务收到最小初始化消息、Skill 生效、Token 下降）在 TASK-007 统一验证。

## 风险 / 说明
- 新会话首条不再含内嵌协议，依赖 skill "workbench-executor" 被加载（TASK-002 已供给到项目 `.dsh/skills`）。若加载失败，最小安全网仍保证执行者知道读 task.json、写 outbox、回 EXECUTOR_DONE。
- 本任务只精简"初始化 Prompt"；task.json 信封中的完整计划仍未精简（TASK-005/006 继续）。
- 未改动 `protocol.mjs`/`orchestrator` 状态机与协议语义。
