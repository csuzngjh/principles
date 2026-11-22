# PD-Lab v0.3 T7a — Judge Protocol、裁判校准与 T6 资格报告（PRI-1258）

日期：2026-11-21。工单：PRI-1258（母工单 PRI-1250）。基线：origin/main `b1e7c9d8b`（PR #2733 已合并）。

本报告按 HANDOFF T7a 第 3–5 项与任务卡 P5 分层如实呈现：**合成协议校验（已执行）** 与 **实时裁判校准 / Owner 盲评 / 真实数据资格（NOT_RUN，授权缺失）** 严格分开。任何合成结果都不冒充真实模型校准。

## 1. 版本化 Judge Protocol

| 项 | 值 |
| --- | --- |
| `judgeProtocolRef` | `jp-pd-lab@1` |
| 协议内容 digest | `sha256:82c78a1e399165f08fb5dd22be68a8aef2dbfeff1e8ffb953f2f02668e4459a5`（最终冻结定义的规范化 JSON SHA-256，确定性可复算；PR #2740 终审修订 judgeSlot/attempt/positionExchange/arbitration 策略后重定，本 digest 即交付时唯一权威值） |
| rubric 版本 | `jp-pd-lab-rubric@1`（比较问题固定为 SPEC §8.2 的"哪个实际行为轨迹更贴近期望"） |
| 四值判定 | `A_BETTER / TIE / B_BETTER / UNKNOWN`；UNKNOWN 必须带原因；非法输出拒绝、绝不转 TIE |
| 输出契约 | 三字段行协议（`VERDICT:` / `REASON:` / `UNKNOWN_REASON:`），闭集解析 |
| lossyInput 策略 | 截断/降级送评材料标记 `lossyInput: true` + 截断位置（侧别/位置/原始长度）；有损输入的判定必须是 UNKNOWN |
| 比较输入 digest | 按真实臂角色（candidate/reference）规范化后摘要：同一比较的两次位置交换共享同一 digest（"one frozen comparison"，与 T4 `COMPARISON_INPUT_DIGEST_CONFLICT` 门语义对齐）；显示顺序与受控身份映射逐记录保存 |
| 裁判/生成器关系 | 记录级 `judgeModel`/`generatorModel`（provider/model/version）+ `modelRelationDisclosure`（闭集 `SAME_FAMILY`/`DIFFERENT_FAMILY`；未披露即非法记录） |
| 历史 `ab-eval.mjs` | 零改动（提示词/输出格式/历史记录/历史哈希均未触碰）；历史三值输出由 T4 适配层按原义映射 |

实现位置：`scripts/dev/pd-lab/judge-protocol.mjs`（纯函数，无 fs/env/时钟）。

## 2. 模型裁判校准结果：**NOT_RUN**

- Linear 及私有文档中均无 D2 批准记录（Owner 2026-11-21 执行对账评论确认）。D2 需冻结具体模型/provider、许可、预算、α、重复次数、统计目标。
- 未取得 D2 前**未发起任何真实模型调用**。资格引擎把"无 D2 但记录了模型调用"机械识别为 `UNAUTHORIZED_MODEL_CALLS_RECORDED` 停止条件。
- 合成协议校验（第 6 节）只证明协议确定性，不构成校准证据。

## 3. Owner 一致率：**未测量（0 样本）**

- 无 D5 批准记录。Owner 盲评样本数 = **0**；一致率、复核稳定性均不适用。
- 资格引擎把"无 D5 但记录了盲评样本"机械识别为 `UNAUTHORIZED_OWNER_BLIND_REVIEW_RECORDED`。

## 4. A/B 位置翻转率：**未测量（实时）；合成层已接线**

- 翻转率 = 同一比较包在两种显示顺序下还原结论不一致的比率（D5 校准指标）。
- 协议校验 CLI 已机械输出 `positionExchange.{consistent, flipped}`（合成夹具上验证：一致对与翻转对均正确分类，翻转为披露数据、不作废条目）。实时翻转率待 D2+D5 后测量。

## 5. 分歧类型：未测量

- 分歧类型学（胜负冲突 / TIE 与胜负冲突 / 证据理由冲突）在协议层以 `perAssignment.{conflict, resolvedBy, outcome}` 呈现；合成层已验证：冲突无仲裁 → UNKNOWN（SC-10，绝不平均成 0.5）；完整绑定仲裁 → 采纳仲裁结论；不完整绑定 → 保持 UNKNOWN。真实分歧分布待授权后测量。

## 6. 合成协议校验（已执行，无需 D2/D5）

测试入口：`npm run test:scripts`（`scripts/__tests__/pd-lab-judge-protocol.test.ts`，75 用例，全部通过；真实 CLI 子进程驱动 `npm run lab:judge-validate`）。

| 校验面 | 结果 |
| --- | --- |
| 记录 schema 闭集 round-trip（ERR-146） | PASS：26 个记录问题码全部可触发、无一越集（终审新增 `ATTEMPT_MISSING`、`JUDGE_SLOT_BINDING_MISSING`、`PROTOCOL_DIGEST_MISMATCH`） |
| 输出解析闭集 round-trip | PASS：10 个 `JUDGE_OUTPUT_*` 码全部可触发 |
| 四值解析 + UNKNOWN 原因 | PASS（含 CRLF、空原因、非 UNKNOWN 带原因拒绝） |
| 非法输出 fail-closed | PASS（8 类非法输入全部拒绝且不产生任何 verdict） |
| 输入 digest 一致性 | PASS（重算一致；篡改 digest/内容/错绑映射均被检出） |
| 盲包泄漏 | PASS（worktree 路径、臂词整值、臂元数据键三类泄漏均在构建期拒绝；泄漏规则单一源自 `ab-blindpack` 导出的扫描器；第三轮起 packageId 含臂词子串、交换包复检同样拒绝） |
| A/B 位置交换 + 身份还原 | PASS（SC-09：交换后双方还原到同一候选结论；交换不改真实候选身份；digest 证明"同一冻结比较"；交换包过最终泄漏门） |
| 失败 attempt 保留 | PASS（`attemptStatus: FAILED` 记录保留于审计轨迹、不投票） |
| 争议仲裁 | PASS（未解决→UNKNOWN；完整绑定→采纳；半绑定→UNKNOWN） |
| 确定性归并 | PASS（经真实 T4 `mergeJudgments`：记录乱序输入逐字节同输出；与 T4 计划/席位语义兼容——双席位预注册 `requiredJudgments: 2`；声明计划行全部到达 FinalComparison——无记录的声明行输出 UNKNOWN/MISSING_JUDGMENTS，绝不静默丢弃） |
| lossyInput | PASS（截断→标记+位置事实；有损判胜=非法记录；交换后截断侧随内容移动；完整输入不得标记有损） |
| 复现性 | PASS（同一 bundle 两次校验输出逐字节一致；协议 digest 稳定） |

统计与资格测试：`scripts/__tests__/pd-lab-t6-qualification.test.ts`，84 用例通过（另 1 个环境条件 skip）。`pd-lab-admission-probe.test.ts` 156 用例通过（另 1 个环境条件 skip；D6 正向/负向路径现为 8 例，包含 WAL 快照 pin 不匹配时拒绝且不遗留 staging 副本）。两套完整测试合计 240 passed、2 skipped、0 failed。

## 7. 输入完整性

- **真实全保真数据：未探测（无 D6）**。T1 真实快照未执行（PR #2733 报告：真实快照 NOT_PROBED），因此 T6 路径的 READY 独立来源组数 n 不可得，按未证明处理（`dataIntegrityValid: false`）。
- 合成夹具输入完整性由协议机械规则保证：截断必标记、关键证据缺失判 UNKNOWN、缺映射即无效证据不猜测。

## 8. 统计边界（CONTRACT §6.5）

- 双侧 k(n, 0.05) 与 CONTRACT 表逐项一致：n=6..16 → 6/7/8/8/9/10/10/11/12/12/13；n=20/30/50/100 → 15/21/33/61。
- 任务边界 n=0/1/5/6/8/9/11/12/14 → k = null/null/null/6/8/8/10/10/12。
- n=1..5 不存在 k≤n 的可拒绝阈值（数学不可达，非功效不足）。
- `n_min(α)` 按公式推导、不硬编码 6：α=0.05→6、0.10→5、0.01→8、0.20→4；每个值均以独立二项重算验证边界（2^-n_min ≤ α/2 < 2^-(n_min-1)）。
- 统计实现复用 T4 `alignment-report.twoSidedThreshold`（全 BigInt 精确有理比较，PRI-1252 r4 修复版）——统计口径单一事实源。
- α 变更对资格的影响如实可见：n=5 在 α=0.10（n_min=5，最低组数=5）下可达 CONFIRMATORY_READY，在 α=0.05 下为 EXPLORATORY_ONLY——**生产 α 必须来自 D2 冻结值**，事后改 α 属协议版本变更须重新预注册（输出回显 α 以暴露漂移）。

## 9. 授权状态

| 决策 | 状态 | 依据 |
| --- | --- | --- |
| D2（真实模型裁判调用） | **未批准** | Linear 无批准记录（2026-11-21 Owner 对账评论） |
| D5（Owner 盲评） | **未批准** | 同上 |
| D6（全保真数据） | **未批准** | PRI-1257 报告：真实快照 NOT_PROBED（无 D6） |

实际模型调用次数：**0**。Owner 盲评次数：**0**。失败 attempts（真实）：**0**（无调用即无失败）。

## 10. 最终资格结论（机械可复算）

当前真实状态输入与结论（`npm run lab:qualify` 实际输出；输入 JSON 见下，可逐字段复核）：

```json
{
  "readyIndependentSourceGroups": 0,
  "analysisPolicy": { "alpha": 0.05, "minimumIndependentSourceGroups": 14, "precisionTargetMet": false },
  "authorization": { "dataPathAuthorizationValid": false, "dataIntegrityValid": false, "d2Approved": false, "d5Approved": false },
  "judgeModelCalibration": { "status": "NOT_RUN", "modelCallCount": 0 },
  "ownerBlindReview": { "status": "NOT_RUN", "sampleCount": 0 }
}
```

```json
{
  "ok": true,
  "status": "BLOCKED",
  "blockedReasons": ["DATA_PATH_AUTHORIZATION_INVALID", "DATA_INTEGRITY_UNPROVEN", "NO_READY_SOURCE_GROUPS",
                     "D2_NOT_APPROVED", "D5_NOT_APPROVED", "D6_NOT_APPROVED", "MODEL_CALIBRATION_NOT_RUN"],
  "unmetCriteria": [],
  "nMinAlpha": 6, "kAtReadyN": null,
  "t6Permissions": { "confirmatoryT6Allowed": false, "exploratoryT6Allowed": false, "promotePossible": false }
}
```

**T6 资格 = BLOCKED，不得启动 T6**（确认性与探索性均不允许）。说明：输入中的 α=0.05 与 minimumIndependentSourceGroups=14 为 SPEC 建议默认值（用于演示引擎），并非 D2 冻结参数——BLOCKED 结论不依赖它们（全部阻断原因为授权/校准类）。

复算命令：

```bash
npm run lab:qualify -- --input <qualification-input.json> --out <dir>
```

三态判定规则（`scripts/dev/pd-lab/t6-qualification.mjs`，纯函数，74 项测试）：

- **BLOCKED**：授权/完整性不合格、n=0、D2/D5 未批准、实时校准未运行或失败、或出现无授权活动记录（停止条件）；第三轮起还包括批准参数与冻结证据不一致（`APPROVAL_PARAMETER_MISMATCH`——D2 的模型/α/最低组数/精度目标/预算、D5 的样本下限/一致率阈值/翻转率上限/复评稳定性、D6 的 datasetSha256 三方绑定逐项核对）。
- **EXPLORATORY_ONLY**：门全过但 n < n_min(α)、或 n < 预注册最低组数、或精度目标未达、或 Owner 盲评未通过、**或预注册标记为探索性（`PREREGISTRATION_EXPLORATORY_CAP`：该标记是永久上限，任何后续证据都不能把探索性预注册升级为确认性）**。探索性 T6 执行权需同时满足：EXPLORATORY_ONLY、绑定且批准的 D2 决策、该决策显式授予 exploratory、预注册标记 exploratory、D5 批准、Owner 盲评实际 PASSED 且达到 D5 批准的样本下限；`promotePossible` 恒 false——**探索性结果绝不产生 PROMOTE**。
- **CONFIRMATORY_READY**：全部门通过且 n ≥ max(n_min(α), minimumIndependentSourceGroups) 且精度目标满足。

## 11. 限制与未完成事项

1. **实时裁判校准 NOT_RUN**（无 D2）：一致率、翻转率、真实失败 attempts、真实分歧分布全部未测量，不得引用合成数字替代。
2. **Owner 盲评 0 样本**（无 D5）。
3. **真实资格输入不可得**（无 D6）：n 待真实快照探测；当前 BLOCKED 是 fail-closed 的诚实结论。
4. `ab-eval.mjs` 文件头注释与实现不符（声称 openrouter/ernie，实际 ZAI glm-5.3）——TECH §6.6 列为 T6 前修正项；本任务按"不改历史文件"边界未触碰，留 T6 执行（裁判/生成器同族限制已在本协议记录级强制披露）。
5. Judge Slot 注册/校准属 T7a-judge 的 D2 后续层：T4 侧引用完整性验证与 `JUDGE_SLOT_REGISTRATION_UNVERIFIED` 披露已在（PR #2696），预注册席位表由未来获授权的预注册提供。
6. `owner-spotcheck-list.mjs` 抽样与 D5 盲评流程待 D5 批准后接线（HANDOFF T7a 第 3 项第 4 层）。
7. 位置翻转率的实时测量依赖"同一包交换顺序再评一次"的 D2 冻结调用方案；合成层指标已就绪。

## 12. PR #2740 终审整改记录（本轮交付）

终审指令要求修复已交付机制而非新增功能。逐项位置与验证：

| 项 | 修复 | 位置 | 新增/更新测试 |
| --- | --- | --- | --- |
| P0-1 T6 资格门 | 状态/计数一致性表（PASSED+0、NOT_RUN+>0 均为拒绝性冲突；FAILED+>0 保留证据不计通过）；`evidence` 段绑定 `{artifactRef, sha256}`，CLI 按真实字节重算 digest，不符即 exit 1；D2/D5/D6 必须是结构化批准记录（owner-decision 形状），普通 Boolean 不再足够；`readyIndependentSourceGroups` 由 source-groups+admission 报告机械推导（按组 dedup、仅计全 T6 路径 READY 的组，声明≠推导即拒绝）；α/最低组数/精度目标取自冻结预注册，漂移即 `PREREGISTRATION_DRIFT` | `scripts/dev/pd-lab/t6-qualification.mjs`、`t6-qualify.mjs` | 状态/计数表、证据绑定、dedup/非 READY 排除、digest 篡改 exit 1、预注册漂移、三态全一致性 |
| P0-2 完整语义交换 | `verifySwapPair`：字节级输出交换、identityMap 真反转、context/rubricVersion/judgeProtocolRef/question 不变、displayOrder 翻转、truncation 按角色侧交换（CONTEXT 不换）；digest 仍为同一角色规范化算法 | `judge-protocol-validate.mjs` | 未反转映射、内容漂移、truncation 侧错、UNKNOWN/invalid 不纳入分母、dup/missing/malformed swapOf |
| P0-3 仲裁绑定 = T4 | `boundAll` 同义：完整参与 judgment id 集 + 完整参与 comparisonInputDigest 集 + assignmentKey + 合法 verdict，id 与 digest 分别比较 | 同上 | 缺/篡改/部分 digest、部分/多余 id、缺 arbitrationId、孤儿仲裁、绑定完整的 UNKNOWN 仲裁 |
| P1-1 记录有效性聚合 | `perRecord[].valid` 聚合全部检查；无效记录不投票、不进交换统计；FAILED 保留不投票 | 同上 | invalid 记录排除于投票与交换分母 |
| P1-2 Slot/attempt 完整性 | `judgeSlotId` 缺失 → `JUDGE_SLOT_BINDING_MISSING`（绝不默认）；无预注册席位表 → 披露 `JUDGE_SLOT_REGISTRATION_UNVERIFIED`；非 FAILED 缺 attempt → `ATTEMPT_MISSING`（绝不默认 1）；重用语义与 T4 `mergeJudgments` 逐案一致 | `judge-protocol.mjs`、`judge-protocol-validate.mjs` | T4 集成用例：缺槽/缺 attempt/同槽冲突/FAILED 不投票 |
| P1-3 深冻结 + digest 保真 | `JUDGE_PROTOCOL` 与全部导出常量数组深冻结；digest 绑定最终冻结定义；记录必绑 `judgeProtocolRef`+`judgeProtocolDigest`+`rubricVersion`，不符 → `PROTOCOL_DIGEST_MISMATCH`（v1 交付前定版，无存量真实记录受影响） | `judge-protocol.mjs` | 冻结不可变 + digest 稳定、记录绑定校验 |
| P1-4 CLI 异常安全 | 结构校验先于 digest 计算；退出码：参数/不可读 2、JSON/schema 1、证据核验失败 1、BLOCKED 0、校验有问题 1；无裸栈 | 两个 CLI | 9 类畸形包/绑定/记录/仲裁 → 具名问题不崩溃 |

新增资格层问题码：`D6_NOT_APPROVED`、`CALIBRATION_STATUS_COUNT_CONFLICT`、`OWNER_REVIEW_STATUS_COUNT_CONFLICT`、`EVIDENCE_MISSING_FOR_CLAIM`、`EVIDENCE_ARTIFACT_INVALID`、`EVIDENCE_CLAIM_MISMATCH`、`PREREGISTRATION_DRIFT`；交换层 `SWAP_OF_INVALID`、`SWAP_PARTNER_MISSING`、`SWAP_CONTENT_MISMATCH`、`SWAP_IDENTITY_NOT_INVERTED`、`SWAP_DISPLAY_ORDER_MISMATCH`、`SWAP_TRUNCATION_MISMATCH`、`SWAP_DIGEST_MISMATCH`、`SWAP_DUPLICATE_PAIRING`、`SWAP_PARTNER_INVALID`；仲裁 `INVALID_ARBITRATION_RECORD`；披露 `AUTHORITY_PROVENANCE_UNVERIFIED`（本地完整性核验不能证明批准者身份，如实披露）。

真实事实不变：真实模型调用 0 次、Owner 盲评 0 样本、D2/D5/D6 均未批准、真实 T6 资格 BLOCKED。合成一致性测试只证明引擎行为，不冒充真实校准。

### 12.1 Devin Review 第二轮加固（commit `9faad0de7`）

终审整改合入后 Devin Review 报告 6 项 fail-closed 缺口，逐项修复并回归：

- 校准成功证据只统计 `SUCCEEDED` 唯一调用（`modelCallCount`），失败调用仍计入审计总数（`auditCallCount`，`UNAUTHORIZED_MODEL_CALLS_RECORDED` 使用审计总数）——`PASSED` + 全失败调用不再能通过。
- 批准记录的 `scope` 必须严格等于其绑定的证据槽位——D5 批准文件不能再被填进 d2 栏。
- 预注册成为声明性分析参数的必备证据：未绑定 → `EVIDENCE_MISSING_FOR_CLAIM`（不再回退采用输入 α/最小组数）；校准的 `precisionTarget` 必须等于预注册的冻结目标（缺锚 → `EVIDENCE_ARTIFACT_INVALID`，不一致 → `EVIDENCE_CLAIM_MISMATCH`）。
- 数据路径授权只认双方约定的正向态 `realDataProbe.status === "RAN_WITH_D6"`（闭集），其余任何取值一律拒绝。
- 分组映射第二层绑定：source-groups 文件 `digest` 必须等于准入报告记录的 `sourceGroups.digest`，误选不同合并规则的分组文件即拒绝。
- 交换配对先全局登记显式 `swapOf` 关系再推断：已绑定包不再被二次推断抢占，未声明包只配对唯一未占位反像，歧义 → `SWAP_OF_INVALID`——两对同内容的合法交换不再被误报 `SWAP_DUPLICATE_PAIRING`。

## 13. Complexity Delta

```text
New durable source of truth: NO   （协议定义/digest 为版本化冻结定义，judgment 记录仍是实验证据；归并权威仍是 T4）
New persisted schema/state:  NO   （无库、无服务；输出均为 --out 派生 JSON）
New subsystem/service/background process: NO
New public abstraction/interface: NO  （两个纯模块 + 两个 CLI，沿用 lab:* 别名模式；TECH §3.2 表同步更新）
New runtime feature flag: NO
New cross-package dependency: NO （scripts/dev 工具；复用 ab-blindpack 导出的纯扫描器与 T4 统计函数，无产品闭包影响——lab-payload-closure 负控既存）
New host/platform-specific behavior: NO
New external/network capability: NO （零网络、零模型；测试负向断言）
```

回滚：revert 新增 4 个源文件 + 2 个测试 + 2 个 fixtures + package.json 两行别名 + TECH §3.2 表行 + 本报告；alignment-report.mjs 仅回退一处 `export` 关键字。无生产副作用。
