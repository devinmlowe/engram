[CmdletBinding()]
param(
    [string]$RepoRoot,
    [string]$NodePath,
    [int]$Port = 9907,
    [string]$DataDir,
    [string]$DbPath,
    [string]$LogsDir,
    [int]$Workers,
    [int]$MaxRestarts = 5,
    [int]$RestartWindowSeconds = 600,
    [int]$RestartDelaySeconds = 5
)

$ErrorActionPreference = 'Stop'

# This script's own bound parameters, captured before any function scope
# could shadow $PSBoundParameters (see install-mcp-daemon.ps1 for the same
# concern). -Workers 0 is a valid, deliberate choice, so presence — not
# truthiness — is what decides whether it reaches the environment below.
$workersSpecified = $PSBoundParameters.ContainsKey('Workers')

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $RepoRoot) {
    $RepoRoot = (Resolve-Path (Join-Path $scriptRoot '..')).Path
} else {
    $RepoRoot = (Resolve-Path $RepoRoot).Path
}

if (-not $NodePath) {
    $NodePath = (Get-Command node.exe -ErrorAction Stop).Source
} else {
    $NodePath = (Resolve-Path $NodePath).Path
}

if (-not $DataDir) {
    $DataDir = if ($env:ENGRAM_DATA_DIR) { $env:ENGRAM_DATA_DIR } else { if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'engram' } else { Join-Path $HOME '.local\share\engram' } }
}
if (-not $DbPath) {
    $DbPath = if ($env:ENGRAM_DB_PATH) { $env:ENGRAM_DB_PATH } else { Join-Path $DataDir 'engram.db' }
}
if (-not $LogsDir) {
    $LogsDir = if ($env:ENGRAM_LOGS_DIR) { $env:ENGRAM_LOGS_DIR } else { Join-Path $DataDir 'logs' }
}

$serverPath = Join-Path $RepoRoot 'dist\interfaces\mcp\server.js'
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
    throw "Built MCP entrypoint not found: $serverPath. Run 'npm run build' first."
}
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
    throw "Node executable not found: $NodePath"
}
if ($Port -lt 1 -or $Port -gt 65535) {
    throw "Port must be between 1 and 65535: $Port"
}
if ($RestartDelaySeconds -lt 1) {
    throw 'Restart delay must be at least one second.'
}
if ($MaxRestarts -lt 1) {
    throw 'MaxRestarts must be at least one.'
}
if ($RestartWindowSeconds -lt $RestartDelaySeconds) {
    throw 'RestartWindowSeconds must be greater than or equal to RestartDelaySeconds.'
}

New-Item -ItemType Directory -Force -Path $DataDir,$LogsDir | Out-Null

$env:ENGRAM_DATA_DIR = $DataDir
$env:ENGRAM_DB_PATH = $DbPath
$env:ENGRAM_LOGS_DIR = $LogsDir
$env:NODE_ENV = 'production'
if ($workersSpecified) {
    $env:ENGRAM_HTTP_WORKERS = "$Workers"
}

$stdoutLog = Join-Path $LogsDir 'mcp.log'
$stderrLog = Join-Path $LogsDir 'mcp-error.log'
$runnerPidFile = Join-Path $DataDir "mcp-$Port.runner.pid"
$childPidFile = Join-Path $DataDir "mcp-$Port.pid"
$PID | Set-Content -LiteralPath $runnerPidFile -Encoding ascii

# Restart timestamps within the trailing RestartWindowSeconds window; bounds
# how many times THIS process will relaunch a crashing server before giving
# up. Task Scheduler's own -RestartCount 3 / -RestartInterval 1 min (set in
# install-mcp-daemon.ps1) is the second, outer layer once this exits 1.
$restartTimestamps = @()

try {
    while ($true) {
        $timestamp = Get-Date -Format 'o'
        "[$timestamp] Starting engram MCP HTTP daemon on 127.0.0.1:$Port" | Add-Content -LiteralPath $stdoutLog

        $process = Start-Process `
            -FilePath $NodePath `
            -ArgumentList @($serverPath, '--http', '--port', "$Port") `
            -WorkingDirectory $RepoRoot `
            -RedirectStandardOutput $stdoutLog `
            -RedirectStandardError $stderrLog `
            -PassThru

        $process.Id | Set-Content -LiteralPath $childPidFile -Encoding ascii
        try {
            Wait-Process -Id $process.Id
            $process.Refresh()
            $rawExitCode = $process.ExitCode
        } finally {
            Remove-Item -LiteralPath $childPidFile -Force -ErrorAction SilentlyContinue
        }

        $exitCode = if ($rawExitCode -is [int]) { $rawExitCode } else { 1 }
        $timestamp = Get-Date -Format 'o'

        if ($exitCode -eq 0) {
            "[$timestamp] Engram MCP daemon exited cleanly (code 0); treating as a deliberate stop, not restarting" | Add-Content -LiteralPath $stdoutLog
            exit 0
        }

        $now = Get-Date
        $cutoff = $now.AddSeconds(-$RestartWindowSeconds)
        $restartTimestamps = @($restartTimestamps | Where-Object { $_ -ge $cutoff })

        if ($restartTimestamps.Count -ge $MaxRestarts) {
            $message = "[$timestamp] giving up after $($restartTimestamps.Count) restarts in $RestartWindowSeconds seconds"
            $message | Add-Content -LiteralPath $stdoutLog
            $message | Add-Content -LiteralPath $stderrLog
            exit 1
        }

        $restartTimestamps += $now
        "[$timestamp] Engram MCP daemon exited with code $exitCode; restarting in $RestartDelaySeconds seconds ($($restartTimestamps.Count)/$MaxRestarts in window)" | Add-Content -LiteralPath $stdoutLog
        Start-Sleep -Seconds $RestartDelaySeconds
    }
} finally {
    Remove-Item -LiteralPath $childPidFile,$runnerPidFile -Force -ErrorAction SilentlyContinue
}
