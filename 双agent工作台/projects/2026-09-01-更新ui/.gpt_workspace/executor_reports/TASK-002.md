# 执行者报告：TASK-002 — UI 重构方案

- 任务：基于当前项目实际实现，制定 UI 重构方案（左项目区 / 右对话区 / 底部输入区及其操作栏的布局关系，参考 Codex/DeepSeek Harness 设计模式，避免机械复制）。
- 执行者：DeepSeek（工作台执行者）
- 状态：完成 ✅

## 做了什么
1. 基于 TASK-001 的 `project_analysis.md` 与逐行核对的 `web/index.html`、`web/style.css`、`web/app.js`，制定目标布局。
2. 明确三区关系：左 rail（项目+文件夹选择，300px）｜右 main（对话工作台，纵向 flex）｜底部 Composer（输入框居中 + 右侧模型/推理 + 附件入口 + 发送）。
3. 给出 DOM 组件归属映射表（每个组件从现状哪里来、迁到哪、处理方式）。
4. 锁定数据流契约：`POST /projects`、`action:setdir/deepseek_model`、`POST /message`、`/api/pickdir`、`/api/deepseek/models` 全部保持不变（纯前端重构）。
5. 给出 Composer 内部结构、模型/推理持久化方案、附件「前端兼容优先 + 消息清单注记」方案（不新增后端端点）、左侧目录状态处理、视觉规范与实施顺序映射。

## 关键决策
- **不改后端协议**：附件按约束做前端兼容（本地态 + 发送时在 `text` 前注记 `[附件] 文件名 (大小)`），二进制真实上传留待 GPT 决策。
- **模型/推理**：Composer 内选择即调用 `deepseek_model` action 持久化，保证实际请求用所选配置。
- **对话主视图**：`#chatList` 从 Tab 提升为主视图，概览/任务/计划/分析/日志保留为次级导航。

## 产出文件
- `ui_refactor_plan.md`（TASK-003…TASK-010 的执行蓝图）

## 验证
- 逐项核对方案与现有代码/API 一一对应；标注了不破坏的数据流契约。
- 未运行 server（本任务为方案制定，无需运行；TASK-009 启动回归）。
