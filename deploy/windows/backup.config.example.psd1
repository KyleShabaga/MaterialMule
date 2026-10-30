# Material Mule backup, restore and monitoring configuration (MM-T21).
#
# ============================== PROPOSAL, PENDING IT (D39) ==============================
# The backup design is IT's decision (App Idea D39). The values IT must decide are left EMPTY
# below on purpose: backup.ps1, monitor.ps1 and the scheduled-task install refuse to run until
# every one is set. The "Proposal" comments are the card's proposals only; they are not
# decisions and must not be copied in without IT's approval.
# =========================================================================================
#
# Copy to <InstallRoot>\config\backup.config.psd1 on the host (Administrators: full; the backup
# account: read). This is a data file: PowerShell reads it without running code. No secrets: the
# backup role's password lives in a pgpass file (PgPassFile) readable only by the backup account.
@{
    # The MM-T20 host configuration (install root, current release, service, health URL).
    HostConfigPath          = 'C:\MaterialMule\config\host.config.psd1'
    # Goes into backup file names: materialmule-<env>-<UTC timestamp>-<version>.dump
    EnvironmentName         = 'production'

    # --- IT DECISIONS (D39): all required, no defaults -------------------------------------------
    # Separate device or approved location (D25), e.g. a dedicated USB drive or a NAS share that
    # only the backup account and IT can write to. Proposal: none (IT chooses the hardware).
    BackupTarget            = ''
    # Recovery point objective in hours: Settings -> System status and the monitor warn when the
    # last successful backup is older. Proposal: 24 (ideally 4-hourly dumps or hourly WAL).
    RpoHours                = $null
    # Recovery time objective in hours (recorded; the restore drill measures against it).
    # Proposal: 4.
    RtoHours                = $null
    # Retention: every backup from the last 24 h, plus the newest of each of the last N days,
    # ISO weeks and months. Proposal: 14 daily, 8 weekly, 12 monthly.
    KeepDaily               = $null
    KeepWeekly              = $null
    KeepMonthly             = $null
    # Who owns backups and restore drills, and who receives alerts. Alerts are written to the
    # Windows event log (source MaterialMule); IT's monitoring forwards them. No email from the app.
    BackupOwner             = ''
    AlertRecipient          = ''
    # $true only once IT confirms the location is encrypted at rest (BitLocker, encrypted NAS
    # volume, ...). Material Mule does not encrypt backups itself; $false refuses to run.
    TargetEncryptedAtRest   = $null

    # --- Scheduled tasks (IT inputs; needed by Install-MaterialMuleHost.ps1 -BackupConfigPath) -----
    # Windows account both tasks run as: a gMSA ('DOMAIN\svc-materialmule-bk$', preferred) or a local
    # standard user. It needs write access to BackupTarget and read access to PgPassFile; the install
    # gives it read access to <InstallRoot> (the release's scripts) and to the files directly in
    # config\ (this file, host.config.psd1, materialmule.env), never config\admin\ or tls\.
    BackupAccount           = ''
    # Local times the backup runs, matching the RPO. Proposal: @('02:00') for a 24 h RPO, or
    # @('02:00', '06:00', '10:00', '14:00', '18:00', '22:00') for 4-hourly dumps.
    BackupTimes             = @()
    MonitorIntervalMinutes  = 5
    PwshExe                 = 'C:\Program Files\PowerShell\7\pwsh.exe'

    # --- PostgreSQL ----------------------------------------------------------------------------
    PgBinDir                = 'C:\Program Files\PostgreSQL\17\bin'
    DbHost                  = '127.0.0.1'
    DbPort                  = 5432
    # The production database: restore.ps1 refuses to restore into it.
    DbName                  = 'materialmule'
    # Read-only role created by: cli.js setup-roles materialmule_owner materialmule_app materialmule_backup
    DbUser                  = 'materialmule_backup'
    # pgpass file with the backup role's password (runbook). Empty: PostgreSQL's default
    # (%APPDATA%\postgresql\pgpass.conf of the account running the task).
    PgPassFile              = 'C:\MaterialMule\config\backup\pgpass.conf'
    # Role restore.ps1 uses to create the scratch database (password typed by the person).
    RestoreAdminUser        = 'postgres'

    # --- Folders (defaults shown; under <InstallRoot>\ops, readable by Administrators and the
    # backup account only, except status\ which the service account reads). Outside ops\ the
    # backup account reads <InstallRoot> and the files directly in config\, nothing else under
    # config\ (Install-MaterialMuleHost.ps1 -BackupConfigPath) -------------------------------------
    # StagingDir            = 'C:\MaterialMule\ops\staging'
    # StatusFile            = 'C:\MaterialMule\ops\status\backup-status.json'   (BACKUP_STATUS_FILE)
    # MonitorStatusFile     = 'C:\MaterialMule\ops\status\monitor-status.json'
    # OpsLogDir             = 'C:\MaterialMule\ops\logs'
    # RestoreDrillLog       = 'C:\MaterialMule\ops\logs\restore-drills.jsonl'

    # --- Monitoring thresholds and log rotation --------------------------------------------------
    EventLogSource          = 'MaterialMule'
    MinFreeSpaceGB          = 10
    PrintQueueMaxAgeMinutes = 15
    LogMaxSizeMB            = 10
    LogKeepFiles            = 10
}
