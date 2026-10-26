# Trapezoid host configuration (TRP-T20). Copy to <InstallRoot>\config\host.config.psd1 on the host
# and fill in the values marked IT INPUT. This is a data file: PowerShell reads it without running
# code. It holds no secrets; those live in the env files below.
@{
    # Where releases, configuration, logs and the service wrapper live.
    InstallRoot             = 'C:\Trapezoid'
    # Windows service name (also the WinSW id).
    ServiceName             = 'Trapezoid'
    # Node.js 24 LTS, installed by hand (runbook step 1).
    NodeExe                 = 'C:\Program Files\nodejs\node.exe'

    # Env files. Defaults: <InstallRoot>\config\trapezoid.env (service account can read) and
    # <InstallRoot>\config\admin\migrate.env (administrators only). Uncomment to override.
    # ServiceEnvFile        = 'C:\Trapezoid\config\trapezoid.env'
    # MigrationEnvFile      = 'C:\Trapezoid\config\admin\migrate.env'

    # IT INPUT: the production host name IT approves, with the certificate issued for it.
    HealthUrl               = 'https://trapezoid.example.internal/api/health'
    HealthTimeoutSeconds    = 90
    ServiceStopTimeoutSeconds = 60
    # Releases kept on disk for rollback (at least 2).
    KeepReleases            = 5

    # Pre-deploy database backup script (TRP-T21). The backup design is deferred (D39): until it
    # exists, leave this empty, back up by hand and deploy with -SkipBackup.
    BackupScript            = ''

    # IT INPUT: dedicated low-privilege account the service runs as. Recommended: the virtual
    # account 'NT SERVICE\Trapezoid' (no password) or a gMSA 'DOMAIN\svc-trapezoid$'. A normal
    # account with a password also works: WinSW then prompts for it at install.
    ServiceAccount          = ''

    # PostgreSQL 17 (EDB installer defaults).
    PostgresServiceName     = 'postgresql-x64-17'
    PostgresDataDir         = 'C:\Program Files\PostgreSQL\17\data'

    # IT INPUT: HTTPS port and who may reach it. Only this port is opened.
    HttpsPort               = 443
    FirewallProfiles        = @('Private')
    FirewallRemoteAddresses = @('LocalSubnet')

    # SHA-256 of the WinSW executable you downloaded (Get-FileHash), checked before install.
    WinSWSha256             = ''
}
