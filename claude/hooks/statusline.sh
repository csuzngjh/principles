#!/usr/bin/env bash
# Status Line for Evolvable Programming Agent
# 实时显示：模型 | 上下文 | 五步流程 | 项目状态 | Git 分支

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

input=$(cat)

# 解析 JSON
MODEL=$(echo "$input" | jq -r '.model.display_name // "?"')
PERCENT_USED=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)
PROJECT_DIR=$(echo "$input" | jq -r '.workspace.project_dir // "."')

# ============================================================================
# 瑞·达利欧五步流程状态跟踪
# ============================================================================

# Step 1: Goals（目标）→ 有 PLAN.md 即表示有明确目标（隐藏显示）
# Step 2: Problems（问题）→ 检查 ISSUE_LOG.md 中的未解决问题
PROBLEM_STATUS=""
if [[ -f "$PROJECT_DIR/docs/ISSUE_LOG.md" ]]; then
  # 统计未解决的问题（以 "## [" 开头的条目）
  UNRESOLVED_COUNT=$(grep -c "^## \[" "$PROJECT_DIR/docs/ISSUE_LOG.md" 2>/dev/null || echo "0")
  if [[ "$UNRESOLVED_COUNT" -gt 0 ]]; then
    PROBLEM_STATUS="Issue:$UNRESOLVED_COUNT"
  fi
fi

# Step 3: Diagnosis（诊断）→ 检查是否有正在进行的问题分析
DIAGNOSIS_STATUS=""
if [[ -f "$PROJECT_DIR/docs/.pain_flag" ]]; then
  # 有 pain flag 说明正在诊断/修复问题
  DIAGNOSIS_STATUS="Diagnosing"
fi

# Step 4: Design（方案）→ 检查 PLAN 状态
DESIGN_STATUS=""
if [[ -f "$PROJECT_DIR/docs/PLAN.md" ]]; then
  STATUS=$(grep -E '^STATUS:' "$PROJECT_DIR/docs/PLAN.md" 2>/dev/null | head -1 | awk '{print $2}')
  case "$STATUS" in
    READY) DESIGN_STATUS="Plan:Ready" ;;
    IN_PROGRESS) DESIGN_STATUS="Plan:WIP" ;;
    DRAFT) DESIGN_STATUS="Plan:Draft" ;;
    *) DESIGN_STATUS="" ;;
  esac
fi

# Step 5: Doing（执行）→ 检查是否正在执行（IN_PROGRESS）
# 执行状态已经在 DESIGN_STATUS 中体现了（WIP = 正在执行）

# 构建流程状态字符串
# 显示当前最重要的状态，避免状态栏过于拥挤
FLOW_STATUS=""

# 优先级：Diagnosing > Issues > Plan Status
if [[ -n "$DIAGNOSIS_STATUS" ]]; then
  # 正在诊断/解决问题（Step 3）
  FLOW_STATUS="$DIAGNOSIS_STATUS"
elif [[ -n "$PROBLEM_STATUS" ]]; then
  # 有未解决的问题（Step 2）
  FLOW_STATUS="$PROBLEM_STATUS"
elif [[ -n "$DESIGN_STATUS" ]]; then
  # 有计划（Step 4）
  FLOW_STATUS="$DESIGN_STATUS"
fi

# ============================================================================
# 其他项目状态
# ============================================================================

# Pain Flag（失败标记）
PAIN_STATUS=""
if [[ -f "$PROJECT_DIR/docs/.pain_flag" ]]; then
  PAIN_STATUS="|Pain"
fi

# AUDIT 状态（审计验证）
AUDIT_STATUS=""
if [[ -f "$PROJECT_DIR/docs/AUDIT.md" ]]; then
  RESULT=$(grep -E '^RESULT:' "$PROJECT_DIR/docs/AUDIT.md" 2>/dev/null | head -1 | awk '{print $2}')
  case "$RESULT" in
    PASS) AUDIT_STATUS="|Audit:✅" ;;
    FAIL) AUDIT_STATUS="|Audit:❌" ;;
    *) AUDIT_STATUS="" ;;
  esac
fi

# Git 分支
GIT_BRANCH=""
if git -C "$PROJECT_DIR" rev-parse --git-dir > /dev/null 2>&1; then
  BRANCH=$(git -C "$PROJECT_DIR" branch --show-current 2>/dev/null)
  if [[ -n "$BRANCH" ]]; then
    # 简化分支名显示
    if [[ ${#BRANCH} -gt 10 ]]; then
      BRANCH="${BRANCH:0:10}.."
    fi
    GIT_BRANCH="|🌿$BRANCH"
  fi
fi

# ============================================================================
# 上下文使用率颜色提示
# ============================================================================

CTX_INDICATOR="📊${PERCENT_USED}%"
if (( PERCENT_USED > 80 )); then
  CTX_INDICATOR="🔴${PERCENT_USED}%"
elif (( PERCENT_USED > 60 )); then
  CTX_INDICATOR="🟡${PERCENT_USED}%"
else
  CTX_INDICATOR="🟢${PERCENT_USED}%"
fi

# ============================================================================
# 输出状态栏
# ============================================================================

# 紧凑版本：只显示最关键的信息
echo "[$MODEL]$CTX_INDICATOR|$FLOW_STATUS$PAIN_STATUS$AUDIT_STATUS$GIT_BRANCH"
