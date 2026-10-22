# PRI-1002 — PRR 离线 A/C 实验能力交付报告（2026-10-22）

| 项 | 值 |
|---|---|
| 交付日期 | 2026-10-22 |
| 关联 | Linear **PRI-1002**（Gate B / B1 前置离线工程）；上游 B0 预注册 v0.2（PR #2111）、SPEC-PD-PRR-001 v1.3 |
| 执行基线 | `origin/main` = `3af39b5367f964de1f96642aeb4cbd2b78687e2a` |
| 工作方式 | 独立 worktree `D:\Code\_worktrees\principles\PRI-1002-prr-ac-offline`（branch `ai/PRI-1002-prr-ac-offline`，writer=zcode，租约+git lock 持有） |
| 证据类型 | **FIXTURE_ONLY**（全部合成夹具；零网络、零模型调用、零真实 workspace 读取） |
| 真实 A/C 实验 | **NOT_RUN**（B0 冻结 FZ-01～FZ-15 全部 OWNER_DECISION_REQUIRED；冻结校验器在本轮以 DRAFT 状态实跑并**拒绝**真实运行） |
| 真实数据 M1~M5 | **NOT_MEASURED**（离线判定逻辑已实现并用合成夹具验证；真实测量待 D-01/D-02） |
| Gate B / Gate C | BLOCKED / NOT_GRANTED（不变） |

> **Owner Review 修复轮（2026-10-22，PR #2115 审查意见）**：首轮交付（head `ccaf96552`）经 Owner 审查发现四类缺陷——真实运行门的必需输入与验证器形态漏洞、FZ-11 配对分母虚高、`empty` 账本状态被误读为真零、未知成本被 `?? 0` 当零。全部修复见 **§6 修复轮记录**，回归由 55 项扩至 64 项。

---

## Owner Review Card

**1. Problem**：B0 预注册 §9.2 列出 8 项缺口（G1~G8），§10.3 列出 6 项必须实际运行的合成预演——PRR 想跑 A/C 价值实验，但仓库里没有任何 PRR 专属任务集、评分器、配对报告、冻结校验器或只读失败语义预演能力。本报告交付这批离线能力并实际跑通全部预演。

**2. Before**：`principle-learning-lab` 只有 PLE-PILOT-01 世界（24 arms × 5 opportunities 的策略对比）。它证明流程可运行，但与 PRR 的 A/C 对照无任务交集；`validatePrereg()` 只认 `preregistration.v0.1-draft`；无逐任务配对差值视图；无负迁移独立维度；全仓 grep `negativeTransfer` 零命中（B0 G2 证据）。

**3. After**：`scripts/dev/principle-learning-lab/prr/` 新增 PRR 专属离线 A/C 运行器（一条命令跑通 A/C 投递→裁定→配对→冻结门→只读语义→预演门），64 项回归测试全绿（首轮 55 + 修复轮 9），全量 scripts 套件 958/958 全绿，预演门 PASS（studyHash 确定性）。

**4. Existing mechanism reused**：同通道投递 `deliverPayload()`（g2.mjs）、跨组污染检测 `checkNoCrossContamination()`/`verifyPromptIsolation()`、外部记忆指纹 `buildMemoryManifest()`、canonical-JSON 哈希（fixture.mjs）、五值裁定词汇与机械裁定纪律（evaluator.mjs 范式）、预注册"拒绝伪造批准"策略（prereg.mjs 范式）、`readLedgerFileState`（core 既有权威，动态导入复用，未重实现）、better-sqlite3 `{readonly:true, fileMustExist:true}` 只读打开模式（workspace-behavior-evidence.ts 同族合同）。

**5. Complexity Delta**（全部 NO，除两处说明）：

```text
New durable source of truth:        NO  （全部产物在 gitignored .tmp/；研究视图不产生第二事实源）
New persisted schema/state:         NO  （零数据库表、零迁移；rehearsal 输出为 JSON 文件）
New subsystem/service/background:   NO  （扩展现有 principle-learning-lab，非新平台）
New public abstraction/interface:   PARTIAL — 4 个 lab 内部 .mjs 模块 + 1 个 CLI 入口（dev 研究工具，非生产 API）
New runtime feature flag:           NO
New cross-package dependency:       PARTIAL — prr-readonly.mjs 动态 import @principles/core/principle-tree-ledger（actor.mjs 已有同款先例；离线路径不加载 core）
New host/platform-specific behavior: NO
New external/network capability:    NO  （零网络；fail-closed 冻结门拒绝一切真实运行直到 Owner 授权）
```

**6. Design reason**：B0 明令"用原有测试工具/评审，不建设实验平台"。所有新代码是既有 lab 内的数据文件 + 纯函数模块；身份/账本读取复用 core 权威；唯一的"门"（冻结校验）从 `validatePrereg` 的拒绝伪造策略派生，且比它更严（fail-closed 到条目级）。

**7. Verification**：见 §3（64/64 + 958/958 + 预演门 PASS + 确定性双跑字节同一；修复细节见 §6）。

**8. Risk**：合成行为脚本的"任务设计区分度"只代表夹具质量，不代表真实模型区分度；M1~M5 离线判定逻辑与真实 PainChainReadModel/任务种子权威的接线是 B1 授权后工作（当前以 deps 注入点预留）；研究夹具目录（B0 G6）仍未决策。

**9. Rollback / recovery**：全部为 dev 脚本新增，删除 `prr/` 目录 + 3 个测试文件 + package.json 一行即完全回滚；无生产路径消费者。

**10. Follow-ups**（刻意不做）：B0 §10.3 之外的真实实验执行、盲评人机协议实现、B1 权威接线、Gate C 任何生产代码——全部等待 Owner 授权。

---

## 1. 七项最终交付标准逐项

### 1.1 PRR 合成 A/C 运行器是否已实现并实际运行

**已实现、已实际运行。**

```bash
# 研究夹具（gitignored，.tmp/prr-ac-fixtures/）一次性生成后：
npm run dev:prr-rehearsal
# 等价于 node scripts/dev/principle-learning-lab/prr/run-prr-rehearsal.mjs \
#        --dataset .tmp/prr-ac-fixtures --out .tmp/prr-ac-rehearsal
```

真实输出（2026-10-22 本机，exit 0）：

```text
[prr-lab] dataset PRR-AC-SYNTH-01 v0.1.0 fixtureHash=dc8479ce7895…
[prr-lab] dataset health check: PASS
[prr-lab] design-check battery: 13/13 PASS
[prr-lab] readonly semantics: PASS
[prr-lab] read-only state unchanged: PASS
[prr-lab] studyHash=2c61181b039f7a3091d190b56ec2dea61248a83b2430fb893d9ef287d2dfe184
[prr-lab] freeze real-run gate: REFUSED (3 problem(s) — draft cannot authorize; 含修复轮新增的 FZ-01 taskSetHash 强制项)
[prr-lab] rehearsal gate: PASS
```

B0 §10.3 六项预演全部实际运行并留有机器可读证据（`rehearsal-result.json`）：

| §10.3 项 | 状态 | 证据 |
|---|---|---|
| A/C 运行隔离（PRR 任务集下） | **PASS** | `isolation.contaminationProblems=[]`、`promptIsolationProblems=[]`、两组外部记忆指纹相等（均为空集 manifest） |
| 任务评分与配对报告（含 pairedDelta） | **PASS** | `paired-report.json`：25 行入册（13 任务 × 2 组 − 1 项未授权排除）、逐任务 Δ、按 AC-T1/T2/T3 分组、全部 MISALIGNED/INCONCLUSIVE 任务逐列 |
| 失败/缺失/不确定处理 | **PASS** | INVALID_OUTPUT/TIMEOUT 行带独立原因码保留在分母；INCONCLUSIVE（evidence_untraceable）单列；NOT_APPLICABLE 仅凭 gold 预登记豁免（白名单唯一理由） |
| 预算超限与 STOP 条件触发 | **PASS** | `A:t-budget-stop` requests=4 > cap=3 → `STOPPED_BUDGET`/`budget_exhausted`，`stopEvents` 记录 `AC-S4_BUDGET_STOP`，行保留、部分结果如实上报 |
| 只读入口失败语义 | **PASS** | 5 个 ledger 用例（ok / ok_but_empty_ledger / empty / unreadable / 歧义归属）+ 1 个 D-01 未授权摘要用例 + 2 个 sqlite 用例（缺库抛错不建文件 / 存量库只读无 WAL 翻转）；不可读绝不误报为 0（`m1.count=null, trueZero=false`） |
| 数据库与文件状态不变断言 | **PASS** | 每用例前后快照（文件集+大小+内容哈希）逐字节比对；`stateProblems=[]` |

### 1.2 复用了哪些既有资产、补齐了哪些 PRR 专属缺口

复用（B0 §9.1 清单逐项接上）：`deliverPayload`/`research-same-channel-v1`（A 与 C 同函数、同位置、同 `budgetChars`，仅内容不同）、`checkNoCrossContamination`+`verifyPromptIsolation`（逐轮断言）、`buildMemoryManifest`、`freezeCandidate` 的字节+hash 冻结纪律（principles/tasks 由 dataset fixtureHash 冻结）、`evaluator.mjs` 五值词汇与三层分离原则、`validatePrereg` 拒绝伪造批准策略、`readLedgerFileState`（core 权威，动态导入）、只读 SQLite 打开合同、`canonicalJson`/`sha256`。

补齐（B0 §9.2 缺口 → 落点）：

| 缺口 | 落点 |
|---|---|
| G1 PRR 任务集与 gold | `prr/lib/prr-dataset.mjs` 数据契约 + `.tmp/prr-ac-fixtures/`（13 任务：AC-T1×6 / AC-T2×5 / AC-T3×2，gold 可事先写定，含 canary 防泄漏）+ CI 用测试内建夹具 |
| G2 负迁移无独立判据 | `prr/lib/prr-adjudicate.mjs`：`negativeTransfer` 独立维度（NT-1/NT-2/NT-3），不改动五值主判定；NT-1=AC-T3 误用旧结论、NT-2=T1/T2 溢出性误用、NT-3=仅措辞谨慎化（永不计为改善） |
| G3 无配对差值视图 | `prr/lib/prr-paired.mjs`：逐任务 Δ（主判定方向 + AC-M1 分子差 + 成本差 + Owner 负担差）、按任务类型分组、完整分母、失败行保留、排除显式记录、无加权合成总分 |
| G4 token 可能拿不到 | 成本层 `tokensIn/tokensOut` 诚实 null + `tokenBasis: NOT_REPORTED_BY_STUB`，估算必须标注（沿用 actor.usage 纪律） |
| G5 只读失败语义未覆盖 | `prr/lib/prr-readonly.mjs` + 预演 §10.3 第 5/6 项（见上表） |
| G6 研究夹具目录 | 研究夹具保留在 gitignored `.tmp/`（本轮实际做法）；CI 回归用 `scripts/__tests__/prr-test-fixtures.ts` 内建测试数据（机器验证用，非 FZ-01 研究任务集）；入库目录决策仍留给 Owner |
| G7 冻结校验器 | `prr/lib/prr-freeze.mjs`：`prr-b0-freeze.v0.1` 契约 + FZ-01~FZ-15 闭集枚举 + 结构校验 + `validateFreezeForRealRun()` fail-closed（见 §2） |
| G8 授权门适用性 | **未接线、如实保留**：PRR 通道不默认复用 `g2-real-run-authorization.v1`；离线路径不触任何 transport；O-05 待 Owner |

M1~M5 离线判定逻辑（Gate B 方案 §2）：`measureLedgerPrinciples()`——资格计数（M1，scope 参数显式标注 D-02 PENDING）、可追溯计数（M2，derived candidateId 只能经 reuseEvidence 显式 painId 交叉核验解析，candidateId 绝不当 painId）、完整证据计数（M3，evidenceQuality ∈ {exact, excerpt_only}）、显式歧义归属（M4，multimap 冲突检测，绝不 last-write-wins）、未授权/不可用计数（M5，带字段名与原因码）。与 PainChainReadModel/任务种子权威的真实接线是 B1 授权后工作。

### 1.3 合成测试、回归测试及运行命令

```bash
# PRR 专属回归（64 用例）
cd scripts && npx vitest run __tests__/prr-ac-lab.test.ts __tests__/prr-freeze-readonly.test.ts
# 全量 scripts 套件（含既有 lab 646 行套件）：50 文件 / 958 用例全绿
npm run test:scripts
# 离线预演（gate PASS，exit 0）
npm run dev:prr-rehearsal
```

测试覆盖要点：数据集健康检查负控（缺 AC-T3 族、canary 泄漏、NA 理由不在白名单、任务间依赖）；裁定器全部规则路径；配对报告分母/排除/单列；冻结门 8 种拒绝路径（草稿、伪造 FROZEN、无 verifier、verifier 拒绝、verifier 证实非批准、正文事后改动→INVALID_PROTOCOL、FZ-01 哈希不匹配、FZ-11 minPairs 超过可用任务数→UNPROVEN 标记 + minPairs 无推导依据拒绝）；只读语义（四态、candidateId≠painId、未授权摘要带字段名）；快照断言（增/改/删文件各自检出）；CLI 端到端 + **双跑字节同一**（确定性，无时间戳无随机）。

### 1.4 真实数据侧测量：获批/执行/M1~M5 分母

**未获批、未执行。** 真实 M1~M5 全部 `NOT_MEASURED`（分母未知，不是 0）。本轮只交付了离线判定逻辑与失败语义（合成夹具验证）。真实测量前置：D-01（workspace/字段/脱敏/外发）、D-02（资格口径）、D-05（宿主），且真实执行必须前后快照比对（快照比较器已随本轮交付）。未扫描任何真实 workspace。

### 1.5 真实 A/C：未运行

**NOT_RUN。** 冻结记录以 DRAFT 状态实跑：`validateFreezeForRealRun()` 拒绝（2 项问题：状态非 OWNER_APPROVED_FROZEN + 15 项全部未冻结）。零模型调用、零费用、零冻结哈希（唯一哈希是 DRAFT 的 `prereg.canonicalSha256`，属预注册正文身份，不是冻结记录）。该拒绝本身是预演门的必要通过条件（证明本轮一切结果产生于未授权的离线通道）。

### 1.6 研究结论

**本轮结论：离线能力 GO（工程就绪）；价值问题维持 UNPROVEN；Gate B 执行维持 BLOCKED。** 可复核依据：§1.1 命令与输出、`rehearsal-result.json`、64+958 测试。本报告不将文档完成、CI 通过或合成测试通过表述为任何真实产品收益（B0 §10.2 边界）。

### 1.7 Gate C

**C0 未授权、未启动。** 无生产代码、无 Tool/Skill、无宿主接线。Codex 仍是 D-05 推荐候选而非已决 Pilot 宿主。

---

## 2. 冻结校验器（G7）要点

- `FZ_ITEMS` 为闭集：恰好 FZ-01~FZ-15，多一项/少一项/未知 id 均拒绝；
- DRAFT 项携带 value 即拒绝（不得预制取值）；`VALUE_FROZEN` 必须同时有 value + `ownerApprovalRef`；
- `OWNER_APPROVED_FROZEN` 状态必须有 `ownerApproval` 记录，且 `approvedBy` 必须字面 `owner`（AI 会话不可批准）；
- FZ-15 自指处理：预注册正文 canonical-JSON SHA-256 存于独立冻结记录；正文事后任何改动 → `INVALID_PROTOCOL`，须重开 studyId；
- 真实运行门要求调用方提供**受信 verifier 函数**（解析 Owner 决策记录）；无 verifier / verifier 拒绝 / 证实非批准，全部 fail-closed；环境变量、默认值、脚本参数一律不能补出授权；
- FZ-01 冻结 `taskSetHash` 必须等于实际加载的数据集 fixtureHash；
- FZ-11 `minPairs` 必须带推导依据；可用任务对数低于 minPairs → 显式 `UNPROVEN` 标记，绝不放宽凑数。

## 3. 验证汇总（Owner Review 修复轮后）

| 项 | 结果 |
|---|---|
| 新增 PRR 回归 | **64/64 PASS**（prr-ac-lab 36 + prr-freeze-readonly 28；首轮 55 项全保留，修复轮新增 9 项拒绝/边界场景） |
| 全量 scripts 套件 | **958/958 PASS**（50 文件） |
| 离线预演门 | PASS（studyHash `2c61181b…dfe184`；冻结门对 DRAFT 拒绝问题数 2→3，新增的正是 FZ-01 taskSetHash 强制项） |
| 确定性 | 双跑 `rehearsal-result.json` 字节同一（cmp 验证） |
| lint | 新增/修改 lab 文件 0 error |
| 生产路径影响 | 零（无生产源码改动） |
| CI（首轮提交时） | 32/32 全绿含 Verify Merge Gate；修复提交推送后 CI 重跑待核对 |

## 4. 集中的 Owner 待决清单（本轮不打断离线工作的全部授权缺口）

| # | 待决事项 | 阻塞什么 |
|---|---|---|
| D-01 | 数据与费用授权（workspace、字段白名单、脱敏、外发=0 默认、预算、撤回） | 真实 M1~M5、C 组材料合法性 |
| D-02 | 召回资格口径（推荐：有效激活集合；停用/撤回默认无资格） | M1 分母口径冻结 |
| D-03 | Codex read-back 是否补齐 | M3 证据来源范围 |
| D-04 | WorkBuddy consent 立项 | （首轮不含 WB，维持暂缓推荐） |
| D-05 | 首个实验宿主（推荐 Codex） | 数据读取范围授权 |
| O-01/O-02 | FZ-09 最小有意义改善标准 + FZ-11 N 的反推 | 冻结取值 |
| O-03 | FZ-08 盲评分歧率阈值 | 冻结取值 |
| O-04 | FZ-04/FZ-06 模型/端点/调用/Token/费用/截止 | 真实 A/C 预算 |
| O-05（G8） | PRR 是否复用 `g2-real-run-authorization.v1` 或需独立授权记录 | 真实 transport 门 |
| O-06 | `readWorkspaceRuleContextRowsBefore()` 是否纳入复用面 | B1 读取面设计 |
| O-07 | Gate A 新鲜度复核（P-02 对当前 main） | B1 准入 |
| G6 | 研究夹具目录决策（`.tmp/` 维持 or 入库新目录） | FZ-01 任务集托管位置 |

## 5. 变更清单

```text
scripts/dev/principle-learning-lab/prr/lib/prr-dataset.mjs      （数据契约 + 健康检查）
scripts/dev/principle-learning-lab/prr/lib/prr-adjudicate.mjs   （五值裁定 + 负迁移 + 原因码）
scripts/dev/principle-learning-lab/prr/lib/prr-freeze.mjs       （FZ-01~15 冻结契约 + fail-closed 门）
scripts/dev/principle-learning-lab/prr/lib/prr-paired.mjs       （配对差值 + 预演门）
scripts/dev/principle-learning-lab/prr/lib/prr-readonly.mjs     （快照/四态/显式歧义/M1~M5 离线逻辑）
scripts/dev/principle-learning-lab/prr/run-prr-rehearsal.mjs    （CLI 入口）
scripts/__tests__/prr-test-fixtures.ts                          （CI 测试数据，非 FZ-01 研究任务集）
scripts/__tests__/prr-ac-lab.test.ts                            （34 用例）
scripts/__tests__/prr-freeze-readonly.test.ts                   （21 用例）
package.json                                                     （dev:prr-rehearsal 别名）
.changeset/prr-ac-offline-capability-no-release.md               （no-release 声明）
docs/implementation-reports/PRI-1002-prr-ac-offline-capability-20261022.md （本报告）
```

研究夹具 `.tmp/prr-ac-fixtures/`（6 个 JSON）与预演产物 `.tmp/prr-ac-rehearsal/` 均为 gitignored，不入库。

**状态收口：PRR 离线 A/C 能力交付（FIXTURE_ONLY）；真实数据 NOT_MEASURED；真实 A/C NOT_RUN；Gate B BLOCKED；Gate C NOT_GRANTED。**

---

## 6. Owner Review 修复轮记录（2026-10-22，PR #2115）

Owner 审查首轮（head `ccaf96552`）发现四类缺陷。以下逐项记录修复前后的行为变化；每项均有新增回归测试实际触发对应拒绝/边界分支（非仅调用 helper）。

### 6.1 真实运行门 `validateFreezeForRealRun()`（prr-freeze.mjs）

| 缺陷 | 修复前 | 修复后 |
|---|---|---|
| 必需输入可缺失 | `preregBody` 缺失 → 跳过 FZ-15 哈希核对；`dataset` 缺失 → 跳过 FZ-01 对账；`verifyOwnerApproval` 缺失 → 仅报一条问题但仍继续处理其余 | 三者任一缺失即列为拒绝项，且哈希/对账检查永远执行（preregBody/dataset 为必需参数，缺失 = 真实运行被拒） |
| 验证器形态漏洞 | 仅显式检查 `verified!==true` 与 `approved!==true` 两分支；`undefined`/`null`/`{}`/错误形状对象会落入相同拒绝消息但缺少独立负控 | `undefined`/`null`/非对象/`verified:false`/`approved:false`/抛异常六种形态各自独立拒绝消息；必须 `verified===true && approved===true` 同时成立 |
| commit 绑定缺失 | `ownerApproval.frozenCommitSha` 仅验 40-hex 格式即视为有效批准 | 验证器证据必须携带 `frozenCommitSha` 且与冻结记录精确一致——权威 Owner 决策记录与冻结协议的绑定是批准的必要条件；仅格式正确不再是批准 |
| FZ-01 可跳过 | 仅当 `taskSetHash` 是字符串时才比较；缺失/格式错静默通过 | `taskSetHash` 必须存在、64-hex 格式正确、且与实际加载数据集 `fixtureHash` 精确相等；缺失即拒绝 |

新增测试：verifier 返回 undefined/null/{}/错误形状/仅 verified/仅 approved/无 commit 绑定/commit 不一致/抛异常共 8 场景；缺 preregBody/缺 dataset/缺 verifier/缺 freeze 共 4 场景；FZ-01 缺 hash/格式错 2 场景。全部断言拒绝消息真实产生。

### 6.2 FZ-11 完整配对分母（prr-freeze.mjs + prr-paired.mjs）

| 缺陷 | 修复前 | 修复后 |
|---|---|---|
| 配对分母虚高 | `minPairs` 与 `dataset.tasks.tasks.length`（13，含 1 项 C 组未授权任务）比较 | 与**完整 A/C 配对数**比较：`{ totalTasks, completePairs, excludedUnauthorizedTasks }` 显式输出；运行前判定未授权的 C 材料不计入配对分母。合成夹具现为 **12 完整配对**：`minPairs=13` → 不足并落 UNPROVEN（保留原始数据与排除说明，绝不降阈值）；`minPairs=12` → 数量比较通过 |
| 报告配对数虚高 | `byType.pairs` 计入仅剩 A 组结果的行（excluded C） | `pairs` 只计双侧齐备的完整配对；`excludedUnpaired` 单独记录（AC-T1：totalTasks=6、pairs=5、excludedUnpaired=1）；`totalTasks` 同时保留 |

### 6.3 账本状态与授权语义（prr-readonly.mjs）

| 缺陷 | 修复前 | 修复后 |
|---|---|---|
| `empty` 误读为真零 | `availability.status==='empty'` → `m1.trueZero=true`（"genuinely empty ledger"） | `empty`（文件缺失/零字节/宽松解析）只产生解析计数 0，`trueZero` 恒为 `false`，reasonCode=`ledger_empty__true_zero_unproven_requires_independent_evidence`。真零声明需要调用方提供**独立可审计证据** `trueZeroEvidence={auditor,recordRef}`（字段不全视为无证据）；提供后 reasonCode 变为 `…_with_independent_true_zero_evidence` 并在输出中保留证据字段 |
| 未知状态被推断 | `classifyLedgerAvailability()` 只认三种状态字符串，其余 fallthrough 进 ok 分支——缺失/未知 `availability.status` 会被当 `ok` 处理 | 新增 `unmeasurable_unknown_availability` 类：非 `ok/empty/unreadable` 的状态（含完全缺失）一律不可测；`m1/m2/m3.count=null`、reasonCode=`availability_status_unknown`、trueZero=false；权威状态优先于账本内容（status=unreadable + 有原则 → unreadable）。类枚举扩为五值 |
| 许可性授权默认 | `authorization = { summaryFieldsAllowed: true }` 默认放行——D-01 未批准即默认计算 M3 | 默认值移除：**省略** → `authorizationBasis=NOT_DECLARED_TREATED_AS_UNAUTHORIZED`（fail-closed，M3 拒算，reasonCode=`summary_authorization_not_declared`）；**false** → `D01_NOT_GRANTED_DECLARED`；**true** → `D01_GRANTED_DECLARED` 才计算 M3。形状非法（非对象/非布尔字段）直接抛错（rc-3）。三种状态行为可观察且不同；未授权时 M5 带字段名（`pain_structured_summary`）与原因码 |

新增测试：缺文件/零字节/宽松解析/非法 JSON 各状态与计数不混淆；真零证据正例+弱证据反例；unknown/missing/状态-内容不一致 3 场景；authorization 省略/false/true 三态各断言 basis 与 M3/M5 行为；malformed 抛错。

### 6.4 未知成本差值（prr-paired.mjs）

| 缺陷 | 修复前 | 修复后 |
|---|---|---|
| `?? 0` 把未知当零 | `costDelta.requests = (c.cost.requests ?? 0) − (a.cost.requests ?? 0)`——任一侧未报告即产生虚假数值差 | 仅当 A/C 双侧均为有限数字才计算差值；任一侧未知 → 该字段差值 `null`，字段名与两侧原值记入 `unknownCostFields`，`measurementBasis` 标记 `PARTIAL_UNKNOWN_NULLS_RETAINED`（双侧齐全时 `PAIRED_NUMERIC_DIFF`）。覆盖 requests/toolCalls/tokensIn/tokensOut/wallMs 与 owner.asks/owner.corrections。五值主判定与"无合成总分"原则不变 |

新增测试：双侧 token 未知 → 差值 null + unknownCostFields 列出；双侧 requests 已知 → 真实数值差（−3）；混合场景 basis 标记断言。

### 6.5 修复轮验证证据

```text
cd scripts && npx vitest run __tests__/prr-ac-lab.test.ts __tests__/prr-freeze-readonly.test.ts
  → Test Files 2 passed, Tests 64 passed (64)
npm run test:scripts
  → Test Files 50 passed, Tests 958 passed (958)
npm run dev:prr-rehearsal
  → rehearsal gate: PASS（studyHash=2c61181b039f7a3091d190b56ec2dea61248a83b2430fb893d9ef287d2dfe184）
  → freeze real-run gate: REFUSED（3 problem(s)——DRAFT + 15 项未冻结 + FZ-01 taskSetHash 缺失强制项）
双跑 cmp rehearsal-result.json → 字节同一
```

预演用例面扩展：`ledger-zero-byte-with-independent-evidence`（真零须独立证据）、`ledger-authorization-omitted/summary-unauthorized/summary-authorized`（三态对照）、`semantic-probe-unknown-status-and-authorization`（未知状态 fail-loud + malformed 抛错）。六项 B0 §10.3 预演语义保持全部 PASS。

### 6.6 修复轮剩余限制（如实保留）

- `trueZeroEvidence` 是离线声明式参数：它证明"调用方持有独立审计记录"，本模块不核验该记录本身的真实性——真实实验中该参数的采信规则须在 FZ-12 冻结；
- 配对分母的未授权判定来源是数据集的 `historyMaterial.disclosureStatus` 声明字段；真实实验中该声明的权威来源（D-01 批准记录）在 B1 接线时须与冻结记录对账；
- G8（PRR 授权记录 schema 是否复用 `g2-real-run-authorization.v1`）仍未决——本轮的 verifier 是接口约定，真实 resolver 待 O-05 裁决后实现；
- 其余 Owner 待决清单（§4）不变。

**修复轮后状态收口：离线能力 GO（缺陷已修复并复验）；真实 M1～M5 NOT_MEASURED；真实 A/C NOT_RUN；Gate B BLOCKED；Gate C NOT_GRANTED。**
