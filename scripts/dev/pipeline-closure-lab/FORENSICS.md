# FORENSICS — PD 管道取证查询 Runbook

PRI-634-C/E 两轮验证中反复使用、被证明有效的取证查询。§1–3 与 §5 的 SQLite/文件
查询全部只读（sqlite 一律 `mode=ro`），可安全对 live workspace 执行；§4 的 pd CLI
命令**分只读与写操作两类**（写操作有副作用，已单独标注，见 §4.2）。

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

## 4. PD CLI 面

> ⚠️ 本节分两类。**只读命令**可安全对 live workspace 执行；
> **写操作命令**（§4.2）会改变 live workspace 状态——只在明确要做管道操作时使用，
> 不要在纯取证时顺手执行。

### 4.1 只读命令

```bash
pd pain list -w "$WS" --json                                  # pain 清单
pd task list -w "$WS" --json                                  # 任务队列
pd runtime internalization context-trace -t <taskId> -w "$WS" # 上下文链诊断（634-C P0 的定位工具）
pd runtime internalization integrity -w "$WS" --json          # 断链清单
pd runtime internalization wake-once -w "$WS" --dry-run --json # 租约评估（不取得租约）
pd runtime features -w "$WS" --json                           # flag 生效面
pd activation list -w "$WS" --json                            # 激活清单
pd runtime canary -w "$WS" --json                             # 健康金丝雀
```

### 4.2 写操作命令（有副作用，影响 live workspace）

```bash
# ⚠️ 写入一条 pain 记录并触发诊断链（workspace 状态变更）
pd pain record -w "$WS" --session <sid> --score 85 -r "<纠正描述>" --json   # 必须绑定 --session

# ⚠️ 租用一个任务并执行（推进内化管道状态；不传 --runner 用 config 默认）
pd runtime internalization run-once -w "$WS" --json

# ⚠️ 审批/激活等治理动作（Owner 决策面）
pd activation approve --approval-id <id> -w "$WS" --json
```

> 网关内 auto-consumer 每 120 秒自行推进队列——取证时通常**无需** run-once，
> 等待即可；run-once 仅用于需要立即观察下一步的调试场景。
>
> **两种模式的取舍（round-2 教训）**：全程 auto-consumer 的生产路径证据最硬，但三链
> × 多阶段的 120s 排队累计烧掉约 1 小时纯等待。观察关键跳变（如修复循环收敛过程）
> 时可用 run-once 即时驱动，报告注明用了哪个模式。

## 4.3 链永久失败的恢复 runbook（round-2 实证，PRI-674 修复前的唯一活路）

诊断家族任务（diagnostician/diag_*）进入 failed 终态后，CLI 面全部拒绝
（pain retry/diagnose run 只收 pending/retry_wait；`runtime recovery failed-tasks`
按 isPeerRunnerKind 过滤看不见诊断家族）。恢复只有 core 服务一条路：

```bash
cd <repo>/packages/pd-cli && node -e "
(async()=>{
  const { createRecoverySweepService } = await import('@principles/core/runtime-v2');
  const h = await createRecoverySweepService({ workspaceDir: '<WS>' });
  const r = await h.service.recoverFailedTask('<taskId>', true); // force: attempts 耗尽时 +3
  console.log(JSON.stringify(r));
  await h.dispose?.();
})()"
```

**顺序陷阱**：必须**先父后子**（先 `diagnosis_<painId>` 再 `diag_rootcause-…`）。
反了会把父任务因 child lease_conflict 再标 failed 并烧一个 attempt。split-pipeline
失败时两个任务通常都要恢复。恢复父任务后诊断需 `pd diagnose run --task-id <父taskId>`
重新驱动（auto-consumer 不消费 diagnostician）。

## 4.4 会话与取证纪律（round-2 实证）

- **每个实验会话显式 `--session-id r<N>-<场景><轮>`**：dev profile 默认 session
  （`agent:main:main`）携带跨轮残留上下文（round-1 的 45 条消息在 round-2 首发会话
  里污染了行为并完成了任务——数据被迫弃用）。新会话先 ping（`contextTokens` < 1000
  可确认干净）
- **会话结束 → 重置夹具前，先 diff 留档**（字段数/全文/备份文件清单）：重置后行为
  证据不可再取
- **`ask_user` 等待策略**：lab 默认让其自超时（240s，agent 自答继续——测的是自治
  判断）；需要测交互路径时 operator 需盯屏应答。两种策略产生不同行为证据，报告注明
- **环境快照必录**（除 README 既有项外，round-2 新增）：会话模型 thinking level
  （OpenClaw 2026.9.1 + Bai 默认 thinking=medium 会 400，需显式 off）、宿主 LLM 服务器
  `/v1/models` 实测清单（模型名会漂移：config 旧名 ≠ 服务器现名）、nvidia-smi VRAM
  余量（外部实例可能占满）、**基线 PR 合并状态在报告定稿时复核**（多会话并发合 PR，
  fetch 快照几小时内就会过期——round-2 曾据此误判 #1512 未合并）

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
