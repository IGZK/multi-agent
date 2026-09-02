# 启动双 Agent 协作工作台（透传参数：--port=3700 --gpt=mock --executor=mock --selftest）
param([string[]]$Args2)
Set-Location $PSScriptRoot
Write-Host "双 Agent 协作工作台启动中… Dashboard: http://127.0.0.1:3700" -ForegroundColor Cyan
& node controller\index.mjs @Args2
