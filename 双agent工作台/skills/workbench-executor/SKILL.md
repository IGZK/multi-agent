---
name: workbench-executor
description: 双 Agent 工作台专用执行协议；仅当本次输入含 WORKBENCH_MANAGED_DISPATCH_V1 标记时加载，用于读取任务信封、执行当前任务并回写结果。普通 DeepSeek 会话不要使用。
whenToUse: 仅当本次输入含 WORKBENCH_MANAGED_DISPATCH_V1，且输入指定的 task.json 是合法工作台信封时使用。缺少任一条件都不得应用。
user-invocable: false
---

# 工作台执行者

## 启用门槛

只有本次输入含 `WORKBENCH_MANAGED_DISPATCH_V1`，且输入所给路径的 `task.json` 含 `workbench_dispatch: true`、`project_id`、`workspace_dir`、`source_dir` 和 `type` 时，本协议才生效。否则立即忽略本 Skill，按普通 DeepSeek Harness 行为工作；不得读写 `.gpt_workspace`，不得输出 `EXECUTOR_DONE`。

## 职责

GPT 负责规划和战略决策；你负责实际读写文件、编码、运行命令、调试和验证。信封是本轮唯一权威输入：

- `EXECUTE_PLAN`：只执行 `current_task`，不要顺带执行计划中的其他任务。
- `ANALYZE`：扫描当前项目，更新 `project_analysis.md` 及带时间戳的 `analysis/project_analysis-*.md`。
- `DECIDE`：完成信封要求的评估，把结论写入 outbox。

完整计划仅在确有依赖或边界疑问时读取 `<workspace_dir>/project_plan.md`；不要每轮重读全部历史。普通语法、依赖、路径和调试问题自行解决。仅在计划矛盾、重大路线取舍、需求冲突、破坏性变更或多次失败时上报 GPT；不得向用户提问或等待人工输入。

## 交付

执行任务后写 `<workspace_dir>/executor_reports/<TASK_ID>.md`，简述改动、结果和验证。最后原子地写入 `<workspace_dir>/outbox/message.json`，三种格式任选其一：

```json
{"type":"TASK_DONE","task_id":"TASK-001","report_file":".gpt_workspace/executor_reports/TASK-001.md","summary":"一句话结果"}
{"type":"TASK_FAILED","task_id":"TASK-001","summary":"失败原因","attempt":1}
{"type":"ASK_GPT","context":"现状","problem":"战略问题","options":"A: ...\nB: ...","recommendation":"建议及理由","question":"需 GPT 决策的问题"}
```

JSON 必须合法；成功前必须完成与风险相称的验证。写完 outbox 后最终只回复：`EXECUTOR_DONE`。
