#!/bin/bash
# Simple health check script that runs every 30 minutes
# Focuses on system state rather than agent responses

WORKSPACE_DIR="/home/csuzngjh/clawd"
OUTPUT_DIR="/home/csuzngjh/code/principles/tests/reports"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
REPORT_FILE="$OUTPUT_DIR/health-check-$TIMESTAMP.md"
GATEWAY_LOG="/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log"

mkdir -p "$OUTPUT_DIR"

echo "╔════════════════════════════════════════════════════════════╗"
echo "║         System Health Check - Automated Loop                ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "Time: $(date)"
echo "Model: unicom-cloud/MiniMax-M2.5"
echo ""

# Send a simple test message (just to trigger activity)
echo "📝 Testing agent connectivity..."
timeout 30 openclaw agent --agent main --message "ping" >/dev/null 2>&1 || true
sleep 2
echo "✓ Agent connectivity test complete"
echo ""

# Collect system data
echo "📊 Collecting system metrics..."

# Trust score
TRUST_SCORE="N/A"
if [ -f "$WORKSPACE_DIR/.state/AGENT_SCORECARD.json" ]; then
    TRUST_SCORE=$(cat "$WORKSPACE_DIR/.state/AGENT_SCORECARD.json" 2>/dev/null | jq -r '.trust_score // "N/A"' || echo "N/A")
    WINS=$(cat "$WORKSPACE_DIR/.state/AGENT_SCORECARD.json" 2>/dev/null | jq -r '.wins // 0' || echo "0")
    LOSSES=$(cat "$WORKSPACE_DIR/.state/AGENT_SCORECARD.json" 2>/dev/null | jq -r '.losses // 0' || echo "0")
elif [ -f "$WORKSPACE_DIR/docs/AGENT_SCORECARD.json" ]; then
    TRUST_SCORE=$(cat "$WORKSPACE_DIR/docs/AGENT_SCORECARD.json" 2>/dev/null | jq -r '.trust_score // "N/A"' || echo "N/A")
    WINS=$(cat "$WORKSPACE_DIR/docs/AGENT_SCORECARD.json" 2>/dev/null | jq -r '.wins // 0' || echo "0")
    LOSSES=$(cat "$WORKSPACE_DIR/docs/AGENT_SCORECARD.json" 2>/dev/null | jq -r '.losses // 0' || echo "0")
fi

# Event counts
EVENT_COUNT="0"
GATE_BLOCKS="0"
TOOL_FAILURES="0"
if [ -f "$WORKSPACE_DIR/memory/.state/logs/events.jsonl" ]; then
    EVENT_COUNT=$(tail -100 "$WORKSPACE_DIR/memory/.state/logs/events.jsonl" 2>/dev/null | wc -l)
    GATE_BLOCKS=$(grep '"event_type":"gate_block"' "$WORKSPACE_DIR/memory/.state/logs/events.jsonl" 2>/dev/null | tail -10 | wc -l)
    TOOL_FAILURES=$(grep '"success":false' "$WORKSPACE_DIR/memory/.state/logs/events.jsonl" 2>/dev/null | tail -20 | wc -l)
fi

# Gateway errors
GATEWAY_ERRORS="0"
if [ -f "$GATEWAY_LOG" ]; then
    GATEWAY_ERRORS=$(tail -100 "$GATEWAY_LOG" 2>/dev/null | grep -i "error" | wc -l)
fi

# Pain signals
PAIN_SIGNALS="0"
PAIN_FLAG="$WORKSPACE_DIR/workspace/code/principles/docs/.pain_flag"
if [ -f "$PAIN_FLAG" ]; then
    PAIN_SIGNALS=$(cat "$PAIN_FLAG" 2>/dev/null | wc -l || echo "0")
fi

# Recent agent runs
RECENT_RUNS=$(grep "⇄ res ✓ agent" "$GATEWAY_LOG" 2>/dev/null | tail -10 | wc -l)

echo "  Trust Score: $TRUST_SCORE"
echo "  Wins: $WINS, Losses: $LOSSES"
echo "  Recent Events: $EVENT_COUNT"
echo "  Gate Blocks: $GATE_BLOCKS"
echo "  Tool Failures: $TOOL_FAILURES"
echo "  Gateway Errors: $GATEWAY_ERRORS"
echo "  Pain Signals: $PAIN_SIGNALS"
echo "  Recent Agent Runs: $RECENT_RUNS"
echo ""

# Analysis
echo "🔍 Analyzing system state..."
echo ""

ISSUES=()

if [[ "$TRUST_SCORE" =~ ^[0-9]+$ ]] && [ "$TRUST_SCORE" -lt 30 ]; then
    ISSUES+=("⚠️  Low trust score ($TRUST_SCORE)")
fi

if [ "$GATE_BLOCKS" -gt 5 ]; then
    ISSUES+=("⚠️  High gate blocks ($GATE_BLOCKS)")
fi

if [ "$TOOL_FAILURES" -gt 10 ]; then
    ISSUES+=("⚠️  High tool failures ($TOOL_FAILURES)")
fi

if [ "$GATEWAY_ERRORS" -gt 50 ]; then
    ISSUES+=("⚠️  High gateway errors ($GATEWAY_ERRORS)")
fi

if [ "$RECENT_RUNS" -lt 1 ]; then
    ISSUES+=("⚠️  No recent agent activity")
fi

# Generate report
echo "📄 Generating report..."

cat > "$REPORT_FILE" << EOF
# System Health Check Report

**Date**: $(date)
**Model**: unicom-cloud/MiniMax-M2.5
**Check Type**: Automated Loop (30 min interval)

## System Metrics

| Metric | Value |
|--------|-------|
| Trust Score | $TRUST_SCORE/100 |
| Wins | $WINS |
| Losses | $LOSSES |
| Recent Events | $EVENT_COUNT |
| Gate Blocks | $GATE_BLOCKS |
| Tool Failures | $TOOL_FAILURES |
| Gateway Errors | $GATEWAY_ERRORS |
| Pain Signals | $PAIN_SIGNALS |
| Recent Agent Runs | $RECENT_RUNS |

## Issues Detected

$(if [ ${#ISSUES[@]} -eq 0 ]; then
    echo "✅ No issues detected. System is healthy."
else
    for issue in "${ISSUES[@]}"; do
        echo "- $issue"
    done
fi)

## Recommendations

$(if [[ "$TRUST_SCORE" =~ ^[0-9]+$ ]] && [ "$TRUST_SCORE" -lt 50 ]; then
    echo "- Consider reviewing agent performance to improve trust score"
elif [[ "$TRUST_SCORE" =~ ^[0-9]+$ ]] && [ "$TRUST_SCORE" -gt 80 ]; then
    echo "- Trust score is excellent. Agent has full permissions."
else
    echo "- System is operating normally"
fi)

---

**Next Check**: $(date -d '+30 minutes' 2>/dev/null || date -v+30M 2>/dev/null || echo "30 minutes from now")
EOF

echo ""
echo "✅ Health check complete!"
echo "📄 Report saved to: $REPORT_FILE"
echo ""
echo "📋 Summary:"
echo "  - Trust Score: $TRUST_SCORE"
echo "  - Recent Activity: $RECENT_RUNS runs"
echo "  - Issues Found: ${#ISSUES[@]}"

# Auto-cleanup old reports (keep last 20)
ls -t "$OUTPUT_DIR"/health-check-*.md 2>/dev/null | tail -n +21 | xargs rm -f 2>/dev/null || true
ls -t "$OUTPUT_DIR"/e2e-test-*.md 2>/dev/null | tail -n +21 | xargs rm -f 2>/dev/null || true

echo "  - Old reports cleaned up"
