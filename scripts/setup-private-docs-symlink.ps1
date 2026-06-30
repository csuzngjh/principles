# scripts/setup-private-docs-symlink.ps1
# 在所有 worktree 中创建 docs/.private → D:/Code/principles-private/docs 的 junction
# 用法:.\scripts\setup-private-docs-symlink.ps1
#
# 注:计划中名为 symlink,实际用 Junction 代替 SymbolicLink,因为:
#   - Junction 不需要管理员权限或开发者模式
#   - Junction 只能指向本地目录(本场景符合)
#   - Junction 对 AI 助手透明(像普通目录一样访问)
#   - SymbolicLink 在 Windows 上需要管理员权限,不适合所有 worktree 自动部署

$ErrorActionPreference = 'Stop'
$privateTarget = 'D:\Code\principles-private\docs'

if (-not (Test-Path $privateTarget)) {
  Write-Error "私人 docs 目录不存在: $privateTarget"
  Write-Host "请先创建独立 git 仓库: git init D:/Code/principles-private"
  exit 1
}

# 获取所有 worktree 路径
$worktrees = git worktree list --porcelain | Where-Object { $_ -match '^worktree ' } | ForEach-Object { ($_ -replace '^worktree ', '').Trim() }

if (-not $worktrees) {
  Write-Warning "未找到任何 worktree,尝试当前目录"
  $worktrees = @((Get-Location).Path)
}

$created = 0
$skipped = 0
$failed = 0
foreach ($wt in $worktrees) {
  $linkPath = Join-Path $wt 'docs\.private'
  if (Test-Path $linkPath) {
    # 验证现有 junction 指向正确目标
    $existing = Get-Item $linkPath -Force -ErrorAction SilentlyContinue
    if ($existing -and $existing.LinkType -eq 'Junction' -and "$($existing.Target)" -eq $privateTarget) {
      Write-Host "[skip] $linkPath -> $privateTarget (already correct)"
      $skipped++
      continue
    }
    # 指向错误或不是 junction,删除后重建
    try {
      Remove-Item $linkPath -Force -Recurse -ErrorAction Stop
    } catch {
      Write-Warning "[fail] $linkPath : cannot remove existing item: $_"
      $failed++
      continue
    }
  }
  $docsDir = Join-Path $wt 'docs'
  if (-not (Test-Path $docsDir)) {
    New-Item -ItemType Directory -Path $docsDir -Force | Out-Null
  }
  try {
    New-Item -ItemType Junction -Path $linkPath -Target $privateTarget -ErrorAction Stop | Out-Null
    Write-Host "[ok]   $linkPath -> $privateTarget"
    $created++
  } catch {
    Write-Warning "[fail] $linkPath : $_"
    $failed++
  }
}

Write-Host ""
Write-Host "完成: $created 创建,$skipped 跳过,$failed 失败"
if ($failed -gt 0) { exit 1 }
