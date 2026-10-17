# Zcode 后端一次性目标指令 — SPEC-PD-PRR-001 v1.2 / Gate A 审计校订版

> **唯一授权任务：PRI-997、PRI-998、PRI-999。** 全程非交互，不询问 Owner、不中途等待审批；外部授权缺失时不越权，标记 OWNER_DECISION_REQUIRED / BLOCKED，继续其他独立可审计部分。执行结束一次性报告。

你现在负责对 `D:\Code\principles` 的 Principles Disciple 项目完成 **SPEC-PD-PRR-001 v1.2 / Gate A 只读 Reality Audit**。这是三个审计工单，不是 Recall 功能开发，不需要创建 PR。原则回忆的行为价值尚为 UNPROVEN。

## I. 必做前置检查（顺序固定）

1. 从**原工作树绝对路径**读取以下两个本地文件（均可能未提交、不存在于远端）：
   - `D:\Code\principles\docs\specs\SPEC-PD-PRR-001-principle-pain-recall-v1.2.md`
   - `D:\Code\principles\docs\specs\SPEC-PD-PRR-001-v1.2-reality-audit-corrections-20261017.md`
   同时读取 `D:\Code\principles\.tmp\prr-spec-review-20261016\REVIEW.md`（如果仍存在）。核验 SPEC SHA256 应为 `4422F14F2A6CBCD20F0AC50515E92622BAB77C0ABC0C819D06988CC89CEBD465`。哈希不符或关键文件缺失则如实报告并禁止引用不确定的版本，不使用远端旧规格顶替。
2. 只读记录 `git status --porcelain=v1`、当前 HEAD、`git rev-parse origin/main` 和 `git ls-remote origin refs/heads/main`。本次起点原 Main `39ebac3f` 已长期落后；最近已知远端为 `702d922339851f54579a4f159a91c801af9810b2`（非永久有效）。如两者不一致，可仅运行 `git fetch origin main` 更新远端引用并重新核验，**绝不能 checkout/reset/clean/rebase/merge 原用户工作树**。必要时在新建的隔离 worktree 检查最新源码，原本地 SPEC 需经明确只读复制/绝对路径加载才会在那里可见。
3. 检查相同范围的现有代码和并行 PR。**必须特别阅读远端 PR #2048 合并形成的** `packages/host-runtime/src/behavior-example-pack-assembler.ts`、`behavior-history.ts`、`workspace-behavior-evidence.ts`，以及 OpenClaw adapter、Codex worker 和 CLI 对这些模块的引用；这是 v1.2 原 SHA 之后的新增共享证据能力。识别真实复用机会，但不要把它误判为已经有通用 Principle→Pain Recall。
4. Linear CLI 的**真实权威**是 `C:/Users/Administrator/.agents/skills/linear-cli/SKILL.md`，实际可执行文件为 `C:/Users/Administrator/.agents/skills/linear-cli/scripts/linear.cjs`。先读 SKILL.md；运行 `node "C:/Users/Administrator/.agents/skills/linear-cli/scripts/linear.cjs" context PRI-997`（依次 998、999）重新确认实时 `canStart`、状态、阻塞与验收。若缺 CLI、凭据或权限，则保留现状并报告，不改用第二状态写入者，不假装已更新 Linear。

## II. 本轮绝对不允许的行动

不得修改任何生产源码、安装插件、宿主配置、Owner 权限/激活/审批、真实 `.pd` / `.state` / `~/.pd/runtime`、现存 SQLite 或真实历史数据；不得强制修复/迁移/初始化真实数据库；不得为了覆盖率抓取未授权私人历史全文；不得使用付费 LLM 进行 A/C 或 A/B 实验；不得建设 Recall Tool、Raw、MCP、索引/平台，创建 Commit/PR/部署/合并；不得运行 PRI-1000、PRI-1001 或 Gate C/D 的工单。

审计的“只读”特指**业务生产资产无写入**。允许在你独立创建的临时目录内生成完全合成的 SQLite Fixture/测试输出，允许写本轮审计报告和通过唯一 Linear CLI 修改本轮三个审计工单的状态/评论。这不构成“已被授权使用真实私人历史数据”。所有临时夹具要与真实路径分离且不得冒充生产统计。

## III. 实际任务（独立调查、汇总交叉检查）

**PRI-997 — 身份、Ledger、形成与复用反向链：**

- 核对 `resolveLedgerActivationId`、ActivationDispatcher 与 `readPromptActivationCandidates`，区别候选可见资格、**本轮实际注入集合**、Artifact identity 与 Ledger canonical ID；后两者不允许凭 title/text 猜测一致性。
- `readLedgerFileState` 的合同只有 `ok/empty/unreadable`；**文件不存在和空/仅空白文件都为 empty**。如需区分这两个根因，另外使用文件存在性/大小，不能声称 API 自带第四状态。
- `parseHybridLedger` 对某些语法合法但结构非法 JSON 可能宽容地归为空 Ledger；区分 JSON 解析故障、结构坏损/静默归空与真正空账本，不做未核实的“损坏 JSON 一定 unreadable”断言。
- 按真实代码证明 Ledger 的 `derivedFromPainIds` 中当前是 candidateId，`reuseEvidence` 为另一个来源，复核 Candidate/Task/Artifact/`sourcePainId` 的可信来源与歧义处理。现有 PainChain 的 `Map.set` 在重复候选时可能覆盖，严禁将最后写入的归属当作真实归属。
- 交付 A-01 身份与来源图、失败/冲突/失联场景、现有复用方法与源码/测试的确定性证据。

**PRI-998 — 证据来源、覆盖与数据库只读真实性：**

- 审计 OpenClaw 痛苦与历史 Turn/Blob、Codex `governance_observation:<logicalKey>` / `correctionEvidence`、WorkBuddy 的实际持久化来源、手工摘要来源；sourceRef 的存在不等于 Owner Correction 已关联、可读取或可对 Agent 披露。
- 重点检查最新 `createWorkspaceBehaviorEvidencePort` 和 `BehaviorExamplePackAssembler`：它们目前围绕**Owner 显式标记的工具行为样例**与历史组装，已有共享 host-runtime 能力和只读 DB；不要重复造一个同形 Reader，也不能把工具样例自动当成任意历史原文。
- `governance-observation-store.ts` 的 `listGovernanceObservations` 依赖 writable `openStore`（WAL、Schema Ensure）。绝对禁止在**真实** DB 上调用其“list”以测试无写入。对照 `openTrajectoryDbReadonly`、已有 `SqliteConnection(readonly:true,bootstrapIfMissing:false)` 和真正只读 BehaviorEvidencePort 的具体调用链。
- A-02 必须将 `SCHEMA_CAPABILITY`（静态支持能力）与 `EMPIRICAL_COVERAGE`（获授权真实样本的分母/占比）分开。未获授权实际样本时填写 `NOT_MEASURED`、分母未知，不得写 0%、100% 或虚构命中率；允许仅对完全合成 Fixture 计算 `FIXTURE_ONLY` 统计。
- A-03 必须说明每种读取入口的打开参数、副作用、关闭行为和缺库/缺 Schema 的失败合同；有试验则仅用隔离 Fixture，不通过读生产库“检测”WAL/Schema 副作用。明确 deletion/retention 来源与缺失/截断质量。
- 对真实性、Owner 原话、模型诊断、工具历史的区别和源所有权提出最小复用建议，不新增生产抽象。

**PRI-999 — 授权、披露、撤回和宿主权限：**

- 逐宿主建立 `host × source × field × consent/enablement × enforcement × revoke × retention × OS/Shell residual risk × status` 矩阵；字段至少包括原则文本、Pain 摘要、诊断摘要、Owner Correction 摘录、Raw、Tool Facts。
- **明确区分** Codex transcript **采集许可**、本地保留、已准许的诊断 API 外发与**未来 Agent Recall 再披露授权**，不能用开启 ingestion 推导允许 Agent 读回私人历史。核实真实 `codex-disclosure.ts` 的文字。
- 对 `readPromptActivationCandidates` 必须区分候选合格集合与最终 Prompt 渲染的实际注入集合；有效激活并不天然覆盖读取背后的历史。验证宿主 disable/revoke、Workspace Resolver、Skill+Shell 权限与 Operator CLI 的不同访问范围；WorkBuddy 不静默跨宿主回退。
- **本审计不能替 Owner 确认新的许可**。已有生产配置及其真实授权范围列为 `VERIFIED_EXISTING`；未明确覆盖的列为 `NOT_COVERED` 或 `UNVERIFIED`，并给 Owner 一份清晰的决策卡。PRI-959 未决手工证据同意语义不擅自裁决。
- A-04 是否完成取决于矩阵是否**真实、完整且承认未决**；不以是否获得新的 Owner 批准来判定本审计工作是否完成。Owner 尚未批准 B 实验时，`GATE_B_READY = BLOCKED`。

## IV. 审计成果、状态与写入边界

1. 只为本轮创建独立、未存在的报告文件，路径建议 `docs/implementation-reports/SPEC-PD-PRR-001-v1.2-gate-a-reality-audit-YYYYMMDD.md`；保持源码可追溯 commit SHA/行号，分 A-01 Data Map、A-02 Coverage、A-03 Read-only Proof、A-04 Disclosure Matrix 四部分；列出 A-05 Pilot 宿主的**候选比较**、A-06 B 实验的**可批准提案**、A-07 不确定性，**不要宣称 PRI-1000 已执行**。
2. 任何结果必须注明出处是 `SOURCE_STATIC`、`TEST_FIXTURE`、`AUTHORIZED_REAL_SAMPLE` 或 `NOT_MEASURED`，并注明哪些测试实际执行。若无合法真实样本，原则上不做覆盖率推断。
3. 尽可能在每项工单开始时经 `linear.cjs start PRI-997/998/999` 转 In Progress；每项审计完成时使用 `linear.cjs comment <ID> --body-file <path>` 回写脱敏证据摘要，再按真实交付情况 `linear.cjs status <ID> Done`。**不要调用需要 PR 的 `handoff`**；也不要在工作目录不存在时执行假想的 `scripts/linear-cli`。若 CLI 报错须核验实际结果，不能无反馈地重试写入或并行增加第二状态写入者。
4. **工单完成与下一阶段批准严格分开**：如果审计证据和授权矩阵已形成但某些授权待 Owner 决定，工单可 Done 并注明 `OWNER_DECISION_REQUIRED`；若其自身审计材料不足，则留未完成并说明 blocker。即使三项 Done，**只可报告 PRI-1000 从 Linear 阻塞角度可能解锁，不允许在本轮执行 PRI-1000，不自动批准 Gate B**。
5. 报告只在本地写入且不创建 PR/Commit 时，不得声称其已同步到 GitHub。Linear 评论应含足以跨设备检查的脱敏事实和基线，不包含秘密/私人原文。
6. 最终核对 git status diff，确保生产代码、现有用户修改、真实 PD workspace/安装资产不因本轮被修改；列举确实新建的报告和临时夹具。

## V. 非交互的失败及停止语义

- 任务无法读取本地 SPEC、远端基线不可验证、源码权限不足：记为 `BLOCKED`，说明原因；**不改用旧主分支凑结果**。
- 权限允许源码审计但禁止私人样本：继续源码审计，真实数据覆盖为 `NOT_MEASURED`，不要把未知计入零分母。
- 即使某一审计票遇到受限数据，继续其他独立、合规的审计；不能为了“全部绿”扩大权限。
- 发现历史数据可能越权：立即停止该访问路径，仅保留合法范围的事实和风险描述。
- 无任何自动审批、无用户对话、无下一阶段任务串跑。

## VI. 最终只输出一张 Owner Review Card

报告：最新远端 SHA / 本地 SHA / 用户工作树保护证明 / 原 SPEC 校验值 / PR #2048 对本次设计的增量 / A-01～A-07 文件位置 / PRI-997–999 的真实 Linear 状态与审计结论 / 不可用与 NOT_MEASURED 数量 / Codex capture-vs-disclosure 边界 / Ledger empty 与 parser 宽容语义 / 已有复用接口及禁止重复实现的点 / Owner 必须决定的事项 / 是否满足 PRI-1000 Linear 依赖解锁（**不执行它**）/ Gate A 的 GO、CONDITIONAL、BLOCKED 或 STOP / 未运行的 B/C/D/真实 E2E 状态。

**成功标准**：真实、可复核、没有夸大权限或成果的源码与历史证据可用性审计；不是开发出 Recall，也不是把全部工单状态改成 Done。

