#!/usr/bin/env bash
set -euo pipefail

# 检查 jq 是否可用
if ! command -v jq &> /dev/null; then
  echo "❌ Error: jq is required but not installed" >&2
  exit 1
fi

INPUT="$(cat)"
TOOL="$(echo "$INPUT" | jq -r '.tool_name // empty')"
FILE_PATH="$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')"

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"

log_info() {
  echo "INFO: $*" >&2
}

# 1. 工具筛选
if [[ "$TOOL" != "Write" && "$TOOL" != "Edit" ]]; then
  exit 0
fi

# 2. 基础环境检查
PROFILE="$PROJECT_DIR/docs/PROFILE.json"
PLAN="$PROJECT_DIR/docs/PLAN.md"
AUDIT="$PROJECT_DIR/docs/AUDIT.md"

if [[ ! -f "$PROFILE" ]]; then
  log_info "Blocked: missing docs/PROFILE.json."
  exit 2
fi

# 3. 路径处理
norm_path() {
  echo "$1" | sed 's/\\/\//g' | sed 's/^[a-zA-Z]://'
}

NORM_FILE_PATH=$(norm_path "$FILE_PATH")
NORM_PROJECT_DIR=$(norm_path "$PROJECT_DIR")

# 计算相对路径
REL_PATH="${NORM_FILE_PATH#"$NORM_PROJECT_DIR"/}"
REL_PATH="${REL_PATH#/}"

log_info "TOOL=$TOOL"
log_info "REL_PATH=$REL_PATH"

# 4. 风险判定
is_risky="false"
while IFS= read -r pattern; do
  [[ -z "$pattern" ]] && continue
  log_info "Checking risk pattern: '$pattern'"
  if [[ "$REL_PATH" == "$pattern"* ]]; then
    is_risky="true"
    log_info "Risk pattern MATCHED: $pattern"
    break
  fi
done < <(jq -r '.risk_paths[]? // empty' "$PROFILE")

if [[ "$is_risky" == "false" ]]; then
  log_info "Not a risky path, allowing."
  exit 0
fi

# 5. 门禁核心逻辑
require_plan="$(jq -r '.gate.require_plan_for_risk_paths // true' "$PROFILE")"
require_audit="$(jq -r '.gate.require_audit_before_write // true' "$PROFILE")"

if [[ "$require_plan" == "true" ]]; then
  if [[ ! -f "$PLAN" ]]; then
    log_info "Blocked: Risk edit requires docs/PLAN.md."
    exit 2
  fi

  if ! grep -qiE "^STATUS:\s*READY" "$PLAN"; then
    log_info "Blocked: docs/PLAN.md is not READY."
    exit 2
  fi

  # 目标-凭证对齐检查
  declared_targets=$(awk '
    /^## Target Files/ {flag=1; next}
    /^## / {flag=0}
    flag && /^- / {
      sub(/^- /, "");
      gsub(/^[ \t]+|[ \t]+$/, "");
      print
    }
  ' "$PLAN")

  log_info "Declared targets: $(echo "$declared_targets" | tr '\n' ' ')"

  target_match="false"
  while IFS= read -r target; do
    [[ -z "$target" ]] && continue
    norm_target=$(echo "$target" | sed 's/\\/\//g')
    if [[ "$REL_PATH" == "$norm_target"* ]]; then
      target_match="true"
      log_info "Target matched: $target"
      break
    fi
  done <<< "$declared_targets"

  if [[ "$target_match" == "false" ]]; then
    echo "⛔ Blocked: Semantic Guardrail Triggered" >&2
    echo "Reason: Target file '$REL_PATH' is NOT declared in docs/PLAN.md." >&2
    exit 2
  fi
fi

if [[ "$require_audit" == "true" ]]; then
  if [[ ! -f "$AUDIT" ]]; then
    log_info "Blocked: Risk edit requires docs/AUDIT.md."
    exit 2
  fi
  
  if ! grep -qiE "^RESULT:\s*PASS" "$AUDIT"; then
    log_info "Blocked: docs/AUDIT.md is not PASS."
    exit 2
  fi
fi

log_info "All checks passed."
exit 0
