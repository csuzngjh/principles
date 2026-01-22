#!/usr/bin/env bash
set -euo pipefail

echo "=== Hooks 单元测试：目标-凭证对齐 (Linux 模式) ==="
echo ""

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

HOOKS_DIR=".claude/hooks"
PLAN="docs/PLAN.md"
AUDIT="docs/AUDIT.md"
PROFILE="docs/PROFILE.json"

# 调试：检查脚本是否存在
ls -l "$HOOKS_DIR/pre_write_gate.sh"

# 临时测试文件路径
TEST_FILE_RISKY="src/server/critical_logic.ts"
TEST_FILE_SAFE="README.md"

# 模拟环境设置
mkdir -p "src/server"
touch "$TEST_FILE_RISKY" "$TEST_FILE_SAFE"

# 备份原始文件
[[ -f "$PLAN" ]] && cp "$PLAN" "${PLAN}.bak"
[[ -f "$AUDIT" ]] && cp "$AUDIT" "${AUDIT}.bak"

# 清理函数
cleanup() {
  echo "🧹 Cleaning up..."
  rm -f "$TEST_FILE_RISKY" "$TEST_FILE_SAFE"
  [[ -f "${PLAN}.bak" ]] && mv "${PLAN}.bak" "$PLAN"
  [[ -f "${AUDIT}.bak" ]] && mv "${AUDIT}.bak" "$AUDIT"
  rmdir "src/server" 2>/dev/null || true
}
trap cleanup EXIT

# 辅助函数：运行测试
run_gate_test() {
  local test_name="$1"
  local file_target="$2"
  local expected_rc="$3"
  
  echo "👉 Test: $test_name"
  
  # 构造模拟输入 (绝对路径)
  local full_path="$PROJECT_DIR/$file_target"
  # 注意：在 Windows bash 中，$PROJECT_DIR 可能包含 C:/ 格式
  
  INPUT='{"tool_name":"Write","tool_input":{"file_path":"'"$full_path"'"}}'
  
  set +e
  # 运行 hook
  # 直接执行，不捕获，看看输出
  echo "$INPUT" | bash "$HOOKS_DIR/pre_write_gate.sh"
  rc=$?
  set -e
  
  if [[ $rc -eq $expected_rc ]]; then
    echo "  ✅ PASS"
    return 0
  else
    echo "  ❌ FAIL (Expected $expected_rc, got $rc)"
    return 1
  fi
}

FAILED=0

# --- 场景准备 ---

# 1. 设置 PLAN 为 READY，但 Target Files 为空
echo "RESULT: PASS" > "$AUDIT"
cat > "$PLAN" <<EOF
# PLAN
STATUS: READY
## Target Files
## Steps
EOF

run_gate_test "风险文件未声明应被拦截" "$TEST_FILE_RISKY" 2 || FAILED=$((FAILED + 1))

# 2. 设置 PLAN 包含目标文件
cat > "$PLAN" <<EOF
# PLAN
STATUS: READY
## Target Files
- src/server/critical_logic.ts
## Steps
EOF

run_gate_test "已声明的风险文件应放行" "$TEST_FILE_RISKY" 0 || FAILED=$((FAILED + 1))

# 3. 设置 PLAN 包含目录
cat > "$PLAN" <<EOF
# PLAN
STATUS: READY
## Target Files
- src/server/
## Steps
EOF

run_gate_test "声明目录应放行目录下文件" "$TEST_FILE_RISKY" 0 || FAILED=$((FAILED + 1))

# 4. 设置 PLAN 状态为 DRAFT
cat > "$PLAN" <<EOF
# PLAN
STATUS: DRAFT
## Target Files
- src/server/critical_logic.ts
## Steps
EOF

run_gate_test "PLAN 状态非 READY 应拦截" "$TEST_FILE_RISKY" 2 || FAILED=$((FAILED + 1))

# 5. 非风险文件
run_gate_test "非风险文件应直接放行" "$TEST_FILE_SAFE" 0 || FAILED=$((FAILED + 1))

echo ""
if [[ $FAILED -eq 0 ]]; then
  echo "✅ 所有测试通过"
  exit 0
else
  echo "❌ 共 $FAILED 个测试失败"
  exit 1
fi
