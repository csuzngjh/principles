#!/usr/bin/env bash
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

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
PROFILE="$PROJECT_DIR/docs/PROFILE.json"
PAIN_FLAG="$PROJECT_DIR/docs/.pain_flag"
ISSUE_LOG="$PROJECT_DIR/docs/ISSUE_LOG.md"
# shellcheck disable=SC2034
CHECKPOINT="$PROJECT_DIR/docs/CHECKPOINT.md"
PLAN="$PROJECT_DIR/docs/PLAN.md"

# 输出会被注入到 Claude 的上下文中
echo "📋 可进化编程智能体已初始化"

# 1. 显示当前配置
if [[ -f "$PROFILE" ]]; then
  echo "  - 审计级别: $(jq -r '.audit_level // "medium"' "$PROFILE")"
  echo "  - 风险路径: $(jq -c '.risk_paths // []' "$PROFILE")"
fi

# 2. 检查断点恢复（关键！）
if [[ -f "$PAIN_FLAG" ]]; then
  echo ""
  echo "⚠️ 检测到未处理的 pain flag（上次任务可能中断）"
  echo "内容摘要："
  head -6 "$PAIN_FLAG" | sed 's/^/    /'
  echo ""
  echo "建议：运行 /evolve-task --recover 完成诊断"
fi

# 3. 检查是否有进行中的计划
if [[ -f "$PLAN" ]]; then
  STATUS=$(grep -E '^STATUS:' "$PLAN" | head -1 | awk '{print $2}' || echo "")
  if [[ "$STATUS" == "IN_PROGRESS" ]]; then
    echo ""
    echo "📌 检测到进行中的计划（STATUS: IN_PROGRESS）"
    echo "建议：继续执行 docs/PLAN.md 中的步骤"
  fi
fi

# 4. 显示最近一条 Issue（上下文恢复）
if [[ -f "$ISSUE_LOG" ]]; then
  LAST_ISSUE=$(grep -E '^## \[' "$ISSUE_LOG" | tail -1 | cut -c1-80 || echo "")
  if [[ -n "$LAST_ISSUE" ]]; then
    echo "  - 最近 Issue: $LAST_ISSUE"
  fi
fi

exit 0
