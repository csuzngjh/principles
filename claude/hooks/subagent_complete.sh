#!/usr/bin/env bash
set -euo pipefail

# 检查 jq 是否可用
if ! command -v jq &> /dev/null; then
  echo "❌ Error: jq is required but not installed" >&2
  exit 1
fi

INPUT="$(cat)"
AGENT_ID="$(echo "$INPUT" | jq -r '.agent_id // empty')"
AGENT_NAME="$(echo "$INPUT" | jq -r '.agent_type // empty')"

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
SCORECARD="$PROJECT_DIR/docs/AGENT_SCORECARD.json"
VERDICT_FILE="$PROJECT_DIR/docs/.verdict.json"
PAIN_FLAG="$PROJECT_DIR/docs/.pain_flag"

# 如果没有 scorecard，跳过
if [[ ! -f "$SCORECARD" ]]; then
  exit 0
fi

# 1. 获取裁决数据 (The Verdict)
# 优先级：.verdict.json > 启发式检测
win=true
score_delta=0
reason="Normal completion"

if [[ -f "$VERDICT_FILE" ]]; then
  # 校验 verdict 是否属于当前 agent (通过名称匹配，简单有效)
  v_agent=$(jq -r '.target_agent // empty' "$VERDICT_FILE")
  
  if [[ "$v_agent" == "$AGENT_NAME" ]]; then
    win=$(jq -r '.win // true' "$VERDICT_FILE")
    score_delta=$(jq -r '.score_delta // 0' "$VERDICT_FILE")
    reason=$(jq -r '.reason // "Manual verdict"' "$VERDICT_FILE")
    # 消费掉裁决书，防止重复使用
    rm -f "$VERDICT_FILE"
  fi
elif [[ -f "$PAIN_FLAG" ]]; then
  # 降级：如果存在 pain flag 且没被上游声明解决，则该 agent 记录一次潜在损失
  # 注意：这里我们不直接扣分，只记录 losses，因为没有明确裁决
  win=false
  score_delta=-1
  reason="Automatic detection: Pain flag present"
else
  # 默认成功，得分由主智能体控制
  win=true
  score_delta=1
  reason="Automatic detection: Clean completion"
fi

# 2. 原子化更新 Scorecard
# 使用临时文件确保写入安全
tmp_scorecard="${SCORECARD}.tmp"

if [[ "$win" == "true" ]]; then
  jq --arg agent "$AGENT_NAME" --argjson delta "$score_delta" '
    .agents[$agent].wins += 1 |
    .agents[$agent].score += $delta
  ' "$SCORECARD" > "$tmp_scorecard"
else
  jq --arg agent "$AGENT_NAME" --argjson delta "$score_delta" '
    .agents[$agent].losses += 1 |
    .agents[$agent].score += $delta
  ' "$SCORECARD" > "$tmp_scorecard"
fi

mv "$tmp_scorecard" "$SCORECARD"

# 3. 触发上下文同步
if [[ -f "$PROJECT_DIR/.claude/hooks/sync_agent_context.sh" ]]; then
  bash "$PROJECT_DIR/.claude/hooks/sync_agent_context.sh" > /dev/null 2>&1 || true
fi

# 4. 审计日志 (可选)
# echo "[$(date -Iseconds)] Agent '$AGENT_NAME' ($AGENT_ID) completed. Win: $win, ScoreDelta: $score_delta, Reason: $reason" >> "$PROJECT_DIR/docs/AUDIT_TRAIL.log"

exit 0