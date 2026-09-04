# Optional: register the workbench to auto-start at Windows logon.
# Usage:  powershell -ExecutionPolicy Bypass -File register-autostart.ps1
# Remove: Unregister-ScheduledTask -TaskName "DualAgentWorkbench" -Confirm:$false
$root = $PSScriptRoot
$nodePath = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$action = New-ScheduledTaskAction -Execute $nodePath -Argument "`"$root\controller\index.mjs`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Days 3) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$settings.DisallowStartIfOnBatteries = $false
$settings.StopIfGoingOnBatteries = $false
Register-ScheduledTask -TaskName "DualAgentWorkbench" -Action $action -Trigger $trigger -Settings $settings -Description "Dual Agent Workbench (ChatGPT + DeepSeek Harness)" -Force | Out-Null
Write-Host ("Registered scheduled task DualAgentWorkbench. Logs: " + $root + "\logs") -ForegroundColor Green
