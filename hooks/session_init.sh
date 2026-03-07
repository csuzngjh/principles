#!/usr/bin/env bash
set -euo pipefail

# 检查 jq 是否可用
if ! command -v jq &> /dev/null; then
  echo "❌ Error: jq is required but not installed" >&2
  # 不退出，仅警告，保证基本功能可用
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
PROFILE="$PROJECT_DIR/docs/PROFILE.json"
PAIN_FLAG="$PROJECT_DIR/docs/.pain_flag"
ISSUE_LOG="$PROJECT_DIR/docs/ISSUE_LOG.md"
PLAN="$PROJECT_DIR/docs/PLAN.md"
PENDING_REFLECTION="$PROJECT_DIR/docs/.pending_reflection"

# 输出会被注入到 Claude 的上下文中
echo "📋 可进化编程智能体已初始化"

# 1. 优先检查反思要求 (新增)
if [[ -f "$PENDING_REFLECTION" ]]; then
  echo ""
  echo "🛑 **URGENT: PENDING REFLECTION**"
  echo "System context was compressed while unstable."
  echo "Reason: $(cat "$PENDING_REFLECTION")"
  echo ""
  echo "👉 **ACTION REQUIRED**: Run \
/reflection\
 immediately to analyze root causes."
  echo "   (This file will be removed after reflection is logged)"
  # 注意：这里不自动删除，留给 /reflection skill 去处理（或者下次手动删除）
  # 也可以选择在这里删除以防死循环，但保留着更能强迫 attention
fi

# 2. 显示当前配置
if [[ -f "$PROFILE" ]] && command -v jq &> /dev/null; then
  echo "  - 审计级别: $(jq -r '.audit_level // "medium"' "$PROFILE")"
  echo "  - 风险路径: $(jq -c '.risk_paths // []' "$PROFILE")"
fi

# 3. 检查断点恢复
if [[ -f "$PAIN_FLAG" ]]; then
  echo ""
  echo "⚠️ 检测到未处理的 pain flag（上次任务可能中断）"
  echo "内容摘要："
  head -6 "$PAIN_FLAG" | sed 's/^/    /'
  echo ""
  echo "建议：运行 /evolve-task --recover 完成诊断"
fi

# 4. 检查是否有进行中的计划
if [[ -f "$PLAN" ]]; then
  STATUS=$(grep -E '^STATUS:' "$PLAN" | head -1 | awk '{print $2}' || echo "")
  # 兼容 DRAFT 和 IN_PROGRESS
  if [[ "$STATUS" == "IN_PROGRESS" || "$STATUS" == "DRAFT" ]]; then
    echo ""
    echo "📌 检测到进行中的计划（STATUS: $STATUS）"
    if [[ "$STATUS" == "DRAFT" ]]; then
        echo "建议：完成计划并更新状态为 READY"
    else
        echo "建议：继续执行 docs/PLAN.md 中的步骤"
    fi
  fi
fi

# 5. 显示最近一条 Issue（上下文恢复）
if [[ -f "$ISSUE_LOG" ]]; then
  LAST_ISSUE=$(grep -E '^## \[' "$ISSUE_LOG" | tail -1 | cut -c1-80 || echo "")
  if [[ -n "$LAST_ISSUE" ]]; then
    echo "  - 最近 Issue: $LAST_ISSUE"
  fi
fi

exit 0