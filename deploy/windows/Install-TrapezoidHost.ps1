#Requires -Version 7.2
<#
.SYNOPSIS
One-time (re-runnable) setup of the Windows host for Trapezoid (TRP-T20).

.DESCRIPTION
1. Folders: <InstallRoot>\{config, config\admin, releases, logs, service}.
2. Windows service: writes the WinSW configuration and registers the service (automatic, delayed
   start after PostgreSQL, restart on failure). WinSW itself is a manual download (runbook).
3. Folder permissions for the low-privilege service account.
4. Windows Firewall: inbound HTTPS on the configured profiles only. Nothing opens PostgreSQL.
5. PostgreSQL service set to start automatically.
6. Power: never sleep or hibernate on mains power.
7. Read-only checks: PostgreSQL listens on localhost only, no remote pg_hba entries, no firewall
   rule opening the database port.

Always preview first with -WhatIf, which changes nothing and also works without elevation.
Run for real from an elevated PowerShell 7 prompt on the host. See docs\operations\runbook.md.

.EXAMPLE
.\Install-TrapezoidHost.ps1 -ConfigPath C:\Trapezoid\config\host.config.psd1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$ConfigPath,
    # Steps to leave out, e.g. -Skip Power,Firewall when IT manages them by policy.
    [ValidateSet('Folders', 'Service', 'Permissions', 'Firewall', 'Postgres', 'Power')]
    [string[]]$Skip = @()
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'TrapezoidHosting.psm1')
$config = Get-TrapezoidHostConfig -Path $ConfigPath

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $WhatIfPreference) {
    throw 'Run this from an elevated PowerShell 7 prompt (or add -WhatIf to preview).'
}
if ([string]::IsNullOrWhiteSpace($config.ServiceAccount)) {
    throw 'ServiceAccount is required in the host configuration (an IT input; see the runbook).'
}
if ($config.ServiceAccount -match '^(NT AUTHORITY\\)?(SYSTEM|LocalSystem|LOCAL SERVICE|NETWORK SERVICE)$' -or
    $config.ServiceAccount -match 'Administrator') {
    throw 'ServiceAccount must be a dedicated low-privilege account, not a built-in or admin account.'
}

$winsw = Join-Path $config.ServiceDir 'trapezoid-service.exe'
$serviceXml = Join-Path $config.ServiceDir 'trapezoid-service.xml'
$warnings = [System.Collections.Generic.List[string]]::new()

function Step([string]$Name) { Write-Host "`n== $Name ==" -ForegroundColor Cyan }

# 1. Folders ------------------------------------------------------------------------------------
if ('Folders' -notin $Skip) {
    Step 'Folders'
    foreach ($dir in $config.InstallRoot, $config.ConfigDir, $config.AdminConfigDir, $config.ReleasesDir, $config.LogsDir, $config.ServiceDir) {
        if (Test-Path -LiteralPath $dir -PathType Container) {
            Write-Host "exists: $dir"
        } elseif ($PSCmdlet.ShouldProcess($dir, 'create folder')) {
            New-Item -ItemType Directory -Path $dir | Out-Null
            Write-Host "created: $dir"
        }
    }
}

# 2. Windows service (WinSW) --------------------------------------------------------------------
if ('Service' -notin $Skip) {
    Step 'Windows service'
    $xml = New-TrapezoidServiceXml -Config $config
    if ($PSCmdlet.ShouldProcess($serviceXml, 'write WinSW service configuration')) {
        Set-Content -LiteralPath $serviceXml -Value $xml -Encoding utf8
    }
    $existing = Get-Service -Name $config.ServiceName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "Service $($config.ServiceName) is already installed. To apply configuration changes:"
        Write-Host "  $winsw stop; $winsw uninstall; then re-run this script"
    } else {
        if (-not (Test-Path -LiteralPath $winsw -PathType Leaf)) {
            $message = "WinSW not found at $winsw (manual download; see the runbook)"
            if ($WhatIfPreference) { $warnings.Add($message) } else { throw $message }
        } elseif ($config.WinSWSha256) {
            $hash = (Get-FileHash -LiteralPath $winsw -Algorithm SHA256).Hash
            if ($hash -ne ([string]$config.WinSWSha256).ToUpperInvariant()) {
                throw "WinSW SHA-256 does not match WinSWSha256 in the host configuration"
            }
        } else {
            $warnings.Add('WinSWSha256 is not set; record the hash of the WinSW download in the host configuration')
        }
        $passwordless = Test-PasswordlessServiceAccount $config.ServiceAccount
        $installArgs = if ($passwordless) { @('install') } else { @('install', '/p') }
        if ($PSCmdlet.ShouldProcess($config.ServiceName, "register Windows service ($winsw $($installArgs -join ' '))")) {
            if (-not $passwordless) {
                Write-Host "WinSW will prompt for the service account: enter $($config.ServiceAccount) and its password."
            }
            & $winsw @installArgs
            if ($LASTEXITCODE -ne 0) { throw "WinSW install failed (exit code $LASTEXITCODE)" }
        }
    }
}

# 3. Permissions ----------------------------------------------------------------------------------
if ('Permissions' -notin $Skip) {
    Step 'Folder permissions'
    function New-Rule([string]$Identity, [string]$Rights) {
        [System.Security.AccessControl.FileSystemAccessRule]::new(
            $Identity, $Rights, 'ContainerInherit, ObjectInherit', 'None', 'Allow')
    }
    $admins = 'BUILTIN\Administrators'
    $system = 'NT AUTHORITY\SYSTEM'
    $plan = [ordered]@{
        $config.InstallRoot    = @((New-Rule $admins 'FullControl'), (New-Rule $system 'FullControl'), (New-Rule $config.ServiceAccount 'ReadAndExecute'))
        $config.ConfigDir      = @((New-Rule $admins 'FullControl'), (New-Rule $system 'FullControl'), (New-Rule $config.ServiceAccount 'Read'))
        $config.AdminConfigDir = @((New-Rule $admins 'FullControl'), (New-Rule $system 'FullControl'))
        $config.LogsDir        = @((New-Rule $admins 'FullControl'), (New-Rule $system 'FullControl'), (New-Rule $config.ServiceAccount 'Modify'))
    }
    foreach ($dir in $plan.Keys) {
        $who = ($plan[$dir] | ForEach-Object { "$($_.IdentityReference): $($_.FileSystemRights)" }) -join '; '
        if ($PSCmdlet.ShouldProcess($dir, "replace permissions (no inheritance) with $who")) {
            $acl = [System.Security.AccessControl.DirectorySecurity]::new()
            $acl.SetAccessRuleProtection($true, $false)
            foreach ($rule in $plan[$dir]) { $acl.AddAccessRule($rule) }
            Set-Acl -LiteralPath $dir -AclObject $acl
        }
    }
}

# 4. Firewall -------------------------------------------------------------------------------------
if ('Firewall' -notin $Skip) {
    Step 'Windows Firewall'
    $ruleName = 'Trapezoid-HTTPS-In'
    $ruleArgs = @{
        DisplayName   = "Trapezoid HTTPS (TCP $($config.HttpsPort), TRP-T20)"
        Direction     = 'Inbound'
        Action        = 'Allow'
        Protocol      = 'TCP'
        LocalPort     = [string]$config.HttpsPort
        Profile       = @($config.FirewallProfiles)
        RemoteAddress = @($config.FirewallRemoteAddresses)
    }
    $describe = "allow inbound TCP $($config.HttpsPort) from $($config.FirewallRemoteAddresses -join ', ') on profile(s) $($config.FirewallProfiles -join ', ')"
    $rule = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
    if ($PSCmdlet.ShouldProcess($ruleName, $describe)) {
        if ($rule) {
            Set-NetFirewallRule -Name $ruleName @ruleArgs
        } else {
            New-NetFirewallRule -Name $ruleName @ruleArgs | Out-Null
        }
    }
}

# 5. PostgreSQL service -----------------------------------------------------------------------------
if ('Postgres' -notin $Skip) {
    Step 'PostgreSQL service'
    $postgres = Get-Service -Name $config.PostgresServiceName -ErrorAction SilentlyContinue
    if (-not $postgres) {
        $warnings.Add("PostgreSQL service '$($config.PostgresServiceName)' not found; check PostgresServiceName")
    } elseif ($postgres.StartType -ne 'Automatic' -and $PSCmdlet.ShouldProcess($postgres.Name, 'set startup type to Automatic')) {
        Set-Service -Name $postgres.Name -StartupType Automatic
    } else {
        Write-Host "$($postgres.Name) starts: $($postgres.StartType)"
    }
}

# 6. Power ------------------------------------------------------------------------------------------
if ('Power' -notin $Skip) {
    Step 'Power settings'
    foreach ($setting in 'standby-timeout-ac', 'hibernate-timeout-ac') {
        if ($PSCmdlet.ShouldProcess("active power plan: $setting", 'set to 0 (never)')) {
            & powercfg.exe /change $setting 0
            if ($LASTEXITCODE -ne 0) { throw "powercfg /change $setting failed" }
        }
    }
    $warnings.Add('Windows Update restart window: agree active hours / maintenance window with IT (manual)')
}

# 7. Read-only checks ------------------------------------------------------------------------------
Step 'Database exposure checks (read-only)'
if ($config.PostgresDataDir) {
    foreach ($problem in Test-TrapezoidDatabaseExposure -DataDir $config.PostgresDataDir) {
        $warnings.Add("PostgreSQL: $problem")
    }
} else {
    $warnings.Add('PostgresDataDir is not set; could not check listen_addresses / pg_hba.conf')
}
$dbRules = Get-NetFirewallPortFilter -Protocol TCP -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -contains '5432' } |
    Get-NetFirewallRule -ErrorAction SilentlyContinue |
    Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' }
foreach ($dbRule in @($dbRules)) {
    if ($dbRule) { $warnings.Add("Firewall rule '$($dbRule.DisplayName)' allows inbound TCP 5432; disable it") }
}

Write-Host ''
if ($warnings.Count -gt 0) {
    foreach ($warning in $warnings) { Write-Host "WARNING: $warning" -ForegroundColor Yellow }
} else {
    Write-Host 'No warnings.' -ForegroundColor Green
}
