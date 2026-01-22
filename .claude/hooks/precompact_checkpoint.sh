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
CHECKPOINT="$PROJECT_DIR/docs/CHECKPOINT.md"

ts="$(date -Iseconds)"
mkdir -p "$PROJECT_DIR/docs"
touch "$CHECKPOINT"

echo "" >> "$CHECKPOINT"
echo "## PreCompact checkpoint [$ts]" >> "$CHECKPOINT"

if [[ -f "$PROFILE" ]]; then
  echo "- PROFILE.audit_level: $(jq -r '.audit_level // "n/a"' "$PROFILE")" >> "$CHECKPOINT"
  echo "- PROFILE.risk_paths: $(jq -c '.risk_paths // []' "$PROFILE")" >> "$CHECKPOINT"
fi

exit 0
