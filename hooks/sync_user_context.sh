#!/usr/bin/env bash
set -euo pipefail

# sync_user_context.sh
# 目标：将 USER_PROFILE.json 编译为 docs/USER_CONTEXT.md
# 确保 AI 始终能通过 CLAUDE.md 感知用户画像

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
JSON_PROFILE="$PROJECT_DIR/docs/USER_PROFILE.json"
MD_CONTEXT="$PROJECT_DIR/docs/USER_CONTEXT.md"

if [[ ! -f "$JSON_PROFILE" ]]; then
  echo "Error: $JSON_PROFILE not found." >&2
  exit 1
fi

# 提取分数并映射为评价等级的函数
get_level() {
  local score=$1
  if (( score >= 10 )); then echo "Expert";
  elif (( score >= 5 )); then echo "Proficient";
  elif (( score >= 0 )); then echo "Intermediate";
  else echo "Novice/Low"; fi
}

# 读取 Domains
frontend_score=$(jq -r '.domains.frontend // 0' "$JSON_PROFILE")
backend_score=$(jq -r '.domains.backend // 0' "$JSON_PROFILE")
infra_score=$(jq -r '.domains.infra // 0' "$JSON_PROFILE")
security_score=$(jq -r '.domains.security // 0' "$JSON_PROFILE")

frontend_level=$(get_level "$frontend_score")
backend_level=$(get_level "$backend_score")
infra_level=$(get_level "$infra_score")
security_level=$(get_level "$security_score")

# 读取 Preferences (Key-Value)
# 使用 jq 将 preferences 对象转换为 "- Key: Value" 格式的列表
preferences_md=$(jq -r '.preferences | to_entries | map("- **" + .key + "**: " + (.value|tostring)) | join("\n")' "$JSON_PROFILE")

# 重新生成 Markdown
{
  echo "# User Cognitive Profile (System Generated)"
  echo "> 🛑 DO NOT EDIT MANUALLY. Updated: $(date -Iseconds)"
  echo "> This file helps you calibrate your stance and prevent blindly following wrong directives."
  echo ""
  echo "## Current Domain Expertise"
  echo "- **Frontend**: [$frontend_level] (Score: $frontend_score)"
  echo "- **Backend**: [$backend_level] (Score: $backend_score)"
  echo "- **Infrastructure**: [$infra_level] (Score: $infra_score)"
  echo "- **Security**: [$security_level] (Score: $security_score)"
  echo ""
  
  if [[ -n "$preferences_md" ]]; then
    echo "## Communication Preferences"
    echo "$preferences_md"
    echo ""
  fi

  echo "## Interaction Strategy"
  
  if [[ "$frontend_level" == "Novice/Low" ]]; then
    echo "- **Frontend Control**: High vigilance. User might give suboptimal UI/UX directives. Strictly verify against best practices."
  else
    echo "- **Frontend Control**: Collaborative. Trust user's UI preferences but maintain code quality."
  fi

  if [[ "$backend_level" == "Novice/Low" ]]; then
    echo "- **Backend Control**: Mandatory Auditor review. Reject unsafe architecture or data flow changes."
  else
    echo "- **Backend Control**: Highly reliable. Accelerate execution of user's architectural suggestions."
  fi

  echo "- **Guidance**: If the user is a 'Novice' in a domain, focus on education and providing safer alternatives."
} > "$MD_CONTEXT"

echo "✅ USER_CONTEXT.md synchronized with latest profile scores."