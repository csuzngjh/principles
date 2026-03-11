#!/bin/bash
# ============================================================================
# 报告质量评分脚本
# ============================================================================
# 用途：自动评分Agent生成的报告质量
# ============================================================================

set -e

# 加载测试环境配置
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config/test-env.sh"

# 参数
REPORT_FILE="$1"

if [ -z "$REPORT_FILE" ]; then
    echo "Usage: $0 <report_file>"
    exit 1
fi

if [ ! -f "$REPORT_FILE" ]; then
    echo "❌ Error: File not found: $REPORT_FILE"
    exit 1
fi

# ============================================================================
# 评分标准
# ============================================================================

# 1. 文件大小评分 (0-25分)
score_size() {
    local size=$(wc -c < "$REPORT_FILE" 2>/dev/null || echo "0")

    if [ "$size" -ge 20480 ]; then        # ≥20KB
        echo "25"
    elif [ "$size" -ge 10240 ]; then       # ≥10KB
        echo "20"
    elif [ "$size" -ge 5120 ]; then        # ≥5KB
        echo "15"
    elif [ "$size" -ge 2048 ]; then        # ≥2KB
        echo "10"
    elif [ "$size" -ge 1024 ]; then        # ≥1KB
        echo "5"
    else
        echo "0"
    fi
}

# 2. 字数评分 (0-25分)
score_words() {
    local words=$(wc -w < "$REPORT_FILE" 2>/dev/null || echo "0")

    if [ "$words" -ge 1500 ]; then        # ≥1500词
        echo "25"
    elif [ "$words" -ge 1000 ]; then       # ≥1000词
        echo "20"
    elif [ "$words" -ge 500 ]; then        # ≥500词
        echo "15"
    elif [ "$words" -ge 250 ]; then        # ≥250词
        echo "10"
    elif [ "$words" -ge 100 ]; then        # ≥100词
        echo "5"
    else
        echo "0"
    fi
}

# 3. 必需章节评分 (0-25分)
score_sections() {
    local score=0

    # 检查关键章节标题
    if grep -q "## 故事节奏分析" "$REPORT_FILE" 2>/dev/null; then
        score=$((score + 8))
    fi
    if grep -q "## 情节连贯性" "$REPORT_FILE" 2>/dev/null; then
        score=$((score + 8))
    fi
    if grep -q "## 发现的问题" "$REPORT_FILE" 2>/dev/null; then
        score=$((score + 5))
    fi
    if grep -q "## 评分" "$REPORT_FILE" 2>/dev/null; then
        score=$((score + 4))
    fi

    echo "$score"
}

# 4. 深度分析评分 (0-25分)
score_depth() {
    local score=0

    # 检查具体行号引用（表示实际阅读了原文）
    local line_refs=$(grep -o "第 [0-9]\+ 行" "$REPORT_FILE" 2>/dev/null | wc -l)
    if [ "$line_refs" -ge 10 ]; then
        score=$((score + 10))
    elif [ "$line_refs" -ge 5 ]; then
        score=$((score + 7))
    elif [ "$line_refs" -ge 1 ]; then
        score=$((score + 5))
    fi

    # 检查问题发现（P0, P1, P2标记）
    if grep -q "P0\|P1\|P2" "$REPORT_FILE" 2>/dev/null; then
        score=$((score + 8))
    fi

    # 检查具体建议（非泛泛而谈）
    local suggestions=$(grep -c "建议\|改进" "$REPORT_FILE" 2>/dev/null || echo "0")
    if [ "$suggestions" -ge 5 ]; then
        score=$((score + 7))
    elif [ "$suggestions" -ge 2 ]; then
        score=$((score + 5))
    fi

    echo "$score"
}

# ============================================================================
# 主评分流程
# ============================================================================

main() {
    echo "╔════════════════════════════════════════════════════════════╗"
    echo "║              Report Quality Assessment                    ║"
    echo "╚════════════════════════════════════════════════════════════╝"
    echo ""
    echo "Report: $REPORT_FILE"
    echo "Date: $(date)"
    echo ""

    # 基础统计
    local size=$(wc -c < "$REPORT_FILE")
    local words=$(wc -w < "$REPORT_FILE")
    local lines=$(wc -l < "$REPORT_FILE")
    local chars=$(wc -m < "$REPORT_FILE")

    echo "📊 Basic Statistics:"
    echo "  Size:   $size bytes"
    echo "  Words:  $words"
    echo "  Lines:  $lines"
    echo "  Chars:  $chars"
    echo ""

    # 评分
    local size_score=$(score_size)
    local words_score=$(score_words)
    local sections_score=$(score_sections)
    local depth_score=$(score_depth)
    local total_score=$((size_score + words_score + sections_score + depth_score))

    echo "📈 Scoring Breakdown:"
    echo "  1. File Size:     $size_score/25"
    echo "  2. Word Count:    $words_score/25"
    echo "  3. Sections:      $sections_score/25"
    echo "  4. Analysis Depth: $depth_score/25"
    echo "  ─────────────────────────────"
    echo "  Total Score:     $total_score/100"
    echo ""

    # 等级评定
    local grade=""
    local status=""

    if [ "$total_score" -ge 90 ]; then
        grade="A+"
        status="✅ Excellent"
    elif [ "$total_score" -ge 80 ]; then
        grade="A"
        status="✅ Very Good"
    elif [ "$total_score" -ge 70 ]; then
        grade="B"
        status="✅ Good"
    elif [ "$total_score" -ge 60 ]; then
        grade="C"
        status="⚠️  Acceptable"
    elif [ "$total_score" -ge 50 ]; then
        grade="D"
        status="⚠️  Needs Improvement"
    else
        grade="F"
        status="❌ Poor"
    fi

    echo "🎯 Grade: $grade"
    echo "📋 Status: $status"
    echo ""

    # 详细建议
    if [ "$total_score" -lt 60 ]; then
        echo "💡 Recommendations:"
        echo ""

        if [ "$size_score" -lt 15 ]; then
            echo "  - Report is too short. Consider adding more detailed analysis."
        fi

        if [ "$sections_score" -lt 15 ]; then
            echo "  - Missing required sections. Ensure all sections are present."
        fi

        if [ "$depth_score" -lt 15 ]; then
            echo "  - Analysis lacks depth. Add specific line references and actionable recommendations."
        fi

        echo ""
    fi

    # 生成JSON输出（用于自动化）
    local json_output="{
  \"file\": \"$REPORT_FILE\",
  \"timestamp\": \"$(date -Iseconds)\",
  \"statistics\": {
    \"size_bytes\": $size,
    \"word_count\": $words,
    \"line_count\": $lines,
    \"char_count\": $chars
  },
  \"scores\": {
    \"size\": $size_score,
    \"words\": $words_score,
    \"sections\": $sections_score,
    \"depth\": $depth_score,
    \"total\": $total_score
  },
  \"grade\": \"$grade\",
  \"status\": \"$status\"
}"

    # 保存JSON
    local json_file="$TEST_REPORTS_DIR/quality-score-$(basename "$REPORT_FILE" .md).json"
    mkdir -p "$TEST_REPORTS_DIR"
    echo "$json_output" | jq '.' > "$json_file"
    echo "📄 JSON report saved to: $json_file"
    echo ""

    # 返回值
    if [ "$total_score" -ge "$MIN_QUALITY_SCORE" ]; then
        exit 0
    else
        exit 1
    fi
}

main "$@"
