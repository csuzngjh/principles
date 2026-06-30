# scripts/setup-worktree.ps1
# 一键配置 git worktree 环境 (Trae/Qoder/Gemini 等 IDE 创建的 worktree 通用)
#
# 用法:
#   .\scripts\setup-worktree.ps1                  # 全套配置
#   .\scripts\setup-worktree.ps1 -SkipInstall     # 跳过 npm install
#   .\scripts\setup-worktree.ps1 -SkipBuild       # 跳过 npm run build 验证
#   .\scripts\setup-worktree.ps1 -SkipPrivateDocs # 跳过 private docs junction
#   .\scripts\setup-worktree.ps1 -WhatIf          # 干跑,只打印不执行
#
# 设计原则:
#   1. 幂等:可重复运行,已就绪的步骤跳过
#   2. Fail loud:任一步骤失败立即报告并退出,不静默继续
#   3. 可选择:参数控制是否跑某步
#   4. 诊断友好:每步打印 [ok]/[skip]/[fail] 状态
#
# 解决的问题:
#   - Trae IDE terminal PATH bug (git/node/npm 不可用)
#   - 新 worktree 缺失 docs/.private junction
#   - 新 worktree 缺失 node_modules
#   - worktree 创建后忘记初始化导致 AI 助手读到错误状态
#
# 不解决的问题 (out of scope):
#   - 分支同步 (用 git rebase main 手动处理,属于开发流程)
#   - graphify 缓存重建 (git commit 时自动触发)
#   - private repo 内容管理 (独立仓库,本脚本只负责 junction)

[CmdletBinding(SupportsShouldProcess)]
param(
  [switch]$SkipInstall,
  [switch]$SkipBuild,
  [switch]$SkipPrivateDocs
)

$ErrorActionPreference = 'Stop'
$startTime = Get-Date

# 步骤计数
$script:okCount = 0
$script:skipCount = 0
$script:failCount = 0

function Write-Step {
  param([string]$Status, [string]$Message)
  $color = switch ($Status) {
    'ok'   { 'Green' }
    'skip' { 'Yellow' }
    'fail' { 'Red' }
    default { 'Gray' }
  }
  Write-Host "[$Status] $Message" -ForegroundColor $color
  switch ($Status) {
    'ok'   { $script:okCount++ }
    'skip' { $script:skipCount++ }
    'fail' { $script:failCount++ }
  }
}

function Test-Command {
  param([string]$Name)
  $null = Get-Command $Name -ErrorAction SilentlyContinue
  return $?
}

function Invoke-Step {
  param(
    [string]$Name,
    [scriptblock]$Action,
    [scriptblock]$Verify
  )
  if ($PSCmdlet.ShouldProcess($Name)) {
    try {
      & $Action
      if ($Verify -and -not (& $Verify)) {
        Write-Step 'fail' "$Name (verify failed)"
        return $false
      }
      Write-Step 'ok' $Name
      return $true
    } catch {
      Write-Step 'fail' "$Name : $_"
      return $false
    }
  } else {
    Write-Step 'skip' "$Name (WhatIf)"
    return $true
  }
}

Write-Host "=========================================="
Write-Host " PD Worktree Setup"
Write-Host " $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host "=========================================="
Write-Host ""

# ============================================================================
# Step 1: PATH 修复 (Trae IDE bug)
# ============================================================================
Write-Host "Step 1: Restore system PATH (Trae IDE bug workaround)"

$pathNeedsFix = -not (Test-Command 'git') -or -not (Test-Command 'node') -or -not (Test-Command 'npm')
if ($pathNeedsFix) {
  $pathOk = Invoke-Step -Name "Restore PATH" -Action {
    $machinePath = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
    $env:PATH = "$env:PATH;$machinePath;$userPath"
  } -Verify {
    (Test-Command 'git') -and (Test-Command 'node') -and (Test-Command 'npm')
  }
  if (-not $pathOk) {
    Write-Host ""
    Write-Host "PATH 修复失败。请手动检查 git/node/npm 安装位置。" -ForegroundColor Red
    exit 1
  }
} else {
  Write-Step 'skip' "PATH (git/node/npm already available)"
}

# ============================================================================
# Step 2: 验证在 PD worktree 内
# ============================================================================
Write-Host ""
Write-Host "Step 2: Verify PD worktree context"

$repoRoot = $null
$inWorktree = $false

$rootOk = Invoke-Step -Name "Detect PD repo root" -Action {
  # 向上查找含 principles-disciple-monorepo 的 package.json
  # 注意: Get-Location 返回 PathInfo,没有 .Parent 属性,必须转 DirectoryInfo
  $dir = Get-Item (Get-Location).Path
  while ($dir) {
    $pkg = Join-Path $dir.FullName 'package.json'
    if (Test-Path $pkg) {
      $content = Get-Content $pkg -Raw -ErrorAction SilentlyContinue
      if ($content -match '"principles-disciple-monorepo"') {
        $script:repoRoot = $dir.FullName
        $script:inWorktree = $true
        return
      }
    }
    $dir = $dir.Parent
  }
  throw "Not in PD worktree (no package.json with 'principles-disciple-monorepo' found in ancestors)"
} -Verify { $script:inWorktree }

if (-not $rootOk) { exit 1 }
if ($repoRoot) { Write-Host "      Repo root: $repoRoot" }

# 显示当前 worktree 信息
try {
  $currentBranch = git -C $repoRoot rev-parse --abbrev-ref HEAD 2>$null
  $currentCommit = git -C $repoRoot rev-parse --short HEAD 2>$null
  Write-Host "      Branch: $currentBranch @ $currentCommit"
} catch {
  Write-Step 'skip' "git info (detached HEAD or not a git repo?)"
}

# ============================================================================
# Step 3: Private docs junction
# ============================================================================
Write-Host ""
Write-Host "Step 3: Private docs junction (docs/.private)"

if ($SkipPrivateDocs) {
  Write-Step 'skip' "Private docs junction (-SkipPrivateDocs)"
} else {
  $junctionPath = Join-Path $repoRoot 'docs\.private'
  $privateTarget = 'D:\Code\principles-private\docs'

  if (Test-Path $junctionPath) {
    $existing = Get-Item $junctionPath -Force -ErrorAction SilentlyContinue
    if ($existing -and $existing.LinkType -eq 'Junction' -and "$($existing.Target)" -eq $privateTarget) {
      Write-Step 'skip' "docs\.private -> $privateTarget (already correct)"
    } else {
      Write-Step 'fail' "docs\.private exists but is not the expected junction. Manual inspection required."
    }
  } else {
    # Junction 缺失,运行现有脚本
    $setupScript = Join-Path $repoRoot 'scripts\setup-private-docs-symlink.ps1'
    if (-not (Test-Path $setupScript)) {
      Write-Step 'fail' "scripts\setup-private-docs-symlink.ps1 not found"
    } else {
      $junctionOk = Invoke-Step -Name "Create docs\.private junction" -Action {
        & $setupScript
        if ($LASTEXITCODE -ne 0) { throw "setup-private-docs-symlink.ps1 exited with $LASTEXITCODE" }
      } -Verify {
        (Test-Path $junctionPath) -and (Test-Path (Join-Path $junctionPath 'product\emotional-value.md'))
      }
      if (-not $junctionOk) {
        Write-Host ""
        Write-Host "Private docs junction 创建失败。" -ForegroundColor Yellow
        Write-Host "可能原因:" -ForegroundColor Yellow
        Write-Host "  1. D:\Code\principles-private\docs 不存在 (需先 git clone private repo)"
        Write-Host "  2. private repo 工作区文件被误删 (在 private repo 运行 'git restore docs/')"
        Write-Host "  3. 权限问题"
        Write-Host "脚本继续,但 AI 助手将无法访问 private docs。" -ForegroundColor Yellow
      }
    }
  }
}

# ============================================================================
# Step 4: 依赖安装
# ============================================================================
Write-Host ""
Write-Host "Step 4: Dependencies (npm install)"

if ($SkipInstall) {
  Write-Step 'skip' "npm install (-SkipInstall)"
} else {
  $nodeModulesPath = Join-Path $repoRoot 'node_modules'
  $needsInstall = -not (Test-Path $nodeModulesPath)

  if (-not $needsInstall) {
    # 检查 node_modules 是否完整
    # 1. 有 .package-lock.json (npm install 完成标志)
    # 2. 有 @types/node (core build 必需,常因不完整 install 缺失)
    $lockCheck = Join-Path $nodeModulesPath '.package-lock.json'
    $typesNodeCheck = Join-Path $nodeModulesPath '@types\node'
    if (-not (Test-Path $lockCheck) -or -not (Test-Path $typesNodeCheck)) {
      $needsInstall = $true
      Write-Host "      node_modules incomplete (missing .package-lock.json or @types/node)"
    }
  }

  if ($needsInstall) {
    $installOk = Invoke-Step -Name "npm install" -Action {
      & npm install --prefix $repoRoot 2>&1 | Out-Host
      if ($LASTEXITCODE -ne 0) { throw "npm install exited with $LASTEXITCODE" }
    } -Verify {
      (Test-Path $nodeModulesPath) -and (Test-Path (Join-Path $nodeModulesPath '.package-lock.json'))
    }
    if (-not $installOk) { exit 1 }
  } else {
    Write-Step 'skip' "npm install (node_modules already present)"
  }
}

# ============================================================================
# Step 5: 构建验证
# ============================================================================
Write-Host ""
Write-Host "Step 5: Build verification"

if ($SkipBuild) {
  Write-Step 'skip' "npm run build (-SkipBuild)"
} else {
  # 检查 @principles/core dist 是否已构建
  $coreDist = Join-Path $repoRoot 'packages\principles-core\dist'
  $needsBuild = -not (Test-Path $coreDist)

  if ($needsBuild) {
    $buildOk = Invoke-Step -Name "npm run build" -Action {
      & npm run build --prefix $repoRoot 2>&1 | Out-Host
      if ($LASTEXITCODE -ne 0) { throw "npm run build exited with $LASTEXITCODE" }
    } -Verify {
      (Test-Path $coreDist) -and (Test-Path (Join-Path $coreDist 'index.js'))
    }
    if (-not $buildOk) { exit 1 }
  } else {
    Write-Step 'skip' "npm run build (dist already present)"
  }
}

# ============================================================================
# Step 6: 健康检查
# ============================================================================
Write-Host ""
Write-Host "Step 6: Health check"

# 6a: git 可用
if (Test-Command 'git') {
  Write-Step 'ok' "git available"
} else {
  Write-Step 'fail' "git not available"
}

# 6b: node 可用
if (Test-Command 'node') {
  $nodeVer = node --version 2>$null
  Write-Step 'ok' "node available ($nodeVer)"
} else {
  Write-Step 'fail' "node not available"
}

# 6c: npm 可用
if (Test-Command 'npm') {
  Write-Step 'ok' "npm available"
} else {
  Write-Step 'fail' "npm not available"
}

# 6d: 关键文件存在
$criticalFiles = @(
  'package.json',
  'AGENTS.md',
  'CLAUDE.md',
  '.trae\rules\project_rules.md'
)

foreach ($f in $criticalFiles) {
  $fullPath = Join-Path $repoRoot $f
  if (Test-Path $fullPath) {
    Write-Step 'ok' "  - $f"
  } else {
    Write-Step 'fail' "  - $f (missing)"
  }
}

# 6e: private docs 可读性 (warning, 不阻塞)
$emotionalValuePath = Join-Path $repoRoot 'docs\.private\product\emotional-value.md'
if (Test-Path $emotionalValuePath) {
  Write-Step 'ok' "private docs readable (emotional-value.md OK)"
} else {
  Write-Step 'skip' "private docs not readable (run scripts\setup-private-docs-symlink.ps1 manually)"
}

# 6f: pnpm 残留检测 (warning)
$pnpmLock = Join-Path $repoRoot 'pnpm-lock.yaml'
$pnpmWorkspace = Join-Path $repoRoot 'pnpm-workspace.yaml'
$hasPnpm = (Test-Path $pnpmLock) -or (Test-Path $pnpmWorkspace)
if ($hasPnpm) {
  Write-Step 'fail' "pnpm files detected (project uses npm). Run: Remove-Item pnpm-lock.yaml, pnpm-workspace.yaml"
}

# ============================================================================
# 总结
# ============================================================================
$elapsed = (Get-Date) - $startTime
Write-Host ""
Write-Host "=========================================="
Write-Host " Setup complete"
Write-Host "=========================================="
Write-Host "ok:    $script:okCount"
Write-Host "skip:  $script:skipCount"
Write-Host "fail:  $script:failCount"
Write-Host "time:  $($elapsed.TotalSeconds.ToString('0.0'))s"
Write-Host ""

if ($script:failCount -gt 0) {
  Write-Host "有失败项,请检查上方 [fail] 输出。" -ForegroundColor Red
  exit 1
} else {
  Write-Host "Worktree 已就绪,可以开始开发。" -ForegroundColor Green
  exit 0
}
