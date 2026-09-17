[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('install', 'uninstall', 'start', 'stop', 'restart', 'status')]
    [string]$Action = 'status',
    [string]$RepoRoot,
    [string]$TaskPath = '\Engram\',
    [string]$TaskName = 'Visualizer',
    [int]$Port = 3001,
    [string]$Bind = '127.0.0.1',
    [string]$DataDir,
    [string]$DbPath,
    [string]$LogsDir,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $RepoRoot) {
    $RepoRoot = (Resolve-Path (Join-Path $scriptRoot '..')).Path
} else {
    $RepoRoot = (Resolve-Path $RepoRoot).Path
}

$runnerPath = Join-Path $RepoRoot 'scripts\run-visualizer.ps1'
if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) {
    throw "Visualizer runner not found: $runnerPath"
}

if (-not $DataDir) {
    $DataDir = if ($env:ENGRAM_DATA_DIR) { $env:ENGRAM_DATA_DIR } else { if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'engram' } else { Join-Path $HOME '.local\share\engram' } }
}
$pidFile = Join-Path $DataDir "visualizer-$Port.pid"
$runnerPidFile = Join-Path $DataDir "visualizer-$Port.runner.pid"
$task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue
$uri = "http://$Bind`:$Port/api/health"

function Get-Health {
    try {
        $response = Invoke-RestMethod -Uri $uri -TimeoutSec 2 -ErrorAction Stop
        return [pscustomobject]@{
            reachable = $true
            healthy = ($response.status -eq 'ok')
            response = $response
        }
    } catch {
        return [pscustomobject]@{
            reachable = $false
            healthy = $false
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
        if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
            & taskkill.exe /PID $processId /T /F *> $null
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
    [pscustomobject]@{
        taskPath = $TaskPath
        taskName = $TaskName
        installed = [bool]$currentTask
        taskState = if ($currentTask) { [string]$currentTask.State } else { 'NotInstalled' }
        lastRunTime = if ($taskInfo) { $taskInfo.LastRunTime } else { $null }
        lastTaskResult = if ($taskInfo) { $taskInfo.LastTaskResult } else { $null }
        url = $uri
        reachable = $health.reachable
        healthy = $health.healthy
    }
}

function Format-Status($status) {
    if ($Json) { $status | ConvertTo-Json -Depth 5 } else { $status | Format-List }
}

function New-TaskDefinition {
    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    $powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = @(
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $runnerPath,
        '-RepoRoot', $RepoRoot,
        '-NodePath', $nodePath,
        '-Port', "$Port",
        '-Bind', $Bind,
        '-DataDir', $DataDir
    )
    if ($DbPath) { $arguments += @('-DbPath', $DbPath) }
    if ($LogsDir) { $arguments += @('-LogsDir', $LogsDir) }

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
        -Description 'Engram local knowledge graph visualizer'
}

switch ($Action) {
    'install' {
        Register-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -InputObject (New-TaskDefinition) -Force | Out-Null
        Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
        $status = Get-StatusObject
        if ($Json) { $status | ConvertTo-Json -Depth 5 } else { "Installed and started $TaskPath$TaskName"; Format-Status $status }
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
