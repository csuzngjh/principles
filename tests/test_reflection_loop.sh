#!/usr/bin/env bash
set -euo pipefail

echo "=== 集成测试：痛定思痛循环 (Reflection Loop) ==="
echo ""

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

HOOKS_DIR=".claude/hooks"
PLAN="docs/PLAN.md"
PENDING_MARKER="docs/.pending_reflection"
CHECKPOINT="docs/CHECKPOINT.md"

# 备份
[[ -f "$PLAN" ]] && cp "$PLAN" "${PLAN}.bak"
[[ -f "$CHECKPOINT" ]] && cp "$CHECKPOINT" "${CHECKPOINT}.bak"

# 清理函数
cleanup() {
  echo "🧹 Cleaning up..."
  rm -f "${PLAN}.test" "${CHECKPOINT}.test" "$PENDING_MARKER"
  # 恢复
  [[ -f "${PLAN}.bak" ]] && mv "${PLAN}.bak" "$PLAN"
  [[ -f "${CHECKPOINT}.bak" ]] && mv "${CHECKPOINT}.bak" "$CHECKPOINT"
}
trap cleanup EXIT

# 辅助函数：运行测试步骤
run_step() {
  local step_name="$1"
  local cmd="$2"
  local check_output="$3"
  
  echo "👉 Step: $step_name"
  
  # 运行命令并捕获输出
  OUTPUT=$(eval "$cmd" 2>&1)
  
  # 检查输出是否包含预期的关键词
  if echo "$OUTPUT" | grep -q "$check_output"; then
    echo "  ✅ PASS (Output contained '$check_output')"
    return 0
  else
    echo "  ❌ FAIL"
    echo "  Expected output to contain: $check_output"
    echo "  Actual output:"
    echo "$OUTPUT" | sed 's/^/    /'
    return 1
  fi
}

FAILED=0

# --- 场景模拟 ---

# 1. 模拟“痛苦”状态：PLAN 还在 DRAFT
mkdir -p docs
cat > "$PLAN" <<EOF
# PLAN
STATUS: DRAFT
## Steps
1. TBD
EOF

# 2. 测试 PreCompact Hook
# 预期：检测到 PLAN 是 DRAFT，输出 "Potential Pain Detected" 并生成标记文件
if ! run_step "PreCompact Hook (Pain State)" \
     "bash $HOOKS_DIR/precompact_checkpoint.sh" \
     "Potential Pain Detected"; then
  FAILED=$((FAILED + 1))
fi

# 检查标记文件是否生成
if [[ -f "$PENDING_MARKER" ]]; then
  echo "  ✅ PASS (Marker file created)"
else
  echo "  ❌ FAIL (Marker file not created)"
  FAILED=$((FAILED + 1))
fi

# 3. 测试 SessionStart Hook
# 预期：检测到标记文件，输出 "URGENT: PENDING REFLECTION"
if ! run_step "SessionStart Hook (Recovery)" \
     "bash $HOOKS_DIR/session_init.sh" \
     "URGENT: PENDING REFLECTION"; then
  FAILED=$((FAILED + 1))
fi

# 4. 模拟“健康”状态：PLAN 是 READY，无 pain flag
cat > "$PLAN" <<EOF
# PLAN
STATUS: READY
## Steps
1. Done
EOF
rm -f "$PENDING_MARKER" docs/.pain_flag

# 预期：输出 "Status looks stable"
if ! run_step "PreCompact Hook (Healthy State)" \
     "bash $HOOKS_DIR/precompact_checkpoint.sh" \
     "Status looks stable"; then
  FAILED=$((FAILED + 1))
fi

# 检查标记文件是否未生成
if [[ ! -f "$PENDING_MARKER" ]]; then
  echo "  ✅ PASS (No marker file created, as expected)"
else
  echo "  ❌ FAIL (Marker file created unexpectedly)"
  FAILED=$((FAILED + 1))
fi

echo ""
if [[ $FAILED -eq 0 ]]; then
  echo "✅ 所有测试步骤均通过"
  exit 0
else
  echo "❌ 共 $FAILED 个步骤失败"
  exit 1
fi
