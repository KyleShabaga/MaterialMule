#Requires -Version 7.2
# Test harness for the deploy scripts (MM-T20). Replaces only the Windows service control with a
# fake that runs the release's main.js as a plain child process, then runs Deploy-MaterialMule.ps1
# unchanged. Never registers, starts or stops a real Windows service.
# Environment: T20_FAKE_LOG (event log file), T20_FAKE_PID (pid file); the fake server reads
# T20_FAKE_PORT. T20_FAKE_START_FAILS (e.g. '2') makes those start calls throw.
# MM-T68: T68_SCRIPT runs another script from deploy\windows instead (Test-MaterialMuleSecurity.ps1,
# Install-MaterialMuleHost.ps1). T68_FAKE_FIREWALL (JSON file: [{ "DisplayName": ... }]) replaces
# the firewall query; T68_FAKE_ACLS (JSON file: { "<path>": [{ "IdentityReference", "FileSystemRights",
# "AccessControlType" }] }) replaces reading permissions. Neither reads nor changes the real host.
param([Parameter(ValueFromRemainingArguments)][object[]]$DeployArgs)

$ErrorActionPreference = 'Stop'
$scripts = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
# Same full path as Deploy-MaterialMule.ps1 uses, so its Import-Module reuses this (patched) module.
$module = Import-Module (Join-Path $scripts 'MaterialMuleHosting.psm1') -PassThru

& $module {
    function script:Start-MaterialMuleApp {
        param($Config)
        # BUG-005: T20_FAKE_START_FAILS lists which start calls of this run throw (e.g. '2').
        if ($env:T20_FAKE_START_FAILS) {
            $calls = @(Get-Content -LiteralPath $env:T20_FAKE_LOG -ErrorAction SilentlyContinue |
                    Where-Object { $_ -in 'start', 'start failed' }).Count + 1
            if (($env:T20_FAKE_START_FAILS -split ',') -contains [string]$calls) {
                Add-Content -LiteralPath $env:T20_FAKE_LOG -Value 'start failed'
                throw "Service cannot be started (fake failure on start $calls)"
            }
        }
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
    if ($env:T68_FAKE_FIREWALL) {
        function script:Get-MaterialMuleDatabaseFirewallRule {
            param([int]$Port = 5432)
            return , @(Get-Content -LiteralPath $env:T68_FAKE_FIREWALL -Raw | ConvertFrom-Json | Where-Object { $_ })
        }
    }
    if ($env:T68_FAKE_ACLS) {
        function script:Get-MaterialMuleAclRules {
            param([string]$Path)
            $acls = Get-Content -LiteralPath $env:T68_FAKE_ACLS -Raw | ConvertFrom-Json -AsHashtable
            $normal = { param($p) [System.IO.Path]::GetFullPath($p).TrimEnd('') }
            $want = & $normal $Path
            $key = @($acls.Keys | Where-Object { (& $normal $_) -eq $want })
            if ($key.Count -eq 0) { throw "not found: $Path (fake ACLs for: $($acls.Keys -join ', '))" }
            return , @($acls[$key[0]] | ForEach-Object { [pscustomobject]$_ })
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
$target = if ($env:T68_SCRIPT) { $env:T68_SCRIPT } else { 'Deploy-MaterialMule.ps1' }
& (Join-Path $scripts $target) @splat
exit $LASTEXITCODE
