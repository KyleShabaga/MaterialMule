#Requires -Version 7.2
<#
.SYNOPSIS
Operational health check for the Material Mule host (MM-T21), run every 5 minutes by the
"Material Mule Monitor" scheduled task.

.DESCRIPTION
Checks the Windows service, GET /api/health (service and database), the age and result of the
latest backup against the RPO, the oldest queued label print job, and free disk space on the host,
the PostgreSQL data drive and the backup location. Writes MonitorStatusFile and raises a Windows
event log alert when a new problem appears (and once when everything passes again). Read-only:
it changes nothing in the app or the database.

Exit codes: 0 all checks pass, 1 at least one problem, 2 refused (configuration incomplete).

.EXAMPLE
.\monitor.ps1 -ConfigPath C:\MaterialMule\config\backup.config.psd1
#>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ConfigPath)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'MaterialMuleOps.psm1')

try {
    $config = Get-MaterialMuleBackupConfig -Path $ConfigPath -Purpose Monitor
} catch {
    Write-Host "Refused: $($_.Exception.Message)" -ForegroundColor Red
    exit 2
}

$result = Invoke-MaterialMuleMonitorRun -Config $config
if ($result.Ok) {
    Write-Host 'All checks pass.'
    exit 0
}
foreach ($problem in $result.Problems) { Write-Host "PROBLEM: $problem" -ForegroundColor Yellow }
exit 1
