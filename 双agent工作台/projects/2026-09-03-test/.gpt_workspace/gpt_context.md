# 项目上下文：test

更新时间：2026-09-03T10:34:07.878Z

用户任务：
生成一个贪吃蛇小游戏

当前计划：

status: READY
project_name: 贪吃蛇小游戏
objective: 创建一个可直接运行的网页版贪吃蛇小游戏，具备完整的移动、吃食物、增长、计分、碰撞判定、重新开始功能。

goals:

实现基础贪吃蛇核心玩法

提供清晰简洁的游戏界面和分数显示

支持键盘控制与重新开始

无需安装第三方依赖，直接浏览器运行

tasks:

id: TASK-001
description: 创建基础页面结构。新增或完善 index.html，包含游戏标题、分数显示区域、canvas 游戏画布、开始/重新开始按钮，并正确引用 style.css 和 game.js。完成后检查页面可直接在浏览器打开且元素均存在。
kind: coding
priority: high
validation: 检查 index.html 中存在 canvas、分数元素、重新开始按钮以及 style.css/game.js 引用
timeout: 300
max_attempts: 2

id: TASK-002
description: 创建界面样式。编写 style.css，为页面、游戏容器、canvas、分数和按钮提供简洁布局；确保游戏区域边界清晰、主要内容居中，并保证普通桌面浏览器下无明显布局溢出。不引入第三方 CSS 库。
kind: coding
priority: medium
validation: 检查 style.css 已被 index.html 引用，且 canvas 有明确尺寸和边界样式
timeout: 300
max_attempts: 2
dependencies:

TASK-001

id: TASK-003
description: 在 game.js 中实现游戏初始化与状态管理。定义固定网格尺寸，初始化蛇身、初始移动方向、食物位置、分数、游戏运行状态；实现 resetGame()，能够将所有状态恢复到初始值，并保证食物不会生成在蛇身上。
kind: coding
priority: high
validation: 检查 game.js 中存在初始化逻辑、resetGame() 和避免食物生成在蛇身上的处理
timeout: 300
max_attempts: 2
dependencies:

TASK-001

id: TASK-004
description: 在 game.js 中实现核心游戏循环。按照固定时间间隔移动蛇头；未吃到食物时移除蛇尾，吃到食物时保留蛇尾实现增长、增加分数并重新生成食物；每一帧清空并重新绘制蛇和食物。将逻辑拆成清晰函数，例如 update()、draw()、gameLoop()。
kind: coding
priority: high
validation: 代码检查确认存在定时游戏循环、蛇移动、吃食物增长和分数更新逻辑
timeout: 600
max_attempts: 2
dependencies:

TASK-003

id: TASK-005
description: 实现键盘方向控制与防止瞬间反向移动。监听 ArrowUp、ArrowDown、ArrowLeft、ArrowRight，并可兼容 WASD；当蛇正在向右移动时禁止立即向左，其他相反方向同理；避免单个游戏帧内连续按键造成非法反向。
kind: coding
priority: high
validation: 检查键盘事件监听存在，并包含四组相反方向保护逻辑
timeout: 300
max_attempts: 2
dependencies:

TASK-004

id: TASK-006
description: 实现游戏失败判定与重新开始。蛇头撞到画布边界或自身身体时停止游戏循环并显示 Game Over 状态；点击开始/重新开始按钮后调用 resetGame() 并重新启动循环，确保不会叠加多个定时器。
kind: coding
priority: high
validation: 检查边界碰撞、自身碰撞、Game Over 显示、重新开始以及防止重复定时器的逻辑
timeout: 300
max_attempts: 2
dependencies:

TASK-004

TASK-005

id: TASK-007
description: 执行完整功能测试并修复发现的问题。至少验证：游戏能够启动；四方向移动正常；禁止直接反向；吃到食物后长度和分数增加；食物不会出现在蛇身上；撞墙结束；撞自身结束；重新开始后蛇、方向、分数和游戏状态恢复；连续多次重新开始不会导致速度异常。如果浏览器自动化测试环境不可用，则进行代码级检查并记录人工检查项。
kind: test
priority: high
validation: 完成上述全部检查点且无阻塞性错误
timeout: 600
max_attempts: 2
dependencies:

TASK-006

id: TASK-008
description: 创建或更新 README.md，简要说明项目功能、文件结构、运行方式和操作方法。运行方式应优先说明直接打开 index.html；若浏览器限制导致需要本地服务器，可补充 python -m http.server 8000 作为可选方式。
kind: docs
priority: low
validation: 检查 README.md 包含运行方法、方向控制和重新开始说明
timeout: 300
max_attempts: 2
dependencies:

TASK-007

acceptance_criteria:

浏览器打开 index.html 后能够正常显示游戏界面

玩家能够使用方向键控制蛇移动

蛇不能直接向当前移动方向的反方向掉头

蛇吃到食物后长度增加且分数增加

新食物不会生成在蛇当前身体位置

蛇撞墙或撞到自身后游戏结束

游戏结束后能够通过按钮重新开始

多次重新开始不会产生多个游戏循环或异常加速

项目无需安装第三方依赖

README.md 包含清晰的运行和操作说明

constraints:

使用原生 HTML、CSS、JavaScript 实现

不引入 npm 包、游戏引擎或外部前端框架

优先保持实现简单，不增加排行榜、账号系统、关卡、音效、皮肤等非必要功能

核心文件优先保持为 index.html、style.css、game.js、README.md

若现有项目已有兼容结构，可在不破坏现有内容的前提下适配，但不要进行无关重构

questions_for_executor:

若目标目录已有同名文件，先读取并在现有结构上最小修改，不要直接覆盖与本任务无关的已有功能

已完成任务：

