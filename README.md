# 双 Agent 协作工作台

Windows 本地工作台：ChatGPT 规划和审查，DeepSeek Harness 执行，本地界面管理进度。

支持 Windows 10/11、Node.js 22+。在本仓库根目录执行：

```powershell
npm ci
npm run demo
```

打开 <http://127.0.0.1:3700> 体验无需账号的模拟流程。

真实使用需要安装 Chrome/Edge、[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 并配置自己的模型服务与 ChatGPT 登录，然后执行 `npm run doctor`、`npm start`。也可以双击根目录 `start.bat` 启动。

[完整安装、配置、迁移和测试说明](双agent工作台/README.md) · [更新记录](双agent工作台/CHANGELOG.md)

程序自动寻找本机依赖，不要求固定用户名或盘符。个人配置保存在 `双agent工作台/config/config.local.json`，无需修改源码。本项目仅考虑 Windows。
