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
>
> **Owner Review 第二轮修复（2026-10-23，head `a6f68c03d` 审查意见）**：经核实的三项 P1——冻结取值未与 Owner 批准内容对账（只比两个 SHA 字符串）、FZ-11 非法值形态可跳过样本量门、畸形账本条目可被报为已证明真零。全部修复见 **§7 第二轮修复记录**，回归由 64 项扩至 72 项。其中第三项在真实 core 读取下核实出比评审描述更深的一层：core 宽松解析会**静默丢弃**字符串条目并给缺 id 的对象条目**回填默认值（无 status）**，修复以 id+status 双字段契约暴露该半成品形态。
>
> **Owner Review 第三轮修复（2026-10-23，head `aa8cbf5a3` 审查意见）**：五项——Owner 批准未绑定完整协议（studyId+正文+全部条目）、runningCommitSha 可缺省、status 未复用 Core 权威枚举、FZ-01 信任加载时缓存哈希、宽松空账本输出误导性 M2/M3 零值。全部修复见 **§8 第三轮修复记录**，回归由 72 项扩至 75 项。
>
> **Owner Review 第四轮修复（2026-10-23，head `cd4e271bc` 审查意见）**：三项——`verifyDatasetIntegrity()` 派生索引校验不足且 Map 防变异可被原型方法绕过、status 应直用规范权威常量 `PRINCIPLE_STATUSES` 而非从 schema 提取、不可测账本状态的 M4/M5 等指标仍输出伪零。全部修复见 **§9 第四轮修复记录**，回归由 75 项扩至 87 项。
>
> **Owner Review 第五轮定向修复（2026-10-23，head `0c10bb895` 审查意见）**：只读 Map Proxy 的内部对象泄漏——`valueOf()` 因无差别 bind 返回内部 Map、`forEach` 原生实现把内部 Map 作为回调第三参数传出（两者均可被 `Map.prototype.set.call` 直接变异内部索引）。修复见 **§10**，回归由 87 项扩至 89 项。

---

## Owner Review Card

**1. Problem**：B0 预注册 §9.2 列出 8 项缺口（G1~G8），§10.3 列出 6 项必须实际运行的合成预演——PRR 想跑 A/C 价值实验，但仓库里没有任何 PRR 专属任务集、评分器、配对报告、冻结校验器或只读失败语义预演能力。本报告交付这批离线能力并实际跑通全部预演。

**2. Before**：`principle-learning-lab` 只有 PLE-PILOT-01 世界（24 arms × 5 opportunities 的策略对比）。它证明流程可运行，但与 PRR 的 A/C 对照无任务交集；`validatePrereg()` 只认 `preregistration.v0.1-draft`；无逐任务配对差值视图；无负迁移独立维度；全仓 grep `negativeTransfer` 零命中（B0 G2 证据）。

**3. After**：`scripts/dev/principle-learning-lab/prr/` 新增 PRR 专属离线 A/C 运行器（一条命令跑通 A/C 投递→裁定→配对→冻结门→只读语义→预演门），72 项回归测试全绿（55 → 64 → 72 三轮递进），全量 scripts 套件 966/966 全绿，预演门 PASS（studyHash 确定性）。

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

**7. Verification**：见 §3（72/72 + 966/966 + 预演门 PASS + 确定性双跑字节同一；修复细节见 §6）。

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
[prr-lab] studyHash=525d9a40e22983f083c6ada59fd081945f496da73648608b4d7cb46837c78e08
[prr-lab] freeze real-run gate: REFUSED (4 problem(s) — draft cannot authorize; 含两轮修复新增的 FZ-01 强制项与 itemsHash 绑定项)
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
| 新增 PRR 回归 | **72/72 PASS**（prr-ac-lab 36 + prr-freeze-readonly 36；55→64（一轮修复）→72（二轮修复），全部历史用例保留） |
| 全量 scripts 套件 | **966/966 PASS**（50 文件） |
| 离线预演门 | PASS（studyHash `525d9a40…c78e08`；冻结门对 DRAFT 拒绝问题数逐轮增至 4——每轮新增的正是当轮的强制绑定项） |
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

---

## 7. Owner Review 第二轮修复记录（2026-10-23，head `a6f68c03d` 审查意见）

三项 P1 逐项核实**全部属实**后修复。每项均有新增回归测试实际触发对应拒绝/边界分支。

### 7.1 P1-1：冻结取值未绑定 Owner 批准的内容（prr-freeze.mjs）

| 项 | 修复前 | 修复后 |
|---|---|---|
| 内容对账 | 门只比较 `evidence.frozenCommitSha === freeze.ownerApproval.frozenCommitSha` 两个输入字段——篡改 items 任何取值（如 FZ-11.minPairs 3→1）后保留 decisionRef 与 SHA 即可通过 | 新增 `freezeItemsHash(freeze)`（对**全部** items 的 canonical-JSON SHA-256）；验证器证据必须携带 `approvedFreezeItemsHash`（Owner 批准记录绑定的冻结内容哈希）并与提交记录的哈希**精确一致**。篡改 FZ-11.minPairs / FZ-06 预算 / FZ-13 STOP / FZ-01 哈希 / 任一 ownerApprovalRef → `freeze content reconciliation FAILED … INVALID_PROTOCOL`，重开 studyId |
| 运行提交核对 | 无 | 新增可选输入 `runningCommitSha`：调用方声明实际执行所依据的提交时，必须与 `evidence.frozenCommitSha`（获批代码状态）一致，否则拒绝；未提供时不改变其余绑定 |
| 缺失绑定 | — | 验证器证据缺 `approvedFreezeItemsHash`（或格式非 64-hex）即拒绝——批准必须同时绑定 commit 与冻结内容 |

新增测试：五类篡改场景（保留原批准哈希）全部断言 `reconciliation FAILED` + `INVALID_PROTOCOL`；缺 itemsHash 绑定拒绝；`runningCommitSha` 不一致拒绝/一致通过；`freezeItemsHash` 确定性与敏感性。

### 7.2 P1-2：FZ-11 非法值形态跳过样本量门（prr-freeze.mjs）

| 项 | 修复前 | 修复后 |
|---|---|---|
| 形状守卫 | `if (fz11 && isPlainObject(fz11.value))` ——value 为字符串/数组时整个分支静默跳过，`minPairsEligible` 保持 null 且无任何问题项 | 守卫改为 `if (fz11)`：value 非契约对象 → 明确拒绝（`the minimum-pairs gate cannot be skipped by replacing the value with another type`）；进入对象分支后 minPairs/derivationBasis 各自校验，且**数量比较仅在两字段均有效时执行**（部分有效不再产出样本量判定） |

新增测试：十种非法形态（字符串/空数组/null/缺 minPairs/minPairs=0/负数/2.5/数字字符串/缺 derivationBasis/空白 derivationBasis）逐一断言真实门禁输出含 FZ-11 拒绝且 `minPairsEligible === null`。

### 7.3 P1-3：畸形账本条目被报为已证明真零（prr-readonly.mjs）

**核实补充**：评审描述的场景在真实 core 读取（`readLedgerFileState`）下表现更隐蔽——core 宽松解析（parseHybridLedger）会**静默丢弃**非对象条目（`{p1:"garbage"}` 归空），并给缺 id 的对象条目**回填默认值**（`{title:…}` → `{id:'p2', derivedFromPainIds:[], …}` 但**无 status**）。因此畸形在 core 输出层的可见形态是"半成品条目 + 合法空集"。

| 项 | 修复前 | 修复后 |
|---|---|---|
| 条目契约 | `classifyLedgerAvailability` 只查 `Object.keys(principles).length > 0`；`{p1:"garbage"}` → 分类 ok；混合畸形经 measure 过滤后 `count:0`，提供 evidence 时 `trueZero:true, reasonCode:'ok'` | 合法条目契约 = plain object + **非空字符串 id + 非空字符串 status**（status 双字段暴露 core 回填的半成品）。任一不可用条目毒化整个账本 → 新类 `malformed_entries__semantic_review_required`（不静默过滤残留计数）；measure 对该类输出 `m1/m2/m3.count=null, trueZero=false, reasonCode='malformed_ledger_entries__semantic_review_required'` |
| 宽松归空提升 | `ok_but_empty_ledger` 在提供 evidence 时 `trueZero` 可为 true | `trueZero` 仅在**结构完整分类（ok，条目全合法）**+ 零 eligible + 独立证据三条件同时成立时可为 true；`ok_but_empty_ledger` 恒 false（宽松解析正是可能吞数据的通道，evidence 参数不可对冲解析层不确定性），note 明示理由 |
| 类枚举 | 五值 | 六值（新增 `malformed_entries__semantic_review_required`） |

新增测试：字符串/数组/数字/null/缺 id/缺 status/混合畸形/非对象容器八场景分类断言；畸形账本 measure 全 null + trueZero false（即使提供 evidence）；宽松归空 + evidence 仍 false；唯一可达 trueZero 路径（完整账本 + 全非 active + 证据）正反两控。CLI 预演新增 `ledger-malformed-entries`（经**真实 core 读取**验证混合畸形 → 不可测）与 `ledger-lenient-empty-cannot-be-true-zero` 用例，并在语义探针段加入直连探针。

### 7.4 第二轮修复验证证据

```text
cd scripts && npx vitest run __tests__/prr-ac-lab.test.ts __tests__/prr-freeze-readonly.test.ts
  → Test Files 2 passed, Tests 72 passed (72)
npm run test:scripts
  → Test Files 50 passed, Tests 966 passed (966)
npm run dev:prr-rehearsal
  → rehearsal gate: PASS（studyHash=525d9a40e22983f083c6ada59fd081945f496da73648608b4d7cb46837c78e08）
  → freeze real-run gate: REFUSED（4 problem(s)——DRAFT + 15 项未冻结 + FZ-01 强制 + itemsHash 绑定缺失）
双跑 cmp rehearsal-result.json → 字节同一；lint 0 error
```

### 7.5 第二轮剩余限制（如实保留）

- `freezeItemsHash` 的权威副本由受信验证器持有——若验证器本身被诱导为篡改后的记录重新计算哈希，门无法察觉（受信解析器是 FZ-15 的信任根，其实现归属是 O-05 裁决范围）；
- `runningCommitSha` 为可选输入：不提供时门不做运行提交核对（离线预演无此绑定需求；真实实验的提供义务须在 FZ-12/FZ-15 冻结时明确）；
- core 宽松解析丢弃字符串条目的行为发生在 core 读取层内部，本模块只能对 core 输出防御（缺 status 回填已暴露）；从源头收紧 parseHybridLedger 属 core 生产代码变更，超出本 PR 边界；
- 其余 Owner 待决清单（§4）与 §6.6 限制不变。

**第二轮修复后状态收口：离线能力 GO（三项 P1 已修复并复验）；真实 M1～M5 NOT_MEASURED；真实 A/C NOT_RUN；Gate B BLOCKED；Gate C NOT_GRANTED。**

---

## 8. Owner Review 第三轮修复记录（2026-10-23，head `aa8cbf5a3` 审查意见）

五项逐项核实属实后修复。变更范围仍限于 `scripts/dev/principle-learning-lab/prr/` 研究树与其测试，生产源码零改动。

### 8.1 P1-1：Owner 批准绑定完整冻结协议（prr-freeze.mjs）

| 项 | 修复前 | 修复后 |
|---|---|---|
| 协议摘要 | `approvedFreezeItemsHash` 只覆盖 items——studyId 与预注册正文不在绑定内 | 新增 `protocolApprovalDigest({freeze, preregBody})`：canonical-JSON SHA-256 over `{digestVersion, studyId, preregCanonicalSha256, freezeItemsSha256}`——字段顺序无关，任何有意义的协议内容变化（studyId/正文/任一条目）都改变摘要 |
| 验证器合同 | verifier 证据为 itemsHash（旧格式） | 扩展为 `approvedProtocolDigest`：必须由验证器按 `decisionRef` 查询**实际 Owner 决策记录**并返回**批准时保存**的摘要；旧格式记录（无该字段）一律拒绝，不自动补值、不解释为已批准 |
| studyId 身份 | 未检查 | `preregBody.studyId` 必须存在且与 `freeze.studyId` 一致；正文哈希核对保持 |
| 测试辅助缺陷（评审点名） | `verifyOkFor(freeze)` 每次验证时对**当前待验证对象**动态计算哈希——被篡改内容自动成为"批准内容" | `approveOnce(freeze, preregBody)`：批准动作只发生一次——对 deep-cloned 快照计算摘要并保存，verifier 永远返回保存值；测试模拟"先批准→再篡改→验证拒绝"的真实顺序 |

新增/更新测试：正文改动但记录哈希未更新→拒绝；正文与记录哈希同步更新但未重新批准→拒绝（digest reconciliation FAILED + INVALID_PROTOCOL）；studyId 改动（body/freeze 任一侧）→拒绝；篡改 FZ-01/06/11/13、ownerApprovalRef、条目 status 降级→拒绝；缺协议摘要/旧格式批准记录→拒绝；正确批准的不可变快照→通过。

### 8.2 P1-2：runningCommitSha 必需（prr-freeze.mjs）

| 项 | 修复前 | 修复后 |
|---|---|---|
| 必需性 | 可选输入，提供时才核对 | 必需：缺失/非 40-hex → 显式拒绝（`a real run must declare the commit it actually executes from, from a trusted runner/CI context`）；与验证器返回的**独立批准记录** `frozenCommitSha` 不一致 → 拒绝 |
| 来源可信 | 未声明 | 合同文档写明：必须来自受信执行上下文（经验证的运行器/CI checkout）；从 `freeze.ownerApproval.frozenCommitSha` 复制不属于受信来源 |
| 真实入口事实 | — | **如实记录**：本仓库当前没有真实 A/C 执行入口；门在仓库内的唯一调用方是离线预演（它依赖门**拒绝**其 DRAFT）。接入真实运行器属 B1 工作，届时必须以受信 runningCommitSha 通过本门 |

新增测试：缺失/null/'HEAD'/短哈希/非 hex 五形态拒绝；与批准 SHA 不同拒绝；一致（且其余门禁满足）通过。

### 8.3 P1-3：status 复用 Core 权威枚举（prr-readonly.mjs）

| 项 | 修复前 | 修复后 |
|---|---|---|
| 枚举来源 | 本地检查"非空字符串" | 模块加载时从 `@principles/core/runtime-v2` 公开导出的 **`PrincipleFactSchema.properties.state`**（TypeBox Union Literals）提取权威值集（当前解析为 candidate/active/archived/deprecated/probation）——schema 驱动，Core 枚举演进自动跟随；解析失败 = 模块加载失败（fail-loud），绝不静默空表 |
| 分类规则 | 非空字符串即合法 | status 缺失/非字符串/空串/不在权威枚举（含已退役的 `deactivated`）→ 整个账本 `malformed_entries__semantic_review_required` 不可测；混合合法+非法同样整体不可测，绝不静默过滤后计余量 |

测试修正与新增：正向夹具中不符合权威枚举的 `deactivated` 全部改为 `archived`；新增权威枚举逐值通过 + 六种非法 status（deactivated/garbage/''/null/缺失/非字符串）逐一断言真实测量 `m1.count=null, trueZero=false, reasonCode='malformed_ledger_entries__semantic_review_required'`、M2/M3 不可测。

### 8.4 P1-4：FZ-01 保护实际执行的数据集快照（prr-dataset.mjs + prr-freeze.mjs）

| 项 | 修复前 | 修复后 |
|---|---|---|
| 哈希信任 | 门使用 `loadPrrDataset()` 缓存的 `fixtureHash`——加载后改动 byFile/tasks 内容，缓存不变，验证继续通过 | 门在验证时**重算**当前内容哈希（`verifyDatasetIntegrity()`），三方对账：FZ-01.taskSetHash == 重算哈希 == 缓存哈希；不一致即拒绝 |
| 消费结构一致性 | 未检查（新发现的绕过面：JSON round-trip/structuredClone 会打破 `tasks === byFile['tasks.json']` 共享引用，篡改消费结构对 byFile 哈希不可见） | `verifyDatasetIntegrity` 同时校验六个消费结构（manifest/principles/tasks/gold/behaviors/designChecks）与 byFile 对应文件**是同一对象**、三个派生索引（tasksById/principlesById/goldByTask）仍绑定已验证快照条目；任一失败 → 专门拒绝消息 |
| 修改阻止 | 无 | `loadPrrDataset` 返回前 **deep-freeze**（含 Map/Set：先钉死 set/delete/clear 变异方法再冻结——`Object.freeze` 单独不阻止 Map 内部变异）；严格模式下任何加载后赋值/索引变异直接 throw |

新增测试：克隆体改任务内容但保留原缓存哈希 → 拒绝；替换任务/改嵌套字段/改 gold/直改 byFile/改行为脚本五变体 → 重算哈希拒绝；deep-freeze 六种原地修改（tasks/byFile/gold/behaviors/tasksById.set/goldByTask 赋值）全部 throw 且快照完好；未改动数据集完整性 ok 正控。

### 8.5 P2：宽松空账本不再输出误导性 M2/M3 零值（prr-readonly.mjs）

| 项 | 修复前 | 修复后 |
|---|---|---|
| M2/M3 | `ok_but_empty_ledger` 走主分支，输出 `count:0, denominator:0`，M3 授权时 `reasonCode:'ok'` | 专用分支：M1 保留解析 `count:0` + `trueZero:false` + 语义审查码；**M2/M3/M4 全部不可测**（count/denominator 为 null + 审查码）——宽松解析可能吞了条目，正常零值会把解析不确定性洗白成可信测量 |
| 一致性 | — | 畸形账本与未知可用性状态已是同等 fail-closed 语义（null + 各自原因码）；完整合法账本（含非 active 权威状态）继续输出正常测量正控 |

新增测试：宽松空账本+独立证据 → M1 仍不可提升、M2/M3 不可测断言；畸形账本 M2/M3/M4 不得产生正常零值；完整账本正控 M2/M3 正常可测。

### 8.6 第三轮修复验证证据

```text
cd scripts && npx vitest run __tests__/prr-ac-lab.test.ts __tests__/prr-freeze-readonly.test.ts
  → Test Files 2 passed, Tests 75 passed (75)
npm run test:scripts
  → Test Files 50 passed, Tests 969 passed (969)
npm run dev:prr-rehearsal
  → rehearsal gate: PASS（studyHash=5923049372f4a777f84fe0c7bfae47a06186961b622d3f86f2eafa316fc46a91）
  → freeze real-run gate: REFUSED（5 problem(s)——DRAFT + items 未冻结 + FZ-01 强制 + 协议摘要缺失 + runningCommitSha 必需）
双跑 cmp rehearsal-result.json → 字节同一；npx eslint scripts/dev/principle-learning-lab/prr/ → 0 error
git diff --check → OK；变更仅 scripts/ 研究树 5 文件 + 报告，生产源码零改动
```

### 8.7 第三轮剩余限制（如实保留）

- `runningCommitSha` 的"受信来源"由合同声明与调用方义务承担——本门无法在离线环境验证一个 SHA 确实来自经验证的运行器；真实运行器的接线（B1）必须把该来源的证明写入 FZ 冻结与遥测；
- 受信验证器仍是 FZ-15 的信任根：它返回的 `approvedProtocolDigest` 必须来自真正独立的 Owner 决策记录存储；其真实实现归属 O-05 裁决范围；
- Core 宽松解析（parseHybridLedger 丢弃/回填条目）的源头收紧属 core 生产代码变更，超出本 PR 边界；本模块在其输出之上以 id+status 权威契约防御；
- 其余 Owner 待决清单（§4）、§6.6/§7.5 限制不变。

**第三轮修复后状态收口：离线能力 GO（五项已修复并复验）；真实 M1～M5 NOT_MEASURED；真实 A/C NOT_RUN；Gate B BLOCKED；Gate C NOT_GRANTED。**

---

## 9. Owner Review 第四轮修复记录（2026-10-23，head `cd4e271bc` 审查意见）

三项逐项核实属实后修复。变更仍限于 PRR 实验室代码、测试与本报告，生产源码零改动。

### 9.1 P1-4：派生索引完整性与 Map 防变异（prr-dataset.mjs + prr-freeze.mjs）

| 项 | 修复前 | 修复后 |
|---|---|---|
| 派生索引校验 | 仅"Map 中的值属于原始数组"——容忍缺失键、错误键值映射、额外键 | `derivedMapMatchesSource()`：Map 大小必须等于源数组长度（重复 ID 导致的歧义由 size 检出）、键集合与源 ID 集合完全一致（无缺失/无额外/无外来键）、**每键映射到源数组中同一对象**（`map.get(id) === entry`）；`tasksById`/`principlesById` 同规则；`goldByTask` 全键覆盖 + 每值与已验证 gold 记录对象身份一致 + 无缺失/额外键。任一失败 `derivedIndexesBound=false` → `ok=false` |
| Map 防变异 | 实例方法钉死（`defineProperty` 覆盖 set/delete/clear）——可被 `Map.prototype.set.call(map,…)` 绕过 | `createReadOnlyMapProxy()`：对永不暴露的 inner Map 建 Proxy——`instanceof Map` 与 get/has/size/forEach/keys/values/entries 全兼容；直接 `set/delete/clear` 命中 get-trap 拒绝；**`Map.prototype.*.call(proxy,…)` 因 Proxy 无 [[MapData]] 内部槽天然 incompatible-receiver TypeError**（本机实测四种原型攻击全部抛错）；属性写入/删除/定义走 set/deleteProperty/defineProperty trap 拒绝；`freezeDeepAndWrap` 重构为带 WeakMap 记忆的深冻结变换，**保留共享对象身份**（`tasks === byFile['tasks.json']` 不被重建破坏），内部 Map 从不外泄（回调只收值） |

新增测试（全部调用真实 `verifyDatasetIntegrity()`，必要时再过门）：完整数据集通过正控；删 `tasksById` 条目失败；任务 ID 指向另一合法任务对象失败；删 `principlesById` 条目失败；原则键指向另一合法原则失败；删 `goldByTask` 条目失败；索引额外键（tasksById 与 goldByTask 双测）失败；重复 taskId 歧义经 size 检出失败；`Map.prototype.set/delete/clear.call()` 四种攻击全部抛错且事后 `verifyDatasetIntegrity(dataset).ok === true`（快照未被触及）；既有 deep-freeze/共享身份/重算哈希/门拒绝测试全部保留并通过。

### 9.2 P1-3：直用 Core 规范权威常量 `PRINCIPLE_STATUSES`（prr-readonly.mjs）

| 项 | 修复前 | 修复后 |
|---|---|---|
| 枚举来源 | 从 `PrincipleFactSchema.properties.state`（TypeBox Union）提取字面值 | 直接消费 `@principles/core/runtime-v2` 导出的**规范权威常量 `PRINCIPLE_STATUSES`**（`runtime-v2/types/principle-enums.ts`，其文档注释即要求一切表示 DERIVE 自该常量、不得重打字面量；`PrincipleStatusSchema` 本身也由它构建）——单一来源、最严格绑定；形状非法（非数组/空/含非字符串）或解析失败 = 模块加载失败（fail-loud 保持） |
| 校验行为 | — | 不变：混合合法与非法条目整账本拒绝；`deactivated`/garbage/''/null/缺失/非字符串逐形态不可测 |

测试更新：`authoritativePrincipleStatuses()` 必须与 Core 导出 `PRINCIPLE_STATUSES` 精确一致（测试直接 import 该常量对账）；`PRINCIPLE_STATUSES` 逐值通过合法性检查；非法形态逐个不可测断言保持。

### 9.3 P2：不可测账本指标不再伪装为零（prr-readonly.mjs）

四类状态语义统一（`unmeasurable: true` 标记 + null 数值 + 专属原因码；`details` 保留数组合同形态、由原因码明确标记不可测）：

| 状态 | M1 | M2/M3/M4 | M5 |
|---|---|---|---|
| `ok`（完整可测） | 正常计数 | 正常计数（正控不回退） | 正常计数 |
| `ok_but_empty_ledger` | `count:0` + `trueZero:false` + 审查码（证据不可提升） | 全部 `null` + `unmeasurable:true` + 审查码 | `unauthorizedCount/unavailableCount: null` |
| `malformed_entries` / `unmeasurable_unknown` | `count:null` | 全部 `null`（证据不可绕过门禁） | 全部 `null` |
| `empty` | `count:0`；真零仅凭独立证据（既有规则不变） | **不再输出成功形态零值**——全部 `null`（空账本不是溯源/完整性/冲突的可测分母） | 全部 `null` |
| `unreadable` | `count:null`（`ledger_unreadable`） | 全部 `null` | 全部 `null` |

新增测试：`ok` 正控 M1~M5 数字输出不回退（`unmeasurable` 字段不存在）；`ok_but_empty_ledger` 全指标断言（含带证据场景）；malformed/unknown 全指标无伪零值；`unreadable` 与 `empty` 明确区分；`empty` 无证据不能证真零、有证据仅 M1 提升；既有正控（counts eligibility / authorization 三态 / CLI 只读快照不变断言）全部保留并通过。

### 9.4 第四轮修复验证证据

```text
cd scripts && npx vitest run __tests__/prr-ac-lab.test.ts __tests__/prr-freeze-readonly.test.ts
  → Test Files 2 passed, Tests 87 passed (87)
npm run test:scripts
  → Test Files 50 passed, Tests 981 passed (981)
npm run dev:prr-rehearsal
  → rehearsal gate: PASS（studyHash=338a07723aff5d5f7b00e33a5d6c5a19472bd24f0b1ad947edb4cd433c407dd4）
  → freeze real-run gate: REFUSED（5 problem(s)）
双跑 cmp rehearsal-result.json → 字节同一；npx eslint scripts/dev/principle-learning-lab/prr/ → 0 error
git diff --check → OK；变更仅 PRR 实验室 3 文件 + 测试 + 报告，生产源码零改动，无网络/模型调用/新增执行入口
```

### 9.5 第四轮剩余限制（如实保留）

- `runningCommitSha` 受信来源证明、verifier 信任根实现归属（O-05）、Core 宽松解析源头收紧——沿用 §8.7 各项，本轮未变；
- 只读 Map 代理依赖"Proxy 无 Map 内部槽"这一引擎行为实现原型方法拒绝（V8/JSC 一致）；若未来宿主要求在无 Proxy 环境运行，需等价替代设计（当前 Node ≥18 均满足）；
- 其余 Owner 待决清单（§4）不变。

**第四轮修复后状态收口：离线能力 GO（三项已修复并复验）；真实 M1～M5 NOT_MEASURED；真实 A/C NOT_RUN；Gate B BLOCKED；Gate C NOT_GRANTED。**

---

## 10. Owner Review 第五轮定向修复记录（2026-10-23，head `0c10bb895` 审查意见）

### 10.1 只读 Map Proxy 的内部对象泄漏（prr-dataset.mjs `createReadOnlyMapProxy`）

两个泄漏点经实测**全部属实**（修复前探针：`valueOf()` 返回内部 Map 且 `Map.prototype.set.call(v,…)` 变异成功；`forEach` 回调第三参数为内部 Map 且全部 13 次迭代中攻击均成功）：

| 泄漏点 | 修复前 | 修复后 |
|---|---|---|
| `valueOf()` | get trap 无差别 `bind(target)`——`Object.prototype.valueOf` 绑定内部 Map 后调用返回内部 Map 本体，原型攻击可直接变异索引 | 不再无条件 bind：白名单之外的方法原样返回（未绑定）——`proxy.valueOf()` 的 `this` 是代理自身，返回代理而非内部 Map |
| `forEach` 第三参数 | 原生 `Map.prototype.forEach.bind(target)` 把内部 Map 作为回调第三参数传出 | `forEach` 重实现：遍历 inner entries，回调第三参数显式传**只读代理**（receiver）；非函数回调 loud 抛错 |
| 无差别 bind | 所有函数属性一律 `bind(target)` | 仅白名单读方法（get/has/keys/values/entries/Symbol.iterator——`this` 只用于读、返回值与新建迭代器不暴露 Map）保持绑定；其余一切原样返回 |

兼容性保持：`instanceof Map`、get/has/size/迭代/for-of/展开 全部不变（本机实测 13 条目 size/展开/for-of 一致）。附带的循环引用占位细节同步修正（cache 占位始终为代理，不再短暂暴露 inner）。

新增回归测试（2 项）：`valueOf() yields the proxy itself, never the mutable inner Map`——断言返回值即代理、经其发起的原型攻击抛错、事后 integrity ok；`forEach hands the callback the READ-ONLY proxy as its third argument`——逐条目断言第三参数即代理、原型/直接两种攻击均抛错、13 条目全部观察到同一代理、事后 `ok:true` + `derivedIndexesBound:true`。既有四种 `Map.prototype.*.call()` 攻击测试继续通过。

### 10.2 第五轮验证证据

```text
cd scripts && npx vitest run __tests__/prr-ac-lab.test.ts __tests__/prr-freeze-readonly.test.ts
  → Test Files 2 passed, Tests 89 passed (89)
npm run test:scripts
  → Test Files 50 passed, Tests 983 passed (983)
npm run dev:prr-rehearsal
  → rehearsal gate: PASS（studyHash=338a07723aff5d5f7b00e33a5d6c5a19472bd24f0b1ad947edb4cd433c407dd4）
双跑 cmp rehearsal-result.json → 字节同一；npx eslint scripts/dev/principle-learning-lab/prr/ → 0 error
git diff --check → OK；变更仅 prr-dataset.mjs + 测试 + 报告，生产源码零改动
```

### 10.3 第五轮剩余限制

沿用 §8.7/§9.5 各项（runningCommitSha 受信来源、verifier 信任根归属 O-05、Core 宽松解析源头收紧超边界）。只读代理的引擎行为依赖与 §9.5 相同。

**第五轮修复后状态收口：离线能力 GO；真实 M1～M5 NOT_MEASURED；真实 A/C NOT_RUN；Gate B BLOCKED；Gate C NOT_GRANTED。**

---

## 12. 真实 A/C 执行入口——第六轮阻断缺陷修复（2026-10-23，head `06e8e7a68` 审查意见）

执行入口（§11）经审查发现五类阻断缺陷，逐项对照真实实现修复：

### 12.1 PI 授权工厂参数与数据契约

| 缺陷 | 修复 |
|---|---|
| `budgets` 参数缺失（OD-2 drift 检查必拒） | CLI 传入完整 `budgets = {httpRequestsPerOpportunity/PerArm/PerStudy, perRunCostCapUsd, totalCostCapUsd}`，与 od2 逐字段对账 |
| `adapterConfig.apiKeyEnv` 不匹配（drift：此前传 `apiKey` 环境变量值） | 传 `apiKeyEnv: budget.apiKeyEnv`（与 od2 逐字对账；凭据仍只从环境变量读取） |
| OD-3 执行顺序与 PRR 数据集不兼容（actor 读 `dataset.histories`，PRR 是 tasks） | runner 的精确执行顺序（A/C × tasks）以兼容视图 `histories` 暴露给 OD-3 校验——顺序即冻结的执行顺序，非伪造 |
| 预算层级构造错误（`createHttpBudgetLedger` 无 study* 参数） | 正确两级链：study parent（`cap=httpRequestsPerStudy, costCapUsd=totalCostCapUsd`）→ arm child（`cap=httpRequestsPerArm, costCapUsd=perRunCostCapUsd, parent=study`）；`createAuthorizedPiTransport` 对 arm==per-run 与 study==total 的 cost/request 双层对账因此真实生效 |
| 定价证据无独立验证（此前 cost-basis 请求返回 undefined，靠字段缺省放行的方向错误） | 受信 resolver 必须返回 `{verified, reference, provider, model, currency, input/outputUsdPerMillionTokens, max*TokensPerRequest, effectiveDate}`，与 od2.costBasis 全字段对账（OD-2 现有校验全部激活）；自报 `costBasisRef` 不再可能单独通过 |

### 12.2 transport 注入接口

`--transport pi` 的 `transportFor = () => ({ transport })` 不符合 runner 期望的 `{complete}` 对象——已修复为直接返回 transport。A/C 隔离语义明确化：Pi transport 为**无状态单轮 `complete()`**，A/C 隔离由投递内容隔离与无共享会话状态保证（预注册要求），已写入代码契约注释。

### 12.3 Owner 授权信任根

- 同一份调用方 JSON 的 `approvedBy:"owner"` 不再被当作独立证据：`--transport pi` **强制要求** `--evidence-resolver <module>`（独立受信模块，default-export `verify()`），缺失即拒绝（"the real execution path is NOT ready without it"）；mock 演练保留。
- resolver 必须独立核验：批准状态、`approvedProtocolDigest`、`frozenCommitSha`、以及**官方定价证据**（cost-basis kind）——全部在 CLI 内与冻结值逐字段对账，自报字段不可能通过。
- 工作区完整性：`git rev-parse HEAD` 之外增加 `git status --porcelain` 检查——**脏工作区拒绝 pi 运行**（运行代码无法证明与获批提交一致）；mock 需显式 `--allow-dirty-worktree-for-mock`。

### 12.4 数据准入与 STOP 语义

- 数据集语义校验（`healthCheckPrrDataset`）**前置到任何 transport 构造之前**；
- C 组材料仅 `authorized_synthetic` 可投递——runner 内第二道断言（缺失/未知状态 throw，防线纵深）；
- 全局预算（FZ-06 `httpRequestsPerStudy`）**调用前检查**：live 账本（`budgetTelemetry`，权威来源）或已累计任务计数达到上限 → 立即停止，剩余任务逐行进入 `notExecutedTasks`（`study_budget_exhausted`），保留已执行结果；
- 未知请求计数**不再推断为 1**：`behaviorFromRoundPayload` 的 requests 保持 null；`denominators.requestCounterBasis` 显式标注 `budget_ledger`/`task_reported`/`UNKNOWN`。

### 12.5 新增测试（`prr-real-pi.test.ts`，10 项；mock Pi adapter + 可信 resolver + 真实账本层级）

| 测试 | 断言 |
|---|---|
| 全要素有效 → PI 工厂构造 runner 兼容 transport | `complete` 存在；构造后 fetch spy = 0（构造不发 HTTP）；单轮经 mock adapter 返回 payload |
| budgets 缺失 | `budgets missing` 拒绝且 fetch=0 |
| OD-3 错误执行顺序 | `executionOrder must exactly match` 拒绝且 fetch=0 |
| 定价证据无效 | `costBasisRef was not verified` 拒绝且 fetch=0 |
| 授权 budgets drift（perRunCostCapUsd 999） | `drift: budgets.perRunCostCapUsd` 拒绝且 fetch=0 |
| 未批准决策记录 | PRR 门 `not BOTH verified and approved`，零构造 |
| 全局 STOP（cap=2） | 调用恰 2 次即停；`notExecutedTasks` = 26−2−1（排除行单列）；分母如实 |
| **账本权威计数**（账本已用 3/3） | **0 次调用即停**——task-reported usage 全 null 也不推断；`requestCounterBasis='budget_ledger'` |
| 未知披露状态 | healthCheck 拒 + runner 内部 throw `non-authorized disclosure status`（门先 UNPROVEN 拒绝的场景由 FZ-11 断言另行覆盖） |
| 未知成本字段 | requests 恒 null，不发明计数 |

既有回归（runner 门链拒绝/mock 全链/CLI 三场景/89+9 项）全部保留并通过。

### 12.6 验证证据

```text
cd scripts && npx vitest run __tests__/prr-real-pi.test.ts __tests__/prr-real-runner.test.ts → 16/16 PASS
npm run test:scripts → 52 文件 / 999 tests 全绿
npm run dev:prr-rehearsal → rehearsal gate PASS（studyHash 338a0772… 不变）
npm run verify:merge → PASS（本地）
npx eslint（prr/ + 新测试文件）→ 0 error；git diff --check → OK
```

### 12.7 第六轮剩余限制

- 受信 resolver 的**生产实现**（对接真实 Owner 决策记录存储与官方定价源）仍属 O-05——本轮交付其契约与强制点：没有它，`--transport pi` 无法启动；
- 脏工作区检查基于 `git status --porcelain`（未跟踪文件计入）；"运行代码与获批提交一致"的更强证明（构建产物哈希）留待 B1 冻结时定义；
- 真实 M1～M5 仍 NOT_MEASURED；真实 A/C 仍 NOT_RUN；Gate B BLOCKED；Gate C NOT_GRANTED。

---

## 11. 真实 A/C 执行入口交付（2026-10-23，#2115 合并后推进）

PR #2115 合并（d2e88bbe0）后按 Owner 指令推进真实实验准备：

### 11.1 合并后基线检查（限界：2fb3b04c8 → main）

- **三大身份权威零变更**：`ledger-identity.ts` / `principle-tree-ledger.ts` / `pain-chain-read-model.ts` 字节未动——P-02 核心结论静态维持；
- `governance-observation-store.ts` / `trajectory-store.ts` 零变更——只读边界负面结论原样；
- #2117（PRI-1019）新增 `design_gate_declarations` 写路径 DDL（bootstrap schema 内）与只读函数 `listObservedDesignGateSessions()`（readonly + fileMustExist 契约合规）——均为 PRI-1019 自有面，**与 PRR 计划读取路径零交集，无实质性风险**（#2117 CI 34 pass）。

### 11.2 受授权执行入口（默认关闭、双层 fail-closed）

| 文件 | 内容 |
|---|---|
| `prr/lib/prr-real-runner.mjs` | 纯编排：PRR 冻结门（`validateFreezeForRealRun`：冻结记录+协议摘要+受信运行提交+决策记录对账）零问题才执行 → A/C 逐任务经 `deliverPayload` 同通道投递 → `transport.complete()` 单轮决策 → B0 §8.2 失败分类（timeout/no_response/budget/invalid 行保留分母）→ `adjudicatePrr` → `buildPairedReport`。runner 自身零 socket，transport 由调用方注入 |
| `prr/run-prr-real.mjs` | CLI 入口（OFF by default）：无冻结/预注册/授权文件即退出非零（无默认值、无环境变量回退）；`--transport mock` 为接线演练（scripted，零模型调用）；`--transport pi` 走既有 PRI-966 授权链（`createAuthorizedPiTransport` 的 P1-02 OD-1/2/3 门 + 预算账本，FZ-06 冻结值构造授权记录，授权缺失 = transport 不存在 = 零 HTTP） |

### 11.3 验证证据

```text
cd scripts && npx vitest run __tests__/prr-real-runner.test.ts → 6/6 PASS
  （门链拒绝三形态 / mock 全链 25 行分母 + NT-1 检出 + 失败行保留 / 失败分类映射）
npm run test:scripts → 51 文件 / 989 tests 全绿（两次连续运行确认稳定）
npm run dev:prr-rehearsal → rehearsal gate PASS（既有行为不回归）
CLI 实测：无参数 exit=1；文件缺失 exit=1；mock 全链 executed=true（25 行）；
  篡改冻结记录 → "protocol approval reconciliation FAILED … INVALID_PROTOCOL" exit=1（零 transport 构造）
```

### 11.4 状态与阻断

- **已交付**：可被授权激活的执行入口 + Owner 决策清单（已按推荐值整理至 Linear PRI-1001：Codex/单一 workspace/结构化摘要与 ID/禁 Raw/外发 0/复用 g2 授权门；Owner 专属取值未代填）；
- **仍阻断**：FZ-01~FZ-15 全部 Owner 决策未决——真实 A/C **NOT_RUN**、真实 M1~M5 **NOT_MEASURED**、Gate B **BLOCKED**、Gate C **NOT_GRANTED**；Owner 勾选并签发冻结记录后，`run-prr-real.mjs` 即为预注册实验的执行路径；
- Gate B 正向结果前不开发 Recall 生产功能、不接 Tool/Skill、不扩宿主（指令第 7 条）。

---

## 13. 第七轮定向修复（2026-10-23，head `41feb12de` 审查意见；最后一轮）

### 13.1 A：Owner 授权证据绑定（run-prr-real.mjs 重构）

| 缺陷 | 修复 |
|---|---|
| `expectedProtocolDigest` 恒为 undefined（三元两臂均 undefined 的笔误） | CLI 现场计算 `protocolApprovalDigest({freeze, preregBody})`（完整协议摘要：studyId+正文哈希+全部冻结条目）并作为 `expectedProtocolDigest` 传给 resolver |
| 传参不全 | resolver 现接收完整期望集：协议摘要、冻结提交 SHA、数据集哈希、预算（FZ-06 冻结值）、决策引用 |
| 对账不严 | 十项严格对账：resolver 必须返回 verified、approved、decisionRef、approvedProtocolDigest、frozenCommitSha、frozenFixtureHash 与官方定价证据（verified + reference==costBasisRef）——任一缺失/不一致即 `trusted-evidence reconciliation FAILED` 拒绝 |
| `trustedEvidenceVerifier` 补造字段（本地填 `frozenFixtureHash: dataset.fixtureHash`、pricing reference 回退到入参） | 改为**纯透传** reconciled attestation——resolver 未核验的字段保持 undefined，工厂自身 OD 校验随后拒绝 |
| 调用方 JSON 当独立证明 | **架构重构**：`verifyOwnerApproval` 门闭包的证据改**只来自 resolver attestation**（reconcile 通过后）；无 resolver 时闭包恒 `verified:false`（"the authorization file is not independent evidence of approval"）——authorization JSON 降级为纯路由元数据；`pi` 无 resolver 在任何其他检查前拒绝 |
| resolver 对账时机 | **前置**到 preflight 之前（门用的证据即已对账的证据），mock/pi 共用同一对账阶段 |

### 13.2 B：预算 STOP 与分母（prr-real-runner.mjs + CLI）

- **arm/study 语义分离**：文档与实现明确——PRR 账本链（study parent → arm child）中每次请求对整链预留，arm 子账本**不是**"每个 arm 各自的独立预算"，而是唯一执行链的上界；study 上界约束整个实验；
- **双 scope pre-call 检查**：arm 与 study 两个上限均在**调用前**检查（live 账本权威计数优先，任务上报有限计数兜底），任一触顶 → 立即停止（reasonCode `arm_budget_exhausted`/`study_budget_exhausted`）；
- 剩余任务完整进入 `notExecutedTasks`（保留原始分母与停止原因）；已执行行如实保留；
- 未知请求量不推断（null）；测试未降低任何预算约束。

### 13.3 C：新增测试（`prr-real-cli.test.ts` 8 项，真实 CLI spawn + 独立 resolver 模块；runner arm-STOP 1 项）

| 测试 | 断言 |
|---|---|
| 有效 resolver + mock | exit 0 + "Trusted evidence reconciled" + executed=true（25 行分母） |
| 协议摘要不匹配（freeze 篡改 FZ-11，resolver 持原摘要） | `trusted-evidence reconciliation FAILED` + `protocol digest does not match`，exit≠0，无 real-run-result 产出（拒绝先于 transport） |
| 冻结提交不匹配（resolver 持不同 commit） | `frozen commit does not match`，exit≠0 |
| 数据集哈希不匹配（resolver 持不同 fixtureHash） | `dataset hash does not match`，exit≠0 |
| 决策引用不匹配 | `decisionRef … does not match`，exit≠0 |
| 定价证据未验证/引用不同 | 双消息拒绝，exit≠0 |
| pi 无 resolver | `NOT ready` 拒绝 |
| arm 账本耗尽（arm level 40/40） | **0 次调用即停**，26−1 项全部 `arm_budget_exhausted` 保留，`counterBasis='budget_ledger'` |

既有测试全部保留：real-path 16/16、PI 工厂 10/10、全量 52 文件全绿。

### 13.4 第七轮验证证据

```text
cd scripts && npx vitest run（real-path 三套件）→ 24/24 PASS
npm run test:scripts → 52 文件 / 全绿
npm run dev:prr-rehearsal → rehearsal gate PASS
npx eslint（prr/ + spawn helper）→ 0 error；git diff --check → OK
npm run verify:merge → PASS（本地）
```

### 13.5 第七轮剩余限制

- resolver 的生产实现（真实 Owner 决策记录存储 + 官方定价源）仍属 O-05——契约与强制点已交付；
- 真实 M1～M5 NOT_MEASURED；真实 A/C NOT_RUN；Gate B BLOCKED；Gate C NOT_GRANTED。

**第七轮状态收口：离线能力 GO；执行入口授权链完整（信任根=独立 resolver，缺即拒）；真实实验仍待 Owner 冻结授权。**
