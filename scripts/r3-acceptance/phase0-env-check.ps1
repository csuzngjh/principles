# R3 Phase 0: Environment Pre-check
# Creates evidence directory and verifies environment prerequisites

$ErrorActionPreference = 'Continue'

# PATH fix (Trae terminal bug)
$machinePath = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
$env:PATH = "$env:PATH;$machinePath;$userPath"

# Create R3 evidence directory
$ts = '2026-07-02T080000Z'
$dir = "D:\.openclaw\workspace\acceptance\release-$ts"
New-Item -ItemType Directory -Path "$dir\evidence" -Force | Out-Null
New-Item -ItemType Directory -Path "$dir\probes" -Force | Out-Null
Write-Host "R3 evidence dir: $dir"

# Save dir to environment file for subsequent scripts
"$dir" | Out-File -FilePath "$dir\evidence-dir.txt" -Encoding UTF8

Write-Host ""
Write-Host "=== Phase 0: Environment Pre-check ==="

# Version checks
Write-Host ""
Write-Host "--- Versions ---"
Write-Host "node: $(node --version 2>&1)"
Write-Host "pd:   $(pd --version 2>&1)"
Write-Host "git:  $(git --version 2>&1)"

$ocVer = openclaw --version 2>&1
Write-Host "openclaw: $ocVer"

# API keys
Write-Host ""
Write-Host "--- API Keys ---"
Write-Host "SENSENOVA_API_KEY: $(if ($env:SENSENOVA_API_KEY) { 'YES (len=' + $env:SENSENOVA_API_KEY.Length + ')' } else { 'NO' })"
Write-Host "LMSTUDIO_API_KEY:  $(if ($env:LMSTUDIO_API_KEY) { 'YES' } else { 'NO' })"
Write-Host "ZAI_API_KEY:       $(if ($env:ZAI_API_KEY) { 'YES' } else { 'NO' })"

# Git HEAD
Write-Host ""
Write-Host "--- Git HEAD (PD worktree) ---"
$repoRoot = "c:\Users\Administrator\.trae-cn\worktrees\principles\feat-pd-product-quality-challenge-hPtFUC"
git -C $repoRoot log --oneline -5

# PD plugin inspect
Write-Host ""
Write-Host "--- PD plugin inspect ---"
$pluginInspect = openclaw plugins inspect principles-disciple --json 2>&1 | Out-String
$pluginInspect | Out-File -FilePath "$dir\evidence\phase0-pd-plugin-inspect.json" -Encoding UTF8
Write-Host $pluginInspect.Substring(0, [Math]::Min(800, $pluginInspect.Length))

# Gateway status
Write-Host ""
Write-Host "--- Gateway status ---"
$gwStatus = openclaw gateway status --json 2>&1 | Out-String
$gwStatus | Out-File -FilePath "$dir\evidence\phase0-gateway-status.json" -Encoding UTF8
Write-Host $gwStatus.Substring(0, [Math]::Min(500, $gwStatus.Length))

# A-group baseline canary
Write-Host ""
Write-Host "--- A-group canary (historical workspace) ---"
$wsA = "D:\.openclaw\workspace"
$canary = pd runtime canary --workspace $wsA --json 2>&1 | Out-String
$canary | Out-File -FilePath "$dir\evidence\a-baseline-canary.json" -Encoding UTF8
Write-Host $canary.Substring(0, [Math]::Min(800, $canary.Length))

# A-group integrity
Write-Host ""
Write-Host "--- A-group integrity ---"
$integrity = pd runtime internalization integrity --workspace $wsA --json 2>&1 | Out-String
$integrity | Out-File -FilePath "$dir\evidence\a-baseline-integrity.json" -Encoding UTF8
Write-Host $integrity.Substring(0, [Math]::Min(1000, $integrity.Length))

# A-group features
Write-Host ""
Write-Host "--- A-group features ---"
$features = pd runtime features --workspace $wsA --json 2>&1 | Out-String
$features | Out-File -FilePath "$dir\evidence\a-baseline-features.json" -Encoding UTF8
Write-Host $features.Substring(0, [Math]::Min(800, $features.Length))

# A-group activations
Write-Host ""
Write-Host "--- A-group activations (include deactivated) ---"
$activations = pd activation list --workspace $wsA --include-deactivated --json 2>&1 | Out-String
$activations | Out-File -FilePath "$dir\evidence\a-baseline-activations.json" -Encoding UTF8
Write-Host $activations.Substring(0, [Math]::Min(800, $activations.Length))

Write-Host ""
Write-Host "=== Phase 0 complete ==="
Write-Host "Evidence saved to: $dir\evidence\"
