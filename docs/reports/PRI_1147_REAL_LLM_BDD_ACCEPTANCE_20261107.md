# PRI-1147 — Pain 真实 LLM BDD 与检测可靠性验收报告

**状态：** READY_FOR_OWNER_REVIEW
**日期：** 2026-11-07
**执行分支：** `test/pain-real-llm-bdd-pri-1147-20261107`（基于 `origin/main@e02fe63b3`）
**关联：** SPEC `docs/specs/SPEC-PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE-001-v0.3.1.md` §7.1–§7.3、§8；SPEC `docs/specs/SPEC-PD-CROSS-HOST-KEYWORD-PAIN-001-v0.2.md`
**冻结证据：** Golden Dataset 于任何模型调用前冻结并提交（`4801fd8b0`，早于首个 API 调用 2026-11-07T09:41:51Z）

---

## 〇、最终裁定：**PASS_WITH_LIMITATIONS**

真实 LLM BDD 已完成且核心判定链路可靠；发现并修复一个**预先存在的 P1 生产缺陷**（D-DEF1，修复+回归+ERR-191 入库）；检测语义指标为诚实实测值，四个 FP 与六个 Stage-1 覆盖边界 FN 需 Owner 决策（不构成本轮修复范围）。

**Owner 五问对照：**

| # | Owner 关注点 | 结论 | 证据 |
|---|---|---|本报告 §4/§5 |
| 1 | 真实纠正能否被识别？ | **能**（检测错误 FN=0；关键词覆盖边界内 20/20 全部识别） | §五 |
| 2 | 普通讨论能否被排除？ | **能**（TN=15；4 FP 中 1 个为冻结对抗样本 C4、3 个为模型语义误判，需 Owner 决策） | §五 §九 |
| 3 | D5 是否避免关键词直接准入？ | **是**——学习词经真实链全部走 pending→Stage 2，无一直达 STRONG | §六 |
| 4 | D6 是否保证待判断任务可靠且不重复创建？ | **是**——17/17 检查通过（创建/恢复/重试/幂等/TTL/终态/隐私） | §七 |
| 5 | 模型不可用时，系统是否安全降级？ | **是**——26/26 故障注入检查通过；且本轮发现并修复了默认预算下每次分类秒败并耗尽尝试的 P1 缺陷 | §八 §十 |

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

复现命令（worktree 根，完整说明见 `scripts/dev/pain-real-llm-bdd/README.md`）：

```bash
node scripts/dev/pain-real-llm-bdd/run-codex-chain.mjs --label full --provider zai --model glm-5.3-flash --apiKeyEnv ZAI_API_KEY --reasoning low
node scripts/dev/pain-real-llm-bdd/run-d6-pending.mjs --provider zai --model glm-5.3-flash --apiKeyEnv ZAI_API_KEY --reasoning low
node scripts/dev/pain-real-llm-bdd/run-fault-injection.mjs --provider zai --model glm-5.3-flash --apiKeyEnv ZAI_API_KEY --reasoning low
node scripts/dev/pain-real-llm-bdd/run-openclaw-host.mjs --provider zai --model glm-5.3-flash --apiKeyEnv ZAI_API_KEY --reasoning low
node scripts/dev/pain-real-llm-bdd/compute-metrics.mjs
```

时间线（全部真实 HTTP 命中 ZAI，无缓存、无 mock、无预制结果）：

| 阶段 | 样本/检查 | 结果 |
|---|---|---|
| 冒烟 A1/A2（09:41:51Z） | 2 样本 | A1 经真实 Stage 2 correction@0.9；A2 STRONG 直达 |
| 全量（09:42:51–09:44:59Z） | 45 样本 / 29 次真实调用 | 全 ok，零脚本失败 |
| D6 专项 | 17 检查项 | 17/17 PASS |
| 故障注入 | 26 检查项 | 26/26 PASS（全部 simulated_fault 明示标注） |
| OpenClaw 子集 | 10 样本 / 6 次真实调用 | 10/10 接缝通过 |
| host-runtime 全套件 | 66 文件 | 全绿（exit 0） |
| stage2-cycle 回归 | 16/16（含新增回归） | 绿 |

## 五、混淆矩阵与 Precision / Recall（45 样本全量）

|  | 管线判定 Pain | 管线判定无 Pain |
|---|---|---|
| **语义真值 = 纠正（26）** | TP = 20 | FN = 6（全部为 Stage-1 关键词覆盖边界，见下） |
| **语义真值 = 非纠正（19）** | FP = 4 | TN = 15 |

- **Precision = 20/24 = 0.833**
- **Recall（仅计检测错误）= 20/20 = 1.000**——任何到达检测机制的纠正全部被识别，零漏判。
- **Recall（含覆盖边界）= 20/26 = 0.769**——6 个 FN 全部是 Stage-1 关键词零命中样本（A3/E2/E3/F1/F2/F3），这些样本按设计根本不进入检测（Codex 治理路径 `not_a_signal`），属于关键词覆盖边界而非模型误判；OpenClaw discovery 路径是 SPEC 设计的恢复通道。
- Specificity = 15/19 = 0.789；Accuracy = 35/45 = 0.778。
- **重点关注 FP（4 个）：**
  - **C4**（冻结对抗样本，按冻结预判实现）：高精度词「搞错了」处于第三人称转述「复盘写着…」中，P-1 第三人称守卫前缀列表（文档/注释/日志/报错/README）不含「复盘」→ STRONG 直达准入。守卫列表扩展属 Owner 决策，本轮未扩表。
  - **B4/D5/G4**（模型语义误判，3 个）：全部含显式否定/假设语境（「如果用户觉得…不对」「我不是让你现在就改」「我并没有说跑偏了」），Stage-2 模型以 0.75/0.9/0.95 置信度误判为 correction。Stage 1 行为全部正确（正确降级/正确送 Stage 2）；误判发生在语义层。
- **Stage 2 判定准确率：** 到达 Stage 2 的 25 样本中 22 个终态符合语义真值 = **0.880**；3 个误判即上述 B4/D5/G4。
- **Pending 进入率 100%（25/25）**——所有歧义候选都按 D6 进入持久 pending 而非静默丢弃。
- **LLM 调用失败率 0%**（29/29 ok；无 no_verdict、无 threw）。平均延迟 3757ms，P95 8169ms。
- 置信度门与重试预算的真实行为证据：C1 首判 correction@0.6（<0.7 → pending_low_confidence，不伪装终态）→ 重试 none@0.7 → resolved_none；G3 在 4 次调用中置信度围绕阈值波动（0.6/0.6/0.6correction/0.75none），attempts 持久递增，最终 none@0.75 收敛终态——阈值、尝试预算与终态收敛按 SPEC 工作。

## 六、D5 专项验收（经真实调用链，非孤立函数测试）

学习词以真实投影形状写入隔离 workspace（`.state/correction_keywords.json`，source=llm），经真实生产链验证：

| 验收项 | 结论 | 证据 |
|---|---|---|
| 学习词只提高 Stage 2 候选优先级，永不直接 STRONG | **是** | G1/G5/G6 真实纠正样本全部先落 pending_llm_review、经真实 Stage 2 判定后才 admitted（marker 前态/后态均已记录）；G2/G3/G4 非纠正样本全部 resolved_none，无 Pain 污染 |
| 历史引用不直接创建 Pain | 是 | G3（历史复盘转述）经 Stage 2 → resolved_none |
| 否定语境不直接创建 Pain | 是 | G4 的 Stage-1 行为正确（学习词为歧义精度，送 Stage 2）；但 Stage 2 模型以 0.95 误判 → FP，语义层问题归 §10 |
| 真正纠正经 Stage 2 正常准入 | 是 | G1/G5/G6 20 项指标同 §五 |
| 普通文本不因学习词命中污染 | 是 | G2（讨论）resolved_none，零 Pain |
| D5 不变量（llm 来源永不 high） | 是 | 源码层 precisionFor（governance-signal-admission.ts:166-178）+ G 类 6/6 真实链行为一致 |

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

时钟全部经生产函数原生 `now` 参数注入（`claimPendingCorrectionCandidates` / `settlePendingCorrection` / `runStage2CorrectionCycle`），未等待真实 72 小时，未改动 D6 数据结构/状态机。

## 八、故障与安全降级（26/26，全部 simulated_fault 明示标注）

| 故障 | 验证内容 | 结果 |
|---|---|---|
| HTTP 429（null 形状 + 异常形状双臂） | 故障臂：瞬时失败不产生虚假准入、claim 释放/尝试按生产语义处理；恢复臂：故障结束后真实 LLM 调用恢复并正确收敛 | PASS ×2 |
| HTTP 500 / HTTP 504 | 同上双臂（false admission 与虚假 Pain 均未发生） | PASS ×4 |
| Timeout | 挂起分类器被 cycle 聚合预算钳制超时 → 降级可观察，行保持 pending | PASS |
| Invalid JSON / Schema Invalid / Empty Response | adapter 层 schema 校验 + 有界修复 + 分类器接缝 null 语义 → 无错误准入 | PASS ×6 |
| Duplicate Request | 同 payload 重放 → 无重复记录、无第二个 Pain | PASS |
| Concurrent Retry | 并发双 cycle 对同一 pending → CAS/fencing 裁决，恰一 admitted、无状态竞争 | PASS |
| Process Restart | claim 后重启接管：10 分钟 claim TTL 内新 cycle 跳过（不重复审查）；过期后接管成功完成收敛；fencing token 拒绝旧持有者写回 | PASS ×4 |
| D-DEF1 复现 + 交叉验证 | 真实分类器默认预算 1ms 瞬败 vs 显式 120s 预算正常分类 | PASS ×2 |

诚实声明：以上故障均为分类器接缝的受控注入（脚本与输出全程标注 `simulated: true`），未把模拟故障表述为真实 Provider 故障；本轮真实 Provider 无自然发生的 429/504（ZAI 全程可用）。

## 九、发现的缺陷

### D-DEF1（P1，已修复，预先存在于 main）

`runStage2CorrectionCycle` 以 `performance.now()` 浮点差值计算分类超时；剩余预算 < classificationTimeoutMs 时，该分数毫秒值经 `SignalClassifierCallOptions.timeoutMs` 直达 `PiAiRuntimeAdapter.startRun` 的 `AbortSignal.timeout()`，Node 对非整数 delay 抛 `ERR_OUT_OF_RANGE`（实测确认）。生产默认参数（预算 60s == 分类超时 60s）下剩余预算几乎恒为分数 → **每次 Stage-2 分类在任何网络 I/O 之前 1ms 内失败** → `pending_llm_error` 消耗一次持久尝试 → 五个 cycle 后候选被 `abandoned(llm_error)`，全程无一次真实模型调用，且 cycle 报告 `ok:true` 无降级痕迹——静默的候选丢失循环。注意区分：PRI-1085 Phase B 当时记录的阻塞（WorkBuddy live 400 / ZAI 429 / AMD 504）是 Provider 侧错误，与 D-DEF1 是不同失败类别；但两者在运维观测上都表现为"Stage 2 不可用"。

发现路径本身值得记录：实验 harness 最初传入显式 120s 聚合预算，`Math.min` 落在整数常量上而掩盖了缺陷；故障注入轮使用生产默认参数后缺陷暴露。已按 ERR-191 记录。

## 十、修复及回归证据

- **修复**：`packages/host-runtime/src/signal-stage2-cycle.ts` —— 剩余预算钳制为整数毫秒（`Math.floor`），生产者处修复，预算语义不变。
- **回归测试**：`packages/host-runtime/tests/signal-stage2-cycle.test.ts` 新增"分类器必须收到整数毫秒超时"（默认预算下断言 `Number.isInteger(timeoutMs)` + 候选仍 admitted）；红→绿证据：修复前真实 Provider 默认预算复现 1ms 瞬败，修复后同样本 3.1s 真实调用 correction@0.9 → admitted。
- **验证**：signal-stage2-cycle 16/16 绿；host-runtime 全套件 66 文件全绿；`check:error-handbook` OK；changeset（patch）已附。
- **定位依据**：EP-03 已在 error:context Pass 1 命中，其"降级可观察/失败不伪装成功"要求与本次修复方向一致。

## 十一、未完成事项与限制

1. **单 Provider**：全部真实调用仅覆盖 ZAI `glm-5.3-flash`（ZAI 全程可用，按工单"ZAI 优先"未启用 AMD 备选；DeepSeek 按工单要求未事先确认故未使用）。多 Provider 交叉验证未做。
2. **OpenClaw 子集规模**：10 样本（覆盖 STRONG 直达/歧义确认/零命中 discovery/学习词/历史引用），非全 45 样本；漏斗证据以真实 diagnostician 任务 + evolution.jsonl 为主，成功路径在 PAIN_* 日志层静默（已在输出中诚实标注）。
3. **`pd codex worker --once` CLI 入口未单独驱动**：Stage 2 经生产函数 `runStage2CorrectionCycle`（worker cycle 的最后一步，同一函数、同一真实分类器解析路径）验证；worker CLI 的 catch-up/reconcile/downstream 前置步骤不在本轮范围。
4. **4 个 FP 与 6 个覆盖边界 FN 未修复**——属检测语义/词表设计决策，见 §十二 Owner 决策卡；按指令"不得改变已批准的 D5/D6 行为、架构级缺陷形成 Decision Card"处理。
5. 证据产物（结果 JSONL、summary、临时 workspace）在 `.tmp/pri-1147/` 与 os.tmpdir() 运行根（gitignored）；报告内数字均可在本 worktree 用 §四命令复现。

## 十二、最终裁定与 Owner 决策卡

### 裁定：**PASS_WITH_LIMITATIONS**

理由：五个 Owner 关注点全部取得真实模型参与下的证据；核心检测机制（检测错误 FN=0、pending 进入率 100%、D5 不变量、D6 七项、故障安全降级）全部按 SPEC 工作；一个预先存在的 P1 生产缺陷在真实实验中被发现、修复并回归。限制均为诚实实测边界（FP/覆盖边界/单 Provider/子集规模），不掩盖任何未执行项。

### 需 Owner 决策的发现（本轮均未擅自修改）

| # | 发现 | 性质 | 建议方向 |
|---|---|---|---|
| OC-1 | P-1 第三人称守卫前缀列表不含「复盘写着/报告写着/会议纪要」类转述 | 词表覆盖边界（C4 冻结对抗样本实现为 FP） | 扩守卫前缀列表，或接受 STRONG 直达 + 事后降噪 |
| OC-2 | Stage 2 模型在显式否定/假设语境的 3 例误判（B4/D5/G4，置信度 0.75–0.95） | 模型语义可靠性 | prompt 增补否定/历史语境定义，或提高 confirm 阈值，或对含显式否定标记的 correction 判定强制二次确认 |
| OC-3 | Stage-1 关键词零命中的真实纠正（6 例）在 Codex 治理路径不可见 | 设计覆盖边界（SPEC 既定，非缺陷） | 依赖 OpenClaw discovery 恢复通道；或 Owner 批准扩大 Stage-1 词表 |
| OC-4 | D-DEF1 修复仅覆盖 cycle 生产者；`pi-ai-runtime-adapter.ts:571` 健康探针路径的 config timeout 理论上也可为分数 | 纵深防御候选 | 可选：adapter 侧统一钳制（独立小 PR） |

### 留痕

- 修复提交：`fix(host-runtime): clamp Stage-2 classification timeout to whole ms (ERR-191)`（本分支）
- 冻结数据集提交：`4801fd8b0`（早于全部模型调用）
- ERR-191：`docs/process/error-management/records/patterns/P-20261107T103850Z-3ghz2gqkg6.md`（check:error-handbook OK）
- Linear：PRI-1147 保持未 Done（真实 BDD 完成但上述 Owner 决策未决，最终验收权在 Owner）；PRI-1085 已回写证据评论。
