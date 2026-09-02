# 执行者报告：TASK-003 — 主界面布局重构

- 任务：重构主界面布局——项目文件夹选择及项目信息稳定置于左侧；对话内容置于右侧；为右侧底部输入区预留固定、响应式空间；窗口尺寸变化不错位/遮挡。
- 执行者：DeepSeek（工作台执行者）
- 状态：完成 ✅（已实际运行验证）

## 做了什么（修改 `web/` 三文件）
1. **index.html**
   - 左栏新增「当前项目」区（`#currentProjBox`：`#curpName`、`#curpState`、`#dirHint` + `#btnSetDir`），把项目文件夹选择/展示稳定归入左侧；未选中项目时隐藏。
   - 右栏重构为「对话工作台」：顶部信息/状态/设置区包进 `.detail-top`，次级导航 `#tabs`，主体 `.workbench-body` 内 `#convoView`（对话主视图，默认显示）+ 各次级面板（概览/任务/规划/分析/日志），底部新增 `.composer`（TASK-004 填充）预留固定空间。
   - 移除旧的 `#tab-chat` 内嵌输入（`#injectMsg/#btnInject` 由 TASK-004 的 Composer 接管）。
2. **style.css**
   - `body` 改 flex 列，`.layout` 用 `flex:1`（不再硬编码 `calc(100vh-49px)`，根除小高度下 ~17px 溢出）。
   - 右栏 `#detail` 纵向 flex；`.detail-top` 限高可独立滚动；`.workbench-body/.convo-scroll` `flex:1;min-height:0`；`.composer` `flex-shrink:0` 固定在底部。
   - 新增 `.current-project/.curp-*` 样式、`.composer/.composer-empty`；响应式断点（≤1000px 左栏 260px，≤760px 220px）。
3. **app.js**（最小改动，保持数据流）
   - `badge()` 同步左栏 `#curpState`；`refreshDetail()` 填充 `#curpName` 并显示当前项目区；`selectProject()`/删除时显示/隐藏当前项目区。
   - Tab 切换特判 `chat`（显示 `#convoView`），其余显示次级面板。
   - `renderChat()` 滚动容器由 `.main` 改为 `#convoView`（自动跟随底部）。
   - `#btnInject` 改为元素存在才绑定（旧布局移除后不再报错）。

## 验证（实际运行，playwright + 运行中的 Dashboard:3700）
- `node --check app.js` 通过；app.js/style.css/index.html 由运行中 server 返回 200 且含新结构标记。
- 浏览器加载并选中项目后：侧栏 300px、右栏对话工作台占满剩余宽度、`.composer` 固定在 `.main` 底部、对话为主视图。
- 多尺寸响应式（1920/1440/1280/1100/900/700 宽 × 1080/900/800/700/600 高）：**全部**无左右错位、无横向溢出、无文档垂直溢出，`.composer` 恒在底部。
- 次级 Tab 切换正确：对话↔概览/任务/规划/分析/日志。
- 控制台无 JS 错误；唯一 404 为既有缺失的 `/favicon.ico`（非本次引入，app.js/style.css 均 200）。

## 产出
- 修改：`web/index.html`、`web/style.css`、`web/app.js`
- 验证脚本：`test/verify-task003.mjs`、`test/verify-task003-resize.mjs`、`test/verify-task003-tabs.mjs`、`test/debug-overflow.mjs`（供 TASK-009 回归复用）
