# Forward all options, including --port=... and paths containing spaces.
Set-Location -LiteralPath $PSScriptRoot
& node (Join-Path $PSScriptRoot 'controller/index.mjs') --open @args
exit $LASTEXITCODE
