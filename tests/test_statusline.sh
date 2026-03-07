#!/usr/bin/env bash
# 完整测试 statusline.sh 的所有场景

set -euo pipefail

PROJECT_DIR="/mnt/d/code/principles"
STATUSLINE="$PROJECT_DIR/.claude/hooks/statusline.sh"

echo "============================================"
echo "  Status Line 完整测试"
echo "============================================"
echo ""

# 模拟真实的 JSON 输入（从官方文档格式）
# 注意：使用 $PROJECT_DIR 变量，而不是硬编码路径，以便迁移到其他项目
BASE_JSON='{
  "hook_event_name": "Status",
  "session_id": "test123",
  "model": {
    "id": "claude-sonnet-4-5-20250929",
    "display_name": "Sonnet"
  },
  "workspace": {
    "current_dir": "'"$PROJECT_DIR"'",
    "project_dir": "'"$PROJECT_DIR"'"
  },
  "context_window": {
    "used_percentage": 65
  }
}'

# 测试场景
test_scenarios() {
  local scenario=$1
  local description=$2
  local modifications=$3

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "场景: $description"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # 应用场景修改
  if [[ -n "$modifications" ]]; then
    eval "$modifications"
  fi

  # 运行 statusline
  result=$(echo "$BASE_JSON" | bash "$STATUSLINE" 2>&1)
  exit_code=$?

  echo "📊 输出: $result"
  echo "✅ 退出码: $exit_code"
  echo ""

  # 恢复原始状态
  if [[ -n "$modifications" ]]; then
    # 清理测试创建的文件
    rm -f "$PROJECT_DIR/docs/.pain_flag" 2>/dev/null || true
  fi
}

# 场景 1: 正常状态（有 PLAN，无 ISSUE）
test_scenarios "1" "正常状态 - 有 PLAN，无 ISSUE" \
  "# 确保 PLAN.md 存在，ISSUE_LOG.md 无问题条目
   echo '## [2026-01-22 10:00:00] 示例问题' >> \"$PROJECT_DIR/docs/ISSUE_LOG.md\""

# 场景 2: 有未解决问题
test_scenarios "2" "有未解决问题" \
  "# 添加多个问题
   echo '## [2026-01-22 10:00:00] 问题1' >> \"$PROJECT_DIR/docs/ISSUE_LOG.md\"
   echo '## [2026-01-22 11:00:00] 问题2' >> \"$PROJECT_DIR/docs/ISSUE_LOG.md\"
   echo '## [2026-01-22 12:00:00] 问题3' >> \"$PROJECT_DIR/docs/ISSUE_LOG.md\""

# 场景 3: 正在诊断（有 pain flag）
test_scenarios "3" "正在诊断 - 有 pain flag" \
  "# 创建 pain flag
   touch \"$PROJECT_DIR/docs/.pain_flag\"
   echo '诊断内容' > \"$PROJECT_DIR/docs/.pain_flag\""

# 场景 4: PLAN 状态为 IN_PROGRESS
test_scenarios "4" "执行中 - PLAN:WIP" \
  "# 修改 PLAN.md 状态
   sed -i 's/^STATUS: READY/STATUS: IN_PROGRESS/' \"$PROJECT_DIR/docs/PLAN.md\""

# 场景 5: 高上下文使用率
test_scenarios "5" "高上下文使用率 - 85%" \
  "# 创建临时的高使用率 JSON（使用 $PROJECT_DIR 变量）
   BASE_JSON='{
  \"hook_event_name\": \"Status\",
  \"session_id\": \"test123\",
  \"model\": {
    \"id\": \"claude-sonnet-4-5-20250929\",
    \"display_name\": \"Sonnet\"
  },
  \"workspace\": {
    \"current_dir\": \"'"$PROJECT_DIR"'\",
    \"project_dir\": \"'"$PROJECT_DIR"'\"
  },
  \"context_window\": {
    \"used_percentage\": 85
  }
}'
   sed -i 's/^STATUS: IN_PROGRESS/STATUS: READY/' \"$PROJECT_DIR/docs/PLAN.md\""

# 场景 6: 无 PLAN.md（测试降级）
test_scenarios "6" "无 PLAN - 只有 ISSUE" \
  "# 备份并移除 PLAN.md
   cp \"$PROJECT_DIR/docs/PLAN.md\" \"$PROJECT_DIR/docs/PLAN.md.bak\"
   rm \"$PROJECT_DIR/docs/PLAN.md\""

# 恢复场景 6
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "恢复：恢复 PLAN.md"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
mv "$PROJECT_DIR/docs/PLAN.md.bak" "$PROJECT_DIR/docs/PLAN.md"

echo "============================================"
echo "  测试总结"
echo "============================================"
echo ""
echo "✅ 所有场景测试完成"
echo ""
echo "📊 新状态栏格式："
echo "  [Sonnet] 🟡 65% | Issue:3 | Plan:Ready | |Audit:✅ | 🌿main"
echo ""
echo "🔍 符号说明："
echo "  🟢/🟡/🔴 - 上下文使用率（绿/黄/红）"
echo "  Issue:3  - 有3个未解决问题"
echo "  Diagnosing - 正在诊断/修复问题"
echo "  Plan:Draft - 方案草稿中"
echo "  Plan:Ready - 方案已就绪"
echo "  Plan:WIP   - 正在执行"
echo "  Pain      - 有失败标记"
echo "  Audit:✅  - 审计通过"
echo "  Audit:❌  - 审计失败"
echo "  🌿branch  - Git 分支"
echo ""
echo "✅ 与达利欧五步流程对应："
echo "  1. Goals   → 🎯 (隐藏，有 PLAN 即表示)"
echo "  2. Problems → Issue:数量 (如 Issue:3)"
echo "  3. Diagnosis → Diagnosing (有 pain_flag 时)"
echo "  4. Design  → Plan:Ready/WIP"
echo "  5. Doing   → Plan:WIP (执行状态)"
