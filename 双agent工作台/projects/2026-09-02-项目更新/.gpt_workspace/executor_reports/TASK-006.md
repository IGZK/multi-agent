# TASK-006 执行报告：建立项目级上下文缓存/引用机制

## 做了什么
1. **项目级上下文缓存基线**（`controller/orchestrator.mjs`）：
   - 新增 `updateContextCache(projectId)`：把当前已完成/失败任务、决策数、重规划数、计划哈希写入 `project_state.json.context_cache`。
   - 新增 `planHash(tasks)`：基于任务 id+status 的稳定哈希，用于判断计划/REPLAN 是否变更。
2. **信封增量生成**（`buildEnvelope`）：
   - `completed_tasks`/`failed_tasks`/`decisions`/`replans` 改为**仅传相对上一状态的新增量**（依据 context_cache 过滤），不再整表重复传输。
   - 新增 `context` 摘要：`{ fresh, planChanged, completedCount, failedCount, decisionsCount, replansCount }`，供执行者简短引用。
   - `fresh`（新会话/无缓存）→ 发送全量；复用会话 → 只发增量。
3. **新会话重置**（`controller/deepseek_runner.mjs`）：`runSessionPool` 结果新增 `freshSession`（新会话创建/崩溃恢复重建时 true）；编排器据此在新会话后把 `context_cache` 置空，下个任务发全量，避免新会话缺历史。
4. **提示渲染适配**（`controller/prompts.mjs`）：
   - `buildTaskMessage`：已完成/失败按增量展示（"已完成（新增）：TASK-xxx" / "已完成共 N 项（本任务无新增）"），新增决策/重规划计数、计划变更提示。
   - `buildProjectInitContext`：用 `context` 计数展示项目状态，fresh 时列出已完成任务。

## 结果
- 四个改动模块 `node --check` 通过。
- 实跑多轮分派验证：
  - 首次（无缓存）fresh=true、发全量。
  - `updateContextCache` 写入基线。
  - 二次分派：fresh=false、`completed_tasks=[]`（无新增）、completedCount=1；消息显示"已完成共 1 项（本任务无新增，沿用会话内已知）"。
  - 三次分派（又完成一项）：delta 仅含 `TASK-002`、completedCount=2；消息"已完成（新增）：TASK-002"，且不整表重列。
  - REPLAN 增量：`replans.length=1`、计划变更检测可用。
- 每任务不再重复传输完整已完成列表、决策、重规划历史；只传真正变化的内容，未变化部分以计数简短引用。

## 验证方式
- 语法校验 + 构造 Orchestrator（桩 store）实测 `buildEnvelope`/`updateContextCache` 的多轮增量行为与 `buildTaskMessage` 渲染。
- 说明：运行中的工作台进程仍跑旧代码，改动将在重启后生效；完整端到端在 TASK-007 统一验证。

## 风险 / 说明
- 执行者如需完整已完成列表/决策历史，可读 project_state.json（增量+计数为默认，不重复进会话上下文）。
- 新会话（崩溃恢复重建）后下个任务发全量，避免缺历史。
- 未改动 `protocol.mjs` 状态机、REPLAN 语义与失败重试逻辑。
