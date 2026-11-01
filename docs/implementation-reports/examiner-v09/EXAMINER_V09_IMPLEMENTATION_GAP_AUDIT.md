# EXAMINER v0.9 — Implementation Gap Audit (Phase 0)

| 属性 | 内容 |
|---|---|
| SPEC | SPEC-PD-EXAMINER-001 v0.9 |
| 基线 | origin/main `34cbf60361c247dddf7ea942ec3e04384ee36fab` |
| 审计日期 | 2026-10-31 |
| 审计性质 | 只读（本报告与 SHA-256 基线为唯一产出，未改任何生产/历史文件） |
| 历史资产基线 | `HISTORICAL_FROZEN_ASSET_BASELINE.sha256`（593 文件，本目录） |

---

## 1. 模块审计结论表

| 模块 | 真实代码位置 | 当前能力 | v0.9 要求 | 处理方案 |
|---|---|---|---|---|
| Scorer V3 | `scripts/dev/principle-learning-lab/lib/claim-evidence-scorer.mjs`（+`claim-evidence-env.mjs`） | 七维独立评分、v1/v2/v3 单入口分发、UNKNOWN/NOT_APPLICABLE/INDETERMINATE 语义完备、7 类负迁移、成本 UNKNOWN 纪律 | 复用（§8） | **零修改复用**；仅经 Primary Endpoint 绑定其输出 |
| Report V2 | `.../lib/challenge-behavior-report.mjs` L1158-1910 | 九维、固定分母阶梯、逐 attempt 重放重打分、REPORT_READY 字节级修订保护、`REPORT_PENDING/INVALID` 状态 | 复用（§9） | **增量扩展**：新增可选 `examiner` 区块（mode/ITT/Fidelity/HEPS/注入证据摘要），不新建报告系统、不改状态阶梯 |
| 统计 | `.../lib/challenge-statistics.mjs` | BFRR/PCR/FIR/PairedEffect（含 full-plan 上下界，语义已等价 ITT 区间）、buildPlannedPairs（从计划构建配对）、VBDR、Factorial2x2 契约、causalAttribution 阶梯 | ITT 为主分析 + Fidelity 独立（§5） | **增量扩展**：`computeITT`（§5.5 逐字语义：d_i=F_C−F_T、固定 N、5 类 UNKNOWN 区间、点估计条件）+ `computeTreatmentFidelity` |
| Runner | `.../lib/challenge-runner.mjs` | 冻结验证、三层循环 arms×cases×repetitions、授权门、UNKNOWN/容量熔断、attempt 原子写、ledger 分类恢复 | 复用 + 增强（Phase 3） | **增量扩展**：可选 `plan.unitOrder`（冻结的随机化执行序）+ 每单元注入证据链采集；**不建第二 Runner** |
| Ledger | `.../lib/challenge-ledger.mjs` | JSONL 追加、崩溃安全（撕裂尾行丢弃）、预算预约幂等、classifyUnit | 复用 | **零修改复用**（注入证据存 attempt 旁路文件 + chainHash，不动 ledger 格式） |
| Freeze/Verify | `.../lib/challenge-freeze.mjs` | canonical SHA-256、实现清单钉（implementation manifest）、人审签名验证 | 复用 | **零修改复用**；examiner manifest hash 复用 `hashOfCanonical` |
| Challenge Suite/Gold | `.../challenge-studies/{CEB-001,CEB-002,CEB-003,CEB-003-P,EXM-MVP-001,v3,v4}` | 已冻结；`challenge-studies/` 为写保护区（`assertNotFrozenStudyArea` 拒绝报告写入） | 保护 + 复用（§6.4） | **零触碰**；新 v0.9 study 写入新目录 `examiner-studies/`（见 §4） |
| A/B 双模式 | 无（规格级） | 无 isolated_principle/full_library_incremental 代码 | Phase 1 全新契约 | **新增** `lib/examiner-study.mjs`（Study Manifest v0.9 §4.1 + HEPS + RuleCode Policy + Primary Endpoint + Pair Assignment） |
| Host-effective Principle Set | 无 | 无 HEPS 代码；生产侧资格过滤权威 = `runtime-v2/activation/prompt-activation-reader-contract.ts#filterPromptActivations` + 预算/选择（`prompt-budget-policy.ts`、`trimToBudget` fair_rotation_v1） | 全新（§2.2.1） | **新增**：离线资格过滤器（status/host/applicable/activation），语义对齐生产权威，快照 hash 冻结 |
| RuleCode Control | 设计词表（isolation-contract `OFFLINE_PROVABLE_VARIABLES`/EXPERIMENT_DESIGNS） | 离线结构性 OFF（`OFF_BY_ABSENCE_OF_MECHANISM`）；生产侧 prompt/RuleCode 为两条独立 activation | 全新策略层（§2.2.3/2.2.4） | **新增** RuleCodePolicy 计算（isolated=ALL_OFF、full=BASELINE_FROZEN、耦合→bundled_intervention） |
| Injection Evidence（六级） | 无六级代码；生产契约 `principles-core/src/runtime-v2/types/intervention-evidence-contract.ts` 有五级小写阶梯（prepared→runtime_loaded）；lab 有三级 DECLARED/LOADED/VERIFIED | 六级 = 规格级 | Phase 3 关键 | **新增** `lib/examiner-injection-evidence.mjs`：六级链 + 每级证据对象 + chainHash 防篡改 + 生产者白名单 + 宿主可证上限声明；映射生产契约命名 |
| ITT/Fidelity | PairedEffect 近似 ITT 区间；无 Fidelity | 增强 | Phase 4 | 同统计行 |
| Console | `packages/pd-console`（React19+Vite+HashRouter / node:http server） | 无任何研究入口（全量搜索零命中） | Phase 5 产品入口（§8） | **新增** `/examiner` 路由页 + `routes/examiner.ts` API + PrincipleDetailPage 入口 + 侧边栏项（本轮授权=本地开发环境集成） |

## 2. 历史研究资产核验（附录 B）

| 资产 | 身份核验 | 状态 |
|---|---|---|
| 九道题目 | `EXM-MVP-001` v4 Gold 归档 `inputs.json`（status OFFLINE_ONLY_NOT_AUTHORIZED，samples=9）+ v3/v2 版本链 + gold-review/expected-replay/package-manifest | **已完成、冻结**。本轮不重跑、不重生成、不复制 Gold；SHA-256 已入基线 |
| CEB-001 | 12 cases（BN/CT/FV/TC ×3）+ stage-g-execution round1-10 + 行为报告 | 冻结；基线已录 |
| CEB-002 / CEB-003-P | 16 cases（L1-L3/B1-B5）+ 执行归档 | 冻结；基线已录 |
| v1/v2/v3 评分兼容 | `adjudicateClaimEvidence` 单入口分发 + v2 字段逐字保留测试（`principle-learning-lab-v07-scorer.test.ts` L316-334） | 兼容测试继续作为回归门 |
| 历史报告 | REPORT_READY 事件 + reportSha256 + `ReportRevisionRequiredError` 字节级保护 | 机制已存在，本轮不触碰 |

## 3. 生产侧注入能力事实（决定注入证据诚实边界）

来源：`intervention-evidence-contract.ts` + 三宿主 evidence-recorder（勘察代理核实）：

| 宿主 | agent_context_delivery 可证上限 | enforcement 可证上限 |
|---|---|---|
| openclaw | submitted | runtime_loaded（RuleHost live） |
| codex | submitted（PRI-780 v2 rule context 未注入） | unknown |
| workbuddy | submitted（P04 探针证明 additionalContext 进入上下文，但 adapter 只能证 stdout） | runtime_loaded（P02 探针） |

离线 Stub 可诚实证明的链：CONFIGURED→SELECTED→SUBMITTED→CONTEXT_PRESENT→RUNTIME_LOADED（对其自身管线：payload 文本确定性地出现在组合后 prompt 中并被 actor 循环消费）——**标记 offline-stub scope，永不冒充真实宿主证明**。

## 4. 已有功能清单 / 必改 / 必增

**零修改复用**：Scorer V3、Ledger、freeze 核心、CEB 套件、run-challenge-study CLI 授权门。

**修改（增量，均为既有文件内扩展）**：
1. `lib/challenge-statistics.mjs` — +`computeITT`、+`computeTreatmentFidelity`
2. `lib/challenge-runner.mjs` — +`plan.unitOrder` 支持、+每单元注入证据采集与落盘
3. `lib/challenge-behavior-report.mjs` — +可选 `examiner` 区块（ITT/Fidelity/mode/HEPS/注入摘要）
4. `generate-behavior-report.mjs` — +`--v2` 包装（现仅 v1）
5. `packages/pd-console/src/server/index.ts` — +examiner API 分支
6. `packages/pd-console/src/ui/App.tsx` / `app-sidebar.tsx` / `PrincipleDetailPage.tsx` / i18n / navigation 契约测试

**新增**：
1. `lib/examiner-study.mjs` — Study Manifest（v0.9 §4.1 全字段）、HEPS 构建、RuleCodePolicy、Primary Endpoint 注册与冻结、Pair Assignment（seed 随机化、执行序冻结）、Preflight
2. `lib/examiner-injection-evidence.mjs` — 六级注入证据链
3. `examiner-studies/`（lab 下新目录，避开冻结保护区）
4. `scripts/__tests__/principle-learning-lab-examiner-v09-*.test.ts` — 红→绿测试组
5. `packages/pd-console/src/server/routes/examiner.ts` + `src/ui/pages/examiner/ExaminerPage.tsx`
6. 端到端验收脚本（离线 Stub 全链路产物生成）

**数据迁移**：无。无生产 schema 变更；examiner manifest 为研究侧新增 JSON 契约。

**历史兼容风险**：低。Report V2 扩展为可选区块（无 manifest 的研究零输出变化→历史重放字节不变）；runner `unitOrder` 缺省时行为不变；统计纯新增函数。

## 5. 实施顺序

Phase 1 契约（examiner-study.mjs）→ Phase 2 评分绑定/题族复用断言 → Phase 3 注入证据链+runner 接线 → Phase 4 ITT/Fidelity+Report 区块 → Phase 5 端到端+Console → 全量回归。

## 6. 与 v0.9 设计的已识别偏差（最小兼容实现声明）

1. **Principle 状态枚举**：SPEC 例表用 DRAFT/PENDING_APPROVAL/REVOKED 等名义值；实现按 PD 权威五态映射（candidate→不具备资格、probation→不具备资格（未完成 Owner 审批链）、active→资格、archived/deprecated→不具备资格），映射在 HEPS 模块中显式声明并冻结。
2. **宿主适用性**：生产无 per-host Principle 适用矩阵；离线 HEPS 输入由调用方提供 `hostApplicable` 装配事实（预检要求来源声明），过滤器只做资格判定。
3. **随机化执行序**：现有 runner 为确定性三层循环；`unitOrder` 为可选扩展，CEB 历史研究不受影响。
