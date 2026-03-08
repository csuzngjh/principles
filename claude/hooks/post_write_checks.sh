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
TOOL="$(echo "$INPUT" | jq -r '.tool_name // empty')"
FILE_PATH="$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')"

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
PROFILE="$PROJECT_DIR/docs/PROFILE.json"
PAIN_FLAG="$PROJECT_DIR/docs/.pain_flag"

if [[ "$TOOL" != "Write" && "$TOOL" != "Edit" ]]; then
  exit 0
fi

if [[ ! -f "$PROFILE" ]]; then
  # no profile => no automated checks
  exit 0
fi

# Determine risk
is_risky="false"
if [[ -n "$FILE_PATH" ]]; then
  rel="${FILE_PATH#"$PROJECT_DIR"/}"
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    if [[ "$rel" == "$p"* ]]; then
      is_risky="true"
      break
    fi
  done < <(jq -r '.risk_paths[]? // empty' "$PROFILE")
fi

# Pick test level
# 检查是否配置了测试（如果没有 tests section 或 commands section，跳过测试）
if ! jq -e '.tests' "$PROFILE" > /dev/null 2>&1; then
  # 没有 tests 配置，静默跳过
  exit 0
fi

if ! jq -e '.tests.commands' "$PROFILE" > /dev/null 2>&1; then
  # 没有 tests.commands 配置，静默跳过
  exit 0
fi

level="$(jq -r '.tests.on_change // "smoke"' "$PROFILE")"
if [[ "$is_risky" == "true" ]]; then
  level="$(jq -r '.tests.on_risk_change // "unit"' "$PROFILE")"
fi

cmd="$(jq -r --arg lvl "$level" '.tests.commands[$lvl] // empty' "$PROFILE")"
if [[ -z "$cmd" ]]; then
  # 如果没有配置对应级别的测试命令，静默跳过
  exit 0
fi

set +e
bash -lc "$cmd"
rc=$?
set -e

if [[ $rc -ne 0 ]]; then
  {
    echo "time: $(date -Iseconds)"
    echo "tool: $TOOL"
    echo "file_path: $FILE_PATH"
    echo "risk: $is_risky"
    echo "test_level: $level"
    echo "command: $cmd"
    echo "exit_code: $rc"
  } > "$PAIN_FLAG"
  echo "Post-write checks failed (rc=$rc). Pain flag written to docs/.pain_flag" >&2
  exit $rc
fi

exit 0
