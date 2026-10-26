#Requires -Version 7.2
# Trapezoid Windows hosting helpers (TRP-T20). Used by Deploy-Trapezoid.ps1 and
# Install-TrapezoidHost.ps1; see docs/operations/runbook.md. Nothing here runs on import.

Set-StrictMode -Version 3.0

$script:VersionPattern = '^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$'

# --- Configuration -------------------------------------------------------------------------------

function Get-TrapezoidHostConfig {
    <#
    .SYNOPSIS
    Reads the host configuration (a .psd1 data file: no code runs) and fills in derived paths.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Host configuration not found: $Path (copy deploy\windows\host.config.example.psd1)"
    }
    $data = Import-PowerShellDataFile -LiteralPath $Path
    $config = [ordered]@{
        InstallRoot             = $null
        ServiceName             = 'Trapezoid'
        NodeExe                 = 'C:\Program Files\nodejs\node.exe'
        ServiceEnvFile          = $null
        MigrationEnvFile        = $null
        HealthUrl               = $null
        HealthTimeoutSeconds    = 90
        ServiceStopTimeoutSeconds = 60
        KeepReleases            = 5
        BackupScript            = ''
        ServiceAccount          = ''
        PostgresServiceName     = 'postgresql-x64-17'
        PostgresDataDir         = ''
        HttpsPort               = 443
        FirewallProfiles        = @('Private')
        FirewallRemoteAddresses = @('LocalSubnet')
        WinSWSha256             = ''
    }
    foreach ($key in $data.Keys) {
        if (-not $config.Contains($key)) {
            throw "Unknown setting '$key' in $Path"
        }
        $config[$key] = $data[$key]
    }
    foreach ($key in 'InstallRoot', 'HealthUrl') {
        if ([string]::IsNullOrWhiteSpace([string]$config[$key])) {
            throw "Setting '$key' is required in $Path"
        }
    }
    if ($config.HealthUrl -notmatch '^https?://[^/]+/api/health$') {
        throw "HealthUrl must look like https://<host name>/api/health"
    }
    $root = [System.IO.Path]::GetFullPath([string]$config.InstallRoot)
    $config.InstallRoot = $root
    $config.ConfigDir = Join-Path $root 'config'
    $config.ReleasesDir = Join-Path $root 'releases'
    $config.CurrentLink = Join-Path $root 'current'
    $config.LogsDir = Join-Path $root 'logs'
    $config.ServiceDir = Join-Path $root 'service'
    $config.StateFile = Join-Path $root 'deploy-state.json'
    if (-not $config.ServiceEnvFile) { $config.ServiceEnvFile = Join-Path $config.ConfigDir 'trapezoid.env' }
    # Administrators only: the service account can't read the migration role's password.
    $config.AdminConfigDir = Join-Path $config.ConfigDir 'admin'
    if (-not $config.MigrationEnvFile) { $config.MigrationEnvFile = Join-Path $config.AdminConfigDir 'migrate.env' }
    if ([int]$config.KeepReleases -lt 2) {
        throw 'KeepReleases must be at least 2 (the current release and the one to roll back to)'
    }
    return [pscustomobject]$config
}

# --- Logging -------------------------------------------------------------------------------------

function Write-DeployLog {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Config,
        [Parameter(Mandatory)][string]$Message,
        [ValidateSet('INFO', 'WARN', 'ERROR')][string]$Level = 'INFO'
    )
    $line = '{0} {1} {2}' -f (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz'), $Level, $Message
    switch ($Level) {
        'ERROR' { Write-Host $line -ForegroundColor Red }
        'WARN' { Write-Host $line -ForegroundColor Yellow }
        default { Write-Host $line }
    }
    if (Test-Path -LiteralPath $Config.LogsDir -PathType Container) {
        Add-Content -LiteralPath (Join-Path $Config.LogsDir 'deploy.log') -Value $line -Encoding utf8
    }
}

# --- Releases and the current pointer ------------------------------------------------------------

function Read-TrapezoidRelease {
    <#
    .SYNOPSIS
    Validates a packed release folder (npm run release:pack) and returns its manifest.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

    $manifestPath = Join-Path $Path 'release.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Not a Trapezoid release (no release.json): $Path"
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ([string]$manifest.version -notmatch $script:VersionPattern) {
        throw "release.json has an invalid version"
    }
    foreach ($required in 'apps\api\dist\main.js', 'apps\api\dist\db\cli.js', 'apps\web\dist\index.html') {
        if (-not (Test-Path -LiteralPath (Join-Path $Path $required) -PathType Leaf)) {
            throw "Release $($manifest.version) is incomplete: $required is missing"
        }
    }
    return $manifest
}

function Get-TrapezoidCurrentVersion {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Config)
    $link = Get-Item -LiteralPath $Config.CurrentLink -Force -ErrorAction SilentlyContinue
    if (-not $link) { return $null }
    if ($link.LinkType -ne 'Junction') {
        throw "$($Config.CurrentLink) exists but is not a junction; fix it by hand before deploying"
    }
    return Split-Path -Leaf ([string]$link.Target)
}

function Set-TrapezoidCurrentRelease {
    <#
    .SYNOPSIS
    Points the `current` junction at releases\<version>. Junctions need no elevation.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)][string]$Version)
    $target = Join-Path $Config.ReleasesDir $Version
    if (-not (Test-Path -LiteralPath $target -PathType Container)) {
        throw "Release folder not found: $target"
    }
    $link = Get-Item -LiteralPath $Config.CurrentLink -Force -ErrorAction SilentlyContinue
    if ($link) {
        if ($link.LinkType -ne 'Junction') {
            throw "$($Config.CurrentLink) is not a junction; refusing to replace it"
        }
        # Deletes the link only, never the release it points at.
        $link.Delete()
    }
    New-Item -ItemType Junction -Path $Config.CurrentLink -Target $target | Out-Null
}

function Get-TrapezoidDeployState {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Config)
    if (Test-Path -LiteralPath $Config.StateFile -PathType Leaf) {
        return Get-Content -LiteralPath $Config.StateFile -Raw | ConvertFrom-Json
    }
    return [pscustomobject]@{ Current = $null; Previous = $null; History = @() }
}

function Save-TrapezoidDeployState {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Config,
        [AllowNull()][string]$Current,
        [AllowNull()][string]$Previous,
        [Parameter(Mandatory)][string]$Event
    )
    $old = Get-TrapezoidDeployState -Config $Config
    $history = @($old.History) + [pscustomobject]@{
        At      = (Get-Date).ToString('o')
        Event   = $Event
        Current = $Current
        By      = [Environment]::UserName
    }
    $state = [pscustomobject]@{
        Current  = $Current
        Previous = $Previous
        History  = @($history | Select-Object -Last 50)
    }
    $state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $Config.StateFile -Encoding utf8
}

function Remove-OldTrapezoidReleases {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Config, [string[]]$Keep = @())
    $releases = Get-ChildItem -LiteralPath $Config.ReleasesDir -Directory |
        Sort-Object LastWriteTime -Descending
    $kept = 0
    foreach ($release in $releases) {
        if ($Keep -contains $release.Name -or $kept -lt [int]$Config.KeepReleases) {
            $kept++
            continue
        }
        Write-DeployLog -Config $Config -Message "Removing old release $($release.Name)"
        Remove-Item -LiteralPath $release.FullName -Recurse -Force
    }
}

# --- The service, migrations, backup and health ----------------------------------------------------

function Stop-TrapezoidApp {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Config)
    $service = Get-Service -Name $Config.ServiceName -ErrorAction SilentlyContinue
    if (-not $service) {
        throw "Windows service '$($Config.ServiceName)' is not installed (run Install-TrapezoidHost.ps1)"
    }
    if ($service.Status -ne 'Stopped') {
        # The wrapper sends Ctrl+C; the API drains the print worker and closes the pool first.
        Stop-Service -InputObject $service
        $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds([int]$Config.ServiceStopTimeoutSeconds))
    }
}

function Start-TrapezoidApp {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Config)
    Start-Service -Name $Config.ServiceName
}

function Invoke-TrapezoidMigration {
    <#
    .SYNOPSIS
    Runs the release's migrations as the migration role: DATABASE_URL comes from the migration env
    file (admins only); everything else from the service env file.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)][string]$Version)
    foreach ($file in $Config.MigrationEnvFile, $Config.ServiceEnvFile) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            throw "Env file not found: $file"
        }
    }
    $cli = Join-Path (Join-Path $Config.ReleasesDir $Version) 'apps\api\dist\db\cli.js'
    # Node's --env-file sets DATABASE_URL first; the CLI then loads ENV_FILE, which never overrides a
    # variable that is already set. The service env file goes in ENV_FILE, not the CLI's own
    # --env-file flag: Node also reads an --env-file flag placed after the script name.
    # A DATABASE_URL in this shell would win over both files, so it is cleared for the child.
    $saved = @{ DATABASE_URL = $env:DATABASE_URL; ENV_FILE = $env:ENV_FILE }
    try {
        $env:DATABASE_URL = $null
        $env:ENV_FILE = $Config.ServiceEnvFile
        & $Config.NodeExe "--env-file=$($Config.MigrationEnvFile)" $cli migrate
        if ($LASTEXITCODE -ne 0) {
            throw "Migrations failed (exit code $LASTEXITCODE)"
        }
    } finally {
        $env:DATABASE_URL = $saved.DATABASE_URL
        $env:ENV_FILE = $saved.ENV_FILE
    }
}

function Invoke-TrapezoidBackup {
    <#
    .SYNOPSIS
    Runs the configured pre-deploy backup (TRP-T21). The backup design is deferred (D39), so there is
    no built-in backup: without BackupScript the deploy needs an explicit -SkipBackup.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Config, [switch]$SkipBackup)
    if ([string]::IsNullOrWhiteSpace($Config.BackupScript)) {
        if (-not $SkipBackup) {
            throw 'No BackupScript is configured. Take a backup by hand, then deploy with -SkipBackup.'
        }
        Write-DeployLog -Config $Config -Level WARN -Message 'Backup skipped (-SkipBackup)'
        return
    }
    Write-DeployLog -Config $Config -Message "Backing up with $($Config.BackupScript)"
    & $Config.BackupScript
    if (-not $?) {
        throw 'The backup script failed; nothing was changed'
    }
}

function Wait-TrapezoidHealthy {
    <#
    .SYNOPSIS
    Polls GET /api/health until it answers 200 with status "ok", or the timeout passes.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Config)
    $deadline = (Get-Date).AddSeconds([int]$Config.HealthTimeoutSeconds)
    $last = 'no response'
    do {
        try {
            $response = Invoke-WebRequest -Uri $Config.HealthUrl -TimeoutSec 5 -SkipHttpErrorCheck `
                -MaximumRedirection 0 -ErrorAction Stop
            if ($response.StatusCode -eq 200) {
                $body = $response.Content | ConvertFrom-Json
                if ($body.status -eq 'ok') {
                    return $true
                }
            }
            $last = "HTTP $($response.StatusCode)"
        } catch {
            $last = $_.Exception.Message
        }
        Start-Sleep -Milliseconds 1000
    } while ((Get-Date) -lt $deadline)
    Write-DeployLog -Config $Config -Level WARN -Message "Health check failed: $last"
    return $false
}

# --- Deploy and rollback ---------------------------------------------------------------------------

function Restore-TrapezoidPrevious {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Config, [AllowNull()][string]$Previous, [Parameter(Mandatory)][string]$Failed)
    try { Stop-TrapezoidApp -Config $Config } catch {
        Write-DeployLog -Config $Config -Level WARN -Message "Stopping the failed release: $($_.Exception.Message)"
    }
    if (-not $Previous) {
        Write-DeployLog -Config $Config -Level ERROR -Message "First install of $Failed failed; nothing to roll back to. The service is stopped."
        return 'Failed'
    }
    Write-DeployLog -Config $Config -Level WARN -Message "Rolling back to $Previous"
    Set-TrapezoidCurrentRelease -Config $Config -Version $Previous
    Start-TrapezoidApp -Config $Config
    if (Wait-TrapezoidHealthy -Config $Config) {
        Save-TrapezoidDeployState -Config $Config -Current $Previous -Previous $null -Event "rolled back from $Failed"
        Write-DeployLog -Config $Config -Level WARN -Message "Rolled back to $Previous; it is healthy"
        return 'RolledBack'
    }
    Save-TrapezoidDeployState -Config $Config -Current $Previous -Previous $null -Event "rollback from $Failed unhealthy"
    Write-DeployLog -Config $Config -Level ERROR -Message "Rolled back to $Previous but it is not healthy either. Follow the runbook's recovery steps."
    return 'RollbackFailed'
}

function Invoke-TrapezoidDeploy {
    <#
    .SYNOPSIS
    Back up -> stop -> switch release -> migrate -> start -> health check, rolling back
    automatically to the previous release if migrations or the health check fail.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)]$Config,
        [Parameter(Mandatory)][string]$ReleasePath,
        [switch]$SkipBackup
    )
    $source = (Resolve-Path -LiteralPath $ReleasePath).Path
    $manifest = Read-TrapezoidRelease -Path $source
    $version = [string]$manifest.version
    $previous = Get-TrapezoidCurrentVersion -Config $Config
    $destination = Join-Path $Config.ReleasesDir $version
    if ($previous -eq $version) {
        throw "Release $version is already current"
    }
    if (Test-Path -LiteralPath $destination) {
        throw "Release $version is already on this host; use Deploy-Trapezoid.ps1 -Rollback -ToVersion $version to switch to it"
    }

    $plan = "deploy $version (current: $(if ($previous) { $previous } else { 'none' }))"
    if (-not $PSCmdlet.ShouldProcess($Config.InstallRoot, $plan)) {
        foreach ($step in @(
                "copy $source to $destination",
                $(if ($Config.BackupScript) { "back up with $($Config.BackupScript)" } elseif ($SkipBackup) { 'skip the backup (-SkipBackup)' } else { 'REFUSE: no BackupScript and no -SkipBackup' }),
                "stop service $($Config.ServiceName)",
                "point $($Config.CurrentLink) at $destination",
                "run migrations with $($Config.MigrationEnvFile)",
                "start service $($Config.ServiceName)",
                "wait up to $($Config.HealthTimeoutSeconds) s for 200 from $($Config.HealthUrl)",
                "on failure: roll back to $(if ($previous) { $previous } else { '(nothing: first install)' })")) {
            Write-Host "What if: $step"
        }
        return [pscustomobject]@{ Outcome = 'WhatIf'; Version = $version; Previous = $previous }
    }

    Write-DeployLog -Config $Config -Message "Deploying $version (from $source); current is $(if ($previous) { $previous } else { 'none' })"
    # Backup first: if it fails, nothing has changed yet.
    Invoke-TrapezoidBackup -Config $Config -SkipBackup:$SkipBackup
    Copy-Item -LiteralPath $source -Destination $destination -Recurse
    if ($previous) {
        Write-DeployLog -Config $Config -Message "Stopping $($Config.ServiceName)"
        try {
            Stop-TrapezoidApp -Config $Config
        } catch {
            # Nothing switched yet: forget the copy so the same release can be deployed again.
            Remove-Item -LiteralPath $destination -Recurse -Force
            throw
        }
    }
    try {
        Set-TrapezoidCurrentRelease -Config $Config -Version $version
        Write-DeployLog -Config $Config -Message 'Running migrations'
        Invoke-TrapezoidMigration -Config $Config -Version $version
    } catch {
        Write-DeployLog -Config $Config -Level ERROR -Message "$($_.Exception.Message). Migrations run one file per transaction, so the failed file left no change; earlier files in this release stay applied (restore the pre-deploy backup if the previous release cannot run on them)."
        $outcome = Restore-TrapezoidPrevious -Config $Config -Previous $previous -Failed $version
        return [pscustomobject]@{ Outcome = $outcome; Version = $version; Previous = $previous; Reason = 'migration' }
    }

    Write-DeployLog -Config $Config -Message "Starting $($Config.ServiceName)"
    $started = $true
    try { Start-TrapezoidApp -Config $Config } catch {
        $started = $false
        Write-DeployLog -Config $Config -Level ERROR -Message "Service did not start: $($_.Exception.Message)"
    }
    if ($started -and (Wait-TrapezoidHealthy -Config $Config)) {
        Save-TrapezoidDeployState -Config $Config -Current $version -Previous $previous -Event 'deployed'
        Write-DeployLog -Config $Config -Message "Deployed $version; health check passed"
        Remove-OldTrapezoidReleases -Config $Config -Keep @($version, $previous | Where-Object { $_ })
        return [pscustomobject]@{ Outcome = 'Deployed'; Version = $version; Previous = $previous }
    }
    $outcome = Restore-TrapezoidPrevious -Config $Config -Previous $previous -Failed $version
    return [pscustomobject]@{ Outcome = $outcome; Version = $version; Previous = $previous; Reason = 'health' }
}

function Invoke-TrapezoidRollback {
    <#
    .SYNOPSIS
    Switches back to the previous release (or -ToVersion) by hand. Migrations are forward-only and
    are not reversed; see the runbook before rolling back across a schema change.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)]$Config, [string]$ToVersion)
    $state = Get-TrapezoidDeployState -Config $Config
    $current = Get-TrapezoidCurrentVersion -Config $Config
    $target = if ($ToVersion) { $ToVersion } else { [string]$state.Previous }
    if (-not $target) {
        throw 'No previous release is recorded; name one with -ToVersion'
    }
    if ($target -notmatch $script:VersionPattern -or -not (Test-Path -LiteralPath (Join-Path $Config.ReleasesDir $target) -PathType Container)) {
        throw "Release $target is not on this host"
    }
    if ($target -eq $current) {
        throw "Release $target is already current"
    }
    if (-not $PSCmdlet.ShouldProcess($Config.InstallRoot, "roll back from $current to $target")) {
        return [pscustomobject]@{ Outcome = 'WhatIf'; Version = $target; Previous = $current }
    }
    Write-DeployLog -Config $Config -Message "Manual rollback from $current to $target"
    Stop-TrapezoidApp -Config $Config
    Set-TrapezoidCurrentRelease -Config $Config -Version $target
    Start-TrapezoidApp -Config $Config
    if (Wait-TrapezoidHealthy -Config $Config) {
        Save-TrapezoidDeployState -Config $Config -Current $target -Previous $current -Event 'manual rollback'
        Write-DeployLog -Config $Config -Message "Now running $target; health check passed"
        return [pscustomobject]@{ Outcome = 'RolledBack'; Version = $target; Previous = $current }
    }
    Save-TrapezoidDeployState -Config $Config -Current $target -Previous $current -Event 'manual rollback unhealthy'
    Write-DeployLog -Config $Config -Level ERROR -Message "$target is not healthy after the rollback"
    return [pscustomobject]@{ Outcome = 'RollbackFailed'; Version = $target; Previous = $current }
}

# --- Service wrapper (WinSW) -------------------------------------------------------------------------

function ConvertTo-XmlText([string]$Value) {
    return [System.Security.SecurityElement]::Escape($Value)
}

function Test-PasswordlessServiceAccount([string]$Account) {
    # Virtual accounts (NT SERVICE\name) and group managed service accounts (DOMAIN\name$) have no
    # password to store. Built-in LocalSystem is refused: it is not least privilege.
    return ($Account -match '^NT SERVICE\\[A-Za-z0-9_.-]+$') -or ($Account -match '^[A-Za-z0-9_.-]+\\[A-Za-z0-9_.-]+\$$')
}

function New-TrapezoidServiceXml {
    <#
    .SYNOPSIS
    WinSW 2.x configuration: automatic (delayed) start after PostgreSQL, restart on failure with
    backoff, Ctrl+C on stop so the API drains the print worker, rolling logs.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Config)
    $main = Join-Path $Config.CurrentLink 'apps\api\dist\main.js'
    $workDir = Join-Path $Config.CurrentLink 'apps\api'
    $account = ''
    # An account with a password is entered at install time ('install /p'), never stored here.
    if ($Config.ServiceAccount -and (Test-PasswordlessServiceAccount $Config.ServiceAccount)) {
        $domain, $user = $Config.ServiceAccount -split '\\', 2
        $account = @"

  <serviceaccount>
    <domain>$(ConvertTo-XmlText $domain)</domain>
    <user>$(ConvertTo-XmlText $user)</user>
    <allowservicelogon>true</allowservicelogon>
  </serviceaccount>
"@
    }
    $depend = ''
    if ($Config.PostgresServiceName) {
        $depend = "`n  <depend>$(ConvertTo-XmlText $Config.PostgresServiceName)</depend>"
    }
    return @"
<!-- Generated by Install-TrapezoidHost.ps1 (TRP-T20). Edit host.config.psd1 and re-run instead. -->
<service>
  <id>$(ConvertTo-XmlText $Config.ServiceName)</id>
  <name>$(ConvertTo-XmlText $Config.ServiceName)</name>
  <description>Trapezoid laboratory sample tracking (NestJS API and web app over HTTPS).</description>
  <executable>$(ConvertTo-XmlText $Config.NodeExe)</executable>
  <arguments>"$(ConvertTo-XmlText $main)"</arguments>
  <workingdirectory>$(ConvertTo-XmlText $workDir)</workingdirectory>
  <env name="ENV_FILE" value="$(ConvertTo-XmlText $Config.ServiceEnvFile)" />
  <env name="NODE_ENV" value="production" />
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>$depend
  <onfailure action="restart" delay="10 sec" />
  <onfailure action="restart" delay="30 sec" />
  <onfailure action="restart" delay="2 min" />
  <resetfailure>1 hour</resetfailure>
  <stopparentprocessfirst>true</stopparentprocessfirst>
  <stoptimeout>45 sec</stoptimeout>
  <logpath>$(ConvertTo-XmlText $Config.LogsDir)</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>10</keepFiles>
  </log>$account
</service>
"@
}

# --- Database exposure checks (read-only) -------------------------------------------------------------

function Test-TrapezoidDatabaseExposure {
    <#
    .SYNOPSIS
    Reads postgresql.conf and pg_hba.conf and lists anything that lets other computers reach
    PostgreSQL. Changes nothing. An empty result means local-only.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$DataDir)
    $problems = [System.Collections.Generic.List[string]]::new()
    $conf = Join-Path $DataDir 'postgresql.conf'
    $hba = Join-Path $DataDir 'pg_hba.conf'
    if (-not (Test-Path -LiteralPath $conf -PathType Leaf)) {
        $problems.Add("postgresql.conf not found in $DataDir")
        return , $problems.ToArray()
    }
    $listen = $null
    foreach ($line in Get-Content -LiteralPath $conf) {
        if ($line -match "^\s*listen_addresses\s*=\s*'([^']*)'") { $listen = $Matches[1] }
    }
    if ($null -eq $listen) {
        # PostgreSQL's built-in default is localhost, but the Windows installer writes '*'.
        $problems.Add("postgresql.conf does not set listen_addresses; set listen_addresses = 'localhost'")
    } else {
        foreach ($address in $listen -split ',') {
            $address = $address.Trim()
            if ($address -notin 'localhost', '127.0.0.1', '::1') {
                $problems.Add("listen_addresses includes '$address'; set listen_addresses = 'localhost'")
            }
        }
    }
    if (Test-Path -LiteralPath $hba -PathType Leaf) {
        foreach ($line in Get-Content -LiteralPath $hba) {
            $fields = ($line -replace '#.*$', '').Trim() -split '\s+'
            if ($fields.Count -ge 4 -and $fields[0] -like 'host*') {
                $address = $fields[3]
                if ($address -notin '127.0.0.1/32', '::1/128', 'localhost', 'samehost') {
                    $problems.Add("pg_hba.conf allows $($fields[0]) connections from $address")
                }
                if ($fields.Count -ge 5 -and $fields[4] -eq 'trust') {
                    $problems.Add("pg_hba.conf trusts $address without a password")
                }
            }
        }
    }
    return , $problems.ToArray()
}

Export-ModuleMember -Function Test-TrapezoidDatabaseExposure, Get-TrapezoidHostConfig, Write-DeployLog, Read-TrapezoidRelease,
    Get-TrapezoidCurrentVersion, Set-TrapezoidCurrentRelease, Get-TrapezoidDeployState,
    Save-TrapezoidDeployState, Remove-OldTrapezoidReleases, Stop-TrapezoidApp, Start-TrapezoidApp,
    Invoke-TrapezoidMigration, Invoke-TrapezoidBackup, Wait-TrapezoidHealthy, Invoke-TrapezoidDeploy,
    Invoke-TrapezoidRollback, New-TrapezoidServiceXml, Test-PasswordlessServiceAccount
