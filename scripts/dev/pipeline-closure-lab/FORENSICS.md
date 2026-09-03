# FORENSICS — PD 管道取证查询 Runbook

PRI-634-C/E 两轮验证中反复使用、被证明有效的只读取证查询。全部只读
（sqlite 一律 `mode=ro`），可安全对 live workspace 执行。

约定：`WS` = PD workspace 目录（如 `D:\.openclaw\workspace`）。

## 1. 队列与链状态（state.db）

```bash
WS='D:/.openclaw/workspace'
# 最近活跃任务
sqlite3 "file:///$WS/.pd/state.db?mode=ro" \
  "SELECT task_id, task_kind, status, attempt_count FROM tasks WHERE updated_at > '<ISO时刻>' ORDER BY task_id"

# 某条链的全部阶段（按 correlationId 前缀模糊匹配）
sqlite3 "file:///$WS/.pd/state.db?mode=ro" \
  "SELECT task_id, status FROM tasks WHERE task_id LIKE '%<链前缀>%' ORDER BY task_id"

# 任务依赖与 pi_metadata（含 dependencyTaskIds / channel / runnerDecision / 修订指令）
sqlite3 "file:///$WS/.pd/state.db?mode=ro" \
  "SELECT diagnostic_json FROM tasks WHERE task_id='<taskId>'"

# run 级失败原因（evaluator/artificer 死因权威来源）
sqlite3 "file:///$WS/.pd/state.db?mode=ro" \
  "SELECT run_id, execution_status, reason FROM runs WHERE task_id LIKE '%<前缀>%' ORDER BY started_at"

# 产物归属（pi_artifacts = 内化链读取的表；artifacts = legacy 诊断桥写入的表）
sqlite3 "file:///$WS/.pd/state.db?mode=ro" \
  "SELECT source_task_id, artifact_kind, created_at, updated_at FROM pi_artifacts WHERE source_task_id LIKE '%<前缀>%'"

# 审批队列
sqlite3 "file:///$WS/.pd/state.db?mode=ro" "SELECT approval_id, channel, status FROM approvals"
```

## 2. 会话轨迹（trajectory.db——pain 绑定与证据的来源）

```bash
# 最近会话（找 --session 绑定目标）
sqlite3 "file:///$WS/.state/trajectory.db?mode=ro" \
  "SELECT session_id, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 10"

# 会话内的工具调用（真实失误/失败证据）
sqlite3 "file:///$WS/.state/trajectory.db?mode=ro" \
  "SELECT tool_name, outcome, created_at FROM tool_calls WHERE session_id='<sid>' ORDER BY created_at"

# pain 事件（含 reason 全文）
sqlite3 "file:///$WS/.state/trajectory.db?mode=ro" \
  "SELECT session_id, source, score, reason FROM pain_events ORDER BY id DESC LIMIT 5"
```

## 3. 对抗门与关键事件（telemetry）

```bash
# evaluator 对抗重放（区分"gate 判负"与"gate 不可达"的权威证据）
grep evaluator_adversarial "$WS/.pd/telemetry/critical-events.jsonl" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      s.trim().split('\n').forEach(l=>{try{const j=JSON.parse(l);
        console.log(j.timestamp, j.eventType, JSON.stringify(j.payload).slice(0,200))
      }catch(e){}})})"
# 关键字段：evaluator_adversarial_replay → gateDecision/caseCount/failedCaseCount（重放实际执行）
#          evaluator_adversarial_replay_skipped → reason=no_adversarial_cases_after_merge（不可达）
```

## 4. PD CLI 面（operator 正道）

```bash
pd pain list -w "$WS" --json                                  # pain 清单
pd pain record -w "$WS" --session <sid> --score 85 -r "<纠正描述>" --json   # 绑定真实会话（必须 --session）
pd task list -w "$WS" --json                                  # 任务队列
pd runtime internalization run-once -w "$WS" --json           # 手动推进一步（gateway auto-consumer 120s 自走）
pd runtime internalization context-trace -t <taskId> -w "$WS" # 上下文链诊断（634-C P0 的定位工具）
pd runtime internalization integrity -w "$WS" --json          # 断链清单
pd runtime features -w "$WS" --json                           # flag 生效面
pd activation list -w "$WS" --json                            # 激活清单
pd runtime canary -w "$WS" --json                             # 健康金丝雀
```

## 5. 行为级验证 one-liner

```bash
# 代码判定行为运行时验证（example: canonicalizeToolKind）
node -e "const {canonicalizeToolKind}=require('<repo>/packages/principles-core/dist/runtime-v2/internalization/rule-context-v2.js');
console.log(canonicalizeToolKind('execute_command'))"        # → 'other'（634-E 审计基线）

# 原则注入统计（agent 是否真的被注入影响）
pd principles stats -w "$WS" --json
```

## 6. 已知观测缺口（使用时注意）

- `v2_adversarial_cases_skipped` 的**子原因**（no_path_param / non_write_canonical_kind）
  不落盘——死因子原因需结合代码路径推导（634-E 已列 follow-up）
- gateway 日志（`%TEMP%/openclaw/openclaw-<date>.log`）是 OpenClaw 侧的；
  PD 侧事件以 critical-events.jsonl 为准
- `| tail` 会吞退出码——验证脚本判定必须用 `$?` 或 `set -o pipefail`
