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
PLAN="$PROJECT_DIR/docs/PLAN.md"
AUDIT="$PROJECT_DIR/docs/AUDIT.md"

# DEBUG: Print raw inputs (controlled by DEBUG_HOOKS env var)
if [[ "${DEBUG_HOOKS:-0}" == "1" ]]; then
  echo "DEBUG: Raw FILE_PATH=$FILE_PATH" >&2
  echo "DEBUG: PROJECT_DIR=$PROJECT_DIR" >&2
fi

# Context: WSL environment where FILE_PATH input is Windows format (e.g. d:\Code)
# but PROJECT_DIR is WSL format (e.g. /mnt/d/Code). We must normalize FILE_PATH.
if [[ "$FILE_PATH" =~ ^[a-zA-Z]: ]]; then
    # Extract drive letter and convert to lowercase
    drive=$(echo "$FILE_PATH" | cut -c1 | tr '[:upper:]' '[:lower:]')
    # Extract path part and convert backslashes to slashes
    path_part=$(echo "$FILE_PATH" | cut -c3- | sed 's/\\/\//g')
    # Construct WSL path
    FILE_PATH="/mnt/$drive/$path_part"
    # echo "DEBUG: Normalized FILE_PATH=$FILE_PATH" >&2
fi

# Only gate Write/Edit
if [[ "$TOOL" != "Write" && "$TOOL" != "Edit" ]]; then
  exit 0
fi

if [[ ! -f "$PROFILE" ]]; then
  echo "Blocked: missing docs/PROFILE.json (required for gating)." >&2
  exit 2
fi

require_plan="$(jq -r '.gate.require_plan_for_risk_paths // false' "$PROFILE")"
require_audit="$(jq -r '.gate.require_audit_before_write // false' "$PROFILE")"

# ... (Keep existing code)

# Determine if file is in risk paths
is_risky="false"
if [[ -n "$FILE_PATH" ]]; then
  # Normalize to project-relative if possible
  # Calculate relative path manually to be safe
  if [[ "$FILE_PATH" == "$PROJECT_DIR"* ]]; then
     rel="${FILE_PATH#"$PROJECT_DIR"/}"
  else
     rel="$FILE_PATH"
  fi

  # DEBUG (uncomment if needed)
  # echo "DEBUG: FILE_PATH=$FILE_PATH" >&2
  # echo "DEBUG: PROJECT_DIR=$PROJECT_DIR" >&2
  # echo "DEBUG: rel=$rel" >&2
  
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    if [[ "$rel" == "$p"* ]]; then
      is_risky="true"
      break
    fi
  done < <(jq -r '.risk_paths[]? // empty' "$PROFILE")
fi

# DEBUG: Print gate state (controlled by DEBUG_HOOKS env var)
if [[ "${DEBUG_HOOKS:-0}" == "1" ]]; then
  echo "DEBUG: is_risky=$is_risky" >&2
  echo "DEBUG: require_plan=$require_plan" >&2
  echo "DEBUG: PLAN=$PLAN" >&2
  ls -l "$PLAN" >&2 || echo "PLAN file not found" >&2
fi

# Gate only for risky paths (or if file path unknown, be conservative)
if [[ "$is_risky" == "true" || -z "$FILE_PATH" ]]; then
# ...
  if [[ "$require_plan" == "true" && ! -f "$PLAN" ]]; then
    echo "Blocked: risk edit requires docs/PLAN.md. Create PLAN first via /evolve-task." >&2
    exit 2
  fi

  if [[ "$require_audit" == "true" ]]; then
    if [[ ! -f "$AUDIT" ]]; then
      echo "Blocked: risk edit requires docs/AUDIT.md with RESULT: PASS. Run audit via /evolve-task." >&2
      exit 2
    fi
    if ! grep -qE '^RESULT:\s*PASS\b' "$AUDIT"; then
      echo "Blocked: docs/AUDIT.md must contain 'RESULT: PASS' before risk edits." >&2
      exit 2
    fi
  fi
fi

exit 0
