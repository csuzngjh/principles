#!/bin/bash
# ============================================================================
# 场景生成器 - 交互式创建测试场景
# ============================================================================

set -e

SCENARIOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../framework/test-scenarios" && pwd)"

echo "╔════════════════════════════════════════════════════════════╗"
echo "║           Feature Test Scenario Generator                 ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# 收集基本信息
read -p "Feature name (e.g., trust-system): " feature_name
read -p "Description: " description
read -p "Version (default: 1.0): " version
version=${version:-1.0}
read -p "Author (default: iFlow CLI): " author
author=${author:-iFlow CLI}

read -p "Tags (comma-separated, e.g., core,critical): " tags
tags_array=$(echo "$tags" | jq -R 'split(",") | map(select(length > 0))')

# 场景文件名
scenario_file="$SCENARIOS_DIR/${feature_name}.json"

if [ -f "$scenario_file" ]; then
    echo ""
    echo "⚠️  Warning: Scenario file already exists: $scenario_file"
    read -p "Overwrite? (y/N): " overwrite
    if [[ "$overwrite" != "y" && "$overwrite" != "Y" ]]; then
        echo "Aborted."
        exit 0
    fi
fi

# 开始构建JSON
json=$(cat << EOF
{
  "metadata": {
    "name": "$feature_name",
    "description": "$description",
    "version": "$version",
    "author": "$author",
    "tags": $tags_array
  },
  "setup": {
    "preconditions": [],
    "initial_state": {}
  },
  "steps": []
}
EOF
)

echo ""
echo "━━━ Adding Steps ━━━"
echo ""

# 添加步骤
step_num=0
while true; do
    step_num=$((step_num + 1))

    echo "Step $step_num:"
    read -p "  Name (or 'done' to finish): " step_name

    if [ "$step_name" == "done" ]; then
        break
    fi

    read -p "  Type (task/validation/cleanup/wait): " step_type
    read -p "  Description: " step_desc

    # 根据类型收集额外信息
    case "$step_type" in
        task)
            echo "  Enter task prompt (press Ctrl+D when done):"
            task_prompt=$(cat)
            read -p "  Timeout (seconds, default: 120): " timeout
            timeout=${timeout:-120}
            read -p "  Wait for completion? (Y/n): " wait_completion
            wait_completion=${wait_completion:-y}
            [[ "$wait_completion" == "y" || "$wait_completion" == "Y" ]] && wait_completion=true || wait_completion=false

            # 添加expected_outcomes
            echo "  Expected outcomes (enter 'done' when finished):"
            outcomes_array="[]"
            outcome_num=0
            while true; do
                outcome_num=$((outcome_num + 1))
                echo "    Outcome $outcome_num:"
                read -p "      Type (file_exists/file_contains/trust_score/event_logged/done): " outcome_type

                if [ "$outcome_type" == "done" ]; then
                    break
                fi

                outcome_json="{\"type\":\"$outcome_type\""

                case "$outcome_type" in
                    file_exists)
                        read -p "      File path: " outcome_path
                        outcome_json+=",\"path\":\"$outcome_path\""
                        ;;
                    file_contains)
                        read -p "      File path: " outcome_path
                        read -p "      Content to search: " outcome_content
                        outcome_json+=",\"path\":\"$outcome_path\",\"content\":\"$outcome_content\""
                        ;;
                    trust_score)
                        read -p "      Operator (>=,<=,=): " outcome_op
                        read -p "      Value: " outcome_value
                        outcome_json+=",\"operator\":\"$outcome_op\",\"value\":$outcome_value"
                        ;;
                    event_logged)
                        read -p "      Event type: " event_type
                        outcome_json+=",\"event_type\":\"$event_type\""
                        ;;
                esac

                outcome_json+="}"

                outcomes_array=$(echo "$outcomes_array" | jq --argjson o "$outcome_json" '. += [$o]')
            done

            # 转义task prompt中的特殊字符
            task_escaped=$(echo "$task_prompt" | jq -Rs .)

            step_json=$(cat << EOF
{
  "name": "$step_name",
  "type": "$step_type",
  "description": "$step_desc",
  "task": $task_escaped,
  "timeout": $timeout,
  "wait_for_completion": $wait_completion,
  "expected_outcomes": $outcomes_array
}
EOF
)
            ;;
        validation)
            read -p "  Validator (trust_validator/gate_validator/file_validator): " validator
            read -p "  Validator params (JSON, e.g., {\"min_score\":60}): " validator_params

            # 验证JSON格式
            if ! echo "$validator_params" | jq empty 2>/dev/null; then
                echo "  ⚠️  Invalid JSON, using empty params"
                validator_params="{}"
            fi

            step_json=$(cat << EOF
{
  "name": "$step_name",
  "type": "$step_type",
  "description": "$step_desc",
  "validator": "$validator",
  "params": $validator_params
}
EOF
)
            ;;
        cleanup)
            echo "  Cleanup actions (enter 'done' when finished):"
            actions_array="[]"
            action_num=0
            while true; do
                action_num=$((action_num + 1))
                echo "    Action $action_num:"
                read -p "      Type (delete_file/reset_trust/done): " action_type

                if [ "$action_type" == "done" ]; then
                    break
                fi

                action_json="{\"type\":\"$action_type\""

                case "$action_type" in
                    delete_file)
                        read -p "      File path: " action_path
                        action_json+=",\"path\":\"$action_path\""
                        ;;
                    reset_trust)
                        read -p "      New trust score: " action_score
                        action_json+=",\"score\":$action_score"
                        ;;
                esac

                action_json+="}"

                actions_array=$(echo "$actions_array" | jq --argjson a "$action_json" '. += [$a]')
            done

            step_json=$(cat << EOF
{
  "name": "$step_name",
  "type": "$step_type",
  "description": "$step_desc",
  "actions": $actions_array
}
EOF
)
            ;;
        wait)
            read -p "  Duration (seconds): " wait_duration
            read -p "  Reason: " wait_reason

            step_json=$(cat << EOF
{
  "name": "$step_name",
  "type": "$step_type",
  "description": "$step_desc",
  "duration": $wait_duration,
  "reason": "$wait_reason"
}
EOF
)
            ;;
        *)
            echo "  ⚠️  Unknown step type, skipping"
            step_num=$((step_num - 1))
            continue
            ;;
    esac

    # 添加步骤到JSON
    json=$(echo "$json" | jq --argjson s "$step_json" '.steps += [$s]')

    echo ""
    read -p "Add another step? (Y/n): " add_more
    [[ "$add_more" == "n" || "$add_more" == "N" ]] && break
    echo ""
done

# 添加teardown
echo ""
echo "━━━ Teardown ━━━"
read -p "Any final notes? (comma-separated): " teardown_notes
teardown_notes_array=$(echo "$teardown_notes" | jq -R 'split(",") | map(select(length > 0))')

json=$(echo "$json" | jq --argjson notes "$teardown_notes_array" '. + {teardown: {final_state: {}, notes: $notes}}')

# 保存场景文件
echo "$json" | jq '.' > "$scenario_file"

echo ""
echo "✅ Scenario created successfully!"
echo "📄 File: $scenario_file"
echo ""
echo "To run the test:"
echo "  ./tests/feature-testing/framework/feature-test-runner.sh $feature_name"
echo ""
echo "To edit the scenario:"
echo "  vim $scenario_file"
