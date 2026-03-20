param(
    [Parameter(Mandatory = $false)]
    [string]$WorkspaceRoot = (Get-Location).Path,

    [Parameter(Mandatory = $false)]
    [string]$OutputRoot = "",

    [Parameter(Mandatory = $false)]
    [int]$SessionLimit = 10
)

$ErrorActionPreference = "Stop"

function Ensure-Directory {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Copy-IfExists {
    param(
        [string]$SourcePath,
        [string]$RelativeTarget,
        [string]$SnapshotDir,
        [System.Collections.Generic.List[object]]$Manifest
    )

    $targetPath = Join-Path $SnapshotDir $RelativeTarget
    $targetDir = Split-Path -Parent $targetPath
    Ensure-Directory -Path $targetDir

    if (Test-Path -LiteralPath $SourcePath) {
        Copy-Item -LiteralPath $SourcePath -Destination $targetPath -Force
        $item = Get-Item -LiteralPath $SourcePath
        $Manifest.Add([pscustomobject]@{
            relativePath = $RelativeTarget.Replace('\', '/')
            sourcePath = $SourcePath
            exists = $true
            length = $item.Length
            lastWriteTime = $item.LastWriteTime.ToString("o")
        })
        return
    }

    $Manifest.Add([pscustomobject]@{
        relativePath = $RelativeTarget.Replace('\', '/')
        sourcePath = $SourcePath
        exists = $false
        length = $null
        lastWriteTime = $null
    })
}

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $WorkspaceRoot ".state\control-plane-observation"
}

$stateDir = Join-Path $WorkspaceRoot ".state"
$memoryLogDir = Join-Path $WorkspaceRoot "memory\logs"
$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$snapshotDir = Join-Path $OutputRoot "snapshots\$timestamp"

Ensure-Directory -Path $OutputRoot
Ensure-Directory -Path $snapshotDir

$manifest = New-Object 'System.Collections.Generic.List[object]'

$staticFiles = @(
    @{ Source = Join-Path $stateDir "AGENT_SCORECARD.json"; Relative = ".state/AGENT_SCORECARD.json" },
    @{ Source = Join-Path $stateDir "evolution_queue.json"; Relative = ".state/evolution_queue.json" },
    @{ Source = Join-Path $stateDir "evolution_directive.json"; Relative = ".state/evolution_directive.json" },
    @{ Source = Join-Path $stateDir "pain_candidates.json"; Relative = ".state/pain_candidates.json" },
    @{ Source = Join-Path $stateDir ".pain_flag"; Relative = ".state/.pain_flag" },
    @{ Source = Join-Path $stateDir "logs\events.jsonl"; Relative = ".state/logs/events.jsonl" },
    @{ Source = Join-Path $stateDir "logs\daily-stats.json"; Relative = ".state/logs/daily-stats.json" },
    @{ Source = Join-Path $memoryLogDir "SYSTEM.log"; Relative = "memory/logs/SYSTEM.log" }
)

foreach ($file in $staticFiles) {
    Copy-IfExists -SourcePath $file.Source -RelativeTarget $file.Relative -SnapshotDir $snapshotDir -Manifest $manifest
}

$sessionsDir = Join-Path $stateDir "sessions"
$selectedSessions = @()
if (Test-Path -LiteralPath $sessionsDir) {
    $selectedSessions = Get-ChildItem -LiteralPath $sessionsDir -Filter *.json |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First $SessionLimit
}

foreach ($sessionFile in $selectedSessions) {
    $relative = ".state/sessions/$($sessionFile.Name)"
    Copy-IfExists -SourcePath $sessionFile.FullName -RelativeTarget $relative -SnapshotDir $snapshotDir -Manifest $manifest
}

$reviewTemplate = @"
# Control Plane Snapshot Review

- generatedAt: $(Get-Date -Format o)
- workspaceRoot: $WorkspaceRoot
- snapshotDir: $snapshotDir

## Daily Checks

1. Trust did not inflate unexpectedly.
2. `user_empathy` and `system_infer` both appear in `.state/logs/events.jsonl` when relevant.
3. Empathy rollback reduced only the empathy slice and did not wipe unrelated GFI.
4. `evolution_queue.json`, `evolution_directive.json`, and status output tell the same story.
5. `daily-stats.json` does not contradict active session snapshots in a way that would mislead operators.

## Files To Review First

- `.state/AGENT_SCORECARD.json`
- `.state/logs/events.jsonl`
- `.state/logs/daily-stats.json`
- `.state/evolution_queue.json`
- `.state/evolution_directive.json`
- `.state/sessions/*.json`

## Decision

- continue_observation:
- patch_needed:
- ready_for_phase_3_shadow:
"@

Set-Content -LiteralPath (Join-Path $snapshotDir "review-template.md") -Value $reviewTemplate -Encoding UTF8

$manifestObject = [pscustomobject]@{
    generatedAt = (Get-Date).ToString("o")
    workspaceRoot = $WorkspaceRoot
    snapshotDir = $snapshotDir
    sessionLimit = $SessionLimit
    copiedFiles = $manifest
}

$manifestPath = Join-Path $snapshotDir "manifest.json"
$manifestObject | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
Set-Content -LiteralPath (Join-Path $OutputRoot "latest_snapshot.txt") -Value $snapshotDir -Encoding UTF8

Write-Output "Snapshot created: $snapshotDir"
Write-Output "Manifest: $manifestPath"
