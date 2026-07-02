# R3 Phase 1: Verify R2 P0 fixes (Bug-B-001~004 clean env install, Bug-B-005 agent registration)
# Bug-B-001: pd runtime init crashed with ERR_MODULE_NOT_FOUND
# Bug-B-002: bundle-plugin.mjs didn't handle principles-disciple dependency
# Bug-B-003: installer used source-tree package.json
# Bug-B-004: syncPdCli only created @principles/core symlink
# Bug-B-005: pd pain record failed with Unknown agent id "diag_rootcause"

$ErrorActionPreference = 'Continue'

# PATH fix
$machinePath = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
$env:PATH = "$env:PATH;$machinePath;$userPath"

$dir = "D:\.openclaw\workspace\acceptance\release-2026-07-02T080000Z"
$wsB = "$dir\env-b-clean"

Write-Host "=== R3 Phase 1: Verify R2 P0 fixes ==="
Write-Host "Clean workspace: $wsB"
Write-Host ""

# B1. Create clean workspace
Write-Host "--- B1. Create clean workspace ---"
if (Test-Path $wsB) {
  Remove-Item -Recurse -Force $wsB
}
New-Item -ItemType Directory -Path $wsB -Force | Out-Null

# Copy minimal persona files (not .pd/.state/DB)
$wsA = "D:\.openclaw\workspace"
$personaFiles = @("AGENTS.md", "BOOTSTRAP.md", "IDENTITY.md", "SOUL.md", "TOOLS.md", "USER.md")
foreach ($f in $personaFiles) {
  $src = Join-Path $wsA $f
  if (Test-Path $src) {
    Copy-Item $src $wsB
  }
}
Write-Host "Copied persona files: $($personaFiles -join ', ')"

# B2. Run pd runtime init (Bug-B-001/002/003/004 fix verification)
Write-Host ""
Write-Host "--- B2. pd runtime init (Bug-B-001~004 fix) ---"
$initResult = pd runtime init --workspace $wsB --confirm --json 2>&1 | Out-String
$initResult | Out-File -FilePath "$dir\evidence\b-runtime-init.json" -Encoding UTF8
Write-Host $initResult.Substring(0, [Math]::Min(1500, $initResult.Length))

# Check for crash
if ($initResult -match 'ERR_MODULE_NOT_FOUND' -or $initResult -match 'Cannot find package') {
  Write-Host "[FAIL] Bug-B-001 NOT FIXED - pd runtime init still crashes" -ForegroundColor Red
} elseif ($initResult -match '"status"\s*:\s*"success"' -or $initResult -match '"ok"\s*:\s*true' -or $initResult -match 'initialized') {
  Write-Host "[PASS] Bug-B-001/002/003/004 FIXED - pd runtime init succeeded in clean env" -ForegroundColor Green
} else {
  Write-Host "[WARN] pd runtime init returned unexpected output (check evidence)" -ForegroundColor Yellow
}

# B3. Verify no nested .pd/.pd/ directory (R2 test plan check)
Write-Host ""
Write-Host "--- B3. Check for nested .pd/.pd/ (R2 concern) ---"
$nestedPd = Join-Path $wsB ".pd\.pd"
if (Test-Path $nestedPd) {
  Write-Host "[FAIL] Nested .pd/.pd/ directory exists - BUG" -ForegroundColor Red
  Get-ChildItem $nestedPd -Recurse | Select-Object FullName | Format-Table
} else {
  Write-Host "[PASS] No nested .pd/.pd/ directory" -ForegroundColor Green
}

# B4. Verify pd-cli node_modules has principles-disciple symlink (Bug-B-004 fix)
Write-Host ""
Write-Host "--- B4. Verify pd-cli principles-disciple symlink (Bug-B-004 fix) ---"
$pdCliModulePath = "$env:APPDATA\npm\node_modules\principles-disciple\dist\index.js"
if (Test-Path $pdCliModulePath) {
  Write-Host "[PASS] principles-disciple dist/bundle.js accessible at npm global" -ForegroundColor Green
} else {
  # Check if pd-cli can resolve the module
  $resolveTest = node -e "try { require.resolve('principles-disciple'); console.log('RESOLVED'); } catch(e) { console.log('FAIL:', e.message); }" 2>&1
  Write-Host "Module resolve test: $resolveTest"
}

# B5. Verify pd --version works in clean env
Write-Host ""
Write-Host "--- B5. pd --version in clean env ---"
$pdVersion = pd --version 2>&1
Write-Host "pd version: $pdVersion"

# B6. Verify pd config doctor in clean env (Bug-B-007 was about misleading message)
Write-Host ""
Write-Host "--- B6. pd config doctor in clean env ---"
$configDoctor = pd config doctor --workspace $wsB --json 2>&1 | Out-String
$configDoctor | Out-File -FilePath "$dir\evidence\b-config-doctor.json" -Encoding UTF8
Write-Host $configDoctor.Substring(0, [Math]::Min(1000, $configDoctor.Length))

# B7. Verify pd runtime features in clean env
Write-Host ""
Write-Host "--- B7. pd runtime features in clean env ---"
$bFeatures = pd runtime features --workspace $wsB --json 2>&1 | Out-String
$bFeatures | Out-File -FilePath "$dir\evidence\b-features.json" -Encoding UTF8
Write-Host $bFeatures.Substring(0, [Math]::Min(1000, $bFeatures.Length))

# B8. Bug-B-005 verification: Check that 'diagnostician' agent is registered (not diag_rootcause)
Write-Host ""
Write-Host "--- B8. Bug-B-005: Verify diagnostician agent registration ---"
# Check the source code to confirm diag_rootcause was replaced with diagnostician
$repoRoot = "c:\Users\Administrator\.trae-cn\worktrees\principles\feat-pd-product-quality-challenge-hPtFUC"
$diagRunner = Get-Content "$repoRoot\packages\principles-core\src\runtime-v2\internalization\diag-rootcause-runner.ts" -Raw
if ($diagRunner -match "defaultAgentId:\s*['""]diagnostician['""]") {
  Write-Host "[PASS] Bug-B-005 FIXED - diag-rootcause-runner uses 'diagnostician' agent" -ForegroundColor Green
} elseif ($diagRunner -match "diag_rootcause") {
  Write-Host "[FAIL] Bug-B-005 NOT FIXED - still uses diag_rootcause" -ForegroundColor Red
} else {
  Write-Host "[WARN] Could not determine agent ID from source" -ForegroundColor Yellow
}

# B9. Try a minimal pd pain record to verify agent registration works at runtime
Write-Host ""
Write-Host "--- B9. pd pain record test (Bug-B-005 runtime verification) ---"
$painResult = pd pain record --workspace $wsB --reason "R3 test: verify diagnostician agent works in clean env" --score 70 --source manual --json 2>&1 | Out-String
$painResult | Out-File -FilePath "$dir\evidence\b-pain-record-test.json" -Encoding UTF8
Write-Host $painResult.Substring(0, [Math]::Min(1500, $painResult.Length))

if ($painResult -match 'Unknown agent id' -or $painResult -match 'diag_rootcause') {
  Write-Host "[FAIL] Bug-B-005 NOT FIXED at runtime - still fails with Unknown agent id" -ForegroundColor Red
} elseif ($painResult -match 'painId' -or $painResult -match 'success') {
  Write-Host "[PASS] Bug-B-005 FIXED at runtime - pain record works in clean env" -ForegroundColor Green
} else {
  Write-Host "[WARN] pain record returned unexpected output" -ForegroundColor Yellow
}

# B10. Verify canary in clean env
Write-Host ""
Write-Host "--- B10. Canary in clean env ---"
$bCanary = pd runtime canary --workspace $wsB --json 2>&1 | Out-String
$bCanary | Out-File -FilePath "$dir\evidence\b-canary.json" -Encoding UTF8
Write-Host $bCanary.Substring(0, [Math]::Min(800, $bCanary.Length))

Write-Host ""
Write-Host "=== Phase 1 complete ==="
Write-Host "Evidence saved to: $dir\evidence\b-*.json"
