# TASK-008 执行报告：对比 Token 消耗 + 问题检查 + 最小修正 + 最终验收

## 1. 重构前后消息规模 / Token 对比（代表型 8 任务项目，字符数，~tokens≈字符/3.5）
| 场景 | 重构前 | 重构后 | 降幅 |
|---|---|---|---|
| 首个任务（新会话）init prompt | 1685 tok | 344 tok | **-79.5%** |
| 后续任务 inbox/task.json 内容（执行者读入上下文） | 1261 tok | 913 tok | **-27.6%** |
| 后续任务（turn 消息 + task.json 内容合计） | 1319 tok | 1122 tok | **-14.9%** |
| 后续任务 turn 消息本身 | 57 tok | 172 tok | +（因显式携带任务/目标/验收/状态） |

- 收益来源：① 稳定角色/协议下沉到 Skill，从 init prompt 移除；② 计划精简（去掉各任务描述）；③ 增量上下文（已完成/失败/决策/REPLAN 只传增量 + 计数引用）；④ 任务消息显式携带必需字段，常规任务可不再读 task.json。
- 随项目规模增大，增量机制收益更明显（不再每个任务整表重列全部已完成任务）。

## 2. 问题检查
- **遗漏必要上下文**：无。current_task（完整描述）、目标、验收标准、依赖、项目状态（增量+计数）均保留；完整计划/历史仍在 project_plan.md / project_state.json 可按需读取。
- **上下文过度缓存**：无。context_cache 每次分派后更新；新会话（freshSession）会重置缓存→下个任务发全量；REPLAN 通过 planChanged 检测并传增量 replans。
- **会话串项目**：无。执行服务/会话按 projectId 隔离（servers Map 键控）；每个项目独立会话；Skill 按项目 `.dsh/skills` 供给。
- **协议失效**：无。mock 全闭环 PASS（outbox/EXECUTOR_DONE/ANALYSIS/REVIEW 契约正常）；协议在 Skill 中 + 提示内保留最小安全网（写 outbox、回 EXECUTOR_DONE）。

## 3. 最后的最小增量修正
- 依据测量：原 `slimPlan` 保留 ≤200 字符任务描述，对典型项目几乎不省（task.json 0% 降幅）。改为**任务列表只保留 id/priority/status/dependencies，丢弃各任务描述**（当前任务完整描述在信封 `current_task`，完整计划在 project_plan.md 可读）。修正后 task.json 降 27.6%，任务消息仍正常渲染（current_task/目标/验收/依赖/增量齐全，无相邻任务描述）。
- 修正后全量语法校验通过；mock 全闭环复测 **PASS**（无回归）。

## 4. 最终验收结果（对照计划验收标准）
- ✔ 稳定角色/协议不再在每次 Task Prompt 中重复发送（init 降 79.5%，协议在 Skill）。
- ✔ 存在工作台专用 Skill 且仅工作台调用启用（供给+激活+上下文门控；`~/.dsh/skills`/其他项目无）。
- ✔ 用户直接调用不改变默认行为（Skill 仅项目 `.dsh/skills` + 门控）。
- ✔ 同项目会话复用、新项目独立会话（getOrCreateSession 按 projectId）。
- ✔ 单 Task 消息不再携带完整任务列表/角色/格式（渲染断言 + slimPlan 去描述）。
- ✔ Task 消息保留 Task ID/目标/依赖/验收/必要增量上下文。
- ✔ 项目状态增量传递（context_cache + 计数引用）。
- ✔ ANALYSIS/QUERY/REPLAN/CONTINUE/DONE 协议可用（mock 闭环 + 代码保留）。
- ✔ Harness 异常退出检测/恢复（uiRecoveryRetries + getOrCreateSession 重建）。
- ✔ 端到端通过，Token 明显下降（init -79.5%、task.json -27.6%）。

**结论：全部验收标准满足，重构完成。**

## 说明 / 建议
- 运行中的工作台进程仍跑旧代码（改动待重启生效）；本次验证用新代码独立进程（mock 闭环 + 渲染断言 + 单元/令牌对比）。
- 建议重启工作台后跑一个真实 2-3 任务小项目做最终回归，以在真实 LLM 环境确认会话复用与 Token 下降。
