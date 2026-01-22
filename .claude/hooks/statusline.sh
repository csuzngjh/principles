#!/usr/bin/env bash
# Status Line for Evolvable Programming Agent
# 实时显示：模式 | 上下文使用率 | Pain Flag 状态 | Git 分支

set -euo pipefail

# 检查 jq 是否可用
if ! command -v jq &> /dev/null; then
  echo "❌ Error: jq is required but not installed" >&2
  echo "" >&2
  echo "Install jq:" >&2
  if [[ "$(uname -s)" == *"MINGW"* ]] || [[ "$(uname -s)" == *"MSYS"* ]]; then
    echo "  Windows (Git Bash): choco install jq" >&2
  elif [[ "$(uname -s)" == "Darwin" ]]; then
    echo "  macOS: brew install jq" >&2
  else
    echo "  Linux/WSL: sudo apt-get install jq" >&2
  fi
  exit 1
fi

input=$(cat)

# 解析 JSON
MODEL=$(echo "$input" | jq -r '.model.display_name // "?"')
PERCENT_USED=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)
# shellcheck disable=SC2034
CURRENT_DIR=$(echo "$input" | jq -r '.workspace.current_dir // "."')
PROJECT_DIR=$(echo "$input" | jq -r '.workspace.project_dir // "."')

# 检测 Pain Flag
PAIN_STATUS=""
if [[ -f "$PROJECT_DIR/docs/.pain_flag" ]]; then
  PAIN_STATUS=" | ⚠️ PAIN"
fi

# 检测 PLAN 状态
PLAN_STATUS=""
if [[ -f "$PROJECT_DIR/docs/PLAN.md" ]]; then
  STATUS=$(grep -E '^STATUS:' "$PROJECT_DIR/docs/PLAN.md" 2>/dev/null | head -1 | awk '{print $2}')
  case "$STATUS" in
    READY) PLAN_STATUS=" | 📋 PLAN:READY" ;;
    IN_PROGRESS) PLAN_STATUS=" | 🔄 PLAN:WIP" ;;
    *) PLAN_STATUS="" ;;
  esac
fi

# 检测 AUDIT 状态
AUDIT_STATUS=""
if [[ -f "$PROJECT_DIR/docs/AUDIT.md" ]]; then
  RESULT=$(grep -E '^RESULT:' "$PROJECT_DIR/docs/AUDIT.md" 2>/dev/null | head -1 | awk '{print $2}')
  case "$RESULT" in
    PASS) AUDIT_STATUS=" | ✅ AUDIT" ;;
    FAIL) AUDIT_STATUS=" | ❌ AUDIT" ;;
    *) AUDIT_STATUS="" ;;
  esac
fi

# Git 分支
GIT_BRANCH=""
if git -C "$PROJECT_DIR" rev-parse --git-dir > /dev/null 2>&1; then
  BRANCH=$(git -C "$PROJECT_DIR" branch --show-current 2>/dev/null)
  if [[ -n "$BRANCH" ]]; then
    GIT_BRANCH=" | 🌿 $BRANCH"
  fi
fi

# 上下文使用率颜色提示
CTX_INDICATOR="📊 ${PERCENT_USED}%"
if (( PERCENT_USED > 80 )); then
  CTX_INDICATOR="🔴 ${PERCENT_USED}%"
elif (( PERCENT_USED > 60 )); then
  CTX_INDICATOR="🟡 ${PERCENT_USED}%"
else
  CTX_INDICATOR="🟢 ${PERCENT_USED}%"
fi

# 输出状态栏
echo "[$MODEL] $CTX_INDICATOR$PAIN_STATUS$PLAN_STATUS$AUDIT_STATUS$GIT_BRANCH"
