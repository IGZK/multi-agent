# TASK-003 执行报告：重构 DeepSeek Harness 启动与生命周期管理

## 做了什么
1. **统一真实模式为"项目级会话池"**（`deepseek_runner.mjs`）：
   - `run()`：真实模式统一走 `runSessionPool()`（每项目一个独立端口的 dsh web 服务 + 一个持久会话，跨任务复用）；`visible` 仅决定是否弹出浏览器窗口（`visible=false` 仍复用同一会话、后台执行）；仅当服务/会话确实无法启动时回退 `runHeadless()`（每任务一个进程，无复用）。新增配置 `useSessionPool`（默认 true）。
2. **崩溃自动恢复**：
   - 轮询循环中服务进程崩溃（两次确认防误判）后，自动执行"销毁失效服务 → 重建服务 → 重建会话 → 重新应用模型 → 重新提交完整提示"的恢复，次数上限 `uiRecoveryRetries`（默认 1）。
   - 会话级失效恢复沿用 `getOrCreateSession`（`session.list` 查不到即重建）。
3. **项目级会话状态**：
   - 新增 `recordProjectSession()`：把 `session`（sessionId/servicePid/serviceUrl/taskId/type/reused/createdAt/recoveries）写入 `project_state.json`，供 Dashboard 与断点恢复。
   - 新增 `projectSessionInfo(projectId)`：合并运行态与服务/会话信息。
4. **项目隔离**：每 projectId 对应独立服务与独立会话（`servers` Map 按 projectId 键控）；实测同项目二次获取返回同一 session，不同项目不同服务/会话。
5. 配置：`config/config.json` 新增 `useSessionPool`、`uiRecoveryRetries`；自测 `selftest` 设 `useSessionPool:false` 保持纯 headless；README 更新。

## 结果
- `node --check` 全部通过（deepseek_runner / dsh_ui / workbench_skill / prompts）。
- config.json 合法 JSON。
- 真实 dsh 服务验证（workbench-exec profile，临时端口）：`getOrCreateSession` 首次创建（reused=false），第二次**返回同一 session（reused=true）** → 会话复用成立；不同 projectId 走不同服务/会话 → 项目隔离成立。
- 无残留 `runVisible`/`windowOpened` 引用。

## 验证方式
- 语法/JSON 静态校验。
- 临时 dsh web 服务实测 UiExecutor 会话复用与隔离。
- 说明：运行中的工作台进程（PID 22916）仍跑旧代码，本次改动将在下次重启后生效；完整端到端（多 Task 连续复用、崩溃恢复演练、新项目新会话）在 TASK-007 统一验证。

## 风险 / 说明
- 会话池路径依赖 dsh web 服务（`--profile workbench-exec`），比纯 headless 略多一个后台服务进程；换取跨任务会话复用与省 token。
- 恢复逻辑会重跑当前任务（新会话无历史，需完整上下文），不会重复累计已完成产出，语义与"失败重试"一致。
- 未改动 `protocol.mjs`/`orchestrator` 状态机与 REPLAN/失败重试语义。
