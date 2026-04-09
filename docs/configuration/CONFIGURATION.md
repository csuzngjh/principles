<!-- generated-by: gsd-doc-writer -->
# Configuration

This document describes how to configure Principles Disciple, covering environment variables, configuration files, and all available settings.

## Environment Variables

The following environment variables can be used to customize Principles Disciple behavior:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PD_WORKSPACE_DIR` | Optional | `~/.openclaw/workspace` | Override the default workspace directory |
| `PD_STATE_DIR` | Optional | `{workspace}/.state` | Override the default state directory |
| `PD_TEST_AGENTS_DIR` | Optional | `~/.openclaw/agents` | Override the agents directory (primarily for testing) |
| `OPENCLAW_WORKSPACE` | Optional | - | Alternative workspace env var (fallback if `PD_WORKSPACE_DIR` is not set) |
| `DEBUG` | Optional | `false` | Enable debug logging for path resolution. Set to `true` for verbose output |

### Path Resolution Priority

When determining the workspace directory, Principles Disciple follows this priority order:

1. `PD_WORKSPACE_DIR` environment variable
2. `OPENCLAW_WORKSPACE` environment variable
3. `workspace` field in `principles-disciple.json` config file
4. Default: `~/.openclaw/workspace`

For the state directory:

1. `PD_STATE_DIR` environment variable
2. `state` field in `principles-disciple.json` config file
3. Default: `{workspace}/.state`

## Configuration Files

### principles-disciple.json

Project-level configuration file. The plugin searches for this file in the following locations (first found wins):

1. `{current_working_directory}/principles-disciple.json`
2. `~/.openclaw/principles-disciple.json`
3. `~/.principles/principles-disciple.json`

**Format:**

```json
{
  "workspace": "/home/user/my-workspace",
  "state": "/home/user/my-workspace/.state",
  "debug": false
}
```

### pain_settings.json

Plugin behavior settings. Stored in the state directory:

```
{state_dir}/pain_settings.json
```

This file is created automatically with default values on first run. It can be edited to customize plugin behavior.

## PainSettings Reference

The `pain_settings.json` file contains the following configuration sections:

### language

- **Type:** `'en' | 'zh'`
- **Default:** `'zh'`

UI and response language. Set to `'zh'` for Chinese or `'en'` for English.

### thresholds

Controls when the pain/stress system triggers interventions.

| Setting | Default | Description |
|---------|---------|-------------|
| `pain_trigger` | `40` | Cumulative pain score that triggers forced reflection |
| `cognitive_paralysis_input` | `4000` | Input length (chars) that indicates cognitive overload |
| `stuck_loops_trigger` | `4` | Consecutive failed attempts on the same file before intervention |
| `semantic_min_score` | `0.7` | Minimum semantic similarity score for loop detection |
| `promotion_count_threshold` | `3` | Number of successful operations before trust score increase |
| `promotion_similarity_threshold` | `0.8` | Similarity threshold for grouping similar operations |

### scores

Penalty values applied when various failure types occur.

| Setting | Default | Description |
|---------|---------|-------------|
| `paralysis` | `30` | Penalty for cognitive paralysis state |
| `default_confusion` | `30` | Penalty for confusion state |
| `default_loop` | `40` | Penalty for detected infinite loops |
| `tool_failure_friction` | `15` | Penalty for tool execution failures |
| `exit_code_penalty` | `50` | Penalty for non-zero exit codes from commands |
| `spiral_penalty` | `30` | Penalty for escalating error spirals |
| `missing_test_command_penalty` | `20` | Penalty when test commands cannot be determined |
| `subagent_error_penalty` | `60` | Penalty for subagent execution errors |
| `subagent_timeout_penalty` | `50` | Penalty for subagent timeouts |

### severity_thresholds

| Setting | Default | Description |
|---------|---------|-------------|
| `high` | `70` | Score threshold for high severity issues |
| `medium` | `40` | Score threshold for medium severity issues |
| `low` | `20` | Score threshold for low severity issues |

### intervals

| Setting | Default | Description |
|---------|---------|-------------|
| `worker_poll_ms` | `900000` (15 min) | How often the evolution worker scans for patterns |
| `initial_delay_ms` | `5000` | Initial delay before worker starts |
| `task_timeout_ms` | `3600000` (1 hour) | Maximum time for a single task |

### diagnostician (optional)

Context extraction settings for the diagnostician agent:

```json
{
  "context": {
    "time_window_minutes": 5,
    "max_message_length": 500,
    "max_summary_length": 3000
  }
}
```

### deep_reflection (optional)

Deep reflection checkpoint settings:

```json
{
  "enabled": true,
  "mode": "auto",
  "force_checkpoint": true,
  "checkpoint_message": "Before responding, quick self-check: 1. Task complexity 2. Information sufficiency 3. If complex or insufficient info, call deep_reflect tool",
  "auto_trigger_conditions": {
    "min_tool_calls": 5,
    "error_rate_threshold": 0.3,
    "complexity_keywords": ["refactor", "architecture", "design", "optimize", "security", "critical"]
  },
  "default_model": "T-01",
  "default_depth": 2,
  "timeout_ms": 60000
}
```

### empathy_engine (optional)

Empathy engine penalty settings:

```json
{
  "enabled": true,
  "dedupe_window_ms": 60000,
  "penalties": {
    "mild": 10,
    "moderate": 25,
    "severe": 40
  },
  "rate_limit": {
    "max_per_turn": 40,
    "max_per_hour": 120
  },
  "model_calibration": {}
}
```

### gfi_gate (optional)

Gate filter integration settings:

```json
{
  "enabled": true,
  "thresholds": {
    "low_risk_block": 70,
    "high_risk_block": 40,
    "large_change_block": 50
  },
  "large_change_lines": 50,
  "ep_tier_multipliers": {
    "1": 0.5,
    "2": 0.75,
    "3": 1.0,
    "4": 1.5,
    "5": 2.0
  },
  "bash_safe_patterns": [
    "^(ls|dir|pwd|which|where|echo|env|cat|type|head|tail|less|more)\\b",
    "^git\\s+(status|log|diff|branch|show|remote)\\b",
    "^npm\\s+(run|test|build|start)\\b"
  ],
  "bash_dangerous_patterns": [
    "rm\\s+(-[a-z]*r[a-z]*f|-rf)",
    "git\\s+(push\\s+.*--force|reset\\s+--hard|clean\\s+-fd)",
    "(curl|wget).*\\|\\s*(ba)?sh"
  ]
}
```

### compression (optional)

Working memory compression settings:

```json
{
  "line_threshold": 100,
  "size_threshold_kb": 15,
  "interval_hours": 24,
  "keep_completed_tasks": 3,
  "max_working_memory_artifacts": 10
}
```

## Runtime Constants

The following constants are compiled into the plugin and cannot be configured via settings files:

| Constant | Value | Description |
|----------|-------|-------------|
| `TRAJECTORY_GATE_BLOCK_RETRY_DELAY_MS` | `250` | Retry delay for trajectory gate blocks |
| `TRAJECTORY_GATE_BLOCK_MAX_RETRIES` | `3` | Maximum retries for trajectory gate blocks |
| `THINKING_CHECKPOINT_WINDOW_MS` | `300000` (5 min) | Time window for thinking checkpoints |
| `GFI_LARGE_CHANGE_LINES` | `50` | Lines threshold for large change detection |
| `AGENT_SPAWN_GFI_THRESHOLD` | `90` | Maximum GFI for agent spawning |
| `EVOLUTION_WORKER_POLL_INTERVAL_MS` | `900000` (15 min) | Evolution worker polling interval |
| `EVOLUTION_QUEUE_BATCH_SIZE` | `10` | Batch size for evolution queue processing |
| `SESSION_TOKEN_WARNING_THRESHOLD` | `8000` | Token count for session warnings |
| `SESSION_MAX_IDLE_MS` | `1800000` (30 min) | Maximum idle time before session warning |
| `EVENT_LOG_BUFFER_SIZE` | `20` | Event log buffer size |
| `EVENT_LOG_FLUSH_INTERVAL_MS` | `30000` (30 sec) | Event log flush interval |

## Per-Environment Overrides

Principles Disciple does not use environment-specific config files (e.g., `.env.development`). Instead:

- **Development vs Production** is determined by the workspace and state directory paths you configure
- **Multiple workspaces** can be supported by using different `PD_WORKSPACE_DIR` values per project
- **Debug mode** is controlled via the `DEBUG` environment variable, not a config file

To run with different settings for different projects, either:

1. Set environment variables in your shell profile per-project using direnv
2. Use different config files at different paths and set `PD_WORKSPACE_DIR` accordingly

## File Path Keys

The `PathResolver` resolves the following symbolic keys to actual paths:

| Key | Description |
|-----|-------------|
| `PROFILE` | `/{workspace}/.principles/PROFILE.json` |
| `PRINCIPLES` | `/{workspace}/.principles/PRINCIPLES.md` |
| `THINKING_OS` | `/{workspace}/.principles/THINKING_OS.md` |
| `DECISION_POLICY` | `/{workspace}/.principles/DECISION_POLICY.json` |
| `MODELS_DIR` | `/{workspace}/.principles/models` |
| `PLAN` | `/{workspace}/PLAN.md` |
| `AGENT_SCORECARD` | `/{state}/AGENT_SCORECARD.json` |
| `PAIN_FLAG` | `/{state}/.pain_flag` |
| `EVOLUTION_QUEUE` | `/{state}/evolution_queue.json` |
| `WORKBOARD` | `/{state}/WORKBOARD.json` |
| `PAIN_SETTINGS` | `/{state}/pain_settings.json` |
| `STATE_DIR` | The state directory path |
| `EXTENSION_ROOT` | Plugin installation root |
| `MEMORY` | `/{workspace}/memory` |
