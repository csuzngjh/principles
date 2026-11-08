# PRI-1147 Real-LLM BDD 实验脚本

Golden 数据集冻结的真实 LLM BDD 实验（Codex 主数据集 / D6 pending 生命周期 / LLM seam 故障注入 / OpenClaw host 子集 / 指标与验收门禁）。
所有脚本：

- 驱动**真实生产链**（`processHookInvocation` → ingestion → admission → pending → `runStage2CorrectionCycle`，Stage-2 分类器由 `createSignalClassifierForWorkspace` 从 workspace 自己的 `.pd/config.yaml` 解析，真实 provider 调用）；
- 不伪造任何 LLM 结果；expected_* 标签只来自 `golden-dataset.json`（冻结于第一次模型调用之前，不得在看到模型输出后修改）；
- 样本环境在 `os.tmpdir()`；SQL 全参数化；日志/证据经 `redactSecrets`，任何脚本都不打印 API key 值（只引用 env 变量名）；
- **运行隔离**：一次完整实验共用一个 `--run-id`，所有阶段只写 `.tmp/pri-1147/runs/<run_id>/`；目标文件已存在时**拒绝运行**（须换新 run_id 或显式 `--append`），绝不静默覆盖/追加；每个阶段及 metrics 还必须持有同一 `.active-run.lock` 独占锁，禁止同一 run_id 并发写入，`--append` 不绕过锁；`run-meta.json` 记录 git commit SHA、数据集 SHA-256、provider/model（仅凭据名）与各阶段起止时间/样本数；
- **结局分类学**（`lib/outcomes.mjs`）：每样本恰一个 `final_outcome` ∈ {admitted, resolved_none, stage1_not_admitted, abandoned_low_confidence, abandoned_llm_error, pending_unresolved, classifier_unavailable, execution_error}——hook 失败/缺 observation/分类器不可用是**执行失败**，永远不是语义 NONE；有效的 NONE 必须是真实模型调用且返回 none@conf≥阈值；低置信度/错误耗尽 5 次尝试的 abandoned 是**未决结果**（不计入 Stage-2 准确率分母）；Stage-2 准确率只统计模型裁决的样本（admitted/resolved_none）。

## 前置条件

1. worktree 自身 READY（Node 26）；
2. `packages/openclaw-plugin/dist/` 已构建（`run-openclaw-host.mjs` 按 dist 文件 URL 导入 `SignalCollectorHost`）；
3. 导出 provider key（值只进进程环境，绝不写入任何文件）：

```bash
export ZAI_API_KEY=...   # 默认 provider 配置；换 provider 时同步改 --provider/--model/--apiKeyEnv
```

冒烟通过组合：`provider=zai model=glm-5.3-flash apiKeyEnv=ZAI_API_KEY reasoning=low`。

## 运行顺序（全部共用同一 --run-id）

```bash
RUN_ID=run-$(date +%Y%m%dT%H%M%SZ)
# Phase 1 — Codex 生产链主数据集（45 样本；部分样本用 --samples A1,A2 → partial_run）
node scripts/dev/pain-real-llm-bdd/run-codex-chain.mjs \
  --run-id $RUN_ID --provider zai --model glm-5.3-flash --apiKeyEnv ZAI_API_KEY --reasoning low

# Phase 2 — D6 pending 生命周期验收（S1–S7）
node scripts/dev/pain-real-llm-bdd/run-d6-pending.mjs \
  --run-id $RUN_ID --provider zai --model glm-5.3-flash --apiKeyEnv ZAI_API_KEY --reasoning low

# Phase 3 — LLM seam 故障注入（全部 simulated_fault）+ D-DEF1 修复后回归
node scripts/dev/pain-real-llm-bdd/run-fault-injection.mjs \
  --run-id $RUN_ID --provider zai --model glm-5.3-flash --apiKeyEnv ZAI_API_KEY --reasoning low

# Phase 4 — OpenClaw host 子集（10 样本，真实 SignalCollectorHost seam）
node scripts/dev/pain-real-llm-bdd/run-openclaw-host.mjs \
  --run-id $RUN_ID --provider zai --model glm-5.3-flash --apiKeyEnv ZAI_API_KEY --reasoning low

# Phase 5 — 指标 + 五项验收门禁 + 脱敏证据落盘
node scripts/dev/pain-real-llm-bdd/compute-metrics.mjs --run-id $RUN_ID
```

**串行执行约束**：同一 `run_id` 的 Phase 1–5 必须依次完成。每个脚本（包括 metrics）启动时通过 `O_EXCL` 创建 `.active-run.lock`；已有锁时立即失败，即使传入 `--append` 也不允许并发写入。正常退出自动释放锁；若进程被强制终止，先核实锁记录中的 PID 已不存在，再手动删除该 run 目录中的锁文件，或直接使用新的 run_id。不要在实验阶段之间并发启动脚本。

通用参数：`--samples A1,A2`（仅 codex-chain；部分样本 → `partial_run: true`，门禁 `overall_ok=false`）、`--append`（显式授权向已有 run 目录追加）、`--results-root`（默认 `.tmp/pri-1147`）、`--timeout-ms`、`--max-tokens`、`--base-url`、`--reasoning false`。OpenClaw 子集另有 `--poll-seconds`（默认 90）。

## 产物位置

| 文件 | 产出脚本 | 内容 |
| --- | --- | --- |
| `.tmp/pri-1147/runs/<run_id>/codex-chain.jsonl` | run-codex-chain | 每样本 Stage-1/Stage-2/终态 + final_outcome + LLM 测量 |
| `.tmp/pri-1147/runs/<run_id>/codex-chain.summary.json` | run-codex-chain | 运行汇总（run_id/partial/git sha/dataset sha/结局计数/执行失败清单） |
| `.tmp/pri-1147/runs/<run_id>/d6-pending.summary.json` | run-d6-pending | S1–S7 检查记录 |
| `.tmp/pri-1147/runs/<run_id>/summary` 文件 ×3 | 三阶段脚本 | 各自 ok/totals/run_id |
| `.tmp/pri-1147/runs/<run_id>/metrics-summary.json` | compute-metrics | 五项门禁 + 混淆矩阵/精度/Stage-2 精度/LLM 统计 + OpenClaw dist SHA-256 指纹 |
| `docs/reports/evidence/pri-1147-<run_id>/per-sample.json` | compute-metrics | **脱敏证据**（含 Stage-2 attempts/verdict/confidence；仅标识/期望/观测/结局/延迟/哈希；不含样本原文/模型理由/日志/凭据） |

样本环境（workspace + CODEX_HOME + trajectory.db）在 `os.tmpdir()` 的临时根下，保留作证据，报告评审后手动删除。

## 诚实标注规则

- **simulated_fault**：`run-fault-injection.mjs` 的全部故障（429/500/504/超时/无效载荷）都是分类器 seam 上的受控注入，**绝不冒充真实 provider 行为**；真实 provider 故障只在真实调用中自然发生时以 `real_http_fault_observation` 记录。
- **seam 判据 vs 语义观测**：OpenClaw 子集的样本级 pass 只看 seam 的确定性路由；LLM 判定如实记为 `semantic_observation`，语义不符进入 metrics 汇总而不伪造 pass。
- **失败即记录**：所有脚本 `{pass:false}` 如实记录；provider 阻塞标 `{pass:false, blocked:true, reason}`；exit code 0 仅当全部通过；summary `ok=false` 时 Node 退出码为 1。
- **生产语义注记**：cycle 内分类器返回 null/超时/async 拒绝 → `recordPendingCorrectionReview(null)` → `pending_llm_error` 消耗一次 attempt，settle 视为可重试；"不消耗 attempt 的释放"仅发生在 classifier 完全不可用 / 预算耗尽 / record 失败 / 同步 throw；连续 5 次（`STAGE2_MAX_ATTEMPTS`）→ `abandoned(llm_error|low_confidence)`。
- **时间控制**：TTL/claim 时钟一律通过生产函数原生 `now` 参数注入（72h / claim TTL 10min），零真实等待。除 F-TIMEOUT 的 2s 分类超时（该测试的目的就是超时形状）外，**所有 cycle 调用使用生产默认预算**（D-DEF1 已修复，见下）。

## D-DEF1（ERR-191）— 已在生产代码修复

`runStage2CorrectionCycle` 曾以 `performance.now()` 浮点差值计算单次分类超时；默认预算（60s==60s）下剩余预算几乎恒为浮点 → `AbortSignal.timeout(浮点)` 抛 `ERR_OUT_OF_RANGE` → 分类器在任何网络 I/O 之前瞬时失败（<50ms）→ `pending_llm_error` 消耗 attempt → 五轮后静默 `abandoned(llm_error)`。

- **修复**：生产者处整数钳制（提交 `f1797cb37`，host-runtime 回归测试锁定整数契约）。
- **修复前复现证据**：保留在验收报告 §九/§十与 ERR-191（修复前一轮 fault 运行的真实记录）。
- **修复后回归**：`run-fault-injection.mjs` 的 `D-DEF1-postfix` 三检查——默认预算下分类器收到**正整数** timeoutMs、真实请求**进入网络**（ok + 真实延迟 + 判定，`<50ms no_verdict` 修复前签名不得出现）、pending 行默认预算下收敛终态。
- 处置闭环：不再"交 Owner 决策"，状态为 `FIXED_IN_THIS_BRANCH`。

## 检查项速览

### run-d6-pending.mjs（D6 生命周期）

| ID | 验证 |
| --- | --- |
| S1 | A1（ambiguous）经真实 hook 链 → `pending_llm_review` |
| S2a | claim → release 不消耗 attempts；classifier 不可用 cycle 同语义；真实 classifier cycle 恢复终态 |
| S2b | record 持久化真实 verdict 后，无 claimToken 的崩溃恢复 settle 完成终态 |
| S3-budget | 真实 classifier ≤5 次尝试到终态 |
| S3-cap | 3 个 pending 行单 cycle 最多 claim 2，剩余保持 pending |
| S4 | pending 阶段重放收敛、admitted 后重放 `already_admitted` 且 pain=1、同 candidate 并发 admit 恰一 pain |
| S5 | 注入 now=TTL+1ms：claim 前置作废；边界前 1 分钟 claim 正常（对照）；持久化 verdict 的迟到 settle → `abandoned(ttl_expired)` |
| S6 | 终态 payload 恰为 `{decision, reason, confidence, attempts, settledAt}` |
| S7 | pending payload + RAW hook stderr 凭据扫描（env 值子串、Bearer、sk 字面量；值不打印） |

### run-fault-injection.mjs（simulated）

`F-HTTP-429`（null + reject 两形状）、`F-HTTP-500`、`F-HTTP-504`、`F-TIMEOUT`（挂起 30s / 周期超时 2s）、`F-INVALID-JSON` / `F-SCHEMA-INVALID` / `F-EMPTY-RESPONSE`（seam 契约=已验证结果|null）、`F-DUP-REQUEST`（重放幂等）、`F-CONCURRENT-RETRY`（双 cycle 并发 CAS 恰一 admit）、`F-RESTART`（新鲜 claim 跳过 → 陈旧接管 → fencing 拒绝 → 真实恢复）+ `D-DEF1-postfix`（修复后回归 ×3）。

### run-openclaw-host.mjs

真实 `SignalCollectorHost` + 真实 `TrajectoryDatabase` + 真实 `EvolutionReducerImpl` + 生产配置解析的共享分类器；10 样本路由观测 + 单 session 6×STRONG rate-limit 抑制检查（第 6 次必须 `SIGNAL_STRONG_RATE_LIMITED`）。

### harness-regression.test.mjs（离线回归，`npx vitest run scripts/dev/pain-real-llm-bdd/harness-regression.test.mjs`）

结局分类学全映射 / llm_error 永不充当 NONE / 低置信与错误耗尽不计入 Stage-2 准确率分母 / Stage-1 覆盖 FN 单列 / 数据集校验（45/唯一/缺失/多余/无 run_id/无效结局） / 五项门禁（缺 phase、run_id 错配、partial 永不 PASS） / 运行隔离（拒绝覆盖 / run_id 格式 / meta 往返） / 真实 cycle 离线驱动（5 次 null → abandoned(llm_error)、8 轮 budget-release → pending_unresolved、5 次低置信 → abandoned(low_confidence)）。