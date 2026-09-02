# 执行者报告：TASK-006 — 文件/照片附件上传 UI

- 任务：统一设计上传入口、拖拽、附件预览/文件卡片、文件名/类型展示、删除、上传中/成功/失败重试/移除状态，支持多附件。
- 执行者：DeepSeek（工作台执行者）
- 状态：完成 ✅（已实际运行验证）

## 背景（约束相关）
后端 `server.mjs` 无任何上传端点（仅 JSON、无 multipart、无附件存储）。按约束「先保留现有能力、对前端做兼容设计，不强行改后端协议」，本任务实现**前端本地态附件**：附件不落盘，发送时在消息正文前加 `[附件] 文件名 (大小)` 清单注记，`POST /api/projects/:id/message {text}` 协议不变（服务端只读 text）。

## 做了什么（修改 `web/` 三文件）
1. **index.html**：Composer 左侧新增 📷 `#btnAttachPhoto` + `#photoInput`（accept=image/*，多选），连同已有的 📎 `#btnAttach` + `#fileInput`；附件列表容器 `#attachList` 复用。
2. **app.js**：
   - 附件状态数组 `composerAttachments`（`{id,name,size,type,status:'uploading'|'success'|'failed',reason,preview}`）。
   - `addFiles`（多选/拖拽）、`simulateUpload`（模拟上传中→成功）、`renderAttachments`（卡片渲染）、`removeAttachment`、`retryAttachment`、`clearAttachments`。
   - 图片用 `URL.createObjectURL` 生成缩略图；>50MB 标记失败（「文件超过 50MB」）并带重试/移除。
   - `#btnAttach/#btnAttachPhoto` → 触发对应隐藏 input；change → `addFiles`。
   - 拖拽：`dragenter/dragover` 高亮 `.dragging`，drop 添加文件。
   - `sendComposer` 拼附件清单注记并发送，成功后清空附件。
3. **style.css**：`.attach-card`（uploading/success/failed 边框色）、缩略图/图标、名称/大小、状态徽章、spinner 动画、删除/重试按钮、`#composer.dragging` 高亮。

## 验证（playwright + 运行中 Dashboard:3700，/message 已拦截）
- 多文件（pdf/png/txt）加入：卡片先全部 `uploading` → `success`；图片有 blob 缩略图；名称展示正确。
- 删除单个 → 数量减少；多附件可并列。
- 发送 body 正确：`{"text":"[附件] 报告.pdf (9B)；截图.png (4B)\n\n请看看这些附件"}`；发送后附件清空。
- 失败态：60MB 文件 → 「✖ 失败：文件超过 50MB」，有 重试/移除；重试后 → success。
- 拖拽高亮：dragenter 加 `.dragging`，dragleave 移除。
- 8 个附件时：Composer 仍在底部、输入框可见、不遮挡、无横向/文档溢出。
- 无控制台 JS 错误。

## 产出
- 修改：`web/index.html`、`web/style.css`、`web/app.js`
- 验证脚本：`test/verify-task006.mjs`、`test/verify-task006-overflow.mjs`（供 TASK-009 回归复用）

## 备注
- 真实二进制上传（后端落盘）未实现，按约束留待 GPT 决策（如需新增后端上传端点与附件持久化，需另立任务并评估数据流变更）。
