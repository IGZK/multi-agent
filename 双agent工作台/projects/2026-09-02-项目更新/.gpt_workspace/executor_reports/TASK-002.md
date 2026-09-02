# TASK-002 执行报告：设计并实现工作台专用 DeepSeek Harness 底层 Skill

## 做了什么
1. 编写工作台专用底层 Skill：`skills/workbench-executor/SKILL.md`（kebab-case 名 `workbench-executor`，frontmatter 含 name/description/whenToUse，`user-invocable: false`），把稳定角色要求、职责边界、工作目录与文件信封约定、执行流程、outbox 格式、何时上报 GPT、状态/消息语义、硬性要求从"每次 Prompt 字符串"下沉为 dsh 标准 Skill。动态项目数据（current_task、plan、增量）仍由工作台按信封下发，不放进 Skill。
2. 新增供给/加载模块 `controller/workbench_skill.mjs`：
   - `ensureProjectSkill(sourceDir)`：把 SKILL.md 幂等供给到 `<sourceDir>/.dsh/skills/workbench-executor/`（dsh skill-filesystem rank-100 项目根，按 cwd 发现）。
   - `isProjectSkillInstalled` / `verifyProjectSkill` / `parseSkillName` / `buildSkillActivationLine` 等校验与入口助手。
3. 接线：
   - `deepseek_runner.mjs` `run()` 第一步供给 Skill（新项目/既有项目都会在分派前确保存在，先于可见/headless 的会话创建）。
   - `prompts.mjs` `buildExecutorPrompt()` 首任务提示开头插入 `buildSkillActivationLine()`（"请先通过 skill 工具加载并遵循 workbench-executor"），保留原角色 Prompt 作为新会话兜底（TASK-005 再精简）。
4. "仅工作台调用时启用"机制（三层）：
   - **放置**：Skill 只放进"由工作台管理的项目源码目录"的 `.dsh/skills`，仅以该项目为 cwd 的会话可见。
   - **激活**：仅工作台首任务提示显式要求加载该 Skill；普通直接调用不触发加载。
   - **上下文门控（Skill 正文内置）**：协议仅在存在 `.gpt_workspace/inbox/task.json` 且含 project_id/workspace_dir/source_dir/current_task 等工作台信封字段、且本次输入明确要求以工作台执行者身份执行时生效；否则忽略本 Skill，不写 .gpt_workspace、不输出 EXECUTOR_DONE。

## 结果
- Skill 文件已创建并通过 frontmatter 解析校验（name=workbench-executor）。
- 供给幂等（重复调用 installed=false、内容一致）；verifyProjectSkill ok。
- `buildExecutorPrompt` 开头含激活行，且保留角色兜底与信封。
- 三个改动模块 `node --check` 语法通过；模块集成调用验证通过。
- 已在当前项目源码目录实际供给 `.dsh/skills/workbench-executor/SKILL.md`。

## 验证方式
- node --check 语法校验 prompts.mjs / deepseek_runner.mjs / workbench_skill.mjs。
- 实跑 workbench_skill：ensureProjectSkill 幂等、isProjectSkillInstalled、verifyProjectSkill(ok,name)、buildSkillActivationLine 输出正确。
- 实跑 buildExecutorPrompt：首行=激活指令、含角色兜底与信封。
- 说明：dsh 的 `skill` 工具按 `session.header.cwd` 发现项目根 skill（dsh-tool-skill 源码确认）；本会话因在 Skill 创建前已建立、目录为旧快照故当前看不到，属预期；新项目会在分派前先供给、再建会话，故新会话目录可见。全量端到端（新会话可见性、隔离、协议约束）在 TASK-007 统一验证。

## 风险 / 说明
- 项目根 `.dsh/skills` 的严格目录级隔离：若用户在**同一项目目录**直接运行 dsh，其目录中也会出现该 Skill（但不自动应用，且上下文门控阻止其改变默认行为）。若需更严格的"目录级不可见"，建议在 TASK-007 启用 profile 级运行时注册（把 Skill 作为 runtime skill 通过 workbench-exec profile 的 cordis.patch.yml 挂载，仅该 profile 可见），本任务出于不破坏运行中工作台、且需重启 profile 验证的考虑未改动真实 profile，已作为建议写入分析。
