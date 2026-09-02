# 执行者报告：TASK-005 — 模型/推理选择 UI 调整

- 任务：将模型选择与推理强度选择放置在对话输入框右侧；设计清晰下拉、当前状态展示与禁用状态；确保选择结果仍正确传递给现有后端/Agent 调用。
- 执行者：DeepSeek（工作台执行者）
- 状态：完成 ✅（已实际运行验证）

## 做了什么（修改 `web/` 三文件）
1. **index.html**：移除右栏旧的 `ds-setting-row`（`#dDsModel/#dDsReasoning/#btnSaveDsModel`）；在 Composer 右侧操作栏 `#composerModelSlot` 加入两个紧凑下拉：`#cModel`（模型）+ `#cReasoning`（推理 off/low/high/max），并新增保存状态提示 `#composerSaveStatus`。
2. **style.css**：`.composer-model-slot/.cs-field/.cs-label/.composer-select` 样式；`:disabled` 降透明度；`.composer-save-status` 淡入显示。
3. **app.js**（保持数据流）
   - `populateModelSelects()` 填充 `#cModel`（复用 `fillModelSelect`，数据来自 `/api/deepseek/models`）。
   - `refreshDetail()` 将项目 `deepseek_selection` 同步到 `#cModel/#cReasoning`（编辑中不覆盖）。
   - 移除保存按钮，改为 **`change` 即持久化**：模型/推理变更即调用 `action:"deepseek_model"`，保证实际请求用所选配置；成功后在 `#composerSaveStatus` 显示「✓ 已保存 …」。

## 发现并修复的 Bug
- 首次实现时保存状态模板引用 `eff`（实为 `effort`）→ `ReferenceError` 被 catch 吞掉并误弹「保存失败」、状态不显示。已改为 `effort`，验证通过。

## 验证（playwright + 运行中 Dashboard:3700，action 已拦截避免改真实项目配置）
- 两个下拉存在且位于输入框右侧（ops.left 976 > input.right 966）。
- `#cModel` 由模型目录填充（4 项：默认 + 3 模型）。
- 变更推理/模型均触发 `action:"deepseek_model"`，body 正确：`{provider:"deepseek-official", model:"deepseek-v4-flash", reasoningEffort:"high"}`。
- 保存后 `#composerSaveStatus` 显示「✓ 已保存 … · 推理 max」且 `.show` 生效。
- 回显：模拟后端已持久化后 `refreshDetail` 正确保留所选推理等级。
- 无控制台 JS 错误；含模型/推理后多尺寸（700–1920 宽）仍无错位/遮挡/溢出、Composer 恒在底部。
- 已清除所有临时调试 `console.log`。

## 产出
- 修改：`web/index.html`、`web/style.css`、`web/app.js`
- 验证脚本：`test/verify-task005.mjs`、`test/verify-task005b.mjs`、`test/verify-savestatus-final.mjs`（供 TASK-009 回归复用）
