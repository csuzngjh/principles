#!/bin/bash
set -e

WORKSPACE_DIR="/home/csuzngjh/clawd"
STORY_DIR="/home/csuzngjh/code/code_magic_academy/story/source/narratives"
OUTPUT_DIR="/home/csuzngjh/code/principles/tests/okr-results"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
TEST_DIR="$OUTPUT_DIR/test-$TIMESTAMP"

mkdir -p "$TEST_DIR"

echo "╔════════════════════════════════════════════════════════════╗"
echo "║     REAL OKR Task Test - Story Optimization                ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "Time: $(date)"
echo "Test Directory: $TEST_DIR"
echo ""

# Backup current state
echo "📸 Backing up current state..."
cp -r "$STORY_DIR" "$TEST_DIR/stories-backup" 2>/dev/null || true
echo "✓ Backup complete"
echo ""

# ============================================================================
# Phase 1: Structure Analysis
# ============================================================================
echo "🎯 Phase 1: Structure Analysis"
echo "Task: Analyze chapter-01 story rhythm and plot coherence"
echo ""

# Create the task prompt
TASK1="请分析 /home/csuzngjh/code/code_magic_academy/story/source/narratives/chapter-01.md 的故事节奏和情节连贯性。

要求：
1. 读取完整的章节内容
2. 分析故事节奏（开头、发展、高潮、结局）
3. 检查情节是否有逻辑漏洞或突兀之处
4. 生成诊断报告，保存到 /home/csuzngjh/code/principles/tests/okr-results/test-$TIMESTAMP/phase1-structure-analysis.md

报告格式：
## 故事节奏分析
[你的分析]

## 情节连贯性检查
[你的发现]

## 问题清单
- 问题1：[描述]
- 问题2：[描述]

## 评分
- 节奏：X/10
- 连贯性：X/10"

# Send task to agent
echo "📤 Sending task to agent..."
timeout 180 openclaw agent --agent main --message "$TASK1" >/dev/null 2>&1 || true
echo "⏳ Waiting for agent to complete (30s)..."
sleep 30

# Check if report was generated
echo ""
echo "📊 Checking results..."
if [ -f "$TEST_DIR/phase1-structure-analysis.md" ]; then
    echo "✅ Phase 1 report generated!"
    REPORT_SIZE=$(wc -c < "$TEST_DIR/phase1-structure-analysis.md")
    echo "   Report size: $REPORT_SIZE bytes"
    echo ""
    echo "📄 Report preview (first 500 chars):"
    head -c 500 "$TEST_DIR/phase1-structure-analysis.md"
    echo ""
else
    echo "❌ Phase 1 report NOT generated"
    echo "   Checking if agent read the file..."
    
    # Check agent activity
    GATEWAY_LOG="/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log"
    RECENT_RUNS=$(grep "⇄ res ✓ agent" "$GATEWAY_LOG" 2>/dev/null | tail -5)
    if [ -n "$RECENT_RUNS" ]; then
        echo "   Agent ran but didn't create expected output"
    else
        echo "   Agent may not have executed the task"
    fi
fi

echo ""
echo "================================================================"
echo ""

# ============================================================================
# Phase 2: Check what agent actually did
# ============================================================================
echo "🔍 Phase 2: Analyzing Agent Behavior"
echo ""

# Check session for tool calls
SESSION_FILE=$(cat ~/.openclaw/agents/main/sessions/sessions.json 2>/dev/null | jq -r 'to_entries[0].value.sessionFile')
if [ -n "$SESSION_FILE" ] && [ -f "$SESSION_FILE" ]; then
    echo "📋 Analyzing session activity..."
    
    # Check for file reads
    FILE_READS=$(cat "$SESSION_FILE" | jq -r 'select(.message.role == "user") | .message.content[0].text' | grep -o "chapter-01.md" | wc -l)
    echo "   - Chapter-01.md mentions: $FILE_READS"
    
    # Check for write operations
    WRITE_OPS=$(cat "$SESSION_FILE" | jq -r 'select(.type == "message" and .message.role == "assistant") | .message.content[0].text' | grep -i "write\|save\|创建\|保存" | wc -l)
    echo "   - Write operation mentions: $WRITE_OPS"
    
    # Get last assistant response
    LAST_RESPONSE=$(cat "$SESSION_FILE" | jq -r 'select(.message.role == "assistant") | .message.content[] | select(.type == "text") | .text' | tail -1)
    if [ -n "$LAST_RESPONSE" ]; then
        echo ""
        echo "📝 Last agent response (first 800 chars):"
        echo "$LAST_RESPONSE" | head -c 800
        echo ""
    fi
fi

echo ""
echo "================================================================"
echo ""

# ============================================================================
# Phase 3: Quality Assessment
# ============================================================================
echo "🎯 Phase 3: Output Quality Assessment"
echo ""

if [ -f "$TEST_DIR/phase1-structure-analysis.md" ]; then
    REPORT="$TEST_DIR/phase1-structure-analysis.md"
    
    # Check report structure
    echo "📋 Report Structure Analysis:"
    
    if grep -q "## 故事节奏分析" "$REPORT"; then
        echo "   ✅ Has rhythm analysis section"
    else
        echo "   ❌ Missing rhythm analysis section"
    fi
    
    if grep -q "## 情节连贯性" "$REPORT"; then
        echo "   ✅ Has coherence analysis section"
    else
        echo "   ❌ Missing coherence analysis section"
    fi
    
    if grep -q "## 问题清单" "$REPORT"; then
        echo "   ✅ Has problem list section"
    else
        echo "   ❌ Missing problem list section"
    fi
    
    if grep -q "## 评分" "$REPORT"; then
        echo "   ✅ Has scoring section"
    else
        echo "   ❌ Missing scoring section"
    fi
    
    echo ""
    
    # Check content quality
    TOTAL_CHARS=$(wc -c < "$REPORT")
    TOTAL_WORDS=$(wc -w < "$REPORT")
    
    echo "📊 Content Metrics:"
    echo "   - Total characters: $TOTAL_CHARS"
    echo "   - Total words: $TOTAL_WORDS"
    
    if [ "$TOTAL_WORDS" -lt 100 ]; then
        echo "   ⚠️  Report seems too short (< 100 words)"
    elif [ "$TOTAL_WORDS" -gt 50 ]; then
        echo "   ✅ Report has reasonable length"
    fi
    
    # Check if actual story content was analyzed
    if grep -q "Leo\|艾丽\|Code魔法学院" "$REPORT"; then
        echo "   ✅ Report references story characters"
    else
        echo "   ⚠️  Report may not have analyzed actual story"
    fi
    
else
    echo "❌ No report to assess"
fi

echo ""
echo "================================================================"
echo ""

# ============================================================================
# Final Summary
# ============================================================================
echo "📊 Test Summary"
echo ""

# Generate final report
cat > "$TEST_DIR/test-summary.md" << EOF
# Real OKR Task Test Summary

**Date**: $(date)
**Test Directory**: $TEST_DIR

## Task Given

Agent was asked to:
1. Read \`chapter-01.md\` from the story directory
2. Analyze story rhythm and plot coherence
3. Generate a structured diagnostic report

## Results

### Output Generated
$(if [ -f "$TEST_DIR/phase1-structure-analysis.md" ]; then
    echo "✅ YES - Report was created"
    echo "- Size: $(wc -c < "$TEST_DIR/phase1-structure-analysis.md") bytes"
    echo "- Words: $(wc -w < "$TEST_DIR/phase1-structure-analysis.md") words"
else
    echo "❌ NO - Report was NOT created"
fi)

### Quality Assessment
$(if [ -f "$TEST_DIR/phase1-structure-analysis.md" ]; then
    echo "See detailed analysis in test output"
else
    echo "No output to assess"
fi)

### Agent Behavior
- Task sent: YES
- Wait time: 30 seconds
- Tool calls: Check session analysis above

## Conclusion

$(if [ -f "$TEST_DIR/phase1-structure-analysis.md" ] && [ $(wc -w < "$TEST_DIR/phase1-structure-analysis.md") -gt 50 ]; then
    echo "✅ Agent successfully completed the OKR task with meaningful output"
elif [ -f "$TEST_DIR/phase1-structure-analysis.md" ]; then
    echo "⚠️  Agent created output but quality is unclear (too short)"
else
    echo "❌ Agent failed to complete the OKR task as specified"
fi)

## Recommendations

- Review agent response to understand why report wasn't created
- Consider if agent needs clearer instructions or different prompt format
- Check if agent has permission to write to the output directory
EOF

echo "✅ Test complete!"
echo ""
echo "📄 Summary report: $TEST_DIR/test-summary.md"
echo "📁 Test directory: $TEST_DIR"
echo ""
echo "📋 Next Steps:"
echo "   1. Review the generated reports"
echo "   2. Check agent's actual response in session history"
echo "   3. Assess if output quality meets requirements"
echo "   4. Identify why agent may not have followed instructions"

