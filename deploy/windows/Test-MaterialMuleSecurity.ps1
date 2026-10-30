#Requires -Version 7.2
<#
.SYNOPSIS
Read-only security check of the Material Mule host (MM-T68; run on the real host in MM-T90).

.DESCRIPTION
Changes nothing. Prints one line per finding, "PASS <check>: <detail>", "FAIL <check>: <detail>"
or "SKIP <check>: <detail>", then a summary, and exits 0 when nothing failed, 1 otherwise. Never
prints a password or a connection string; role and account names only.

Checks:
- postgres-exposure: listen_addresses is localhost only and pg_hba.conf accepts no remote addresses
  (the same check Install-MaterialMuleHost.ps1 runs).
- pg-hba-auth-method: every pg_hba.conf host line uses scram-sha-256 (or reject), not md5,
  password or trust.
- firewall-5432: no enabled inbound Allow rule for TCP 5432.
- acl-admin-config-dir, acl-migration-env-file: Administrators and SYSTEM only.
- acl-config-dir, acl-service-env-file: not readable by Everyone, Users, Authenticated Users,
  Anonymous or Guests; the service account can read the service env file.
- service-env-database-user: DATABASE_URL in the service env file connects as -AppRole (not
  postgres, not the migration role).
- database (unless -SkipDatabase): the release's `cli.js security-check`, run as the app role from
  the service env file; its PASS/FAIL/SKIP lines are relayed as they are.

Run from an elevated PowerShell 7 prompt on the host, so the PostgreSQL data folder and the
permissions can be read. See docs\operations\runbook.md.

.EXAMPLE
.\Test-MaterialMuleSecurity.ps1 -ConfigPath C:\MaterialMule\config\host.config.psd1

.EXAMPLE
.\Test-MaterialMuleSecurity.ps1 -ConfigPath C:\MaterialMule\config\host.config.psd1 -BackupRole materialmule_backup
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ConfigPath,
    # Leave out the database check (e.g. before the first release is deployed).
    [switch]$SkipDatabase,
    [string]$AppRole = 'materialmule_app',
    [string]$MigrationRole = 'materialmule_owner',
    # MM-T21 read-only backup role, when one has been set up.
    [string]$BackupRole
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'MaterialMuleHosting.psm1')
$config = Get-MaterialMuleHostConfig -Path $ConfigPath

$counts = [ordered]@{ PASS = 0; FAIL = 0; SKIP = 0 }
# Secrets that must never reach the output (the service env file's database password).
$secrets = [System.Collections.Generic.List[string]]::new()

function Hide-Secret([string]$Text) {
    $Text = $Text -replace '(postgres(ql)?://[^:/@\s]*:)[^@\s]*@', '$1***@'
    foreach ($secret in $secrets) {
        if ($secret) { $Text = $Text.Replace($secret, '***') }
    }
    return $Text
}

function Write-Result([ValidateSet('PASS', 'FAIL', 'SKIP')][string]$Status, [string]$Check, [string]$Detail) {
    $counts[$Status]++
    $color = @{ PASS = 'Green'; FAIL = 'Red'; SKIP = 'Yellow' }[$Status]
    Write-Host (Hide-Secret "$Status ${Check}: $Detail") -ForegroundColor $color
}

# Runs one check: $Body returns problem strings (none = PASS) or throws (FAIL: could not check).
function Invoke-Check([string]$Check, [string]$PassDetail, [scriptblock]$Body) {
    try {
        $problems = @(& $Body | Where-Object { $_ })
    } catch {
        Write-Result FAIL $Check "could not check: $($_.Exception.Message)"
        return
    }
    if ($problems.Count -eq 0) {
        Write-Result PASS $Check $PassDetail
    } else {
        foreach ($problem in $problems) { Write-Result FAIL $Check $problem }
    }
}

# --- PostgreSQL configuration and firewall ------------------------------------------------------
if ([string]::IsNullOrWhiteSpace([string]$config.PostgresDataDir)) {
    Write-Result FAIL 'postgres-exposure' 'PostgresDataDir is not set in the host configuration'
    Write-Result FAIL 'pg-hba-auth-method' 'PostgresDataDir is not set in the host configuration'
} else {
    Invoke-Check 'postgres-exposure' 'listen_addresses is local only and pg_hba.conf accepts no remote addresses' {
        $problems = Test-MaterialMuleDatabaseExposure -DataDir $config.PostgresDataDir
        $problems
    }
    Invoke-Check 'pg-hba-auth-method' 'every pg_hba.conf host line uses scram-sha-256' {
        $problems = Test-MaterialMulePgHbaAuthMethod -DataDir $config.PostgresDataDir
        $problems
    }
}
Invoke-Check 'firewall-5432' 'no enabled inbound Allow rule for TCP 5432' {
    $rules = Get-MaterialMuleDatabaseFirewallRule
    foreach ($rule in $rules) {
        "rule '$($rule.DisplayName)' allows inbound TCP 5432; disable it"
    }
}

# --- Folder and file permissions ------------------------------------------------------------------
foreach ($expect in Get-MaterialMuleAclExpectation -Config $config) {
    $passDetail = if ($expect.AllowedIdentities) {
        "$($expect.Path): Administrators and SYSTEM only"
    } elseif ($expect.RequiredReader) {
        "$($expect.Path): not readable by broad groups; $($expect.RequiredReader) can read it"
    } else {
        "$($expect.Path): not readable by broad groups"
    }
    if ($expect.Name -eq 'acl-service-env-file' -and [string]::IsNullOrWhiteSpace($expect.RequiredReader)) {
        Write-Result FAIL $expect.Name 'ServiceAccount is not set in the host configuration'
        continue
    }
    Invoke-Check $expect.Name $passDetail {
        $rules = Get-MaterialMuleAclRules -Path $expect.Path
        $arguments = @{ Rules = $rules; ForbiddenReaders = $expect.ForbiddenReaders }
        if ($expect.AllowedIdentities) { $arguments.AllowedIdentities = $expect.AllowedIdentities }
        if ($expect.RequiredReader) { $arguments.RequiredReader = $expect.RequiredReader }
        $problems = Test-MaterialMuleAcl @arguments
        foreach ($problem in $problems) { "$($expect.Path): $problem" }
    }
}

# --- Service env file: which role the API connects as ---------------------------------------------
Invoke-Check 'service-env-database-user' "DATABASE_URL connects as $AppRole" {
    if (-not (Test-Path -LiteralPath $config.ServiceEnvFile -PathType Leaf)) {
        return "$($config.ServiceEnvFile) not found"
    }
    $values = Read-MaterialMuleEnvFile -Path $config.ServiceEnvFile
    $url = [string]$values['DATABASE_URL']
    if (-not $url) { return "DATABASE_URL is not set in $($config.ServiceEnvFile)" }
    if ($url -match '^postgres(ql)?://[^:@/]*:([^@]*)@') {
        $secrets.Add($Matches[2])
        $secrets.Add([System.Uri]::UnescapeDataString($Matches[2]))
    }
    $user = Get-MaterialMuleDatabaseUrlUser -Url $url
    if (-not $user) { return 'DATABASE_URL names no user (or is not a postgres:// URL)' }
    if ($user -eq $AppRole) { return }
    if ($user -eq 'postgres') { return "DATABASE_URL connects as the superuser postgres; use $AppRole" }
    if ($user -eq $MigrationRole) { return "DATABASE_URL connects as the migration role $MigrationRole; use $AppRole" }
    return "DATABASE_URL connects as $user; expected $AppRole"
}

# --- Database (roles, grants, settings), through the release's CLI ----------------------------------
if ($SkipDatabase) {
    Write-Result SKIP 'database' 'skipped (-SkipDatabase)'
} else {
    $cli = Join-Path $config.CurrentLink 'apps\api\dist\db\cli.js'
    if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
        Write-Result FAIL 'database' "database check could not run: $cli not found (deploy a release first, or use -SkipDatabase)"
    } else {
        $cliArgs = @($cli, 'security-check', '--env-file', $config.ServiceEnvFile, '--app-role', $AppRole, '--migration-role', $MigrationRole)
        if ($BackupRole) { $cliArgs += @('--backup-role', $BackupRole) }
        # A DATABASE_URL or ENV_FILE in this shell would win over the env file; clear them for the child.
        $saved = @{ DATABASE_URL = $env:DATABASE_URL; ENV_FILE = $env:ENV_FILE }
        $lines = @()
        $exitCode = $null
        try {
            $env:DATABASE_URL = $null
            $env:ENV_FILE = $null
            $lines = @(& $config.NodeExe @cliArgs 2>&1 | ForEach-Object { [string]$_ })
            $exitCode = $LASTEXITCODE
        } catch {
            $lines = @("$($_.Exception.Message)")
            $exitCode = -1
        } finally {
            $env:DATABASE_URL = $saved.DATABASE_URL
            $env:ENV_FILE = $saved.ENV_FILE
        }
        $failures = 0
        foreach ($line in $lines) {
            if ($line -match '^(PASS|FAIL|SKIP) (\S[^:]*): ?(.*)$') {
                if ($Matches[1] -eq 'FAIL') { $failures++ }
                Write-Result $Matches[1] $Matches[2] $Matches[3]
            } elseif ($line.Trim()) {
                Write-Host (Hide-Secret "  $line")
            }
        }
        if ($exitCode -ne 0 -and $failures -eq 0) {
            Write-Result FAIL 'database' "database check could not run (exit code $exitCode)"
        }
    }
}

Write-Host ''
Write-Host "Summary: $($counts.PASS) passed, $($counts.FAIL) failed, $($counts.SKIP) skipped"
if ($counts.FAIL -gt 0) {
    Write-Host 'Result: FAIL' -ForegroundColor Red
    exit 1
}
Write-Host 'Result: PASS' -ForegroundColor Green
exit 0
