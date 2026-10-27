#Requires -Version 7.2
# Test harness for the deploy scripts (MM-T20). Replaces only the Windows service control with a
# fake that runs the release's main.js as a plain child process, then runs Deploy-MaterialMule.ps1
# unchanged. Never registers, starts or stops a real Windows service.
# Environment: T20_FAKE_LOG (event log file), T20_FAKE_PID (pid file); the fake server reads
# T20_FAKE_PORT.
param([Parameter(ValueFromRemainingArguments)][object[]]$DeployArgs)

$ErrorActionPreference = 'Stop'
$scripts = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
# Same full path as Deploy-MaterialMule.ps1 uses, so its Import-Module reuses this (patched) module.
$module = Import-Module (Join-Path $scripts 'MaterialMuleHosting.psm1') -PassThru

& $module {
    function script:Start-MaterialMuleApp {
        param($Config)
        Add-Content -LiteralPath $env:T20_FAKE_LOG -Value 'start'
        $main = Join-Path $Config.CurrentLink 'apps\api\dist\main.js'
        $process = Start-Process -FilePath $Config.NodeExe -ArgumentList "`"$main`"" -PassThru -WindowStyle Hidden
        Set-Content -LiteralPath $env:T20_FAKE_PID -Value $process.Id
    }
    function script:Stop-MaterialMuleApp {
        param($Config)
        Add-Content -LiteralPath $env:T20_FAKE_LOG -Value 'stop'
        if (Test-Path -LiteralPath $env:T20_FAKE_PID) {
            $id = [int](Get-Content -LiteralPath $env:T20_FAKE_PID)
            Stop-Process -Id $id -ErrorAction SilentlyContinue
            Wait-Process -Id $id -Timeout 10 -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $env:T20_FAKE_PID
        }
    }
}

# Named arguments arrive as strings ('-ConfigPath', 'x', '-SkipBackup'); rebuild a splat.
$splat = @{}
for ($i = 0; $i -lt $DeployArgs.Count; $i++) {
    $name = ([string]$DeployArgs[$i]).TrimStart('-')
    $next = if ($i + 1 -lt $DeployArgs.Count) { [string]$DeployArgs[$i + 1] } else { $null }
    if ($null -ne $next -and -not $next.StartsWith('-')) {
        $splat[$name] = $next
        $i++
    } else {
        $splat[$name] = $true
    }
}
& (Join-Path $scripts 'Deploy-MaterialMule.ps1') @splat
exit $LASTEXITCODE
