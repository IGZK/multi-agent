# 项目分析：双 Agent 协作工作台 —— DeepSeek Harness 调度与通信优化（最终）

> ANALYZE 最终分析（重新生成）| 2026-09-02 | 全部 8 项任务已完成、0 失败 | 请求：生成最终项目分析

## 一、项目结构与关键文件

```
双agent工作台/
├── controller/
│   ├── index.mjs             # 主入口/装配/单实例锁/自测
│   ├── orchestrator.mjs      # 状态机+调度+信封构造（含增量上下文 context_cache）
│   ├── deepseek_runner.mjs   # 执行桥：项目级会话池（session pool）+ 崩溃自动恢复
│   ├── dsh_ui.mjs            # 每项目一个 dsh web 服务 + 持久会话 RPC（getOrCreateSession）
│   ├── prompts.mjs           # 项目初始化消息（buildProjectInitContext）+ 任务消息（buildTaskMessage）
│   ├── protocol.mjs          # 协议解析 + slimPlan/mergePlan 计划工具
│   ├── workbench_skill.mjs   # 工作台专用 Skill 供给/加载/校验（projectSkillDir 等）
│   ├── gpt_bridge.mjs / server.mjs / store.mjs / logger.mjs / visible_probe.mjs / folder_picker.mjs
├── skills/workbench-executor/SKILL.md   # 工作台专用底层 Skill（稳定协议源，供项目供给）
├── .dsh/skills/workbench-executor/SKILL.md  # 工作台把 Skill 供给到的目标（工作台自身源码目录）
├── config/config.json
└── projects/<项目>/
```

> 说明：真实模式以 **每项目一个 dsh web 服务 + 一个持久会话** 承载 DeepSeek Harness 执行（会话池由
> `deepseek_runner.mjs` 的 `servers Map`（键控 projectId）与 `dsh_ui.mjs` 的 `getOrCreateSession` 实现）。
> 用户实际看到的"窗口"本质是 dsh web 服务/持久会话载体；`visible` 只控制是否弹窗，`headless` 仅作兜底。

## 二、已完成的工作（TASK-001..008 全部完成）

1. **TASK-001 全量分析**：定位 Prompt 拼接位置、Harness "窗口"的真实载体（每项目 dsh web 服务 + 持久会话）、
   会话复用基础、项目现状（工作台本身此前没有自己的 Skill 供给机制，底层 dsh 具备 skill 发现能力）。
2. **TASK-002 工作台专用底层 Skill**：新建 `skills/workbench-executor/SKILL.md`（角色/职责/通信协议/outbox 格式/
   状态语义/何时上报/上下文门控）；`workbench_skill.mjs` 将其供给到项目源码 `<sourceDir>/.dsh/skills/`；
   `run()` 分派前先供给；首个提示内写入 Skill 激活入口。**仅工作台调用生效的三层保障**：只放项目级 `.dsh/skills` +
   仅工作台激活 + Skill 正文"上下文识别规则"门控（普通直接调用/无信封即忽略）。
3. **TASK-003 生命周期重构**：真实模式统一走"项目级会话池"（`runSessionPool`），一个项目一个 dsh 服务 + 一个
   持久会话跨任务复用；服务崩溃自动恢复（`uiRecoveryRetries`）；新增项目级会话状态记录/查询；按 projectId 隔离，
   新项目新建服务与会话。
4. **TASK-004 项目初始化消息重构**：区分"项目级初始化上下文"与"Task 执行指令"；新增 `buildProjectInitContext`；
   `buildExecutorPrompt` 只发最小项目上下文 + 项目状态 + Skill 入口 + 指向 task.json，移除内嵌完整角色文本与
   整份任务列表转储。
5. **TASK-005 任务消息重构**：`slimPlan` 精简计划视图、`buildTaskMessage` 只含当前 Task ID/优先级/依赖/目标/
   验收标准/项目状态/必要上下文，删除每个 Task 末尾重复追加的角色要求、通信格式、完整计划等固定文本。
6. **TASK-006 上下文缓存/引用机制**：新增 `context_cache` 基线与 `updateContextCache`；信封只传相对上一状态的
   增量（completed/failed/decisions/replans）+ `context` 计数摘要（fresh/planChanged/计数）；runner 返回
   `freshSession`，新会话则下发全量；`buildTaskMessage` 按增量+引用渲染。
7. **TASK-007 端到端验证**：mock 全闭环 PASS（计划→执行→分析→审查→COMPLETED）；会话复用/项目隔离成立
   （同项目复用同一 session、新项目新会话）；Skill 仅存在于工作台项目 `.dsh/skills` 且带上下文门控；Prompt 渲染
   断言角色/格式/完整任务列表不再重复、后续任务为增量；重试/REPLAN/审查逻辑保留。
8. **TASK-008 Token 对比 + 最小修正 + 最终验收**：见下节；依测量把 `slimPlan` 改为任务列表去掉描述（仅保留
   id/priority/status/dependencies），修正后全量语法通过、mock 闭环复测无回归。

## 三、重构前后 Token / 消息规模对比（代表型 8 任务项目，~tokens≈字符/3.5）

| 场景 | 重构前 | 重构后 | 变化 |
|---|---|---|---|
| 首个任务（新会话）init prompt | 1685 tok | 344 tok | **-79.5%** |
| 后续任务 inbox/task.json 内容 | 1261 tok | 913 tok | **-27.6%** |
| 后续任务 turn 消息本身 | 57 tok | 172 tok | +（显式携带任务/目标/验收/状态） |
| 后续任务合计（turn+task.json） | 1319 tok | 1122 tok | **-14.9%** |

收益来源：①稳定角色/协议下沉到 Skill，从 init prompt 移除；②计划精简（去掉各任务描述/重复固定文本）；
③增量上下文（只传增量 + 计数引用）；④任务消息显式携带必需字段。随项目规模增大收益更明显。

## 四、当前进度与状态

- 8 项任务全部完成、0 失败；当前请求为 **ANALYZE（生成最终项目分析）**。
- **已核实的代码落点**（本次分析直接读取源码确认）：`getOrCreateSession`/`servers Map(projectId)/
  runSessionPool/uiRecoveryRetries`（会话复用与隔离）、`workbench_skill.mjs` 的 `projectSkillDir/供给/校验`、
  `SKILL.md` 的"上下文识别规则（工作台调用判定）"、`prompts.mjs` 的 `buildProjectInitContext`/`buildTaskMessage`、
  `orchestrator.mjs`/`protocol.mjs` 的 `context_cache`/`slimPlan` 均存在。
- **生效提示**：运行中的工作台进程仍可能跑旧代码（此前各任务改动待重启工作台后生效）；本分析基于当前源码状态，
  建议重启工作台后跑一个真实 2-3 任务小项目做最终回归（真实 LLM 环境确认会话复用与 Token 下降）。

## 五、验收结论（对照计划验收标准）

- ✔ 稳定角色/协议不再在每次 Task Prompt 中重复发送（init -79.5%，协议入 Skill）。
- ✔ 存在工作台专用 Skill 且仅工作台调用启用（供给 + 激活 + 上下文门控三层；`~/.dsh/skills`、其他项目无该 Skill）。
- ✔ 用户直接调用不改变默认行为（Skill 仅项目 `.dsh/skills` + 门控）。
- ✔ 同项目会话复用、新项目独立会话（`servers Map` 键控 projectId + `getOrCreateSession`）。
- ✔ 单 Task 消息不再携带完整任务列表/角色/格式（渲染断言 + slimPlan 去描述）。
- ✔ Task 消息保留 Task ID/目标/依赖/验收/必要增量上下文。
- ✔ 项目状态增量传递（context_cache + 计数引用）；freshSession 新会话发全量，避免过度缓存。
- ✔ ANALYSIS/QUERY/REPLAN/CONTINUE/DONE 协议可用（mock 闭环 + 代码保留）。
- ✔ Harness 异常退出检测/恢复（uiRecoveryRetries + 会话重建）。
- ✔ 端到端通过，Token 明显下降（init -79.5%、task.json -27.6%、合计 -14.9%）。

**结论：全部验收标准满足，重构完成。**

## 六、遗留问题与建议

1. **真实回归缺口**：重构后未在真实 LLM 环境跑过多任务小项目做最终确认（mock 已验证全闭环；真实会话此前由运行中
   的旧代码进程持有）。建议重启工作台后跑一个 2-3 任务真实项目，确认会话复用与 Token 下降在真实环境成立。
2. **Skill 目录级隔离的严格性**：当前 Skill 放在项目源码 `.dsh/skills`，若用户恰好在同一目录直接运行 dsh，其目录会
   出现该 Skill（但不会自动应用，且上下文门控阻止行为改变）。如需更严格的"目录级不可见"，可走 profile 级运行时
   注册（workbench-exec profile 的 cordis.patch.yml 挂载 runtime skill，仅该 profile 可见），建议按需后续启用验证。
3. **turn 消息略增大**：复用会话的任务消息比旧的"仅读 task.json"多携带任务/目标/验收/状态字段（57→172 tok），属
   设计取舍（显式携带可免读 task.json、随项目增大收益递增）；若需进一步压缩可省略验收细节只留计数。
4. **`stripPlanRaw` 现未被 orchestrator 使用**（改用 slimPlan），保留导出兼容，可考虑后续清理。
5. **运行/运维**：`project_state.json` 记录的 `last_error=RUNNER_UI_CRASH` 属历史会话崩溃记录，新版已加入自动恢复；
   另记录过一次 GPT 侧 `GPT_PAGE_ERROR`（ChatGPT 页面发送偶发问题，已重试），不影响代码交付。
