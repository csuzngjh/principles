#!/bin/bash
# ============================================================================
# OKR任务测试脚本 - 统一版本
# ============================================================================
# 用途：在真实OKR任务上测试Agent能力
# 特点：统一配置、自动化验证、详细报告、智能错误处理
# ============================================================================

set -e

# 加载测试环境配置
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config/test-env.sh"

# ============================================================================
# 参数处理
# ============================================================================
PHASE="${1:-1}"              # OKR阶段（默认Phase 1）
TASK_TYPE="${2:-structure}"  # 任务类型（structure, character, concept, pain）
VERBOSE="${VERBOSE:-false}"  # 详细输出

# 输出文件
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
TEST_REPORT="$TEST_REPORTS_DIR/okr-test-${PHASE}-${TASK_TYPE}-${TIMESTAMP}.md"
TASK_OUTPUT="$OUTPUT_DIR/phase${PHASE}-${TASK_TYPE}-report.md"

# 创建输出目录
mkdir -p "$OUTPUT_DIR"
mkdir -p "$TEST_REPORTS_DIR"

# ============================================================================
# 任务定义
# ============================================================================

# Phase 1: 结构分析
define_phase1_structure_task() {
    cat << EOF
请执行故事诊断Phase 1的第一个任务：整体结构分析。

任务要求：
1. 读取文件：$STORY_DIR/chapter-01.md
2. 分析内容：
   - 故事节奏（开头、发展、高潮、结局）
   - 情节连贯性（是否有逻辑漏洞、突兀转折）
   - 整体结构评价
3. 生成诊断报告并保存到：$TASK_OUTPUT

报告格式要求：
## 故事节奏分析
[详细分析，包含具体行号引用]

## 情节连贯性检查
[详细检查，标注问题位置]

## 发现的问题
- 按优先级列出问题（P0, P1, P2）
- 每个问题包含：位置、描述、严重程度

## 评分
- 节奏：X/10（附理由）
- 连贯性：X/10（附理由）
- 总体：X/10

## 改进建议
[具体的、可操作的改进建议]

请立即开始执行，完成所有步骤并生成报告。
EOF
}

# Phase 1: 角色一致性（占位）
define_phase1_character_task() {
    cat << EOF
请执行故事诊断Phase 1的第二个任务：角色一致性检查。

任务要求：
1. 读取文件：$STORY_DIR/chapter-01.md
2. 检查角色一致性：
   - 里奥的角色特征是否前后一致
   - 可可的角色特征是否前后一致
   - 对话风格是否符合角色设定
3. 生成报告并保存到：$TASK_OUTPUT

请立即开始执行。
EOF
}

# ============================================================================
# 核心功能
# ============================================================================

# 打印测试信息
print_test_info() {
    cat << EOF
╔════════════════════════════════════════════════════════════╗
║         OKR Task Test - Phase ${PHASE} (${TASK_TYPE})             ║
╚════════════════════════════════════════════════════════════╝

Time:     $(date)
Phase:    ${PHASE}
Task:     ${TASK_TYPE}
Output:   $TASK_OUTPUT
Report:   $TEST_REPORT

$(print_test_config)
EOF
}

# 获取任务描述
get_task_description() {
    case "$PHASE" in
        1)
            case "$TASK_TYPE" in
                structure) define_phase1_structure_task ;;
                character) define_phase1_character_task ;;
                *) echo "Unknown task type: $TASK_TYPE" >&2; exit 1 ;;
            esac
            ;;
        *) echo "Phase ${PHASE} not yet implemented" >&2; exit 1 ;;
    esac
}

# 发送任务到Agent
send_task() {
    local task="$1"

    echo "📤 Sending task to agent..."
    if [ "$VERBOSE" == "true" ]; then
        echo "Task description:"
        echo "$task" | head -20
        echo "..."
    fi
    echo ""

    # 后台执行
    timeout "$TEST_TIMEOUT" openclaw agent --agent "$AGENT_ID" --message "$task" >/dev/null 2>&1 &
    AGENT_PID=$!

    echo "✓ Agent started (PID: $AGENT_PID)"
    echo "⏳ Waiting for completion (checking every ${CHECK_INTERVAL}s)..."
    echo ""
}

# 监控执行进度
monitor_progress() {
    local checks=0
    local success=false

    while [ $checks -lt $MAX_CHECKS ]; do
        sleep "$CHECK_INTERVAL"
        checks=$((checks + 1))

        # 检查输出文件
        if [ -f "$TASK_OUTPUT" ]; then
            local quality=$(check_file_quality "$TASK_OUTPUT")
            local size=$(echo "$quality" | jq -r '.size')
            local words=$(echo "$quality" | jq -r '.words')

            echo "✅ SUCCESS! Report generated!"
            echo "   Time elapsed: $((checks * CHECK_INTERVAL)) seconds"
            echo "   File size: $size bytes"
            echo "   Word count: $words words"
            echo ""

            # 质量检查
            if [ "$size" -ge "$MIN_FILE_SIZE" ]; then
                echo "✅ File size OK (≥${MIN_FILE_SIZE} bytes)"
            else
                echo "⚠️  File size below threshold (${MIN_FILE_SIZE} bytes)"
            fi

            if [ "$words" -ge "$MIN_WORD_COUNT" ]; then
                echo "✅ Word count OK (≥${MIN_WORD_COUNT} words)"
            else
                echo "⚠️  Word count below threshold (${MIN_WORD_COUNT} words)"
            fi

            # 必需章节检查
            if grep -q "## 故事节奏分析" "$TASK_OUTPUT" 2>/dev/null; then
                echo "✅ Has required sections"
            fi

            success=true
            break
        fi

        # 进度指示
        if [ $((checks % 3)) -eq 0 ]; then
            echo "⏳ Still waiting... ($((checks * CHECK_INTERVAL))s elapsed)"

            # 检查Gateway活动
            local gateway_log=$(get_gateway_log)
            if [ -f "$gateway_log" ]; then
                local recent_runs=$(tail -5 "$gateway_log" 2>/dev/null | grep -c "agent" || echo "0")
                echo "   Recent activity: $recent_runs runs"
            fi
        fi

        # 检查进程状态
        if ! ps -p $AGENT_PID > /dev/null 2>&1; then
            echo "⚠️  Agent process completed but no report found"
            break
        fi
    done

    return $([ "$success" == "true" ] && echo 0 || echo 1)
}

# 诊断失败原因
diagnose_failure() {
    echo "🔍 Diagnosing failure..."
    echo ""

    # 检查session文件
    local session_file=$(get_latest_session)
    if [ -n "$session_file" ] && [ -f "$session_file" ]; then
        echo "📋 Session file: $session_file"
        echo ""

        # 检查最近的助手消息
        echo "Recent assistant messages:"
        tail -20 "$session_file" | \
            jq -r 'select(.message.role == "assistant") | .message.content[0].text // .message.content[0].thinking // "no content"' | \
            head -c 500
        echo ""
        echo ""

        # 检查工具调用
        echo "Recent tool calls:"
        tail -30 "$session_file" | \
            jq -r 'select(.message.toolName != null) | "\(.timestamp) - \(.message.toolName)"' | \
            tail -5
        echo ""

        # 检查工具结果
        echo "Tool results:"
        tail -30 "$session_file" | \
            jq -r 'select(.message.role == "toolResult") | {tool: .message.toolName, status: .message.details.status, error: .message.details.error}' | \
            tail -3
        echo ""

        # 检查Gate blocks
        echo "Checking for Gate blocks..."
        local gate_blocks=$(tail -50 "$session_file" | jq -r 'select(.message.details.error != null) | .message.details.error' | grep -c "PRINCIPLES_GATE" || echo "0")
        if [ "$gate_blocks" -gt 0 ]; then
            echo "⚠️  Found $gate_blocks Gate block(s):"
            tail -50 "$session_file" | jq -r 'select(.message.details.error != null) | .message.details.error' | grep "PRINCIPLES_GATE" | tail -1
        else
            echo "✓ No Gate blocks found"
        fi
    else
        echo "⚠️  No session file found"
    fi

    # 检查Gateway错误
    local gateway_log=$(get_gateway_log)
    if [ -f "$gateway_log" ]; then
        echo ""
        echo "Recent Gateway errors:"
        tail -50 "$gateway_log" | grep -i "error" | tail -5
    fi
}

# 生成测试报告
generate_test_report() {
    local success="$1"
    local elapsed_time="$2"

    cat > "$TEST_REPORT" << EOF
# OKR Task Test Report

**Date**: $(date)
**Phase**: ${PHASE}
**Task**: ${TASK_TYPE}
**Status**: $( [ "$success" == "true" ] && echo "✅ PASSED" || echo "❌ FAILED" )
**Elapsed Time**: ${elapsed_time}s

## Configuration

| Parameter | Value |
|-----------|-------|
| Agent ID | $AGENT_ID |
| Model | $DEFAULT_MODEL |
| Trust Score | $(get_trust_score) |
| Trust Stage | $(get_trust_stage) |
| Test Timeout | ${TEST_TIMEOUT}s |
| Check Interval | ${CHECK_INTERVAL}s |

## Results

### Output File
- **Path**: \`$TASK_OUTPUT\`
- **Status**: $( [ -f "$TASK_OUTPUT" ] && echo "✅ Generated" || echo "❌ Not found" )

$(if [ -f "$TASK_OUTPUT" ]; then
    local quality=$(check_file_quality "$TASK_OUTPUT")
    echo ""
    echo "### Quality Metrics"
    echo ""
    echo "| Metric | Value | Threshold | Status |"
    echo "|--------|-------|-----------|--------|"
    echo "| Size | $(echo "$quality" | jq -r '.size') bytes | ${MIN_FILE_SIZE} | $( [ $(echo "$quality" | jq -r '.size') -ge $MIN_FILE_SIZE ] && echo "✅" || echo "⚠️" ) |"
    echo "| Words | $(echo "$quality" | jq -r '.words') | ${MIN_WORD_COUNT} | $( [ $(echo "$quality" | jq -r '.words') -ge $MIN_WORD_COUNT ] && echo "✅" || echo "⚠️" ) |"
    echo "| Lines | $(echo "$quality" | jq -r '.lines') | - | - |"
fi)

### Execution Timeline
- Started: $(date -d "$elapsed_time seconds ago" 2>/dev/null || date)
- Completed: $(date)
- Total Duration: ${elapsed_time}s
- Checks Performed: $((elapsed_time / CHECK_INTERVAL))

$(if [ "$success" == "false" ]; then
    echo ""
    echo "## Failure Analysis"
    echo ""
    echo "### Possible Causes"
    echo ""
    echo "- [ ] Gate block (Trust score too low)"
    echo "- [ ] API rate limit"
    echo "- [ ] Timeout (Agent too slow)"
    echo "- [ ] Task misunderstood"
    echo "- [ ] File permission issue"
    echo ""
    echo "### Recommendations"
    echo ""
    echo "1. Check session file for detailed error messages"
    echo "2. Verify trust score is ≥ 80"
    echo "3. Check Gateway logs for API errors"
    echo "4. Try increasing TEST_TIMEOUT"
fi)

---

**Generated by**: \`run-okr-test.sh\`
**Test Report**: \`$TEST_REPORT\`
EOF

    echo "📄 Test report saved to: $TEST_REPORT"
}

# ============================================================================
# 主流程
# ============================================================================

main() {
    local start_time=$(date +%s)

    print_test_info

    # 获取任务描述
    TASK=$(get_task_description)

    # 发送任务
    send_task "$TASK"

    # 监控进度
    local monitor_start=$(date +%s)
    if monitor_progress; then
        local monitor_end=$(date +%s)
        local elapsed_time=$((monitor_end - start_time))

        echo ""
        echo "================================================================"
        echo ""
        echo "📄 Task Output Preview:"
        echo "========================"
        head -100 "$TASK_OUTPUT"
        echo "..."
        echo "========================"
        echo ""
        echo "✅ TEST PASSED: Agent successfully completed OKR task!"

        # 生成报告
        generate_test_report "true" "$elapsed_time"

        exit 0
    else
        local monitor_end=$(date +%s)
        local elapsed_time=$((monitor_end - start_time))

        echo ""
        echo "================================================================"
        echo ""

        # 诊断失败
        diagnose_failure

        # 生成报告
        generate_test_report "false" "$elapsed_time"

        echo ""
        echo "❌ TEST FAILED"
        exit 1
    fi
}

# 执行主流程
main "$@"
