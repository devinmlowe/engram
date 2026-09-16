[CmdletBinding()]
param(
    [string]$RepoRoot,
    [string]$NodePath,
    [int]$Port = 3001,
    [string]$Bind = '127.0.0.1',
    [string]$DataDir,
    [string]$DbPath,
    [string]$LogsDir,
    [int]$RestartDelaySeconds = 30
)

$ErrorActionPreference = 'Stop'

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
    $DataDir = if ($env:ENGRAM_DATA_DIR) { $env:ENGRAM_DATA_DIR } else { Join-Path $HOME '.local\share\engram' }
}
if (-not $DbPath) {
    $DbPath = if ($env:ENGRAM_DB_PATH) { $env:ENGRAM_DB_PATH } else { Join-Path $DataDir 'engram.db' }
}
if (-not $LogsDir) {
    $LogsDir = if ($env:ENGRAM_LOGS_DIR) { $env:ENGRAM_LOGS_DIR } else { Join-Path $DataDir 'logs' }
}

$serverPath = Join-Path $RepoRoot 'dist\interfaces\web\server.js'
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
    throw "Built visualizer entrypoint not found: $serverPath. Run 'npm run build' first."
}
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
    throw "Node executable not found: $NodePath"
}
if ($Port -lt 1 -or $Port -gt 65535) {
    throw "Port must be between 1 and 65535: $Port"
}
if ([string]::IsNullOrWhiteSpace($Bind)) {
    throw 'Bind address cannot be empty.'
}
if ($RestartDelaySeconds -lt 1) {
    throw 'Restart delay must be at least one second.'
}

New-Item -ItemType Directory -Force -Path $DataDir,$LogsDir | Out-Null

$env:ENGRAM_DATA_DIR = $DataDir
$env:ENGRAM_DB_PATH = $DbPath
$env:ENGRAM_LOGS_DIR = $LogsDir
$env:ENGRAM_BIND = $Bind
$env:PORT = "$Port"
$env:NODE_ENV = 'production'

$stdoutLog = Join-Path $LogsDir 'visualizer.log'
$stderrLog = Join-Path $LogsDir 'visualizer-error.log'
$runnerPidFile = Join-Path $DataDir "visualizer-$Port.runner.pid"
$childPidFile = Join-Path $DataDir "visualizer-$Port.pid"
$PID | Set-Content -LiteralPath $runnerPidFile -Encoding ascii

try {
    while ($true) {
        $timestamp = Get-Date -Format 'o'
        "[$timestamp] Starting engram visualizer on $Bind`:$Port" | Add-Content -LiteralPath $stdoutLog

        $process = Start-Process `
            -FilePath $NodePath `
            -ArgumentList @($serverPath) `
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
        "[$timestamp] Engram visualizer exited with code $exitCode; restarting in $RestartDelaySeconds seconds" | Add-Content -LiteralPath $stdoutLog
        Start-Sleep -Seconds $RestartDelaySeconds
    }
} finally {
    Remove-Item -LiteralPath $childPidFile,$runnerPidFile -Force -ErrorAction SilentlyContinue
}
