#!/bin/bash
# ============================================================================
# 通用特性测试框架
# ============================================================================
# 用途：针对Principles Disciple插件的各项功能进行端到端测试
# 特点：场景驱动、自动化验证、详细报告、支持断点检测
# ============================================================================

set -e

# ============================================================================
# 配置和初始化
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "/home/csuzngjh/code/principles/tests/config/test-env.sh"

# 参数
FEATURE_NAME="$1"          # 特性名称（如：trust-system, gatekeeper, thinking-os）
SCENARIO_FILE="$2"         # 场景文件路径（可选，默认从test-scenarios/加载）
VERBOSE="${VERBOSE:-false}"

# 输出目录
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
TEST_OUTPUT_DIR="$TEST_REPORTS_DIR/feature-testing/$FEATURE_NAME-$TIMESTAMP"
mkdir -p "$TEST_OUTPUT_DIR"

# 日志文件
TEST_LOG="$TEST_OUTPUT_DIR/test.log"
EXECUTION_LOG="$TEST_OUTPUT_DIR/execution.jsonl"

# ============================================================================
# 工具函数
# ============================================================================

log() {
    local level="$1"
    shift
    local message="$@"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] [$level] $message" | tee -a "$TEST_LOG"
}

log_info() { log "INFO" "$@"; }
log_success() { log "SUCCESS" "$@"; }
log_warning() { log "WARNING" "$@"; }
log_error() { log "ERROR" "$@"; }
log_debug() { [ "$VERBOSE" == "true" ] && log "DEBUG" "$@"; }

# 记录执行事件
record_event() {
    local event_type="$1"
    shift
    local data="$@"
    echo "{\"timestamp\":\"$(date -Iseconds)\",\"type\":\"$event_type\",\"data\":$data}" >> "$EXECUTION_LOG"
}

# ============================================================================
# 场景加载和解析
# ============================================================================

load_scenario() {
    local scenario_file="$1"

    if [ -z "$scenario_file" ]; then
        # 使用默认场景文件
        scenario_file="$SCRIPT_DIR/test-scenarios/$FEATURE_NAME.json"
    fi

    if [ ! -f "$scenario_file" ]; then
        log_error "Scenario file not found: $scenario_file"
        exit 1
    fi

    # Redirect to stderr to avoid capture in command substitution
    >&2 echo "[$(date '+%Y-%m-%d %H:%M:%S')] [INFO] Loading scenario from: $scenario_file"

    # 验证JSON格式
    if ! jq empty "$scenario_file" 2>/dev/null; then
        log_error "Invalid JSON in scenario file"
        exit 1
    fi

    cat "$scenario_file"
}

# 解析场景配置
parse_scenario() {
    local scenario="$1"
    local field="$2"

    echo "$scenario" | jq -r ".$field // empty"
}

# 获取最新的agent session文件
get_latest_session() {
    if [ ! -d "$SESSION_DIR" ]; then
        return 1
    fi

    # Find the most recently modified session file
    local latest_session=$(find "$SESSION_DIR" -name "*.json" -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)

    if [ -z "$latest_session" ]; then
        return 1
    fi

    echo "$latest_session"
}

# ============================================================================
# 任务执行
# ============================================================================

# 执行单个测试步骤
execute_step() {
    local step="$1"
    local step_num="$2"
    local total_steps="$3"

    local step_name=$(echo "$step" | jq -r '.name // "Unnamed step"')
    local step_type=$(echo "$step" | jq -r '.type // "task"')
    local step_desc=$(echo "$step" | jq -r '.description // ""')

    log_info ""
    log_info "━━━ Step $step_num/$total_steps: $step_name ━━━"
    log_info "Type: $step_type"
    [ -n "$step_desc" ] && log_info "Description: $step_desc"

    record_event "step_start" "{\"step\":$step_num,\"name\":\"$step_name\",\"type\":\"$step_type\"}"

    case "$step_type" in
        task)
            execute_task_step "$step"
            ;;
        validation)
            execute_validation_step "$step"
            ;;
        cleanup)
            execute_cleanup_step "$step"
            ;;
        wait)
            execute_wait_step "$step"
            ;;
        *)
            log_error "Unknown step type: $step_type"
            return 1
            ;;
    esac

    local result=$?
    if [ $result -eq 0 ]; then
        log_success "✓ Step completed: $step_name"
        record_event "step_complete" "{\"step\":$step_num,\"name\":\"$step_name\"}"
    else
        log_error "✗ Step failed: $step_name"
        record_event "step_failed" "{\"step\":$step_num,\"name\":\"$step_name\",\"error_code\":$result}"
    fi

    return $result
}

# 执行任务步骤（发送消息给Agent）
execute_task_step() {
    local step="$1"

    local task_prompt=$(echo "$step" | jq -r '.task')
    local expected_outcomes=$(echo "$step" | jq -r '.expected_outcomes // []')
    local step_timeout=$(echo "$step" | jq -r '.timeout // "empty"')
    local timeout="${step_timeout:-$TEST_TIMEOUT}"
    local wait_for_completion=$(echo "$step" | jq -r '.wait_for_completion // true')

    log_info "Task prompt: $(echo "$task_prompt" | head -c 100)..."

    # 发送任务
    log_info "Sending task to agent..."

    timeout "$timeout" openclaw agent --agent "$AGENT_ID" --message "$task_prompt" >/dev/null 2>&1 &
    local agent_pid=$!

    record_event "task_sent" "{\"pid\":$agent_pid,\"timeout\":$timeout}"

    if [ "$wait_for_completion" == "true" ]; then
        # 等待完成
        wait_for_completion "$step" "$agent_pid" "$timeout"
    else
        # 异步执行，不等待
        log_info "Task sent asynchronously (PID: $agent_pid)"
        sleep 2  # 给Agent一点时间启动
    fi
}

# 等待任务完成并验证预期结果
wait_for_completion() {
    local step="$1"
    local agent_pid="$2"
    local timeout="$3"

    local checks=0
    local max_checks=$((timeout / CHECK_INTERVAL))

    log_info "Waiting for completion (checking every ${CHECK_INTERVAL}s)..."

    while [ $checks -lt $max_checks ]; do
        sleep "$CHECK_INTERVAL"
        checks=$((checks + 1))

        # 检查预期结果
        local expected_outcomes=$(echo "$step" | jq -r '.expected_outcomes // []')
        local all_satisfied=true

        if [ "$(echo "$expected_outcomes" | jq 'length')" -gt 0 ]; then
            for outcome in $(echo "$expected_outcomes" | jq -r '.[] | @base64'); do
                if ! check_outcome "$outcome"; then
                    all_satisfied=false
                    break
                fi
            done
        else
            # 没有预期结果，检查进程是否结束
            if ! ps -p $agent_pid > /dev/null 2>&1; then
                log_info "Agent process completed"
                break
            fi
        fi

        if [ "$all_satisfied" == "true" ]; then
            log_success "All expected outcomes satisfied"
            break
        fi

        # 进度指示
        if [ $((checks % 3)) -eq 0 ]; then
            log_debug "Still waiting... ($((checks * CHECK_INTERVAL))s elapsed)"
        fi
    done

    # 检查超时
    if ps -p $agent_pid > /dev/null 2>&1; then
        log_warning "Agent still running after timeout, killing process..."
        kill $agent_pid 2>/dev/null || true
        return 1
    fi

    return 0
}

# 检查单个预期结果
check_outcome() {
    local outcome_b64="$1"
    local outcome=$(echo "$outcome_b64" | base64 -d 2>/dev/null || echo "$outcome_b64")

    local type=$(echo "$outcome" | jq -r '.type')
    local condition=$(echo "$outcome" | jq -r '.condition // ""')

    case "$type" in
        file_exists)
            local path=$(echo "$outcome" | jq -r '.path')
            if [ -f "$path" ]; then
                log_debug "✓ File exists: $path"
                return 0
            else
                log_debug "✗ File not found: $path"
                return 1
            fi
            ;;
        file_contains)
            local path=$(echo "$outcome" | jq -r '.path')
            local content=$(echo "$outcome" | jq -r '.content')
            if grep -q "$content" "$path" 2>/dev/null; then
                log_debug "✓ File contains expected content: $path"
                return 0
            else
                log_debug "✗ File missing expected content: $path"
                return 1
            fi
            ;;
        trust_score)
            local operator=$(echo "$outcome" | jq -r '.operator // ">="')
            local value=$(echo "$outcome" | jq -r '.value')
            local current=$(get_trust_score)

            if [ "$current" "$operator" "$value" ]; then
                log_debug "✓ Trust score $current $operator $value"
                return 0
            else
                log_debug "✗ Trust score $current NOT $operator $value"
                return 1
            fi
            ;;
        event_logged)
            local event_type=$(echo "$outcome" | jq -r '.event_type')
            if grep -q "\"event_type\":\"$event_type\"" "$EVENT_LOG_PATH" 2>/dev/null; then
                log_debug "✓ Event logged: $event_type"
                return 0
            else
                log_debug "✗ Event not logged: $event_type"
                return 1
            fi
            ;;
        *)
            log_warning "Unknown outcome type: $type"
            return 1
            ;;
    esac
}

# 执行验证步骤
execute_validation_step() {
    local step="$1"

    local validator=$(echo "$step" | jq -r '.validator')
    local params=$(echo "$step" | jq -r '.params // {}')

    log_info "Running validator: $validator"

    case "$validator" in
        file_validator)
            validate_file "$params"
            ;;
        trust_validator)
            validate_trust "$params"
            ;;
        gate_validator)
            validate_gate "$params"
            ;;
        custom_validator)
            validate_custom "$params"
            ;;
        *)
            log_error "Unknown validator: $validator"
            return 1
            ;;
    esac
}

# 文件验证器
validate_file() {
# 自定义验证器 - 深度测试专用
validate_custom() {
    local params="$1"
    local validation_type=$(echo "$params" | jq -r '.validation_type')

    log_info "Running custom validator: $validation_type"

    case "$validation_type" in
        cold_start_initialization)
            local expected_score=$(echo "$params" | jq -r '.expected_score')
            local expected_grace=$(echo "$params" | jq -r '.expected_grace')
            local scorecard_path="$WORKSPACE_DIR/docs/AGENT_SCORECARD.json"

            if [ ! -f "$scorecard_path" ]; then
                log_error "Scorecard not found"
                return 1
            fi

            local actual_score=$(cat "$scorecard_path" | jq -r '.trust_score')
            local actual_grace=$(cat "$scorecard_path" | jq -r '.grace_failures_remaining // 0')
            local has_cold_end=$(cat "$scorecard_path" | jq -r '.cold_start_end // ""')

            if [ "$actual_score" != "$expected_score" ]; then
                log_error "Score mismatch: expected $expected_score, got $actual_score"
                return 1
            fi

            if [ "$actual_grace" != "$expected_grace" ]; then
                log_error "Grace mismatch: expected $expected_grace, got $actual_grace"
                return 1
            fi

            if [ -z "$has_cold_end" ]; then
                log_error "Missing cold_start_end timestamp"
                return 1
            fi

            log_success "✓ Cold start initialization verified"
            log_info "  Score: $actual_score, Grace: $actual_grace"
            return 0
            ;;

        grace_verification)
            local expected_grace=$(echo "$params" | jq -r '.expected_grace_remaining')
            local expected_score=$(echo "$params" | jq -r '.expected_score')
            local score_should_change=$(echo "$params" | jq -r '.score_should_change // "true"')

            local scorecard_path="$WORKSPACE_DIR/docs/AGENT_SCORECARD.json"
            local actual_grace=$(cat "$scorecard_path" | jq -r '.grace_failures_remaining // 0')
            local actual_score=$(cat "$scorecard_path" | jq -r '.trust_score')

            if [ "$actual_grace" != "$expected_grace" ]; then
                log_error "Grace remaining mismatch: expected $expected_grace, got $actual_grace"
                return 1
            fi

            if [ "$score_should_change" == "false" ]; then
                if [ "$actual_score" != "$expected_score" ]; then
                    log_error "Score should not change but did: expected $expected_score, got $actual_score"
                    return 1
                fi
            fi

            log_success "✓ Grace verification passed"
            log_info "  Grace: $actual_grace, Score: $actual_score"
            return 0
            ;;

        penalty_verification)
            local expected_score=$(echo "$params" | jq -r '.expected_score')
            local expected_delta=$(echo "$params" | jq -r '.expected_delta')
            local failure_type=$(echo "$params" | jq -r '.failure_type // ""')

            local scorecard_path="$WORKSPACE_DIR/docs/AGENT_SCORECARD.json"
            local actual_score=$(cat "$scorecard_path" | jq -r '.trust_score')

            # 计算实际delta（从history中查找最近的penalty）
            local last_delta=$(cat "$scorecard_path" | jq -r '.history[-1].delta // "0"')

            if [ "$actual_score" != "$expected_score" ]; then
                log_error "Score mismatch after penalty: expected $expected_score, got $actual_score"
                return 1
            fi

            if [ "$last_delta" != "$expected_delta" ]; then
                log_error "Penalty delta mismatch: expected $expected_delta, got $last_delta"
                return 1
            fi

            log_success "✓ Penalty verified"
            log_info "  Score: $actual_score, Delta: $last_delta, Type: $failure_type"
            return 0
            ;;

        streak_bonus_verification)
            local expected_streak=$(echo "$params" | jq -r '.expected_streak')
            local expected_stage=$(echo "$params" | jq -r '.expected_stage')
            local min_score=$(echo "$params" | jq -r '.min_expected_score')

            local scorecard_path="$WORKSPACE_DIR/docs/AGENT_SCORECARD.json"
            local actual_streak=$(cat "$scorecard_path" | jq -r '.success_streak // 0')
            local actual_score=$(cat "$scorecard_path" | jq -r '.trust_score')

            # 计算Stage
            local actual_stage=1
            if [ "$actual_score" -ge 80 ]; then
                actual_stage=4
            elif [ "$actual_score" -ge 60 ]; then
                actual_stage=3
            elif [ "$actual_score" -ge 30 ]; then
                actual_stage=2
            fi

            if [ "$actual_streak" -lt "$expected_streak" ]; then
                log_error "Streak too short: expected ≥$expected_streak, got $actual_streak"
                return 1
            fi

            if [ "$actual_stage" != "$expected_stage" ]; then
                log_error "Stage mismatch: expected $expected_stage, got $actual_stage"
                return 1
            fi

            if [ "$actual_score" -lt "$min_score" ]; then
                log_error "Score too low: expected ≥$min_score, got $actual_score"
                return 1
            fi

            log_success "✓ Streak bonus verified"
            log_info "  Streak: $actual_streak, Stage: $actual_stage, Score: $actual_score"
            return 0
            ;;

        boundary_verification)
            local min_score=$(echo "$params" | jq -r '.min_score // -1')
            local max_score=$(echo "$params" | jq -r '.max_score // -1')
            local capped=$(echo "$params" | jq -r '.capped // false')

            local scorecard_path="$WORKSPACE_DIR/docs/AGENT_SCORECARD.json"
            local actual_score=$(cat "$scorecard_path" | jq -r '.trust_score')

            if [ "$min_score" != "-1" ]; then
                if [ "$actual_score" -lt "$min_score" ]; then
                    log_error "Score below minimum: expected ≥$min_score, got $actual_score"
                    return 1
                fi
            fi

            if [ "$max_score" != "-1" ]; then
                if [ "$actual_score" -gt "$max_score" ]; then
                    if [ "$capped" == "true" ]; then
                        log_success "✓ Score correctly capped at maximum ($max_score)"
                    else
                        log_error "Score exceeds maximum: expected ≤$max_score, got $actual_score"
                        return 1
                    fi
                fi
            fi

            log_success "✓ Boundary verification passed"
            log_info "  Score: $actual_score (within bounds)"
            return 0
            ;;

        stage_verification)
            local expected_stage=$(echo "$params" | jq -r '.expected_stage')
            local expected_score=$(echo "$params" | jq -r '.expected_score')

            local scorecard_path="$WORKSPACE_DIR/docs/AGENT_SCORECARD.json"
            local actual_score=$(cat "$scorecard_path" | jq -r '.trust_score')

            # Determine actual stage from score
            local actual_stage=1
            if [ "$actual_score" -ge 80 ]; then
                actual_stage=4
            elif [ "$actual_score" -ge 60 ]; then
                actual_stage=3
            elif [ "$actual_score" -ge 30 ]; then
                actual_stage=2
            fi

            if [ "$actual_score" != "$expected_score" ]; then
                log_error "Score mismatch for stage: expected $expected_score, got $actual_score"
                return 1
            fi

            if [ "$actual_stage" != "$expected_stage" ]; then
                log_error "Stage mismatch: expected Stage $expected_stage, got Stage $actual_stage (score: $actual_score)"
                return 1
            fi

            log_success "✓ Stage verification passed"
            log_info "  Stage: $actual_stage, Score: $actual_score"
            return 0
            ;;

        *)
            log_error "Unknown custom validation type: $validation_type"
            return 1
            ;;
    esac
}

    local params="$1"

    local path=$(echo "$params" | jq -r '.path')
    local min_size=$(echo "$params" | jq -r '.min_size // 0')
    local required_sections=$(echo "$params" | jq -r '.required_sections // []')

    log_info "Validating file: $path"

    if [ ! -f "$path" ]; then
        log_error "File not found: $path"
        return 1
    fi

    local size=$(wc -c < "$path")
    if [ "$size" -lt "$min_size" ]; then
        log_error "File too small: $size bytes (expected ≥ $min_size)"
        return 1
    fi

    log_success "✓ File size OK: $size bytes"

    # 检查必需章节
    for section in $(echo "$required_sections" | jq -r '.[]'); do
        if grep -q "$section" "$path" 2>/dev/null; then
            log_success "✓ Section found: $section"
        else
            log_error "✗ Section missing: $section"
            return 1
        fi
    done

    return 0
}

# 自定义验证器 - 深度测试专用
validate_custom() {
    local params="$1"
    local validation_type=$(echo "$params" | jq -r '.validation_type')

    log_info "Running custom validator: $validation_type"

    case "$validation_type" in
        cold_start_initialization)
            local expected_score=$(echo "$params" | jq -r '.expected_score')
            local expected_grace=$(echo "$params" | jq -r '.expected_grace')
            local scorecard_path="$WORKSPACE_DIR/docs/AGENT_SCORECARD.json"

            if [ ! -f "$scorecard_path" ]; then
                log_error "Scorecard not found"
                return 1
            fi

            local actual_score=$(cat "$scorecard_path" | jq -r '.trust_score')
            local actual_grace=$(cat "$scorecard_path" | jq -r '.grace_failures_remaining // 0')
            local has_cold_end=$(cat "$scorecard_path" | jq -r '.cold_start_end // ""')

            if [ "$actual_score" != "$expected_score" ]; then
                log_error "Score mismatch: expected $expected_score, got $actual_score"
                return 1
            fi

            if [ "$actual_grace" != "$expected_grace" ]; then
                log_error "Grace mismatch: expected $expected_grace, got $actual_grace"
                return 1
            fi

            if [ -z "$has_cold_end" ]; then
                log_error "Missing cold_start_end timestamp"
                return 1
            fi

            log_success "✓ Cold start initialization verified"
            log_info "  Score: $actual_score, Grace: $actual_grace"
            return 0
            ;;

        grace_verification)
            local expected_grace=$(echo "$params" | jq -r '.expected_grace_remaining')
            local expected_score=$(echo "$params" | jq -r '.expected_score')
            local score_should_change=$(echo "$params" | jq -r '.score_should_change // "true"')

            local scorecard_path="$WORKSPACE_DIR/docs/AGENT_SCORECARD.json"
            local actual_grace=$(cat "$scorecard_path" | jq -r '.grace_failures_remaining // 0')
            local actual_score=$(cat "$scorecard_path" | jq -r '.trust_score')

            if [ "$actual_grace" != "$expected_grace" ]; then
                log_error "Grace remaining mismatch: expected $expected_grace, got $actual_grace"
                return 1
            fi

            if [ "$score_should_change" == "false" ]; then
                if [ "$actual_score" != "$expected_score" ]; then
                    log_error "Score should not change but did: expected $expected_score, got $actual_score"
                    return 1
                fi
            fi

            log_success "✓ Grace verification passed"
            log_info "  Grace: $actual_grace, Score: $actual_score"
            return 0
            ;;

        penalty_verification)
            local expected_score=$(echo "$params" | jq -r '.expected_score')
            local expected_delta=$(echo "$params" | jq -r '.expected_delta')
            local failure_type=$(echo "$params" | jq -r '.failure_type // ""')

            local scorecard_path="$WORKSPACE_DIR/docs/AGENT_SCORECARD.json"
            local actual_score=$(cat "$scorecard_path" | jq -r '.trust_score')

            # 计算实际delta（从history中查找最近的penalty）
            local last_delta=$(cat "$scorecard_path" | jq -r '.history[-1].delta // "0"')

            if [ "$actual_score" != "$expected_score" ]; then
                log_error "Score mismatch after penalty: expected $expected_score, got $actual_score"
                return 1
            fi

            if [ "$last_delta" != "$expected_delta" ]; then
                log_error "Penalty delta mismatch: expected $expected_delta, got $last_delta"
                return 1
            fi

            log_success "✓ Penalty verified"
            log_info "  Score: $actual_score, Delta: $last_delta, Type: $failure_type"
            return 0
            ;;

        streak_bonus_verification)
            local expected_streak=$(echo "$params" | jq -r '.expected_streak')
            local expected_stage=$(echo "$params" | jq -r '.expected_stage')
            local min_score=$(echo "$params" | jq -r '.min_expected_score')

            local scorecard_path="$WORKSPACE_DIR/docs/AGENT_SCORECARD.json"
            local actual_streak=$(cat "$scorecard_path" | jq -r '.success_streak // 0')
            local actual_score=$(cat "$scorecard_path" | jq -r '.trust_score')

            # 计算Stage
            local actual_stage=1
            if [ "$actual_score" -ge 80 ]; then
                actual_stage=4
            elif [ "$actual_score" -ge 60 ]; then
                actual_stage=3
            elif [ "$actual_score" -ge 30 ]; then
                actual_stage=2
            fi

            if [ "$actual_streak" -lt "$expected_streak" ]; then
                log_error "Streak too short: expected ≥$expected_streak, got $actual_streak"
                return 1
            fi

            if [ "$actual_stage" != "$expected_stage" ]; then
                log_error "Stage mismatch: expected $expected_stage, got $actual_stage"
                return 1
            fi

            if [ "$actual_score" -lt "$min_score" ]; then
                log_error "Score too low: expected ≥$min_score, got $actual_score"
                return 1
            fi

            log_success "✓ Streak bonus verified"
            log_info "  Streak: $actual_streak, Stage: $actual_stage, Score: $actual_score"
            return 0
            ;;

        boundary_verification)
            local min_score=$(echo "$params" | jq -r '.min_score // -1')
            local max_score=$(echo "$params" | jq -r '.max_score // -1')
            local capped=$(echo "$params" | jq -r '.capped // false')

            local scorecard_path="$WORKSPACE_DIR/docs/AGENT_SCORECARD.json"
            local actual_score=$(cat "$scorecard_path" | jq -r '.trust_score')

            if [ "$min_score" != "-1" ]; then
                if [ "$actual_score" -lt "$min_score" ]; then
                    log_error "Score below minimum: expected ≥$min_score, got $actual_score"
                    return 1
                fi
            fi

            if [ "$max_score" != "-1" ]; then
                if [ "$actual_score" -gt "$max_score" ]; then
                    if [ "$capped" == "true" ]; then
                        log_success "✓ Score correctly capped at maximum ($max_score)"
                    else
                        log_error "Score exceeds maximum: expected ≤$max_score, got $actual_score"
                        return 1
                    fi
                fi
            fi

            log_success "✓ Boundary verification passed"
            log_info "  Score: $actual_score (within bounds)"
            return 0
            ;;

        stage_verification)
            local expected_stage=$(echo "$params" | jq -r '.expected_stage')
            local expected_score=$(echo "$params" | jq -r '.expected_score')

            local scorecard_path="$WORKSPACE_DIR/docs/AGENT_SCORECARD.json"
            local actual_score=$(cat "$scorecard_path" | jq -r '.trust_score')

            # Determine actual stage from score
            local actual_stage=1
            if [ "$actual_score" -ge 80 ]; then
                actual_stage=4
            elif [ "$actual_score" -ge 60 ]; then
                actual_stage=3
            elif [ "$actual_score" -ge 30 ]; then
                actual_stage=2
            fi

            if [ "$actual_score" != "$expected_score" ]; then
                log_error "Score mismatch for stage: expected $expected_score, got $actual_score"
                return 1
            fi

            if [ "$actual_stage" != "$expected_stage" ]; then
                log_error "Stage mismatch: expected Stage $expected_stage, got Stage $actual_stage (score: $actual_score)"
                return 1
            fi

            log_success "✓ Stage verification passed"
            log_info "  Stage: $actual_stage, Score: $actual_score"
            return 0
            ;;

        *)
            log_error "Unknown custom validation type: $validation_type"
            return 1
            ;;
    esac
}

# 信任分数验证器
validate_trust() {
    local params="$1"

    local min_score=$(echo "$params" | jq -r '.min_score // 0')
    local max_score=$(echo "$params" | jq -r '.max_score // 100')
    local expected_stage=$(echo "$params" | jq -r '.expected_stage // ""')

    local current_score=$(get_trust_score)
    local current_stage=$(get_trust_stage)

    log_info "Validating trust score: $current_score"

    if [ "$current_score" -lt "$min_score" ]; then
        log_error "Trust score too low: $current_score < $min_score"
        return 1
    fi

    if [ "$current_score" -gt "$max_score" ]; then
        log_error "Trust score too high: $current_score > $max_score"
        return 1
    fi

    log_success "✓ Trust score in range: [$min_score, $max_score]"

    if [ -n "$expected_stage" ]; then
        if [[ "$current_stage" == *"$expected_stage"* ]]; then
            log_success "✓ Stage matches: $current_stage"
        else
            log_warning "Stage mismatch: expected '$expected_stage', got '$current_stage'"
        fi
    fi

    return 0
}

# Gate验证器
validate_gate() {
    local params="$1"

    local should_block=$(echo "$params" | jq -r '.should_block // false')
    local operation=$(echo "$params" | jq -r '.operation // "write"')

    log_info "Validating gate behavior (should_block=$should_block)"

    # 检查最近的Gate事件
    local session_file=$(get_latest_session)
    if [ -z "$session_file" ] || [ ! -f "$session_file" ]; then
        log_warning "No session file found for gate validation"
        return 0
    fi

    # Parse jsonl file: read last 50 lines, filter for gate blocks
    local gate_blocks=$(tail -50 "$session_file" | jq -r 'select(.type == "message" and .message.role == "toolResult" and .message.details.error != null) | .message.details.error' | grep -c "PRINCIPLES_GATE" || echo "0")

    if [ "$should_block" == "true" ]; then
        if [ "$gate_blocks" -gt 0 ]; then
            log_success "✓ Gate blocked as expected"
            return 0
        else
            log_error "✗ Gate should have blocked but didn't"
            return 1
        fi
    else
        if [ "$gate_blocks" -eq 0 ]; then
            log_success "✓ Gate allowed as expected"
            return 0
        else
            log_error "✗ Gate should have allowed but blocked"
            log_error "Gate block message: $(tail -50 "$session_file" | jq -r 'select(.message.details.error != null) | .message.details.error' | grep "PRINCIPLES_GATE" | tail -1)"
            return 1
        fi
    fi
}

# 执行清理步骤
execute_cleanup_step() {
    local step="$1"

    local cleanup_actions=$(echo "$step" | jq -r '.actions // []')

    log_info "Running cleanup actions..."

    for action in $(echo "$cleanup_actions" | jq -r '.[] | @base64'); do
        action_decoded=$(echo "$action" | base64 -d)
        local action_type=$(echo "$action_decoded" | jq -r '.type')

        case "$action_type" in
            delete_file)
                local path=$(echo "$action_decoded" | jq -r '.path')
                if [ -f "$path" ]; then
                    rm -f "$path"
                    log_info "Deleted file: $path"
                fi
                ;;
            reset_trust)
                local score=$(echo "$action_decoded" | jq -r '.score // 59')
                jq ".trust_score = $score" "$SCORECARD_PATH" > /tmp/scorecard.json
                mv /tmp/scorecard.json "$SCORECARD_PATH"
                log_info "Reset trust score to $score"
                ;;
            *)
                log_warning "Unknown cleanup action: $action_type"
                ;;
        esac
    done

    return 0
}

# 执行等待步骤
execute_wait_step() {
    local step="$1"

    local duration=$(echo "$step" | jq -r '.duration // 5')
    local reason=$(echo "$step" | jq -r '.reason // ""')

    log_info "Waiting ${duration}s... ${reason}"
    sleep "$duration"

    return 0
}

# ============================================================================
# 测试报告
# ============================================================================

generate_test_report() {
    local scenario="$1"
    local results="$2"
    local start_time="$3"
    local end_time="$4"

    local duration=$((end_time - start_time))
    local total_steps=$(echo "$scenario" | jq '.steps | length')
    local passed_steps=$(echo "$results" | jq '[.[] | select(.status == "passed")] | length')
    local failed_steps=$(echo "$results" | jq '[.[] | select(.status == "failed")] | length')

    local report_file="$TEST_OUTPUT_DIR/test-report.md"
    local json_report="$TEST_OUTPUT_DIR/test-report.json"

    # Markdown报告
    cat > "$report_file" << EOF
# Feature Test Report: $FEATURE_NAME

**Date**: $(date)
**Feature**: $FEATURE_NAME
**Status**: $( [ "$failed_steps" -eq 0 ] && echo "✅ PASSED" || echo "❌ FAILED" )
**Duration**: ${duration}s

## Summary

| Metric | Value |
|--------|-------|
| Total Steps | $total_steps |
| Passed | $passed_steps |
| Failed | $failed_steps |
| Success Rate | $((passed_steps * 100 / total_steps))% |

## Test Configuration

\`\`\`json
$(echo "$scenario" | jq '.metadata // {}')
\`\`\`

## Step Results

$(echo "$results" | jq -r '.[] | "### \(.name)\n\n- **Status**: \(.status)\n- **Duration**: \(.duration)s\n- **Type**: \(.type)\n\(.details // "")\n"')

## Execution Timeline

$(jq -r '[.[] | "[\(.timestamp)] \(.type): \(.data.step // "" | tostring) \(.data.name // "")"] | join("\n")' "$EXECUTION_LOG")

## Artifacts

- **Test Log**: \`test.log\`
- **Execution Log**: \`execution.jsonl\`
- **Output Directory**: \`$TEST_OUTPUT_DIR\`

---

**Generated by**: \`feature-test-runner.sh\`
EOF

    # JSON报告
    cat > "$json_report" << EOF
{
  "feature_name": "$FEATURE_NAME",
  "timestamp": "$(date -Iseconds)",
  "start_time": "$start_time",
  "end_time": "$end_time",
  "duration": $duration,
  "status": $( [ "$failed_steps" -eq 0 ] && echo '"passed"' || echo '"failed"' ),
  "summary": {
    "total_steps": $total_steps,
    "passed_steps": $passed_steps,
    "failed_steps": $failed_steps,
    "success_rate": $((passed_steps * 100 / total_steps))
  },
  "scenario": $(echo "$scenario" | jq 'del(.steps)'),  // 不包含步骤详情以避免冗余
  "results": $results,
  "artifacts": {
    "log": "test.log",
    "execution_log": "execution.jsonl",
    "output_dir": "$TEST_OUTPUT_DIR"
  }
}
EOF

    log_success "📄 Test reports generated:"
    log_success "   - Markdown: $report_file"
    log_success "   - JSON: $json_report"
}

# ============================================================================
# 主流程
# ============================================================================

main() {
    log_info "╔════════════════════════════════════════════════════════════╗"
    log_info "║          Feature Test Framework: $FEATURE_NAME            ║"
    log_info "╚════════════════════════════════════════════════════════════╝"
    log_info ""
    log_info "Output Directory: $TEST_OUTPUT_DIR"

    # 记录测试开始
    record_event "test_start" "{\"feature\":\"$FEATURE_NAME\"}"

    # 加载场景
    local scenario=$(load_scenario "$SCENARIO_FILE")

    # 显示场景信息
    local feature_description=$(echo "$scenario" | jq -r '.metadata.description // "No description"')
    local feature_version=$(echo "$scenario" | jq -r '.metadata.version // "unknown"')
    local feature_version=$(echo "$scenario" | jq -r '.metadata.version // "unknown"')

    log_info "Feature: $feature_description"
    log_info "Version: $feature_version"
    log_info ""

    # 获取测试步骤 (don't use -r to keep JSON array structure)
    local steps=$(echo "$scenario" | jq '.steps // []')
    local total_steps=$(echo "$steps" | jq 'length')

    if [ "$total_steps" -eq 0 ]; then
        log_error "No test steps found in scenario"
        exit 1
    fi

    log_info "Test Plan: $total_steps steps"
    log_info ""

    # 执行测试
    local start_time=$(date +%s)
    local results="[]"
    local step_num=0

    for step in $(echo "$steps" | jq -r '.[] | @base64'); do
        step_decoded=$(echo "$step" | base64 -d)
        step_num=$((step_num + 1))

        local step_start=$(date +%s)

        if execute_step "$step_decoded" "$step_num" "$total_steps"; then
            local step_status="passed"
            local step_result=0
        else
            local step_status="failed"
            local step_result=1
        fi

        local step_end=$(date +%s)
        local step_duration=$((step_end - step_start))

        # 记录结果
        results=$(echo "$results" | jq --argjson n "$step_num" \
            --argjson s "$step_decoded" \
            --arg status "$step_status" \
            --argjson duration "$step_duration" \
            '. += [{
                step: $n,
                name: ($s.name // "Unnamed"),
                type: ($s.type // "unknown"),
                status: $status,
                duration: $duration,
                details: ($s.description // "")
            }]')
    done

    local end_time=$(date +%s)

    # 生成报告
    generate_test_report "$scenario" "$results" "$start_time" "$end_time"

    # 记录测试结束
    record_event "test_end" "{\"feature\":\"$FEATURE_NAME\",\"status\":$( [ "$step_result" -eq 0 ] && echo '"passed"' || echo '"failed"' )}"

    log_info ""
    log_info "═══════════════════════════════════════════════════════════"
    log_info ""

    # 输出总结
    local passed_count=$(echo "$results" | jq '[.[] | select(.status == "passed")] | length')
    local failed_count=$(echo "$results" | jq '[.[] | select(.status == "failed")] | length')

    log_info "Test Summary:"
    log_info "  Total:   $total_steps"
    log_info "  Passed:  $passed_count"
    log_info "  Failed:  $failed_count"
    log_info "  Status:  $( [ "$failed_count" -eq 0 ] && echo "✅ PASSED" || echo "❌ FAILED" )"
    log_info ""

    if [ "$failed_count" -gt 0 ]; then
        log_info "Failed Steps:"
        echo "$results" | jq -r '.[] | select(.status == "failed") | "  - \(.name) (Step \(.step))"'
        log_info ""
    fi

    exit $step_result
}

# 执行主流程
main "$@"
