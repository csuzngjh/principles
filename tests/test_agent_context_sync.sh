#!/usr/bin/env bash
set -euo pipefail

echo "=== 单元测试：子智能体画像同步 (Agent Context Sync) ==="
echo ""

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

SCORECARD="docs/AGENT_SCORECARD.json"
CONTEXT="docs/AGENT_CONTEXT.md"
SYNC_SCRIPT=".claude/hooks/sync_agent_context.sh"

# 备份
[[ -f "$SCORECARD" ]] && cp "$SCORECARD" "${SCORECARD}.bak"
[[ -f "$CONTEXT" ]] && cp "$CONTEXT" "${CONTEXT}.bak"

cleanup() {
  echo "🧹 Cleaning up..."
  rm -f "$SCORECARD" "$CONTEXT"
  [[ -f "${SCORECARD}.bak" ]] && mv "${SCORECARD}.bak" "$SCORECARD"
  [[ -f "${CONTEXT}.bak" ]] && mv "${CONTEXT}.bak" "$CONTEXT"
}
trap cleanup EXIT

# 辅助函数：断言包含字符串
assert_contains() {
  if grep -q "$1" "$CONTEXT"; then
    echo "  ✅ Found: $1"
  else
    echo "  ❌ Missing: $1"
    exit 1
  fi
}

# --- 测试场景 1：全方位分级匹配 ---
echo "👉 Test 1: Multiple agent scores..."
mkdir -p docs
cat > "$SCORECARD" <<EOF
{
  "agents": {
    "explorer": {"score": 10, "wins": 10, "losses": 0},
    "diagnostician": {"score": -2, "wins": 1, "losses": 3},
    "planner": {"score": 0, "wins": 5, "losses": 5}
  }
}
EOF

bash "$SYNC_SCRIPT"

assert_contains "explorer**: \[High (Trustworthy)\] (Score: 10"
assert_contains "diagnostician**: \[Low (Risky)\] (Score: -2"
assert_contains "planner**: \[Neutral (Standard)\] (Score: 0"

# --- 测试场景 2：空文件处理 ---
echo "👉 Test 2: Handling missing scorecard..."
rm "$SCORECARD"
# 应该不报错安全退出
bash "$SYNC_SCRIPT"
echo "  ✅ Safely handled missing scorecard"

echo ""
echo "🎉 Agent Context Sync tests passed."
