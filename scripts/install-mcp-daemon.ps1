# Engram MCP HTTP Daemon — Windows Task Scheduler installer
#
# Windows sibling of scripts/install-visualizer.ps1, but supervises the MCP
# Streamable-HTTP server (src/interfaces/mcp/server.ts --http --port N)
# instead of the web visualizer. Registers a per-user logon task that keeps
# scripts/run-mcp-daemon.ps1 running; bounded restart-on-failure lives in
# that runner, with Task Scheduler's own RestartCount as a second layer.
#
# Usage:
#   .\scripts\install-mcp-daemon.ps1 install    Register (or re-register) and start the task
#   .\scripts\install-mcp-daemon.ps1 uninstall  Stop, remove the task, and sweep orphan processes
#   .\scripts\install-mcp-daemon.ps1 start      Start the task and wait for /health
#   .\scripts\install-mcp-daemon.ps1 stop       Stop the task and wait for /health to go away
#   .\scripts\install-mcp-daemon.ps1 restart    stop then start
#   .\scripts\install-mcp-daemon.ps1 status     Show task state, health, and log tail
#
# The task inherits your *user-scope* environment (Settings > Environment
# Variables), not the shell you install from. This script never reads,
# writes, or prints provider API keys — only ENGRAM_DATA_DIR / ENGRAM_DB_PATH
# / ENGRAM_LOGS_DIR / ENGRAM_HTTP_WORKERS style values cross to the runner,
# as plain arguments.

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('install', 'uninstall', 'start', 'stop', 'restart', 'status')]
    [string]$Action = 'status',
    [string]$RepoRoot,
    [string]$NodePath,
    [string]$TaskPath = '\Engram\',
    [string]$TaskName = 'MCP',
    [int]$Port = 9907,
    [string]$DataDir,
    [string]$DbPath,
    [string]$LogsDir,
    [int]$Workers,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $RepoRoot) {
    $RepoRoot = (Resolve-Path (Join-Path $scriptRoot '..')).Path
} else {
    $RepoRoot = (Resolve-Path $RepoRoot).Path
}

$runnerPath = Join-Path $RepoRoot 'scripts\run-mcp-daemon.ps1'
if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) {
    throw "MCP daemon runner not found: $runnerPath"
}

if (-not $DataDir) {
    $DataDir = if ($env:ENGRAM_DATA_DIR) { $env:ENGRAM_DATA_DIR } else { if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'engram' } else { Join-Path $HOME '.local\share\engram' } }
}
if (-not $LogsDir) {
    $LogsDir = if ($env:ENGRAM_LOGS_DIR) { $env:ENGRAM_LOGS_DIR } else { Join-Path $DataDir 'logs' }
}

$pidFile = Join-Path $DataDir "mcp-$Port.pid"
$runnerPidFile = Join-Path $DataDir "mcp-$Port.runner.pid"
$logFile = Join-Path $LogsDir 'mcp.log'
$serverPath = Join-Path $RepoRoot 'dist\interfaces\mcp\server.js'
$task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue

# Captured at script scope: $PSBoundParameters inside a function reflects
# THAT function's own bound parameters, not the script's, so this can't be
# recomputed inside New-TaskDefinition below.
$workersSpecified = $PSBoundParameters.ContainsKey('Workers')

# The MCP server binds 127.0.0.1 unconditionally (src/interfaces/mcp/http.ts
# defaults host to '127.0.0.1'; server.ts's --http mode never passes a host),
# so there is no -Bind parameter here — the health URL is always loopback.
$uri = "http://127.0.0.1:$Port/health"

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

function Get-Health {
    try {
        $response = Invoke-RestMethod -Uri $uri -TimeoutSec 2 -ErrorAction Stop
        return [pscustomobject]@{
            reachable = $true
            healthy = ($response.status -eq 'ok')
            workers = $response.workers
            response = $response
        }
    } catch {
        return [pscustomobject]@{
            reachable = $false
            healthy = $false
            workers = $null
            response = $null
        }
    }
}

function Wait-Health([bool]$Expected, [int]$TimeoutSeconds = 30) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $health = Get-Health
        if ($health.healthy -eq $Expected) { return $health }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    return Get-Health
}

function Stop-RunnerProcess {
    $processIds = @()
    foreach ($path in @($runnerPidFile, $pidFile)) {
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            $value = 0
            [int]::TryParse((Get-Content -LiteralPath $path -Raw), [ref]$value) | Out-Null
            if ($value -gt 0) { $processIds += $value }
        }
    }
    foreach ($processId in ($processIds | Select-Object -Unique)) {
        if ($processId -ne $PID -and (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
            & taskkill.exe /PID $processId /T /F *> $null
        }
    }

    # Pid files can be stale or missing (crash, manual deletion, etc.), so also
    # sweep by command line — this is what guarantees stop/uninstall leaves no
    # orphan MCP process behind.
    $nodeMarker = 'dist\interfaces\mcp\server.js'
    $portMarker = "--port $Port"
    $runnerMarker = 'run-mcp-daemon.ps1'
    $portFlagMarker = "-Port $Port"
    $leftovers = Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq 'node.exe' -or $_.Name -eq 'powershell.exe' }
    foreach ($proc in $leftovers) {
        if ($proc.ProcessId -eq $PID) { continue }
        $cmd = $proc.CommandLine
        if (-not $cmd) { continue }
        $isNodeMatch = ($proc.Name -eq 'node.exe') -and $cmd.Contains($nodeMarker) -and $cmd.Contains($portMarker)
        $isPwshMatch = ($proc.Name -eq 'powershell.exe') -and $cmd.Contains($runnerMarker) -and $cmd.Contains($portFlagMarker)
        if ($isNodeMatch -or $isPwshMatch) {
            & taskkill.exe /PID $proc.ProcessId /T /F *> $null
        }
    }

    Remove-Item -LiteralPath $pidFile,$runnerPidFile -Force -ErrorAction SilentlyContinue
}

function Get-StatusObject {
    $currentTask = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue
    $health = Get-Health
    $taskInfo = if ($currentTask) {
        Get-ScheduledTaskInfo -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue
    } else {
        $null
    }
    $runnerPid = 0
    if (Test-Path -LiteralPath $runnerPidFile -PathType Leaf) {
        [int]::TryParse((Get-Content -LiteralPath $runnerPidFile -Raw), [ref]$runnerPid) | Out-Null
    }
    $childPid = 0
    if (Test-Path -LiteralPath $pidFile -PathType Leaf) {
        [int]::TryParse((Get-Content -LiteralPath $pidFile -Raw), [ref]$childPid) | Out-Null
    }
    $processRunning = ($childPid -gt 0) -and [bool](Get-Process -Id $childPid -ErrorAction SilentlyContinue)
    [pscustomobject]@{
        taskPath = $TaskPath
        taskName = $TaskName
        installed = [bool]$currentTask
        taskState = if ($currentTask) { [string]$currentTask.State } else { 'NotInstalled' }
        lastRunTime = if ($taskInfo) { $taskInfo.LastRunTime } else { $null }
        lastTaskResult = if ($taskInfo) { $taskInfo.LastTaskResult } else { $null }
        runnerPid = $runnerPid
        childPid = $childPid
        processRunning = $processRunning
        url = $uri
        reachable = $health.reachable
        healthy = $health.healthy
        workers = $health.workers
        logFile = $logFile
        dataDir = $DataDir
        dbPath = if ($DbPath) { $DbPath } else { Join-Path $DataDir 'engram.db' }
        # A populated pre-0.2.0 database that this install would ignore (issue #13); `engram doctor` explains.
        legacyDbPath = $(
            $legacy = Join-Path (Join-Path $HOME '.local\share\engram') 'engram.db'
            $effective = if ($DbPath) { $DbPath } else { Join-Path $DataDir 'engram.db' }
            if (($legacy -ne $effective) -and (Test-Path -LiteralPath $legacy -PathType Leaf)) { $legacy } else { $null }
        )
    }
}

function Format-Status($status) {
    if ($Json) {
        $status | ConvertTo-Json -Depth 5
    } else {
        $status | Format-List
        if (Test-Path -LiteralPath $logFile -PathType Leaf) {
            Write-Output 'Last 5 log lines:'
            Get-Content -LiteralPath $logFile -Tail 5
        }
    }
}

function New-TaskDefinition {
    $resolvedNode = Resolve-NodePath
    $powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = @(
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $runnerPath,
        '-RepoRoot', $RepoRoot,
        '-NodePath', $resolvedNode,
        '-Port', "$Port",
        '-DataDir', $DataDir
    )
    if ($DbPath) { $arguments += @('-DbPath', $DbPath) }
    if ($LogsDir) { $arguments += @('-LogsDir', $LogsDir) }
    if ($workersSpecified) { $arguments += @('-Workers', "$Workers") }

    $quoted = $arguments | ForEach-Object {
        if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
    }
    $actionSpec = New-ScheduledTaskAction -Execute $powershellPath -Argument ($quoted -join ' ') -WorkingDirectory $RepoRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $settings = New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal `
        -UserId "$env:USERDOMAIN\$env:USERNAME" `
        -LogonType Interactive `
        -RunLevel Limited
    New-ScheduledTask `
        -Action $actionSpec `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Description 'Engram MCP HTTP daemon (loopback only)'
}

switch ($Action) {
    'install' {
        New-Item -ItemType Directory -Force -Path $DataDir,$LogsDir | Out-Null
        if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
            throw "Built MCP entrypoint not found: $serverPath. Run 'npm run build' first."
        }
        Register-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -InputObject (New-TaskDefinition) -Force | Out-Null
        Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
        $status = Wait-Health $true
        Format-Status (Get-StatusObject)
        if (-not $status.healthy) { exit 1 }
    }
    'uninstall' {
        if ($task) {
            Stop-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue
            Stop-RunnerProcess
            Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -Confirm:$false
            Write-Output "Uninstalled $TaskPath$TaskName"
        } else {
            Stop-RunnerProcess
            Write-Output "Task not installed: $TaskPath$TaskName"
        }
    }
    'start' {
        if (-not $task) { throw "Task not installed: $TaskPath$TaskName" }
        Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
        $status = Wait-Health $true
        Format-Status (Get-StatusObject)
        if (-not $status.healthy) { exit 1 }
    }
    'stop' {
        if ($task) { Stop-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue }
        Stop-RunnerProcess
        $status = Wait-Health $false
        Format-Status (Get-StatusObject)
        if ($status.healthy) { exit 1 }
    }
    'restart' {
        if (-not $task) { throw "Task not installed: $TaskPath$TaskName" }
        Stop-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue
        Stop-RunnerProcess
        Wait-Health $false | Out-Null
        Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
        $status = Wait-Health $true
        Format-Status (Get-StatusObject)
        if (-not $status.healthy) { exit 1 }
    }
    'status' {
        Format-Status (Get-StatusObject)
    }
}
