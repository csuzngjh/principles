#!/usr/bin/env bash
# 批量为所有 hook 脚本添加 jq PATH（Windows 兼容性修复）
set -euo pipefail

HOOKS_DIR=".claude/hooks"
PATH_FIX='# 确保 jq 可用（Windows 兼容性）
'

for script in post_write_checks.sh stop_evolution_update.sh precompact_checkpoint.sh session_init.sh subagent_complete.sh audit_log.sh statusline.sh; do
  file="$HOOKS_DIR/$script"
  if [[ -f "$file" ]]; then
    # 检查是否已添加 PATH fix 注释
    if grep -q "确保 jq 可用" "$file"; then
      echo "- $script already has PATH fix"
    else
      # 在第3行后（set -euo pipefail 之后）插入
      sed -i "3a\\$PATH_FIX" "$file"
      echo "✓ Updated $script"
    fi
  else
    echo "! $script not found"
  fi
done

echo "All hooks updated!"
