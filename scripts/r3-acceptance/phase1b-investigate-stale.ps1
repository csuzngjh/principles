# R3 Phase 1b: Investigate why installed PD is stale
$ErrorActionPreference = 'Continue'

$machinePath = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
$env:PATH = "$env:PATH;$machinePath;$userPath"

$dir = "D:\.openclaw\workspace\acceptance\release-2026-07-02T080000Z"
$extDir = "C:\Users\Administrator\.openclaw\extensions\principles-disciple"

Write-Host "=== Installed PD version ==="
if (Test-Path "$extDir\package.json") {
  $pkg = Get-Content "$extDir\package.json" -Raw | ConvertFrom-Json
  Write-Host "name: $($pkg.name)"
  Write-Host "version: $($pkg.version)"
}

Write-Host ""
Write-Host "=== Check runtime-init.js for Bug-B-001 ==="
$initJs = Get-Content "$extDir\pd-cli\dist\commands\runtime-init.js" -Raw -ErrorAction SilentlyContinue
if ($initJs) {
  $importMatches = [regex]::Matches($initJs, "import\s*\{[^}]+\}\s*from\s*['`"]([^'`"]+)['`"]")
  foreach ($m in $importMatches) {
    if ($m.Groups[1].Value -match 'principles-disciple') {
      Write-Host "FOUND import from principles-disciple: $($m.Value)"
    }
  }
  if ($initJs -match 'initTrajectorySchema|initWorkflowSchema') {
    Write-Host "Has initTrajectorySchema/initWorkflowSchema imports"
  }
} else {
  Write-Host "runtime-init.js NOT FOUND at expected path"
  # Search for it
  Get-ChildItem $extDir -Filter "runtime-init*" -Recurse -ErrorAction SilentlyContinue | Select-Object FullName
}

Write-Host ""
Write-Host "=== Check bundle.js for Bug-B-005 (diag_rootcause vs diagnostician) ==="
$bundlePath = "$extDir\dist\bundle.js"
if (Test-Path $bundlePath) {
  $bundle = Get-Content $bundlePath -Raw
  $rootcauseMatches = [regex]::Matches($bundle, 'diag_rootcause')
  $diagnosticianMatches = [regex]::Matches($bundle, 'diagnostician')
  Write-Host "diag_rootcase occurrences: $($rootcauseMatches.Count)"
  Write-Host "diagnostician occurrences: $($diagnosticianMatches.Count)"
  if ($rootcauseMatches.Count -gt 0 -and $diagnosticianMatches.Count -eq 0) {
    Write-Host "[FAIL] Bundle STILL USES diag_rootcause - Bug-B-005 NOT FIXED in installed"
  } elseif ($diagnosticianMatches.Count -gt 0) {
    Write-Host "[PASS] Bundle USES diagnostician - Bug-B-005 FIXED in installed"
  }
} else {
  Write-Host "bundle.js NOT FOUND"
}

Write-Host ""
Write-Host "=== Check pd-cli dist for Bug-B-001 ==="
$pdCliDir = "$extDir\pd-cli"
if (Test-Path "$pdCliDir\dist") {
  # Check if node_modules/principles-disciple symlink exists (Bug-B-004 fix)
  $symlinkPath = "$pdCliDir\node_modules\principles-disciple"
  if (Test-Path $symlinkPath) {
    $item = Get-Item $symlinkPath -Force
    Write-Host "principles-disciple symlink EXISTS: LinkType=$($item.LinkType) Target=$($item.Target)"
  } else {
    Write-Host "[FAIL] principles-disciple symlink NOT FOUND in pd-cli/node_modules - Bug-B-004 NOT FIXED"
  }
  
  # Check the actual import in runtime-init.js
  $runtimeInitPath = "$pdCliDir\dist\commands\runtime-init.js"
  if (Test-Path $runtimeInitPath) {
    $content = Get-Content $runtimeInitPath -Raw
    $lines = $content -split "`n" | Where-Object { $_ -match 'import.*principles-disciple' }
    if ($lines) {
      Write-Host "runtime-init.js imports principles-disciple:"
      foreach ($line in $lines) { Write-Host "  $line" }
    }
  }
}

Write-Host ""
Write-Host "=== File timestamps (most recent) ==="
Get-ChildItem $extDir -Recurse -File | 
  Sort-Object LastWriteTime -Descending | 
  Select-Object -First 10 FullName, LastWriteTime | 
  Format-Table -AutoSize

Write-Host ""
Write-Host "=== openclaw agents list ==="
$agents = openclaw agents list --json 2>&1 | Out-String
$agents | Out-File -FilePath "$dir\evidence\openclaw-agents-list.json" -Encoding UTF8
Write-Host $agents.Substring(0, [Math]::Min(2000, $agents.Length))

Write-Host ""
Write-Host "=== Check if installer needs to be re-run ==="
$repoRoot = "c:\Users\Administrator\.trae-cn\worktrees\principles\feat-pd-product-quality-challenge-hPtFUC"
$installerPath = "$repoRoot\packages\create-principles-disciple\src\installer.ts"
if (Test-Path $installerPath) {
  $installer = Get-Content $installerPath -Raw
  if ($installer -match 'rewriteBundledDependency') {
    Write-Host "[PASS] Source installer.ts has rewriteBundledDependency (Bug-B-002 fix)"
  }
  if ($installer -match "principles-disciple.*symlinkSync|symlinkSync.*principles-disciple") {
    Write-Host "[PASS] Source installer.ts creates principles-disciple symlink (Bug-B-004 fix)"
  }
}

Write-Host ""
Write-Host "=== CONCLUSION ==="
Write-Host "If installed PD is stale, the fix is to re-run the installer:"
Write-Host "  cd $repoRoot\packages\create-principles-disciple"
Write-Host "  node dist\index.js install --workspace <target>"
Write-Host "OR use the published installer:"
Write-Host "  npx create-principles-disciple install --workspace <target>"
