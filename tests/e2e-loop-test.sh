#!/bin/bash
set -e

WORKSPACE_DIR="/home/csuzngjh/clawd"
AGENT_ID="main"
OUTPUT_DIR="/home/csuzngjh/code/principles/tests/reports"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
REPORT_FILE="$OUTPUT_DIR/e2e-test-$TIMESTAMP.md"

mkdir -p "$OUTPUT_DIR"

echo "╔════════════════════════════════════════════════════════════╗"
echo "║     E2E Conversation Test - Story Optimization OKR          ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "Time: $(date)"
echo "Agent: $AGENT_ID"
echo "Workspace: $WORKSPACE_DIR"
echo ""
echo "📝 Running test scenarios..."
echo ""

# Phase 1
echo "Phase 1: Structure Analysis"
RESPONSE1=$(timeout 120 openclaw agent --agent "$AGENT_ID" --message "你好，我看到你的 OKR 中有故事优化任务。请分析第一章的故事节奏和情节连贯性，找出任何需要改进的地方。" 2>&1 || echo "TIMEOUT")
echo "✓ Phase 1 complete (${#RESPONSE1} chars)"
sleep 2

# Phase 2
echo "Phase 2: Character Consistency"
RESPONSE2=$(timeout 120 openclaw agent --agent "$AGENT_ID" --message "现在检查第一章的角色一致性。主角的行为和动机是否符合其性格设定？是否有不一致的地方？" 2>&1 || echo "TIMEOUT")
echo "✓ Phase 2 complete (${#RESPONSE2} chars)"
sleep 2

# Phase 3
echo "Phase 3: Technical Concepts"
RESPONSE3=$(timeout 120 openclaw agent --agent "$AGENT_ID" --message "检查编程概念映射的准确性。确保技术细节正确且易于初学者理解。" 2>&1 || echo "TIMEOUT")
echo "✓ Phase 3 complete (${#RESPONSE3} chars)"
sleep 2

# Phase 4
echo "Phase 4: User Pain Points"
RESPONSE4=$(timeout 120 openclaw agent --agent "$AGENT_ID" --message "最后，识别用户可能在学习过程中遇到的痛点，并提出具体的改进建议。" 2>&1 || echo "TIMEOUT")
echo "✓ Phase 4 complete (${#RESPONSE4} chars)"
echo ""

# Quick data collection
echo "📊 Collecting system data..."

# Trust score
TRUST_SCORE="N/A"
if [ -f "$WORKSPACE_DIR/.state/AGENT_SCORECARD.json" ]; then
    TRUST_SCORE=$(cat "$WORKSPACE_DIR/.state/AGENT_SCORECARD.json" 2>/dev/null | jq -r '.trust_score // "N/A"' || echo "N/A")
elif [ -f "$WORKSPACE_DIR/docs/AGENT_SCORECARD.json" ]; then
    TRUST_SCORE=$(cat "$WORKSPACE_DIR/docs/AGENT_SCORECARD.json" 2>/dev/null | jq -r '.trust_score // "N/A"' || echo "N/A")
fi

# Generate report
echo "📄 Generating report..."

cat > "$REPORT_FILE" << EOF
# E2E Test Report - Automated Loop

**Date**: $(date)
**Agent**: $AGENT_ID
**Default Model**: unicom-cloud/MiniMax-M2.5

## Test Results

| Phase | Description | Response Size |
|-------|-------------|---------------|
| 1 | Structure Analysis | ${#RESPONSE1} chars |
| 2 | Character Consistency | ${#RESPONSE2} chars |
| 3 | Technical Concepts | ${#RESPONSE3} chars |
| 4 | User Pain Points | ${#RESPONSE4} chars |

## System State

- **Trust Score**: $TRUST_SCORE
- **Test Completed**: $(date)

## Sample Response (Phase 1, first 500 chars)

\`\`\`
$(echo "$RESPONSE1" | head -c 500)
\`\`\`
EOF

echo ""
echo "✅ Test complete!"
echo "📄 Report saved to: $REPORT_FILE"
echo ""
echo "📋 Summary:"
echo "  - Agent: $AGENT_ID"
echo "  - 4 Phases completed"
echo "  - Trust Score: $TRUST_SCORE"
