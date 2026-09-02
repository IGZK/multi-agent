# TASK-002 执行报告：创建 README.md

## 任务
创建 README.md，说明项目简介、Python 环境要求以及从项目目录运行程序的方法，并与实际文件保持一致。

## 所做工作
1. 检查了 TASK-001 的产出：`source/hello.py`，内容为 `print("Hello, World!")`。
2. 创建 `source/README.md`，包含：
   - 项目简介（最小化 Python Hello World 项目）
   - 项目结构（仅 `hello.py`）
   - 环境要求（Python 3.x，无第三方依赖）
   - 运行方法（`python hello.py`）及预期输出（`Hello, World!`）

## 验证方式
- 在项目目录执行 `python hello.py`：输出 `Hello, World!`，退出码 `EXIT_CODE=0`。
- README 中描述的文件名（`hello.py`）、运行命令（`python hello.py`）与项目实际结构一致，预期输出与实际运行输出一致。

## 结果
成功。README.md 已创建，与实际项目结构一致。
