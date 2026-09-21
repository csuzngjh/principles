#!/bin/bash
set -e

WORKSPACE_DIR="/home/csuzngjh/clawd"
STORY_DIR="/home/csuzngjh/code/code_magic_academy/story/source/narratives"
OUTPUT_DIR="$WORKSPACE_DIR/okr-diagnostic"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

mkdir -p "$OUTPUT_DIR"

echo "╔════════════════════════════════════════════════════════════╗"
echo "║   FINAL OKR TEST - Stage 4 (Trust 100/100)                  ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "Time: $(date)"
echo "Trust Score: 100/100"
echo "Stage: 4 (Architect - Full Access)"
echo "Output: $OUTPUT_DIR"
echo ""

# Real OKR task
TASK="请执行故事诊断Phase 1的第一个任务：整体结构分析。

任务要求：
1. 读取文件：$STORY_DIR/chapter-01.md
2. 分析内容：
   - 故事节奏（开头、发展、高潮、结局）
   - 情节连贯性（是否有逻辑漏洞、突兀转折）
   - 整体结构评价
3. 生成诊断报告并保存到：$OUTPUT_DIR/phase1-structure-report.md

报告格式要求：
## 故事节奏分析
[详细分析]

## 情节连贯性检查
[详细检查]

## 发现的问题
- 列出具体问题

## 评分
- 节奏：X/10
- 连贯性：X/10

请立即开始执行，完成所有步骤并生成报告。"

echo "📤 Sending task to agent..."
echo ""

# Send task and wait
timeout 300 openclaw agent --agent main --message "$TASK" >/dev/null 2>&1 &
AGENT_PID=$!

echo "⏳ Waiting for agent to complete (monitoring every 20s)..."
echo ""

# Monitor with checks
for i in {1..15}; do
    sleep 20
    
    if [ -f "$OUTPUT_DIR/phase1-structure-report.md" ]; then
        SIZE=$(wc -c < "$OUTPUT_DIR/phase1-structure-report.md")
        WORDS=$(wc -w < "$OUTPUT_DIR/phase1-structure-report.md")
        
        echo "✅ SUCCESS! Report generated!"
        echo "   Time elapsed: $((i * 20)) seconds"
        echo "   File size: $SIZE bytes"
        echo "   Word count: $WORDS words"
        echo ""
        
        # Quality check
        if [ "$WORDS" -gt 100 ]; then
            echo "✅ Report has substantial content"
        else
            echo "⚠️  Report seems short"
        fi
        
        if grep -q "## 故事节奏分析" "$OUTPUT_DIR/phase1-structure-report.md" 2>/dev/null; then
            echo "✅ Has required sections"
        fi
        
        break
    fi
    
    # Progress indicator
    if [ $((i % 3)) -eq 0 ]; then
        echo "⏳ Still waiting... ($((i * 20))s elapsed)"
        
        # Check agent activity
        GATEWAY_LOG="/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log"
        RECENT_RUNS=$(tail -5 "$GATEWAY_LOG" 2>/dev/null | grep -c "agent" || echo "0")
        echo "   Recent activity: $RECENT_RUNS runs"
    fi
    
    # Check if agent process still running
    if ! ps -p $AGENT_PID > /dev/null 2>&1; then
        echo "⚠️  Agent process completed but no report found"
        break
    fi
done

echo ""
echo "================================================================"
echo ""

# Final report
if [ -f "$OUTPUT_DIR/phase1-structure-report.md" ]; then
    echo "📄 FULL REPORT CONTENT:"
    echo "========================"
    cat "$OUTPUT_DIR/phase1-structure-report.md"
    echo ""
    echo "========================"
    echo ""
    echo "✅ TEST PASSED: Agent successfully completed OKR task!"
    
else
    echo "❌ Report not found. Checking what happened..."
    
    # Check session
    SESSION_FILE=$(cat ~/.openclaw/agents/main/sessions/sessions.json 2>/dev/null | jq -r 'to_entries[0].value.sessionFile')
    
    if [ -n "$SESSION_FILE" ] && [ -f "$SESSION_FILE" ]; then
        echo ""
        echo "📋 Last assistant message:"
        tail -3 "$SESSION_FILE" | grep '"role":"assistant"' | tail -1 | jq -r '.message.content[0].text // .message.content[0].thinking' 2>/dev/null | head -c 500
        
        echo ""
        echo "🔧 Recent tool calls:"
        tail -30 "$SESSION_FILE" | grep '"toolName"' | jq -r '"\(.timestamp) - \(.message.toolName)"' 2>/dev/null | tail -5
        
        echo ""
        echo "🚧 Tool results:"
        tail -30 "$SESSION_FILE" | grep '"role":"toolResult"' | tail -3 | jq -r '{tool: .message.toolName, status: .message.details.status}' 2>/dev/null
    fi
fi

