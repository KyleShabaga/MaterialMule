#Requires -Version 7.2
<#
.SYNOPSIS
Deploys a packed Material Mule release on the Windows host, or rolls back to an earlier one (MM-T20).

.DESCRIPTION
Deploy: back up the database (BackupScript) -> copy the release to releases\<version> -> stop the
service -> point `current` at the new release -> run migrations as the migration role -> start the
service -> wait for GET /api/health = 200. If migrations or the health check fail, it rolls back
to the previous release automatically.

Exit codes: 0 deployed (or rolled back by hand), 1 failed and rolled back, 2 failed and the
rollback is unhealthy or impossible, or an error came after the release was switched or the
service stopped (follow the runbook; deploy-state.json records where `current` points), 3 stopped
by an error before the release was switched (bad configuration or release, backup failed, service
would not stop): the running release is unchanged.

Run from an elevated PowerShell 7 prompt on the host. See docs\operations\runbook.md.

.EXAMPLE
.\Deploy-MaterialMule.ps1 -ConfigPath C:\MaterialMule\config\host.config.psd1 -Release D:\materialmule-0.2.0-ab12cd3 -WhatIf

.EXAMPLE
.\Deploy-MaterialMule.ps1 -ConfigPath C:\MaterialMule\config\host.config.psd1 -Rollback
#>
[CmdletBinding(SupportsShouldProcess, DefaultParameterSetName = 'Deploy')]
param(
    [Parameter(Mandatory)][string]$ConfigPath,
    [Parameter(Mandatory, ParameterSetName = 'Deploy')][string]$Release,
    [Parameter(ParameterSetName = 'Deploy')][switch]$SkipBackup,
    [Parameter(Mandatory, ParameterSetName = 'Rollback')][switch]$Rollback,
    [Parameter(ParameterSetName = 'Rollback')][string]$ToVersion
)

$ErrorActionPreference = 'Stop'
# Reuses the module if it is already loaded (the automated tests load it first).
Import-Module (Join-Path $PSScriptRoot 'MaterialMuleHosting.psm1')

$config = $null
$before = $null
try {
    $config = Get-MaterialMuleHostConfig -Path $ConfigPath
    $before = Get-MaterialMuleCurrentVersion -Config $config
    if ($PSCmdlet.ParameterSetName -eq 'Rollback') {
        $result = Invoke-MaterialMuleRollback -Config $config -ToVersion $ToVersion -WhatIf:$WhatIfPreference
    } else {
        $result = Invoke-MaterialMuleDeploy -Config $config -ReleasePath $Release -SkipBackup:$SkipBackup -WhatIf:$WhatIfPreference
    }
} catch {
    Write-Host "Stopped: $($_.Exception.Message)" -ForegroundColor Red
    # BUG-005 backstop: exit 3 promises the running release is unchanged. If `current` moved (or
    # can't be read any more), say so and exit 2 instead.
    $now = $before
    if ($config) {
        try { $now = Get-MaterialMuleCurrentVersion -Config $config } catch { $now = '(unreadable)' }
    }
    if ($now -ne $before) {
        Write-Host "The release was switched from $(if ($before) { $before } else { 'none' }) to $(if ($now) { $now } else { 'none' }) before the error. Follow the runbook's recovery steps." -ForegroundColor Red
        exit 2
    }
    exit 3
}

Write-Host "Outcome: $($result.Outcome) ($($result.Version))"
switch ($result.Outcome) {
    'Deployed' { exit 0 }
    'WhatIf' { exit 0 }
    'RolledBack' { if ($PSCmdlet.ParameterSetName -eq 'Rollback') { exit 0 } else { exit 1 } }
    default { exit 2 }
}
