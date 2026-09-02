status: READY
project_name: E2E-HelloWorld
objective: 创建一个可直接运行的 Python Hello World 项目，并提供 README 说明运行方法。

goals:

创建最小可运行的 Python Hello World 程序

添加 README.md，明确说明项目用途、运行环境和运行方法

验证程序能够正常执行并输出 Hello World

tasks:

id: TASK-001
description: 创建 Python Hello World 主程序文件，实现运行后输出“Hello, World!”
priority: high
dependencies:

id: TASK-002
description: 创建 README.md，说明项目简介、Python 环境要求以及从项目目录运行程序的方法，并与实际文件保持一致
priority: high
dependencies:

TASK-001

id: TASK-003
description: 运行 Hello World 程序进行最终验证，并检查 README 中描述的文件名和运行命令与项目实际结构一致
priority: high
dependencies:

TASK-002

acceptance_criteria:

项目包含可运行的 Python Hello World 程序

程序直接执行成功且退出码为 0

程序输出包含“Hello, World!”

项目包含 README.md

README.md 清楚说明运行方法和必要的 Python 环境要求

README 中的运行命令可以直接用于运行实际程序

不引入不必要的第三方依赖

所有任务完成后项目结构简洁、无明显无关文件

constraints:

使用 Python

不使用第三方依赖

保持项目最小化，不添加与目标无关的功能或文件

以实际运行测试结果作为最终验收依据

questions_for_executor:

按任务依赖顺序执行；每完成一个任务后验证其产出

不要擅自扩大项目范围