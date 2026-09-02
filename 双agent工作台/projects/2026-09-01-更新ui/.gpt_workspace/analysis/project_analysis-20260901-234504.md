# 双 Agent 协作工作台 UI 重构 — 全量项目分析（TASK-001）

> 生成时间：2026-09-01T23:45（执行者，DeepSeek）
> 目标：为「参考 Codex / DeepSeek Harness 重构对话区与文件操作区布局、完善文件/照片上传 UI」的后续任务提供准确、可执行的现状基线。

---

## 1. 项目是什么

`ai-dual-agent-workbench`（双 Agent 协作工作台）是一个本地运行的双 Agent 自动化平台：

- **GPT-5.6 Sol**（聊天型 ChatGPT，经浏览器桥 `gpt_bridge.mjs` 驱动）→ 负责"想清楚"（规划、决策、审查）。
- **DeepSeek Harness**（本执行者，经 `deepseek_runner.mjs` / `dsh_ui.mjs` 驱动）→ 负责"做出来"（建目录、写代码、跑命令、出报告）。
- **本地编排器**（`orchestrator.mjs`）→ 状态机循环：GPT 规划 → DeepSeek 执行 → 分析 → 决策 → 完成。
- **Web Dashboard**（`web/` 静态前端 + `controller/server.mjs` HTTP API）→ 本次 UI 重构的改造对象。

---

## 2. 技术栈（已确认，非假设）

| 层面 | 技术 | 说明 |
|---|---|---|
| 前端 | 原生 HTML + CSS + 原生 JS（ESM 加载，无框架、无构建） | `web/index.html`、`web/style.css`、`web/app.js` |
| 后端 | Node.js 原生 `http` 模块，ESM | `controller/server.mjs` 启动静态服务 + REST API |
| 运行时 | Node（无构建步骤，改完即生效） | Dashboard 端口 3700（config.json） |
| 第三方依赖 | 仅 `playwright-core` | 用于浏览器桥；前端零第三方 UI 库 |
| 持久化 | 本地 JSON 文件（`store.mjs`） | 每项目 `.gpt_workspace/` 下存 state/plan/analysis/conversation |

**关键结论**：前端是**纯静态文件**，由 server.mjs 直接读盘返回（`serveStatic`），**没有任何构建/打包步骤**。因此 UI 重构 = 直接修改 `web/` 下三个文件即可，改完浏览器刷新即生效；但 server 需已启动（端口 3700）。

---

## 3. 现有目录与关键文件

```
双agent工作台/
├─ controller/
│  ├─ index.mjs            # 入口：装配并启动 server/orchestrator/bridge/runner
│  ├─ server.mjs           # Dashboard HTTP 服务器 + 全部 REST API 路由（本次 UI 依赖它）
│  ├─ orchestrator.mjs     # 项目状态机与动作分发（pause/resume/setdir/...）
│  ├─ store.mjs            # 项目读写（listProjects/projectDetail/readFileSafe/listConversation）
│  ├─ gpt_bridge.mjs       # ChatGPT 浏览器桥（dialogue 真正发生处，本次不动核心）
│  ├─ deepseek_runner.mjs / dsh_ui.mjs  # DeepSeek 执行者（本次不动核心）
│  ├─ folder_picker.mjs    # 原生文件夹选择器（/api/pickdir）
│  └─ prompts.mjs / protocol.mjs / logger.mjs / 各 probe 测试
├─ web/                    # ★ 本次重构目标
│  ├─ index.html           # 页面结构（布局骨架，需大改）
│  ├─ style.css            # 全部样式（需系统性扩充）
│  └─ app.js               # 前端逻辑（DOM、轮询、事件、API 调用）
├─ config/config.json      # dashboard port=3700，gpt/deepseek 均为 real
├─ projects/<projectId>/   # 每项目工作目录（.gpt_workspace/...）
└─ logs/
```

---

## 4. 现有页面布局（重点记录"现状 vs 目标"）

### 4.1 当前 DOM 结构（index.html）
- `header.topbar`：品牌 + `#sysStatus`。
- `div.layout`（flex，高度=视口）：
  - **左侧 `aside.sidebar`（固定 320px）**：
    - 「新建项目」表单：`#projName`、`#projTask`、目录选择行（`#projDir` 输入框 + `#btnPickDir` 原生选择）、`#projCategory`、**DeepSeek 模型 `#dsModel`**、**推理等级 `#dsReasoning`**、创建按钮 `#btnCreate`。
    - 项目列表 `#projList`（按分类分组、归档折叠）。
    - 底部系统信息 `#sysInfo`。
  - **右侧 `main.main`（flex:1，overflow-y:auto）**：
    - 空提示 `#emptyHint`。
    - 项目详情 `#detail`（选中项目后显示）：
      - 头部：`#dName`、状态徽章 `#dState`、操作按钮（执行窗口/显示浏览器/暂停/继续/重试）。
      - GPT 实时状态 `#dGptLive`、元信息 `#dMeta`。
      - **目录行 `#btnSetDir` + `#dirHint`**（改项目文件夹，在右侧）。
      - **设置行 `#dDsModel`、`#dDsReasoning` + `#btnSaveDsModel`**（在右侧）。
      - 横幅：pending / exec-ui / error。
      - **Tabs**：概览/任务进度/GPT规划/项目分析/**GPT对话**/日志。
      - **对话 Tab（`#tab-chat`）**：`#injectMsg`（单行输入）+「发送给 GPT」`#btnInject` + 对话历史 `#chatList`。

### 4.2 现状 vs 用户目标（关键差异表）

| 用户目标 | 现状 | 差距 |
|---|---|---|
| 对话输入框在**右侧主对话区底部居中** | 输入框 `#injectMsg` 藏在「GPT 对话」**Tab 内部**，且是单行小输入，不在底部固定栏 | 大。需新增/改造为右侧对话区底部固定输入区 |
| 模型+推理强度选择放在**输入框右侧** | 模型/推理在选择在两个地方：左栏新建表单 + 右侧详情"设置行"，**均不在输入框右侧** | 大。需挪到输入框右侧形成操作栏 |
| 项目文件夹选择放**左侧** | 新建表单的目录选择已在左侧；但**详情页改目录按钮在右侧** | 中。需把"当前项目文件夹"展示与修改稳定归并到左侧 |
| 完善文件/照片**上传 UI** | **完全不存在**：无上传入口、无附件展示、无上传状态 | 大。需从零设计（见 §6 战略问题） |

### 4.3 现有数据流 / 功能依赖（重构时**必须保持**）
- **模型/推理 → 后端**：`selectedModelPayload()` 从 `#dsModel`+`#dsReasoning` 读取 → `POST /api/projects`（body `deepseek_selection:{provider,model,reasoningEffort}`）；详情页 `#dDsModel`+`#dDsReasoning`+`#btnSaveDsModel` → `POST /api/projects/:id/action` `{action:"deepseek_model", selection:{...}}`。模型目录来自 `GET /api/deepseek/models`（`loadModelCatalog`→`fillModelSelect` 填充两个下拉）。
- **目录选择 → 后端**：`#btnPickDir` → `POST /api/pickdir {start_dir}`（原生选择器）→ 写入 `#projDir` → 创建时 `POST /api/projects {source_dir}`；详情 `#btnSetDir` → `POST /api/projects/:id/action {action:"setdir", dir}`。
- **对话消息 → 后端**：`#btnInject` → `POST /api/projects/:id/message {text}`（injectMessage）；对话历史经 `renderChat(d.conversation)` 渲染。
- **轮询**：`refresh()` 每 2s → `GET /api/projects` + 选中项目 `GET /api/projects/:id`。
- **说明**：真正的主对话通道是"项目任务描述 → GPT 规划 → DeepSeek 执行"，`#injectMsg` 只是给 GPT 的补充手动消息。重构底部输入区时需明确它对应哪条数据流（见 §7 建议）。

---

## 5. 可复用组件 / 样式（能复用则不重写）

- **CSS 变量主题**（style.css `:root`）：`--bg/--panel/--panel2/--border/--text/--dim/--accent/--green/--red/--yellow/--purple`，暗色主题。→ 直接复用，作为视觉统一基础。
- **`.btn`/`.btn.primary`/`.btn.small`、`.badge`、`.card`、`.file-view`、`.task-table`、`.chat-msg`**：现有通用样式可沿用。
- **`escapeHtml`、`fmtDuration`、`api()`、`actionWith()`、`fillModelSelect()`、`splitModelValue()`**：前端已有工具函数，直接复用。
- **`#chatList` 对话渲染**（renderChat，带增量渲染/滚动保护）：可迁入右侧对话区，避免重复实现。
- 前端**无任何第三方 UI 库**，按约束应继续用原生实现，不引入新框架。

---

## 6. 关键战略问题（供后续任务 / GPT 决策，不在本任务擅自决定）

1. **文件/照片上传没有任何后端能力**（最大约束点）：
   - `server.mjs` 的 `readBody()` 只解析 JSON（上限 1MB），**无 multipart/form-data 处理**；API 路由无任何 upload/attachment 端点；`store.mjs`、`orchestrator.mjs` 无附件概念。
   - 约束明确："如现有上传能力存在后端/数据流限制，先保留现有能力并对前端 UI 做兼容设计，**不得为 UI 强行改变后端协议**。"
   - 因此 TASK-006 只能二选一：
     - **A. 纯前端兼容设计**：附件选择/预览/删除/多选/状态为**前端本地态**，不上传后端（或仅收集为待发送内容），发送时把文件名/文本作为消息附注注入 `POST /api/projects/:id/message`。零后端改动，符合约束。
     - **B. 新增后端上传端点**（`POST /api/upload` + multipart、附件落盘到项目 `workspace_dir/attachments`、持久化附件清单到 state）：属于"后端协议/数据结构变更"，**需 GPT 决策**。若选 B，需一并评估注入对话与存储方案。
   - **本任务结论**：标记为开放决策，默认推荐 A（保能力、兼容、不动后端），除非 GPT 明确要求新增后端上传。

2. **底部输入框的语义/数据流**：用户想要 Codex 式底部输入。当前只有 `#injectMsg`（手动发给 GPT）与"新建项目任务描述"。需确认底部输入区 = 复用/改造 `#injectMsg` 通道（发送给当前项目 GPT），还是新增独立 Composer。推荐：**复用 injectMessage 通道**作为右侧底部输入（改动小、符合现有 API）。

3. **详情区与对话区的整合方式**：当前右侧 main 被"项目详情(Tabs)"占据，并没有一个持续可见的"对话区"。重构需决定：右侧是"始终显示对话区 + 底部输入栏"，详情信息以可折叠/次要方式呈现，还是保持 Tabs。推荐：右侧主区为**对话工作台视图**（对话历史 + 底部输入栏），项目状态/计划/分析等保留为可切换 Tab。

---

## 7. 建议的后续实施路径（TASK-002 起参考）

1. **TASK-002 方案**：左右两栏稳定分离——
   - 左栏：项目列表 + 新建项目 + **项目文件夹选择/当前项目目录**（归并 `#projDir`、`#btnSetDir`、`#dirHint` 到此）。
   - 右栏：顶部项目信息条 + 中部对话历史 + **底部固定输入区**（输入框水平居中 + 右侧操作栏：模型/推理选择、附件入口、发送按钮）。
2. **TASK-003**：改造 `div.layout` 布局为两栏网格（左 300–340px / 右 flex:1），右侧对话区 `display:flex; flex-direction:column`，输入栏固定在底部、不随滚动走；CSS 用 `min-height:0` 保证可滚动不溢出。桌面缩放保持对齐。
3. **TASK-004**：底部输入区容器（多行 textarea/输入框、Enter 发送、Shift+Enter 换行、自动增高、滚动），左侧可放附件入口，右侧放模型/推理与发送。
4. **TASK-005**：模型/推理下拉移到输入框右侧操作栏；保持 `selectedModelPayload()` 与 `deepseek_model` action 数据流不变（仅 DOM 位置变化）。
5. **TASK-006**：附件上传 UI（先按 §6 决策 A 做前端态：入口、多附件卡片、预览、删除、上传中/成功/失败态；如需后端再补端点）。保证不遮挡输入区。
6. **TASK-007**：左栏项目/目录区视觉统一 + 未选择/切换/路径过长状态。
7. **TASK-008**：统一字体层级、间距、圆角、边框、背景层次、hover/focus/disabled、深浅色兼容。
8. **TASK-009/010**：启动 server（端口 3700）实际回归 + 清理残留。

---

## 8. 运行与验证方式

- **启动**：项目根 `node controller/index.mjs`（或 `start.bat`）。Dashboard 监听 `http://127.0.0.1:3700`。
- **注意**：存在单实例锁（`logs/workbench-default.lock`，PID 22916 曾占用）；多实例或残留 lock 会拒绝启动，需先清理或结束旧进程。当前 **3700 端口未监听（Dashboard 未运行）**，本任务仅分析、未启动；后续回归任务需自行启动并验证。
- **验证入口**：改 `web/` 文件 → 刷新浏览器 → 观察布局/交互 → 用 `GET /api/...` 确认数据流未被破坏。
- 前端无构建，改动即时生效（前提 server 在跑）。

---

## 9. 结论

- 项目技术栈简单清晰（原生三件套 + Node 静态服务），**UI 重构只动 `web/` 三文件**，不触碰 Agent/API 核心逻辑即可满足约束。
- 现有 CSS 变量与工具函数可充分复用。
- 当前最大缺口 = **文件/照片上传后端与 UI 均不存在**（须按约束以"前端兼容设计"优先，新增后端端点需 GPT 决策）。
- 布局重构要点 = 右侧底部固定输入栏 + 输入框右侧模型/推理操作栏 + 左栏项目/目录区，均已确认对应数据流，重构时可保持 API 契约不变。
