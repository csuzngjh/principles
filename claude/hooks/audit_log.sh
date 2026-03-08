#!/usr/bin/env bash
# Audit Trail Logger - 记录所有 hook 执行到 AUDIT_TRAIL.log
# 兼容 Windows Git Bash

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

INPUT="$(cat)"

# 从环境变量获取 hook 类型（需要在 settings.json 中传入）
HOOK_TYPE="${CLAUDE_HOOK_TYPE:-Unknown}"

# 解析输入
TOOL="$(echo "$INPUT" | jq -r '.tool_name // "-"')"
FILE_PATH="$(echo "$INPUT" | jq -r '.tool_input.file_path // "-"')"
AGENT_TYPE="$(echo "$INPUT" | jq -r '.agent_type // "-"')"
STOP_REASON="$(echo "$INPUT" | jq -r '.stop_reason // "-"')"

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
AUDIT_LOG="$PROJECT_DIR/docs/AUDIT_TRAIL.log"
PROFILE="$PROJECT_DIR/docs/PROFILE.json"

mkdir -p "$PROJECT_DIR/docs"
touch "$AUDIT_LOG"

ts="$(date '+%Y-%m-%dT%H:%M:%S')"

# 判断是否为风险路径
is_risky="N"
if [[ -f "$PROFILE" && "$FILE_PATH" != "-" ]]; then
  rel="${FILE_PATH#"$PROJECT_DIR"/}"
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    if [[ "$rel" == "$p"* ]]; then
      is_risky="Y"
      break
    fi
  done < <(jq -r '.risk_paths[]? // empty' "$PROFILE" 2>/dev/null || true)
fi

# 生成日志条目
case "$HOOK_TYPE" in
  PreToolUse)
    echo "[$ts] PRE   | $TOOL | file=$FILE_PATH | risk=$is_risky" >> "$AUDIT_LOG"
    ;;
  PostToolUse)
    echo "[$ts] POST  | $TOOL | file=$FILE_PATH | risk=$is_risky" >> "$AUDIT_LOG"
    ;;
  Stop)
    PAIN_EXISTS="N"
    [[ -f "$PROJECT_DIR/docs/.pain_flag" ]] && PAIN_EXISTS="Y"
    echo "[$ts] STOP  | reason=$STOP_REASON | pain_flag=$PAIN_EXISTS" >> "$AUDIT_LOG"
    ;;
  SubagentStop)
    echo "[$ts] AGENT | $AGENT_TYPE | completed" >> "$AUDIT_LOG"
    ;;
  SessionStart)
    echo "[$ts] START | session initialized" >> "$AUDIT_LOG"
    ;;
  PreCompact)
    echo "[$ts] COMPACT | context compression triggered" >> "$AUDIT_LOG"
    ;;
  *)
    echo "[$ts] $HOOK_TYPE | $TOOL | $FILE_PATH" >> "$AUDIT_LOG"
    ;;
esac

exit 0
