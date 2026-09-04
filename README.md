# 双 Agent 协作工作台

一个本地运行的自动协作工作台：ChatGPT 负责规划与决策，DeepSeek Harness 负责读取项目、改代码和运行测试，本地编排器负责在两者之间传递结果并持久化进度。

安装、启动和测试统一由仓库根目录的 `package.json`、`start.bat` 与本文维护；应用目录不再保留重复副本。下文未注明仓库根目录的运行数据与配置路径，均相对于 `双agent工作台/`。

## 快速开始

支持 **Windows 10/11 桌面环境**。不同用户名、系统盘、项目盘符、中文和空格路径均不需要修改源码。本次不提供 macOS/Linux 支持。

1. 安装 **Node.js 22+（建议 LTS）**，勾选加入 PATH；安装后重新打开终端。使用 Git 拉取时保留整个仓库目录。
2. 在仓库根目录（README.md、package.json 和“双agent工作台”文件夹所在目录）执行：

```powershell
npm ci
npm run demo
```

打开 <http://127.0.0.1:3700> 即可体验模拟规划和执行，不需要账号或 DeepSeek。Mock 只验证工作流，不会由模型实现任意需求。结束后台后再启动真实模式。

真实运行还需要：

- 安装 Chrome 或 Edge；程序自动发现常见系统级/用户级安装位置以及 PATH 中的浏览器。
- 安装并配置 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。本项目对接并验证的版本为 **0.1.1-rc.2**，建议先使用此版本：

```powershell
npm install -g @deepseek-ai/dsh@0.1.1-rc.2
dsh web
```

在 Harness 网页中配置自己的模型服务和凭据，确认能正常使用后，再执行：

```powershell
npm run doctor
npm start
```

`doctor` 检查 Node、浏览器、执行器位置、配置和端口，不登录、不发送任务、不验证账号额度。Harness 的安装与模型调用需要网络；真实 ChatGPT 操作需要可访问 ChatGPT 的网络和自己的账号。

也可以双击仓库根目录的 `start.bat`：依赖缺失时安装锁定依赖，服务就绪后打开实际配置的地址。`start.bat` 文本保持 ASCII，避免 cmd 误解析中文；项目目录和界面支持中文。PowerShell 启动器可在应用目录执行 `.\start.ps1 --port=3800`，命令行启动可使用 `npm start -- --port=3800 --open`。如果 PowerShell 禁止运行 npm.ps1，可直接使用 `npm.cmd` 或在命令提示符中运行。

含空格的参数应整体加引号，例如 `start.bat "--data-dir=D:\我的项目\工作台数据" --port=3800`。批处理与 PowerShell 共用一份启动逻辑；多个 Node 安装并存时使用 PATH 中的第一个。程序按项目数据的真实目录取得系统级单实例锁，目录大小写、目录联接或不同日志位置不会绕过保护，进程退出后自动释放。

首次执行项目或主动打开 GPT 时，在工作台专用 Chrome 窗口中登录 ChatGPT；登录态保存在本机 `browser-profile/`。

启动器在本地服务就绪后立即打开界面，不再固定等待四秒。空闲启动只打开工作台，不预热或唤起 GPT；查看项目列表、记录和状态不需要启动 GPT 浏览器。创建并开始项目、发送消息或主动打开 GPT 时按需连接。已有未完成且未暂停的项目仍会自动恢复，恢复流程需要 GPT 时会启动浏览器。GPT 规划期间预热项目的 DeepSeek 服务，后续任务复用服务和会话。模型目录在首次操作模型下拉框时加载，不阻塞首页；已保存模型会立即显示。

GPT 浏览器采用无启动窗口模式，连接后复用已有 ChatGPT 页面或打开一个工作页。项目启动和重连共用连接；启动失败后有 60 秒防重复唤起保护。已移除 `about:blank` 启动首页及会强制恢复历史窗口的 `--restore-last-session=false` 参数（Chrome 按开关是否存在判断，详见 [Chromium 源码](https://chromium.googlesource.com/chromium/src/+/lkgr/chrome/browser/ui/startup/startup_browser_creator.cc)）。只在确认属于工作台专用 Profile 后清理无内容的空白页，保留其他网页及有内容的空白页。

在左上角点击“新建项目”，右侧主区域会显示创建区：

1. 描述你想构建的内容。
2. 可选一个已有本地工作目录；留空则使用工作台默认源码目录。
3. 可选 DeepSeek 模型和推理等级。
4. 点击“创建并开始”。项目名称会根据工作目录或任务首行自动生成。

进入项目后，先在对话框左上选择工作文件夹，再点击左下角“＋”或相机按钮添加附件；附件会随下一条消息上传给 GPT。文件拖拽到输入框不会被工作台拦截。

切换已有项目的源码目录前先暂停项目。切换后会清除旧目录的检查点和执行会话；检查点只能恢复到创建时对应的实际目录。各项目分别保留输入草稿和待发送附件，切换项目不会把尚未完成的目录选择、文件读取或发送结果写入另一个项目。

追加消息会保存到项目队列，在当前执行步骤或 GPT 回合结束后的安全时机发送；暂停期间只保存，点击继续后再发送。手动结束会撤销此前尚未发送的队列；对已完成或已取消项目主动发送新消息，会继续该项目的对话。工作台关闭时先停止派发并清理验证、命令行子进程；如无法确认进程停止，会保留项目锁并提示重试退出。

之后流程自动运行：

```text
用户目标 → GPT 规划 → DeepSeek 执行 → 生成分析 → GPT 审查
                       ↑                    ↓
                       └── 继续 / 重规划 ───┘
```

## 主要能力

- 多项目断点恢复：状态写入每个项目的 `.gpt_workspace/project_state.json`；旧项目读取时惰性补齐新字段。
- 会话隔离：每个项目有独立 GPT 会话；共享的浏览器页面按完整“发送—等待回复”周期串行使用。
- GPT 内置规范：新会话将固定规则与当前指挥档打包成 Markdown 附件，正文只发送任务与简短提醒；同会话不重复上传。规则或档位变化后下一条消息自动补发，重启沿用已发送记录。
- 可靠派发：v3 信封用唯一 `dispatch_id` 关联任务和结果；半写、重复、过期、未知类型或 ID 不匹配的 outbox 会被拒绝。
- 会话接管：同一项目复用一个 DeepSeek Harness 会话；工作台重启后优先接管原服务和会话，只等待原派发结果，不重复执行任务。
- 隔离 Skill：`workbench-executor` 只安装到工作台专用 Harness Profile，不写入用户源码目录；后续任务仅通知执行者重新读取当前信封。
- 任务验证：计划任务可声明 `kind`、`validation`、`timeout` 和 `max_attempts`；依赖满足后执行，成功结果还需通过确定性验证。
- 检查点回滚：修改源码前保存任务级检查点；失败、超时、执行服务崩溃、非法结果或验证失败时先恢复再重试，恢复失败则停止在 `ERROR`。
- 按能力调整指挥深度：弱模型/低推理档由 GPT 先确定方案、拆小任务、写明动作与预期，再逐项检查并纠错；强模型/高推理档接收目标、范围和验收，自主设计与实现。系统按档位检查指令完整性，不限制文件、步骤或任务数量。
- 成本可观测：每项 DeepSeek 任务前后读取 Harness 的真实 token 与上下文投影；GPT 网页端只记录字符数和明确标记的 token 估算值。Dashboard 展示逐任务模型、推理等级、耗时、重试、token 与上下文占用。
- 上下文控制：上下文达到窗口 70% 时自动生成 `executor_context.md` 并换用摘要化新会话；投影不可用时以同会话完成 20 项任务为后备阈值，也可点击“压缩会话”手动触发。
- 安全切换模型：运行中切换不会打断当前任务；任务结束后 GPT 只重写未完成任务，再以新模型创建摘要化会话。空闲时立即增量重规划。
- 暂停、结束与删除：暂停可恢复；手动结束会进入 `CANCELED` 并保留记录；删除会移除工作区。迟到结果不会覆盖终止状态。
- GPT 附件：在 GPT 对话框点击左下角“＋”或相机按钮；文件先保存到项目 `.gpt_workspace/attachments/`，发送时再通过 ChatGPT 浏览器 composer 上传给 GPT。
- 计划依赖：只有依赖已完成的任务才会执行；循环或缺失依赖会交回 GPT 重规划。
- 项目管理：紧凑项目列表支持重命名、归档、删除和修改源码目录；概览集中显示进度、Token、上下文、执行记录和检查点。
- 最小执行器扩展：DeepSeek Harness 为默认实现；可选通用命令行执行器使用同一 v3 文件协议，不包含插件注册或工作流平台。
- 审计导出：直接汇总现有计划、任务状态、验证、用量、执行与恢复记录为 Markdown。

## 数据目录

```text
双agent工作台/
├── controller/                 编排器、GPT 桥、DeepSeek Runner、HTTP 服务
├── docs/gpt-workbench-rules.md GPT 固定角色、通信协议和规划规范
├── skills/workbench-executor/ DeepSeek 执行规范的随程序原本
├── web/                        原生 HTML/CSS/JavaScript 界面
├── config/config.json          随版本发布的默认配置
├── config/config.local.json    本机覆盖配置（可选，不提交）
├── test/                       回归与界面测试
├── projects/<项目>/
│   ├── source/                 默认源码目录
│   └── .gpt_workspace/
│       ├── project_state.json  可恢复状态
│       ├── project_plan.md     当前计划
│       ├── project_analysis.md 项目分析
│       ├── executor_context.md 压缩后供新执行会话恢复的摘要
│       ├── checkpoints/        当前任务的临时源码检查点
│       ├── audit-export.md     最近一次审计导出
│       ├── attachments/        上传附件
│       ├── instructions/       已发给 GPT 的规范快照（含当时指挥档，按内容版本保留）
│       ├── conversation/gpt/   GPT 消息记录
│       ├── executor_reports/  执行报告
│       ├── inbox/              发给执行者的任务信封
│       └── outbox/             执行者返回的结果信封
├── browser-profile/            专用 Chrome 登录态（不要提交或共享）
└── logs/                       工作台日志
```

指定外部源码目录时，`.gpt_workspace/` 仍保存在工作台的项目目录内；DeepSeek 只把源码目录作为工作目录。

Harness 工作区分组：工作台通过官方 `workspace.create({path})` 注册或复用实际源码目录，并通过 `session.create({workspaceId})` 新建/压缩会话。默认 `source` 目录的工作区使用项目名；已有工作区的自定义名称保持不变。复用与重启接管时，旧的未分组会话会以原 ID 补关联，保留历史。父目录不是归属依据：会话工作目录必须与工作区路径完全一致。注册失败会明确报错，不静默降级为未分组会话。

工作台会把 `workbench-executor` 安装到独立 Harness Profile 的 `skills/` 下，并仅向工作台启动的 Harness 进程提供该目录。用户源码目录不会新增 `.dsh/skills/`，普通 DeepSeek 会话不会加载工作台协议。

### GPT 与 DeepSeek 如何读取规范

GPT 的固定规范只维护在 [`docs/gpt-workbench-rules.md`](双agent工作台/docs/gpt-workbench-rules.md)。系统按程序文件的位置读取它，再与 `planning_policy.mjs` 生成的当前档位规则合成附件，保存至项目 `.gpt_workspace/instructions/`。创建项目的首条消息会将该文件与用户附件一起上传给 ChatGPT，并要求先读规范、直接处理任务；不需要用户手动粘贴或等待单独确认。网页 GPT 无法通过一条本机路径读取文件，所以必须真正上传。

规范使用内容摘要标记版本，发送成功后才记录到 `gpt.instructions`。同项目同会话后续只带当前模型、档位和协议提醒；重新打开浏览器或重启工作台不重复发送。新会话、旧项目尚无规范记录，或规范/有效模型档位改变时，下一次发送会附上当前版本。上传失败会报错，不会把该版本记成已发送；已有计划、任务检查与结果验证继续生效。

文件形式不会让模型免费记住规则。这里减少的是重复注入：首轮仍需要读取规范，后续不再反复附上全文和长篇指挥规则。GPT 用量仍是粗略估算，已把内置规范附件的字符数计入发送字符与输入 token 估算；用户的其他附件及网页端实际检索、历史上下文开销不在该估算内，不能据此推算真实上下文占用。

DeepSeek 的固定规范位于 [`skills/workbench-executor/SKILL.md`](双agent工作台/skills/workbench-executor/SKILL.md)。工作台把它复制到 `%USERPROFILE%/.dsh/profiles/workbench-exec/skills/workbench-executor/`（设置 `DSH_HOME` 或 `deepseek.uiProfile` 后相应调整），并通过 `DSH_BUNDLED_SKILL_DIR` 给工作台启动的服务和 headless 执行进程。新执行会话首先用 Skill 工具加载规范，后续通过绝对路径读取任务信封。

因此，无论源码位于默认 `projects/<项目>/source`，还是另一磁盘或任意外部目录，由工作台管理的 DeepSeek 会话都能加载同一规范，不需要将规范复制到每个项目。直接在外部目录自行启动的普通 DeepSeek 会话不会自动应用工作台协议；把一个 Markdown 文件放在磁盘上本身也不会让模型自动读取。本项目根目录的 `AGENTS.md` 是维护工作台代码的约定，与上述执行协议用途不同，不应将它当作其他项目自动继承的全局规则。

## 任务字段与结果协议

GPT 在 `<PLAN>` / `<UPDATED_PLAN>` 中返回 JSON 对象，使用 `tasks` 数组。所有档位共用的最小任务契约：

| 字段 | 要求 |
|---|---|
| `id` / `description` / `kind` | 唯一 TASK 编号、一个可独立验收目标、coding/test/analysis/docs |
| `scope` | 功能范围，以及必须保持的接口、行为或其他边界 |
| `outputs` | 可检查的交付物数组，不限制数量 |
| `dependencies` | 前置任务 ID 数组，无依赖用 `[]`；不能循环或引用缺失任务 |
| `acceptance_check` | 可观察的成功标准，必填；自然语言不会作为命令执行 |

可选 `validation_command`（可重复执行的检查命令）、`timeout`（秒）、`max_attempts`（总执行次数）。项目级 `acceptance_criteria` 为必填的最终验收标准数组。

`controller/planning_policy.mjs` 的 v2 规则控制 GPT 的指挥深度与 DeepSeek 的自主空间：

| 模型 | off | low | high | max |
|---|---|---|---|---|
| V4 Flash / Flash Vision Exp | 逐步指挥 | 详细指导 | 关键点指导 | 模块委托 |
| V4 Pro | 详细指导 | 关键点指导 | 模块委托 | 目标委托 |

默认或未知模型/档位使用“逐步指挥”，由 GPT 承担更多工作。项目选择和全局默认逐字段合并，规划与执行使用同一解析规则。该映射是工作台的协作策略，不是模型能力的实测评级。

| 指挥方式 | GPT 必须准备什么 | DeepSeek 的自主空间 |
|---|---|---|
| 逐步指挥 | 已确定方案、输入/接口、具体文件、实现说明或伪代码、每步动作和预期、边界情况、验证实例、失败处理 | 执行已明确的小任务；前提不成立或需另选方案时交回 GPT |
| 详细指导 | 明确方案、输入、文件、操作步骤、边界与验证；不强制每步都写预期 | 自行完成局部语法与常规实现细节 |
| 关键点指导 | 目标、范围、关键方案/接口和验证实例 | 自行定位文件、展开步骤、实现与调试 |
| 模块委托 | 模块目标、接口边界、交付物及验收 | 自主选择算法、组织文件和设计测试 |
| 目标委托 | 目标、背景、硬约束、依赖、交付物与验收 | 自主分析、设计、内部拆分、实现和改进 |

逐步指挥/详细指导额外必填 `files`、`inputs`、`implementation_notes`、`steps`、`edge_cases`、`verification`、`failure_handling`、`open_decisions: []`。其中逐步指挥的 `steps` 使用 `{ "action": "具体操作", "expected_result": "该步预期" }` 对象数组；详细指导也允许字符串步骤。两者的 `verification` 均用相同的动作/预期结构。关键点指导只额外要求 `implementation_notes` 与 `verification`。模块/目标委托不强制这些实现细节，也不会从升档前的旧任务继承已省略的步骤。

例如，Flash Off 的一个子任务可以明确为：“在 normalize 的空数组分支返回 []，保持函数签名及其他分支；给出修改位置、伪代码、空数组测试和预期输出”。Pro Max 则可接收：“完成输入规范化模块，兼容现有接口，覆盖正常、空和非法输入，交付实现与验证证据”，自行展开内部方案。

不设文件数、步骤数、交付物数或任务总数上限。弱档任务按已明确的子问题拆分，必要说明可以写得充分；强档可以覆盖完整模块。GPT 需要基于真实项目证据给方案，未知前提先请求分析，不能用模糊长文或删除难需求来凑合通过。

处理顺序：GPT 提交计划 → 按当前档位校验指令完整性、ID 与依赖图 → 不合格最多要求修正两次（`orchestrator.protocolReprompts`）→ 合格后派发。逐步/详细/关键点指导每项完成后发送 `TASK_REVIEW`，GPT 对比指令、执行报告和验证证据，确认后才派发下一项；需要纠正则追加修正任务。检查状态会持久化，暂停或恢复不会越过检查。最后仍生成项目分析并进行整体验收。

逐步/详细指导失败时，先恢复检查点，将原指令、错误和可用报告交回 GPT，要求改方案、补指导或继续拆小；不原样自动重试，也不能用 CONTINUE/DONE 跳过修订。其他档位允许执行者按 `max_attempts` 自主重试。模块/目标委托不插入每项 GPT 检查，由执行者自行迭代，GPT 在最终审查或重大问题时介入。

`planning_check` 保存规则版本与校验结果，`pending_task_review` / `task_reviews` 保存检查进度并进入审计导出。旧计划仍可读取，已完成记录保留；未完成任务下一次执行前按新规则检查。降档后需补足指导，选模失败不会静默使用其他模型，不能通过 headless 回退绕过规则。

目标是用 GPT 的设计、监督与纠错提高弱档位下整个系统的任务完成能力；这会增加 GPT 往返和耗时。结构校验不能证明方案正确，也没有实测保证 Flash Off 等同 Pro Max。真实效果需用相同任务、相同验收标准对比成功率、返工次数、时间与成本。

执行者必须回传 schema 3 的 `project_id`、`task_id`、`dispatch_id` 和 `created_at`，并通过临时文件原子重命名为 `.gpt_workspace/outbox/message.json`。

旧 `validation` 字段继续兼容：明确以 node/npm/python 等运行器开头的单行命令才在本地执行，其余内容作为验收描述，不再当成 shell 命令。实现与相关测试可同属一项任务，指令深度按当前档位调整。

结果时间必须用 `new Date().toISOString()` 或 `[DateTime]::UtcNow.ToString('o')` 生成 UTC；不能给北京时间追加 `Z`。如果结果身份均匹配、只有时间无效，DeepSeek 最多进行一次“只重发结果”的修复，不立即回滚源码；其他协议校验仍保留。已完成派发的迟到重复结果不会触发下一任务回滚。检查点异步复制并排除依赖与构建物；以工作台目录为源码时还排除其 `browser-profile/`、项目存储目录和 `logs/`，普通源码中的同名目录仍正常备份。

## 换电脑与移动目录

新用户拉取源码后安装依赖、配置自己的账号即可。`node_modules/`、`projects/`、`logs/`、`browser-profile/` 和本机配置均不纳入 Git；所需目录会在运行时创建。

整套数据要搬迁时，先结束工作台与它管理的执行服务，再自行复制项目数据。默认 `source/` 会随项目迁移；外部源码目录若已失效，工作台会提示重新选择，阻止任务在错误目录执行。浏览器登录态受 Windows 用户加密保护，换电脑后请重新登录，不要复制他人的登录态。Windows 开机自启注册需在新位置重新运行 `register-autostart.ps1`。

本次只取消当前版本对运行数据的跟踪，旧 Git 历史仍可能包含先前误提交的个人数据；对外公开完整历史前需另行清理历史。

## 常用配置

默认配置在 `config/config.json`。个人设置写入 `config/config.local.json`，只填需要覆盖的字段；可以复制 `config/config.local.example.json` 后编辑。更新仓库不会覆盖这个本机文件。

优先级：命令行参数 > 环境变量 > `--config=文件` / `WORKBENCH_CONFIG` 指定的覆盖文件 > 本机配置 > 默认配置。对象逐字段合并，数组整体替换。所有相对配置路径以应用目录（`双agent工作台/`）为基准，与打开终端的目录无关。

`DSH_BIN` 可指定 Harness 的 `lib/bin.js`，`CHROME_PATH` 可指定浏览器 exe；通常留空即可自动寻找。`WORKBENCH_PORT` 可改端口。`WORKBENCH_DATA_DIR` 或 `--data-dir=目录` 可统一指定 projects、logs、browser-profile 的存放目录；`projectsRoot` / `--projects=目录` 可单独指定项目存放位置。选择外部源码时仍由用户通过界面选择绝对路径。

默认不锁定特定 ChatGPT 订阅模型，使用网页当前模型；如要指定，配置 `gpt.modelName` 和 `gpt.modelMatch`。DeepSeek 模型和凭据从用户自己的 Harness 配置读取，不随仓库分发。

| 配置 | 用途 |
|---|---|
| `gpt.chromePath` / `deepseek.uiChromePath` | 浏览器位置，留空自动寻找 Chrome/Edge |
| `deepseek.dshBin` | Harness JS 入口，留空自动寻找本地/npm 全局安装 |
| `deepseek.nodeBin` | Node 路径，留空复用启动工作台的 Node |
| `dataDir` / `projectsRoot` | 数据根目录 / 项目存放目录，可为相对路径 |
| `dashboard.host` / `port` | Dashboard 地址，默认 `127.0.0.1:3700` |
| `gpt.mode` | `real` 或 `mock` |
| `gpt.modelName` / `modelMatch` | 目标 ChatGPT 模型及匹配规则 |
| `gpt.replyTimeoutMs` | GPT 回复超时 |
| `gpt.replyPollMs` / `replyStableMs` | 回复检测间隔 / 停止生成后的文本稳定窗口，默认 `300` / `500` 毫秒 |
| `gpt.loginPollMs` | 登录检查间隔，默认 `1000` 毫秒 |
| `deepseek.mode` | `real` 或 `mock` |
| `deepseek.visible` | 是否打开可见执行窗口 |
| `deepseek.modelProvider` / `model` | 默认 DeepSeek 模型 |
| `deepseek.reasoningEffort` | 默认推理等级 |
| `deepseek.executorTimeoutMs` | 单次执行超时 |
| `deepseek.outboxPollMs` | 目录事件即时收包的后备检查间隔，默认 `150` 毫秒；健康探测不阻塞收包 |
| `orchestrator.stepIntervalMs` | 状态未变化时退避，默认 `100` 毫秒；状态推进后立即继续 |
| `deepseek.contextCompactThreshold` | 自动压缩阈值，默认 `0.7` |
| `deepseek.contextCompactFallbackTasks` | 无上下文投影时的同会话完成任务阈值，默认 `20` |
| `executors.cli.command` | 通用命令行执行器命令；留空时 Dashboard 禁止选择 |
| `executors.cli.timeoutMs` | 通用命令行执行器默认超时 |

项目级模型选择优先于全局默认值。

端口必须在 1–65535 范围内，真实模式下 GPT 调试端口不得与 Dashboard 相同；毫秒时长须为有效正整数。非法配置会在启动进程前报错。

### 通用命令行执行器

命令在项目源码目录运行，并收到两个环境变量：`WORKBENCH_TASK_FILE` 指向 v3 inbox 信封，`WORKBENCH_DISPATCH_ID` 是当前派发 ID。命令应按与 DeepSeek 相同的规则原子写入 outbox。配置完成后，可在项目“概览”中切换；任务执行中禁止切换。

## 测试

在仓库根目录执行：

```powershell
npm test                 # 核心、取消/路径/启动、协议、目录与可移植性回归
npm run test:ui          # Dashboard 功能、布局及异步交互回归，需要浏览器
npm run test:performance # 隔离 DOM 的浏览器桥测试，不使用账号
npm run selftest         # 临时目录中的模拟闭环，结束后清理
```

仓库提供 Windows Node.js 22/24 的 CI 工作流，在推送或提交拉取请求后运行。主测试在无浏览器时明确跳过浏览器集成部分，`test:ui` 则要求安装浏览器。测试使用临时数据目录与独立浏览器，截图写入系统临时目录并在输出中给出位置，可用 `UI_SCREENSHOT_DIR` 指定；测试不连接正在使用的 3700 端口。旧任务编号的重复 UI 探针已合并到维护中的两套 UI 回归。

真实 DeepSeek 环境验证会消耗模型资源，仅在需要时运行：

```powershell
npm run test:runner                       # 真实 headless 执行
npm run test:runner -- --visible          # 真实会话池执行
npm run test:runner -- --visible --open-window # 同时打开执行窗口
```

## 安全与边界

- 不需要 GPT API Key，也不会绕过登录或验证码。
- 本地优化不改变模型推理速度、网络延迟或服务端拥堵；网页无法确认目标模型时会明确记录沿用默认模型。
- Dashboard 默认仅监听本机；写入接口会拒绝来自非本机 Dashboard Origin 的浏览器请求。
- 删除项目会删除该项目在 `projects/` 下的工作区和默认源码目录，不可恢复。外部指定的源码目录不位于项目目录内，不随项目删除。
- 附件上限为 50MB，文件名会清理后再落盘。

## 故障排查

- 页面提示“工作台后台未运行”：重新运行 `start.bat`。浏览器页面可以继续保留，后台恢复后项目列表会自动重新加载。
- 点击删除时出现网络错误并不表示项目已经删除；应先恢复后台，再从项目列表确认状态。
- 启动窗口出现乱码或“文件名、目录名或卷标语法不正确”：确认使用项目根目录中的最新版 `start.bat`，不要用旧副本启动。

## 维护约定

项目完整分阶段路线图见 [docs/双-Agent-工作台完整演进路线图.md](双agent工作台/docs/双-Agent-工作台完整演进路线图.md)。项目变更索引见 [CHANGELOG.md](双agent工作台/CHANGELOG.md)，各次更新的独立记录保存在 [`changelog/`](双agent工作台/changelog/) 中，文件名统一为 `YYYY-MM-DD-vX.Y.Z.md`。任何接手本项目的 Agent 或开发者，只要修改代码、配置、界面或文档，都必须新建日志文件并更新索引；详细规则见 [AGENTS.md](双agent工作台/AGENTS.md)。
