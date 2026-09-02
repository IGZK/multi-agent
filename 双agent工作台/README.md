# 双 Agent 协作工作台

一个本地运行的自动协作工作台：ChatGPT 负责规划与决策，DeepSeek Harness 负责读取项目、改代码和运行测试，本地编排器负责在两者之间传递结果并持久化进度。

## 快速开始

环境要求：Windows、Node.js 20+、Chrome、已安装并可用的 DeepSeek Harness。

```powershell
npm install
.\start.bat
```

`start.bat` intentionally contains ASCII-only launcher text. Windows `cmd` may parse a UTF-8 batch file before the code-page switch and turn Chinese text into commands or invalid paths; the Dashboard itself remains fully localized.

然后打开 <http://127.0.0.1:3700>。首次使用时，在工作台专用 Chrome 窗口中登录 ChatGPT；登录态保存在本机 `browser-profile/`。

在左上角点击“新建项目”，右侧底部会显示创建区：

1. 描述你想构建的内容。
2. 可选一个已有本地工作目录；留空则使用工作台默认源码目录。
3. 可选 DeepSeek 模型和推理等级。
4. 点击右下角箭头创建并开始。项目名称会根据工作目录或任务首行自动生成。

进入项目后，先在对话框左上选择工作文件夹，再点击左下角“＋”或相机按钮添加附件；附件会随下一条消息上传给 GPT。文件拖拽到输入框不会被工作台拦截。

之后流程自动运行：

```text
用户目标 → GPT 规划 → DeepSeek 执行 → 生成分析 → GPT 审查
                       ↑                    ↓
                       └── 继续 / 重规划 ───┘
```

## 主要能力

- 多项目断点恢复：状态写入每个项目的 `.gpt_workspace/project_state.json`。
- 会话隔离：每个项目有独立 GPT 会话；共享的浏览器页面按完整“发送—等待回复”周期串行使用。
- 执行会话复用：同一项目复用一个 DeepSeek Harness 会话，只在首个任务打开执行窗口；失效时自动重建。
- 精简派发：执行者角色、通信协议和结果格式由项目内 `workbench-executor` Skill 承担；后续任务只通知执行者重新读取当前信封，不重复发送整份计划和格式说明。
- 档位自适应规划：GPT 会收到项目选择的 DeepSeek 模型与推理等级；Pro + High/Max 使用较粗任务，Flash + Off/Low 使用包含步骤与验证的小任务。
- 成本可观测：每项 DeepSeek 任务前后读取 Harness 的真实 token 与上下文投影；GPT 网页端只记录字符数和明确标记的 token 估算值。Dashboard 展示逐任务模型、推理等级、耗时、重试、token 与上下文占用。
- 上下文控制：上下文达到窗口 70% 时自动生成 `executor_context.md` 并换用摘要化新会话；投影不可用时以同会话完成 20 项任务为后备阈值，也可点击“压缩会话”手动触发。
- 安全切换模型：运行中切换不会打断当前任务；任务结束后 GPT 只重写未完成任务，再以新模型创建摘要化会话。空闲时立即增量重规划。
- 暂停、结束与删除：暂停可恢复；手动结束会进入 `CANCELED` 并保留记录；删除会移除工作区。迟到结果不会覆盖终止状态。
- GPT 附件：在 GPT 对话框点击左下角“＋”或相机按钮；文件先保存到项目 `.gpt_workspace/attachments/`，发送时再通过 ChatGPT 浏览器 composer 上传给 GPT。
- 计划依赖：只有依赖已完成的任务才会执行；循环或缺失依赖会交回 GPT 重规划。
- 项目管理：按源码工作目录分组、重命名、归档、修改源码目录、选择模型。

## 数据目录

```text
双agent工作台/
├── controller/                 编排器、GPT 桥、DeepSeek Runner、HTTP 服务
├── web/                        原生 HTML/CSS/JavaScript 界面
├── config/config.json          本地配置
├── test/                       回归与界面测试
├── projects/<项目>/
│   ├── source/                 默认源码目录
│   └── .gpt_workspace/
│       ├── project_state.json  可恢复状态
│       ├── project_plan.md     当前计划
│       ├── project_analysis.md 项目分析
│       ├── executor_context.md 压缩后供新执行会话恢复的摘要
│       ├── attachments/        上传附件
│       ├── conversation/gpt/   GPT 消息记录
│       ├── executor_reports/  执行报告
│       ├── inbox/              发给执行者的任务信封
│       └── outbox/             执行者返回的结果信封
├── browser-profile/            专用 Chrome 登录态（不要提交或共享）
└── logs/                       工作台日志
```

指定外部源码目录时，`.gpt_workspace/` 仍保存在工作台的项目目录内；DeepSeek 只把源码目录作为工作目录。

工作台会把 `workbench-executor` 安装到源码目录的 `.dsh/skills/`，但只有工作台派发提示和信封同时带有专属标记时才生效；用户直接调用 DeepSeek 时不会进入工作台协议。

## 常用配置

编辑 `config/config.json`：

| 配置 | 用途 |
|---|---|
| `dashboard.host` / `port` | Dashboard 地址，默认 `127.0.0.1:3700` |
| `gpt.mode` | `real` 或 `mock` |
| `gpt.modelName` / `modelMatch` | 目标 ChatGPT 模型及匹配规则 |
| `gpt.replyTimeoutMs` | GPT 回复超时 |
| `deepseek.mode` | `real` 或 `mock` |
| `deepseek.visible` | 是否打开可见执行窗口 |
| `deepseek.modelProvider` / `model` | 默认 DeepSeek 模型 |
| `deepseek.reasoningEffort` | 默认推理等级 |
| `deepseek.executorTimeoutMs` | 单次执行超时 |
| `deepseek.contextCompactThreshold` | 自动压缩阈值，默认 `0.7` |
| `deepseek.contextCompactFallbackTasks` | 无上下文投影时的同会话完成任务阈值，默认 `20` |

项目级模型选择优先于全局默认值。

## 测试

```powershell
npm test                         # 核心、协议、GPT Mock、中文路径
node test\verify-task009.mjs    # 独立启动静态服务的综合 UI 回归
node controller\index.mjs --gpt=mock --executor=mock --selftest
```

真实 DeepSeek 环境验证会消耗模型资源，仅在需要时运行：

```powershell
npm run test:runner
node controller\visible_probe.mjs
```

## 安全与边界

- 不需要 GPT API Key，也不会绕过登录或验证码。
- Dashboard 默认仅监听本机；写入接口会拒绝来自非本机 Dashboard Origin 的浏览器请求。
- 删除项目会删除该项目在 `projects/` 下的工作区和默认源码目录，不可恢复。外部指定的源码目录不位于项目目录内，不随项目删除。
- 附件上限为 50MB，文件名会清理后再落盘。

## 故障排查

- 页面提示“工作台后台未运行”：重新运行 `start.bat`。浏览器页面可以继续保留，后台恢复后项目列表会自动重新加载。
- 点击删除时出现网络错误并不表示项目已经删除；应先恢复后台，再从项目列表确认状态。
- 启动窗口出现乱码或“文件名、目录名或卷标语法不正确”：确认使用项目根目录中的最新版 `start.bat`，不要用旧副本启动。

## 维护约定

项目完整分阶段路线图见 [docs/双-Agent-工作台完整演进路线图.md](docs/双-Agent-工作台完整演进路线图.md)。项目变更索引见 [CHANGELOG.md](CHANGELOG.md)，各次更新的独立记录保存在 [`changelog/`](changelog/) 中，文件名统一为 `YYYY-MM-DD-vX.Y.Z.md`。任何接手本项目的 Agent 或开发者，只要修改代码、配置、界面或文档，都必须新建日志文件并更新索引；详细规则见 [AGENTS.md](AGENTS.md)。
