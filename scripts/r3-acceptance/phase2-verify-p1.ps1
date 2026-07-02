# R3 Phase 2: Verify R2 P1 fixes
# Focus: admission gate, F9/F10 FK checks, RuleHost warn, integrity, schema_version
# Uses source-level grep + B-group runtime probes

$ErrorActionPreference = 'Continue'
$ts = '2026-07-02T080000Z'
$evidenceDir = "D:\.openclaw\workspace\acceptance\release-$ts\evidence"
$wsRoot = "c:\Users\Administrator\.trae-cn\worktrees\principles\feat-pd-product-quality-challenge-hPtFUC"

# PATH fix (Trae terminal bug)
$machinePath = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
$env:PATH = "$env:PATH;$machinePath;$userPath"

Write-Host "=== R3 Phase 2: Verify R2 P1 fixes ===" -ForegroundColor Cyan

# ============================================================
# 1. Admission gate bypass verification
#   Bug: pd-cli package had 0 references to evaluateCandidateAdmissions
#   Fix: introduce evaluateCandidateAdmissionFromRecord, call at intake/repair/backfill
# ============================================================
Write-Host "`n[2.1] Admission gate callsites" -ForegroundColor Yellow
$candidateTs = "$wsRoot\packages\pd-cli\src\commands\candidate.ts"
if (Test-Path $candidateTs) {
    $matches = Select-String -Path $candidateTs -Pattern 'checkAdmissionGate|evaluateCandidateAdmission|admissionGate' -AllMatches
    if ($matches) {
        Write-Host "  [OK] admission gate references found:" -ForegroundColor Green
        $matches | ForEach-Object { Write-Host "    $($_.LineNumber): $($_.Line.Trim())" }
    } else {
        Write-Host "  [FAIL] No admission gate references in candidate.ts" -ForegroundColor Red
    }
}

# ============================================================
# 2. F9-2/F10-2 integrity check FK dangling detection
# ============================================================
Write-Host "`n[2.2] integrity check FK dangling detection" -ForegroundColor Yellow
$integrityFile = "$wsRoot\packages\principles-core\src\runtime-v2\internalization-chain-integrity-read-model.ts"
if (Test-Path $integrityFile) {
    $f9 = Select-String -Path $integrityFile -Pattern 'activation_artifact_id_dangling' -SimpleMatch
    $f10 = Select-String -Path $integrityFile -Pattern 'candidate_source_run_id_dangling' -SimpleMatch
    if ($f9) {
        Write-Host "  [OK] F9-2 activation_artifact_id_dangling at line $($f9.LineNumber)" -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] F9-2 missing activation_artifact_id_dangling" -ForegroundColor Red
    }
    if ($f10) {
        Write-Host "  [OK] F10-2 candidate_source_run_id_dangling at line $($f10.LineNumber)" -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] F10-2 missing candidate_source_run_id_dangling" -ForegroundColor Red
    }
}

# ============================================================
# 3. F9-3 dispatcher idempotency artifact_mismatch check
# ============================================================
Write-Host "`n[2.3] F9-3 dispatcher artifact_id consistency" -ForegroundColor Yellow
$dispFile = "$wsRoot\packages\principles-core\src\runtime-v2\activation\activation-dispatcher.ts"
if (Test-Path $dispFile) {
    $f93 = Select-String -Path $dispFile -Pattern 'idempotency_artifact_mismatch|inputArtifactId' -SimpleMatch
    if ($f93) {
        Write-Host "  [OK] F9-3 found:" -ForegroundColor Green
        $f93 | Select-Object -First 3 | ForEach-Object { Write-Host "    L$($_.LineNumber): $($_.Line.Trim())" }
    } else {
        Write-Host "  [FAIL] F9-3 missing idempotency_artifact_mismatch" -ForegroundColor Red
    }
}

# ============================================================
# 4. R2-RH-002 RuleHost armed-but-empty warn
# ============================================================
Write-Host "`n[2.4] R2-RH-002 RuleHost empty warn" -ForegroundColor Yellow
$rhFile = "$wsRoot\packages\openclaw-plugin\src\core\rule-host.ts"
if (Test-Path $rhFile) {
    $warn = Select-String -Path $rhFile -Pattern 'emptyLoadWarnEmitted|armed but empty|armed-but-empty' -SimpleMatch
    if ($warn) {
        Write-Host "  [OK] R2-RH-002 empty warn found:" -ForegroundColor Green
        $warn | Select-Object -First 3 | ForEach-Object { Write-Host "    L$($_.LineNumber): $($_.Line.Trim())" }
    } else {
        Write-Host "  [FAIL] R2-RH-002 missing empty warn" -ForegroundColor Red
    }
}

# ============================================================
# 5. R2-RH-004 principleId lineage (source_principle_id column)
# ============================================================
Write-Host "`n[2.5] R2-RH-004 principleId lineage" -ForegroundColor Yellow
if (Test-Path $rhFile) {
    $lineage = Select-String -Path $rhFile -Pattern 'source_principle_id|sourcePrincipleId' -SimpleMatch
    if ($lineage) {
        Write-Host "  [OK] R2-RH-004 source_principle_id read:" -ForegroundColor Green
        $lineage | Select-Object -First 3 | ForEach-Object { Write-Host "    L$($_.LineNumber): $($_.Line.Trim())" }
    } else {
        Write-Host "  [FAIL] R2-RH-004 missing source_principle_id" -ForegroundColor Red
    }
}

# ============================================================
# 6. F12 schema_version setSchemaVersion call
# ============================================================
Write-Host "`n[2.6] F12 schema_version persistence" -ForegroundColor Yellow
$sqliteFile = "$wsRoot\packages\principles-core\src\runtime-v2\store\sqlite-connection.ts"
if (Test-Path $sqliteFile) {
    $f12 = Select-String -Path $sqliteFile -Pattern "setSchemaVersion\('001'\)|setSchemaVersion\(`001`\)" -SimpleMatch
    if (-not $f12) {
        $f12 = Select-String -Path $sqliteFile -Pattern 'setSchemaVersion' -SimpleMatch
    }
    if ($f12) {
        Write-Host "  [OK] F12 setSchemaVersion call:" -ForegroundColor Green
        $f12 | Select-Object -First 3 | ForEach-Object { Write-Host "    L$($_.LineNumber): $($_.Line.Trim())" }
    } else {
        Write-Host "  [FAIL] F12 missing setSchemaVersion" -ForegroundColor Red
    }
}

# ============================================================
# 7. F14-1 core flag category preserved (defaultFlag.category)
# ============================================================
Write-Host "`n[2.7] F14-1 core flag category preservation" -ForegroundColor Yellow
$flagRegFiles = @(
    "$wsRoot\packages\principles-core\src\feature-flags\feature-flag-contract.ts",
    "$wsRoot\packages\openclaw-plugin\src\feature-flags\feature-flag-registry.ts"
)
foreach ($f in $flagRegFiles) {
    if (Test-Path $f) {
        $f14 = Select-String -Path $f -Pattern 'defaultFlag\.category|entry\.category\s*=|category:\s*defaultFlag' -SimpleMatch
        if ($f14) {
            Write-Host "  [OK] $($f | Split-Path -Leaf):" -ForegroundColor Green
            $f14 | Select-Object -First 2 | ForEach-Object { Write-Host "    L$($_.LineNumber): $($_.Line.Trim())" }
        }
    }
}

# ============================================================
# 8. F15 empathy_observer flag consumption
# ============================================================
Write-Host "`n[2.8] F15 empathy_observer flag consumption" -ForegroundColor Yellow
$empathyFiles = Get-ChildItem -Path "$wsRoot\packages" -Recurse -Filter "*.ts" -ErrorAction SilentlyContinue |
    Select-String -Pattern 'empathy_observer|resolveEmpathyObserver' -SimpleMatch -List
if ($empathyFiles) {
    Write-Host "  [OK] empathy_observer references:" -ForegroundColor Green
    $empathyFiles | Select-Object -First 5 | ForEach-Object { Write-Host "    $($_.Path | Split-Path -Leaf):$($_.LineNumber)" }
} else {
    Write-Host "  [FAIL] F15 no empathy_observer references" -ForegroundColor Red
}

# ============================================================
# 9. F7-6 retry_wait staleness detection
# ============================================================
Write-Host "`n[2.9] F7-6 retry_wait staleness" -ForegroundColor Yellow
$guardsFile = "$wsRoot\packages\principles-core\src\runtime-v2\internalization-task-guards.ts"
$readModelFiles = Get-ChildItem -Path "$wsRoot\packages\principles-core\src\runtime-v2" -Recurse -Filter "*.ts" -ErrorAction SilentlyContinue
$staleRef = $readModelFiles | Select-String -Pattern 'retry_wait_stale|isRetryWaitStale|DEFAULT_RETRY_WAIT_STALE_TTL_MS' -SimpleMatch
if ($staleRef) {
    Write-Host "  [OK] F7-6 staleness detection:" -ForegroundColor Green
    $staleRef | Select-Object -First 5 | ForEach-Object { Write-Host "    $($_.Path | Split-Path -Leaf):$($_.LineNumber): $($_.Line.Trim())" }
} else {
    Write-Host "  [WARN] F7-6 no staleness references (may be removed per F7-6 follow-up)" -ForegroundColor Yellow
}

# ============================================================
# 10. Runtime probe on B-group (if exists)
# ============================================================
Write-Host "`n[2.10] Runtime probe on B-group integrity" -ForegroundColor Yellow
$wsB = "D:\.openclaw\workspace\acceptance\release-$ts\env-b-clean"
if (Test-Path "$wsB\.pd\state.db") {
    $result = pd runtime internalization integrity --workspace $wsB --json 2>&1 | Out-String
    $result | Out-File "$evidenceDir\phase2-b-integrity.json" -Encoding UTF8
    if ($result -match 'degraded|broken|dangling') {
        Write-Host "  [WARN] integrity check found issues:" -ForegroundColor Yellow
        $result | Select-Object -First 5
    } else {
        Write-Host "  [OK] integrity check passed (or healthy)" -ForegroundColor Green
    }
} else {
    Write-Host "  [SKIP] B-group state.db not present (skip runtime integrity)" -ForegroundColor Yellow
}

# ============================================================
# Summary
# ============================================================
Write-Host "`n=== Phase 2 Summary ===" -ForegroundColor Cyan
Write-Host "Source-level verification of R2 P1 fixes complete."
Write-Host "Runtime verification limited because installed PD package is stale (Bug-B-001 regression)."
Write-Host "Evidence saved to: $evidenceDir\phase2-*"
