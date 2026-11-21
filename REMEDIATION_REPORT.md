# PR #2740 终审整改 — 最终报告

工单：PRI-1258（PD-Lab v0.3 T7a-judge）。PR：<https://github.com/csuzngjh/principles/pull/2740>。报告日期：2026-11-21（第三轮整改更新 2026-11-22）。

> **当前状态**：第三轮整改（独立评审 6×P1 + 4×P2）已于 commit `91f6c97cd` 交付。本报告 §13 为第三轮逐项记录；§1–§12 保留第一/二轮历史（其测试计数已被 §13 的最新计数取代）。

## Owner Review Card（§27）

**Problem**：独立评审发现 [PR #2740](https://github.com/csuzngjh/principles/pull/2740) 虽 CI 绿，但 T7a 校验器把整包合并成单个 T4 plan（每个比较未按各自席数归并、记录有效性漏判、仲裁未经结构门、协议字段可篡改仍通过），T6 资格门探索性无授权即可判定、源组 digest 可被假装重算、artifactRef/alpha null 等畸形输入在 `--out` 创建后崩溃。

**Before**：perAssignment 行为与 T4 偏离；探索性可 promote；P1-1..P1-6、P2-1..P2-4 缺陷存在（见 §2）。

**After**：校验器逐比较归并（perAssignment 忠实复现 T4 `mergeJudgments`），bundle 级重复仲裁/案例版本冲突/未声明键歧义均 fail；探索性必须 prereg `exploratory===true` + 绑定 D2 exploratory 批准且永不 PROMOTE；源组 digest 经 `sourceGroupsDigestOf` 字节级诚算；协议冻结字段逐项比对；顶层输入/用法错误（exit 2）先于 `--out` 创建、不留目录；问题级非法记录仍写诊断报告后以 1 退出。

**Existing mechanism reused**：T4 `mergeJudgments`/`twoSidedThreshold`、admission-probe `sourceGroupsDigestOf` 与 write-once `--out` 先例、owner-decision 结构；零新抽象。

**Verification**：judge-protocol 66 用例 + t6-qualification 40 用例全绿；含全部 review 回归（per-comparison 席数、入口对象绑定、合法截断、结构化声明、仲裁结构门、DUPLICATE_ARBITRATION、CASE_VERSION_CONFLICT、空 `--out` 重试）。lint 0 error。

**Complexity Delta**：无新 schema/服务/flag/跨包依赖；纯 scripts/dev 工具。

**Rollback**：revert 本 PR 文件即可，无生产副作用。

## 1. 任务范围

按终审指令修复 PR #2740 已交付机制，并闭环代码、测试、证据、文档与远端 CI。两轮：round-1（P0-1 T6 资格门、P0-2 完整语义交换、P0-3 仲裁绑定、P1-1..P1-4）；round-2（独立代码评审 P1-1..P1-6、P2-1..P2-4）+ 三轮 Devin Review 加固。所有修复发生在既有 `ai/PRI-1258-judge-protocol-t6-gate` 分支；无新增功能。

## 2. 逐项落地

| 项 | 落地 | 位置 |
| --- | --- | --- |
| P0-1 | 状态/计数一致性表；`evidence` 段 `{artifactRef, sha256}` 由 CLI 按真实字节重算；D2/D5/D6 结构化 owner-decision 记录；`readyIndependentSourceGroups` 机械推导；预注册漂移拒绝；3 态；EXPLORATORY 永不 PROMOTE；复用 T4 `twoSidedThreshold` | `t6-qualification.mjs`、`t6-qualify.mjs` |
| P0-2 | `verifySwapPair` 完整语义校验 + 角色规范化 digest；不可比交换对单独披露 | `judge-protocol-validate.mjs` |
| P0-3 | 仲裁绑定 = T4 `boundAll`（id 集 + digest 集 + assignmentKey） | 同上 |
| P1-1 | T7a perAssignment 逐比较复用 `mergeJudgments`，每个 key 按自身有效席位归并 | 同上 |
| P1-2 | 源组推导经 `sourceGroupsDigestOf` 字节诚算；篡改→`contentDigestMismatch`/`groupingBindingMismatch` | `t6-qualification.mjs`、`admission-probe.mjs` |
| P1-3 | 探索性要求 prereg `exploratory===true` + D2 exploratory 绑定批准；恒不 PROMOTE | `t6-qualification.mjs` |
| P1-4 | `packageProblem` 强制冻结 ref/rubric/question + 非空 A/B（截断例外仅当事实满足构建者不变式） | `judge-protocol-validate.mjs` |
| P1-5 | `evidence`→`evidenceRefs` 贯通至 FinalComparison | 同上 |
| P1-6 | `judgmentId` 全局唯一（重复双方均 invalid） | 同上 |
| P2-1 | null ≠ absent 全层一致 | 同上 |
| P2-2 | alpha null → BLOCKED，绝不进 `Math.max` | `t6-qualification.mjs` |
| P2-3 | artifactRef 形状先于 path.resolve | `t6-qualify.mjs` |
| P2-4 | 顶层输入/用法错误（exit 2）在 outDir mkdir 前 fail、不留目录；问题级记录照常写诊断报告 | `judge-protocol-validate.mjs`、`t6-qualify.mjs` |

**Devin Review 三轮加固**（`9faad0de7`→`dffac62f` + 本轮）：校准只计 SUCCEEDED 调用；批准 scope 绑定槽位；预注册必备；precisionTarget 锚定；data-path `RAN_WITH_D6` 闭集；source-groups 双层绑定；swapOf 全局登记 + 同 assignmentKey 配对；per-comparison 席数；入口对象绑定（id/pk 碰撞免疫）；结构化 `bundle.assignments`（separator-bearing key）；仲裁结构门 `INVALID_ARBITRATION_RECORD`；截断事实不变式（`truncatedAt === context.length` 且 `originalChars > truncatedAt`）；bundle 级 `DUPLICATE_ARBITRATION` 与 `CASE_VERSION_CONFLICT`（覆盖未收到判决的声明计划行）；`bundle.assignments` 类型检查先于 `--out` 创建（exit-2 不留目录）。

## 3. 新增问题码

资格层 7 个 + 交换层 9 个 + `INVALID_ARBITRATION_RECORD`/`DUPLICATE_ARBITRATION`/`CASE_VERSION_CONFLICT`/`ASSIGNMENT_KEY_UNDECOMPOSABLE`/`INVALID_ASSIGNMENT_DECLARATION`/`DUPLICATE_ASSIGNMENT_DECLARATION`/`DUPLICATE_JUDGMENT_ID` + 披露 `AUTHORITY_PROVENANCE_UNVERIFIED`/`JUDGE_SLOT_REGISTRATION_UNVERIFIED`。

## 4. 验证（待合并版本 HEAD `dffac62f6`，本轮后更新）

- `pd-lab-judge-protocol.test.ts`：**66 用例全绿**。
- `pd-lab-t6-qualification.test.ts`：**40 用例全绿**（ERR-146 α=1e-310 用例 180s timeout）。
- 全 scripts 套件：3354 通过 / 2 失败（`release-immutable-candidate`、`RUNNER_TEMP` env-only，pre-existing 与本 PR 无关）。
- eslint 0 error；全部 git hooks 通过。

## 5. 真实事实（如实声明，合成结果绝不冒充真实校准）

- 真实模型调用：**0 次**（D2 未批准）。
- Owner 盲评样本：**0**（D5 未批准）。
- 真实全保真数据探测：NOT_RUN（D6 未批准）。
- 真实 T6 资格：机械推出 **BLOCKED**（无 D2/D5/D6、n=0、无校准/盲评证据）。

## 6. 版本与 digest

- Judge Protocol：`jp-pd-lab@1`，冻结 digest `sha256:82c78a1e399165f08fb5dd22be68a8aef2dbfeff1e8ffb953f2f02668e4459a5`。
- 统计口径：CONTRACT §6.5，`twoSidedThreshold` 全 BigInt 双侧精确阈值。

## 7. 文档更新

`docs/reports/PD_LAB_V03_JUDGE_CALIBRATION.md`：digest、用例计数（65/40）、整改表与 Complexity Delta 同步。PR 描述同步。

## 8. PR 远端状态

- HEAD：`dffac62f6`（round-3 加固；round-4 修复待推）。Merge status：Mergeable。
- Devin Review：全部历史 findings 已修复并逐线程回复 + resolve（12 CodeRabbit + 8 Devin Review 线程）。
- 历史快照：round-1 完成时 `2374c5e95` CI 26/26 绿、47+32 用例 — 仅作历史记录，不代表当前 HEAD。

## 9. 已知限制

- `AUTHORITY_PROVENANCE_UNVERIFIED`：本地字节核验不能认证批准者身份。
- 无真实预注册席位表（无 D2），`JUDGE_SLOT_REGISTRATION_UNVERIFIED` 如实披露。
- `lab:probe` 必然 `NOT_RUN_WITHOUT_D6`（刻意 fail-closed）。
- Windows runner 2 个 `release-immutable-candidate` 失败为 env 问题（pre-existing，CI Linux 全绿）。

## 10. 合规边界

`ab-eval.mjs` 零改动；T4 业务语义零改动；无新 DB/服务/flag/依赖；零网络；零真实裁判调用；未伪造 D2/D5/D6；真实资格未写成 CONFIRMATORY_READY；未 merge PR；无跳过/放松测试。

## 11. 回滚路径

Revert 本 PR 的新增/修改文件；`alignment-report.mjs`/`admission-probe.mjs` 仅 export 变更。无生产副作用。

## 12. 结论

**Verdict: PASS_WITH_LIMITATIONS。** 全部终审整改项 + 多轮评审 findings 修复闭环。遗留限制均为外部前置条件（D2/D5/D6 未批准 → 真实 T6 资格 BLOCKED 且必须保持 BLOCKED），非代码缺陷。PR 未合并，等待 Owner 审批。

---

# 13. 第三轮整改（2026-11-22，commit `91f6c97cd`）

独立评审（基线 `e6697700c`）发现 6 项 P1 + 4 项 P2。本轮全部修复；不合并 PR、不改 T4 语义、不改 `ab-eval.mjs`、不新增 DB/服务/flag/依赖、零网络、零真实模型调用。

## 13.1 修复总览

| 编号 | 问题 | 修复文件 | 测试 | 状态 |
|---|---|---|---|---|
| P1-1 | 探索性资格升级 | `t6-qualification.mjs` | t6：2 个 P1-1 用例 + 闭集新增 fixture | 已修复 |
| P1-2 | 校准与盲评证据 | `t6-qualification.mjs` | t6：6（校准）+ 4（盲评）负向用例 | 已修复 |
| P1-3 | D2/D5/D6 参数绑定 | `t6-qualification.mjs` | t6：7 个绑定负向用例（模型/α/样本下限/数据集/缺参数/预算/伪造布尔） | 已修复 |
| P1-4 | Source Groups 完整性 | `t6-qualification.mjs` | t6：7 个完整性用例（双向重复 caseId、无锚点共享组、缺 sessionId、双计数不一致、幽灵键） | 已修复 |
| P1-5 | Assignment 完整归并 | `judge-protocol-validate.mjs` | judge-protocol：6 个用例（0/1/多声明无记录、9/10、FAILED-only、隔离、部分席位） | 已修复 |
| P1-6 | D6 正向路径 | `admission-probe.mjs`、`t6-qualification.mjs` | admission-probe：7 个 CLI 用例 + t6：2 个引擎用例 | 已修复 |
| P2-1 | nMinAlpha null | `t6-qualification.mjs` | t6：2 个边界用例（1e-310 显式 false + 边界值表） | 已修复 |
| P2-2 | artifactRef 安全 | `t6-qualify.mjs` | t6：4 个 CLI 用例（traversal、绝对/盘符、symlink 逃逸、合法嵌套） | 已修复 |
| P2-3 | Blind Leak 终检 | `judge-protocol.mjs` | judge-protocol：3 个用例（整值/子串/正常交换语义） | 已修复 |
| P2-4 | 报告同步 | `REMEDIATION_REPORT.md`、`PD_LAB_V03_JUDGE_CALIBRATION.md` | 本节 | 本节即交付 |

## 13.2 各 P1 关键语义

**P1-1**：`PREREGISTRATION_EXPLORATORY_CAP` 成为 unmet criterion——预注册标记 exploratory 时即使 n/精度/盲评全部满足也最多 `EXPLORATORY_ONLY`（升级唯一途径 = 新的确认性预注册，即新实验）。`exploratoryT6Allowed` 显式列出全部条件（状态 + 绑定批准的 D2 + D2 exploratory grant + prereg exploratory + D5 + 盲评 PASSED + 样本达 D5 下限），`status===EXPLORATORY_ONLY` 单独永不充分。`promotePossible` 同时受状态与注册类型约束。

**P1-2**：校准文档必须绑定 `judgeProtocolRef`+`judgeProtocolDigest`（与当前协议一致，否则 invalid）、报告级 `judgeModel`、逐调用 `model`（SUCCEEDED 调用必须与报告级模型一致——"报告说模型 A、证据是模型 B"即 invalid）、`judgeVerdict`/`referenceVerdict`（协议四值）、`positionExchangeConsistent`（每次 SUCCEEDED 必带）。`precisionTargetMet` 从原始逐调用一致率**重算**（声明值只作对比，三方不一致 = `EVIDENCE_CLAIM_MISMATCH`）。盲评样本必须携带完整评审记录：`packageId`、`displayOrder`、`identityMap`、`ownerVerdict`、`judgeVerdict`、`judgeRestoredVerdict`（用协议自身 `restoreDisplayVerdict` 复核盲化还原）、`recheckStability`、`disagreementType`（一致时必须 null，不一致时必须闭集值）。一致率/分歧类型/复评稳定性全部重算；重复 sampleId/invocationId 即 invalid。复用现有 Judge Protocol digest 与 validation 机制，未另建校准系统。

**P1-3**：已批准的 D2/D5/D6 决策必须携带冻结参数（结构缺失 = `EVIDENCE_ARTIFACT_INVALID`，并披露 `parameterProblem`）。逐项核对矩阵（不一致 = `APPROVAL_PARAMETER_MISMATCH`，BLOCKED）：D2 α/最低组数/精度目标 ↔ 冻结预注册；D2 模型/精度目标/预算 ↔ 实际校准报告；D5 样本下限（仅对已完成的 PASSED 盲评声明；NOT_RUN 是诚实未完成，走 unmet criterion）↔ 盲评样本数；D5 一致率阈值/翻转率上限/复评要求 ↔ 重算指标；D6 datasetSha256 ↔ admission report ↔ source-groups 三方。参数面来自 HANDOFF 决策表，无自造阈值。`AUTHORITY_PROVENANCE_UNVERIFIED` 披露保留。

**P1-4**：重复 caseId 直接判证据无效（双向：INCOMPLETE→READY 与 READY→INCOMPLETE 均拒绝，Map 覆盖路径消除）；`dataset.sampleCount`/`counts.caseCount`/perSample 唯一 caseId 数/映射键数四者必须一致；非空 sessionId 同 session 拆多组拒绝（已有）；**空/缺失 sessionId 不再静默跳过**——按生产端机械规则必须单例成组，出现在共享组即 `sessionAnchorMissingSharedGroup` 拒绝；digest 重算与 admission/sourceGroups 双层绑定保留。

**P1-5**：归并计划 = 声明 assignments ∪ 实际记录 keys。每个声明的 Assignment 都到达真实 T4 `mergeJudgments`（无记录 → `MISSING_JUDGMENTS` 的 UNKNOWN FinalComparison；不伪造记录、不删声明行）；`perAssignment` 诊断面同样取并集；`totals.{declaredAssignments, mergedAssignmentKeys, finalComparisons}` 外显验收面；孤儿仲裁的绑定集同步为声明∪记录（绑定到"声明但未判定"的 arbitration 合法进入归并、不被采纳）。T4 归并算法零复制。

**P1-6**：`admission-probe.mjs` 新增 `--d6-decision <file>` 正式入口：加载即验证 owner-decision 形状、`scope==='d6'`、`approved===true`、完整参数块、`datasetSha256 === 被探测数据集实际 digest`；任一不满足 = `d6_decision_invalid` fail-closed 退出（不降级、不绕过）。有效时 `realDataProbe` 输出 `RAN_WITH_D6` + 完整决策绑定回显（file/sha256/decidedBy/decidedAt/datasetSha256）+ `probeScope`（数据集摘要/范围/存储/保留期/快照目录）+ 执行结果。无 `--d6-decision` 时保持 `NOT_RUN_WITHOUT_D6`。T6 引擎侧重新验证 report ↔ D6 授权一致性（`deriveDataPathAuthorization` 要求 `realDataProbe.datasetSha256 === admission.dataset.sha256 === D6.parameters.datasetSha256`）。`RAN_WITH_D6` 是探测器派生状态，用户输入无法直写；无环境变量/测试布尔旁路。**本轮全部 D6 测试使用隔离合成快照，未访问任何真实生产数据。**

## 13.3 P2 修复

- **P2-1**：`nMinAlpha === null` 时 `checks.nMeetsNMinAlpha` 显式 false（`nMinAlpha !== null && nEffective >= nMinAlpha`）；`requiredGroups`/`BELOW_N_MIN_ALPHA` 判定同加显式守卫。新增 1e-310 用例钉住"`>= null` 隐式转 0 为 true"的 bug 形态。
- **P2-2**：`resolveArtifact` 先拒绝绝对路径（POSIX/Windows/盘符相对）与任何 `..` 段，再以 realpath 解析后强制落在 realpath(证据根) 内（symlink 逃逸拒绝），合法嵌套相对路径不受影响；全部 fail-closed exit 1 并写入结构化 `evidence-verification.json`。
- **P2-3**：`swapJudgePackage` 对生成的交换包执行与构建期同一 `checkPackageForLeaks()`；`checkPackageForLeaks` 新增 `packageId` 臂词**子串**规则（操作者控制的标识符不得含 candidate/reference/baseline；判定材料 content/outputs 不受子串规则约束）；任何泄漏返回 `ok:false, code: SWAP_BLIND_PACKAGE_LEAK`，绝不返回 `ok:true` 的非法盲评包。
- **P2-4**：本报告与校准报告文档同步最新计数与状态；旧 HEAD 数据仅以历史口径保留并明确标注。

附带卫生修复：`judge-protocol-validate.mjs` 源码中一处**字面 NUL 字节**（`join("<NUL>")`）改为等价的 `\u0000` 转义（同一字符串值，源码恢复文本工具可读性）。

## 13.4 测试结果（本轮实际运行）

| 套件 | 新增 | 总数 | 通过 | 失败 | 跳过 |
|---|---|---|---|---|---|
| `pd-lab-judge-protocol.test.ts` | +9（P1-5×6、P2-3×3） | 75 | 75 | 0 | 0 |
| `pd-lab-t6-qualification.test.ts` | +34（P1-1×2、P1-2×10、P1-3×7、P1-4×7、P2-1×2、P2-2×4、P1-6×2） | 74 | 74 | 0 | 0 |
| `pd-lab-admission-probe.test.ts` | +7（P1-6 CLI） | 154 | 154 | 0 | 0（本机 symlink 1 例按环境能力 skip，Linux CI 执行） |
| 全 scripts 套件（`npm run test:scripts`） | — | 3433 | 3412 | 2（pre-existing） | 19 |

2 个失败 = `release-immutable-candidate.test.ts` 的 `RUNNER_TEMP`/OIDC 环境依赖，与本 PR 无关（第二、三轮本地均为同样 2 例，CI Linux 全绿）。闭集 round-trip（ERR-146）已扩展覆盖两个新码 `PREREGISTRATION_EXPLORATORY_CAP`、`APPROVAL_PARAMETER_MISMATCH`。既有测试零删除、零跳过、零放宽（夹具增强只为满足更强的证据校验）。

## 13.5 真实研究状态（不变）

- D2 / D5 / D6：**均未批准**（无任何真实 Owner 决策记录）。
- 真实模型调用次数：**0**。Owner 盲评实际样本数：**0**。
- 真实数据探测：**未执行**（本轮所有 D6 正向路径测试均使用隔离合成快照）。
- 真实 T6 资格：**BLOCKED**（fail-closed 诚实结论；本轮所有 GREEN 的校准/盲评数字均为合成夹具，不冒充真实结果）。

## 13.6 第三轮结论

**Verdict: PASS_WITH_LIMITATIONS。** 6×P1 + 4×P2 全部修复且有对应负向/边界/集成测试；遗留限制仍为外部前置条件（D2/D5/D6 授权），非代码缺陷。PR 未合并。
