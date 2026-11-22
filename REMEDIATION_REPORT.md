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

---

# 14. 第四轮：Devin/CodeRabbit 对第三轮交付的复审修复（2026-11-22，commit `d544a8e26`）

第三轮推送后 Devin Review + CodeRabbit 对新交付提出 19 个评审线程（17 个独立 finding，2 组跨工具重复）。逐项处置：**16 项代码修复**、1 项语义说明（DV1）、1 项部分修复+披露（CR10）。

| 线程 | 问题 | 处置 | 测试 |
|---|---|---|---|
| DV1 | 裁判一致率 ≠ 确认性区间精度 | 语义说明：precisionTarget 是 T7a 校准层精度（HANDOFF T7a「Owner 校准达到预注册标准」）；来源组统计精度由 n≥n_min(α)+最低组数双门槛覆盖，区间精度属 T6 运行时分析 | — |
| DV2/CR8 | UNSTABLE 复评可通过 | `allRecheckStable = recheckStable === sampleCount` | t6 round-4 用例 |
| DV3 | UNKNOWN 交换稀释翻转率 | flip 分母只含 determinate 判定 | t6 round-4 用例（两分支） |
| DV4/CR7 | 同包重复评审抬样本量 | 评审单元 = (packageId, displayOrder)，重复即 invalid | t6 round-4 用例 |
| DV5/CR9 | 旧探测报告配新 D6 决策 | `realDataProbe.d6Decision.sha256 === 绑定 artifact 摘要`；probeScope 为权威读取源 | t6 round-4 用例 |
| DV6 | FAILED 调用绕过模型核验 | FAILED invocation 同样核对 model === judgeModel | t6 round-4 用例 |
| DV7 | JSON null 证据崩溃 | 参数核对 isPlainObject 守卫，降级 BLOCKED 不抛异常 | t6 round-4 用例 |
| DV8 | D6 不限制快照 | 可选 `trajectoryDbSha256` 钉定：probe 打开 trajectory.db 后不匹配即 fail-closed；probeScope 回显实际快照摘要；T6 引擎侧同步核对 | admission-probe DV8 两用例 + t6 引擎用例 |
| CR1 | 非数组 arbitrations 被吞 | `--out` 创建前 exit 2 | judge-protocol CR1 |
| CR2 | 诊断标签 String() 风险 | `diagnosticId()` 安全标签（非字符串 → 占位） | 既有闭集回归 |
| CR3 | 同包双判被误配为交换 | counterKey 排除同 packageId | judge-protocol CR3 |
| CR4 | FAILED 侧交换计 consistent | `neitherFailed` → undetermined | judge-protocol CR4 |
| CR5 | 重复 truncatedSide 覆盖 | 结构校验 + digest 规范化器同规则拒绝 | judge-protocol CR5 |
| CR6 | modelCallCount 按成功数核对 | checkClaim 改用 auditCallCount（总调用） | t6 round-4 用例（两分支） |
| CR10 | 换 prereg 文件复用证据 | 可选 `preregistrationSha256` 绑定 + `PREREGISTRATION_IDENTITY_UNBOUND` 披露；强制绑定属 Owner/SPEC 决策（follow-up） | t6 round-4 用例 |
| CR11 | 结构验证先于证据读取 | CLI 解析后立即 `validateQualificationInput` exit 1 | 既有 P2-4 用例 |

全部 19 线程已逐条回复并 resolve（引用 `d544a8e26`）。测试总量：judge-protocol 79、t6 82（+1 环境性 skip）、admission-probe 155（+1 环境性 skip）。真实研究状态不变（D2/D5/D6 未批准、真实调用 0、盲评 0、真实资格 BLOCKED）。


# 15. 第五轮：HEAD `8dab3755f` 复审新发现修复（2026-11-22）

第四轮交付后，Devin 在最新 HEAD 上提出 5 项新 finding。本轮直接修改本地工作树，不再把整改委托给本地 AI；修复范围限定在 T6 资格判定、D6 快照读取、对应回归测试及测试类型检查。

| Finding | 根因 | 修复 | 回归证据 |
|---|---|---|---|
| D2 preregistration digest 不一致 | Owner 决策记录使用 64 位 bare hex，证据 binding 使用 `sha256:<hex>`；原比较把两种编码当成不同摘要 | 增加严格的 SHA-256 hex 提取器，只接受小写 64 位 bare hex 或规范 `sha256:` 前缀；D2 冻结摘要与 binding 按摘要字节比较 | 新增 bare-hex D2 正向用例；原 HEAD 下该用例失败 |
| D6 decision digest 不一致 | admission-probe 回显 D6 决策文件摘要为 bare hex，T6 binding 为带前缀格式；原始字符串比较拒绝真实生产格式 | `deriveDataPathAuthorization` 对回显值与 binding 摘要做同一严格规范化；不接受 malformed digest | 原有真实 `RAN_WITH_D6` 正向路径在原 HEAD 下失败，修复后通过 |
| D6 mismatch 的 WAL staging 残留 | 原流程先创建 WAL staging、打开 SQLite，之后才比较 Owner pin；fail-fast 退出绕过 staging 清理 | 在任何 staging/SQLite open 前核验 D6 pin；`stageWalSnapshot` 在创建临时目录前再次核验 main-file digest；对实际打开文件记录摘要，post-open 失败先 close 并清理 staging；报告绑定实际打开文件摘要 | 新增真实 CLI WAL mismatch 用例；原 HEAD 下留下 `pd-lab-probe-stage-*`，修复后无残留 |
| D5 position-flip rate 未测量 | 所有 judge verdict 均为 UNKNOWN 时，翻转率分母为 0、派生值为 null；原逻辑只比较非 null 数值，等同于把未测量当作满足阈值 | 新增 `POSITION_FLIP_RATE_UNMEASURED`；D5 已批准且校准报告 PASSED、但无任何 determinate position-exchange outcome 时，T6 fail-closed | 新增全 UNKNOWN 用例；原 HEAD 下缺少该阻断码，修复后 BLOCKED |
| CR6 auditCallCount 可掩盖声明调用数 | 输入侧可提供 `auditCallCount`，并优先于 `modelCallCount` 参与声明值比较 | 输入拒绝调用方自报 `auditCallCount`；声明值固定取 `modelCallCount`，派生值从绑定原始 invocation 重算为 succeeded + failed 总数 | 新增独立 mask 用例；固定 D6 格式避免跨 finding 干扰；原 HEAD 下该断言失败，修复后输入校验拒绝 |

## 15.1 测试与静态检查

- 两个完整套件：`pd-lab-t6-qualification.test.ts` + `pd-lab-admission-probe.test.ts`，**240 passed / 2 skipped / 0 failed**。
- `npm run typecheck:pd-lab-tests`：通过。新增 `scripts/tsconfig.pd-lab-tests.json`，并把该检查接入根 `verify:merge`，避免这两份 TypeScript 测试文件只经 Vitest transpile 而不做类型检查。
- `npm run lint`：13/13 packages 通过，0 errors（仓库现有 warnings 保留）。
- `git diff --check`：通过。
- EP-09 mutation check：临时用原 HEAD 生产源码运行新增回归用例，T6 4 项用例失败，WAL staging 用例 1 项失败；恢复后两份生产源码与修改前备份逐字节一致。

## 15.2 Error Context 路由结果

按仓库要求实际运行 preflight 与 diff 模式：

- Preflight：EP-09 HIGH（score 4），EP-10 HIGH（score 4）。
- Post-diff：EP-09 HIGH（score 23）、EP-10 HIGH（score 14）、EP-02 HIGH（score 9）、EP-14 HIGH（score 8）、EP-01 HIGH（score 6）、EP-03 HIGH（score 6）。
- EP-09：已用原 HEAD mutation 证明新回归测试确实能捕获修复前行为；D6 WAL 测试走真实 CLI 子进程，不是 source-string assertion。
- EP-02：D6 WAL 拒绝与 staging 清理通过 admission-probe 真实 CLI 入口验证；T6 证据判定通过资格引擎及 CLI 既有集成路径验证。
- EP-14：新增专用 TypeScript test config 和 `typecheck:pd-lab-tests`，并接入 `verify:merge`。
- EP-10：路由由 `scripts/dev` 路径信号触发；本轮没有修改 worktree 删除/清理逻辑，也没有声称任何 CI 失败是 main 预存问题，因此该模式的 worktree-cleanup 专项要求不适用。

## 15.3 真实研究状态与合并状态

真实研究事实不变：D2/D5/D6 仍无真实 Owner 批准；真实模型调用 0、Owner 盲评 0、真实数据探测未执行；T6 仍必须保持 BLOCKED。所有新增正向测试均使用合成证据/隔离快照。

本轮修复已完成本地验证；**PR 尚未合并**。合并前必须以包含本轮修复的最新 PR HEAD 的 GitHub CI、评审及分支保护状态为准；本地通过不能替代远端门禁。
