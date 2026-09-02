# 执行者报告：TASK-004 — 对话输入区（Composer）重构

- 任务：将输入框置于右侧对话区底部居中；完善输入框容器、发送按钮、附件入口与底部操作栏的视觉层级；长文本/换行/滚动布局正常。
- 执行者：DeepSeek（工作台执行者）
- 状态：完成 ✅（已实际运行验证）

## 做了什么（修改 `web/` 三文件）
1. **index.html**：把 TASK-003 的 `.composer` 占位替换为真实 Composer：
   - `.composer-attachments`（#attachList，TASK-006 填充附件卡片）
   - `.composer-main`：左侧附件入口（📎 `#btnAttach` + 隐藏 `#fileInput`）｜中部输入 `#composerInput`（多行 textarea）｜右侧操作栏 `.composer-ops`（`#composerModelSlot` 供 TASK-005 放模型/推理 + `#btnComposerSend` 发送按钮）
   - `.composer-hint`（Enter 发送 · Shift+Enter 换行）
2. **style.css**：`.composer-main` 整体居中（max-width:900 水平居中）；`.composer-input-wrap` flex 居中；`#composerInput` 圆角容器、`min-height:40 / max-height:180 / overflow-y:auto`、focus 焦点环；`.icon-btn`、`.btn.primary.send`、`.composer-hint` 视觉层级。
3. **app.js**：新增 Composer 逻辑——`autoGrow()` 自动增高（封顶 180px）；Enter 发送 / Shift+Enter 换行；`sendComposer()` 调用 `POST /api/projects/:id/message`（协议不变），成功后清空输入并重置高度，发送中禁用按钮。

## 验证（playwright + 运行中 Dashboard:3700，/message 已拦截避免干扰编排器）
- 输入框存在且居中（距 `.main` 中心仅 19px ≈1.6%，TASK-005 加入右侧模型/推理后仍居中）。
- auto-grow：8 行从 43px 长到 180px；60 行长文本封顶 180px 且内部可滚动。
- Shift+Enter 保留换行且**不**触发发送；Enter 发送、按钮点击发送均产生正确的 `POST /api/projects/2026-09-01-更新ui/message` body `{text}`。
- 发送后输入框清空、高度重置、按钮恢复。
- 无控制台 JS 错误；Composer 存在时多尺寸响应式（700–1920 宽）仍无错位/遮挡/溢出、恒在底部。

## 产出
- 修改：`web/index.html`、`web/style.css`、`web/app.js`
- 验证脚本：`test/verify-task004.mjs`（供 TASK-009 回归复用）
