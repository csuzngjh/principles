# EXAMINER v0.7 核心缺陷一次性修复 · 最终报告（PR #2239 修复轮）

日期：2026-10-31 · 修复提交：`0a327cb0c`（基于评审 HEAD `3b36f273f` 增量提交，未重写历史、未 force push）
目标 PR：[#2239](https://github.com/csuzngjh/principles/pull/2239)（OPEN / MERGEABLE / 未合并）

---

## A. 缺陷闭环

| ID | 根因 | 修复 | 红→绿测试 | 状态 |
|---|---|---|---|---|
| P1-1 | 隔离验证接受配置声明+非空字符串即判 VERIFIED，无实际加载证明 | 重构为 Actual Load Evidence 模型：`collectOfflineStubLoadEvidence`（Runner 唯一离线生产者，canonical evidenceHash 防篡改）+ DECLARED/LOADED/VERIFIED 三态 + Principle/RuleCode 实际加载校验 + commonContext 重绑冻结值 + 宿主类变量离线=UNKNOWN（`ISOLATION_VERIFIED_OFFLINE_SCOPE`，绝不冒充全证）、真实宿主缺探针证据=拒绝；随机化需**已执行**的 order 记录（strategy+seed+actualOrder），声明不算 | 指令 9 项反例全落地 + 「声明-only 输入被拒」回归（该输入形态正是修复前被接受的）+ real-host 全证据全证路径，21 项 | **CLOSED** |
| P1-2 | 空谓词（全空数组/字段缺失/仅 Exception）的 applicable 案例可得 PC=PASS | 双层：① env validator 要求 required+prohibited+boundary ≥1（Exception 不计）否则拒绝构建；② scorer 独立 fail-closed——零可评谓词 → INDETERMINATE（绕过 validator 的数据也覆盖：v2-base 重建失败时诚实降级而非 crash/PASS） | 3 项绕过-validator 红→绿 + validator 拒绝 + NOT_APPLICABLE/正常语义不变，共 5 项 | **CLOSED** |
| P1-3 | BFRR 未计计划中未产生记录的单元（分母可被未完成缩小）；配对从已执行记录反推，缺失侧使整对消失；Δ 无全计划界 | `missingPlannedUnits = planned − observed` 计入 UNKNOWN（12 计划/6 观察/6 全败 → 6/12–12/12）；units>planned 与重复 unitId 抛错；`buildPlannedPairs` 从预注册 plan 生成完整配对集（每对含双侧执行状态/F/pairValidity/unknownReason/invalidityReason，缺侧不弃对）；PCR/FIR 消费计划配对集；`computePairedEffect` 增 fullPlanLower/UpperBound（单侧未知跨 {0,1}，双侧 [-1,+1]，completeCaseDelta 与全计划结果显式分离） | BFRR 4 项（含红→绿 12/6/6）、Δ 界 4 项、计划配对 1 项（三态配对/双侧未启动/FAILED_KNOWN 原因）+ 既有零分母/UNKNOWN 臂用例回归 | **CLOSED** |
| P1-4 | VBDR 用 `some()&&some()` 跨 repetition 拼接配对；缺失重复被记为 unstable；`adjudicatedNotNoise=null` 硬编码；`relatedToTargetMechanism=true` 无依据直赋 | `projectVBDRCase`：按 (caseId, repetitionId) 精确配对（pairedValid 要求**每个**计划重复双侧有效）；repetitionStable 三态（全完整一致=STABLE／全完整不一致=UNSTABLE／任一缺失=UNKNOWN，永不混淆）；独立噪声裁定经 `noise-adjudications.json`（绑定 caseId+双侧主 trace hash+机制族+决定/依据/来源；缺失或错绑 → INDETERMINATE；NOISE → falsePositive）；机制关联仅在 mapping 自 hash 复验通过且 F 派生已注册（EVIDENCE_ALIGNMENT↔PAIN44）时 VERIFIED | 11 项：跨重复拼接（红）、同重复完整、双侧有记录但无配对、真不一致 vs 缺失、裁定缺失/错绑/NOISE/通过、机制不绑定、六条件全过、REJECTED≠PENDING | **CLOSED** |
| P2 | 六项语义收口 | P2-1 空事件集仅完整轨迹=NOT_DETECTED（overChecking/repeatedConfirmation 同步）；P2-2 Gold 三态分计（REJECTED≠PENDING，VBDR/分母/coverage 三处）；P2-3 authorized 从实际授权记录计算，离线=null+说明（不再恒等式冒充）；P2-4 重复确认基于完整 owner 请求序列（成功+预算拒+结构拒，同 requestType 第 2+ 次计重复，不可辨=UNKNOWN，不同类型不算）；P2-5 `retryCount`→`repeatedObservationCount`（名实一致）；P2-6 空成本包络 validator 拒绝 + scorer 防御（无有效阈值=UNKNOWN，绝不隐含未超限） | P2-1/P2-5/P2-6 红→绿各含正向不变用例；P2-2/P2-3/P2-4 由 report/statistics 断言覆盖 | **CLOSED** |

**额外发现并修复**（修复过程中红测试暴露）：v3 输出字段拼写错误 `base.faltyCorrect` → undefined；因 canonicalJson 会字面序列化 undefined 而 JSON round-trip 丢弃该键，导致 adjudication 不可 round-trip、重放 hash 漂移。已修复并在代码内留注（该缺陷使 P1-2 绕过路径的 SCORE_REPLAY_MISMATCH 显形）。

## B. 统计验证（输入→输出样例）

1. **BFRR 完整计划分母**：12 计划、6 观察（全 F=1）、6 未观察 → `rate=6/6`（点估计只看有效单元）、`bounds.lower=6/12=0.5`、`bounds.upper=12/12=1.0`、`missingPlannedUnits=6`。观察数>计划数、重复 unitId → 抛错（计划外证据是契约违规）。
2. **PCR/FIR 未知上下界**：baseline 失败对 (1,0)×2 + (1,UNKNOWN)×2 → 点估计 2/2，lower=2/4=0.5，upper=4/4=1.0；UNKNOWN 对保留在 sensitivity。Control UNKNOWN 对既不进 baseline-failure 也不进 non-failure 分母（不误判基线成败）。
3. **Δ 全计划敏感性界**：3 计划对 = (1,0)+(1,UNK)+(UNK,UNK) → `completeCaseDelta=+1/1`，`fullPlanLower=(1+0−1)/3=0`，`fullPlanUpper=(1+1+1)/3=1.0`。执行无效侧按未知参与区间。
4. **VBDR 精确重复配对**：R1(C 有效,T UNKNOWN)+R2(C UNKNOWN,T 有效) → `pairedValid=false`（`repetitionCoverage={r1:false,r2:false}`）——旧 `some()&&some()` 会判 true 的用例（红）。
5. **UNKNOWN≠UNSTABLE**：R1 完整 (1,0)+R2 双侧未启动 → `repetitionStable=null`；R1 (1,0)+R2 (0,0) → `repetitionStable=false`（真实观察到的不一致）。
6. **六条件门**：全过（APPROVED+每重复配对+STABLE+差异+机制 VERIFIED+裁定 CONFIRMED）→ ESTIMABLE 1/1；裁定缺失或机制未验 → INDETERMINATE（绝不强行 0%）；裁定 NOISE → falsePositive=1。

## C. 兼容性验证

- v1/v2 评分函数与输出**零改动**：`adjudicateClaimEvidenceV2`/env v1/v2 步进未被触碰；v2 输出仍保留历史字段对（`behaviorAligned≡principleBehaviorAligned`，既有测试断言原样通过）。
- v4 九题冻结复算：`run-exm-mvp-offline.mjs` 9/9，**executionsHash `97e2d4e7…` 跨轮逐字节不变**（rebind 前后与上轮一致）。
- CEB-001/002/003-P freeze verify `VERIFY OK` ×3（12/16/16 题）。
- 历史 REPORT_READY 未触碰；Report V2 为独立 schema/文件/事件。

## D. 历史资产验证

- **675 个基线冻结文件（9 根：CEB-001/002/003-P、EXM v1/v3、四个执行归档）SHA-256 前后完全一致**（`.tmp/examiner-v07/frozen-baseline.json` vs `frozen-after-repair.json`）。
- v4 包：inputs/gold-review/revision/source-audit/source-verification 逐文件不变；唯一变化 = rebind 派生件（packageHash `010ec346→5c55977c` 经由已提交 rebind 工具；expected-replay 仅 implementationHash 及其派生 reportHash 移动；Owner 内容评审意见、mappingHash、逐题 goldHash 不变；盲审包条目内容一致）。历史执行行、历史报告、PRI-1037/1038/F1/F2 归档零改动、零重跑。

## E. 安全验证

| 检查项 | 结果 | 证据 |
|---|---|---|
| Real Model Calls | **0** | 全部纯函数/确定性环境；无 transport 构造 |
| Real Host Runs | **0** | 未启动宿主/探针；Stage G/R/F2 授权未触碰 |
| Production Writes | **0** | 仅研究 lib/测试/文档 + 既定 rebind；无生产包/治理/部署改动 |
| External Network Calls | **0** | 新增/改动模块 grep `fetch(`/`http`/`node:net` = 0 |
| Historical Asset Mutation | **0** | §D |
| Gate 1 | **BLOCKED**（不变；独立人审未发生） | GATE_ASSESSMENT 未放宽 |
| Phase 6 | **NOT STARTED** | 无任何真实实验路径 |

## F. Git 交付

- 修复提交：`0a327cb0c`（PR #2239 原分支增量提交；基线 `3b36f273f` 与评审参考一致；无历史重写、无 force push）
- 最终 HEAD：`0a327cb0c`（本地=远端，推送后确认）
- PR：https://github.com/csuzngjh/principles/pull/2239
- CI：以 PR checks 实时状态为准（本地等效证据：scripts 全量 `--maxWorkers=2` 97 文件/1829 项全绿 + eslint 零错误 + `check:docs-structure`/`check:error-handbook` OK；默认全并行下 3 项跨 worker `.pd-test-temp` 干扰失败，隔离复跑 72/72 绿——非回归，参数与历史验收一致）
- 工作区：干净（除 .tmp/ 会话工件，gitignored）

## G. 最终裁定

**READY_FOR_OWNER_REVIEW** —— 四项 P1 全部修复且各有红→绿证据；影响统计语义与结果解释的 P2 全部收口；v1/v2 历史兼容与 675 冻结文件完整性经复算证明；全量测试通过。PR 保持 OPEN，未合并、未部署、未启动真实实验、未解除 Gate 1 BLOCKED、未进入 Phase 6。

---

### Owner Review Card（修复轮）

1. **Problem**：独立评审发现四项 P1——隔离验证声明冒充加载证据、空谓词可得 PASS、统计分母被未完成/缺失侧缩小、VBDR 跨重复拼接+硬编码裁定输入。
2. **Before**：声明+非空字符串 → ISOLATION_VERIFIED；空谓词案例 PASS；12 计划 6 观察时 BFRR upper 只到 6/12；`some()&&some()` 可把 R1 控制+R2 处理拼成"配对"。
3. **After**：加载证据三态+Runner 唯一生产者+防篡改哈希；谓词充分性双层 fail-closed；统计全部从预注册计划构建并保留全部未知；VBDR 逐重复精确配对+三态稳定性+绑定式独立裁定+可验机制关联。
4. **Existing mechanism reused**：rebind 工具、冻结校验、ledger/rollup、computeVBDR 六条件门（仅投影层重写）、canonicalJson。
5. **Complexity Delta**：仅新增 `noise-adjudications.json` 研究侧输入文件（缺省=PENDING，不建第二真相源）与 evidence 结构（纯数据对象）；无新子系统/服务/flag/依赖。
6. **Design reason**：统计与配对语义的修复必须落在数据面（计划配对集）而非调用方纪律，否则分母纪律不可机械保证。
7. **Verification**：§B 输入→输出样例 + 28 项红→绿 + 874/874 lab + 1829 全量 + 冻结对比。
8. **Risk**：真实宿主探针生产者尚不存在（real-host 模式会被正确 BLOCKED——设计如此）；`noise-adjudications.json` 目前无人工记录（VBDR 诚实 INDETERMINATE）。
9. **Rollback**：revert `0a327cb0c` 即回到修复前行为；无数据迁移。
10. **Follow-ups**：真实宿主探针证据生产者（待 Owner 授权的真实研究）、G-1 补族、G-3 归档方案——均不阻塞本轮。
