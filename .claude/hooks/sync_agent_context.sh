#!/usr/bin/env bash
set -euo pipefail

# sync_agent_context.sh
# 目标：将 AGENT_SCORECARD.json 编译为 docs/AGENT_CONTEXT.md
# 确保主智能体能看到子智能体的实时战绩

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
JSON_SCORECARD="$PROJECT_DIR/docs/AGENT_SCORECARD.json"
MD_CONTEXT="$PROJECT_DIR/docs/AGENT_CONTEXT.md"

if [[ ! -f "$JSON_SCORECARD" ]]; then
  exit 0
fi

# 提取分数并映射为评价等级的函数
get_reliability() {
  local score=$1
  if (( score >= 5 )); then echo "High (Trustworthy)";
  elif (( score >= 0 )); then echo "Neutral (Standard)";
  else echo "Low (Risky)"; fi
}

# 使用 jq 生成 Markdown 内容
# 遍历 agents 对象，生成 "- **name**: [Level] (Score: X, Wins: Y, Losses: Z)"
agents_md=$(jq -r '
  .agents | to_entries | map(
    .key as $name |
    .value as $v |
    $v.score as $score |
    (
      if $score >= 5 then "High (Trustworthy)"
      elif $score >= 0 then "Neutral (Standard)"
      else "Low (Risky)" end
    ) as $level |
    "- **" + $name + ": [" + $level + "] (Score: " + ($score|tostring) + ", Wins: " + ($v.wins|tostring) + ", Losses: " + ($v.losses|tostring) + ")"
  ) | join("\n")
' "$JSON_SCORECARD")

# 重新生成 Markdown
{
  echo "# Agent Performance Context (System Generated)"
  echo "> 🛑 DO NOT EDIT MANUALLY. Updated: $(date -Iseconds)"
  echo ""
  echo "## Current Agent Reliability"
  echo "$agents_md"
  echo ""
  echo "## Operational Guidance"
  echo "- If an agent has a **Low/Risky** status, you MUST double-check its output."
  echo "- For 'Low' agents, consider providing more detailed instructions or asking for a self-correction."
} > "$MD_CONTEXT"

# echo "✅ AGENT_CONTEXT.md synchronized."
exit 0
