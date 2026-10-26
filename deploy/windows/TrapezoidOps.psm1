#Requires -Version 7.2
# Trapezoid backup, restore and monitoring helpers (TRP-T21). Used by backup.ps1, restore.ps1,
# monitor.ps1 and Install-TrapezoidHost.ps1; see docs/operations/runbook.md. Nothing runs on import.
#
# The backup design is deferred to IT (D39): location, owner, RPO/RTO, retention and the alert
# recipient have NO defaults here. Every script refuses to run until backup.config.psd1 sets them.
# Alerts go to the Windows event log (source "Trapezoid") and the status record; the app sends no
# email. Passwords never pass through these scripts: PostgreSQL tools read them from a pgpass file
# (PgPassFile) or the PGPASSWORD of the person running a restore.

Set-StrictMode -Version 3.0

Import-Module (Join-Path $PSScriptRoot 'TrapezoidHosting.psm1')

$script:BackupNamePattern = '^trapezoid-(?<env>[a-z0-9]{1,20})-(?<stamp>\d{8}T\d{6}Z)-(?<version>[0-9A-Za-z.+_-]{1,64})\.dump$'
$script:VersionPattern = '^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$'
$script:DatabaseNamePattern = '^[a-z_][a-z0-9_]{0,62}$'
$script:EventIds = @{
    BackupSucceeded  = 1000
    BackupFailed     = 1001
    MonitorProblem   = 1100
    MonitorRecovered = 1101
    RestoreVerified  = 1200
    RestoreFailed    = 1201
}

# --- Configuration -------------------------------------------------------------------------------

# Decided by IT under D39. No defaults: an empty value stops every script.
$script:D39Settings = @(
    'BackupTarget', 'RpoHours', 'RtoHours', 'KeepDaily', 'KeepWeekly', 'KeepMonthly',
    'BackupOwner', 'AlertRecipient', 'TargetEncryptedAtRest'
)

function Get-TrapezoidBackupConfig {
    <#
    .SYNOPSIS
    Reads backup.config.psd1 (a data file: no code runs), validates it for the given purpose and
    fills in derived paths from the host configuration (TRP-T20).
    .PARAMETER Purpose
    Backup and Monitor need every D39 decision; Restore needs only the database settings; Install
    also needs the backup account and schedule.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [ValidateSet('Backup', 'Monitor', 'Restore', 'Install')][string]$Purpose = 'Backup'
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Backup configuration not found: $Path (copy deploy\windows\backup.config.example.psd1)"
    }
    $data = Import-PowerShellDataFile -LiteralPath $Path
    $config = [ordered]@{
        HostConfigPath          = $null
        EnvironmentName         = 'production'
        # D39 (IT): no defaults.
        BackupTarget            = $null
        RpoHours                = $null
        RtoHours                = $null
        KeepDaily               = $null
        KeepWeekly              = $null
        KeepMonthly             = $null
        BackupOwner             = $null
        AlertRecipient          = $null
        TargetEncryptedAtRest   = $null
        # Scheduled tasks (IT inputs, only needed by Install-TrapezoidHost.ps1).
        BackupAccount           = $null
        BackupTimes             = @()
        MonitorIntervalMinutes  = 5
        PwshExe                 = 'C:\Program Files\PowerShell\7\pwsh.exe'
        # PostgreSQL.
        PgBinDir                = 'C:\Program Files\PostgreSQL\17\bin'
        DbHost                  = '127.0.0.1'
        DbPort                  = 5432
        DbName                  = 'trapezoid'
        DbUser                  = 'trapezoid_backup'
        PgPassFile              = ''
        RestoreAdminUser        = 'postgres'
        # Folders (defaults under <InstallRoot>\ops).
        OpsDir                  = $null
        StagingDir              = $null
        StatusFile              = $null
        MonitorStatusFile       = $null
        OpsLogDir               = $null
        RestoreDrillLog         = $null
        # Monitoring and logs.
        EventLogSource          = 'Trapezoid'
        MinFreeSpaceGB          = 10
        PrintQueueMaxAgeMinutes = 15
        LogMaxSizeMB            = 10
        LogKeepFiles            = 10
    }
    foreach ($key in $data.Keys) {
        if (-not $config.Contains($key)) {
            throw "Unknown setting '$key' in $Path"
        }
        $config[$key] = $data[$key]
    }

    $missing = [System.Collections.Generic.List[string]]::new()
    if ([string]::IsNullOrWhiteSpace([string]$config.HostConfigPath)) { $missing.Add('HostConfigPath') }
    if ($Purpose -ne 'Restore') {
        foreach ($key in $script:D39Settings) {
            $value = $config[$key]
            if ($null -eq $value -or ($value -is [string] -and [string]::IsNullOrWhiteSpace($value))) {
                $missing.Add($key)
            }
        }
    }
    if ($Purpose -eq 'Install') {
        if ([string]::IsNullOrWhiteSpace([string]$config.BackupAccount)) { $missing.Add('BackupAccount') }
        if (@($config.BackupTimes).Count -eq 0) { $missing.Add('BackupTimes') }
    }
    if ($missing.Count -gt 0) {
        throw "Backup configuration is incomplete; IT has to decide (D39) and set: $($missing -join ', '). Nothing was changed."
    }

    if ($Purpose -ne 'Restore') {
        foreach ($key in 'RpoHours', 'RtoHours') {
            if (-not ($config[$key] -is [int] -or $config[$key] -is [double]) -or $config[$key] -le 0) {
                throw "$key must be a number of hours greater than 0"
            }
        }
        foreach ($key in 'KeepDaily', 'KeepWeekly', 'KeepMonthly') {
            if (-not ($config[$key] -is [int]) -or $config[$key] -lt 0) {
                throw "$key must be a whole number (0 or more)"
            }
        }
        if (([int]$config.KeepDaily + [int]$config.KeepWeekly + [int]$config.KeepMonthly) -lt 1) {
            throw 'Retention keeps nothing: set KeepDaily, KeepWeekly or KeepMonthly above 0'
        }
        if ($config.TargetEncryptedAtRest -isnot [bool]) {
            throw 'TargetEncryptedAtRest must be $true or $false'
        }
        if (-not $config.TargetEncryptedAtRest) {
            throw 'TargetEncryptedAtRest is $false: Trapezoid does not encrypt backups itself, so the backup location must be encrypted at rest (e.g. BitLocker or an encrypted NAS share; IT decision, D39)'
        }
    }
    if ([string]$config.EnvironmentName -cnotmatch '^[a-z0-9]{1,20}$') {
        throw 'EnvironmentName must be 1-20 lowercase letters or digits'
    }
    foreach ($key in 'DbName', 'DbUser', 'RestoreAdminUser') {
        if ([string]$config[$key] -cnotmatch $script:DatabaseNamePattern) {
            throw "$key must be lowercase letters, digits and underscores"
        }
    }
    if ([string]$config.DbHost -notmatch '^[A-Za-z0-9.:-]{1,253}$') { throw 'DbHost must be a host name or IP address' }
    if (-not ($config.DbPort -is [int]) -or $config.DbPort -lt 1 -or $config.DbPort -gt 65535) { throw 'DbPort must be a port number' }
    foreach ($time in @($config.BackupTimes)) {
        if ([string]$time -notmatch '^([01]\d|2[0-3]):[0-5]\d$') { throw "BackupTimes entry '$time' must look like 02:30" }
    }

    $hostConfig = Get-TrapezoidHostConfig -Path ([string]$config.HostConfigPath)
    $config.Host = $hostConfig
    if (-not $config.OpsDir) { $config.OpsDir = Join-Path $hostConfig.InstallRoot 'ops' }
    if (-not $config.StagingDir) { $config.StagingDir = Join-Path $config.OpsDir 'staging' }
    if (-not $config.StatusFile) { $config.StatusFile = Join-Path (Join-Path $config.OpsDir 'status') 'backup-status.json' }
    if (-not $config.MonitorStatusFile) { $config.MonitorStatusFile = Join-Path (Join-Path $config.OpsDir 'status') 'monitor-status.json' }
    if (-not $config.OpsLogDir) { $config.OpsLogDir = Join-Path $config.OpsDir 'logs' }
    if (-not $config.RestoreDrillLog) { $config.RestoreDrillLog = Join-Path $config.OpsLogDir 'restore-drills.jsonl' }
    $config.ConfigPath = [System.IO.Path]::GetFullPath($Path)
    return [pscustomobject]$config
}

# --- Logs, rotation and alerts ---------------------------------------------------------------------

function Write-TrapezoidOpsLog {
    <#
    .SYNOPSIS
    Appends a line to <OpsLogDir>\<Log>.log (rotated by size) and echoes it.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Config,
        [Parameter(Mandatory)][ValidateSet('backup', 'restore', 'monitor')][string]$Log,
        [Parameter(Mandatory)][string]$Message,
        [ValidateSet('INFO', 'WARN', 'ERROR')][string]$Level = 'INFO'
    )
    $line = '{0} {1} {2}' -f (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz'), $Level, $Message
    switch ($Level) {
        'ERROR' { Write-Host $line -ForegroundColor Red }
        'WARN' { Write-Host $line -ForegroundColor Yellow }
        default { Write-Host $line }
    }
    if (Test-Path -LiteralPath $Config.OpsLogDir -PathType Container) {
        $file = Join-Path $Config.OpsLogDir "$Log.log"
        Invoke-TrapezoidLogRotation -Path $file -MaxSizeMB $Config.LogMaxSizeMB -KeepFiles $Config.LogKeepFiles
        Add-Content -LiteralPath $file -Value $line -Encoding utf8
    }
}

function Write-TrapezoidEventLog {
    <#
    .SYNOPSIS
    Writes to the Windows Application log under the registered source. Never registers a source
    (Install-TrapezoidHost.ps1 does that, elevated): if it is missing, says so and returns $false.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][ValidateSet('Information', 'Warning', 'Error')][string]$EntryType,
        [Parameter(Mandatory)][int]$EventId,
        [Parameter(Mandatory)][string]$Message
    )
    # Reading the registry needs no elevation, unlike EventLog.SourceExists.
    if (-not (Test-Path -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\EventLog\Application\$Source")) {
        Write-Warning "Event log source '$Source' is not registered (run Install-TrapezoidHost.ps1 -BackupConfigPath ...); alert recorded in the status file only"
        return $false
    }
    [System.Diagnostics.EventLog]::WriteEntry($Source, $Message, [System.Diagnostics.EventLogEntryType]$EntryType, $EventId)
    return $true
}

function Send-TrapezoidAlert {
    <#
    .SYNOPSIS
    Raises an alert through the channel IT approved: the Windows event log (which IT's monitoring
    forwards to the agreed recipient) plus the status record. No email from the app (TRP-T21).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Config,
        [Parameter(Mandatory)][ValidateSet('Information', 'Warning', 'Error')][string]$EntryType,
        [Parameter(Mandatory)][string]$Event,
        [Parameter(Mandatory)][string]$Message
    )
    $text = "$Message`r`nOwner: $($Config.BackupOwner). Alert recipient: $($Config.AlertRecipient). Runbook: docs\operations\runbook.md"
    try {
        $null = Write-TrapezoidEventLog -Source $Config.EventLogSource -EntryType $EntryType -EventId $script:EventIds[$Event] -Message $text
    } catch {
        Write-Warning "Could not write to the Windows event log: $($_.Exception.Message)"
    }
}

# --- Small helpers ---------------------------------------------------------------------------------

function ConvertTo-UtcText([datetime]$Time) {
    return $Time.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [cultureinfo]::InvariantCulture)
}

function Save-JsonAtomically {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Value)
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $temp = "$Path.tmp"
    $Value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temp -Encoding utf8
    Move-Item -LiteralPath $temp -Destination $Path -Force
}

function Get-TrapezoidReleaseVersion {
    <#
    .SYNOPSIS
    Version of the release the service runs (current\release.json), or 'unknown'.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Config)
    $manifest = Join-Path $Config.Host.CurrentLink 'release.json'
    if (Test-Path -LiteralPath $manifest -PathType Leaf) {
        try {
            $version = [string](Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).version
            if ($version -match $script:VersionPattern) { return $version }
        } catch {
            Write-Verbose "release.json unreadable: $($_.Exception.Message)"
        }
    }
    return 'unknown'
}

function Get-TrapezoidFreeSpace {
    <#
    .SYNOPSIS
    Free and total bytes of the drive holding Path, or $null (e.g. a UNC share) where unknown.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)
    try {
        $root = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($Path))
        if ($root -notmatch '^[A-Za-z]:\\?$') { return $null }
        $drive = [System.IO.DriveInfo]::new($root)
        if (-not $drive.IsReady) { return $null }
        return [pscustomobject]@{ FreeBytes = $drive.AvailableFreeSpace; TotalBytes = $drive.TotalSize }
    } catch {
        return $null
    }
}

function Invoke-TrapezoidPgTool {
    <#
    .SYNOPSIS
    Runs a PostgreSQL client tool non-interactively (-w: never prompts for a password). The
    password comes from PgPassFile or the caller's PGPASSWORD, never from this script.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Config,
        [Parameter(Mandatory)][ValidateSet('pg_dump', 'pg_restore', 'psql')][string]$Tool,
        [Parameter(Mandatory)][string[]]$Arguments
    )
    $exe = Join-Path $Config.PgBinDir "$Tool.exe"
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
        throw "$Tool not found in PgBinDir ($($Config.PgBinDir))"
    }
    $savedPassFile = $env:PGPASSFILE
    try {
        if ($Config.PgPassFile) { $env:PGPASSFILE = $Config.PgPassFile }
        $output = & $exe -w @Arguments 2>&1
        $code = $LASTEXITCODE
    } finally {
        $env:PGPASSFILE = $savedPassFile
    }
    $lines = @($output | ForEach-Object { [string]$_ })
    $stdout = @($output | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } | ForEach-Object { [string]$_ })
    $stderr = @($output | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { [string]$_ })
    return [pscustomobject]@{ ExitCode = $code; Output = $stdout; Errors = $stderr; All = $lines }
}

function Get-ConnectionArgs($Config, [string]$User, [string]$Database) {
    return @('-h', [string]$Config.DbHost, '-p', [string]$Config.DbPort, '-U', $User, '-d', $Database)
}

function Invoke-TrapezoidVerification {
    <#
    .SYNOPSIS
    Runs verify-restore.sql (read-only) and returns its "check|value" lines.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)][string]$User, [Parameter(Mandatory)][string]$Database)
    $sql = Join-Path $PSScriptRoot 'verify-restore.sql'
    $result = Invoke-TrapezoidPgTool -Config $Config -Tool psql -Arguments (@('-X', '-q', '-A', '-t', '-F', '|', '-v', 'ON_ERROR_STOP=1') + (Get-ConnectionArgs $Config $User $Database) + @('-f', $sql))
    if ($result.ExitCode -ne 0) {
        throw "Verification queries failed on $Database (psql exit code $($result.ExitCode)): $(($result.Errors | Select-Object -First 3) -join ' ')"
    }
    return @($result.Output | Where-Object { $_ -and $_.Trim() })
}

function Compare-TrapezoidVerification {
    <#
    .SYNOPSIS
    Line-by-line differences between two verification outputs (empty = they match).
    #>
    [CmdletBinding()]
    param([string[]]$Expected = @(), [string[]]$Actual = @())
    $toMap = {
        param($lines)
        $map = [ordered]@{}
        foreach ($line in $lines) {
            $key, $value = $line -split '\|', 2
            $map[$key] = $value
        }
        $map
    }
    $want = & $toMap $Expected
    $got = & $toMap $Actual
    $differences = [System.Collections.Generic.List[string]]::new()
    foreach ($key in $want.Keys) {
        if (-not $got.Contains($key)) {
            $differences.Add("$key missing after restore (expected $($want[$key]))")
        } elseif ($got[$key] -ne $want[$key]) {
            $differences.Add("$key is $($got[$key]), expected $($want[$key])")
        }
    }
    foreach ($key in $got.Keys) {
        if (-not $want.Contains($key)) { $differences.Add("$key only after restore ($($got[$key]))") }
    }
    return $differences.ToArray()
}

# --- Retention -----------------------------------------------------------------------------------

function Get-TrapezoidBackupSet {
    <#
    .SYNOPSIS
    Complete backups in a folder for one environment (a .dump with its .sha256), newest first.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$EnvironmentName)
    $sets = foreach ($file in Get-ChildItem -LiteralPath $Path -File -Filter 'trapezoid-*.dump') {
        if ($file.Name -cnotmatch $script:BackupNamePattern -or $Matches.env -ne $EnvironmentName) { continue }
        $base = $file.Name.Substring(0, $file.Name.Length - '.dump'.Length)
        if (-not (Test-Path -LiteralPath (Join-Path $Path "$base.sha256") -PathType Leaf)) { continue }
        [pscustomobject]@{
            Base = $base
            Time = [datetime]::ParseExact($Matches.stamp, "yyyyMMdd'T'HHmmss'Z'", [cultureinfo]::InvariantCulture,
                [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal)
        }
    }
    return @($sets | Sort-Object Time -Descending)
}

function Select-TrapezoidBackupsToKeep {
    <#
    .SYNOPSIS
    Grandfather-father-son retention: every backup from the last 24 hours, plus the newest backup
    of each of the last KeepDaily days, KeepWeekly ISO weeks and KeepMonthly months (host's local
    calendar). The newest backup is always kept. Returns the base names to keep.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Backups,
        [Parameter(Mandatory)][int]$KeepDaily,
        [Parameter(Mandatory)][int]$KeepWeekly,
        [Parameter(Mandatory)][int]$KeepMonthly,
        [datetime]$Now = (Get-Date)
    )
    $sorted = @($Backups | Sort-Object Time -Descending)
    $keep = [System.Collections.Generic.HashSet[string]]::new()
    if ($sorted.Count -eq 0) { return @() }
    $null = $keep.Add($sorted[0].Base)
    $nowUtc = $Now.ToUniversalTime()
    foreach ($backup in $sorted) {
        if (($nowUtc - $backup.Time).TotalHours -lt 24) { $null = $keep.Add($backup.Base) }
    }
    $buckets = @(
        @{ Count = $KeepDaily; Key = { param($t) $t.ToString('yyyy-MM-dd') } },
        @{ Count = $KeepWeekly; Key = { param($t) '{0}-W{1:00}' -f [System.Globalization.ISOWeek]::GetYear($t), [System.Globalization.ISOWeek]::GetWeekOfYear($t) } },
        @{ Count = $KeepMonthly; Key = { param($t) $t.ToString('yyyy-MM') } }
    )
    foreach ($bucket in $buckets) {
        $seen = [System.Collections.Generic.HashSet[string]]::new()
        foreach ($backup in $sorted) {
            if ($seen.Count -ge $bucket.Count) { break }
            $key = & $bucket.Key $backup.Time.ToLocalTime()
            if ($seen.Add($key)) { $null = $keep.Add($backup.Base) }
        }
    }
    return @($keep)
}

# --- Backup ----------------------------------------------------------------------------------------

function Get-RedactedEnvText {
    <#
    .SYNOPSIS
    An env file with every secret value replaced, so configuration can travel with the backup.
    Secrets are recovered from the password manager entry IT owns (runbook).
    #>
    param([Parameter(Mandatory)][string]$Path)
    $out = foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') {
            $key = $Matches[1]
            $value = $Matches[2]
            if ($key -match 'SECRET|PASSWORD|PASSPHRASE|TOKEN|CREDENTIAL') {
                if ($value.Trim()) { "$key=<redacted: see the password manager>" } else { "$key=" }
            } elseif ($value -match '://[^/@\s]*:[^/@\s]*@') {
                "$key=$($value -replace '://([^/:@\s]*):[^/@\s]*@', '://$1:<redacted>@')"
            } else {
                $line
            }
        } else {
            $line
        }
    }
    return ($out -join "`r`n")
}

function New-TrapezoidConfigBundle {
    <#
    .SYNOPSIS
    Zips the host and backup configuration, the redacted service env file and release.json.
    #>
    param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)][string]$Destination)
    $work = Join-Path $Config.StagingDir ("config-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work | Out-Null
    try {
        if (Test-Path -LiteralPath $Config.Host.StateFile -PathType Leaf) {
            Copy-Item -LiteralPath $Config.Host.StateFile -Destination (Join-Path $work 'deploy-state.json')
        }
        Copy-Item -LiteralPath ([string]$Config.HostConfigPath) -Destination (Join-Path $work 'host.config.psd1')
        Copy-Item -LiteralPath $Config.ConfigPath -Destination (Join-Path $work 'backup.config.psd1')
        if (Test-Path -LiteralPath $Config.Host.ServiceEnvFile -PathType Leaf) {
            Set-Content -LiteralPath (Join-Path $work 'trapezoid.env.redacted') -Value (Get-RedactedEnvText -Path $Config.Host.ServiceEnvFile) -Encoding utf8
        }
        $release = Join-Path $Config.Host.CurrentLink 'release.json'
        if (Test-Path -LiteralPath $release -PathType Leaf) {
            Copy-Item -LiteralPath $release -Destination (Join-Path $work 'release.json')
        }
        Set-Content -LiteralPath (Join-Path $work 'README.txt') -Encoding utf8 -Value @(
            'Trapezoid configuration at backup time (TRP-T21). Secrets are NOT included:'
            'restore them from the password manager entry IT owns (docs\operations\runbook.md).'
        )
        Compress-Archive -Path (Join-Path $work '*') -DestinationPath $Destination -Force
    } finally {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Save-TrapezoidBackupStatus {
    <#
    .SYNOPSIS
    Writes the status record the API shows (Settings → System status) and the monitor checks.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)]$Run, $TargetSpace)
    $previous = $null
    if (Test-Path -LiteralPath $Config.StatusFile -PathType Leaf) {
        try { $previous = Get-Content -LiteralPath $Config.StatusFile -Raw | ConvertFrom-Json } catch { $previous = $null }
    }
    $lastSuccess = if ($Run.result -eq 'success') { $Run } elseif ($previous -and $previous.PSObject.Properties['lastSuccess']) { $previous.lastSuccess } else { $null }
    $history = @()
    if ($previous -and $previous.PSObject.Properties['history']) { $history = @($previous.history) }
    $history = @(@($history) + [pscustomobject]@{ startedAt = $Run.startedAt; finishedAt = $Run.finishedAt; result = $Run.result; message = $Run.message; file = $Run.file } | Select-Object -Last 30)
    $status = [ordered]@{
        schemaVersion  = 1
        lastRun        = $Run
        lastSuccess    = $lastSuccess
        rpoHours       = $Config.RpoHours
        rtoHours       = $Config.RtoHours
        owner          = [string]$Config.BackupOwner
        alertRecipient = [string]$Config.AlertRecipient
        target         = if ($TargetSpace) { [ordered]@{ freeBytes = $TargetSpace.FreeBytes; totalBytes = $TargetSpace.TotalBytes } } else { $null }
        history        = $history
    }
    Save-JsonAtomically -Path $Config.StatusFile -Value $status
}

function Invoke-TrapezoidBackupRun {
    <#
    .SYNOPSIS
    One backup: verification manifest -> pg_dump (custom format) -> manifest again -> config
    bundle -> SHA-256 file -> copy to the backup location -> re-check the checksum there ->
    retention -> status record and event log. Returns the run record.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)]$Config, [string]$Reason = 'Scheduled')

    $started = Get-Date
    $version = Get-TrapezoidReleaseVersion -Config $Config
    $base = 'trapezoid-{0}-{1}-{2}' -f $Config.EnvironmentName, $started.ToUniversalTime().ToString("yyyyMMdd'T'HHmmss'Z'"), $version
    $files = [ordered]@{
        Dump     = "$base.dump"
        Manifest = "$base.manifest.json"
        Bundle   = "$base.config.zip"
        Checksum = "$base.sha256"
    }
    if (-not $PSCmdlet.ShouldProcess($Config.BackupTarget, "back up database $($Config.DbName) as $($files.Dump)")) {
        foreach ($step in @(
                "run verify-restore.sql on $($Config.DbName) as $($Config.DbUser) (read-only)",
                "pg_dump --format=custom $($Config.DbName) -> $(Join-Path $Config.StagingDir $files.Dump)",
                "zip host/backup configuration, redacted trapezoid.env and release.json -> $($files.Bundle)",
                "write SHA-256 checksums -> $($files.Checksum)",
                "copy to $($Config.BackupTarget) and re-check the checksum there",
                "keep the last 24 h plus $($Config.KeepDaily) daily, $($Config.KeepWeekly) weekly, $($Config.KeepMonthly) monthly; delete older trapezoid-$($Config.EnvironmentName)-* backups there",
                "write the status record $($Config.StatusFile)",
                "on failure: Windows event log ($($Config.EventLogSource), event $($script:EventIds.BackupFailed)) for $($Config.AlertRecipient)")) {
            Write-Host "What if: $step"
        }
        return [pscustomobject]@{ result = 'whatif'; file = $files.Dump }
    }

    foreach ($dir in $Config.StagingDir, $Config.OpsLogDir) {
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    }
    $log = { param($message, $level = 'INFO') Write-TrapezoidOpsLog -Config $Config -Log backup -Message $message -Level $level }
    & $log "Backup started ($Reason): $($Config.DbName) -> $($Config.BackupTarget) as $base"
    $staged = @($files.Values | ForEach-Object { Join-Path $Config.StagingDir $_ })
    $sizeBytes = $null
    $targetSpace = $null
    try {
        $connection = Get-ConnectionArgs $Config $Config.DbUser $Config.DbName
        $before = Invoke-TrapezoidVerification -Config $Config -User $Config.DbUser -Database $Config.DbName

        $dumpPath = Join-Path $Config.StagingDir $files.Dump
        $dump = Invoke-TrapezoidPgTool -Config $Config -Tool pg_dump -Arguments (@('--format=custom', '--file', $dumpPath) + $connection)
        if ($dump.ExitCode -ne 0) {
            throw "pg_dump failed (exit code $($dump.ExitCode)): $(($dump.Errors | Select-Object -First 3) -join ' ')"
        }
        $sizeBytes = (Get-Item -LiteralPath $dumpPath).Length
        if ($sizeBytes -le 0) { throw 'pg_dump wrote an empty file' }

        # Counts taken just before and after the dump. Equal (audit events are append-only and
        # every change writes one) means the dump holds exactly these values.
        $after = Invoke-TrapezoidVerification -Config $Config -User $Config.DbUser -Database $Config.DbName
        $stable = (@(Compare-TrapezoidVerification -Expected $before -Actual $after).Count -eq 0)
        if (-not $stable) { & $log 'Data changed while the dump ran; the restore check will report the differences' 'WARN' }
        Save-JsonAtomically -Path (Join-Path $Config.StagingDir $files.Manifest) -Value ([ordered]@{
                createdAt = ConvertTo-UtcText $started
                database  = $Config.DbName
                version   = $version
                stable    = $stable
                checks    = @($after)
            })

        New-TrapezoidConfigBundle -Config $Config -Destination (Join-Path $Config.StagingDir $files.Bundle)
        $sums = foreach ($name in $files.Dump, $files.Manifest, $files.Bundle) {
            '{0} *{1}' -f (Get-FileHash -LiteralPath (Join-Path $Config.StagingDir $name) -Algorithm SHA256).Hash.ToLowerInvariant(), $name
        }
        Set-Content -LiteralPath (Join-Path $Config.StagingDir $files.Checksum) -Value $sums -Encoding ascii

        if (-not (Test-Path -LiteralPath $Config.BackupTarget -PathType Container)) {
            throw "Backup location unavailable: $($Config.BackupTarget)"
        }
        # Copy under a .partial name, then rename, so an interrupted copy never looks complete. The
        # checksum file goes last: a backup without one is ignored by retention and restore.
        foreach ($name in $files.Dump, $files.Manifest, $files.Bundle, $files.Checksum) {
            $partial = Join-Path $Config.BackupTarget "$name.partial"
            Copy-Item -LiteralPath (Join-Path $Config.StagingDir $name) -Destination $partial -Force
            Move-Item -LiteralPath $partial -Destination (Join-Path $Config.BackupTarget $name) -Force
        }
        $check = Test-TrapezoidBackupChecksum -DumpPath (Join-Path $Config.BackupTarget $files.Dump)
        if (-not $check.Valid) { throw "Checksum mismatch at the backup location: $($check.Problem)" }

        $sets = Get-TrapezoidBackupSet -Path $Config.BackupTarget -EnvironmentName $Config.EnvironmentName
        $keep = Select-TrapezoidBackupsToKeep -Backups $sets -KeepDaily $Config.KeepDaily -KeepWeekly $Config.KeepWeekly -KeepMonthly $Config.KeepMonthly
        foreach ($set in $sets) {
            if ($keep -contains $set.Base) { continue }
            & $log "Retention: deleting $($set.Base)"
            foreach ($suffix in '.dump', '.manifest.json', '.config.zip', '.sha256') {
                Remove-Item -LiteralPath (Join-Path $Config.BackupTarget "$($set.Base)$suffix") -Force -ErrorAction SilentlyContinue
            }
        }
        foreach ($path in $staged) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
        $targetSpace = Get-TrapezoidFreeSpace -Path $Config.BackupTarget
        $result = 'success'
        $message = "Backup copied and verified ($([math]::Round($sizeBytes / 1MB, 1)) MB$(if (-not $stable) { '; data changed during the dump' }))"
    } catch {
        $result = 'failed'
        $message = $_.Exception.Message
        # Keep only this run's local copy (it can be copied by hand); older staged runs go.
        Get-ChildItem -LiteralPath $Config.StagingDir -File -Filter 'trapezoid-*' -ErrorAction SilentlyContinue |
            Where-Object { -not $_.Name.StartsWith($base) } |
            Remove-Item -Force -ErrorAction SilentlyContinue
        $targetSpace = Get-TrapezoidFreeSpace -Path $Config.BackupTarget
    }
    $run = [ordered]@{
        startedAt  = ConvertTo-UtcText $started
        finishedAt = ConvertTo-UtcText (Get-Date)
        result     = $result
        message    = $message
        file       = if ($result -eq 'success') { $files.Dump } else { $null }
        sizeBytes  = if ($result -eq 'success') { $sizeBytes } else { $null }
        version    = $version
    }
    Save-TrapezoidBackupStatus -Config $Config -Run $run -TargetSpace $targetSpace
    if ($result -eq 'success') {
        & $log "Backup succeeded: $($files.Dump)"
        Send-TrapezoidAlert -Config $Config -EntryType Information -Event BackupSucceeded -Message "Trapezoid backup succeeded: $($files.Dump)"
    } else {
        & $log "Backup FAILED: $message" 'ERROR'
        Send-TrapezoidAlert -Config $Config -EntryType Error -Event BackupFailed -Message "Trapezoid backup FAILED: $message"
    }
    return [pscustomobject]$run
}

function Test-TrapezoidBackupChecksum {
    <#
    .SYNOPSIS
    Checks every file listed in <base>.sha256 next to a dump. The dump itself must be listed.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$DumpPath)
    $dir = Split-Path -Parent $DumpPath
    $name = Split-Path -Leaf $DumpPath
    if ($name -notmatch '\.dump$') { return [pscustomobject]@{ Valid = $false; Problem = 'not a .dump file' } }
    $sumFile = Join-Path $dir ($name -replace '\.dump$', '.sha256')
    if (-not (Test-Path -LiteralPath $sumFile -PathType Leaf)) {
        return [pscustomobject]@{ Valid = $false; Problem = "no checksum file ($(Split-Path -Leaf $sumFile))" }
    }
    $listed = @{}
    foreach ($line in Get-Content -LiteralPath $sumFile) {
        if ($line -match '^([0-9a-fA-F]{64}) \*?(.+)$') { $listed[$Matches[2].Trim()] = $Matches[1].ToLowerInvariant() }
    }
    if (-not $listed.ContainsKey($name)) { return [pscustomobject]@{ Valid = $false; Problem = "$name is not listed in the checksum file" } }
    foreach ($file in $listed.Keys) {
        if ($file -match '[\\/]') { return [pscustomobject]@{ Valid = $false; Problem = "unexpected path in checksum file: $file" } }
        $path = Join-Path $dir $file
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return [pscustomobject]@{ Valid = $false; Problem = "$file is missing" } }
        $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $listed[$file]) { return [pscustomobject]@{ Valid = $false; Problem = "$file does not match its SHA-256" } }
    }
    return [pscustomobject]@{ Valid = $true; Problem = $null }
}

# --- Restore ---------------------------------------------------------------------------------------

function Assert-TrapezoidRestoreTarget {
    <#
    .SYNOPSIS
    Refuses any restore target that is not a new, clearly named scratch database: never the
    configured production database, a system database, or anything without "restore" in its name.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)][string]$TargetDatabase)
    if ($TargetDatabase -cnotmatch $script:DatabaseNamePattern) {
        throw "Target database '$TargetDatabase' must be lowercase letters, digits and underscores (max 63)"
    }
    if ($TargetDatabase -ieq [string]$Config.DbName) {
        throw "Refusing to restore into '$TargetDatabase': it is the production database (DbName). Restores only go into a new, isolated database."
    }
    if ($TargetDatabase -in 'postgres', 'template0', 'template1') {
        throw "Refusing to restore into the system database '$TargetDatabase'"
    }
    if ($TargetDatabase -notmatch 'restore') {
        throw "Target database '$TargetDatabase' must contain 'restore' in its name (e.g. trapezoid_restore_20261026), so it can't be mistaken for production"
    }
}

function Invoke-TrapezoidRestoreRun {
    <#
    .SYNOPSIS
    Restore drill: checksum -> refuse unsafe targets -> CREATE DATABASE (new only) -> pg_restore
    -> verify-restore.sql -> compare with the backup's manifest -> drill record and event log.
    Never touches the production database and never uses --clean.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)]$Config,
        [Parameter(Mandatory)][string]$BackupFile,
        [Parameter(Mandatory)][string]$TargetDatabase,
        [switch]$DropAfterVerify,
        # Keep owners and grants (trapezoid_owner, trapezoid_app, ...; the roles must exist): for a
        # copy that may later replace production by the runbook's manual recovery steps.
        [switch]$KeepOwnership
    )
    $restoreOptions = if ($KeepOwnership) { @('--exit-on-error') } else { @('--no-owner', '--no-privileges', '--exit-on-error') }
    Assert-TrapezoidRestoreTarget -Config $Config -TargetDatabase $TargetDatabase
    $dumpPath = (Resolve-Path -LiteralPath $BackupFile -ErrorAction Stop).Path
    $check = Test-TrapezoidBackupChecksum -DumpPath $dumpPath
    if (-not $check.Valid) { throw "Backup failed its checksum check: $($check.Problem)" }
    $manifestPath = $dumpPath -replace '\.dump$', '.manifest.json'
    $manifest = if (Test-Path -LiteralPath $manifestPath -PathType Leaf) { Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } else { $null }

    $admin = [string]$Config.RestoreAdminUser
    $exists = Invoke-TrapezoidPgTool -Config $Config -Tool psql -Arguments (@('-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1') + (Get-ConnectionArgs $Config $admin 'postgres') + @('-c', "SELECT count(*) FROM pg_database WHERE datname = '$TargetDatabase'"))
    if ($exists.ExitCode -ne 0) {
        throw "Could not connect as $admin (set PGPASSWORD or PgPassFile): $(($exists.Errors | Select-Object -First 2) -join ' ')"
    }
    if (($exists.Output -join '').Trim() -ne '0') {
        throw "Database '$TargetDatabase' already exists. Restores only go into a NEW database; pick another name."
    }
    if (-not $PSCmdlet.ShouldProcess($TargetDatabase, "create a new database and restore $(Split-Path -Leaf $dumpPath) into it")) {
        foreach ($step in @(
                "checksum OK: $(Split-Path -Leaf $dumpPath)",
                "CREATE DATABASE $TargetDatabase (as $admin)",
                "pg_restore $($restoreOptions -join ' ') into $TargetDatabase",
                "run verify-restore.sql on $TargetDatabase and compare with $(if ($manifest) { Split-Path -Leaf $manifestPath } else { '(no manifest: report only)' })",
                "append the drill record to $($Config.RestoreDrillLog)",
                $(if ($DropAfterVerify) { "DROP DATABASE $TargetDatabase afterwards" } else { "leave $TargetDatabase for inspection (drop it by hand afterwards)" }))) {
            Write-Host "What if: $step"
        }
        return [pscustomobject]@{ Result = 'whatif'; Differences = @() }
    }

    if (-not (Test-Path -LiteralPath $Config.OpsLogDir -PathType Container)) { New-Item -ItemType Directory -Path $Config.OpsLogDir -Force | Out-Null }
    $log = { param($message, $level = 'INFO') Write-TrapezoidOpsLog -Config $Config -Log restore -Message $message -Level $level }
    $started = Get-Date
    & $log "Restore drill: $(Split-Path -Leaf $dumpPath) -> new database $TargetDatabase"
    $created = $false
    $differences = @()
    try {
        $create = Invoke-TrapezoidPgTool -Config $Config -Tool psql -Arguments (@('-X', '-q', '-v', 'ON_ERROR_STOP=1') + (Get-ConnectionArgs $Config $admin 'postgres') + @('-c', "CREATE DATABASE `"$TargetDatabase`""))
        if ($create.ExitCode -ne 0) { throw "CREATE DATABASE failed: $(($create.Errors | Select-Object -First 2) -join ' ')" }
        $created = $true
        $restore = Invoke-TrapezoidPgTool -Config $Config -Tool pg_restore -Arguments ($restoreOptions + (Get-ConnectionArgs $Config $admin $TargetDatabase) + @($dumpPath))
        if ($restore.ExitCode -ne 0) { throw "pg_restore failed (exit code $($restore.ExitCode)): $(($restore.Errors | Select-Object -First 3) -join ' ')" }
        $actual = Invoke-TrapezoidVerification -Config $Config -User $admin -Database $TargetDatabase
        foreach ($line in $actual) { & $log "  $line" }
        if ($manifest) {
            $differences = @(Compare-TrapezoidVerification -Expected @($manifest.checks) -Actual $actual)
            $result = if ($differences.Count -eq 0) { 'verified' } else { 'mismatch' }
            if ($differences.Count -gt 0 -and -not $manifest.stable) {
                $differences = @($differences) + 'note: data changed while this backup was taken, so small count differences are expected'
            }
        } else {
            $result = 'restored-unverified'
        }
    } catch {
        $result = 'failed'
        $differences = @($_.Exception.Message)
    } finally {
        if ($created -and $DropAfterVerify) {
            $drop = Invoke-TrapezoidPgTool -Config $Config -Tool psql -Arguments (@('-X', '-q') + (Get-ConnectionArgs $Config $admin 'postgres') + @('-c', "DROP DATABASE IF EXISTS `"$TargetDatabase`""))
            if ($drop.ExitCode -ne 0) { & $log "Could not drop $TargetDatabase; drop it by hand" 'WARN' }
        }
    }
    $duration = (Get-Date) - $started
    $record = [ordered]@{
        at              = ConvertTo-UtcText $started
        by              = [Environment]::UserName
        backup          = Split-Path -Leaf $dumpPath
        targetDatabase  = $TargetDatabase
        durationSeconds = [math]::Round($duration.TotalSeconds)
        result          = $result
        differences     = @($differences)
        dropped         = [bool]($created -and $DropAfterVerify)
    }
    Add-Content -LiteralPath $Config.RestoreDrillLog -Value ($record | ConvertTo-Json -Compress -Depth 4) -Encoding utf8
    $summary = "Restore drill $result in $([math]::Round($duration.TotalMinutes, 1)) min: $($record.backup) -> $TargetDatabase"
    if ($result -eq 'verified') {
        & $log $summary
        Send-TrapezoidAlert -Config $Config -EntryType Information -Event RestoreVerified -Message $summary
    } else {
        foreach ($difference in $differences) { & $log "  $difference" 'WARN' }
        & $log $summary 'ERROR'
        Send-TrapezoidAlert -Config $Config -EntryType Error -Event RestoreFailed -Message "$summary`r`n$($differences -join "`r`n")"
    }
    return [pscustomobject]@{ Result = $result; Differences = @($differences); DurationSeconds = $record.durationSeconds }
}

# --- Monitoring ------------------------------------------------------------------------------------

function Invoke-TrapezoidMonitorRun {
    <#
    .SYNOPSIS
    Health check (every 5 minutes by default): service, /api/health, latest backup age against the
    RPO and its result, oldest queued print job, disk space on the host and backup location.
    Alerts only when a problem appears (and once when all is clear again).
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Config, [datetime]$Now = (Get-Date))
    $problems = [System.Collections.Generic.List[string]]::new()
    $checks = [ordered]@{}

    $service = Get-Service -Name $Config.Host.ServiceName -ErrorAction SilentlyContinue
    $checks.service = if ($service) { [string]$service.Status } else { 'not installed' }
    if (-not $service -or $service.Status -ne 'Running') { $problems.Add("Service $($Config.Host.ServiceName) is $($checks.service)") }

    try {
        $response = Invoke-WebRequest -Uri $Config.Host.HealthUrl -TimeoutSec 10 -SkipHttpErrorCheck -MaximumRedirection 0 -ErrorAction Stop
        $body = try { $response.Content | ConvertFrom-Json } catch { $null }
        $checks.health = "HTTP $($response.StatusCode)"
        if ($response.StatusCode -ne 200 -or -not $body -or $body.status -ne 'ok') {
            $problems.Add("Health check: HTTP $($response.StatusCode)$(if ($body -and $body.PSObject.Properties['database']) { ", database $($body.database)" })")
        }
    } catch {
        $checks.health = 'no response'
        $problems.Add("Health check: no response from $($Config.Host.HealthUrl)")
    }

    $status = $null
    if (Test-Path -LiteralPath $Config.StatusFile -PathType Leaf) {
        try { $status = Get-Content -LiteralPath $Config.StatusFile -Raw | ConvertFrom-Json } catch { $status = $null }
    }
    if (-not $status) {
        $checks.backup = 'no status record'
        $problems.Add('Backup: no status record yet (has the backup task run?)')
    } else {
        if ($status.lastRun.result -eq 'failed') { $problems.Add("Backup: last run failed: $($status.lastRun.message)") }
        $lastSuccess = if ($status.lastSuccess) { [datetime]::Parse([string]$status.lastSuccess.finishedAt, [cultureinfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AdjustToUniversal) } else { $null }
        $checks.backup = if ($lastSuccess) { "last success $(ConvertTo-UtcText $lastSuccess)" } else { 'never succeeded' }
        if (-not $lastSuccess -or ($Now.ToUniversalTime() - $lastSuccess).TotalHours -gt [double]$Config.RpoHours) {
            $problems.Add("Backup: no successful backup within the RPO ($($Config.RpoHours) h)")
        }
    }

    $queue = Invoke-TrapezoidPgTool -Config $Config -Tool psql -Arguments (@('-X', '-q', '-A', '-t') + (Get-ConnectionArgs $Config $Config.DbUser $Config.DbName) + @('-c', "SELECT coalesce(floor(extract(epoch FROM now() - min(created_at)) / 60)::int, -1) FROM print_job WHERE status = 'queued'"))
    if ($queue.ExitCode -eq 0) {
        $minutes = [int](($queue.Output -join '').Trim())
        $checks.printQueueOldestMinutes = $minutes
        if ($minutes -gt [int]$Config.PrintQueueMaxAgeMinutes) {
            $problems.Add("Print queue: a label job has waited $minutes min (limit $($Config.PrintQueueMaxAgeMinutes))")
        }
    } else {
        $checks.printQueueOldestMinutes = $null
        $problems.Add('Print queue: could not query the database as the backup role')
    }

    $disks = [ordered]@{
        host   = $Config.Host.InstallRoot
        target = [string]$Config.BackupTarget
    }
    if ($Config.Host.PostgresDataDir) { $disks.database = [string]$Config.Host.PostgresDataDir }
    $checks.disks = [ordered]@{}
    foreach ($name in $disks.Keys) {
        $space = Get-TrapezoidFreeSpace -Path $disks[$name]
        if ($space) {
            $freeGB = [math]::Round($space.FreeBytes / 1GB, 1)
            $checks.disks[$name] = $freeGB
            if ($freeGB -lt [double]$Config.MinFreeSpaceGB) { $problems.Add("Disk space: $freeGB GB free for $name ($($disks[$name])); minimum $($Config.MinFreeSpaceGB) GB") }
        } elseif ($name -eq 'target' -and -not (Test-Path -LiteralPath $disks[$name])) {
            $checks.disks[$name] = $null
            $problems.Add("Backup location unavailable: $($disks[$name])")
        }
    }

    $previous = @()
    if (Test-Path -LiteralPath $Config.MonitorStatusFile -PathType Leaf) {
        try { $previous = @((Get-Content -LiteralPath $Config.MonitorStatusFile -Raw | ConvertFrom-Json).problems) } catch { $previous = @() }
    }
    $new = @($problems | Where-Object { $previous -notcontains $_ })
    Save-JsonAtomically -Path $Config.MonitorStatusFile -Value ([ordered]@{
            checkedAt = ConvertTo-UtcText $Now
            ok        = ($problems.Count -eq 0)
            problems  = @($problems)
            checks    = $checks
        })
    if (-not (Test-Path -LiteralPath $Config.OpsLogDir -PathType Container)) { New-Item -ItemType Directory -Path $Config.OpsLogDir -Force | Out-Null }
    if ($new.Count -gt 0) {
        foreach ($problem in $new) { Write-TrapezoidOpsLog -Config $Config -Log monitor -Level WARN -Message $problem }
        Send-TrapezoidAlert -Config $Config -EntryType Warning -Event MonitorProblem -Message "Trapezoid monitoring found a problem:`r`n$($new -join "`r`n")"
    } elseif ($problems.Count -eq 0 -and $previous.Count -gt 0) {
        Write-TrapezoidOpsLog -Config $Config -Log monitor -Message 'All checks pass again'
        Send-TrapezoidAlert -Config $Config -EntryType Information -Event MonitorRecovered -Message 'Trapezoid monitoring: all checks pass again'
    }
    return [pscustomobject]@{ Ok = ($problems.Count -eq 0); Problems = @($problems); New = $new; Checks = $checks }
}

# --- Scheduled tasks (registered by Install-TrapezoidHost.ps1) ----------------------------------------

function Get-TrapezoidScheduledTaskPlan {
    <#
    .SYNOPSIS
    The scheduled tasks Install-TrapezoidHost.ps1 registers: the backup at BackupTimes and the
    monitor every MonitorIntervalMinutes, both as BackupAccount, whether or not anyone is signed in.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Config)
    $scripts = Join-Path $Config.Host.CurrentLink 'deploy\windows'
    $common = "-NoProfile -NonInteractive -File"
    return @(
        [pscustomobject]@{
            Name        = 'Trapezoid Backup'
            Path        = '\Trapezoid\'
            Description = "pg_dump of $($Config.DbName) to $($Config.BackupTarget) (TRP-T21). Owner: $($Config.BackupOwner)."
            Execute     = $Config.PwshExe
            Arguments   = "$common `"$(Join-Path $scripts 'backup.ps1')`" -ConfigPath `"$($Config.ConfigPath)`""
            Times       = @($Config.BackupTimes)
            EveryMinutes = $null
            TimeLimit   = [TimeSpan]::FromHours(2)
        },
        [pscustomobject]@{
            Name        = 'Trapezoid Monitor'
            Path        = '\Trapezoid\'
            Description = 'Service, health, backup age, print queue and disk space checks (TRP-T21).'
            Execute     = $Config.PwshExe
            Arguments   = "$common `"$(Join-Path $scripts 'monitor.ps1')`" -ConfigPath `"$($Config.ConfigPath)`""
            Times       = @()
            EveryMinutes = [int]$Config.MonitorIntervalMinutes
            TimeLimit   = [TimeSpan]::FromMinutes(4)
        }
    )
}

Export-ModuleMember -Function Get-TrapezoidBackupConfig, Write-TrapezoidOpsLog, Write-TrapezoidEventLog,
    Send-TrapezoidAlert, Get-TrapezoidReleaseVersion, Get-TrapezoidFreeSpace, Invoke-TrapezoidPgTool,
    Invoke-TrapezoidVerification, Compare-TrapezoidVerification, Get-TrapezoidBackupSet,
    Select-TrapezoidBackupsToKeep, Get-RedactedEnvText, Save-TrapezoidBackupStatus,
    Invoke-TrapezoidBackupRun, Test-TrapezoidBackupChecksum, Assert-TrapezoidRestoreTarget,
    Invoke-TrapezoidRestoreRun, Invoke-TrapezoidMonitorRun, Get-TrapezoidScheduledTaskPlan
