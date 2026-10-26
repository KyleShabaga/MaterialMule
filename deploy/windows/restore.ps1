#Requires -Version 7.2
<#
.SYNOPSIS
Restore drill: restores a Trapezoid backup into a NEW, isolated database and verifies it (TRP-T21).

.DESCRIPTION
1. Checks the backup against its .sha256 file.
2. Refuses the target if it is the configured production database (DbName), a system database,
   already exists, or does not have "restore" in its name.
3. CREATE DATABASE <target>, then pg_restore into it (--no-owner --no-privileges --exit-on-error,
   or with owners and grants kept under -KeepOwnership; never --clean, never into an existing
   database).
4. Runs verify-restore.sql on the restored copy and compares it line by line with the manifest
   taken from production at backup time: counts, the latest storage unit ID per year, the ID
   counters, the audit history fingerprint and five spot-checked units.
5. Appends a drill record (date, duration, result, differences) to RestoreDrillLog and the Windows
   event log. Record the drill on the TRP-T21 card / runbook too (AC6).

It never restores over production. Recovering production after a disaster is a separate, manual
runbook procedure that starts from a verified drill.

Connects as RestoreAdminUser (postgres by default, which may create databases); the password
comes from PGPASSWORD in this window or PgPassFile, never from this script.

Exit codes: 0 verified, 1 restore or verification failed, 2 refused (nothing was created).

.EXAMPLE
$env:PGPASSWORD = (Read-Host 'postgres password' -MaskInput)
.\restore.ps1 -ConfigPath C:\Trapezoid\config\backup.config.psd1 -BackupFile E:\TrapezoidBackups\trapezoid-production-20261026T080000Z-0.2.0-ab12cd3.dump -TargetDatabase trapezoid_restore_20261026 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$ConfigPath,
    [Parameter(Mandatory)][string]$BackupFile,
    [Parameter(Mandatory)][string]$TargetDatabase,
    # Drop the restored copy after verifying it (otherwise it stays for inspection).
    [switch]$DropAfterVerify,
    # Keep owners and grants (the roles must exist). Only for the runbook's manual recovery, where
    # a verified copy later replaces a lost production database.
    [switch]$KeepOwnership
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'TrapezoidOps.psm1')

try {
    $config = Get-TrapezoidBackupConfig -Path $ConfigPath -Purpose Restore
    $drill = Invoke-TrapezoidRestoreRun -Config $config -BackupFile $BackupFile -TargetDatabase $TargetDatabase -DropAfterVerify:$DropAfterVerify -KeepOwnership:$KeepOwnership -WhatIf:$WhatIfPreference
} catch {
    Write-Host "Refused: $($_.Exception.Message)" -ForegroundColor Red
    exit 2
}

Write-Host "Result: $($drill.Result)"
foreach ($difference in $drill.Differences) { Write-Host "  $difference" }
if ($drill.Result -in 'verified', 'whatif') { exit 0 }
exit 1
