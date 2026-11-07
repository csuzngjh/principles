# PRI-1147 Real-LLM BDD 实验脚本

Golden 数据集冻结的真实 LLM BDD 实验（Phase 2/4/5 + OpenClaw host 子集 + 指标汇总）。
所有脚本：

- 驱动**真实生产链**（`processHookInvocation` → admission → pending →
  `runStage2CorrectionCycle`，Stage-2 分类器由 `createSignalClassifierForWorkspace`
  从 workspace 自己的 `.pd/config.yaml` 解析，真实 provider 调用）；
- 不伪造任何 LLM 结果；expected_* 标签只来自 `golden-dataset.json`（冻结于第一次
  模型调用之前，不得在看到模型输出后修改）；
- 不使用 child_process、不硬编码绝对路径（样本环境在 `os.tmpdir()`，结果在
  worktree 的 `.tmp/pri-1147/results/`）；
- 全部 SQL 参数化；日志/证据输出经 `redactSecrets`，且**任何脚本都不打印 API key
  值**（只引用 env 变量名）。

## 前置条件

1. worktree 自身 READY（`npm run dev:worktree` 创建的工作区已 bootstrap；Node 26）；
2. `packages/openclaw-plugin/dist/` 已构建（`run-openclaw-host.mjs` 按 dist 文件 URL
   导入 `SignalCollectorHost`——包根 exports map 不提供深路径）；
3. 导出 provider key（值只进进程环境，绝不写入任何文件）：

```bash
export ZAI_API_KEY=...   # 默认 provider 配置；换 provider 时同步改 --provider/--model/--apiKeyEnv
```

冒烟通过组合（Phase 2 已验证全链可用）：`provider=zai model=glm-5.3-flash
apiKeyEnv=ZAI_API_KEY reasoning=low`。

## 运行顺序

```bash
# Phase 2 — Codex 生产链主数据集（40 样本，codex-chain-full.jsonl）
node scripts/dev/pain-real-llm-bdd/run-codex-chain.mjs \
  --label full --provider zai --model glm-5.3-flash --apiKeyEnv ZAI_API_KEY --reasoning low

# Phase 4 — D6 pending 生命周期验收（S1 创建 / S2 恢复 / S3 重试与候选上限 /
#           S4 幂等 / S5 TTL 注入时钟 / S6 终态最小 payload / S7 隐私扫描）
node scripts/dev/pain-real-llm-bdd/run-d6-pending.mjs \
  --provider zai --model glm-5.3-flash --apiKeyEnv ZAI_API_KEY --reasoning low

# Phase 5 — LLM seam 故障注入（全部为 simulated_fault，见下"诚实标注"）
node scripts/dev/pain-real-llm-bdd/run-fault-injection.mjs \
  --provider zai --model glm-5.3-flash --apiKeyEnv ZAI_API_KEY --reasoning low

# OpenClaw host 子集（10 样本：A1 A2 A6 B1 B4 C1 C4 D2 G1 H4，真实 SignalCollectorHost seam）
node scripts/dev/pain-real-llm-bdd/run-openclaw-host.mjs \
  --provider zai --model glm-5.3-flash --apiKeyEnv ZAI_API_KEY --reasoning low

# 指标汇总（读取 codex-chain-full.jsonl + 可选的三个 summary）
node scripts/dev/pain-real-llm-bdd/compute-metrics.mjs
```

通用参数：`--samples A1,A2`（仅 codex-chain）、`--timeout-ms`、`--max-tokens`、
`--base-url`、`--results-dir`（默认 `.tmp/pri-1147/results`）、`--reasoning false`
（关闭推理档位）。OpenClaw 子集另有 `--poll-seconds`（异步路由轮询上限，默认 90）。

## 产物位置

| 文件 | 产出脚本 | 内容 |
| --- | --- | --- |
| `.tmp/pri-1147/results/codex-chain-full.jsonl` | run-codex-chain | 每样本 Stage-1/Stage-2/终态 + LLM 测量 |
| `.tmp/pri-1147/results/codex-chain-full.summary.json` | run-codex-chain | 运行汇总 |
| `.tmp/pri-1147/results/d6-pending.summary.json` | run-d6-pending | S1–S7 检查记录（`{ok, checks:[{id,name,pass,evidence}]}`） |
| `.tmp/pri-1147/results/fault-injection.summary.json` | run-fault-injection | 故障场景检查记录 |
| `.tmp/pri-1147/results/openclaw-host.jsonl` / `.summary.json` | run-openclaw-host | 每样本 seam 路由 + LLM 观测 + rate-limit 检查 |
| `.tmp/pri-1147/results/metrics-summary.json` | compute-metrics | 混淆矩阵/精度/Stage-2 精度/LLM 统计 + 三份 summary 合并 |

样本环境（workspace + CODEX_HOME + trajectory.db）在 `os.tmpdir()` 的临时根下，
保留作证据，报告评审后手动删除。

## 诚实标注规则

- **simulated_fault**：`run-fault-injection.mjs` 的全部故障（429/500/504/超时/
  无效载荷）都是分类器 seam 上的受控注入，**绝不冒充真实 provider 行为**；
  真实 provider 故障只在真实调用中自然发生时以 `real_http_fault_observation` 记录。
- **seam 判据 vs 语义观测**：OpenClaw 子集的样本级 pass 只看 seam 的确定性路由
  （expected_stage 是否匹配观测路由）；LLM 的 correction/none 判定如实记为
  `semantic_observation`，语义不符进入 metrics 汇总而不伪造 pass。
- **失败即记录**：所有脚本 `{pass:false}` 如实记录；provider 阻塞的检查标
  `{pass:false, blocked:true, reason}`；整体 exit code 0 仅当全部检查通过。
- **生产语义注记**（实测 `signal-stage2-cycle.ts` / `governance-signal-admission.ts`
  及其生产测试）：cycle 内分类器返回 null/超时/async 拒绝 → `withTimeout` 归一 null →
  `recordPendingCorrectionReview(null)` → P-3 门判 `pending_llm_error`，**消耗一次
  attempt**，settle 视为可重试（清除 verdict、释放 claim）；真正"不消耗 attempt 的
  释放"仅发生在 classifier 完全不可用 / 预算耗尽 / record 失败 / 同步 throw。
  连续 5 次（`STAGE2_MAX_ATTEMPTS`）→ `abandoned(llm_error|low_confidence)`。
- **时间控制**：TTL/claim 时钟一律通过生产函数原生 `now` 参数注入
  （`PENDING_CANDIDATE_TTL_MS`=72h、claim TTL=10min），零真实等待。

## 实验发现的生产缺陷（如实记录，不在本工单修改生产代码）

**D-DEF1** — `runStage2CorrectionCycle` 以 `performance.now()` 浮点差值计算单次
分类超时（`remaining = budgetMs - elapsed`，signal-stage2-cycle.ts:164）。当剩余
聚合预算小于 `classificationTimeoutMs` 时（多候选 cycle 的后续候选、或预算临近
耗尽），浮点 `timeoutMs` 传入 pi-ai 适配器（pi-ai-runtime-adapter.ts:669
`AbortSignal.timeout(effectiveTimeoutMs)`），Node 26 对非整数 delay 抛
`ERR_OUT_OF_RANGE` → 分类器在**任何网络 I/O 之前**瞬时失败（0-4ms 实测）→
`recordPendingCorrectionReview(null)` → `pending_llm_error`，消耗一次 attempt。

- 复现：`run-fault-injection.mjs` 的 `D-DEF1` 场景（真实分类器，确定性，
  零网络依赖）+ `D-DEF1-crosscheck`（`aggregateBudgetMs=120s` 时同一行正常
  分类，证明由预算形状触发、与 provider 无关）。
- 本目录脚本的直接 cycle 调用一律显式传 `aggregateBudgetMs=120_000`
  （> `classificationTimeoutMs`）以规避该缺陷、度量预期语义。
- 处置：交 Owner 决策（候选修复：对 timeoutMs 取整）。

## 检查项速览

### run-d6-pending.mjs（Phase 4 / D6）

| ID | 验证 |
| --- | --- |
| S1 | A1（ambiguous）经真实 hook 链 → `pending_llm_review` |
| S2a | claim → release 不消耗 attempts；classifier 不可用 cycle 同语义；真实 classifier cycle 恢复终态 |
| S2b | record 持久化真实 verdict 后，无 claimToken 的崩溃恢复 settle 完成终态 |
| S3-budget | 真实 classifier ≤5 次尝试到终态（admitted 或诚实 abandoned） |
| S3-cap | 3 个 pending 行单 cycle 最多 claim 2，剩余保持 pending |
| S4 | pending 阶段重放收敛、admitted 后重放 `already_admitted` 且 pain=1、同 candidate 并发 admit 恰一 pain |
| S5 | 注入 now=TTL+1ms：claim 前置作废；边界前 1 分钟 claim 正常（对照）；持久化 verdict 的迟到 settle → `abandoned(ttl_expired)` |
| S6 | 终态 payload 恰为 `{decision, reason, confidence, attempts, settledAt}`，无 reviewResult/claimToken/trigger 残留 |
| S7 | pending payload + RAW hook stderr 凭据扫描（env 值子串、Bearer、sk 字面量；值不打印） |

### run-fault-injection.mjs（Phase 5，simulated）

`F-HTTP-429`（null + reject 两形状）、`F-HTTP-500`、`F-HTTP-504`、`F-TIMEOUT`
（挂起 30s / 周期超时 2s）、`F-INVALID-JSON` / `F-SCHEMA-INVALID` /
`F-EMPTY-RESPONSE`（seam 契约=已验证结果|null，三者同形）、`F-DUP-REQUEST`
（payload 重放幂等）、`F-CONCURRENT-RETRY`（双真实 cycle 并发 CAS 恰一 admit）、
`F-RESTART`（新鲜 claim 跳过 → +11min 陈旧接管 → 旧 token fencing 拒绝 → 真实恢复）。

### run-openclaw-host.mjs

真实 `SignalCollectorHost` + 真实 `TrajectoryDatabase` + 真实
`EvolutionReducerImpl` + 生产配置解析的共享分类器 + 生产 live 词库 provider；
10 样本路由观测 + 单 session 6×STRONG rate-limit 抑制检查
（`strongRateLimitPerHour=5`，第 6 次必须出现 `SIGNAL_STRONG_RATE_LIMITED`）。
