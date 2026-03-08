#!/usr/bin/env bash
set -euo pipefail

# 检查 jq 是否可用
if ! command -v jq &> /dev/null; then
  echo "❌ Error: jq is required but not installed" >&2
  exit 1
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
USER_PROFILE="$PROJECT_DIR/docs/USER_PROFILE.json"
USER_VERDICT="$PROJECT_DIR/docs/.user_verdict.json"
PAIN_FLAG="$PROJECT_DIR/docs/.pain_flag"
ISSUE_LOG="$PROJECT_DIR/docs/ISSUE_LOG.md"
DECISIONS="$PROJECT_DIR/docs/DECISIONS.md"

mkdir -p "$PROJECT_DIR/docs"

# 1. 处理 Pain Flag (原逻辑保持不变)
if [[ -f "$PAIN_FLAG" ]]; then
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
    echo "### Diagnosis (Pending)"
    echo "- Run /evolve-task to diagnose."
  } >> "$ISSUE_LOG"

  rm -f "$PAIN_FLAG"
fi

# 2. 处理用户画像更新 (新增逻辑)
if [[ -f "$USER_VERDICT" ]]; then
  if [[ ! -f "$USER_PROFILE" ]]; then
    # 初始化空 Profile
    echo '{"domains":{},"preferences":{},"history":[]}' > "$USER_PROFILE"
  fi

  tmp_profile="${USER_PROFILE}.tmp"
  
  # 使用 jq 进行深度合并与计算
  # 1. 遍历 updates 数组，累加分数到 domains
  # 2. 合并 preferences (覆盖)
  # 3. 将 updates 追加到 history 并保留最近 20 条
  
  jq --slurpfile verdict "$USER_VERDICT" '
    . as $current |
    $verdict[0] as $v |
    
    # 更新 Domains 分数
    reduce ($v.updates[]? // empty) as $u (
      $current;
      .domains[$u.domain] = (.domains[$u.domain] // 0) + $u.delta
    ) |
    
    # 更新 Preferences (覆盖)
    .preferences = (.preferences + ($v.preferences // {})) |
    
    # 更新 History (追加并切片)
    .history = (
      ($v.updates // []) + .history
    ) | .history[:20]
    
  ' "$USER_PROFILE" > "$tmp_profile"

  mv "$tmp_profile" "$USER_PROFILE"
  rm -f "$USER_VERDICT"
  
  # 触发上下文同步 (可选，SessionEnd 也会触发，但这里触发更实时)
  if [[ -f "$PROJECT_DIR/.claude/hooks/sync_user_context.sh" ]]; then
    bash "$PROJECT_DIR/.claude/hooks/sync_user_context.sh" > /dev/null 2>&1 || true
  fi
fi

exit 0