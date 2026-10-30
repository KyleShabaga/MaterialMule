#Requires -Version 7.2
# Material Mule Windows hosting helpers (MM-T20). Used by Deploy-MaterialMule.ps1 and
# Install-MaterialMuleHost.ps1; see docs/operations/runbook.md. Nothing here runs on import.

Set-StrictMode -Version 3.0

$script:VersionPattern = '^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$'

# --- Configuration -------------------------------------------------------------------------------

function Get-MaterialMuleHostConfig {
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
        ServiceName             = 'MaterialMule'
        NodeExe                 = 'C:\Program Files\nodejs\node.exe'
        ServiceEnvFile          = $null
        MigrationEnvFile        = $null
        HealthUrl               = $null
        HealthTimeoutSeconds    = 90
        ServiceStopTimeoutSeconds = 60
        KeepReleases            = 5
        BackupScript            = ''
        BackupConfig            = ''
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
    if (-not $config.ServiceEnvFile) { $config.ServiceEnvFile = Join-Path $config.ConfigDir 'materialmule.env' }
    # Administrators only: the service account can't read the migration role's password.
    $config.AdminConfigDir = Join-Path $config.ConfigDir 'admin'
    if (-not $config.MigrationEnvFile) { $config.MigrationEnvFile = Join-Path $config.AdminConfigDir 'migrate.env' }
    if ([int]$config.KeepReleases -lt 2) {
        throw 'KeepReleases must be at least 2 (the current release and the one to roll back to)'
    }
    return [pscustomobject]$config
}

# --- Logging -------------------------------------------------------------------------------------

function Invoke-MaterialMuleLogRotation {
    <#
    .SYNOPSIS
    Size-based rotation for the scripts' own logs (MM-T21): when Path reaches MaxSizeMB it becomes
    <name>.1<ext>, older copies shift up and copies beyond KeepFiles are deleted. The service's logs
    are rotated by WinSW (10 MB, 10 kept); PostgreSQL's by its own settings (runbook).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [double]$MaxSizeMB = 10,
        [int]$KeepFiles = 10
    )
    $file = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
    if (-not $file -or $file.Length -lt ($MaxSizeMB * 1MB)) { return }
    $dir = $file.DirectoryName
    $stem = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
    $ext = $file.Extension
    $numbered = { param($n) Join-Path $dir "$stem.$n$ext" }
    Remove-Item -LiteralPath (& $numbered $KeepFiles) -Force -ErrorAction SilentlyContinue
    for ($n = $KeepFiles - 1; $n -ge 1; $n--) {
        $from = & $numbered $n
        if (Test-Path -LiteralPath $from) { Move-Item -LiteralPath $from -Destination (& $numbered ($n + 1)) -Force }
    }
    Move-Item -LiteralPath $file.FullName -Destination (& $numbered 1) -Force
}

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
        $deployLog = Join-Path $Config.LogsDir 'deploy.log'
        Invoke-MaterialMuleLogRotation -Path $deployLog -MaxSizeMB 10 -KeepFiles 5
        Add-Content -LiteralPath $deployLog -Value $line -Encoding utf8
    }
}

# --- Releases and the current pointer ------------------------------------------------------------

function Read-MaterialMuleRelease {
    <#
    .SYNOPSIS
    Validates a packed release folder (npm run release:pack) and returns its manifest.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

    $manifestPath = Join-Path $Path 'release.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Not a Material Mule release (no release.json): $Path"
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

function Get-MaterialMuleCurrentVersion {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Config)
    $link = Get-Item -LiteralPath $Config.CurrentLink -Force -ErrorAction SilentlyContinue
    if (-not $link) { return $null }
    if ($link.LinkType -ne 'Junction') {
        throw "$($Config.CurrentLink) exists but is not a junction; fix it by hand before deploying"
    }
    return Split-Path -Leaf ([string]$link.Target)
}

function Set-MaterialMuleCurrentRelease {
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

function Get-MaterialMuleDeployState {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Config)
    if (Test-Path -LiteralPath $Config.StateFile -PathType Leaf) {
        return Get-Content -LiteralPath $Config.StateFile -Raw | ConvertFrom-Json
    }
    return [pscustomobject]@{ Current = $null; Previous = $null; History = @() }
}

function Save-MaterialMuleDeployState {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Config,
        [AllowNull()][string]$Current,
        [AllowNull()][string]$Previous,
        [Parameter(Mandatory)][string]$Event
    )
    $old = Get-MaterialMuleDeployState -Config $Config
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

function Remove-OldMaterialMuleReleases {
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

function Stop-MaterialMuleApp {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Config)
    $service = Get-Service -Name $Config.ServiceName -ErrorAction SilentlyContinue
    if (-not $service) {
        throw "Windows service '$($Config.ServiceName)' is not installed (run Install-MaterialMuleHost.ps1)"
    }
    if ($service.Status -ne 'Stopped') {
        # The wrapper sends Ctrl+C; the API drains the print worker and closes the pool first.
        Stop-Service -InputObject $service
        $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds([int]$Config.ServiceStopTimeoutSeconds))
    }
}

function Start-MaterialMuleApp {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Config)
    Start-Service -Name $Config.ServiceName
}

function Invoke-MaterialMuleMigration {
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

function Invoke-MaterialMuleBackup {
    <#
    .SYNOPSIS
    Runs the configured pre-deploy backup (MM-T21). The backup design is deferred (D39), so there is
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
    # A script that ends without `exit` leaves LASTEXITCODE alone; don't inherit a stale value.
    $global:LASTEXITCODE = 0
    if ($Config.BackupConfig) {
        # backup.ps1 (MM-T21) takes its settings from backup.config.psd1.
        & $Config.BackupScript -ConfigPath $Config.BackupConfig -Reason PreDeploy
    } else {
        & $Config.BackupScript
    }
    if (-not $? -or $LASTEXITCODE -ne 0) {
        throw 'The backup script failed; nothing was changed'
    }
}

function Wait-MaterialMuleHealthy {
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

function Restore-MaterialMulePrevious {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Config, [AllowNull()][string]$Previous, [Parameter(Mandatory)][string]$Failed)
    try { Stop-MaterialMuleApp -Config $Config } catch {
        Write-DeployLog -Config $Config -Level WARN -Message "Stopping the failed release: $($_.Exception.Message)"
    }
    if (-not $Previous) {
        Write-DeployLog -Config $Config -Level ERROR -Message "First install of $Failed failed; nothing to roll back to. The service is stopped."
        return 'Failed'
    }
    Write-DeployLog -Config $Config -Level WARN -Message "Rolling back to $Previous"
    Set-MaterialMuleCurrentRelease -Config $Config -Version $Previous
    Start-MaterialMuleApp -Config $Config
    if (Wait-MaterialMuleHealthy -Config $Config) {
        Save-MaterialMuleDeployState -Config $Config -Current $Previous -Previous $null -Event "rolled back from $Failed"
        Write-DeployLog -Config $Config -Level WARN -Message "Rolled back to $Previous; it is healthy"
        return 'RolledBack'
    }
    Save-MaterialMuleDeployState -Config $Config -Current $Previous -Previous $null -Event "rollback from $Failed unhealthy"
    Write-DeployLog -Config $Config -Level ERROR -Message "Rolled back to $Previous but it is not healthy either. Follow the runbook's recovery steps."
    return 'RollbackFailed'
}

function Invoke-MaterialMuleDeploy {
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
    $manifest = Read-MaterialMuleRelease -Path $source
    $version = [string]$manifest.version
    $previous = Get-MaterialMuleCurrentVersion -Config $Config
    $destination = Join-Path $Config.ReleasesDir $version
    if ($previous -eq $version) {
        throw "Release $version is already current"
    }
    if (Test-Path -LiteralPath $destination) {
        throw "Release $version is already on this host; use Deploy-MaterialMule.ps1 -Rollback -ToVersion $version to switch to it"
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
    Invoke-MaterialMuleBackup -Config $Config -SkipBackup:$SkipBackup
    Copy-Item -LiteralPath $source -Destination $destination -Recurse
    if ($previous) {
        Write-DeployLog -Config $Config -Message "Stopping $($Config.ServiceName)"
        try {
            Stop-MaterialMuleApp -Config $Config
        } catch {
            # Nothing switched yet: forget the copy so the same release can be deployed again.
            Remove-Item -LiteralPath $destination -Recurse -Force
            throw
        }
    }
    try {
        Set-MaterialMuleCurrentRelease -Config $Config -Version $version
        Write-DeployLog -Config $Config -Message 'Running migrations'
        Invoke-MaterialMuleMigration -Config $Config -Version $version
    } catch {
        Write-DeployLog -Config $Config -Level ERROR -Message "$($_.Exception.Message). Migrations run one file per transaction, so the failed file left no change; earlier files in this release stay applied (restore the pre-deploy backup if the previous release cannot run on them)."
        $outcome = Restore-MaterialMulePrevious -Config $Config -Previous $previous -Failed $version
        return [pscustomobject]@{ Outcome = $outcome; Version = $version; Previous = $previous; Reason = 'migration' }
    }

    Write-DeployLog -Config $Config -Message "Starting $($Config.ServiceName)"
    $started = $true
    try { Start-MaterialMuleApp -Config $Config } catch {
        $started = $false
        Write-DeployLog -Config $Config -Level ERROR -Message "Service did not start: $($_.Exception.Message)"
    }
    if ($started -and (Wait-MaterialMuleHealthy -Config $Config)) {
        Save-MaterialMuleDeployState -Config $Config -Current $version -Previous $previous -Event 'deployed'
        Write-DeployLog -Config $Config -Message "Deployed $version; health check passed"
        Remove-OldMaterialMuleReleases -Config $Config -Keep @($version, $previous | Where-Object { $_ })
        return [pscustomobject]@{ Outcome = 'Deployed'; Version = $version; Previous = $previous }
    }
    $outcome = Restore-MaterialMulePrevious -Config $Config -Previous $previous -Failed $version
    return [pscustomobject]@{ Outcome = $outcome; Version = $version; Previous = $previous; Reason = 'health' }
}

function Invoke-MaterialMuleRollback {
    <#
    .SYNOPSIS
    Switches back to the previous release (or -ToVersion) by hand. Migrations are forward-only and
    are not reversed; see the runbook before rolling back across a schema change.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)]$Config, [string]$ToVersion)
    $state = Get-MaterialMuleDeployState -Config $Config
    $current = Get-MaterialMuleCurrentVersion -Config $Config
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
    Stop-MaterialMuleApp -Config $Config
    Set-MaterialMuleCurrentRelease -Config $Config -Version $target
    Start-MaterialMuleApp -Config $Config
    if (Wait-MaterialMuleHealthy -Config $Config) {
        Save-MaterialMuleDeployState -Config $Config -Current $target -Previous $current -Event 'manual rollback'
        Write-DeployLog -Config $Config -Message "Now running $target; health check passed"
        return [pscustomobject]@{ Outcome = 'RolledBack'; Version = $target; Previous = $current }
    }
    Save-MaterialMuleDeployState -Config $Config -Current $target -Previous $current -Event 'manual rollback unhealthy'
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

function New-MaterialMuleServiceXml {
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
<!-- Generated by Install-MaterialMuleHost.ps1 (MM-T20). Edit host.config.psd1 and re-run instead. -->
<service>
  <id>$(ConvertTo-XmlText $Config.ServiceName)</id>
  <name>$(ConvertTo-XmlText $Config.ServiceName)</name>
  <description>Material Mule laboratory sample tracking (NestJS API and web app over HTTPS).</description>
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

function Test-MaterialMuleDatabaseExposure {
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

function Test-MaterialMulePgHbaAuthMethod {
    <#
    .SYNOPSIS
    Reads pg_hba.conf and lists every host line (host, hostssl, hostnossl, ...) whose method is not
    scram-sha-256 (or reject): md5, password and trust send or skip passwords. Changes nothing.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$DataDir)
    $problems = [System.Collections.Generic.List[string]]::new()
    $hba = Join-Path $DataDir 'pg_hba.conf'
    if (-not (Test-Path -LiteralPath $hba -PathType Leaf)) {
        $problems.Add("pg_hba.conf not found in $DataDir")
        return , $problems.ToArray()
    }
    foreach ($line in Get-Content -LiteralPath $hba) {
        $fields = @(($line -replace '#.*$', '').Trim() -split '\s+' | Where-Object { $_ })
        if ($fields.Count -lt 5 -or $fields[0] -notlike 'host*') { continue }
        # host DATABASE USER ADDRESS [MASK] METHOD [OPTIONS]: an IP address and a separate mask
        # (127.0.0.1 255.255.255.255) push the method one field along.
        $methodIndex = if ($fields[4] -match '^(\d{1,3}\.){3}\d{1,3}$|^[0-9A-Fa-f]*:[0-9A-Fa-f:]*$') { 5 } else { 4 }
        if ($fields.Count -le $methodIndex) { continue }
        $method = $fields[$methodIndex]
        if ($method -notin 'scram-sha-256', 'reject') {
            $problems.Add("pg_hba.conf $($fields[0]) line for $($fields[3]) uses '$method'; use scram-sha-256")
        }
    }
    return , $problems.ToArray()
}

function Get-MaterialMuleDatabaseFirewallRule {
    <#
    .SYNOPSIS
    Enabled inbound Allow firewall rules for the database port (TCP 5432, alone or in a range).
    Read-only. Install-MaterialMuleHost.ps1 and Test-MaterialMuleSecurity.ps1 both use it.
    #>
    [CmdletBinding()]
    param([int]$Port = 5432)
    $opensPort = {
        param($localPort)
        foreach ($entry in @($localPort)) {
            $text = [string]$entry
            if ($text -eq [string]$Port) { return $true }
            if ($text -match '^(\d+)-(\d+)$' -and [int]$Matches[1] -le $Port -and $Port -le [int]$Matches[2]) { return $true }
        }
        return $false
    }
    $rules = Get-NetFirewallPortFilter -Protocol TCP -ErrorAction SilentlyContinue |
        Where-Object { & $opensPort $_.LocalPort } |
        Get-NetFirewallRule -ErrorAction SilentlyContinue |
        Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' }
    return , @($rules | Where-Object { $_ })
}

# --- Host security checks (MM-T68, read-only) ---------------------------------------------------------

# Well-known SIDs, so the checks work whatever language Windows is installed in.
$script:WellKnownSid = @{
    Administrators     = 'S-1-5-32-544'
    System             = 'S-1-5-18'
    Everyone           = 'S-1-1-0'
    Users              = 'S-1-5-32-545'
    AuthenticatedUsers = 'S-1-5-11'
    Anonymous          = 'S-1-5-7'
    Guests             = 'S-1-5-32-546'
}

function ConvertTo-MaterialMuleSid {
    <#
    .SYNOPSIS
    An identity (SecurityIdentifier, SID string or account name) as a SID string; an account name
    Windows cannot resolve is returned upper-cased so it still compares equal to itself.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][object]$Identity)
    if ($Identity -is [System.Security.Principal.SecurityIdentifier]) { return $Identity.Value }
    if ($Identity -is [System.Security.Principal.NTAccount]) { $Identity = $Identity.Value }
    $text = ([string]$Identity).Trim()
    if ($text -match '^S-1-[0-9-]+$') { return $text.ToUpperInvariant() }
    try {
        return ([System.Security.Principal.NTAccount]::new($text)).Translate(
            [System.Security.Principal.SecurityIdentifier]).Value
    } catch {
        return $text.ToUpperInvariant()
    }
}

function Format-MaterialMuleIdentity([string]$Sid) {
    if ($Sid -notmatch '^S-1-') { return $Sid }
    try {
        return ([System.Security.Principal.SecurityIdentifier]::new($Sid)).Translate(
            [System.Security.Principal.NTAccount]).Value
    } catch {
        return $Sid
    }
}

function Get-MaterialMuleAclRules {
    <#
    .SYNOPSIS
    The access rules (explicit and inherited) on a file or folder, with SIDs as identities.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { throw "not found: $Path" }
    $acl = Get-Acl -LiteralPath $Path
    return , @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
}

function Test-MaterialMuleAcl {
    <#
    .SYNOPSIS
    Evaluates access rules (from Get-MaterialMuleAclRules, or fabricated objects with
    IdentityReference, FileSystemRights and AccessControlType) and lists problems. Pure: reads
    nothing from disk.
    .PARAMETER AllowedIdentities
    When given, an Allow rule for anyone else is a problem.
    .PARAMETER ForbiddenReaders
    Identities that must not be able to read.
    .PARAMETER RequiredReader
    An identity that must be able to read.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Rules,
        [string[]]$AllowedIdentities,
        [string[]]$ForbiddenReaders = @(),
        [string]$RequiredReader
    )
    $problems = [System.Collections.Generic.List[string]]::new()
    $allowed = @($AllowedIdentities | Where-Object { $_ } | ForEach-Object { ConvertTo-MaterialMuleSid $_ })
    $forbidden = @($ForbiddenReaders | Where-Object { $_ } | ForEach-Object { ConvertTo-MaterialMuleSid $_ })
    $required = if ($RequiredReader) { ConvertTo-MaterialMuleSid $RequiredReader } else { $null }
    $requiredFound = $false
    $reported = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($rule in $Rules) {
        if ([string]$rule.AccessControlType -ne 'Allow') { continue }
        $sid = ConvertTo-MaterialMuleSid $rule.IdentityReference
        $rights = [int][System.Security.AccessControl.FileSystemRights]$rule.FileSystemRights
        if ($rights -eq 0) { continue }
        # ReadData, or the generic rights an inheritable ACE can carry (GenericAll, GenericRead).
        $canRead = ($rights -band 0x1) -or ($rights -band 0x10000000) -or ($rights -lt 0)
        $name = Format-MaterialMuleIdentity $sid
        if ($null -ne $AllowedIdentities -and $sid -notin $allowed -and $reported.Add("other:$sid")) {
            $problems.Add("$name has access ($([System.Security.AccessControl.FileSystemRights]$rights))")
        }
        if ($canRead -and $sid -in $forbidden -and $reported.Add("read:$sid")) {
            $problems.Add("$name can read it")
        }
        if ($canRead -and $required -and $sid -eq $required) { $requiredFound = $true }
    }
    if ($required -and -not $requiredFound) {
        $problems.Add("$(Format-MaterialMuleIdentity $required) cannot read it")
    }
    return , $problems.ToArray()
}

function Get-MaterialMuleAclExpectation {
    <#
    .SYNOPSIS
    What the Permissions step of Install-MaterialMuleHost.ps1 grants, as checks for
    Test-MaterialMuleAcl: config\admin and the migration env file Administrators and SYSTEM only;
    config and the service env file unreadable by Everyone, Users, Authenticated Users, Anonymous
    and Guests; the service account able to read the service env file.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Config)
    $adminsAndSystem = @($script:WellKnownSid.Administrators, $script:WellKnownSid.System)
    $broad = @($script:WellKnownSid.Everyone, $script:WellKnownSid.Users, $script:WellKnownSid.AuthenticatedUsers,
        $script:WellKnownSid.Anonymous, $script:WellKnownSid.Guests)
    return @(
        [pscustomobject]@{ Name = 'acl-admin-config-dir'; Path = $Config.AdminConfigDir; AllowedIdentities = $adminsAndSystem; ForbiddenReaders = @(); RequiredReader = $null }
        [pscustomobject]@{ Name = 'acl-migration-env-file'; Path = $Config.MigrationEnvFile; AllowedIdentities = $adminsAndSystem; ForbiddenReaders = @(); RequiredReader = $null }
        [pscustomobject]@{ Name = 'acl-config-dir'; Path = $Config.ConfigDir; AllowedIdentities = $null; ForbiddenReaders = $broad; RequiredReader = $null }
        [pscustomobject]@{ Name = 'acl-service-env-file'; Path = $Config.ServiceEnvFile; AllowedIdentities = $null; ForbiddenReaders = $broad; RequiredReader = [string]$Config.ServiceAccount }
    )
}

function Read-MaterialMuleEnvFile {
    <#
    .SYNOPSIS
    Parses a dotenv-style file (KEY=VALUE lines, # comments, optional quotes) into a hashtable.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)
    $values = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        $text = $line.Trim()
        if (-not $text -or $text.StartsWith('#')) { continue }
        $text = $text -replace '^export\s+', ''
        if ($text -notmatch '^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { continue }
        $key = $Matches[1]
        $value = $Matches[2].Trim()
        if ($value -match '^"(.*)"$' -or $value -match "^'(.*)'$") {
            $value = $Matches[1]
        } else {
            $value = ($value -replace '\s+#.*$', '').Trim()
        }
        $values[$key] = $value
    }
    return $values
}

function Get-MaterialMuleDatabaseUrlUser {
    <#
    .SYNOPSIS
    The user name in a postgres:// connection string, or $null when it names none. Never returns
    or prints the password.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Url)
    if ($Url -notmatch '^postgres(ql)?://(.*)$') { return $null }
    $rest = $Matches[2]
    $at = $rest.IndexOf('@')
    if ($at -ge 0) {
        $user = ($rest.Substring(0, $at) -split ':', 2)[0]
        if ($user) { return [System.Uri]::UnescapeDataString($user) }
    }
    if ($rest -match '[?&]user=([^&]+)') { return [System.Uri]::UnescapeDataString($Matches[1]) }
    return $null
}

Export-ModuleMember -Function Invoke-MaterialMuleLogRotation, Test-MaterialMuleDatabaseExposure, Get-MaterialMuleHostConfig, Write-DeployLog, Read-MaterialMuleRelease,
    Test-MaterialMulePgHbaAuthMethod, Get-MaterialMuleDatabaseFirewallRule, ConvertTo-MaterialMuleSid,
    Get-MaterialMuleAclRules, Test-MaterialMuleAcl, Get-MaterialMuleAclExpectation, Read-MaterialMuleEnvFile,
    Get-MaterialMuleDatabaseUrlUser,
    Get-MaterialMuleCurrentVersion, Set-MaterialMuleCurrentRelease, Get-MaterialMuleDeployState,
    Save-MaterialMuleDeployState, Remove-OldMaterialMuleReleases, Stop-MaterialMuleApp, Start-MaterialMuleApp,
    Invoke-MaterialMuleMigration, Invoke-MaterialMuleBackup, Wait-MaterialMuleHealthy, Invoke-MaterialMuleDeploy,
    Invoke-MaterialMuleRollback, New-MaterialMuleServiceXml, Test-PasswordlessServiceAccount
