# Conversation Testing Guide

Simple guide for testing agent conversations using OpenClaw CLI.

## Quick Start

### Basic Conversation

```bash
# Send a message to the main agent
openclaw agent --agent main --message "你好，请介绍一下你自己"

# Ask about current OKR progress
openclaw agent --agent main --message "请报告当前 OKR 任务的进度"

# Get JSON output for analysis
openclaw agent --agent main --message "报告状态" --json
```

### Scheduled Testing

```bash
# Check progress every 2 hours
/loop 2h openclaw agent --agent main --message "请报告故事优化任务的当前进度"

# Daily status check
/loop 24h openclaw agent --agent main --message "请生成今日工作总结"
```

### Useful Options

```bash
# With thinking enabled
openclaw agent --agent main --message "分析代码质量" --thinking high

# With verbose output
openclaw agent --agent main --message "执行任务" --verbose on

# Timeout setting
openclaw agent --agent main --message "复杂任务" --timeout 300
```

## Example Scenarios

### Story Diagnosis Task

```bash
# Phase 1: Structure analysis
openclaw agent --agent main --message "请分析第一章的故事节奏和情节连贯性"

# Phase 2: Character consistency
openclaw agent --agent main --message "检查第一章的角色一致性"

# Phase 3: Technical concepts
openclaw agent --agent main --message "验证编程概念映射的准确性"

# Phase 4: User pain points
openclaw agent --agent main --message "识别用户可能的痛点并提出改进"
```

### System Health Check

```bash
# Check trust score
cat /home/csuzngjh/clawd/docs/AGENT_SCORECARD.json | jq '.trust_score'

# View recent events
tail -20 /home/csuzngjh/clawd/memory/.state/logs/events.jsonl | jq -r '.event_type'

# Check for pain signals
ls -la /home/csuzngjh/clawd/docs/.pain_flag
```

### Monitoring Trust System

```bash
# Monitor trust score changes
watch -n 60 'cat /home/csuzngjh/clawd/docs/AGENT_SCORECARD.json | jq ".trust_score, .trust_stage"'

# Check recent gate blocks
grep -i "gate_block\|blocked" /home/csuzngjh/clawd/memory/.state/logs/events.jsonl | tail -10

# View agent scorecard
openclaw agent --agent main --message "请显示我的当前信任分数和权限等级" --json | jq '.result.meta'
```

## Tips

1. **Keep it simple** - Use direct CLI commands instead of complex scripts
2. **Use JSON output** - Add `--json` flag for programmatic analysis
3. **Schedule wisely** - Don't overwhelm the agent with too frequent checks
4. **Monitor logs** - Check `/tmp/openclaw/` and workspace logs for issues

## Troubleshooting

### Gateway not running
```bash
# Check if gateway is running
ps aux | grep openclaw-gateway

# Start gateway if needed
openclaw-gateway start
```

### Agent not responding
```bash
# Check agent status
openclaw agents list

# View agent logs
openclaw agent --agent main --message "test" --verbose on
```

### Trust issues
```bash
# Check current trust status
cat /home/csuzngjh/clawd/docs/AGENT_SCORECARD.json

# Reset trust score if needed (requires manual intervention)
```
