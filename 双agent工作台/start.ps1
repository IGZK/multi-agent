# Both the batch entry point and direct PowerShell runs use this launcher.
$ErrorActionPreference = 'Stop'
try {
    Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
    $workbenchNode = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    & $workbenchNode -e "if (Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"
    if ($LASTEXITCODE -ne 0) { throw 'Install Node.js 22 or newer, then reopen the terminal.' }
    & $workbenchNode -e "try { require.resolve('playwright-core') } catch { process.exit(1) }"
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Installing workbench dependencies...'
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check your network and npm registry.' }
    }
    $workbenchArgs = $args
    # Windows PowerShell strips quotes from --key=value arguments containing spaces.
    if ($PSNativeCommandArgumentPassing -notin @('Standard', 'Windows')) {
        $workbenchArgs = @($args | ForEach-Object {
            if ($_ -match '[\s"]') { '"' + ($_ -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"' }
            else { $_ }
        })
    }
    & $workbenchNode (Join-Path $PSScriptRoot 'controller/index.mjs') --open @workbenchArgs
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
