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

INPUT="$(cat)"
AGENT_NAME="$(echo "$INPUT" | jq -r '.agent_type // empty')"

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
SCORECARD="$PROJECT_DIR/docs/AGENT_SCORECARD.json"

# 如果没有 agent 名称或文件不存在，跳过
if [[ -z "$AGENT_NAME" || ! -f "$SCORECARD" ]]; then
  exit 0
fi

# 检查是否成功完成（通过检查是否有 pain flag）
PAIN_FLAG="$PROJECT_DIR/docs/.pain_flag"

if [[ -f "$PAIN_FLAG" ]]; then
  # 存在 pain flag，记录为失败
  jq --arg agent "$AGENT_NAME" '
    .agents[$agent].losses += 1 |
    .agents[$agent].score -= 1
  ' "$SCORECARD" > "${SCORECARD}.tmp" && mv "${SCORECARD}.tmp" "$SCORECARD"
else
  # 无 pain flag，记录为成功
  jq --arg agent "$AGENT_NAME" '
    .agents[$agent].wins += 1 |
    .agents[$agent].score += 1
  ' "$SCORECARD" > "${SCORECARD}.tmp" && mv "${SCORECARD}.tmp" "$SCORECARD"
fi

exit 0
