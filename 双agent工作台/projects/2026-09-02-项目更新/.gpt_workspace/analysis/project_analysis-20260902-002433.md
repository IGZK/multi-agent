# 项目分析：双 Agent 协作工作台 —— DeepSeek Harness 调度与通信优化

> 分析范围：TASK-001（全量分析，不含代码修改）
> 生成时间：2026-09-02 00:24
> 目标：回答 GPT 的 4 个追踪问题，给出当前行为、真实生命周期载体、Skill/注入机制现状，以及后续 TASK-002~006 的落点建议。

---

## 一、项目概况

- 版本：`1.1.0`（2026-09-01），`ai-dual-agent-workbench`，Node ESM。
- 核心架构（与本项目目标一致，保持不变）：**GPT-5.6 Sol（ChatGPT 浏览器桥）规划/审查 + 本地编排器状态机 + DeepSeek Harness 执行**。
- 运行状态（实测）：当前有一个真实工作台进程在跑（`node controller/index.mjs`，PID 22916），并已为一个项目拉起 `workbench-exec` 端口的 dsh web 服务（PID 17240）。当前信封任务 TASK-001 正运行于新创建的首个会话中。
- 依赖：仅 `playwright-core`（GPT 桥用）。DeepSeek 端复用本机已装的 `@deepseek-ai/dsh` CLI。

## 二、目录结构与模块职责（需要改动的代码位置）

```
双agent工作台/
├── controller/
│   ├── index.mjs            # 主入口/装配/单实例锁/自测
│   ├── orchestrator.mjs     # 状态机 + 自动循环 + Task 调度 + 信封构造（核心改动点）
│   ├── deepseek_runner.mjs  # DeepSeek 执行桥：可见模式/headless/生命周期（核心改动点）
│   ├── dsh_ui.mjs           # 可见执行服务：每项目一个 dsh web 进程 + 会话 RPC + 窗口（核心改动点）
│   ├── prompts.mjs          # 固定系统提示词 + 信封拼装（核心改动点：Skill 迁移入口）
│   ├── protocol.mjs         # GPT/DeepSeek XML 协议解析 + 计划合并
│   ├── gpt_bridge.mjs       # ChatGPT 浏览器桥（GPT 侧，非本目标重点）
│   ├── server.mjs           # Dashboard HTTP API
│   ├── store.mjs            # 项目工作区 + project_state.json（断点恢复）
│   └── logger.mjs
├── web/                     # Dashboard 前端（原生 HTML/JS）
├── config/config.json       # 全量配置
├── projects/<日期-项目名>/  # 每个项目 = .gpt_workspace/ + source/
└── browser-profile/         # 专用 Chrome 登录态
```

关键数据流：`orchestrator` 用 `buildEnvelope()` 造信封 → `runner.run()` 写 `inbox/task.json` + `task_prompt.txt` → 可见模式走 `dsh_ui`（会话 RPC）或 headless 走 `spawn node dsh --profile headless <prompt>` → 执行者完成后写 `outbox/message.json` → `handleExecutorResult()` 流转。

## 三、GPT 追踪问题逐条回答

### 1. DeepSeek Prompt 在哪里拼接？

- 系统提示词常量：`controller/prompts.mjs` 的 `DEEPSEEK_EXECUTOR_PROMPT`（约 95 行、~2900 字符，含角色分工/工作目录约定/信封格式/何时问 GPT/硬性要求）。
- 组装函数：
  - `buildExecutorPrompt(envelope)` —— 新会话完整提示 = `DEEPSEEK_EXECUTOR_PROMPT` + `本次任务信封`（整份 plan JSON）。调用点：`deepseek_runner.buildPrompt()` → `run()`。
  - `buildExecutorTurnPrompt(envelope)` —— 复用会话精简提示（约 200 字符，"读取 inbox/task.json 并执行 current_task"）。调用点：`runVisible()` 中 `submitPrompt = sessionReused ? buildExecutorTurnPrompt(envelope) : prompt`。
- 落地文件：每次 `run()` 都会把完整 prompt 写进 `inbox/task_prompt.txt`，把信封写进 `inbox/task.json`。
- **注意**：`buildExecutorPrompt` 里"本次任务信封"就是 GPT 原样生成的整份 plan（`buildEnvelope()` 用 `stripPlanRaw` 只去掉 `raw` 字段，parsed 计划的所有 tasks/goals/acceptance/constraints 仍完整嵌入）。

### 2. Harness"窗口"究竟是什么载体？（复用方案必须针对真实生命周期）

**结论：所谓"窗口"不是终端窗口，也不是 CLI 会话，而是【一个每项目独立的 dsh Harness Web 服务进程 + 一个持久化会话 + 可选浏览器窗口】**。具体：

- 可见模式（默认 `deepseek.visible=true`）：`dsh_ui.mjs` 的 `ensureServer()` 为每个项目 spawn 一个 `node <dshBin> --profile workbench-exec --port <空闲端口> --no-open` 进程（`this.servers` Map 按 projectId 持有）。它是一个 **HTTP RPC 服务**（`/api/session.create`、`session.prompt`、`session.list`、`session.cancel` 等），会话上下文由 dsh 持久化在 `<dshHome>/sessions`。
- `createSession`/`getOrCreateSession()` 用 `session.create`（cwd=项目 source_dir）创建会话；**一个项目一个会话，跨任务复用**（先查 `session.list` 确认仍存活，失效才重建）。
- "窗口" = `openBrowserWindow(server.url)` 打开的浏览器页，只是把上面这个 URL 展示给用户看，**不是独立进程**。
- headless 回退：`runHeadless()` 每次任务 spawn 一个全新 `node <dshBin> --profile headless <prompt>` 进程，**不复用**。

### 3. Task 执行是否每次重新初始化上下文？

**可见模式下不再重新初始化**（1.1.0 已实现）：
- 首次任务：新会话 + 完整提示（`DEEPSEEK_EXECUTOR_PROMPT` + 整份 plan）。
- 后续任务：`getOrCreateSession` 复用同一 sessionId，`submitPrompt` 只发精简 `buildExecutorTurnPrompt`（约 200 字符），会话内历史连续。

**headless 模式下仍然每次全新进程/全新上下文**（新任务=新 `dsh --profile headless`，无会话复用）。

### 4. 现有项目是否已有 Skill / 系统提示注入机制？

- **工作台代码里没有任何 Skill 概念**（`grep skill` 在 `controller/` 无命中）。
- 稳定规则目前以**字符串常量**注入到每次新会话的 Prompt 文本里（`DEEPSEEK_EXECUTOR_PROMPT`），并非以 dsh Skill 机制承载。
- **但底层 dsh Harness 具备完整 Skill 机制**（这是本次方案可落地的关键依据）：
  - 包：`@deepseek-ai/dsh-skill`（注册表）、`@deepseek-ai/dsh-skill-filesystem`（本地发现）、`@deepseek-ai/dsh-tool-skill`（目录 + `skill` 工具）。这些随 `standard` agent preset 挂载（本会话即运行在该 preset 下，具备 `skill` 工具与会话 Skill 目录）。
  - Skill 形态：`<root>/<name>/SKILL.md`（带 YAML frontmatter：`name`、`description`、`whenToUse` 等）或平铺 `<name>.md`；只扫描一层。
  - 发现根（rank）：项目根 `.dsh/skills`(100)、`.agents/skills`(200)、`customSkillDirs`(300)、用户根 `<dshHome>/skills`(400)、`<agentsHome>/skills`(500)。项目根=最近含 `.git` 的祖先，否则 cwd。
  - 当前实测：`~/.dsh/skills` 与 `~/.agents` **均不存在**，各项目目录也没有 `.dsh/skills`。所以现在没有任何 user/project skill 在作用域内。

## 四、现状 vs 计划目标（差距清单）

| 计划目标 | 现状 | 差距 |
|---|---|---|
| TASK-003：同项目复用会话/窗口，新项目独立 | **可见模式已实现**（`getOrCreateSession` 每项目一会话，`servers` 按 projectId 隔离）；headless 模式未复用 | headless 回退路径仍每任务新进程；崩溃自动重建逻辑已有雏形但需加固 |
| TASK-002：把稳定角色/协议下沉为工作台专用底层 Skill，且仅工作台调用启用 | **未实现**。稳定规则仍是 `DEEPSEEK_EXECUTOR_PROMPT` 字符串，随每次新会话 Prompt 发送 | 需新建 SKILL.md + 设计"仅 workbench-exec profile 生效"的隔离机制 |
| TASK-004：项目初始化消息精简 | 部分。新会话仍整份 plan 内嵌；无"最小项目上下文 + Skill 入口"分离 | `buildExecutorPrompt` 需改为短入口指令 + Skill 激活 |
| TASK-005：Task 消息精简，去掉末尾重复角色/格式文本 | 可见模式复用会话已用精简 `buildExecutorTurnPrompt`，**不再**每任务追加角色/格式 | 但 `inbox/task.json` 每任务仍带完整 plan/完整 user_task/decisions；执行者按提示"读取 task.json"会把整份 plan 重新读进上下文 |
| TASK-006：上下文缓存/增量引用 | **未实现**。`buildEnvelope` 每次全量传 plan、completed/failed、decisions、user_task | 需引入"已发送即缓存，只传增量"机制 |

**关键结论**：用户抱怨的 3 点中，**第 2 点（每任务重开窗口）在第 1 版 1.1.0 可见模式下已被修掉**，但存在两个真实残留：① headless/回退路径仍每任务新进程；② 每任务 `task.json` 仍全量携带计划/任务列表，执行者读它仍会把整份计划吃进上下文。**第 1 点（Skill）与第 3 点（消息精简）是本次真正要新建的核心工作。**

## 五、Token 消耗现状（供 TASK-008 对比基线）

- 新会话首任务发送量 ≈ `DEEPSEEK_EXECUTOR_PROMPT`(~2900 字符) + 整份 plan JSON(本项目 plan 约 15KB 转义后) + project_name/user_task/decisions/timeout。
- 后续任务（可见复用）发送量 ≈ 200 字符提示，但执行者随后 `read inbox/task.json` 会把整份 plan 读回上下文（受 tool-result 裁剪限制，仍重复）。
- 每任务仍全量落盘 `task_prompt.txt`（含完整提示），虽不直接计 token，但反映消息构造未最小化。

## 六、后续实现落点与建议（TASK-002~006）

### 6.1 Skill 下沉（TASK-002）—— 最需要决策的部分

把 `DEEPSEEK_EXECUTOR_PROMPT` 中**稳定不变**的部分（角色分工、工作目录/信封约定、outbox 格式、何时问 GPT、硬性要求、通信/格式规则）迁到一个 dsh SKILL.md；动态项目数据（当前 task、增量上下文）仍由工作台按需发送。

**"仅工作台启用"的隔离机制（3 种方案，建议 TASK-002 先做最小验证）**：

- **方案 A（推荐，隔离最严）**：工作台已专有 profile `workbench-exec`（bundles= dsh-base + dsh-web-app，且 `ensureProfile()` 已生成空 `cordis.yml`）。在该 profile 的 composition 里加一行，用 `ctx.skills.register(...)` 注册运行时 Skill（rank 250）。只有 workbench 拉起该 profile 时才注册，用户直接 dsh 用其它 profile 完全不可见。**需在 TASK-002 验证 profile 级 composition 是否生效、是否覆盖 standard preset 的目录。**
- **方案 B**：把 SKILL.md 放到各项目 source 的 `.dsh/skills/`（rank 100），工作台首任务提示显式"激活并遵循 skill"。隔离靠项目目录作用域 + 仅工作台主动调用。缺点：用户在同一个项目目录直接跑 dsh 时目录里会出现该 skill（虽不被自动应用）。
- **方案 C**：放 `~/.dsh/skills/`（用户根），工作台提示显式调用。**最不推荐**——用户直接调用时目录里也会出现，隔离弱。

> 建议：优先方案 A；若 profile composition 不可行，退到方案 B + 显式激活指令。无论哪种，稳定规则都要从"Prompt 文本常量"迁移为"Skill 指令"，让新会话 Prompt 只剩短入口（如"请加载 skill <name> 并读取 inbox/task.json 执行 current_task"）。

### 6.2 生命周期加固（TASK-003）

- 保持可见模式 `getOrCreateSession` 的复用与 `ensureServer`/`isAlive`/`disposeServer` 的存活检测（已存在）。
- **补 headless 路径的会话复用**：要么在 headless 也用 dsh web 服务（统一走可见模式的会话池，`visible=false` 只关 `uiOpenWindow`），要么明确 headless 每任务重建是可接受回退（建议：统一走 web 服务会话复用，headless 仅作极端兜底）。
- 异常退出自动恢复：现有 `getOrCreateSession` 会话失效即重建 + `ensureServer` 服务死亡即重启，已覆盖多数场景；建议补一次"提交后服务崩溃 → 自动重试一次提交"的护栏，避免 `RUNNER_UI_CRASH` 直接判失败。
- 项目隔离已由 `servers` Map 按 projectId 天然隔离，无需改动，验证即可。

### 6.3 消息生命周期精简（TASK-004/005/006）

- `buildEnvelope()`：改为只含 `current_task`（id/description/priority/dependencies）、项目名、当前状态摘要、Skill 激活标识；去掉完整 plan、完整 user_task、decisions 全量。
- 首任务：短入口（Skill 激活 + 最小项目上下文 + "读取 task.json"）。
- 后续任务：`buildExecutorTurnPrompt` 保留（已精简），且把 `inbox/task.json` 也改为精简信封（当前 task + 增量），避免执行者读回完整 plan。
- 增量缓存：工作台在会话内已发送的信息（project_name、objective、已完成任务）不再重发，只发相对上一状态的变化（新增 completed 任务、REPLAN 差异等）。可在 `project_state.json` 维护 `last_sent_*` 基线。
- 风险：**协议/状态机语义（ANALYSIS/QUERY/REPLAN/CONTINUE/DONE、失败重试、REPLAN 增量合并）全部保留，只改通信内容**，不要动 `protocol.mjs`/`orchestrator` 的状态分支。

## 七、风险与注意事项

- 不能改 GPT 侧 `GPT_SYSTEM_PROMPT` 与 XML 协议（那是大脑侧协议）。
- `DEEPSEEK_EXECUTOR_PROMPT` 迁移到 Skill 后，要保证执行者仍遵守信封/outbox 约定；Skill 正文必须能完整承载这些规则，否则执行者可能"失忆"。
- 每任务 `task_prompt.txt` 落盘逻辑可一并精简，避免误导。
- 路径中文乱码：`source_dir` 在 `project_state.json` 里显示为 `双agent锟斤拷锟斤拷台`（GBK/UTF-8 混淆），与本目标无关但若后续写路径相关代码需留意编码。

## 八、结论

- **已具备的基础**：可见模式会话复用（1.1.0）已解决"每任务重开窗口"；dsh 底层 Skill 机制完整可复用。
- **本次核心新工作**：① 把稳定角色/协议下沉为工作台专用 Skill（TASK-002）；② 统一/加固会话生命周期含 headless 与崩溃恢复（TASK-003）；③ 真正精简每任务信封与首任务入口（TASK-004/005/006）。
- 建议 GPT 据此决定实现路径，重点先敲定 **Skill 隔离方案（6.1 的 A/B/C）**，再进入 TASK-002。
