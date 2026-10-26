#Requires -Version 7.2
<#
.SYNOPSIS
Backs up the Trapezoid database to the backup location IT approved (TRP-T21).

.DESCRIPTION
pg_dump (custom format) as the read-only backup role, a verification manifest (verify-restore.sql
before and after the dump), a configuration bundle without secrets, a SHA-256 file, a copy to
BackupTarget with the checksum re-checked there, retention pruning, then the status record that
Settings -> System status shows. A failure is recorded and raised in the Windows event log.

Refuses to run until backup.config.psd1 holds IT's decisions (D39): location, owner, RPO/RTO,
retention and alert recipient have no defaults.

Exit codes: 0 backed up, 1 failed (recorded and alerted), 2 refused (configuration incomplete or
invalid; nothing ran).

Runs from the "Trapezoid Backup" scheduled task as the backup account, from Deploy-Trapezoid.ps1
before an upgrade (BackupScript + BackupConfig in host.config.psd1), or by hand. Never elevated.

.EXAMPLE
.\backup.ps1 -ConfigPath C:\Trapezoid\config\backup.config.psd1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$ConfigPath,
    # Recorded in the log, e.g. PreDeploy when Deploy-Trapezoid.ps1 calls it.
    [ValidateSet('Scheduled', 'PreDeploy', 'Manual')][string]$Reason = 'Manual'
)

$ErrorActionPreference = 'Stop'
# Reuses the module if it is already loaded (the automated tests load it first).
Import-Module (Join-Path $PSScriptRoot 'TrapezoidOps.psm1')

try {
    $config = Get-TrapezoidBackupConfig -Path $ConfigPath -Purpose Backup
} catch {
    Write-Host "Refused: $($_.Exception.Message)" -ForegroundColor Red
    exit 2
}

$run = Invoke-TrapezoidBackupRun -Config $config -Reason $Reason -WhatIf:$WhatIfPreference
Write-Host "Result: $($run.result)$(if ($run.file) { " ($($run.file))" })"
if ($run.result -eq 'failed') { exit 1 }
exit 0
