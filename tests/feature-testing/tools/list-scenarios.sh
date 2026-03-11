#!/bin/bash
# ============================================================================
# 场景列表工具 - 显示所有可用的测试场景
# ============================================================================

SCENARIOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../framework/test-scenarios" && pwd)"

echo "╔════════════════════════════════════════════════════════════╗"
echo "║           Available Feature Test Scenarios                ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

if [ ! -d "$SCENARIOS_DIR" ]; then
    echo "❌ Error: Scenarios directory not found: $SCENARIOS_DIR"
    exit 1
fi

# 查找所有JSON场景文件
scenarios=($(find "$SCENARIOS_DIR" -name "*.json" 2>/dev/null | sort))

if [ ${#scenarios[@]} -eq 0 ]; then
    echo "No test scenarios found in $SCENARIOS_DIR"
    exit 0
fi

echo "Found ${#scenarios[@]} scenario(s):"
echo ""

# 遍历并显示每个场景的信息
for scenario in "${scenarios[@]}"; do
    filename=$(basename "$scenario" .json)

    # 提取元数据
    name=$(cat "$scenario" 2>/dev/null | jq -r '.metadata.name // "Unknown"' || echo "Unknown")
    description=$(cat "$scenario" 2>/dev/null | jq -r '.metadata.description // "No description"' || echo "No description")
    version=$(cat "$scenario" 2>/dev/null | jq -r '.metadata.version // "unknown"' || echo "unknown")
    tags=$(cat "$scenario" 2>/dev/null | jq -r '.metadata.tags // [] | join(", ")' || echo "")
    steps=$(cat "$scenario" 2>/dev/null | jq '.steps | length' 2>/dev/null || echo "0")

    echo "📋 $filename"
    echo "   Name:        $name"
    echo "   Description: $description"
    echo "   Version:     $version"
    [ -n "$tags" ] && echo "   Tags:        $tags"
    echo "   Steps:       $steps"
    echo "   File:        $scenario"
    echo ""
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Usage:"
echo "  ./tests/feature-testing/framework/feature-test-runner.sh <scenario-name>"
echo ""
echo "Example:"
echo "  ./tests/feature-testing/framework/feature-test-runner.sh trust-system"
echo ""
echo "Create new scenario:"
echo "  ./tests/feature-testing/tools/create-scenario.sh"
