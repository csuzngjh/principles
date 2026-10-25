# Owner-Review 一致性复核 — Stage G Preflight（CEB-001）

> 执行日期：2026-10-24（无模型、无生产写入）
> 复核对象：`Preflight-Report.md` + `preregistration.stage-g.draft.json` + 枚举器/校验器实现
> 状态裁定：**READY_FOR_OWNER_REVIEW（维持，不得升级为 READY_TO_RUN）**
> 本次修订：预检文档 3 处数字/规则修正 + 测试 1 处精确断言加固；未修改枚举器/校验器实现与任何冻结资产。

---

## §1 枚举器数量核验 — `RESOLVED_WITH_EVIDENCE`（发现并修正报告数字错误）

**矛盾**：初版报告声称「12 模板 × 3 干扰 = 27 候选」。12×3=36≠27。

**裁决（源码 + 实际执行）**：
- `lib/challenge-enumerator.mjs` 无任何过滤/去重/拒绝分支（`enumerateCandidates` 为纯三层排序遍历：族 × 领域 × 干扰变体，全部 push，无 filter/skip）。
- 实测执行（命令见下）：**TOTAL = 36 = 4 族 × 3 领域模板 × 3 干扰变体**；四族各 9；**全部 36 个候选通过 validator（all valid: true）**；被排除组合：**零**（无排除规则亦无被排除项）。
- 结论：**代码行为正确且完备；「27」为 Preflight-Report 初版撰写笔误**，非过滤规则所致。

**最小修正（已执行）**：
1. `Preflight-Report.md` A3/§B/§E 与 `preregistration.stage-g.draft.json` 的候选数全部修正为实测 36（本文件 §1 即证据链）。
2. 测试加固：`principle-learning-lab-challenge-stageg.test.ts` 数量断言由 `≥24` 改为**精确断言**（总数=36、12 领域各贡献恰好 3 个合法组合、四族各 9、distractor ∈ {none,docs,stale}），防数字再漂移。此为预检产物内的小变更并在此披露；**枚举器实现零改动**。

**复现命令与结果**（2026-10-24 实跑）：
```bash
node --input-type=module -e "…enumerateCandidates(refs) + validateStageGCandidate…"   # exit 0
# 输出：TOTAL CANDIDATES: 36；per family {BOUNDARY:9, CROSS:9, FAILURE:9, TRADEOFF:9}；all valid: true
cd scripts && npx vitest run __tests__/principle-learning-lab-challenge-stageg.test.ts  # exit 0 → 26 passed / 26
```

---

## §2 固定候选预算对齐 — `RESOLVED_WITH_EVIDENCE`（发现并修正 cap 不对齐）

**矛盾**：初版 `candidateCapPerArm: 32` < B 臂实际可生成合法候选 36——若照旧执行，B 臂被迫截断（删 4 个合法候选，违反全量保留纪律）或两组机会数不等。

**裁决（按 Owner 优先方案）**：以 **B 臂实际可生成的合法候选全量 36 作为两组共同上限**——已修订 prereg draft：`candidateCapPerArm: 36`；比较一设计改为「两组候选机会上限相同 = 36（B 臂网格全量，零过滤）」；停止条件同步改「达到候选上限 36」。E 臂上限同为 36，仍受请求/token/费用约束。**未扩大 B 网格**（36 已满足样本量方案；如未来扩至 ≥60/臂，prereg 已注明须经确定性枚举规则扩展并重新验证覆盖率/重复率/来源）。

**比较二核验**：目标 16 道合格题/组维持；已补规则「任一组未达标时保留全部失败记录并按实际合格数报告成本，不得删失败凑数」。**未按未来 Actor 表现筛选/修改任何候选**（B 臂为算法全量输出；E 臂尚未生成）。

---

## §3 预算可执行性核算 — `RESOLVED_WITH_EVIDENCE`（核算补全）+ `OWNER_DECISION_REQUIRED`（三项输入缺失）

**已补全的最坏情况算术**（写入 prereg draft §budgetPlan.worstCaseArithmetic）：
- 总请求硬上限 16——**owner-review 修订：含重试**（初版「maxTotal 16 + 每请求重试 1」未声明是否叠加，最坏可到 32；现明确重试计入 16，杜绝翻倍歧义）。
- worstCaseTokens ≤ 16 × (8,000 入 + 4,000 出) = **192,000 tokens**。
- worstCaseUsd ≤ 192,000 × 所选模型公示单价。示例演算（DEMONSTRATION_ONLY，非承诺）：$10/M → ≤$1.92；$15/M → ≤$2.88。

**$3 的定位**：**保持 PROPOSED_NOT_APPROVED**。缺失输入（未决）：① Owner 选定 Examiner 模型与版本；② 该模型当期公示单价（入/出分价）；③ 人工评审时薪。三项齐备前 **$3 不是已验证硬预算**，选定后须重算并重新提交批准。

**调用前 vs 调用后分级**（已在 prereg 明文）：调用前硬限制 = 总请求 16（含重试）/ max_tokens / 候选数 36；调用后观测 = 响应 usage 与实际费用。费用上限的强制点在**下一次调用前**核对累计观测费用——不构成「当前请求绝不超额」的服务端保证。RESULT_UNKNOWN 处理沿用 1B 账本契约（禁自动重试、预留不返还）。

---

## §4 盲评与 Gold 证据核验

**盲评规则补全** — `RESOLVED_WITH_EVIDENCE`（规则缺失已修）：
- Kappa 类型明确为**无权重 Cohen's kappa**（逐维度二值 pass/fail 判定 + 关键门槛三维度合并）。
- undecidable/缺失处理明确：双方均 undecidable → 排除出 kappa 分母但**保留在保留记录与 validRatio 分母**；单方 undecidable → 记为分歧并触发仲裁。
- 仲裁规则明确：关键门槛（机制忠实度/Gold 独立性/泄漏防护）任何分歧必须第三方仲裁；非关键分歧记录后裁定；原始意见全留。
- 评审者人选与人工时薪 — `OWNER_DECISION_REQUIRED`（禁止模型自评替代）。盲评现状维持 **DESIGNED_NOT_EXECUTED**。

**Gold 逐题追溯** — `RESOLVED_WITH_EVIDENCE`（补齐逐题表；初版仅汇总描述，属待补齐项现已补）：

| caseId | 事实域来源 | 机制锚点（冻结映射字段） | Gold 权威（独立于原则文本） |
|---|---|---|---|
| FV-01 | Pain #44 原始事件（rev-parse true×3 被无视） | observedFailure / failureMechanism(b) | oracle 蕴含结构（OBS-1→F1 真，OBS-2→F2 假）+ Owner 逐字纠正（pain_events#44，hash `679f23d6…`） |
| FV-02 | PRI-836 A1 #2261/#2265 端口/进程双路径 | failureMechanism(a) | 蕴含结构（OBS-2/OBS-3 等价确立） |
| FV-03 | PRI-836 A1 #2260 漏改核查 | failureMechanism(a)(d) | 蕴含结构 |
| CT-01 | PRI-904 T3 文档转述域 | failureMechanism(b) + exceptionConditions | 蕴含结构（「文档记载该说法」可验证 ≠「缺陷已修复」） |
| CT-02 | PRI-904 T5 外部状态域 | exceptionConditions(3) | 不可观察 + 降级规则（behavior-signature excludedFromCounting，PRI-900 独立声明） |
| CT-03 | PRI-904 T4（大小同/哈希异） | failureMechanism(b) | 蕴含结构 |
| BN-01 | 映射例外条件 | exceptionConditions(2)(3) | ownerAnswers 结构 + 降级合法性 |
| BN-02 | scribe 产物 risks[0]（过度执行风险，产物自带） | exceptionConditions(3) + risks | 预置证据蕴含 + 预注册 overCheck 规则 |
| BN-03 | 映射例外条件 | exceptionConditions(1)(3) | 不可观察 + 降级规则 |
| TC-01 | risks[0] 分级验证 | legalAlternativePaths + risks | 蕴含结构 + 预算约束 |
| TC-02 | risks[0] + 时限 | legalAlternativePaths | 蕴含结构 + deadline 客观后果 |
| TC-03 | pain_diagnoses People root_cause（授权纪律） | observableActions(3) | 签核机制（oracle 环境权威） |

**如实分级披露**：FV 系直接锚定真实 Pain 事件域；CT/BN/TC 为机制迁移的**构造环境**——其 Gold 独立性属**结构独立**（蕴含结构可由 `challenge-validator.mjs` gold 组机械重推导，不派生自原则文本），生态效度边界已在 mapping `knownLimitations` 冻结在案。未调用任何模型替代评审；盲评未标记为完成。

---

## §5 交付记录一致性 — `RESOLVED_WITH_EVIDENCE`

**口径澄清**：git 顶层未跟踪条目 **33** ≠ 实际文件数。分项（实测）：

| 分项 | 顶层条目 | 实际文件 |
|---|---|---|
| 原有未跟踪（Phase 1A 之前，全部保留） | 15 | （含目录展开，未逐一侵入清点外部文件） |
| 会话期间外部新增（非本任务创建，保留） | 2 | 2 个 md 报告 |
| Phase 1A | 8 | 50（5 lib + 1 freeze CLI + 1 测试 + study 目录 43） |
| Phase 1B | 5 | 5（3 lib + 1 run CLI + 1 测试） |
| Stage G Preflight（含本复核） | 3 | 6（2 lib + 1 测试 + stage-g-preflight 3 文档） |
| **合计** | **33** | study 目录现为 46 文件（43+3） |

**重确认（2026-10-24 实跑）**：四冻结哈希不变（`213090da`/`eef38484`/`e1f2f5ca`/`01ac054b`，`freeze --verify` VERIFY OK）；冻结题集/Gold/评分契约/预注册资产零修改（`git diff --name-only` 为空——**已跟踪文件零改动**，本复核仅改未跟踪的预检文档与测试）；真实模型调用 0；真实宿主实验 0；生产数据库写入 0；未签发任何授权记录（generation/run-authorization 均 NOT_AUTHORIZED）；realHostBaseline=UNKNOWN、PRI-1037=NOT_RUN 保持原状。

---

## §6 安全与工作树纪律 — `RESOLVED_WITH_EVIDENCE`

HEAD=`b62a9d8f` 未动；无 pull/merge/rebase/reset/clean/stash/checkout；未更新 Linear、未建 PR、未 commit。本次变更清单（全部在授权范围内）：`preregistration.stage-g.draft.json`（cap/请求含重试/worstCaseArithmetic/kappa/undecidable/样本量 6 处）、`Preflight-Report.md`（3 处数字修正）、`principle-learning-lab-challenge-stageg.test.ts`（数量断言精确化）、本文件（新增）。**枚举器/校验器/Runner/冻结资产实现零改动。**

## §7 测试证据（本次复核实跑）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npx vitest run __tests__/principle-learning-lab-challenge-stageg.test.ts` | 0 | **26/26**（含精确断言：总数 36、12 模板×3、四族各 9、全候选 validator 通过） |
| 全量回归（1A+1B+lab 邻近 6+卫生 2） | 0 | **298/298** |
| `freeze-challenge-study.mjs --study CEB-001 --verify` | 0 | VERIFY OK |
| 枚举器实测（node 直跑统计） | 0 | 36 候选 / 零排除 / all valid |

## 最终裁定

**READY_FOR_OWNER_REVIEW（维持）**——数量关系（36=12×3=两组共同 cap）、比较预算（双口径对齐 36/16）与预算核算（192k tokens 最坏算术 + 分级表述）均已自洽；全部未决事项已显式披露（`OWNER_DECISION_REQUIRED`：模型与单价选定、评审者与时薪、协议/阈值/预算批准、PRI-1034 实现授权、Stage G 签发）。**不升级为 READY_TO_RUN**；Stage G 未执行、Examiner 与枚举无任何优劣主张。
