# 双 Agent 协作工作台 — UI 重构方案（TASK-002）

> 生成：2026-09-01（执行者） | 依据：`project_analysis.md`（TASK-001）+ 逐行核对的 `web/index.html`、`web/style.css`、`web/app.js`。
> 本文件是 TASK-003…TASK-010 的执行蓝图：给出目标布局、区域/组件归属、DOM 与数据流映射、状态处理、附件设计、视觉规范与验证要点。**不改变后端协议**。

---

## 1. 设计目标与产品定位

参考 **Codex / DeepSeek Harness / 现代 AI Agent-IDE** 的共通设计语言（非复制其界面）：
- **三区工作台布局**：左侧「项目上下文」= 文件/项目操作区；右侧「对话工作台」= 主要工作区；右侧底部「Composer」= 固定输入区。
- **分层表面（layered surfaces）**：背景 < 面板 < 输入区，用边框/圆角/阴影区分层级。
- **密度适中、信息可扫读**：紧凑工具栏 + 充足留白的关键输入区；路径/代码用等宽字体并做溢出截断。
- **明确的状态反馈**：进行中（脉冲/旋转）、成功（绿）、失败（红/可重试）、禁用（降透明度）。
- **键盘优先**：Enter 发送、Shift+Enter 换行、焦点环清晰。

采纳原则（约束）：复用现有 CSS 变量与 `app.js` 工具函数；保持 API 契约；不引入第三方 UI 框架；不做无必要整体重写。

---

## 2. 目标总体布局

```
┌──────────────────────────────────────────────────────────────┐
│ header.topbar  [品牌]                    [系统状态 #sysStatus]│
├──────────────┬───────────────────────────────────────────────┤
│ 左 rail       │  右 main（对话工作台）                         │
│ .sidebar      │  ├ .detail-head  项目工具栏（名称/状态/操作按钮）│
│  • 项目列表    │  ├ .tabs         次级导航（概览/任务/计划/分析/日志）│
│  • 新建项目    │  ├ .convo-scroll 对话历史 #chatList  ← 主内容  │
│  • 当前项目目录 │  └ .composer     底部固定输入区（Composer）    │
│   选择/展示    │      [附件入口][输入框]……[模型/推理][发送]      │
│  footer 系统   │                                               │
├──────────────┴───────────────────────────────────────────────┤
```

**关键关系（必须满足）**：
- 左 rail 固定宽度（建议 300px，`min-width:0`、可随窗口收缩不溢出）。
- 右 main 为 `flex:1` 且 `min-width:0`，内部**纵向 flex**：头部/导航固定，`.convo-scroll` `flex:1; overflow-y:auto`（`min-height:0` 防溢出），`.composer` 固定在底部、**不随对话滚动**。
- `.composer` 内的输入框**水平居中**，模型/推理选择在输入框**右侧**。
- 窗口缩放：全链路 `min-height:0` + `overflow`，任何尺寸下不遮挡/不错位。

---

## 3. 区域归属与组件映射

### 3.1 左侧项目 rail（`.sidebar`）— 归并「项目 + 文件夹选择」
| 组件 | 来源（现状） | 处理 |
|---|---|---|
| 项目列表 `#projList`（分组/归档/操作） | 左栏现有 | 保留，视觉统一（TASK-007/008） |
| 「新建项目」入口 | 左栏 `.new-project` 表单 | 改为**折叠面板**或「＋ 新建项目」按钮展开；保留 `#projName/#projTask/#projCategory/#btnCreate` |
| **项目文件夹选择**（新建用） | `#projDir` + `#btnPickDir`（原左栏） | **保留在左栏**新建面板内（TASK-003/007） |
| **当前项目目录展示/修改** | `#btnSetDir` + `#dirHint`（原右栏详情） | **迁到左栏**：当前项目卡片下显示路径 + 「📁 修改」按钮（TASK-007），路径过长用 `text-overflow:ellipsis` + `title` |
| 系统信息 footer | 左栏现有 | 保留 |

> 目的：项目文件夹选择/展示**稳定位于左侧**，与右侧对话操作区明确分离。

### 3.2 右侧对话工作台（`.main`）
| 组件 | 来源（现状） | 处理 |
|---|---|---|
| 项目工具栏 `.detail-head` | 右栏详情头部 | 精简为横向条：`#dName`、`#dState` 徽章、操作按钮（执行窗口/显示浏览器/暂停/继续/重试）、`#dGptLive` 状态灯 |
| 次级导航 `.tabs` | 右栏现有 Tabs | 保留；**默认选中「GPT 对话」**，对话作为主视图；概览/任务/计划/分析/日志为可切换的次级面板（TASK-003） |
| **对话历史 `.convo-scroll > #chatList`** | 右栏 `#tab-chat` | **提到主视图**（默认展示），`renderChat()` 逻辑复用（增量渲染 + 滚动保护） |
| 底部输入区 `.composer` | 右栏 `#tab-chat` 的 `#injectMsg`+`#btnInject` | **全新固定输入区**（见 §4），发送仍走 `POST /api/projects/:id/message` |
| 模型/推理选择（当前项目） | `#dDsModel`/`#dDsReasoning`+`#btnSaveDsModel`（右栏设置行） | **迁入 Composer 操作栏**（TASK-005），选择即持久化（`deepseek_model` action） |
| 横幅（pending/exec/error）、`#dMeta` | 右栏详情 | 收敛为对话区上方的状态条（折叠展示），不抢对话主视图 |

### 3.3 数据流契约（重构不得破坏）
| 功能 | 现状 API | 重构后保持 |
|---|---|---|
| 新建项目（含 `source_dir`/`deepseek_selection`/`category`） | `POST /api/projects` | 不变，左栏新建面板 |
| 修改文件夹 | `action:"setdir"` | 不变，迁左栏 |
| 模型/推理持久化 | `action:"deepseek_model"` | 不变，Composer 内选择即调用 |
| 发送对话消息 | `POST /api/projects/:id/message {text}` | 不变，Composer 发送按钮触发 |
| 文件夹原生选择 | `POST /api/pickdir` | 不变 |
| 模型目录 | `GET /api/deepseek/models` | 不变，`loadModelCatalog`/`fillModelSelect` 复用 |
| 轮询 | `GET /api/projects` + `GET /api/projects/:id`（2s） | 不变 |

> 结论：**纯前端 DOM/样式/布局重构，API 契约零改动**。

---

## 4. 底部输入区（Composer）设计 — TASK-004/005/006

### 4.1 结构
```
.composer
├ .composer-attachments   # 已选附件预览行（置于输入框上方，不遮挡）
│   └ 附件卡片(chip)：图标｜文件名｜大小｜[上传中..]/[✓]/[✖ 重试]｜× 删除
├ .composer-main（一行）
│   ├ .attach-btns      # 左：📎 文件、📷 照片（hidden file input, multiple）
│   ├ .input-wrap       # 居中：textarea（auto-grow，max-height，Enter 发送）
│   └ .ops              # 右：模型 select + 推理 select + 发送按钮(primary)
└ .hint-row            # 小字：Enter 发送 · Shift+Enter 换行 · 当前项目/模型状态
```

### 4.2 输入框
- 多行 textarea（原生，无第三方），`auto-grow`：高度随内容自适应，`max-height:~180px` 后内部滚动。
- **Enter 发送、Shift+Enter 换行**；空内容禁用发送；发送后清空并重置高度。
- 水平居中：`.input-wrap { flex:1; display:flex; justify-content:center }`，输入框 `max-width`（如 640px）在对话区内视觉居中。

### 4.3 模型/推理（TASK-005，在输入框右侧）
- 两个紧凑下拉：模型、推理等级（复用 `#dDsModel/#dDsReasoning` 的逻辑与 `fillModelSelect`）。
- 未选中项目时 disabled；切换后立即调用 `action:"deepseek_model"` 持久化（`setProjectDeepseekSelection`），保证**实际请求使用所选配置**（不只改前端显示）。
- 展示当前生效值；保存反馈（短暂提示「已保存」）。

### 4.4 附件（TASK-006，前端兼容优先，见约束）
- 入口：`📎`（文件）+ `📷`（照片）→ 隐藏 `<input type=file multiple>`；支持拖拽到 `.composer`（在数据流支持范围内）。
- 每附件卡片：类型图标、文件名、大小、预览（图片用 `URL.createObjectURL` 缩略图）。
- 状态：`ready` → `uploading`（旋转/进度）→ `success`(✓) / `failed`(红 + 重试/移除)；`×` 单独删除；多附件并列。
- **后端现状**：`server.mjs` 仅 JSON、无 multipart、无附件存储。→ 按约束**不新增后端端点**；Composer 附件为**前端本地态**：发送时在 `text` 前追加附件清单（如 `[附件] 报告.pdf (12KB); 照片.png (345KB)`），正文与 `POST /message` 协议不变（服务端只读 `text`），从而让 GPT 感知所附内容；二进制文件真实上传**留待 GPT 决策**（若需则另立任务新增后端上传端点 + 附件持久化）。
- 附件 UI 保证不遮挡输入框/发送/模型选择（位于输入框上方的独立行）。

---

## 5. 左侧项目/目录区状态（TASK-007）
- **未选择项目**：右栏显示 onboading 提示 + 「新建项目」CTA；Composer 禁用并给占位文案。
- **已选项目**：左栏当前项目卡片高亮；下方展示 `source_dir`（ellipsis + title 全文）；「📁 修改」弹原生选择器（`/api/pickdir`）。
- **切换项目**：清空 Composer、刷新对话；模型/推理重置为该项目 `deepseek_selection`。
- **路径过长**：`overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction` 兼容处理，`title` 显示完整路径。
- 与左侧视觉系统统一（同色板、圆角、hover）。

---

## 6. 视觉规范（TASK-008，基于现有 `:root` 变量）
- **复用/扩展 CSS 变量**：现有 `--bg/--panel/--panel2/--border/--text/--dim/--accent/--green/--red/--yellow/--purple` 作为基准；按需补充 `--bg-raise`、`--radius-*`、`--font-mono`、`--focus-ring`、`--composer-bg` 等，保持整体一致。
- **层级**：背景 `--bg` → 面板 `--panel/--panel2` → 输入区稍高亮 `--composer-bg` + 边框；圆角统一（8/10px），边框统一 `--border`。
- **状态**：按钮 hover 边框变 accent、primary 悬浮增亮；focus 用 `outline` 焦点环；disabled 降透明度 + `cursor:not-allowed`。
- **字体**：正文 13–14px；标题加粗；路径/代码用等宽字体栈。
- **深浅色**：以现有暗色变量为主题，额外提供 `[data-theme="light"]` 覆盖变量集（前置实现，避免结构性返工），默认仍为暗色。
- **不复制任何产品品牌元素**：仅吸收布局/层级/反馈通用理念。

---

## 7. 实施顺序映射（增量，不重复已完成）
| 后续任务 | 落点 |
|---|---|
| TASK-003 | `.layout`→两栏网格、右栏纵向 flex、`.convo-scroll`+`.composer` 骨架、min-height 防溢出 |
| TASK-004 | Composer 输入框（auto-grow/居中/Enter 发送）、发送按钮、滚动/长文本 |
| TASK-005 | 模型/推理下拉迁入 Composer 右侧 + 持久化 + disabled 态 |
| TASK-006 | 附件卡片/预览/删除/上传状态/多附件/拖拽 + 发送清单注记 |
| TASK-007 | 左栏项目目录展示/修改迁移 + 未选择/切换/长路径状态 |
| TASK-008 | 视觉统一 + 深浅色变量 + hover/focus/disabled |
| TASK-009 | 启动 server（3700）实际回归（发消息/切项目/模型/附件/缩放） |
| TASK-010 | 清理旧布局残留、错位、未用代码、控制台错误 |

---

## 8. 验证要点（供 TASK-009/010 对照）
1. 输入框在右侧对话区底部、区域内水平居中（非左上角）。
2. 模型/推理在输入框右侧，稳定、易发现；切换后真实请求用所选配置。
3. 项目文件夹选择在左侧，清晰表达当前项目上下文。
4. 左右区边界明确，窗口缩放无错位/遮挡/溢出。
5. 输入支持多行/发送，发送逻辑与重构前一致（`POST /message`）。
6. 附件入口清晰、可多选、可单删、上传中/成功/失败有反馈，且不遮挡输入/发送/模型区。
7. 目录选择/切换项目正常。
8. 启动无控制台严重错误，无旧布局残留与未用代码。

---

## 9. 开放决策（记录，供 GPT/后续处理）
- **附件真实上传**：当前按「前端兼容 + 消息清单注记」实施（不改后端）。若需真实二进制上传，须 GPT 决策新增后端 multipart 端点 + 附件持久化（数据流变更）。
- **左栏宽度/新建面板折叠**：默认 300px + 折叠；若需可拖拽调宽列为可选增强。
