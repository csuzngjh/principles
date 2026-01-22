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
PAIN_FLAG="$PROJECT_DIR/docs/.pain_flag"
ISSUE_LOG="$PROJECT_DIR/docs/ISSUE_LOG.md"
DECISIONS="$PROJECT_DIR/docs/DECISIONS.md"

mkdir -p "$PROJECT_DIR/docs"

# If no pain, do nothing (keep it fast)
if [[ ! -f "$PAIN_FLAG" ]]; then
  exit 0
fi

# Ensure files exist
touch "$ISSUE_LOG" "$DECISIONS"

ts="$(date -Iseconds)"
title="Pain detected - $(sed -n '1,6p' "$PAIN_FLAG" | tr '\n' ' ' | cut -c1-80)"

{
  echo ""
  echo "## [$ts] $title"
  echo ""
  echo "### Pain Signal (auto-captured)"
  echo '```'
  cat "$PAIN_FLAG"
  echo '```'
  echo ""
  echo "### Diagnosis (to be filled by Claude)"
  echo "- Proximal cause (verb):"
  echo "- Root cause (adjective/design/assumption):"
  echo "- 5 Whys:"
  echo "  1."
  echo "  2."
  echo "  3."
  echo "  4."
  echo "  5."
  echo "- Category: People | Design | Assumption"
  echo ""
  echo "### Principle Candidate"
  echo "- Principle:"
  echo "- Trigger:"
  echo "- Exceptions:"
  echo ""
  echo "### Guardrail Proposal"
  echo "- rule / hook / test:"
  echo "- minimal regression test:"
} >> "$ISSUE_LOG"

{
  echo ""
  echo "## [$ts] Decision checkpoint"
  echo "- Pain flag detected; IssueLog entry appended."
} >> "$DECISIONS"

rm -f "$PAIN_FLAG"
exit 0
