# TASK-007 执行报告：端到端验证

## 验证方式与结果
1. **mock 全闭环自测**（`node controller/index.mjs --gpt=mock --executor=mock --selftest`，独立进程用新代码）：**PASS**。计划→执行×3→项目分析→GPT 审查→COMPLETED，检查 `completed=3 analysis=true final=true gptMsgs=6`。日志显示每次分派都会供给工作台 Skill（"工作台 Skill 已供给/已就绪"）。覆盖：状态机、顺序执行、ANALYZE 回传、REVIEW 最终审查、COMPLETED。
2. **会话复用 / 项目隔离**：
   - 代码路径 `runSessionPool → getOrCreateSession`：同项目首次创建、后续返回同一 session（reused=true）；新项目不同 server+session（servers 按 projectId 键控）。TASK-003 实测成立。
   - 运行中的工作台在同一项目跨 TASK-001..006 复用同一个 dsh 会话（session-8caf115b），证明"首个 Task 起一个会话、后续复用"。
3. **Skill 仅工作台启用 / 普通调用不受影响**：
   - Skill 只存在于工作台项目源码的 `.dsh/skills/workbench-executor/`；`~/.dsh/skills`、`~/.agents` 及其余项目目录均无（实测确认）。
   - 首条消息含 Skill 激活行；Skill 正文含"工作台上下文识别规则"门控（无 .gpt_workspace/inbox/task.json 工作台信封即忽略，不写文件、不回 EXECUTOR_DONE）。
   - 因此普通 DeepSeek 调用（不同目录）看不到该 Skill；即便目录内出现，未激活/无信封也不生效。
4. **Prompt 不再重复角色/格式/完整任务列表**（实跑渲染断言）：
   - 项目初始化消息：`noRoleText=true`（无完整角色文本）、`noFullTaskList=true`（无完整任务列表转储）、含 Skill 激活。
   - 后续任务消息：增量式 `已完成（新增）：TASK-002`（不整表重列）、`noFullPlan=true`、含 Skill 引用。
5. **状态回传、失败重试、REPLAN、最终审查**：
   - 状态回传与最终审查：mock 闭环 PASS。
   - 失败重试 / REPLAN：逻辑位于 `handleExecutorResult` 的 TASK_FAILED 分支与 `stepWaitingGpt` 的 REPLAN 分支，本次未改动（只改信封/prompt/缓存/生命周期），由代码检查确认保留；信封的 `context.planChanged` 与 replans 增量已就绪供 REPLAN 传递。

## 覆盖对照（验收标准）
- 首个 Task 启动一个 Harness：✔（会话池按需创建）
- 同项目后续 Task 不重建窗口、连续执行：✔（getOrCreateSession 复用；同一会话跨任务）
- 新项目创建新 Harness 会话：✔（servers 按 projectId 隔离）
- Skill 约束工作台调用：✔（供给+激活+门控）
- 普通调用不误启用：✔（仅工作台项目目录可见+上下文门控）
- Prompt 不再重复角色/格式/完整任务列表：✔（渲染断言）
- 状态回传/重试/REPLAN/最终审查正常：✔（mock 闭环 + 代码检查）

## 说明 / 局限
- 运行中的工作台进程仍跑旧代码（改动待重启生效）；本次用"新代码独立进程的 mock 闭环 + 渲染断言 + 单测"验证，未做真实 LLM 多任务压测（耗时耗 token，且真实会话由运行中旧进程持有）。
- 建议正式发布前重启工作台后跑一个真实小项目（2-3 任务）做最终回归；若需，可在 TASK-008 一并对比 token。
