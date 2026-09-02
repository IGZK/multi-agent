# 执行者报告：TASK-007 — 项目文件夹选择 UI 优化

- 任务：优化项目文件夹选择 UI，与左侧项目区域视觉统一，处理未选择项目/项目切换/当前项目展示/路径过长等状态；不得破坏现有项目目录选择逻辑。
- 执行者：DeepSeek（工作台执行者）
- 状态：完成 ✅（已实际运行验证）

## 做了什么（修改 `web/` 三文件）
1. **index.html**：当前项目区 `#currentProjBox` 重构——新增「📁 项目文件夹」分组标题 `.curp-folder-title`，路径 `#dirHint` + 「修改」按钮 `#btnSetDir`；移除按钮上的「📁 修改文件夹」文案（文件夹图标已在上方标题展示），视觉与左栏统一。
2. **app.js**：
   - `refreshDetail()`：`#dirHint` 空路径显示占位「默认工作台目录（未指定）」并加 `.empty` 态；真实路径写入 `#dirHint.dataset.path`（供选择器用）与 `title`（长路径全文）。
   - `#btnSetDir` 处理器：改为读取 `#dirHint.dataset.path`（真实路径）作为系统选择器起始目录，避免把占位文案误当路径；按钮文本「选择中…」→恢复「修改」。
3. **style.css**：`.curp-folder`（分隔/上边距）、`.curp-folder-title`、`.curp-dir.empty`（斜体占位）；`.curp-dir` 沿用 `text-overflow:ellipsis` + `title` 处理长路径。

## 状态处理
- **未选择项目**：`#currentProjBox` 隐藏（display:none）。
- **项目切换**：`selectProject`→`refreshDetail` 刷新 `#curpName/#curpState/#dirHint`。
- **当前项目展示**：名称 + 状态徽章 + 文件夹分组。
- **路径过长**：等宽字体 + `nowrap` + `ellipsis` + `title` 全文；占位态斜体。

## 验证（playwright + 运行中 Dashboard:3700）
- 未选项目：当前项目框隐藏。
- 选中项目：名称「更新ui」、路径按侧栏宽度省略（`ellipsized:true`、`clipWiderThanView:true`）、`title` 含完整长路径、文件夹标题存在。
- 空路径：显示「默认工作台目录（未指定）」、`.empty` 态、`dataset.path=""`。
- 项目切换列表正常（2 个项目）；选择逻辑（`#btnSetDir`→`/api/pickdir`→`action:setdir`）数据源改为真实路径 `dataset.path`，未破坏原有流程。
- 多尺寸响应式仍无错位/遮挡/溢出；无控制台 JS 错误。

## 产出
- 修改：`web/index.html`、`web/style.css`、`web/app.js`
- 验证脚本：`test/verify-task007.mjs`（供 TASK-009 回归复用）
