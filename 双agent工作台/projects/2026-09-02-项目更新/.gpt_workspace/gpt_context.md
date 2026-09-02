# 项目上下文：项目更新

更新时间：2026-09-01T16:22:05.863Z

用户任务：
解决以下问题：1、当前发给deepseek的字太多了，应该将对deepseek harness的角色要求、格式要求等内容写成一个底层skill，每次从双agent工作台调用DeepSeek时直接让他自己启动并识别遵守这个skill（注意这个skill仅仅是从双agent工作台调用deepseek才会启用，如果用户直接调用DeepSeek则不启用这个skill）
2、每次在同一个项目里运行新task时都会重新拉起一个harness的窗口，不需要这样，只用在执行第一个task时拉起一个窗口就行了
3、优化一下给DeepSeek发任务的文字逻辑：每次新项目开始时都会将所有任务给depsk发一遍，然后执行分任务时又会将分任务再给DeepSeek同样发一遍，并且每个分任务末尾都加上了格式要求，这对token的消耗太大了，优化一下这里的逻辑。

当前计划：

status: READY
project_name: 双 Agent 协作工作台——DeepSeek Harness 调度与通信优化
objective: 重构双 Agent 工作台调用 DeepSeek Harness 的机制，将稳定的角色/通信协议下沉为仅在工作台调用场景生效的底层 Skill，复用同一个 Harness 会话执行同一项目的多个 Task，并精简项目初始化与 Task 调度消息，显著降低 Token 消耗，同时保持现有双 Agent 协作逻辑和任务可靠性。

goals:

将 DeepSeek Harness 的角色定义、通信协议、执行边界、状态回传规则等稳定内容从每次任务 Prompt 中移除，改为工作台专用底层 Skill。

确保该 Skill 仅由双 Agent 工作台启动/调用 Harness 时注入或启用，DeepSeek 用户直接使用时不受影响。

同一项目执行多个 Task 时复用首个 Task 已启动的 Harness 窗口/进程/会话，不再每个 Task 重复创建窗口。

重构任务消息生命周期：项目初始化只发送必要的项目级上下文；执行具体 Task 时只发送当前 Task 所需信息，不重复发送完整任务列表、角色协议和格式要求。

保留必要的上下文传递、Task 状态管理、失败重试、重新规划和最终审查能力。

在不改变现有用户体验和核心工作流的前提下，降低 DeepSeek API Token 消耗并提高连续 Task 执行效率。

tasks:

id: TASK-001
description: 全量分析当前双 Agent 工作台的项目结构、DeepSeek Harness 启动流程、Prompt 构造逻辑、Task 调度逻辑、窗口/进程生命周期管理、状态通信机制，以及现有 Skill/配置加载机制，明确需要修改的代码位置和当前行为。
priority: high
dependencies:

id: TASK-002
description: 设计并实现工作台专用 DeepSeek Harness 底层 Skill。将稳定的角色要求、职责边界、通信协议、消息格式、状态含义、工作台调用上下文识别规则等集中到 Skill 中；设计可靠的“仅工作台调用时启用”机制，避免污染 DeepSeek 的普通直接调用环境。
priority: high
dependencies:

TASK-001

id: TASK-003
description: 重构 DeepSeek Harness 启动与生命周期管理。实现同一项目首次执行 Task 时启动一个 Harness 会话，后续 Task 复用该会话；增加项目级会话状态、进程/窗口存活检测和异常退出后的自动恢复机制；确保切换到新项目时按需创建新会话。
priority: high
dependencies:

TASK-001

id: TASK-004
description: 重构项目初始化消息生成逻辑。区分“项目级初始化上下文”和“Task 执行指令”，项目启动时不再把所有完整任务内容重复发送给 DeepSeek；仅发送执行所需的最小项目上下文、项目状态及 Skill 启用标识/入口信息。
priority: high
dependencies:

TASK-002

TASK-003

id: TASK-005
description: 重构 Task 消息生成与发送逻辑。执行具体 Task 时只发送当前 Task ID、目标、依赖、验收标准、必要上下文和当前项目状态摘要；删除每个 Task 末尾重复追加的角色要求、通信格式、完整计划等固定文本，并依赖底层 Skill 处理稳定协议。
priority: high
dependencies:

TASK-002

TASK-004

id: TASK-006
description: 建立项目级上下文缓存/引用机制。对于已经发送且在当前 Harness 会话中有效的信息，后续 Task 使用简短引用或增量更新，不重复传输；对于 Task 执行结果、ANALYSIS、QUERY、REPLAN 等动态信息，只传递相对于上一状态真正发生变化的内容。
priority: medium
dependencies:

TASK-003

TASK-005

id: TASK-007
description: 完成端到端验证。验证新项目首个 Task 会启动一个 Harness；同项目后续 Task 不创建新窗口并能够连续执行；新项目能够正确创建新的 Harness 会话；Skill 能正确约束工作台调用的 DeepSeek；普通 DeepSeek 调用不会误启用该 Skill；Prompt 中不再重复出现角色/格式要求及完整任务列表；状态回传、失败重试、REPLAN 和最终审查流程正常。
priority: high
dependencies:

TASK-006

id: TASK-008
description: 对比重构前后的实际发送消息与 Token 消耗，检查是否存在遗漏的必要上下文、上下文过度缓存、会话串项目、协议失效等问题；根据测试结果进行最后的最小增量修正并形成最终验收结果。
priority: medium
dependencies:

TASK-007

acceptance_criteria:

DeepSeek Harness 的稳定角色要求和通信协议不再需要在每次 Task Prompt 中重复发送。

存在明确且可验证的工作台专用 Skill/机制，并且只有双 Agent 工作台调用 Harness 时才启用。

用户直接调用 DeepSeek 时不会因为该工作台 Skill 而改变其默认行为。

同一项目执行 TASK-001、TASK-002 等多个 Task 时，只在第一个 Task 启动 Harness，后续 Task 复用同一 Harness 会话/窗口。

新项目启动时不会错误复用旧项目 Harness 上下文。

单个 Task 消息不再重复携带完整项目任务列表、固定角色说明和固定通信格式。

Task 消息保留完成当前任务所必需的信息，包括 Task ID、任务目标、依赖、验收标准以及必要的增量上下文。

项目状态发生变化时优先传递增量信息，而不是重复发送完整历史。

ANALYSIS、QUERY、REPLAN、CONTINUE、DONE 等现有双 Agent 协作协议仍然能够正常工作。

Harness 异常退出时能够被检测，并在需要时重新建立会话，而不是无限等待或错误复用失效窗口。

端到端测试通过，且重构后实际 Prompt/Token 消耗相较当前实现有明显下降。

constraints:

不改变 GPT-5.6 Sol 作为规划/审查大脑、DeepSeek Harness 作为执行者的核心架构。

不删除现有状态机、任务依赖和增量 REPLAN 语义，只优化通信和执行生命周期。

不把用户直接调用 DeepSeek 的行为强制绑定到工作台 Skill。

Skill 应尽量承载稳定规则，动态项目数据仍由工作台按需传递。

同一 Harness 会话不能跨项目共享项目上下文，必须存在明确的项目隔离。

优先复用现有架构和依赖，避免为解决 Prompt 冗余问题引入不必要的大型依赖。

修改必须保持现有任务失败恢复和重新规划能力。

所有改动完成后必须通过实际运行验证，而不是仅检查代码结构。

questions_for_executor:

首先不要直接修改代码。先执行 TASK-001，重点追踪“DeepSeek Prompt 是在哪里拼接的”“Harness 窗口/进程在哪里创建和销毁”“Task 执行调用是否每次重新初始化上下文”“现有项目是否已有 Skill/系统提示注入机制”。

特别确认当前 Harness 所谓“窗口”究竟是独立进程、终端窗口、CLI 会话还是其他载体，因为复用方案必须针对真实生命周期实现。

重点寻找是否可以让工作台在首次建立 Harness 会话时一次性建立稳定上下文，后续只发送增量 Task 指令；如果现有 Harness 本身不支持持久会话，则需要设计最小成本的会话复用/进程通信方案，而不是简单假设它支持。

完成 TASK-001 后，将完整 project_analysis.md 返回，由我根据实际架构决定后续实现路径。

已完成任务：

