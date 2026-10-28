# CEB-001 Stage G / Phase 2a 终局裁定报告（B0/B1 v2/E 对照）

> **文档性质**：PRI-1035（[PE2a.2] Phase 2a：执行 Examiner vs 确定性枚举质量/成本试点）的可复核终局裁定依据。
> **SPEC 契约**：`SPEC-PD-EXAMINER-001` v0.4 §5.3/§5.3A（B0/B1/E 三组对照）、§12.3（Examiner 增量验收）、§12.5.17（Examiner 不优于枚举 → `ENUMERATION_SUFFICIENT`）、Phase 2a DoD（对照可复核；报告质量、人工成本与失败；可得 `ENUMERATION_SUFFICIENT`）。
> **状态**：`OWNER_DECISION_REQUIRED`——本报告形成可审计裁定依据；`ENUMERATION_SUFFICIENT` 与否的最终裁定权在 Owner（依据 `OWNER-DECISION-2026-10-27.md` §3 的明确保留）。本报告不将 PRI-1035 或 PRI-1024 置 Done。
> **授权边界**：E 臂真实生成已按 PR #2174 决策记录暂停；Stage G 当前 NOT_AUTHORIZED。本报告全部内容为离线复算，零新增真实模型请求。

---

## 1. 证据基线与复算入口

| 项 | 位置 |
|---|---|
| E 臂 60 adopted 信封（round7=12 / round8=6 / round10=42） | `scripts/dev/principle-learning-lab/challenge-studies/CEB-001/stage-g-execution/{round7,round8,round10}/examiner-draft-log.jsonl` |
| 全 10 轮请求账本（141 结果请求） | `stage-g-execution/round*/generation-ledger.jsonl` |
| AI-only 盲评（60 候选，OWNER_DELEGATED_AI_ONLY_REVIEW） | `blind-review-package/ai-only-review-results/`（结果 JSON + 决策记录） |
| 盲评匿名化映射（seed=20261025） | `blind-review-package/judge-only/rv-to-source.json` + `packets/RV-001..060.json` |
| B0/B1 v2 确定性基线（可随时离线重算） | `lib/challenge-enumerator.mjs`（`enumerateCandidates` / `enumerateCandidatesB1`） |
| **机器复算入口（本报告新增）** | `scripts/dev/principle-learning-lab/stage-g-phase2a-final-metrics.mjs`（导出 `computePhase2aFinalMetrics`，CLI 写 `stage-g-preflight/phase2a-final-metrics.{json,md}`） |
| 复算保护测试（CI 钉死关键不变量） | `scripts/__tests__/principle-learning-lab-phase2a-final-metrics.test.ts` |
| B1 公平性套件 / AMD transport 套件（本轮入库，此前仅存于未跟踪文件） | `scripts/__tests__/principle-learning-lab-challenge-b1.test.ts`（18 项）+ `principle-learning-lab-challenge-amd.test.ts`（15 项） |

除 `generatedAt` 外，重跑指标脚本产出逐字节一致（确定性测试在案）。所有跨源一致性（60 信封 ↔ 60 RV ↔ 评审计数 ↔ 账本合计）在脚本内 fail-loud 校验。

**已知复算缺口（如实披露）**：仓内 `build-blind-review-package.mjs` 停留在 round7 时代的 12 候选版本；60 候选扩展轮的构建器状态未入库，故盲评包**不能**由当前仓内构建器重新生成。已提交的包本身（packets + judge-only 映射 + manifest 种子）是权威证据，其内部一致性已由指标脚本逐字段核验；本报告不猜测原始构建器状态、不重建第二权威副本（P4）。

## 2. 三臂对照总表（§5.3A 公平契约）

| 臂 | 提交 | validator | 网格(/110) 提交/有效 | 实质情境(/3960) 提交/有效 | 重复(e/s/k) | 机制 facets | leak 守卫失败 |
|---|---|---|---|---|---|---|---|
| B0（历史 36 点） | 36 | 36/36 | 3/110 | 36/3960 | 0/12/0 | 8/8 | 0 |
| **B1 v2（主对照，全验后确定性选 36）** | 36 | 36/36 | **36/110** | 36/3960 | **0/0/0** | 8/8 | 0 |
| E（受约束 Examiner，真实请求免费层） | 60 | 40/60† | 17/110 / 15/110 | 52/3960 / 36/3960 | 0/0/8 | 8/8 | 20† |

† 当前 validator（含 PR #2138 OBS-D* 方向守卫）下 E 的 20 个失败全部源于**生成时共享库的旧 OBS-D1 文本**（答案方向提示），非 Examiner 模型行为差异；两臂生成时同等暴露于该缺陷。B0/B1 以修复后库文本重算故为 0。

**完整组合覆盖（3,960 实质情境 / 31,680 完整组合）**：三臂 36–60 槽均在 0.11–0.16% 量级——如实披露，任何臂都不接近穷举（协议双口径全量见 `phase2a-final-metrics.json`）。

## 3. 机械×评审失败集收敛（本轮新审计发现，信封级证明）

修复后 validator 的 OBS-D1 方向守卫（机械）与 AI-only 评审的 `gold_independence`+`safety_leakage`（语义）在 60 信封上识别出**完全相同的 20 个失败信封**（按 `(requestId, candidateId)` 信封级联接，集合相等由脚本 fail-loud 断言、CI 测试钉死）。该收敛把 PR #2174 决策记录中「20 失败根因=OBS-D1 共享库缺陷」的归因从单源判断升级为双独立方法交叉证实。

## 4. PRI-1035 八项必报指标（摘要；机器可读全量见 JSON）

1. **有效题比例**：B0/B1=36/36（结构天花板）；E 机械（当前 validator）40/60；E 评审关键门槛 40/60（同一集合，见 §3）。
2. **机制覆盖**：三臂均 8/8 facets——平局，无判别力。
3. **决策变量多样性**：B1 36/110 vs E 17/110（提交口径）——**B1 优**；实质情境 E 52（含 24 个同基线多表达）vs B1 36；E 与 B1 实质情境交集=0。
4. **近重复率**：B0 12 对 structural；B1 零重复；E 机械 skeleton 级 8 对、评审 `non_duplication` 仅 **12/40 通过**（E 的表达新颖性在语义层弱于机械唯一性）。
5. **Gold 泄漏率**：机械骨架门三臂 0；E 的 20 泄漏守卫失败=OBS-D1 旧文本（§3）；merge 采纳管线保持 Gold 结构性不可注入（骨架哈希与冻结基线一致）。
6. **编译拒绝率**：拒绝面全部在请求层——141 结果请求中 FAILED_KNOWN 105（403/404/429/超时/解析）、RESULT_UNKNOWN 25；进入采纳管线的解析草案 0 拒绝。
7. **人工修订时间**：`NOT_MEASURED`——60 信封 `manualRevision` 事件=0（merge 管线无需人工修订）；评审为 AI-only 委托、无逐候选计时（决策记录 `timingLimit` 原文随行）。
8. **每道有效题成本**：模型预算费 **$0**（11 个成功请求全部 `free_tier_zero_cost`，Owner 2026-10-25 确认免费层）；硬口径=请求数：141 请求/60 采纳信封=2.35 请求/信封，141/40 评审有效=3.53 请求/有效候选；产出候选的成功请求 10 个。账本 token 数为公式演练值（`simulatedUsage=true`），不作计量依据。B1 对照成本=~7s 离线计算、0 请求。

## 5. AI-only 盲评结果与采信边界

- 60 候选全评：关键门槛 40 通过/20 失败；非关键维度（40 评分内）task_validity 40/40、evidence_binding 40/40、boundary_coverage 35/40、non_duplication 12/40、executability 35/40；全维通过 11。
- **采信限制（OWNER-DECISION-2026-10-27 随行，不得剥除）**：single-pass AI-only ≠ 人类双盲；无有效 Cohen's kappa；rubric 撰写于 12 候选阶段与 60 候选批次存在范围错配注记；失败候选不评非关键维度。
- **对照边界**：盲评对象为 E 臂候选；B0/B1 为模板固定表达、无盲评面（协议将表达质量列为「E 的主要可检验质量面」）。因此**不存在 E vs B 的盲评差值**——「Examiner 表达质量更优」在本数据上不可判。

## 6. 结论边界四问（§5.3A `conclusionBoundaries` 的证据更新）

| 维度 | 可判性 | 依据 |
|---|---|---|
| 表达质量优劣 | **不可判** | 无 B 侧盲评对照；E 自身 non_duplication 12/40 削弱表达新颖性主张；AI-only 限制随行 |
| 有限预算下的选择 | **可判** | B1 参数覆盖 36/110 > E 17/110；E 未充分行使参数变化权（10 个成功请求的切片设计所致） |
| 人工修订成本 | **不可判（未测）** | `NOT_MEASURED`；仅知 merge 管线下人工修订事件=0 |
| 相对 B1 v2 优劣 | **部分可判** | 可判维度上 E 无一项优于 B1（§4.2/4.3/4.8）；判度纪律禁止把新颖性/去重单独记为增量 |

**notClaimable（更新版）**：不可声称 Examiner 优于确定性枚举；不可声称 E 候选质量合格（无人类盲评）；不可声称 Stage G 完整 36 槽实验（E 采纳 60 信封系超额记录、原始 36 槽计划未按原样填满）；不可从本对照推断真实宿主行为、长期内化或跨模型泛化。

## 7. Owner 决策卡

**待裁事项 A：Phase 2a 出题路径终局推荐**

| 选项 | 内容 | 证据位置 |
|---|---|---|
| **A1 `ENUMERATION_SUFFICIENT`（数据支持的推荐）** | 采用确定性枚举（B1 v2=全验后确定性选择）作为出题路径；E 臂保持暂停（PR #2174 已决）；后续如需表达层多样化，优先投资确定性模板变体与表达审计 | §4 全部可判维度上 E 无增量；§6 四问两不可判一负一平；CEB-002/CEB-003-P 题集事实上已全部以冻结 B1 基线为骨架构建并被 96/96 真实执行消费——枚举路径已在实际研究链中运转 |
| **A2 继续 Examiner 路线** | 恢复 E 臂（需新 Stage G 授权+付费通道），并补做 E vs B 人类双盲对照与计时 | 需回答：表达质量差值是否存在（本数据不可判）；成本=付费请求+双盲人工；当前无任何可判维度支持该投入的预期收益 |

**待裁事项 B：对照协议 v2 冻结**——`stage-g-preflight/protocol-b0-b1-e-comparison.draft.json`（`PROPOSED_NOT_APPROVED`）随本报告提请冻结认可（含 B1 v2 策略认可）。冻结与否不改变 A1 的数据支持方向，但决定本对照的预注册地位。

**决策生效边界**：A1/A2 由 Owner 明示后，PRI-1035 方可按其结论收口；协议 v2 冻结独立生效。无论 A1/A2，Stage G 真实生成授权维持 NOT_AUTHORIZED，不因本报告自动恢复。

## 8. 与后续工单的关系

- **PRI-1038（F2 真实宿主 A/B）**：题集来源不受 Phase 2a 裁定悬置影响（CEB-002/003 冻结套件已在库）；F2 的前置仍是 PRI-1037 探针真实执行 + Stage R 授权 + 宿主隔离核验。
- **PRI-1039（可选 Summary C 臂）**：CEB-003-P 的 C′ 自然经验叙事对照已提供相关历史证据，但其契约（自然叙事、预注册混杂在案）与 PRI-1039 要求的「高质量匹配 Summary 臂」不同——不能自动视作完成，另行评估。

## 9. 变更清单（本 PR）

- 新增 `stage-g-phase2a-final-metrics.mjs`（可导出复算函数 + CLI）与 `stage-g-preflight/phase2a-final-metrics.{json,md}`。
- 新增复算测试 `principle-learning-lab-phase2a-final-metrics.test.ts`（含确定性双跑断言）。
- 入库孤儿资产：B1 公平性套件（18 项）、AMD transport 套件（15 项）、round1/round3 执行驱动与 round1 指标脚本（PR #2136 时代遗留未跟踪文件，数据记录此前已在库）。
- 零生产代码改动；CEB-001 四冻结哈希不变（`freeze --verify` 在验证清单中）；零网络。
