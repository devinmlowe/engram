# Engram Dream State Daemon — Windows Task Scheduler installer
#
# Windows sibling of scripts/install-daemon.sh (launchd on macOS, systemd user
# timer on Linux). Registers a per-user daily task at 02:00 that runs the
# compiled CLI with the resolved node.exe:
#
#   node.exe --max-old-space-size=2048 dist\interfaces\cli\index.js dream
#
# Usage:
#   .\scripts\install-daemon.ps1 install    Register (or re-register) the daily task
#   .\scripts\install-daemon.ps1 uninstall  Remove the task
#   .\scripts\install-daemon.ps1 status     Show task state, next/last run, log tail
#   .\scripts\install-daemon.ps1 run-now    Trigger an immediate dream run
#
# The task inherits your *user-scope* environment (Settings > Environment
# Variables), not the shell you install from. Pass -PersistEnv to copy any
# ANTHROPIC_API_KEY / OPENROUTER_API_KEY / ENGRAM_* values from the current
# session into user scope so the scheduled run sees them.

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('install', 'uninstall', 'status', 'run-now')]
    [string]$Action = 'status',
    [string]$RepoRoot,
    [string]$NodePath,
    [string]$TaskPath = '\Engram\',
    [string]$TaskName = 'Dream',
    [string]$At = '02:00',
    [ValidateSet('S4U', 'Interactive')]
    [string]$LogonType = 'S4U',
    [string]$DataDir,
    [string]$LogsDir,
    [switch]$PersistEnv,
    [switch]$SkipBuild,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'

# --- Path resolution (from this script's location and ENGRAM_* env, never a fixed layout)
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $RepoRoot) {
    $RepoRoot = (Resolve-Path (Join-Path $scriptRoot '..')).Path
} else {
    $RepoRoot = (Resolve-Path $RepoRoot).Path
}

if (-not $DataDir) {
    $DataDir = if ($env:ENGRAM_DATA_DIR) { $env:ENGRAM_DATA_DIR } else { Join-Path $HOME '.local\share\engram' }
}
if (-not $LogsDir) {
    $LogsDir = if ($env:ENGRAM_LOGS_DIR) { $env:ENGRAM_LOGS_DIR } else { Join-Path $DataDir 'logs' }
}

$cliRelative = 'dist\interfaces\cli\index.js'
$cliPath = Join-Path $RepoRoot $cliRelative
$dreamLog = Join-Path $LogsDir 'dream.log'
$task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue

# Environment the CLI reads (src/_core/config); mirrored from install-daemon.sh.
$envNames = @(
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'ENGRAM_LOCAL_MODEL',
    'ENGRAM_DATA_DIR',
    'ENGRAM_DB_PATH',
    'ENGRAM_LOGS_DIR'
)

function Resolve-NodePath {
    if ($NodePath) {
        return (Resolve-Path $NodePath).Path
    }
    $resolved = (Get-Command node.exe -ErrorAction Stop).Source
    # fnm/nvm-windows "multishell" shims are per-session and vanish after logout;
    # the task needs a path that survives reboot.
    if ($resolved -match 'fnm_multishells|nvm4w\\temp') {
        Write-Warning "Resolved node path looks ephemeral ($resolved). Set a default node version (fnm default / nvm use) or pass -NodePath."
    }
    return $resolved
}

function Invoke-Build {
    if ($SkipBuild) { return }
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm -ErrorAction Stop }
    Write-Output 'Building engram...'
    Push-Location $RepoRoot
    try {
        & $npm.Source run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}

function Sync-UserEnvironment {
    $copied = @()
    foreach ($name in $envNames) {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if ($value) {
            [Environment]::SetEnvironmentVariable($name, $value, 'User')
            $copied += $name
        }
    }
    if ($copied.Count -gt 0) {
        Write-Output ("Persisted to user environment: " + ($copied -join ', '))
    } else {
        Write-Output 'No ENGRAM_*/provider variables found in this session; nothing persisted.'
    }
}

function Get-StatusObject {
    $currentTask = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue
    $taskInfo = if ($currentTask) {
        Get-ScheduledTaskInfo -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue
    } else {
        $null
    }
    $action = if ($currentTask) { $currentTask.Actions | Select-Object -First 1 } else { $null }
    [pscustomobject]@{
        taskPath = $TaskPath
        taskName = $TaskName
        installed = [bool]$currentTask
        taskState = if ($currentTask) { [string]$currentTask.State } else { 'NotInstalled' }
        schedule = "Daily at $At"
        nextRunTime = if ($taskInfo) { $taskInfo.NextRunTime } else { $null }
        lastRunTime = if ($taskInfo) { $taskInfo.LastRunTime } else { $null }
        lastTaskResult = if ($taskInfo) { $taskInfo.LastTaskResult } else { $null }
        node = if ($action) { $action.Execute } else { $null }
        workingDirectory = if ($action) { $action.WorkingDirectory } else { $null }
        logFile = $dreamLog
    }
}

function Format-Status($status) {
    if ($Json) {
        $status | ConvertTo-Json -Depth 5
    } else {
        $status | Format-List
        if (Test-Path -LiteralPath $dreamLog -PathType Leaf) {
            Write-Output 'Last 5 log lines:'
            Get-Content -LiteralPath $dreamLog -Tail 5
        }
    }
}

function New-TaskDefinition([string]$ResolvedNode) {
    # Direct node.exe action: the CLI writes its own dream.log under the logs
    # dir, so no shell wrapper or stdout redirection is needed.
    $arguments = @('--max-old-space-size=2048', $cliRelative, 'dream')
    $actionSpec = New-ScheduledTaskAction `
        -Execute $ResolvedNode `
        -Argument ($arguments -join ' ') `
        -WorkingDirectory $RepoRoot
    $trigger = New-ScheduledTaskTrigger -Daily -At $At
    $settings = New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Hours 6) `
        -MultipleInstances IgnoreNew `
        -Priority 8
    $principal = New-ScheduledTaskPrincipal `
        -UserId "$env:USERDOMAIN\$env:USERNAME" `
        -LogonType $LogonType `
        -RunLevel Limited
    New-ScheduledTask `
        -Action $actionSpec `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Description 'Engram nightly dream consolidation (engram dream)'
}

switch ($Action) {
    'install' {
        New-Item -ItemType Directory -Force -Path $DataDir,$LogsDir | Out-Null
        Invoke-Build
        if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
            throw "Built CLI entrypoint not found: $cliPath. Run 'npm run build' first."
        }
        $resolvedNode = Resolve-NodePath
        Write-Output "Using node: $resolvedNode ($(& $resolvedNode --version))"
        if ($PersistEnv) { Sync-UserEnvironment }

        Register-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -InputObject (New-TaskDefinition $resolvedNode) -Force | Out-Null
        $status = Get-StatusObject
        if ($Json) {
            $status | ConvertTo-Json -Depth 5
        } else {
            Write-Output "Registered $TaskPath$TaskName (daily at $At, logon type $LogonType)."
            Write-Output "  Logs: $dreamLog"
            if (-not $PersistEnv) {
                Write-Output '  Provider keys: the task reads user-scope environment variables. Re-run with'
                Write-Output '  -PersistEnv to copy ANTHROPIC_API_KEY / OPENROUTER_API_KEY / ENGRAM_* from this shell.'
            }
            Write-Output ''
            Format-Status $status
        }
    }
    'uninstall' {
        if ($task) {
            Stop-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -Confirm:$false
            Write-Output "Uninstalled $TaskPath$TaskName"
        } else {
            Write-Output "Task not installed: $TaskPath$TaskName"
        }
    }
    'status' {
        Format-Status (Get-StatusObject)
    }
    'run-now' {
        if (-not $task) { throw "Task not installed: $TaskPath$TaskName. Run '.\scripts\install-daemon.ps1 install' first." }
        Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
        Write-Output "Dream run triggered. Follow along with: Get-Content -Wait '$dreamLog'"
        Format-Status (Get-StatusObject)
    }
}
