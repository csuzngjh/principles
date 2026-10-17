# SPEC-PD-PRR-001 v1.2 × Zcode Gate A 指令：独立复核与执行校订（2026-10-17）

> 裁决：**原 Gate A 方向成立，但原始指令未达到无歧义直接投递标准。** 本报告仅提供审计事实、差异和纠偏规则；不改变原 SPEC 的产品范围/Owner 权限，不赋予 Gate B/C/D 实施许可。
>
> **使用方式**：在执行 PRI-997/998/999 前同时读取原 SPEC 与本校订；若二者在本轮 Gate A 的数据权限、审计产物可得性、读取复用、工单状态/方法上表述冲突，以本报告的更保守解释为准。正式调整 SPEC 版本及 Linear 描述须另行通过受控同步，不暗改原始文件/既有 SHA。

## 1. 固定核查上下文与未实施事实

- 本地仓库：`D:\\Code\\principles`；本地 HEAD `39ebac3f56dc5394844284166c867d2266b159a7`，当前状态为 `main` 落后且有用户既有未提交文件，必须保护。
- 用户本地 SPEC：`docs/specs/SPEC-PD-PRR-001-principle-pain-recall-v1.2.md`，SHA256 `4422F14F2A6CBCD20F0AC50515E92622BAB77C0ABC0C819D06988CC89CEBD465`（文件原样保留）。
- v1.2/独立评审原代码基线 `f7d47ae0`，2026-10-17 核实时 `origin/main` 和 `git ls-remote origin refs/heads/main` 均为 `702d922339851f54579a4f159a91c801af9810b2`。Zcode 启动时需重新核实；不能以此处 SHA 永久替代最新 HEAD。
- v1.2 是本地**未跟踪文件**，`origin/main` 不包含它。**隔离 worktree 不能假设存在该相对路径**。Zcode 必须先从原主工作区绝对路径只读加载并校验 SHA，然后可在自己的审计工作区使用经检验的只读副本。
- 本轮只做审计与指令核对，**没有运行真实宿主 E2E、真实私人数据库扫描或付费 Agent A/C 实验**。证据覆盖率、披露授权和行为收益仍然是 NOT_MEASURED / OWNER_DECISION_REQUIRED / UNPROVEN，不准假装已证明。
- 当前本机 Linear CLI 入口：`C:/Users/Administrator/.agents/skills/linear-cli/scripts/linear.cjs`，相应 `SKILL.md` 已验证存在并支持 `context/start/comment/status`。这是用户级权威，不属于当前仓库；本轮已只读运行 `context PRI-997/998/999` 确认 Todo，未调用 start/status 修改。
- 关联的 Linear：PRI-996 父任务；PRI-997/998/999 三项无阻塞可审计；PRI-1000 被三项阻塞，Gate B/C/D 其余任务处于后续审批范围。

## 2. 关键问题、严重度与精确校订

| 编号 | 严重度 | 核查发现 | 对执行的精确校订 |
|---|---|---|---|
| F-01 | **P0** | 远端 main 已从 v1.2 的 `f7d47ae0` 前进到 `702d9223`，新增 PR #2048 行为证据共享实现 | 先做新旧基线差异对照，纳入 `host-runtime` 共享证据端口与现有 SQLite 真实只读实现；不能照旧 SPEC 规划重复 Reader/Assembler |
| F-02 | **P0** | v1.2 在本地为未跟踪文件，隔离 worktree 中不存在 | 明确从原仓库绝对路径读取/校验，再作隔离检验；不要求或暗自把 SPEC 提交到 main |
| F-03 | **P1** | `readLedgerFileState` 将“文件不存在”与“零字节/仅空白文件”都返回 `availability=empty`，不能直接区分 | 审计应精确断言 `ok/empty/unreadable`；如果调查原因需要细分不存在和空文件，再额外检查文件存在性/大小；不得改写既有三态或声称四态由该 API 提供 |
| F-04 | **P1** | `parseHybridLedger(raw)` 对语法合法、结构非 Record 的 JSON 返回空 Ledger，不必然报告 unreadable | 报告应分开 `JSON parse 错误` 和 `JSON 语法正确但结构异常/被宽松解析`；不能把所有“坏 schema”都预期为 unreadable |
| F-05 | **P1** | 2026-10-16 PR #2048 在 `host-runtime` 引入 `BehaviorExamplePackAssembler`、`assembleBehaviorHistory`、`createWorkspaceBehaviorEvidencePort`，供 Codex/OpenClaw/CLI 复用；已有只读 SQLite `fileMustExist:true` + snapshot transaction 实现 | A2 必须判断其能否复用 canonical Pain → 有 Owner 标签的 Tool Evidence 与有界历史；它**不等于**通用 Recall 查询，也不自动证明 Owner Correction 原话关联；只评估真实重叠范围 |
| F-06 | **P1** | `governance-observation-store.ts` 的 `listGovernanceObservations` 确实调用可写 `openStore()`，设置 WAL 并 ensure schema | 只可在隔离夹具验证该事实；生产历史不允许调用此入口来“验证只读”；与 `createWorkspaceBehaviorEvidencePort` 的真正只读能力分别记录 |
| F-07 | **P1** | 原 SPEC 的 Gate A 字眼“冻结历史披露/由 Owner 明确确认”，与 Zcode 非交互且未经额外授权的只读审计存在职责错位 | A3 只做**现有授权证据盘点 + 待 Owner 决策清单**，不能代替 Owner 冻结新的许可。A3 的**审计交付可为 DONE**且结论 OWNER_DECISION_REQUIRED；Gate A 对进入 B 的就绪性另判 BLOCKED |
| F-08 | **P1** | `Codex ingestion consent` 的披露范围是收集 transcript、治理观察与特定诊断 API 外发，不等于新增 Agent Recall 再披露许可 | 明确区分 capture / retention / diagnosis egress / agent read-back 四种不同能力；没有 Read-back 明确覆盖的字段列为 NOT_COVERED/UNVERIFIED，不能因启用了 ingestion 就说“可以回忆” |
| F-09 | **P1** | SPEC 要各宿主“完整分母/有效摘要率”，但未批准私人数据读取时根本没有合法实际样本 | 将“schema/代码可达性覆盖”与“真实数据覆盖率”分栏；未获许可真实样本用 NOT_MEASURED（分母未知，不是 0），不得为凑百分比访问真实历史。允许安全构造 fixture 的统计，必须标明不是生产覆盖率 |
| F-10 | **P1** | Gate B 的人工 Oracle C 组可以无限增加历史事实，容易证明的是“原始内容有用”，而 Gate C 仅可披露 LIST + 摘要 | Gate B 的主要 A/C 评估材料必须遵守预期 Pilot 同等数据类别、脱敏、长度预算、授权和证据质量；若另作 Raw 上界试验，仅记为独立探索，不把该成绩用作 Gate C GO |
| F-11 | **P1** | 既有 `readPromptActivationCandidates` 读取可参与 Prompt 的有效候选，但后续还有预算/公平轮转、最终渲染；它不是“本轮实际注入集合”的证明 | A1/A3 要分别报告 `candidate eligibility`、`final injected set`、`canonical Ledger ID`；不等价的 ID 或授权界限均拒绝推断 |
| F-12 | **P1** | 原 Zcode 指令仅写“项目现有 Linear CLI”，但本地项目没有 `scripts/linear-cli`，权威实际位于用户级 Skill | 按实际路径先读 SKILL.md，再执行 `node .../linear.cjs context PRI-xxx`、`start`、`comment --body-file`、`status PRI-xxx Done`。审计票不创建 PR，**不调用要求 PR 的 handoff**；禁用第二个 Linear 状态写入者 |
| F-13 | **P2** | 原指令的“审计只读”与“创建隔离工作区、运行临时 SQLite 夹具、写 Markdown 报告、更新 Linear”字面上可混淆 | **只读限制作用于生产源码/真实 PD 数据库/宿主治理状态**；允许审计者在自建独立目录中产生临时测试 DB/报告，并通过一次 Linear CLI 工作流作任务状态写入。不允许改变当前用户工作树/生产安装或执行写模式读取函数 |
| F-14 | **P2** | 指令中的“PRI-999 冻结/三个完成才解锁”可能使 Agent 在未获 Owner 许可时伪造批准或永远不敢 Done | 将**工单交付 DONE**与**Gate A→B 准入 GO**分开：已交完整调查矩阵、授权空白也如实标记，则审计票可 Done；汇总 PRI-1000 只有等其自身 blocker 在 Linear 中解除后才可执行，且不得本轮抢跑 |
| F-15 | **P2** | 不允许创建 PR/提交时仅把结果放到本地被忽略临时目录会丢失团队可见性 | 审计报告放在新的可追踪 `docs/implementation-reports/` 路径（未获提交许可不提交）；将脱敏的关键发现/文件路径/Commit SHA 与保留的不确定性同步到工单评论。只有本地路径不能当作已发布证据 |
| F-16 | **P2** | Gate B 的 H1 文本“显著改善”可能被误解为固定统计显著性或事后选阈值 | B0 预注册前明确业务上有意义的行动提升/Owner 时间下降、可接受 Token/时延、STOP 条件；样本不足 UNPROVEN，不能按任意 20% 或 p-value 口头通过 |

## 3. 已核实的准确性（原设计无需推翻）

1. `resolveLedgerActivationId` 确实存在且已由 Activation Dispatcher 使用；`readPromptActivationCandidates` 已采用 readonly state.db 模式，但不自动完成 Agent 读取授权。
2. `derivedFromPainIds` 当前正向链把值当 candidateId；`reuseEvidence` 包含 candidateId 关联；`pain-chain-read-model.ts` 目前仍以 `Map.set` 对歧义有覆写风险。
3. `openTrajectoryDbReadonly` 文件缺失时抛不可用，不静默创建库；observation-store 的普通 `list` 不适合直接用于 Recall 只读。
4. 首版应保留按需、无自动历史注入、无新状态源、历史未获授权不披露、formed/reused 不伪造、Owner Correction 与模型诊断区分。
5. **Gate A 允许审计，Gate B/C/D 需另行批准**；三宿主为最终目标而不是 Gate A 或单宿主 Pilot 的完成声明。

## 4. 强制报告状态的统一解释

- **ISSUE_DONE（PRI-997/998/999）**：该工单审计按其已许可范围完成、有真实材料、未决事项列明；不要求获得新的 Owner 许可才能标“审计完成”。
- **ISSUE_BLOCKED**：关键的审计事实本身没有取到，或真实受阻；说明哪些交付缺失，保留 Todo/In Progress 并给出 blocker。
- **DATA_NOT_MEASURED**：源与字段可静态核实，但没有授权样本的实际覆盖率；不能以 0/100% 假装统计。
- **GATE_A_AUDIT_COMPLETE**：可从三项审计汇总得到 A-01～A-04，有证据/明确缺失，但不意味 Gate B-ready。
- **GATE_B_READY**：必须经 A4 汇总提案并由 Owner 批准数据、费用、模型、隐私和预注册。三项审计 DONE 不自动达成。
- **NOT_RUN**：本轮未运行真实插件 E2E/历史原文检索/Agent 价值实验/上线；不允许改写为 PASS。
- **STOP**：若发现无法合法披露需要的数据或严重证据归属问题，停止该数据访问/实施，不通过临时放宽授权或回填历史越过。

## 5. 安全实施边界

此次允许：读取本机源码/已授权的文档、只读 Git 与远端 SHA/PR 信息、审计设计/真实函数调用图、完全隔离的临时测试夹具、撰写报告、通过 CLI 对本轮审计任务完成最小必要 Linear 状态与证据更新。

此次不允许：修改生产源码/现有用户工作树/任何真实 `.pd`、`.state`、`~/.pd/runtime`，未授权读取私有历史全文，写入或自动修复真实数据库、激活/停用/审批，修改功能开关，执行需要额外授权的模型实验，PR/提交/部署/合并，以及 PRI-1000/1001 或后续 Gate 的执行。

**最终判断**：原 v1.2 SPEC 的产品假设和阶段管理基本成立；但执行细节如 F-01～F-16 必须以新的审计指令覆盖，否则不能声称“无歧义”。本报告没有替代 Gate A 的真实数据审计，也未证明 PRR 对行为的价值。

