#!/bin/bash
# ============================================================================
# 测试结果自动保存脚本
# ============================================================================
#
# 功能：
# 1. 捕获测试执行结果
# 2. 生成结构化报告
# 3. 提交到git仓库
# 4. 创建每日归档
#
# 使用：
#   ./tests/save-test-results.sh [test_name] [status]
#
# 示例：
#   ./tests/save-test-results.sh trust-system-deep completed
#   ./tests/save-test-results.sh gatekeeper failed
#   ./tests/save-test-results.sh quick-verify partial

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
DATE=$(date +%Y-%m-%d)
ARCHIVE_DIR="$SCRIPT_DIR/archive/reports-$DATE"
SESSION_DIR="$SCRIPT_DIR/archive/session-$DATE"

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# ============================================================================
# 主要功能
# ============================================================================

save_test_results() {
    local TEST_NAME="$1"
    local STATUS="$2"
    local REPORT_DIR="$ARCHIVE_DIR/$TEST_NAME-$TIMESTAMP"

    # 创建报告目录
    mkdir -p "$REPORT_DIR"
    mkdir -p "$SESSION_DIR"

    log_info "╔════════════════════════════════════════════════════════════╗"
    log_info "║         保存测试结果 - $TEST_NAME                             ║"
    log_info "╚════════════════════════════════════════════════════════════╝"
    log_info ""
    log_info "测试名称: $TEST_NAME"
    log_info "执行状态: $STATUS"
    log_info "时间戳: $TIMESTAMP"
    log_info "归档目录: $REPORT_DIR"
    log_info ""

    # 1. 收集测试报告
    log_info "📸 收集测试报告..."

    # 复制最新测试报告
    if [ -d "$SCRIPT_DIR/reports/feature-testing" ]; then
        local LATEST_REPORT=$(ls -t "$SCRIPT_DIR/reports/feature-testing" | head -1)
        if [ -n "$LATEST_REPORT" ]; then
            cp -r "$SCRIPT_DIR/reports/feature-testing/$LATEST_REPORT" "$REPORT_DIR/"
            log_info "  ✅ 复制最新测试报告: $LATEST_REPORT"
        fi
    fi

    # 2. 收集测试日志
    log_info "📋 收集测试日志..."
    if [ -f "/tmp/trust-deep-test.log" ]; then
        cp "/tmp/trust-deep-test.log" "$REPORT_DIR/test-execution.log"
        log_info "  ✅ 复制测试执行日志"
    fi

    # 3. 收集scorecard快照
    log_info "💾 收集系统状态..."
    if [ -f "/home/csuzngjh/clawd/.state/AGENT_SCORECARD.json" ]; then
        mkdir -p "$REPORT_DIR/system-state"
        cp "/home/csuzngjh/clawd/.state/AGENT_SCORECARD.json" "$REPORT_DIR/system-state/scorecard.json"
        log_info "  ✅ 保存scorecard快照"
    fi

    # 4. 生成测试摘要
    log_info "📊 生成测试摘要..."
    cat > "$REPORT_DIR/SUMMARY.md" << EOF
# 测试执行摘要

> **测试名称**: $TEST_NAME
> **执行时间**: $(date '+%Y-%m-%d %H:%M:%S UTC')
> **状态**: $STATUS
> **归档位置**: $REPORT_DIR

---

## 执行结果

### 系统环境
- **Gateway**: $(ps aux | grep openclaw-gateway | grep -v grep | wc -l) 进程运行中
- **Trust Score**: $(cat /home/csuzngjh/clawd/.state/AGENT_SCORECARD.json | jq -r '.trust_score // "N/A"')
- **Grace Remaining**: $(cat /home/csuzngjh/clawd/.state/AGENT_SCORECARD.json | jq -r '.grace_failures_remaining // "N/A"')

### 测试报告
- 执行日志: \`test-execution.log\`
- 详细报告: 参见原始报告目录

### 系统状态
- Scorecard快照: \`system-state/scorecard.json\`

---

## 文件清单

\`\`\`
$(find "$REPORT_DIR" -type f | sed 's|^'$REPORT_DIR'/||' | sort)
\`\`\`

---

**归档时间**: $(date -Iseconds)
**归档工具**: save-test-results.sh
EOF
    log_info "  ✅ 生成测试摘要: SUMMARY.md"

    # 5. 更新每日索引
    log_info "📝 更新每日索引..."
    update_daily_index "$DATE" "$TEST_NAME" "$TIMESTAMP" "$STATUS"

    # 6. 生成统计信息
    log_info "📈 生成统计信息..."
    generate_statistics "$DATE"

    # 7. 提交到git（如果指定）
    if [ "$AUTO_COMMIT" == "true" ]; then
        commit_results "$TEST_NAME" "$TIMESTAMP" "$STATUS"
    fi

    log_info ""
    log_info "✅ 测试结果已保存"
    log_info "   📁 归档: $REPORT_DIR"
    log_info "   📄 摘要: $REPORT_DIR/SUMMARY.md"
    log_info ""
}

update_daily_index() {
    local DATE="$1"
    local TEST_NAME="$2"
    local TIMESTAMP="$3"
    local STATUS="$4"
    local INDEX_FILE="$SESSION_DIR/daily-index-$DATE.md"

    if [ ! -f "$INDEX_FILE" ]; then
        cat > "$INDEX_FILE" << EOF
# 测试会话索引 - $DATE

> **创建时间**: $(date -Iseconds)
> **会话目录**: $SESSION_DIR

---

## 测试执行历史

| 时间 | 测试名称 | 状态 | 归档 |
|------|----------|------|------|
EOF
    fi

    echo "| $(date +%H:%M:%S) | [$TEST_NAME](../reports-$DATE/$TEST_NAME-$TIMESTAMP/SUMMARY.md) | $STATUS | [查看](../reports-$DATE/$TEST_NAME-$TIMESTAMP/) |" >> "$INDEX_FILE"
}

generate_statistics() {
    local DATE="$1"
    local STATS_FILE="$SESSION_DIR/statistics-$DATE.md"

    # 统计今日测试数量
    local TOTAL_TESTS=$(find "$ARCHIVE_DIR" -type d -name "*-*" 2>/dev/null | wc -l)
    local PASSED_TESTS=$(find "$ARCHIVE_DIR" -name "SUMMARY.md" -exec grep -l "状态:.*completed\|状态:.*通过" {} \; 2>/dev/null | wc -l)
    local FAILED_TESTS=$(find "$ARCHIVE_DIR" -name "SUMMARY.md" -exec grep -l "状态:.*failed\|状态:.*失败" {} \; 2>/dev/null | wc -l)

    cat > "$STATS_FILE" << EOF
# 测试统计 - $DATE

> **更新时间**: $(date -Iseconds)

---

## 总体统计

- **总测试数**: $TOTAL_TESTS
- **通过**: $PASSED_TESTS
- **失败**: $FAILED_TESTS
- **成功率**: $(awk "BEGIN {printf \"%.1f%%\", ($PASSED_TESTS/$TOTAL_TESTS)*100}" <<< "")

## 测试列表

$(find "$ARCHIVE_DIR" -name "SUMMARY.md" -exec echo "- {}" \; | sed 's|'$ARCHIVE_DIR'/||' | sort)

---

**生成时间**: $(date -Iseconds)
EOF
}

commit_results() {
    local TEST_NAME="$1"
    local TIMESTAMP="$2"
    local STATUS="$3"

    cd "$PROJECT_ROOT"

    git add tests/archive/
    git add tests/reports/

    git commit -m "test: Save test results - $TEST_NAME ($STATUS)

Test: $TEST_NAME
Time: $(date -Iseconds)
Status: $STATUS
Archive: tests/archive/reports-$(date +%Y-%m-%d)/$TEST_NAME-$TIMESTAMP/

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>" > /dev/null 2>&1

    if [ $? -eq 0 ]; then
        log_info "  ✅ 已提交到git"
    else
        log_warn "  ⚠️  Git提交失败（可能没有变更）"
    fi
}

# ============================================================================
# 主流程
# ============================================================================

show_usage() {
    cat << EOF
用法:
  $0 [test_name] [status] [options]

参数:
  test_name    测试名称（如：trust-system-deep, gatekeeper）
  status       测试状态（completed, failed, partial）

选项:
  -c, --commit  自动提交到git
  -h, --help    显示帮助信息

示例:
  # 保存测试结果
  $0 trust-system-deep completed

  # 保存并提交
  $0 gatekeeper failed --commit

  # 快速保存当前所有结果
  $0 all-$(date +%H%M) partial --commit
EOF
}

main() {
    if [ $# -lt 2 ]; then
        show_usage
        exit 1
    fi

    local TEST_NAME="$1"
    local STATUS="$2"
    shift 2

    # 解析选项
    AUTO_COMMIT="false"
    while [ $# -gt 0 ]; do
        case "$1" in
            -c|--commit)
                AUTO_COMMIT="true"
                ;;
            -h|--help)
                show_usage
                exit 0
                ;;
            *)
                log_error "未知选项: $1"
                show_usage
                exit 1
                ;;
        esac
        shift
    done

    # 执行保存
    save_test_results "$TEST_NAME" "$STATUS"
}

# 如果直接执行脚本
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    main "$@"
fi
