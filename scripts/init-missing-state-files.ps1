$ErrorActionPreference = 'Stop'
$stateDir = 'D:\.openclaw\workspace\.state'

$painFlag = Join-Path $stateDir '.pain_flag'
if (-not (Test-Path $painFlag)) {
    Set-Content $painFlag -Value '{"flagged":false,"timestamp":null}' -NoNewline
    Write-Host 'CREATED: .pain_flag'
} else { Write-Host 'EXISTS: .pain_flag' }

$painCand = Join-Path $stateDir 'pain_candidates.json'
if (-not (Test-Path $painCand)) {
    Set-Content $painCand -Value '{"candidates":[],"timestamp":null}' -NoNewline
    Write-Host 'CREATED: pain_candidates.json'
} else { Write-Host 'EXISTS: pain_candidates.json' }

$scorecard = Join-Path $stateDir 'AGENT_SCORECARD.json'
if (-not (Test-Path $scorecard)) {
    Set-Content $scorecard -Value '{"agents":{},"timestamp":null}' -NoNewline
    Write-Host 'CREATED: AGENT_SCORECARD.json'
} else { Write-Host 'EXISTS: AGENT_SCORECARD.json' }

$evoDirFile = Join-Path $stateDir 'evolution_directive.json'
if (-not (Test-Path $evoDirFile)) {
    Set-Content $evoDirFile -Value '{"directives":[],"timestamp":null}' -NoNewline
    Write-Host 'CREATED: evolution_directive.json'
} else { Write-Host 'EXISTS: evolution_directive.json' }

$logsDir = Join-Path $stateDir 'logs'
if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir -Force | Out-Null }
$events = Join-Path $logsDir 'events.jsonl'
if (-not (Test-Path $events)) {
    $ts = (Get-Date).ToString('o')
    Set-Content $events -Value ('{"type":"system.start","timestamp":"' + $ts + '"}') -NoNewline
    Write-Host 'CREATED: events.jsonl'
} else { Write-Host 'EXISTS: events.jsonl' }

$memLogsDir = 'D:\.openclaw\workspace\memory\logs'
if (-not (Test-Path $memLogsDir)) { New-Item -ItemType Directory -Path $memLogsDir -Force | Out-Null }
$sysLog = Join-Path $memLogsDir 'SYSTEM.log'
if (-not (Test-Path $sysLog)) {
    $ts = (Get-Date).ToString('o')
    Set-Content $sysLog -Value ('[' + $ts + '] SYSTEM.log initialized by PD Production Canary Agent')
    Write-Host 'CREATED: SYSTEM.log'
} else { Write-Host 'EXISTS: SYSTEM.log' }

Write-Host 'DONE: All missing state files initialized'
