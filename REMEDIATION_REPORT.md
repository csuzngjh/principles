# PR #2740 终审整改 — 最终报告

工单：PRI-1258（PD-Lab v0.3 T7a-judge）。PR：<https://github.com/csuzngjh/principles/pull/2740>。报告日期：2026-11-21。

## Owner Review Card（§27）

**Problem**：独立评审发现 [PR #2740](https://github.com/csuzngjh/principles/pull/2740) 虽 CI 绿，但 T7a 校验器把整包合并成单个 T4 plan（每个比较未按各自席数归并、记录有效性漏判、仲裁未经结构门、协议字段可篡改仍通过），T6 资格门探索性无授权即可判定、源组 digest 可被假装重算、artifactRef/alpha null 等畸形输入在 `--out` 创建后崩溃。

**Before**：perAssignment 行为与 T4 偏离；探索性可 promote；P1-1..P1-6、P2-1..P2-4 缺陷存在（见 §2）。

**After**：校验器逐比较归并（perAssignment 忠实复现 T4 `mergeJudgments`），bundle 级重复仲裁/案例版本冲突/未声明键歧义均 fail；探索性必须 prereg `exploratory===true` + 绑定 D2 exploratory 批准且永不 PROMOTE；源组 digest 经 `sourceGroupsDigestOf` 字节级诚算；协议冻结字段逐项比对；无效输入先 fail 后建 `--out`。

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
| P2-4 | 无效输入在 outDir mkdir 前 fail | `judge-protocol-validate.mjs`、`t6-qualify.mjs` |

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
