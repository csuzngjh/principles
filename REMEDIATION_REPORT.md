# PR #2740 终审整改 — 最终报告（12 节）

工单：PRI-1258（PD-Lab v0.3 T7a-judge）。PR：<https://github.com/csuzngjh/principles/pull/2740>。报告日期：2026-11-21。

## 1. 任务范围

按终审指令修复 PR #2740 已交付机制（P0-1 T6 资格门、P0-2 完整语义交换、P0-3 仲裁绑定、P1-1 记录有效性、P1-2 slot/attempt 完整性、P1-3 深冻结+digest、P1-4 CLI 异常安全），并闭环代码、测试、证据、文档与远端 CI。本轮无新增功能；所有修复发生在既有 `ai/PRI-1258-judge-protocol-t6-gate` 分支。

## 2. 逐项落地

| 终审项 | 落地 | 位置 |
| --- | --- | --- |
| P0-1 | 状态/计数一致性表；`evidence` 段 `{artifactRef, sha256}` 由 CLI 按真实字节重算（篡改→exit 1）；D2/D5/D6 结构化 owner-decision 记录（非 Boolean）；`readyIndependentSourceGroups` 由 source-groups+admission 报告机械推导；α/最低组数/精度目标取自冻结预注册（漂移→`PREREGISTRATION_DRIFT`）；3 态；EXPLORATORY `promotePossible` 恒 false；复用 T4 `twoSidedThreshold` | `t6-qualification.mjs`（~1000 行）、`t6-qualify.mjs` |
| P0-2 | `verifySwapPair` 完整语义校验：字节级输出交换、identityMap 真反转、context/rubricVersion/judgeProtocolRef/question 不变、displayOrder 翻转、truncation 按角色侧交换；角色规范化 digest；UNKNOWN/FAILED/invalid 单独披露不入分母 | `judge-protocol-validate.mjs` |
| P0-3 | 仲裁绑定 = T4 `boundAll`：完整 judgment id 集 + 完整 comparisonInputDigest 集分别比较 + assignmentKey + arbitrationId + 合法 verdict | 同上 |
| P1-1 | `perRecord[].valid` 聚合全部检查；无效记录不投票、不进交换统计；FAILED 保留不投票 | 同上 |
| P1-2 | `judgeSlotId` 缺失 → `JUDGE_SLOT_BINDING_MISSING`（绝不默认）；无席位表 → `JUDGE_SLOT_REGISTRATION_UNVERIFIED`；非 FAILED 缺 attempt → `ATTEMPT_MISSING`；语义与 T4 `mergeJudgments` 逐案一致 | `judge-protocol.mjs`、`judge-protocol-validate.mjs` |
| P1-3 | `JUDGE_PROTOCOL` 与全部导出常量数组深冻结；记录必绑 `judgeProtocolRef`+`judgeProtocolDigest`+`rubricVersion`（不符 → `PROTOCOL_DIGEST_MISMATCH`）；v1 交付前定版 digest | `judge-protocol.mjs` |
| P1-4 | 结构校验先于 digest；退出码 arg=2 / invalid=1 / evidence-fail=1 / BLOCKED=0 / problems=1；9 类畸形输入 → 具名问题不崩溃 | 两个 CLI |

**Devin Review 第二轮加固（commits `9faad0de7`、`5f4f7fd8d`、`2374c5e95`）**：校准只计 SUCCEEDED 调用为成功证据（失败调用保留审计数）；批准 `scope` 必须与绑定槽位一致；未绑预注册 → `EVIDENCE_MISSING_FOR_CLAIM`；`precisionTarget` 必须等于冻结目标；data-path 只认 `RAN_WITH_D6` 闭集；source-groups digest 双层绑定（datasetSha256 + 报告记录的分组 digest）；显式 swapOf 先全局登记再推断（歧义 → `SWAP_OF_INVALID`）；显式声明不被"已配对"跳过（链式冲突仍报）；配对还要求同 `assignmentKey` 比较身份（跨任务反像不配对）。

## 3. 新增问题码

资格层 7 个 + 交换层 9 个 + `INVALID_ARBITRATION_RECORD` + 披露 `AUTHORITY_PROVENANCE_UNVERIFIED`（详见报告 §12 与代码 `PROTOCOL_RECORD_PROBLEM_CODES` 26 码闭集）。

## 4. 验证

- `pd-lab-judge-protocol.test.ts`：**47 用例全绿**（真实 CLI 子进程矩阵、ERR-146 双闭集 round-trip、T4 `mergeJudgments` 集成、交换/仲裁/per-record/CLI 异常全覆盖）。
- `pd-lab-t6-qualification.test.ts`：**32 用例全绿**（状态表、证据绑定、组推导、预注册漂移、三态、篡改拒绝、CLI exit 语义 + 8 个 review 加固回归）。
- 全部 pd-lab 测试文件：**696 通过 / 7 跳过**。
- eslint：0 error；`error:context` diff 模式：无新增 actionable 命中（EP-09/EP-10 词法命中已在 PR Error Experience 记录）。
- pre-commit/pre-push hooks：全部通过（commit-identity、worktree-guard、repo-hygiene、lint、fast-push 语法）。

## 5. 真实事实（如实声明，合成结果绝不冒充真实校准）

- 真实模型调用：**0 次**（D2 未批准）。
- Owner 盲评样本：**0**（D5 未批准）。
- 真实全保真数据探测：NOT_RUN（D6 未批准）。
- 真实 T6 资格：机械推出 **BLOCKED**（无 D2/D5/D6、n=0、无校准/盲评证据）。
- 合成一致性测试仅证明引擎行为，报告中明确区分。

## 6. 版本与 digest

- Judge Protocol：`jp-pd-lab@1`，最终冻结 digest `sha256:82c78a1e399165f08fb5dd22be68a8aef2dbfeff1e8ffb953f2f02668e4459a5`（本 PR 合并前定版；无存量真实记录）。
- 统计口径：CONTRACT §6.5，`twoSidedThreshold` 全 BigInt 双侧精确阈值，`n_min(α)` 公式推导不硬编码。

## 7. 文档更新

`docs/reports/PD_LAB_V03_JUDGE_CALIBRATION.md`：digest 更新、用例计数更新（45→47、25→32）、§12 终审整改表、§12.1 Devin Review 第二轮加固清单、§13 Complexity Delta。PR 描述同步更新 digest、用例数与整改章节。

## 8. PR 远端状态（§13 Acceptance Gates）

- HEAD：`2374c5e95`。Merge status：**Mergeable (no conflicts)**。
- CI：**26/26 通过、0 失败、1 skipped**（Verify Merge Gate ✅、quick-check ✅、Analyze/CodeQL ✅、全部包测试 ✅）。
- Devin Review：最新一轮 **0 findings**（全部 8 项历史 findings 已修复并逐线回复）。
- 评审回复：7 个文件评论线程均给出修复说明 + 对应 commit。

## 9. 已知限制

- `AUTHORITY_PROVENANCE_UNVERIFIED`：本地字节核验不能认证批准者身份，批准记录仅按完整性采纳并披露。
- 无真实预注册席位表（无 D2），`JUDGE_SLOT_REGISTRATION_UNVERIFIED` 如实披露。
- 真实 `lab:probe` 当前必然 `NOT_RUN_WITHOUT_D6` —— 刻意 fail-closed，D6 授权探测运行后才会出现 `RAN_WITH_D6`。
- Windows 本机 2 个 `release-immutable-candidate` 失败为 runner 环境变量问题（pre-existing，本 PR 零改动该文件；CI Linux 全绿）。

## 10. 合规边界（§2.2 逐条遵守）

`ab-eval.mjs` 零改动；T4 业务语义零改动；无新 DB/服务/feature flag；无新依赖；零网络；零真实裁判调用；零真实 Owner 评审；未伪造 D2/D5/D6；未把真实资格写成 CONFIRMATORY_READY；未启动真实 T6；**未 merge PR**；无跳过/放松测试。

## 11. 回滚路径

Revert 本 PR 的 8 个新增/修改文件（4 个源文件 + 2 个测试 + 校准报告 + PR 描述）；`alignment-report.mjs` 仅一处 `export` 变更。无生产副作用。

## 12. 结论

**Verdict: PASS_WITH_LIMITATIONS。** 全部终审整改项 + 两轮 Devin Review findings 已修复闭环：代码、测试（47+32 绿、pd-lab 套件 696 绿）、lint/type、远端 CI（26/26 ✅、PR MERGEABLE）全部通过，文档如实更新。遗留限制均为不可由本任务解决的外部前置条件（D2/D5/D6 未批准 → 真实 T6 资格 BLOCKED 且必须保持 BLOCKED），非代码缺陷。PR 未合并，等待 Owner 审批。
