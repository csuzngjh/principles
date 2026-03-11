#!/bin/bash
# 测试环境统一配置

# 路径配置
export WORKSPACE_DIR="${WORKSPACE_DIR:-/home/csuzngjh/clawd}"
export STORY_DIR="${STORY_DIR:-/home/csuzngjh/code/code_magic_academy/story/source/narratives}"
export OUTPUT_DIR="${OUTPUT_DIR:-$WORKSPACE_DIR/okr-diagnostic}"
export TEST_REPORTS_DIR="${TEST_REPORTS_DIR:-/home/csuzngjh/code/principles/tests/reports}"

# Agent配置
export AGENT_ID="${AGENT_ID:-main}"
export DEFAULT_MODEL="${DEFAULT_MODEL:-unicom-cloud/MiniMax-M2.5}"

# 测试参数
export TEST_TIMEOUT="${TEST_TIMEOUT:-300}"
export CHECK_INTERVAL="${CHECK_INTERVAL:-20}"

# 日志路径
export GATEWAY_LOG_DIR="${GATEWAY_LOG_DIR:-/tmp/openclaw}"
export SESSION_DIR="${SESSION_DIR:-$HOME/.openclaw/agents/$AGENT_ID/sessions}"
export SCORECARD_PATH="${SCORECARD_PATH:-$WORKSPACE_DIR/docs/AGENT_SCORECARD.json}"

echo "✅ 配置文件创建完成"
echo "   WORKSPACE: $WORKSPACE_DIR"
echo "   AGENT_ID: $AGENT_ID"
echo "   DEFAULT_MODEL: $DEFAULT_MODEL"
