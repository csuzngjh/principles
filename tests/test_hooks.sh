#!/usr/bin/env bash
set -euo pipefail

echo "=== Hooks 单元测试 ==="
echo ""

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

HOOKS_DIR=".claude/hooks"
# shellcheck disable=SC2034
PROFILE="docs/PROFILE.json"
PLAN="docs/PLAN.md"
AUDIT="docs/AUDIT.md"

# 清理测试环境
# shellcheck disable=SC2034,SC2317
cleanup() {
  rm -f docs/.pain_flag
  rm -f "${AUDIT}.test"
  rm -f "${PLAN}.test"
  # 恢复
  [[ -f "${PLAN}.bak" ]] && mv "${PLAN}.bak" "$PLAN"
  [[ -f "${AUDIT}.bak" ]] && mv "${AUDIT}.bak" "$AUDIT"
}

trap cleanup EXIT

# 备份原始文件
[[ -f "$PLAN" ]] && cp "$PLAN" "${PLAN}.bak"
[[ -f "$AUDIT" ]] && cp "$AUDIT" "${AUDIT}.bak"

# Test 1: pre_write_gate 在无 PLAN 时阻断风险路径写入
test_1() {
  echo "Test 1: 无 PLAN 时阻断风险路径写入"
  
  rm -f "$PLAN"
  
  # 模拟 Write 工具输入（风险路径）
  INPUT='{"tool_name":"Write","tool_input":{"file_path":"'"$PROJECT_DIR"'/src/server/test.ts"}}'
  
  set +e
  echo "$INPUT" | bash "$HOOKS_DIR/pre_write_gate.sh"
  rc=$?
  set -e
  
  if [[ $rc -eq 2 ]]; then
    echo "  ✅ PASS - 正确阻断"
  else
    echo "  ❌ FAIL - 未阻断（exit code: $rc）"
    return 1
  fi
}

# Test 2: pre_write_gate 在 AUDIT 非 PASS 时阻断
test_2() {
  echo "Test 2: AUDIT 非 PASS 时阻断"
  
  # 创建 FAIL 状态的 AUDIT
  cat > "$AUDIT" <<EOF
# AUDIT
RESULT: FAIL
EOF
  
  INPUT='{"tool_name":"Write","tool_input":{"file_path":"'"$PROJECT_DIR"'/src/server/test.ts"}}'
  
  set +e
  echo "$INPUT" | bash "$HOOKS_DIR/pre_write_gate.sh"
  rc=$?
  set -e
  
  if [[ $rc -eq 2 ]]; then
    echo "  ✅ PASS - 正确阻断"
  else
    echo "  ❌ FAIL - 未阻断（exit code: $rc）"
    return 1
  fi
}

# Test 3: pre_write_gate 在有 PLAN + AUDIT PASS 时放行
test_3() {
  echo "Test 3: PLAN + AUDIT PASS 时放行"
  
  echo "STATUS: READY" > "$PLAN"
  echo "RESULT: PASS" > "$AUDIT"
  
  INPUT='{"tool_name":"Write","tool_input":{"file_path":"'"$PROJECT_DIR"'/src/server/test.ts"}}'
  
  set +e
  echo "$INPUT" | bash "$HOOKS_DIR/pre_write_gate.sh"
  rc=$?
  set -e
  
  if [[ $rc -eq 0 ]]; then
    echo "  ✅ PASS - 正确放行"
  else
    echo "  ❌ FAIL - 错误阻断（exit code: $rc）"
    return 1
  fi
}

# Test 4: pre_write_gate 对非风险路径不阻断
test_4() {
  echo "Test 4: 非风险路径不阻断"
  
  # 删除 PLAN/AUDIT（模拟最严格情况）
  rm -f "$PLAN" "$AUDIT"
  
  INPUT='{"tool_name":"Write","tool_input":{"file_path":"'"$PROJECT_DIR"'/README.md"}}'
  
  set +e
  echo "$INPUT" | bash "$HOOKS_DIR/pre_write_gate.sh"
  rc=$?
  set -e
  
  if [[ $rc -eq 0 ]]; then
    echo "  ✅ PASS - 正确放行"
  else
    echo "  ❌ FAIL - 错误阻断（exit code: $rc）"
    return 1
  fi
}

# 运行所有测试
echo "开始测试..."
echo ""

FAILED=0

test_1 || FAILED=$((FAILED + 1))
echo ""
test_2 || FAILED=$((FAILED + 1))
echo ""
test_3 || FAILED=$((FAILED + 1))
echo ""
test_4 || FAILED=$((FAILED + 1))

echo ""
echo "=== 测试完成 ==="
if [[ $FAILED -eq 0 ]]; then
  echo "✅ 所有测试通过"
  exit 0
else
  echo "❌ $FAILED 个测试失败"
  exit 1
fi
