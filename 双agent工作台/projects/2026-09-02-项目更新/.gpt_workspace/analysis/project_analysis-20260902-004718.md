# 项目分析：双 Agent 协作工作台 —— DeepSeek Harness 调度与通信优化（最终）

> ANALYZE 最终分析 | 生成时间：2026-09-02（重新生成）| 全部 8 项任务已完成

## 一、项目结构与关键文件
```
双agent工作台/
├── controller/
│   ├── index.mjs            # 主入口/装配/单实例锁/自测
│   ├── orchestrator.mjs     # 状态机+调度+信封构造(含增量上下文 context_cache)
│   ├── deepseek_runner.mjs  # 执行桥：项目级会话池 + 崩溃自动恢复
│   ├── dsh_ui.mjs           # 每项目一个 dsh web 服务 + 持久会话 RPC + 窗口
│   ├── prompts.mjs          # 项目初始化消息 + 任务消息 + 增量渲染
│   ├── protocol.mjs         # 协议解析 + slimPlan/mergePlan 计划工具
│   ├── workbench_skill.mjs  # 工作台专用 Skill 供给/加载/校验
│   ├── gpt_bridge.mjs       # ChatGPT 浏览器桥（GPT 侧）
│   ├── server.mjs / store.mjs / logger.mjs
├── skills/workbench-executor/SKILL.md   # 工作台专用底层 Skill（稳定协议）
├── config/config.json
└── projects/<项目>/
```

## 二、已完成的工作（TASK-001..008 全部完成）
1. **TASK-001** 全量分析：定位 Prompt 拼接、Harness"窗口"真实载体（每项目 dsh web 服务+持久会话）、会话复用基础、Skill 机制现状。
2. **TASK-002** 工作台专用底层 Skill：`skills/workbench-executor/SKILL.md`（角色/协议/格式/状态语义/上下文门控）；`workbench_skill.mjs` 供给到 `<sourceDir>/.dsh/skills/`；run() 分派前供给；首提示激活。
3. **TASK-003** 生命周期重构：真实模式统一走"项目级会话池"（每项目一 dsh web 服务+一持久会话，跨任务复用；visible 只控弹窗；headless 仅兜底）；服务崩溃自动恢复（uiRecoveryRetries）；项目级会话状态记录/查询。
4. **TASK-004** 项目初始化消息重构：新增 `buildProjectInitContext`，`buildExecutorPrompt` 只发最小项目上下文+项目状态+Skill 入口，移除内嵌完整角色文本与整份计划转储。
5. **TASK-005** 任务消息重构：`slimPlan` 精简计划视图、`buildTaskMessage` 只含当前任务/目标/依赖/验收/状态，移除每任务重复的角色/格式/完整计划。
6. **TASK-006** 上下文缓存/引用机制：`context_cache` 基线 + 增量信封（completed/failed/decisions/replans 只传增量 + context 计数引用）+ freshSession 新会话全量。
7. **TASK-007** 端到端验证：mock 全闭环 PASS；会话复用/隔离、Skill 仅工作台启用、Prompt 精简均验证通过。
8. **TASK-008** Token 对比 + 最小修正：init prompt 降 79.5%、task.json 降 27.6%；依测量把 `slimPlan` 改为去掉任务描述；mock 闭环复测 PASS。

## 三、当前进度与状态
- 全部 8 项任务已标记完成，无失败任务；当前项目状态 ANALYZING（正在生成最终分析供 GPT 审查）。
- **当前运行时信号**：GPT 审查最终分析后回复 `CONTINUE` + `NEXT_TASK=TASK-009`，暗示需追加一项后续任务（`TASK-009` 尚未列入计划，待 GPT 通过 REPLAN 增补后再执行）；此前有一次 `GPT_PAGE_ERROR`（"消息发送后未检测到用户消息增加"），属 ChatGPT 页面/发送偶发问题，已触发重试，不影响代码交付。
- 运行中的工作台进程（PID 22916）仍为改动前代码；`workbench-exec` dsh 服务（PID 17240）在跑。**新代码待重启工作台后生效。**
- 改动文件：prompts.mjs / protocol.mjs / orchestrator.mjs / deepseek_runner.mjs / dsh_ui.mjs(少量) / workbench_skill.mjs(新) / config.json / README.md / skills/workbench-executor/SKILL.md(新)。

## 四、验证结论（对照验收标准）
- ✔ 稳定角色/协议不再重复发送（init -79.5%，协议入 Skill）。
- ✔ 工作台专用 Skill，仅工作台调用启用（项目 `.dsh/skills` + 激活 + 上下文门控）。
- ✔ 用户直接调用不改变默认行为（`~/.dsh/skills`、其他项目均无该 Skill）。
- ✔ 同项目会话复用、新项目独立会话（getOrCreateSession 按 projectId）。
- ✔ 单 Task 消息不再携带完整任务列表/角色/格式。
- ✔ Task 消息保留 Task ID/目标/依赖/验收/必要增量上下文。
- ✔ 项目状态增量传递（context_cache + 计数引用）。
- ✔ ANALYSIS/QUERY/REPLAN/CONTINUE/DONE 协议可用（mock 闭环 + 代码保留）。
- ✔ Harness 异常退出检测/恢复（uiRecoveryRetries + 会话重建）。
- ✔ 端到端通过，Token 明显下降。

## 五、遗留问题与建议
1. **生效需重启**：运行中工作台跑旧代码；重启后新逻辑才生效。建议重启后跑一个真实 2-3 任务小项目做最终回归（真实 LLM 环境确认会话复用与 Token 下降）。
2. **Skill 目录级隔离的严格性**：当前 Skill 放在项目源码 `.dsh/skills`，若用户在同一目录直接运行 dsh，其目录中会出现该 Skill（但不会自动应用，且上下文门控阻止行为改变）。若需更严格的"目录级不可见"，可进一步走 profile 级运行时注册（通过 workbench-exec profile 的 cordis.patch.yml 挂载 runtime skill，仅该 profile 可见）——建议在后续迭代按需启用并验证。
3. **turn 消息略增大**：复用会话的任务消息比旧的"仅读 task.json"多携带了任务/目标/验收/状态字段（57→172 tok），属设计取舍（显式携带可免读 task.json、且随项目增大收益递增）；若需进一步压缩，可在消息中省略验收标准细节而只留计数。
4. **`stripPlanRaw` 现未被 orchestrator 使用**（改用 slimPlan）；保留导出兼容，可考虑后续清理。
5. **真实压测缺口**：未做真实 LLM 多任务压测（耗时耗 token，且真实会话由运行中旧进程持有）；正式发布前建议补一次。

## 六、结论
本次重构目标全部达成：稳定协议下沉为工作台专用 Skill、同项目会话复用、项目初始化与 Task 消息精简、增量上下文、Token 显著下降，且保留状态机/REPLAN/失败重试/最终审查与协议语义。代码结构与现有架构完全兼容，未引入大型依赖。**项目可进入最终审查（REVIEW）阶段；建议重启工作台后做一次真实项目回归。**
