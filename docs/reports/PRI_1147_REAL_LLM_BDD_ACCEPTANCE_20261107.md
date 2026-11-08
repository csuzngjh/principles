# PRI-1147 — Pain 真实 LLM BDD 与检测可靠性验收报告

**状态：** READY_FOR_OWNER_REVIEW（整改与真实验收已完成，等待最新 PR CI 全绿）
**日期：** 2026-11-08
**执行分支：** `test/pain-real-llm-bdd-pri-1147-20261107`（已同步最新 main；最终验收代码 commit `c01dde9c4`）
**关联：** SPEC `docs/specs/SPEC-PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE-001-v0.3.1.md` §7.1–§7.3、§8；SPEC `docs/specs/SPEC-PD-CROSS-HOST-KEYWORD-PAIN-001-v0.2.md`
**冻结证据：** Golden Dataset 于任何模型调用前冻结并提交（`4801fd8b0`，早于首个 API 调用 2026-11-07T09:41:51Z）
**最终验收运行：** `run-20261108T043500Z-pr2407-stage2fix`（最新代码下单一 run_id 贯穿四阶段，生产默认预算，五项门禁全过，Stage-2 证据 25/25 完整）

---

## 〇、最终裁定：**READY_FOR_OWNER_REVIEW**

真实 LLM BDD 已在最新代码 `c01dde9c4`、生产默认预算下重新全量执行；原始三项 P1 与最终复核 P1-B 全部关闭（失败分类学/退出码、run_id 隔离/并发锁、D-DEF1 默认预算、Stage-2 证据回填与 fail-closed 完整性门禁）；五项验收门禁全部通过；25/25 Stage-2 样本的 attempts/verdict/confidence 均完整且与终态一致。另保留已修复的生产缺陷 D-DEF1（整数 timeout 钳制 + ERR-191）。6 个 FP 与 6 个 Stage-1 覆盖边界 FN 是真实语义/覆盖边界，需 Owner 决策，不构成本轮 P1。

**Owner 五问对照（最终验收运行 run-20261108T043500Z-pr2407-stage2fix）：**

| # | Owner 关注点 | 结论 | 证据 |
|---|---|---|---|
| 1 | 真实纠正能否被识别？ | **能**（检测错误 FN=0；关键词覆盖边界内 20/20 全部识别） | §五 |
| 2 | 普通讨论能否被排除？ | **能**（TN=13；6 FP 含冻结对抗样本 C4 与模型语义误判，逐样本归因见 §五/§十二） | §五 §十二 |
| 3 | D5 是否避免关键词直接准入？ | **是**——学习词经真实链全部走 pending→Stage 2，无一直达 STRONG | §六 |
| 4 | D6 是否保证待判断任务可靠且不重复创建？ | **是**——D6 专项 17/17 检查通过 | §七 |
| 5 | 模型不可用时，系统是否安全降级？ | **是**——故障注入 27/27（含 D-DEF1 修复后回归 3 项）；且 D-DEF1 本身已修复+回归 | §八 §十 |

---

## 一、测试环境与真实 Provider 信息

| 项 | 值 |
|---|---|
| Provider / Model | **ZAI（智谱）`glm-5.3-flash`** |
| API 端点类型 | pi-ai `zai` provider（OpenAI-compatible completions，经 `PiAiRuntimeAdapter` + `@earendil-works/pi-ai` 1.2.0） |
| 凭据 | 仅引用环境变量名 `ZAI_API_KEY`（值不落盘、不写配置、报告不出现） |
| 冒烟 | 2026-11-07T09:41:51Z 起 2 样本（A1/A2）——确认 11-05 的 ZAI 429 已恢复，未产生新付费开通 |
| 全量运行 | 2026-11-07T09:42:51Z – 09:44:59Z，45 样本 / 29 次真实调用 / 0 脚本失败 |
| 延迟 | 平均 3757 ms，P95 8169 ms |
| 隔离 | 每样本独立 workspace + CODEX_HOME（os.tmpdir()），无真实 Owner 对话或生产数据 |
| WorkBuddy | 按 Owner 2026-11-05 决策不在范围 |

**实验区分真伪的说明：** 模型判定值（`{is_feedback,type,confidence,reason}`）由真实 HTTP 命中 ZAI 端点后经 adapter 的 schema 校验返回；harness 仅在分类器外层计时/计数，不改变请求内容；全部原始判定已记录于 `.tmp/pri-1147/results/codex-chain-full.jsonl`（每样本含 input_hash、逐调用延迟与判定映射）。故障注入的全部故障为受控注入（`simulated_fault` 明示标注），与真实语义运行严格分脚本，未把模拟 429/504 说成真实 Provider 故障。

## 二、实际代码调用链（Phase 0 一手核验，非文档转述）

十个环节全部按 `origin/main@e02fe63b3` 源码逐行核验。主链（Codex 持久路径）：

```text
User Correction (UserPromptSubmit)
  | processHookInvocation            codex-adapter/src/pd-hook.ts:208
  v
Ingestion                           codex-adapter/src/ingestion/ingestion.ts:313
  | governance_observations 行 + live candidate (admission.ts:35)
  v
admitGovernanceSignals              host-runtime/src/governance-signal-admission.ts:1422
  v
Stage 1 scanKeywords                core signal-collector/keyword-stage.ts:158 (P-1 守卫)
  |  high 直达 / ambiguous 候选 / 零命中拒绝
  v
Ingress 纯函数门                    governance-signal-admission.ts:1132 (refuse/observation_only→abandoned)
  v
ambiguous → insertPendingCorrectionMarker :1038 (pending_llm_review, TTL 72h, 预派生 painId)
  |
  v
Stage 2 cycle                       host-runtime/src/signal-stage2-cycle.ts:96
  |  claim :1483 (CAS+fencing) → 真实 LLM (signal-classifier.ts:68 → PiAiRuntimeAdapter)
  |  → record :1631 (attempts+1) → settle :1706
  |     correction@≥0.7 → 准入 | none@≥0.7 → resolved_none | 低置信/错误 → 重试, ≥5 abandoned
  v
Pain Admission 单事务 :1279 (pain_events + marker admitted + 限流)
  → ensureGovernanceDiagnosticianTask :2098 (state.db tasks, 实测已入队)
幂等: canonical_pain_id sha256 + UNIQUE 索引 + CAS 全程
```

与 SPEC v0.3.1 §1.2 执行顺序一致；OpenClaw 路径复用同一 Stage-1/同一分类器工厂/同一置信度门（signal-collector-host.ts:182/266/601，隔离实测产生真实 diagnostician 任务）。

## 三、Golden Dataset（45 样本 / 8 类，冻结先于任何模型调用）

- 文件 `scripts/dev/pain-real-llm-bdd/golden-dataset.json`，提交 `4801fd8b0`（09:36），早于首次 API 调用（09:41:51Z）。
- 冻结依据 = SPEC v0.3.1 语义 + Stage-1 词表 + P-1 守卫语义，未参考任何模型输出。
- 冻结预判全部命中：5 样本直达 STRONG、25 样本进 Stage 2（pending 进入率 25/25=100%）、15 样本零命中全部 not_a_signal。
- 构成：A6/B6/C5/D5/E5/F6/G6/H6；G 类预置 source=llm 学习词（跑偏了/别瞎改/不是我要的）。

## 四、测试执行记录

复现命令（worktree 根，完整说明见 `scripts/dev/pain-real-llm-bdd/README.md`；验收运行共用同一 run_id）：

```bash
RUN_ID=run-20261108T043500Z-pr2407-stage2fix
node scripts/dev/pain-real-llm-bdd/run-codex-chain.mjs --run-id $RUN_ID --provider zai --model glm-5.3-flash --apiKeyEnv ZAI_API_KEY --reasoning low
node scripts/dev/pain-real-llm-bdd/run-d6-pending.mjs --run-id $RUN_ID --provider zai --model glm-5.3-flash --apiKeyEnv ZAI_API_KEY --reasoning low
node scripts/dev/pain-real-llm-bdd/run-fault-injection.mjs --run-id $RUN_ID --provider zai --model glm-5.3-flash --apiKeyEnv ZAI_API_KEY --reasoning low
node scripts/dev/pain-real-llm-bdd/run-openclaw-host.mjs --run-id $RUN_ID --provider zai --model glm-5.3-flash --apiKeyEnv ZAI_API_KEY --reasoning low
node scripts/dev/pain-real-llm-bdd/compute-metrics.mjs --run-id $RUN_ID
```

最终验收运行元数据（`run-meta.json`）：run_id `run-20261108T043500Z-pr2407-stage2fix`；实验代码 commit `c01dde9c479d759fe2d09e17e55aaeb4d2a08f31`；dataset SHA-256 `2043116826d8e8f001afe6c3228d07b0cb0c8d0ff33ac5862869c775a9bb4a8e`；provider/model 仅记录凭据环境变量名（`ZAI_API_KEY`）。真实 Codex 主链运行 04:34:25–04:36:26 UTC，metrics 与证据归档于 04:38:25 UTC 完成；所有结果写入 `.tmp/pri-1147/runs/<run_id>/`，重跑同 run_id 无 `--append` 会被拒绝。

时间线（全部真实 HTTP 命中 ZAI，无缓存、无 mock、无预制结果；首轮 = 整改前基线运行，验收运行 = 整改后单一 run_id 贯穿四阶段）：

| 阶段 | 样本/检查 | 结果 |
|---|---|---|
| 首轮冒烟 A1/A2（09:41:51Z） | 2 样本 | A1 经真实 Stage 2 correction@0.9；A2 STRONG 直达 |
| 首轮全量（09:42:51–09:44:59Z） | 45 样本 / 29 次真实调用 | 全 ok（旧判定口径，作历史对照保留） |
| **最终验收运行：Codex 主数据集** | 45 样本 / 31 次真实调用，生产默认预算 | 全 ok，outcome_counts {admitted 26, stage1_not_admitted 15, resolved_none 4}，零执行失败 |
| **验收运行：D6 专项** | 17 检查项 | 17/17 PASS |
| **验收运行：故障注入** | 27 检查项（含 D-DEF1-postfix 回归 3 项） | 27/27 PASS（全部 simulated_fault 明示标注） |
| **最终验收运行：OpenClaw 子集** | 10 样本 / 真实漏斗 + 6 次真实 LLM 调用 | 10/10 接缝通过；6/6 LLM 调用成功；STRONG 限流抑制 1 次并生成 5 个 diagnostician 任务 |
| **最终验收运行：metrics 门禁** | dataset/d6/fault/openclaw/overall + Stage-2 证据完整性 | 五项全 TRUE，mode=full；25/25 Stage-2 行的 attempts/verdict/confidence 全部完整且与终态一致 |
| host-runtime 全套件 | 66 文件 | 全绿（exit 0） |
| stage2-cycle 回归 | 16/16（含整数超时回归） | 绿 |
| harness + metrics CLI 回归 | 47/47（38 + 9） | 绿；ESLint 通过 |

## 五、混淆矩阵与 Precision / Recall（验收运行 45 样本全量）

|  | 管线判定 Pain | 管线判定无 Pain |
|---|---|---|
| **语义真值 = 纠正（26）** | TP = 20 | FN = 6（全部为 Stage-1 关键词覆盖边界，见下） |
| **语义真值 = 非纠正（19）** | FP = 6 | TN = 13 |

- **Precision = 20/26 = 0.769**
- **Recall（仅计检测错误）= 20/20 = 1.000**——任何到达检测机制的纠正全部被识别，零漏判。
- **Recall（含覆盖边界）= 20/26 = 0.769**——6 个 FN 全部是 Stage-1 关键词零命中样本（A3/E2/E3/F1/F2/F3），这些样本按设计根本不进入检测（Codex 治理路径 `not_a_signal`），属于关键词覆盖边界而非模型误判；OpenClaw discovery 路径是 SPEC 设计的恢复通道。
- Specificity = 13/19 = 0.684；Accuracy = 33/45 = 0.733。
- **重点关注 FP（6 个）：**
  - **C4**（冻结对抗样本，按冻结预判实现）：高精度词「搞错了」处于第三人称转述「复盘写着…」中，P-1 第三人称守卫前缀列表（文档/注释/日志/报错/README）不含「复盘」→ STRONG 直达准入。守卫列表扩展属 Owner 决策，本轮未扩表。
  - **B4/C1/D4/D5/G4**（Stage-2 语义误判）：均正确进入 pending，但模型把条件句/历史引用/显式否定误判为 correction：B4（假设句）0.85、C1（转述历史发言）0.75、D4（「我没有说…不对」）0.75、D5（「我不是让你现在就改」）0.95、G4（「我并没有说跑偏了」）0.90。Stage-1 路由正确，误判发生在 Stage-2 语义层，归入 OC-2。
- **Stage-2 判定准确率：** 25/25 全部得到终态裁决，20 个符合冻结语义真值，准确率 **0.800**；未决 0。上一轮 D4 为持续低置信未决，本轮变为 correction@0.75（FP）；G3 则经 4 次调用最终 none@0.70 收敛为 resolved_none，体现模型对否定/历史语境的非确定性。
- **Pending 进入率 100%（25/25）**——所有歧义候选都按 D6 进入持久 pending 而非静默丢弃。
- **LLM 调用失败率 0%**（31/31 真实 ZAI 调用成功；无 no_verdict、无 threw）。平均延迟 3554ms，P95 6961ms。D2 与 G3 各经 4 次尝试后收敛为 resolved_none。
- **两轮对比（模型非确定性诚实记录）**：Stage-1 路由结构保持一致（STRONG 直达 5、pending 25、零命中拒绝 15）；模型语义裁决有漂移：本轮 D4 从上一轮低置信未决翻为 correction@0.75，G3 从上一轮误判 correction 翻为 none@0.70（4 次调用后收敛）。阈值附近与否定/历史语境仍需确定性处置策略，归入 OC-2。
- 置信度门与重试预算的真实行为证据（最终验收运行）：D2 与 G3 均经历 4 次真实调用，最终分别以 none@0.90 / none@0.70 收敛为 resolved_none；其间低置信和相反方向 verdict 均未被提前当作终态。

## 六、D5 专项验收（经真实调用链，非孤立函数测试）

学习词以真实投影形状写入隔离 workspace（`.state/correction_keywords.json`，source=llm），经真实生产链验证（验收运行）：

| 验收项 | 结论 | 证据 |
|---|---|---|
| 学习词只提高 Stage 2 候选优先级，永不直接 STRONG | **是** | G1/G5/G6 真实纠正样本全部先落 pending_llm_review、经真实 Stage 2 判定后才 admitted（marker 前态/后态均已记录）；G2/G3/G4 非纠正样本同样全部先经 pending——无一绕过 Stage 2 |
| 历史引用不直接创建 Pain | **是（机制层）** | G3 的 Stage-1 行为正确（学习词仅作 Stage-2 候选）；最终经 4 次真实调用以 none@0.70 收敛为 resolved_none，未创建 Pain；D5 机制未被绕过 |
| 否定语境不直接创建 Pain | **是（机制层）** | G4 的 Stage-1 行为正确（送 Stage 2）；模型以 0.9 误判 → FP，语义层归 OC-2 |
| 真正纠正经 Stage 2 正常准入 | 是 | G1/G5/G6 经真实 Stage 2 → admitted（同 §五） |
| 普通文本不因学习词命中污染 | 是 | G2（讨论）resolved_none，零 Pain |
| D5 不变量（llm 来源永不 high） | 是 | 源码层 precisionFor（governance-signal-admission.ts:166-178）+ G 类 6/6 真实链行为一致：全部经 pending→Stage 2，零直达 STRONG |

## 七、D6 Pending 专项验收（可控时钟 + 隔离 DB，17/17）

| Owner 验收项 | 检查 | 结果 |
|---|---|---|
| 创建 | S1 歧义纠正 → pending_llm_review | PASS |
| 恢复 | S2a 分类器暂不可用 → 释放 claim 不耗尝试，后续真实 cycle 恢复至 admitted；S2b 崩溃恢复（持久化 reviewResult 后无 token settle） | PASS |
| 重试 | S3 attempts 递增持久化；≤2 candidates/cycle 上限实测（3 pending 只 claim 2，第 3 个留待下轮）；5 次上限语义核验 | PASS |
| 幂等 | S4 同 payload 重放收敛（无第二 pain）；并发双 admit 收敛单 pain | PASS |
| TTL | S5a now=+72h+1ms claim 前置作废 → abandoned(ttl_expired)；S5b 已持久化 verdict 的 TTL 边界同样作废 | PASS |
| 终态 | S6 terminal payload 恰为 D6 最小字段集（decision/reason/confidence/attempts/settledAt），无 reviewResult/claimToken/trigger 残留 | PASS |
| 隐私 | S7 pending payload 最小化 + 无凭据字面量（含 sk- 模式）+ hook stderr 无键值泄漏 | PASS |

时钟全部经生产函数原生 `now` 参数注入（`claimPendingCorrectionCandidates` / `settlePendingCorrection` / `runStage2CorrectionCycle`），未等待真实 72 小时，未改动 D6 数据结构/状态机。本阶段全部 cycle 调用使用**生产默认预算**（整改前曾显式传 120s 预算规避 D-DEF1，整改后随生产修复一并去除——见 §十）。

## 八、故障与安全降级（验收运行 27/27，全部 simulated_fault 明示标注）

| 故障 | 验证内容 | 结果 |
|---|---|---|
| HTTP 429（null 形状 + 异常形状双臂） | 故障臂：瞬时失败不产生虚假准入、attempt 按生产语义处理；恢复臂：故障结束后真实 LLM 调用恢复并正确收敛 | PASS ×2 |
| HTTP 500 / HTTP 504 | 同上双臂（false admission 与虚假 Pain 均未发生） | PASS ×4 |
| Timeout | 挂起分类器被 cycle 聚合预算钳制超时 → 降级可观察，行保持 pending | PASS |
| Invalid JSON / Schema Invalid / Empty Response | adapter 层 schema 校验 + 有界修复 + 分类器接缝 null 语义 → 无错误准入 | PASS ×6 |
| Duplicate Request | 同 payload 重放 → 无重复记录、无第二个 Pain | PASS |
| Concurrent Retry | 并发双 cycle 对同一 pending → CAS/fencing 裁决，恰一 admitted、无状态竞争 | PASS ×2 |
| Process Restart | claim 后重启接管：10 分钟 claim TTL 内新 cycle 跳过（不重复审查）；过期后接管成功完成收敛；fencing token 拒绝旧持有者写回 | PASS ×4 |
| **D-DEF1-postfix（修复后回归，P1-3）** | ① 默认预算（不传 aggregateBudgetMs）下分类器收到**正整数** timeoutMs；② 真实 provider 请求**进入网络**（ok + 真实延迟 + 判定；`<50ms no_verdict` 修复前签名不得出现）；③ pending 行在默认预算下收敛终态（不再静默 abandoned(llm_error)） | PASS ×3 |

诚实声明：以上故障均为分类器接缝的受控注入（脚本与输出全程标注 `simulated: true`），未把模拟故障表述为真实 Provider 故障；验收运行真实 Provider 无自然发生的 429/504（ZAI 全程可用）。整改前的 D-DEF1 缺陷复现场景（期待旧 Bug 再次发生）已按 P1-3 移除，替换为上述修复后回归；修复前的真实复现证据保留在 §九/§十与 ERR-191。

## 九、发现的缺陷

### D-DEF1（P1，已修复，预先存在于 main）

`runStage2CorrectionCycle` 以 `performance.now()` 浮点差值计算分类超时；剩余预算 < classificationTimeoutMs 时，该分数毫秒值经 `SignalClassifierCallOptions.timeoutMs` 直达 `PiAiRuntimeAdapter.startRun` 的 `AbortSignal.timeout()`，Node 对非整数 delay 抛 `ERR_OUT_OF_RANGE`（实测确认）。生产默认参数（预算 60s == 分类超时 60s）下剩余预算几乎恒为分数 → **每次 Stage-2 分类在任何网络 I/O 之前 1ms 内失败** → `pending_llm_error` 消耗一次持久尝试 → 五个 cycle 后候选被 `abandoned(llm_error)`，全程无一次真实模型调用，且 cycle 报告 `ok:true` 无降级痕迹——静默的候选丢失循环。注意区分：PRI-1085 Phase B 当时记录的阻塞（WorkBuddy live 400 / ZAI 429 / AMD 504）是 Provider 侧错误，与 D-DEF1 是不同失败类别；但两者在运维观测上都表现为"Stage 2 不可用"。

发现路径本身值得记录：实验 harness 最初传入显式 120s 聚合预算，`Math.min` 落在整数常量上而掩盖了缺陷；故障注入轮使用生产默认参数后缺陷暴露。已按 ERR-191 记录。

## 十、修复及回归证据（含整改轮）

### D-DEF1 修复（历史轮，生产代码）

- **修复**：`packages/host-runtime/src/signal-stage2-cycle.ts` —— 剩余预算钳制为整数毫秒（`Math.floor`），生产者处修复，预算语义不变。**整改轮确认保留，未回退。**
- **回归测试**：`packages/host-runtime/tests/signal-stage2-cycle.test.ts` "分类器必须收到整数毫秒超时"（**默认预算**下断言 `Number.isInteger(timeoutMs)` + 候选仍 admitted）。
- **修复前证据（保留）**：真实 Provider 默认预算复现 1ms 瞬败（`no_verdict`、attempt 消耗、cycle 报告 ok）；修复后同样本 3.1s 真实调用 correction@0.9 → admitted。原 fault 脚本中"期待旧 Bug 再次发生"的 D-DEF1 场景已替换为 D-DEF1-postfix 修复后回归（见 §八）。
- **验证**：signal-stage2-cycle 16/16 绿；host-runtime 全套件 66 文件全绿；`check:error-handbook` OK；changeset（patch）已附。

### 整改轮（P1-1/P1-2/P1-3/P2，harness 层，零生产代码改动）

1. **P1-1 判定与退出码**：8 态结局分类学（`lib/outcomes.mjs`）；hook 失败/缺 observation/classifier 不可用 → `execution_error`/`classifier_unavailable`，永不充当语义 NONE；`runStage2UntilTerminal` 耗尽循环数 → `pending_unresolved`（读真实持久化状态，不是 NONE）；低置信/错误耗尽 5 次 → `abandoned_*` 单列（不计入 Stage-2 准确率分母）；summary `ok=false` 时进程退出码 1（冒烟实测：拒绝覆盖 exit 1、partial metrics exit 1、缺失 run exit 1）。
2. **P1-2 运行隔离**：单一 run_id 贯穿四阶段；结果仅写 `.tmp/pri-1147/runs/<run_id>/`；已存在结果默认拒绝运行（`--append` 显式授权）；完整性校验 45/唯一/无缺/无重/无执行失败；`run-meta.json` 记录 git SHA + dataset SHA-256 + provider/model（仅凭据名）+ 各阶段时间。
3. **P1-3 默认预算**：主 BDD `runStage2UntilTerminal` 不再人为传 120s 预算——与生产 worker 相同的默认预算（60s==60s）跑完全部 45 样本；D6 与故障注入的全部直接 cycle 调用同步去掩码（仅 F-TIMEOUT 保留 2s 分类超时，其测试目的即超时形状本身）。**最终验收运行证明：生产默认预算下 31/31 真实调用成功**——这是 D-DEF1 修复后的真实全量证据。
4. **P2 门禁**：`compute-metrics` 五状态（dataset_ok/d6_ok/fault_injection_ok/openclaw_ok/overall_ok）+ 跨阶段 run_id 一致性 + 缺失专项即 fail + partial 模式永不 PASS。
5. **Stage-2 证据闭环（最终复核 P1-B）**：admitted settlement 会用 pain-event payload 替换 review payload；验收器现从真实测量的 classifier-call trace 补齐 scalar attempts/verdict/confidence，并以持久化 marker terminal decision 为最终裁决依据。`validateDatasetRows` 对所有已裁决 Stage-2 样本强制校验 attempts、confidence、verdict 与终态一致，缺失/矛盾即 dataset gate fail，不允许 summary-only PASS。最终真实运行 25/25 完整。
6. **回归测试**：harness 38 项 + metrics CLI 9 项，共 47/47；覆盖 Stage-2 admitted/D6-terminal/pending/no-verdict 证据形状、缺失字段负控、终态矛盾负控、脱敏输出、实验锁、dist fingerprint 和 CLI fail-closed。默认预算整数 timeout 由 host-runtime 回归 + D-DEF1-postfix 实测覆盖。

## 十一、未完成事项与限制

1. **单 Provider**：全部真实调用仅覆盖 ZAI `glm-5.3-flash`（ZAI 全程可用，按工单"ZAI 优先"未启用 AMD 备选；DeepSeek 按工单要求未事先确认故未使用）。多 Provider 交叉验证未做。
2. **OpenClaw 子集规模**：10 样本（覆盖 STRONG 直达/歧义确认/零命中 discovery/学习词/历史引用），非全 45 样本；漏斗证据以真实 diagnostician 任务 + evolution.jsonl 为主，成功路径在 PAIN_* 日志层静默（已在输出中诚实标注）。
3. **`pd codex worker --once` CLI 入口未单独驱动**：Stage 2 经生产函数 `runStage2CorrectionCycle`（worker cycle 的最后一步，同一函数、同一真实分类器解析路径）验证；worker CLI 的 catch-up/reconcile/downstream 前置步骤不在本轮范围。
4. **6 个 FP 与 6 个覆盖边界 FN 未修复**——属检测语义/词表设计决策，见 §十二 Owner 决策卡；按指令"不得改变已批准的 D5/D6 行为、不处理 OC-1～OC-4"执行。
5. **模型语义非确定性**：两轮全量运行间，Stage-1 路由结构稳定，但 Stage-2 语义判定有漂移：本轮 D4 从上一轮低置信未决翻为 correction@0.75（FP），G3 从上一轮 correction 翻为 none@0.70（4 次调用后收敛）。任何单轮 Precision/Stage-2 准确率都是该模型在该时点的采样值，不代表确定性的上限——见 OC-2。
6. 证据产物：原始运行记录在 `.tmp/pri-1147/runs/run-20261108T043500Z-pr2407-stage2fix/`（gitignored，含逐样本判定/延迟）；**最终脱敏证据已入库** `docs/reports/evidence/pri-1147-run-20261108T043500Z-pr2407-stage2fix/`。证据含 25/25 Stage-2 attempts/verdict/confidence 与四个 OpenClaw dist 完整 SHA-256；`final_outcome_reason` 仅含命中词片段或模型一句话判定理由，不含样本完整原文、日志或凭据。

## 十二、最终裁定与 Owner 决策卡

### 裁定：**READY_FOR_OWNER_REVIEW**

整改指令 §九 的十二问逐项回答：

1. **本轮修复了哪些真实缺陷？** 原始三项 P1：①BDD 失败判定（hook 失败/classifier 不可用/循环耗尽曾被静默当作正常语义结果；现按 8 态分类学判定，退出码如实反映失败）；②重复运行数据污染（现 run_id 隔离、拒绝覆盖并校验完整性）；③D-DEF1 验收语义不一致（移除旧 Bug 复现场景与 120s 掩码，使用生产默认预算 + 修复后回归）。另关闭最终复核 P1-B：Stage-2 admitted payload 替换导致证据字段缺失，改为真实 classifier trace 回填并在 metrics 层 fail closed。P2 门禁亦已补齐（五状态门禁 + run_id 一致性 + OpenClaw dist fingerprint）。
2. **哪些生产代码保持不变？** 除 D-DEF1 整数钳制（历史轮，保留未回退）外，本轮零生产代码改动——检测语义、D5/D6 行为、词表、prompt、阈值全部未动。
3. **三个 P1 是否全部关闭？** 是（P1-1/P1-2/P1-3 全部实现 + 冒烟/回归验证，见 §十）。
4. **是否解决重复实验污染？** 是——同 run_id 重跑被拒绝（exit 1 实测），metrics 只读指定 run_id，跨阶段 run_id 错配即 fail。
5. **是否真正使用生产默认预算完成真实 Provider 调用？** 是——最终运行全部 45 样本经默认预算（无 aggregateBudgetMs 覆盖），31/31 真实 ZAI 调用成功（D-DEF1-postfix 另有专项检查：整数 timeout + 真实网络延迟 + 判定）。
6. **45 个样本是否完整且唯一？** 是——45/45，唯一，无缺失/多余/重复，零执行失败（compute-metrics dataset_ok=TRUE）。
7. **Precision / Recall / Stage-2 Accuracy 是否重新计算？** 是——Precision 0.769；Recall（检测错误口径）1.000；Recall（含覆盖边界）0.769；Specificity 0.684；Accuracy 0.733；Stage-2 Accuracy 0.800（25/25 决定，未决 0）。
8. **D6 是否 7/7 通过？** 是——S1–S7 七组 17/17 检查全 PASS。
9. **故障注入是否全部通过？** 是——27/27（含 D-DEF1-postfix 3 项），全部 simulated_fault 明示标注，与真实语义运行分脚本。
10. **OpenClaw 是否 10/10 通过？** 是——真实 SignalCollectorHost seam 10/10，另含 STRONG 限流实测。
11. **CI 是否全部通过？** 以最新 PR #2407 checks 为准；本报告更新时 CodeQL / CI / pd-console E2E 仍在运行，其余已完成检查通过，不提前宣称全绿。
12. **是否还有影响合并的 P0/P1？** 目前未发现；最终复核 P1-B 已通过 25/25 真实 Stage-2 证据闭环与 fail-closed 负控。CI 全绿后即可合并。

**遗留 P0/P1：无已知未关闭项；CI 尚待最终完成。** 不以总体测试通过掩盖任何未执行项；上述限制均为诚实实测边界。

### 需 Owner 决策的发现（本轮均未擅自修改，仅记录）

| # | 发现 | 性质 | 建议方向 |
|---|---|---|---|
| OC-1 | P-1 第三人称守卫前缀列表不含「复盘写着/报告写着/会议纪要」类转述 | 词表覆盖边界（C4 冻结对抗样本两轮均实现为 FP） | 扩守卫前缀列表，或接受 STRONG 直达 + 事后降噪 |
| OC-2 | Stage 2 模型在显式否定/假设/历史语境的误判（本轮 B4/C1/D4/D5/G4 为 FP；D4 与 G3 两轮间翻转，0.7–0.75 边界） | 模型语义可靠性 | prompt 增补否定/历史语境定义，或提高 confirm 阈值，或对含显式否定标记/阈值边缘的 correction 判定强制二次确认 |
| OC-3 | Stage-1 关键词零命中的真实纠正（6 例）在 Codex 治理路径不可见 | 设计覆盖边界（SPEC 既定，非缺陷） | 依赖 OpenClaw discovery 恢复通道；或 Owner 批准扩大 Stage-1 词表 |
| OC-4 | D-DEF1 修复仅覆盖 cycle 生产者；`pi-ai-runtime-adapter.ts:571` 健康探针路径的 config timeout 理论上也可为分数 | 纵深防御候选 | 可选：adapter 侧统一钳制（独立小 PR） |

### 留痕

- D-DEF1 修复提交：`f1797cb37`（fix(host-runtime): clamp Stage-2 classification timeout to whole ms (ERR-191)）
- 整改轮提交：harness 判定/隔离/门禁 + README + 本报告（本分支）
- 冻结数据集提交：`4801fd8b0`（早于全部模型调用；dataset SHA-256 `20431168…` 记录于 run-meta.json）
- ERR-191：`docs/process/error-management/records/patterns/P-20261107T103850Z-3ghz2gqkg6.md`（check:error-handbook OK）
- 最终脱敏证据：`docs/reports/evidence/pri-1147-run-20261108T043500Z-pr2407-stage2fix/`
- Linear：PRI-1147 状态未在本轮修改（按指令）；PRI-1085 已有真实 BDD 证据评论。
