#!/bin/bash
set -e

WORKSPACE_DIR="/home/csuzngjh/clawd"
OUTPUT_DIR="$WORKSPACE_DIR/okr-test-output"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

mkdir -p "$OUTPUT_DIR"

echo "╔════════════════════════════════════════════════════════════╗"
echo "║   REAL OKR Task Test v2 - Max Trust (100/100)              ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "Time: $(date)"
echo "Trust Score: 100/100 (Stage 4: Architect)"
echo "Output: $OUTPUT_DIR"
echo ""

# Task with workspace path
TASK="请分析故事文件 /home/csuzngjh/code/code_magic_academy/story/source/narratives/chapter-01.md 的故事节奏和情节连贯性。

要求：
1. 读取完整章节
2. 分析故事节奏和连贯性
3. 生成报告保存到: $OUTPUT_DIR/analysis.md

报告必须包含：
- 故事节奏分析
- 情节连贯性评估  
- 发现的问题
- 改进建议

请现在开始执行，完成所有步骤。"

echo "📤 Sending task to agent..."
echo ""

# Send task
timeout 300 openclaw agent --agent main --message "$TASK" >/dev/null 2>&1 &
AGENT_PID=$!

echo "⏳ Agent PID: $AGENT_PID"
echo "🕐 Waiting for agent to work (checking every 30s)..."
echo ""

# Check progress over time
for i in {1..10}; do
    sleep 30
    
    echo "=== Check $i ($(date +%H:%M:%S)) ==="
    
    # Check if file exists
    if [ -f "$OUTPUT_DIR/analysis.md" ]; then
        SIZE=$(wc -c < "$OUTPUT_DIR/analysis.md")
        echo "✅ File found! Size: $SIZE bytes"
        
        if [ "$SIZE" -gt 100 ]; then
            echo "✅ File has content!"
            break
        fi
    else
        echo "⏳ File not yet created..."
    fi
    
    # Check recent activity
    GATEWAY_LOG="/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log"
    RECENT_ACTIVITY=$(tail -10 "$GATEWAY_LOG" 2>/dev/null | grep -c "agent" || echo "0")
    echo "   Recent agent activity: $RECENT_ACTIVITY runs"
    
    # Check process
    if ps -p $AGENT_PID > /dev/null 2>&1; then
        echo "   Agent process still running"
    else
        echo "   Agent process completed"
    fi
    
    echo ""
done

echo ""
echo "================================================================"
echo ""

# Final check
if [ -f "$OUTPUT_DIR/analysis.md" ]; then
    echo "✅ SUCCESS! Report generated!"
    echo ""
    echo "📄 Report content:"
    echo "---"
    cat "$OUTPUT_DIR/analysis.md"
    echo "---"
else
    echo "⏳ Time's up! Checking what happened..."
    
    # Check session
    SESSION_FILE=$(cat ~/.openclaw/agents/main/sessions/sessions.json 2>/dev/null | jq -r 'to_entries[0].value.sessionFile')
    
    if [ -n "$SESSION_FILE" ] && [ -f "$SESSION_FILE" ]; then
        echo ""
        echo "📋 Last agent responses:"
        tail -20 "$SESSION_FILE" | jq -r 'select(.message.role == "assistant") | .message.content[0].text // .message.content[0].thinking // "no content"' | tail -5
    fi
fi

