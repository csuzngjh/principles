# SPEC-PD-PRR-001 — Gate A 最新主分支差异复核报告（PRI-1000）

| 项 | 值 |
|---|---|
| 复核日期 | 2026-10-18 |
| 任务 | PRI-1000（Gate A 最新代码基线复核与收口）；关联 SPEC-PD-PRR-001 v1.3 |
| 历史审计基线 | `702d922339851f54579a4f159a91c801af9810b2`（2026-10-17 Gate A Reality Audit 基线，原报告保留不动） |
| 最新基线 | `origin/main` = `f2539e07ee0f4d2353c5e3897da81b6ef3b787ca`（`git fetch origin main` 后 `git rev-parse` 核验，与任务预期一致） |
| 差异规模 | 15 个提交；168 文件；+19,408 / −7,905 行（`git diff --stat 702d9223..origin/main`） |
| 复核方式 | 独立 worktree（`ai/PRI-1000-gate-a-freshness-delta`，基于 f2539e07e）内只读审计 + 合成夹具/包级测试定向重放 |
| 只读边界 | 未修改任何生产源码；未读取/写入真实 `.pd`、`.state`、`~/.pd/runtime`、`~/.workbuddy/pd-workspace`；未创建生产数据库；未运行付费模型；未调用外部 LLM |
| 证据标注约定 | 沿用原报告：`SOURCE_STATIC`（f2539e07e 静态源码证据）、`TEST_FIXTURE`（合成数据隔离夹具）、`FIXTURE_ONLY`、`AUTHORIZED_REAL_SAMPLE`、`NOT_MEASURED`。本轮**零 `AUTHORIZED_REAL_SAMPLE`** |
| 最终裁决 | **Gate A = GO（仅审计收口裁决，2026-10-18 新基线复验成立）；GATE_B_EXECUTION 维持 BLOCKED（D-01～D-05 全部 PENDING，见 §10）** |

> 本报告是 `docs/implementation-reports/SPEC-PD-PRR-001-v1.2-gate-a-reality-audit-20261017.md`（原 Gate A 审计，基线 702d9223）的**新鲜度差异复核**，不替代也不覆盖原报告。原报告作为历史证据原样保留。

---

## 1. 基线间提交构成（15 commits，按审计相关性分类）

| 相关性 | 提交 | 说明 |
|---|---|---|
| **审计面变更** | `b02ebb539` (#2073) | WorkBuddy 配套技能 + **显式 Owner 痛苦登记路径** + installer 技能交付（§3 详审） |
| **审计面变更** | `860e38df5` (#2062) | PRR Gate A 审计收口与 Gate B 准入包入库（纯文档：v1.3 SPEC、实验方案、决策卡、准入矩阵、原审计报告） |
| 相邻（已排除） | `c5f03c87b` (#2061) | PRI-995 RuleCode 意图前置门 + V2 强制暂停（internalization 管线，§4） |
| 相邻（已排除） | `1eb5293a2` (#2070) | Pi runtime 迁移 1.2.0（LLM adapter 层，§4） |
| 相邻（已排除） | `d91b9e07e` (#2064) | PRI-1011 LLM 输出预算降档重试 |
| 相邻（已排除） | `a66cc3841` (#2067) | PRI-1012 Companion pd-cli 入口有界等待 |
| 相邻（已排除） | `a241ca22e` (#2068) | PRI-1013 Console Codex 治理健康走安装布局权威 |
| 相邻（已排除） | `33d9bf621` (#2066) | Dev 工具链提速（pre-push-fast；AGENTS.md §25 同步修订，见 §4.6） |
| 版本/文档 | `63490efca` `7dc7b36c7` `38ddf8322` `c3933e8fc` `aee538012` `80e0a0529` `f2539e07e` | 版本推进 2.3.7、companion 0.1.4、12 篇 SPEC 入库、Pi AC-6 测试 |

## 2. 任务指定文件逐项核对（11 路径）

| 路径 | f2539e07e 状态 | 字节同一性（vs 702d9223） | 结论 |
|---|---|---|---|
| `packages/principles-core/src/runtime-v2/activation/ledger-identity.ts` | 存在 | **零变更**（`resolveLedgerActivationId` 仍在 `:121`） | A-01 结论原样成立 |
| `packages/principles-core/src/principle-tree-ledger.ts` | 存在 | **零变更**（`readLedgerFileState` 仍在 `:153`） | A-01/A-03 结论原样成立 |
| `packages/principles-core/src/runtime-v2/pain-chain-read-model.ts` | 存在 | **零变更**（`buildCandidateToLedgerEntryMap` 仍在 `:68`） | A-01 双匹配覆写风险结论原样成立 |
| `packages/host-runtime/src/governance-signal-admission.ts` | 存在 | **有变更（28 行）** | §3.1 |
| `packages/host-runtime/src/explicit-owner-statement.ts` | **该路径在两个基线上都不存在** | — | 任务给定的路径从未存在过；host-runtime 的真实共享模块是**新增**的 `explicit-owner-statement-prefix.ts`（§3.2），Codex 侧实现位于 `codex-adapter/src/ingestion/explicit-owner-statement.ts`（§3.3） |
| `packages/host-runtime/src/governance-observation-store.ts` | 存在 | **零变更**（WAL/schema-ensure 写副作用结论原样成立） | A-03 结论原样成立 |
| `packages/host-runtime/src/workspace-behavior-evidence.ts` | 存在 | **零变更**（严格只读 Port 原样） | A-02/A-03 结论原样成立 |
| `packages/codex-adapter/src/ingestion/explicit-owner-statement.ts` | 存在 | **有变更（23 行，实为抽取后的 re-export）** | §3.3 |
| `packages/workbuddy-adapter/src/explicit-owner-statement.ts` | **新增（45 行）** | — | §3.4 |
| `packages/workbuddy-adapter/src/pd-hook.ts` | 存在 | **有变更（39 行）** | §3.5 |
| `packages/create-principles-disciple/src/installers/workbuddy-host-installer.ts` | 存在 | **有变更（+415 行）** | §3.6 |

零变更判定方法：`git diff --stat 702d9223..origin/main -- <全部 11 路径>` 仅列出上表 5 个实变更文件，其余文件未出现在差异中（即字节同一）。

## 3. 实变更文件逐项审计发现

### 3.1 `host-runtime/src/governance-signal-admission.ts`（28 行）

| 发现 | 位置（f2539e07e） | 标注 |
|---|---|---|
| `GovernanceCorrectionCandidate.hostKind` 从 `'codex'` 放宽为 `'codex' \| 'workbuddy'` | `:431` | SOURCE_STATIC |
| `admitOne` 准入门：workbuddy **仅在** `kind === 'user_correction' && explicitOwnerStatement === true` 时放行；其余一律 `unsupported_host_kind` 拒绝 | `:875-877` | SOURCE_STATIC。WorkBuddy **没有**获得 Codex 的 transcript observation/keyword 采集路径 |
| WorkBuddy 显式陈述的任务 payload：`evidence: []`（源码注释："WorkBuddy explicit intake has no transcript observation to promote"——不造伪迹）；`correctionEvidence.channel = 'workbuddy_explicit_prefix'`，文本经**基线已有**的 `boundCorrectionEvidenceText`（`principle-tree` 外的 core 既有函数：sanitize 后截到 `MAX_CORRECTION_EVIDENCE_TEXT_CHARS = 2000`，`pain-signal-bridge.ts:54,66-75`） | `:617-631` | SOURCE_STATIC。`boundCorrectionEvidenceText`/`ensureGovernanceDiagnosticianTask` 均为 702d9223 已有符号（`git grep` 于基线核验） |
| payload 校验器强制 `channel` 与 `hostKind` 配对（codex↔codex_explicit_prefix，workbuddy↔workbuddy_explicit_prefix） | `:966-967` | SOURCE_STATIC |
| 去重 marker（`governance_signal_admissions.logical_observation_key`）与 per-session 限额**原样沿用**（源码注释明示 "Rate limiting and the unique observation-key dedup still apply unchanged"） | `:879-889` | SOURCE_STATIC + TEST_FIXTURE（本轮回放 §7） |
| 写入路径仍走 `openAdmissionStore`（可写连接 + WAL + pain 行 + diagnostician 任务种子）——与 Codex correction 同一条共享管线，workspace 为 WorkBuddy 独立治理目录 | `:890-900` | SOURCE_STATIC。**与只读 Recall 无关**：这是生产 hook 写路径，Recall 禁止复用（v1.3 §1.6 既定） |

### 3.2 `host-runtime/src/explicit-owner-statement-prefix.ts`（新增，24 行）

前缀解析器从 codex-adapter **抽取**为 host-runtime 共享模块：`OWNER_STATEMENT_PREFIX = 'PD记录痛苦：'`（`:2`）、`MAX_OWNER_STATEMENT_CHARS = 500`（`:4`，超长拒绝不截断）、`parseOwnerStatementPrefix`（`:15-22`，空陈述/超长返回 `matched:true, text:null` + reason，绝不伪造陈述）。语义与 702d9223 的 Codex 实现逐行等价（对照原 `codex-adapter` 版本确认为纯代码移动）。host-runtime barrel 导出（`src/index.ts:345`）。标注意义：**这是共享化重构 + 为 WorkBuddy 复用，不是 Codex 新能力**。

### 3.3 `codex-adapter/src/ingestion/explicit-owner-statement.ts`（23 行）

原 24 行本地实现删除，改为从 `@principles/host-runtime` re-export（保留 `CODEX_OWNER_STATEMENT_PREFIX` 别名）。Codex 显式前缀行为的常量、边界、解析语义不变；`tests/codex-explicit-owner-statement.test.ts`（基线已有、未改动）9/9 通过（§7）即为行为不变证据。标注：SOURCE_STATIC + TEST_FIXTURE。

### 3.4 `workbuddy-adapter/src/explicit-owner-statement.ts`（新增，45 行）

`recordWorkbuddyOwnerStatement(event, workspaceDir)`（`:5-45`）——WorkBuddy 显式 Owner 痛苦登记入口，全部门槛：

1. 仅 `before_prompt_build`（即原生 UserPromptSubmit）事件（`:6`）；其他通道（如 PostToolUse 传入 prompt 形状 payload）不构成提交（TEST_FIXTURE §7）；
2. 精确前缀 `PD记录痛苦：`；空/超 500 字符 → 有界拒绝，零写入（`:9-11`）；
3. **Owner 身份断言**：原生 `raw.is_internal_continuation === false` 才可能获得 Owner 作者归属；内部续写/缺失/类型不符 → `owner_source_unverified` 拒绝（`:12-16`）；
4. **lineage 三重校验**：原生 `session_id` + `generation_id`（turnId）不可缺失（`:17-20`）；
5. 身份键命名空间隔离：`JSON.stringify(['workbuddy', sessionId, turnId])`，与 Codex 已建立 canonical ID 无碰撞（`:21-24`）；
6. 经共享 `admitGovernanceSignals` 落 Pain + marker + 限额（`:26-38`），经既有 `ensureGovernanceDiagnosticianTask` 建诊断任务（`:39-40`）；
7. 回执明示：`unverified owner_statement; diagnosis, candidate admission, approval and activation are not complete`（`:41`）——登记 ≠ 诊断 ≠ 审批 ≠ 激活；
8. 全程 best-effort、不抛出、失败有界拒绝（`:42-44`）。

测试 `tests/explicit-owner-statement.test.ts`（新增，23 例）在**真实生产 hook 入口**（`runEntry`）+ 合成夹具工作区上断言：`pain_events` 恰 1 行（`host_kind='workbuddy'`）、`approvals = 0`、`pi_artifacts = 0`、marker payload `evidence: []` + `workbuddy_explicit_prefix`、去重/独立轮次区分、六类拒绝零残留、`host.workbuddy` 停用时零回执零 Pain、非前缀提示词（引用/内嵌/半角冒号）**绝不推断**为显式提交、会话限额保留（第 6 条起 `rate_limited`）、PostToolUse 通道不收 prompt 形状 payload、任务存储损坏时 Pain 可恢复且重发精确修复该任务、拒绝路径**不创建 `.pd/state.db`**（fail-closed）。标注：TEST_FIXTURE。

### 3.5 `workbuddy-adapter/src/pd-hook.ts`（39 行）

- UserPromptSubmit 在分发前调用 `recordWorkbuddyOwnerStatement`，回执拼入 hook 输出 `additionalContext`（`:277-283, :384, :395`）；
- decode 失败路径：若原始 prompt 匹配显式前缀**且** `host.workbuddy` flag 为 enabled，附加有界拒绝上下文（`owner_statement_decode_invalid`），不清除 Owner 消息、不绕过 decoder、停用时零输出（`:228-243`）；
- 失败语义注释同步修订（exit 0 保护 prompt 原则不变）。

### 3.6 `create-principles-disciple/src/installers/workbuddy-host-installer.ts`（+415 行）与技能交付

- 四技能随 adapter/installer payload/marketplace/版本缓存交付：`pd-record-pain`、`pd-status`、`pd-review`、`pd-disable`（`:79`）；payload 完整性证明 `missingWorkbuddyPayloadFile`（`:86-92, :146-154`，staged 副本逐文件非空校验，"从不信任 cpSync 不抛错"）；
- 安全加固：缓存版本号必须安全单段 semver（`:66-69`）；删除/写入目标必须严格位于固定缓存根内（`:71-77` 路径包含检查）；兼容原生 v2 registry 数组形态并保留其他 scope/元数据；
- `plugin/scripts/pd-control.cjs`（新增）委托正式安装器；`bundle-plugin.mjs` payload 清单同步四技能；
- `plugin.json` `defaultEnabled=false` 未动，且有测试钉死（`tests/plugin-skeleton.test.ts:42-43` "install does not equal enable"）——**WorkBuddy 默认关闭结论原样成立**；
- 技能文本 `pd-record-pain/SKILL.md` 明确：仅用 Owner 当前显式提供的 1–500 字符陈述、不代发/不模拟宿主事件、代理输出/引用/工具输出不构成 Owner 提交、CLI `pd pain record --host workbuddy` 仍不受支持且禁止借其他宿主参数绕过、审批沿用 `pd-review` 不得自动批准或激活。

## 4. 相邻变更的排除性审查

| 变更面 | 排除理由（基于 f2539e07e 实读） |
|---|---|
| PRI-995 RuleCode（`artificer-intent-preflight.ts` 新增 887 行、`internalization-consumer-cycle.ts`、`behavior-example-pack.ts`、RuleHost V2 隔离） | 全部位于 internalization 生成管线（artificer 意图前置门、源故障退避、行为示例包标签冲突校验）。行为证据**读取端口** `workspace-behavior-evidence.ts` 零变更；`behaviorEvidence` port 在 consumer-cycle 中仍为可选注入、契约未动。不触及 A-01～A-04 任何结论 |
| Pi 1.2.0 迁移（`pi-ai-runtime-adapter.ts` ±124、`context-payload.ts` +1、`telemetry-event.ts` +12、`runtime-v2/index.ts` +33 导出） | LLM adapter/遥测层；无 schema/账本/身份/只读入口变化 |
| PRI-1011/1012/1013 | LLM 预算重试、Companion 入口等待、Console 健康模型——均不在审计面 |
| Dev 工具链（`pre-push-fast.mjs`、`lefthook.yml`、`check-security-baseline.js`） | 工程门禁布局变化，无产品行为 |
| **AGENTS.md §25 修订** | `verify:merge` 从"每次 handoff 必跑"改为 CI 合并门 + 本地仅任务相关测试。本报告据此采用定向测试 + CI 门策略（诚实披露：本任务未本地全量跑 `verify:merge`，由 PR CI 承担，状态见 PR） |

## 5. A-01～A-07 逐项影响判定

### A-01 Data Map（身份解析/Ledger 可用性/Pain 反向链）——结论维持，零修订

三个权威文件字节同一（§2）；30/30 夹具在 f2539e07e 镜像上逐项复现（§7）。WorkBuddy 显式陈述产生的 Pain 走**同一条共享 Pain 路径**（`pain_events.canonical_pain_id` + marker + diagnostician 任务种子），因此 Principle→Artifact→Ledger→Candidate/Task→Pain 反向链对新增 WorkBuddy Pain **结构上同样适用**，无需新增读模型。`PainChainReadModel` 的 candidate→Ledger 双匹配 `Map.set` last-write-wins 风险（`pain-chain-read-model.ts:68-88`）原样存在，仍为 Gate B 重点验证项；WorkBuddy 新增 Pain 会进入未来该风险的测量分母（U2），但不改变风险本身。

### A-02 Evidence Coverage 矩阵——WorkBuddy 行需增补，其余维持

| 变更点 | 内容 | 标注 |
|---|---|---|
| WorkBuddy 新增证据源 | **显式 Owner 陈述**（`owner_statement` 分类、`workbuddy_explicit_prefix` 通道、≤500 字符原文、≤2000 字符持久化边界）：落 `pain_events` + `governance_signal_admissions` marker + 诊断任务种子；`evidence:[]` 不造伪迹 | SCHEMA_CAPABILITY + TEST_FIXTURE（真实生产 hook 入口 × 合成夹具） |
| WorkBuddy 仍然没有的 | transcript 采集（无 consent、recorder 仍自报 unsupported 且未改动）、Agent read-back、行为观察 capability 真实测量（自报 unknown 原样） | SOURCE_STATIC（`workbuddy-evidence-recorder.ts` 等零变更） |
| EMPIRICAL_COVERAGE | 各宿主×来源真实分母**维持 NOT_MEASURED**。已知例外（非本轮测量）：`docs/reviews/2026-10-17-workbuddy-pain-skills-repair.md` 披露的隔离失误使真实 WorkBuddy 治理库存在 2 条 Pain + 2 个 succeeded 诊断任务、0 候选（§9） | NOT_MEASURED（系统性覆盖率不变）；披露事实引用 |

### A-03 Read-only Proof Plan——结论维持，零修订

五个只读/副作用证明对象（SqliteConnection 双形态、`openTrajectoryDbReadonly`、`listGovernanceObservations` WAL/schema-ensure、BehaviorEvidencePort）对应文件全部零变更，17/17 夹具重放全过（§7）。新增代码只加了**写路径**（admission 对 workbuddy 显式陈述的接纳），没有新增任何读取入口——Recall 只读合同的"禁止清单"不变。

### A-04 Disclosure Matrix——WorkBuddy 行需修订；四能力区分红线重申

| 字段/能力 | 702d9223 结论 | f2539e07e 结论 |
|---|---|---|
| WorkBuddy "Owner Correction 摘录"行 | "无 self-report 采集通道（recorder 自报 unsupported）" | **修订**：现有原生**显式 Owner 陈述**通道（前缀 + flag 门 + 身份断言 + lineage 校验 + 限额 + 去重），capture 侧在 flag 开启时**按设计授权**；回执即披露，无静默采集 |
| WorkBuddy transcript / Raw | 无采集 | **维持**：新路径不读 transcript；`transcript_path` 传入也仅作"必须不读"的负例断言（TEST_FIXTURE） |
| Agent read-back（三宿主） | NOT_COVERED | **维持 NOT_COVERED**：新路径不提供任何 Agent 历史回读；审批/激活仍须 Owner 经 `pd-review`（tests 断言 approvals=0、pi_artifacts=0） |
| Codex 全部行 | — | **维持**：Codex 行为零变化（re-export 等价 + 9/9 回归） |

**四能力区分（任务红线，逐条落名）**：
1. **Owner 显式陈述**（本次新增）：Owner 亲自以约定前缀提交的原文——**仅此一项**获得新通道；
2. **transcript 采集**：未变，WorkBuddy 无；
3. **Agent 历史回读**：未变，三宿主均 NOT_COVERED；
4. **Owner Correction**（transcript 推导的纠正证据）：未变，WorkBuddy 无该推导路径（其 correctionEvidence 是显式陈述的分类复用，不是从 transcript 挖出的纠正）。
不得从 (1) 推断 (2)(3)(4) 任一已获授权。

### A-05 Pilot 宿主建议——**维持 Codex 首选；WorkBuddy 维持暂缓（理由更新）**

| 维度 | WorkBuddy 在 f2539e07e 的增量 | 是否足以改推荐 |
|---|---|---|
| 真实接线证据 | 安装交付在隔离合成环境实测（review 文档：installer 目标套件 72/72、真实 engine 技能加载日志可见四技能五 Hook）；**真实 Desktop 已安装运行时 E2E 仍 NOT_RUN**；真实 LLM 全学习 BDD NOT COMPLETED（review 文档明示） | 否——接线证据仍非真机 |
| 证据完整性 | 显式陈述 = Owner 主动、稀疏、≤500 字符；无 transcript 广度；Pain 治理库真实样本仅披露的 2 条（隔离失误产物，非系统覆盖） | 否——Recall Pilot 需要历史证据广度，NOT_MEASURED |
| 授权边界 | capture 侧 flag 门已闭环，但 read-back consent/披露文本不存在（Codex 有 G2A 冻结文本可延伸） | 否——授权地基 Codex 仍最短 |
| 实施成本 | WorkBuddy 需先补 read-back consent 立项 + 真机链路验证；Codex 仅需 1 Skill + 1 只读 CLI | 否 |

**结论**：A-05 建议原文（Codex 首选 / OpenClaw 次选 / WorkBuddy 暂缓）**维持**；WorkBuddy 的暂缓理由从"数据侧无任何 Owner 输入通道"精确化为"显式陈述已具备，但证据广度 NOT_MEASURED、read-back consent 未立项、真机 E2E NOT_RUN"。未授权项一律保留 NOT_RUN/NOT_MEASURED，不升级。

### A-06 Gate B 实验提案骨架——维持，加一条注记

A/C 对照结构、任务三类型、B0 预注册、STOP 条件均不因本差异改变。**注记**：若 Owner 在 Gate B 材料授权（D-01）中纳入 WorkBuddy 显式陈述，其 `owner_statement` 原文可成为 C 组 Oracle 材料的一类来源（边界 ≤500 字符、已按 owner_statement 分类）；这**不改变**材料须逐条过脱敏/长度预算/授权的要求，也不构成默认纳入。

### A-07 Uncertainties——U6 收窄但保持开放；其余不变；新增一项披露性事实

| # | 变化 |
|---|---|
| U1～U5、U7、U8 | **不变**（真实分母、candidate 多归属频率、observation→Pain 关联率、候选集 vs 注入集、pending observation 拒绝行为、blob 过期恢复率、Gate B 材料构成——全部仍待授权/待 Gate B/C） |
| U6（WorkBuddy Desktop 技能加载/安装器缓存行为） | **收窄未关闭**：安装器缓存/升级/目录安全在隔离合成环境实测通过（72/72），真实 engine 技能加载有日志证据；**真机已安装运行时 E2E 与真实 Desktop hook 语义（含 `is_internal_continuation` 实际取值分布）仍 NOT_RUN** |
| 新增披露事实（不编号为新不确定项，归 U1 分母注记） | 真实 WorkBuddy 治理库现存 2 条隔离失误 Pain + 2 个 succeeded 任务、0 候选（review 文档披露，本轮未读取该库）；Gate B 若做 WorkBuddy 分母测量，须把这两条标记为 lab 起源而非自然使用样本 |

## 6. 定向验证（命令与真实结果）

全部在 worktree `D:\Code\_worktrees\principles\PRI-1000-gate-a-freshness-delta` 内、合成数据上执行；夹具为 2026-10-17 Gate A 夹具的逐字副本（仅 mirror 指向改为 f2539e07e 的 `git archive` 快照，断言零改动），运行产物与完整日志在 worktree `.tmp/pri-1000/`（不进版本库）。

| # | 命令 | 结果 |
|---|---|---|
| 1 | `npx vitest run .tmp/pri-1000/fixture-f2539e07e/replay.test.ts --root=. --testTimeout=120000`（经 vitest 装载两份夹具；夹具自带 JSON 判定） | **fixture-ledger 13/13 PASS；fixture-sqlite 17/17 PASS**（与 2026-10-17 基线结果逐项一致） |
| 2 | `cd packages/workbuddy-adapter && npx vitest run tests/explicit-owner-statement.test.ts tests/plugin-skeleton.test.ts` | **33/33 PASS**（显式陈述 23 + 骨架/默认关 10） |
| 3 | `cd packages/codex-adapter && npx vitest run tests/codex-explicit-owner-statement.test.ts` | **9/9 PASS**（抽取重构后 Codex 行为不变） |

合计 **72/72 断言通过，0 失败，0 跳过**。测试范围为本次差异直接触及面，未运行无关大型套件；全量门禁由 PR CI 承担（AGENTS.md §25 当前口径），CI 状态以 PR 页面为准、不在本报告预写绿。

**只读合同遵守**：测试仅写入 `os.tmpdir()` 临时目录与 worktree `.tmp/` 夹具工作区（自带清理断言：拒绝路径不创建 `.pd/state.db`）；未创建生产数据库、未执行迁移/schema ensure、未触发 WAL 翻转于任何真实库、未修改业务状态。任务指定文件清单中"只读合同"逐项核对：无数据库创建路径新增、无迁移新增、无生产代码修改。

## 7. WorkBuddy 隔离事件披露（引用，不重复调查）

`docs/reviews/2026-10-17-workbuddy-pain-skills-repair.md`（已随 #2073 入库）披露：原生验收期间隔离失误使 2 条标注"隔离验收信号"的记录进入真实 WorkBuddy 治理库；发现后停止原生提交、向 Owner 披露、未删除记录、未批准未激活；只读复核 2 个诊断任务均 succeeded 且 principle_candidates 为空。本审计**未读取、未修改**该真实库，仅引用该披露作为真实库状态事实。该事件不削弱 A-01～A-04 任何证据，但 Owner 应知悉真实库中存在 lab 起源记录（§5 A-07 注记）。

## 8. Gate A 最终裁决

> **Gate A = GO（审计收口裁决，2026-10-18 于 f2539e07e 复验成立）**

- A-01～A-04 的全部静态与夹具证据在新基线上逐项复验成立（3 个核心文件字节同一 + 30/30 夹具重放 + 72/72 定向断言）；
- 唯一实质新增面（WorkBuddy 显式 Owner 陈述路径）已按四能力区分红线完成影响评估：**不改变** read-back NOT_COVERED、transcript 未采集、审批/激活 Owner 独占三条边界；
- A-05～A-07 为提案层，已按新事实修订（§5），无未解决的 Gate A 阻断项。

**此裁决的精确含义**：仅代表"Gate A 只读审计完整且对当前 main 有效"。**不构成** Gate B 执行授权、付费模型调用授权、真实数据读取授权或任何生产开发授权。

> **GATE_B_EXECUTION = BLOCKED（维持）**。阻断原因（准入矩阵 P-06～P-10 + P-12）：D-01 数据与成本授权、D-02 召回资格口径、D-03 Codex read-back 处置、D-04 WorkBuddy consent 立项、D-05 首个实验宿主指定，全部 **PENDING Owner 裁决**；B0 预注册未做。Gate B 日期上的任何推进都必须从这些决策卡开始，而不是从本报告开始。

## 9. PRI-1000 验收条件判定

任务书四之 4 的两分支判定：**A-01～A-07 均有充分证据，无未解决的 Gate A 阻断项 → 走文档 PR 分支**（本 PR）。交付物核对：

1. ✅ 本补充报告（基线双 SHA、差异清单、逐项审计、A-01～A-07 影响、测试命令与真实结果、最终裁决）；
2. ✅ 准入矩阵 P-02 基线新鲜度结论修订 + 本报告纳入证据索引（同 PR）；
3. ✅ 原始 2026-10-17 审计报告原样保留（本 PR 零改动该文件）；
4. 阶段门禁：D-01～D-05 维持 PENDING 未代填；未执行 PRI-1001/1002；PRI-1003/1004 未解锁；无新数据库/服务/权限平台/Raw 检索/MCP。

## 附：证据索引

- 本轮工作树：`ai/PRI-1000-gate-a-freshness-delta`（base f2539e07e），审计产物 `.tmp/pri-1000/`（夹具副本、mirror、运行日志与结果 JSON，gitignored，不入库）；
- 原审计报告（历史证据，未改动）：`docs/implementation-reports/SPEC-PD-PRR-001-v1.2-gate-a-reality-audit-20261017.md`；
- WorkBuddy 交付 review（含隔离事件披露）：`docs/reviews/2026-10-17-workbuddy-pain-skills-repair.md`；
- WorkBuddy 设计 SPEC：`docs/specs/SPEC-WORKBUDDY-PAIN-CLOSURE-001-v0.1.md`；
- 测试证据文件（本仓库测试，f2539e07e 实跑）：`packages/workbuddy-adapter/tests/explicit-owner-statement.test.ts`（23）、`packages/workbuddy-adapter/tests/plugin-skeleton.test.ts`（10）、`packages/codex-adapter/tests/codex-explicit-owner-statement.test.ts`（9）。

**SPEC-PD-PRR-001 Gate A main-freshness delta 复核报告 END**
