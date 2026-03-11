#!/bin/bash
# End-to-End Conversation Test for Story Optimization OKR
# Tests agent behavior and collects system data

set -euo pipefail

# Configuration
WORKSPACE_DIR="/home/csuzngjh/clawd"
AGENT_ID="main"
OUTPUT_DIR="/home/csuzngjh/code/principles/tests/reports"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
REPORT_FILE="$OUTPUT_DIR/e2e-test-$TIMESTAMP.md"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo "╔════════════════════════════════════════════════════════════╗"
echo "║     E2E Conversation Test - Story Optimization OKR          ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "Time: $(date)"
echo "Agent: $AGENT_ID"
echo "Workspace: $WORKSPACE_DIR"
echo ""

# Create output directory
mkdir -p "$OUTPUT_DIR"

# ============================================================================
# Test Scenarios
# ============================================================================

echo "📝 Running test scenarios..."
echo ""

# Phase 1: Structure Analysis
echo "Phase 1: Testing structure analysis..."
RESPONSE1=$(timeout 120 openclaw agent --agent "$AGENT_ID" --message "你好，我看到你的 OKR 中有故事优化任务。请分析第一章的故事节奏和情节连贯性，找出任何需要改进的地方。" 2>&1 || echo "TIMEOUT_OR_ERROR")
echo "✓ Phase 1 complete"
echo ""

sleep 2

# Phase 2: Character Consistency
echo "Phase 2: Testing character consistency check..."
RESPONSE2=$(timeout 120 openclaw agent --agent "$AGENT_ID" --message "现在检查第一章的角色一致性。主角的行为和动机是否符合其性格设定？是否有不一致的地方？" 2>&1 || echo "TIMEOUT_OR_ERROR")
echo "✓ Phase 2 complete"
echo ""

sleep 2

# Phase 3: Technical Concepts
echo "Phase 3: Testing technical concept mapping..."
RESPONSE3=$(timeout 120 openclaw agent --agent "$AGENT_ID" --message "检查编程概念映射的准确性。确保技术细节正确且易于初学者理解。" 2>&1 || echo "TIMEOUT_OR_ERROR")
echo "✓ Phase 3 complete"
echo ""

sleep 2

# Phase 4: User Pain Points
echo "Phase 4: Testing user pain point identification..."
RESPONSE4=$(timeout 120 openclaw agent --agent "$AGENT_ID" --message "最后，识别用户可能在学习过程中遇到的痛点，并提出具体的改进建议。" 2>&1 || echo "TIMEOUT_OR_ERROR")
echo "✓ Phase 4 complete"
echo ""

# ============================================================================
# Data Collection
# ============================================================================

echo "📊 Collecting system data..."
echo ""

# Collect trust score (with error handling)
if [ -f "$WORKSPACE_DIR/docs/AGENT_SCORECARD.json" ]; then
    TRUST_SCORE=$(cat "$WORKSPACE_DIR/docs/AGENT_SCORECARD.json" | jq -r '.trust_score // "N/A"' 2>/dev/null || echo "N/A")
    TRUST_STAGE=$(cat "$WORKSPACE_DIR/docs/AGENT_SCORECARD.json" | jq -r '.trust_stage // "N/A"' 2>/dev/null || echo "N/A")
    WINS=$(cat "$WORKSPACE_DIR/docs/AGENT_SCORECARD.json" | jq -r '.wins // 0' 2>/dev/null || echo "0")
    LOSSES=$(cat "$WORKSPACE_DIR/docs/AGENT_SCORECARD.json" | jq -r '.losses // 0' 2>/dev/null || echo "0")
else
    TRUST_SCORE="N/A"
    TRUST_STAGE="N/A"
    WINS="0"
    LOSSES="0"
fi

# Collect recent events (with error handling)
if [ -f "$WORKSPACE_DIR/memory/.state/logs/events.jsonl" ]; then
    EVENT_COUNT=$(tail -100 "$WORKSPACE_DIR/memory/.state/logs/events.jsonl" | wc -l)
    GATE_BLOCKS=$(grep '"event_type":"gate_block"' "$WORKSPACE_DIR/memory/.state/logs/events.jsonl" | tail -10 | wc -l)
    TOOL_FAILURES=$(grep '"success":false' "$WORKSPACE_DIR/memory/.state/logs/events.jsonl" | tail -20 | wc -l)
else
    EVENT_COUNT="0"
    GATE_BLOCKS="0"
    TOOL_FAILURES="0"
fi

# Collect Gateway errors
GATEWAY_LOG="/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log"
if [ -f "$GATEWAY_LOG" ]; then
    GATEWAY_ERRORS=$(tail -100 "$GATEWAY_LOG" | grep -i "error" | wc -l)
else
    GATEWAY_ERRORS="0"
fi

# Check pain signals
PAIN_FLAG="$WORKSPACE_DIR/workspace/code/principles/docs/.pain_flag"
if [ -f "$PAIN_FLAG" ]; then
    PAIN_SIGNALS=$(cat "$PAIN_FLAG" | wc -l)
else
    PAIN_SIGNALS="0"
fi

echo "  Trust Score: $TRUST_SCORE"
echo "  Trust Stage: $TRUST_STAGE"
echo "  Wins: $WINS, Losses: $LOSSES"
echo "  Pain Signals: $PAIN_SIGNALS"
echo "  Recent Events: $EVENT_COUNT"
echo "  Gate Blocks (recent): $GATE_BLOCKS"
echo "  Tool Failures (recent): $TOOL_FAILURES"
echo "  Gateway Errors (today): $GATEWAY_ERRORS"
echo ""

# ============================================================================
# Analysis
# ============================================================================

echo "🔍 Analyzing results..."
echo ""

ISSUES=()

# Check trust score (only if numeric)
if [[ "$TRUST_SCORE" =~ ^[0-9]+$ ]]; then
    if [ "$TRUST_SCORE" -lt 30 ]; then
        ISSUES+=("⚠️  Trust score is low ($TRUST_SCORE). Agent may have restricted permissions.")
    elif [ "$TRUST_SCORE" -gt 90 ]; then
        ISSUES+=("✅ Trust score is excellent ($TRUST_SCORE).")
    fi
else
    ISSUES+=("ℹ️  Trust score: $TRUST_SCORE")
fi

# Check gate blocks
if [[ "$GATE_BLOCKS" =~ ^[0-9]+$ ]] && [ "$GATE_BLOCKS" -gt 5 ]; then
    ISSUES+=("⚠️  High number of gate blocks detected ($GATE_BLOCKS). Check if agent is being overly restricted.")
fi

# Check tool failures
if [[ "$TOOL_FAILURES" =~ ^[0-9]+$ ]] && [ "$TOOL_FAILURES" -gt 10 ]; then
    ISSUES+=("⚠️  High tool failure rate detected ($TOOL_FAILURES). Check agent's error handling.")
fi

# Check pain signals
if [[ "$PAIN_SIGNALS" =~ ^[0-9]+$ ]] && [ "$PAIN_SIGNALS" -gt 3 ]; then
    ISSUES+=("⚠️  Multiple pain signals accumulated ($PAIN_SIGNALS). Consider running evolution tasks.")
fi

# Check Gateway errors
if [[ "$GATEWAY_ERRORS" =~ ^[0-9]+$ ]] && [ "$GATEWAY_ERRORS" -gt 50 ]; then
    ISSUES+=("⚠️  High Gateway error rate ($GATEWAY_ERRORS). Check Gateway logs for issues.")
fi

if [ ${#ISSUES[@]} -eq 0 ]; then
    ISSUES+=("✅ No critical issues detected.")
fi

# ============================================================================
# Generate Report
# ============================================================================

echo "📄 Generating report..."
echo ""

# Prepare response summaries
R1_LEN=${#RESPONSE1}
R2_LEN=${#RESPONSE2}
R3_LEN=${#RESPONSE3}
R4_LEN=${#RESPONSE4}

cat > "$REPORT_FILE" << EOF
# E2E Conversation Test Report

**Date**: $(date)
**Agent**: $AGENT_ID
**Test Scenario**: Story Optimization OKR

## Test Execution

### Phase 1: Structure Analysis
**Prompt**: 分析第一章的故事节奏和情节连贯性
**Response**: [${R1_LEN} characters]

### Phase 2: Character Consistency
**Prompt**: 检查角色一致性
**Response**: [${R2_LEN} characters]

### Phase 3: Technical Concepts
**Prompt**: 验证编程概念映射
**Response**: [${R3_LEN} characters]

### Phase 4: User Pain Points
**Prompt**: 识别用户痛点
**Response**: [${R4_LEN} characters]

## System State

### Trust System
- **Trust Score**: $TRUST_SCORE / 100
- **Trust Stage**: $TRUST_STAGE
- **Wins**: $WINS
- **Losses**: $LOSSES

### Pain Signals
- **Active Signals**: $PAIN_SIGNALS

### Recent Activity
- **Events Logged**: $EVENT_COUNT
- **Gate Blocks**: $GATE_BLOCKS
- **Tool Failures**: $TOOL_FAILURES
- **Gateway Errors**: $GATEWAY_ERRORS

## Analysis Findings

$(for issue in "${ISSUES[@]}"; do echo "- $issue"; done)

## Recommendations

1. **Monitor Trust Score**: Keep trust score above 30 for adequate permissions
2. **Review Gate Blocks**: Check if blocks are legitimate or overly restrictive
3. **Analyze Failures**: Investigate tool failure patterns
4. **Check Evolution Queue**: Review pending evolution tasks
5. **Update PLAN.md**: Ensure current tasks are whitelisted

## Quick Commands

\`\`\bash
# View full agent response
openclaw sessions history --limit 10

# Check trust score trends
tail -20 $WORKSPACE_DIR/memory/.state/logs/events.jsonl | jq 'select(.event_type == "trust_score_change")'

# View gate blocks
grep '"event_type":"gate_block"' $WORKSPACE_DIR/memory/.state/logs/events.jsonl | tail -5

# Check pain signals
cat $WORKSPACE_DIR/workspace/code/principles/docs/.pain_flag

# View Gateway logs
tail -50 /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log
\`\`\

---

**Generated by**: e2e-conversation-test.sh
**Next test**: $(date -d '+30 minutes' +'%Y-%m-%d %H:%M:%S')
EOF

echo "  Report saved to: $REPORT_FILE"
echo ""

# ============================================================================
# Summary
# ============================================================================

echo "╔════════════════════════════════════════════════════════════╗"
echo "║  Test Complete                                                ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "Summary:"
echo "  Phases Completed: 4/4"
echo "  Trust Score: $TRUST_SCORE"
echo "  Issues Found: ${#ISSUES[@]}"
echo ""
echo "Issues:"
for issue in "${ISSUES[@]}"; do
    echo "  - $issue"
done
echo ""
echo "Next run: $(date -d '+30 minutes' +'%Y-%m-%d %H:%M:%S')"
echo ""

# Auto-cleanup old reports (keep last 10)
find "$OUTPUT_DIR" -name "e2e-test-*.md" -type f | sort -r | tail -n +10 | xargs rm -f 2>/dev/null || true

exit 0
