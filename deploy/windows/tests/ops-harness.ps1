#Requires -Version 7.2
# Test harness for the backup, restore and monitor scripts (MM-T21). Replaces only the Windows
# event log writer with one that appends to $env:T21_FAKE_EVENTLOG, then runs the named script
# unchanged. Never registers an event source or writes to the real event log.
param(
    [Parameter(Mandatory)][string]$Script,
    [Parameter(ValueFromRemainingArguments)][object[]]$ScriptArgs
)

$ErrorActionPreference = 'Stop'
$scripts = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
# Same full path the scripts use, so their Import-Module reuses this (patched) module.
$module = Import-Module (Join-Path $scripts 'MaterialMuleOps.psm1') -PassThru

& $module {
    function script:Write-MaterialMuleEventLog {
        param($Source, $EntryType, $EventId, $Message)
        $line = '{0}|{1}|{2}|{3}' -f $Source, $EntryType, $EventId, ($Message -replace '\r?\n', ' / ')
        Add-Content -LiteralPath $env:T21_FAKE_EVENTLOG -Value $line -Encoding utf8
        return $true
    }
}

# Named arguments arrive as strings ('-ConfigPath', 'x', '-WhatIf'); rebuild a splat.
$splat = @{}
for ($i = 0; $i -lt $ScriptArgs.Count; $i++) {
    $name = ([string]$ScriptArgs[$i]).TrimStart('-')
    $next = if ($i + 1 -lt $ScriptArgs.Count) { [string]$ScriptArgs[$i + 1] } else { $null }
    if ($null -ne $next -and -not $next.StartsWith('-')) {
        $splat[$name] = $next
        $i++
    } else {
        $splat[$name] = $true
    }
}
& (Join-Path $scripts $Script) @splat
exit $LASTEXITCODE
