# PD_LAB_SPEC_V02_INDEPENDENT_REVIEW — SPEC v0.2 独立反向评审

> 阶段 1（Stage 1）输出 · Gate 1 · 评审时间 2026-11-16 · 评审基线 `origin/main @ 23f2c17fd`
>
> 评审立场：**独立架构评审者，以推翻 v0.2 为目标**。以下每个「推翻尝试」都给出了
> 实际执行的核验动作与结果；推翻失败的事实本身是评审证据，不是客套话。
> 被评审对象：`docs/specs/SPEC-PD-LAB-EXPERIMENT-INTEGRATION-001-v0.2.md`（本次 PR 内附原文本）。

## 0. 评审结论（先行）

| 项 | 结论 |
|---|---|
| P0 发现 | **0** |
| P1 发现 | **0** |
| P2 发现 | 3（F-1 / F-2 / F-3） |
| P3 发现 | 3（F-4 / F-5 / F-6） |
| **Gate 1** | **PASS —— 无未处理的 P0/P1 架构问题，允许进入后续实施阶段** |
| 是否生成 v0.2.1 | **否，保留 v0.2 原文**。评审未发现「重大事实错误或架构问题」；P2/P3 属执行层风险与表达优化，修订建议并入未来 v0.3（见 §4），不为体现工作量而改 SPEC |

## 1. Reviewer A —— 架构合理性（推翻尝试与结果）

### 尝试 A-1：推翻「PD-Lab 定位 = 治理/关联层，不是新平台」
核验：PRI-1244 报告五项发现逐条对照源码（`experiment-manifest.mjs` 的
`MANIFEST_SCHEMA:17`、`lab-payload.mjs:15-24` 七模块、五套 Evaluator 零共享 import）。
结果：**推翻失败**。仓库现状确实不支持「另建统一平台」的正当性，v0.2 的复用优先判断
与源码证据一致。

### 尝试 A-2：推翻「Pipeline Evolution 适合作为核心管道 Benchmark 首要基础」
核验：`docs/pipeline-evolution/` 15 文件、S001–S006 场景文件、6 份 episode/round 报告、
`scripts/dev/pipeline-evolution/`（manifest/evidence/init/collect 四文件 + 602 行测试）、
`scripts/dev/pipeline-closure-lab/` 6 个确定性夹具全部在位。结果：**推翻失败**——资产真实存在。
但注意：**没有任何场景处于 `validated` 或 `behavioral-verified` 状态**
（`git grep behavioral-verified origin/main` 全树仅 README.md:83 的阶段定义一处命中），
三个 episode 的 Activation/Behavior 全部 `NOT_REACHED`。v0.2 §4.2 已如实声明这一点
（「不能声称它已经证明所有核心管道行为都能被完整、稳定、自动化地评价」），因此不构成对
v0.2 的反驳，但构成对其读者的持续提醒（详见 Stage 5 审计报告）。

### 尝试 A-3：推翻「现有 Manifest 能承担最小关联职责」
核验：`experiment-manifest.v1` 必填字段仅 `experimentId/scenarioId/host/startedAt/pdCommit`
（`experiment-manifest.mjs:19,58-60`），模板含 model/featureFlags/fixtureHash/painIds/
behaviorObservation 等。它表达不了 #2653 的 Arm/Blindpack/盲评矩阵，v0.2 §7.2 明确
「不扩展成巨型 Manifest」。结果：**推翻失败**——v0.2 的判断准确：manifest 适合
Pipeline Evolution/PLE，不适合强行承载 #2653；跨域关联靠索引引用而非扩 schema。

### 尝试 A-4：遗漏已有研究模块？
核验：对照 v0.2 §4.1 资产表与目录实查——PLE、PRR、Challenge/Examiner、Closure Lab、
Adaptive Selector Lab、`docs/experiments/`（behavior signature）均已列入。补充发现：
`docs/experiments/pri-836/` 是唯一在册的行为观察实验（激活后 Owner 纠正 1→0→0，
归因不可得），v0.2 未单列它。结果：**部分成立但不构成架构缺陷**——pri-836 属
Longitudinal（v0.2 §13 Stage 7）范畴，v0.2 的处理（不视为已运行 Benchmark）正确。

## 2. Reviewer B —— 实验方法学（推翻尝试与结果）

### 尝试 B-1：推翻「#2653 配对 A/B 可复核」
实际执行 20 项只读核验（脚本与逐项结果见
`PROMPT_V2_HISTORICAL_ARTIFACT_AUDIT.md` §3，本仓 `.tmp/pd-lab-v02/verify-results.json` 留档）：
全保真数据集文件 SHA、16/16 样本 inputDigest 重算、两个快照 DB SHA、V1/V2 各 19 个
prompt 变体 SHA+chars、grid-2 v1 head=v1BaseCommit、4/4 shard run-manifest 钉定
datasetSha256、109 盲评包/109 评价文件/109 blindmap 条目、pairwise 65:27:17（decided 92）、
records 52=32+20、grid-1 无效批 52/52 incomplete 保留。结果：**推翻失败，20/20 PASS**。

### 尝试 B-2：评价器是否独立？
**不独立（已披露）**：评估器与生成器同为 glm-5.3 家族（独立会话、盲化、顺序随机化）。
v0.2 §4.5 如实记录；`AB_EXPERIMENT_ACCEPTANCE_REPORT.md` §7.4 披露了免费档评估器
~40% 失败率导致的选择性偏差理由，并建议 Owner 抽查 ≥20% 盲评包。这是真实的
方法学限制，v0.2 未淡化它——**驳回以此为由推翻 SPEC 的尝试，同时确认该限制必须
随历史实验进入 PD-Lab 索引**（Stage 4 已执行）。

### 尝试 B-3：样本泄漏与过度推断？
配对设计：同一 16 条真实 Pain 同时跑两臂（`digestSource` 逐样本钉定）；盲评包
arm 盲化 + 顺序随机化（blindmap）；`missing`（47 个缺失 stage-artifact 槽位）被
结构化登记而非静默丢弃（`blindmap.json: missing[]` 带 `reason: stage-artifacts-missing`）。
+2.64 < +5 门槛、n=16 不声称统计显著性、Dreamer −1.25 如实报告。结果：**推翻失败**
——v0.2/报告的诚实度经得起检查。唯一表达问题见 F-5。

### 尝试 B-4：能否区分「Pipeline 未到达」与「Actor 行为失败」？
v0.2 §12.2/§16 的铁律（Pipeline Reachability ≠ Actor Outcome；无 Activation 不得宣称
行为改善）与三个 episode 的实际判定一致（EP001 `PARTIAL_EPISODE`/INCONCLUSIVE、
R2/R3 `NOT_REACHED`，approvals/activations 恒 0）。结果：**推翻失败**。

### 尝试 B-5：能否支持长期行为改善结论？
**不能，v0.2 也没说能**：Longitudinal 被放在 Stage 7（未来），且在册唯一行为观察
实验（pri-836）自己写着「变化归因于该原则本身不可得」。一致。

## 3. Reviewer C/D/E —— 数据治理、工程实现、发布安全

### Reviewer C（数据治理与安全）
- 真实 Pain 授权：数据集来自 Owner 自己的生产快照（`D:/.openclaw/workspace/.pd/state.db` /
  `trajectory.db`，snapshot-report.json 记录 integrityCheck ok）；公开副本字段级脱敏 +
  canary 正控 + 全库扫描（`PUBLIC_DATA_REDACTION_AUDIT.md`：81 文件 vs 1,508 原文 0 泄漏）。
- **F-1（P2）：全保真冻结数据唯一副本的存储位置与其自身原则冲突。** v0.2 §6.3 明文
  「Gitignored `.tmp` 不是长期安全数据仓库」，但当前唯一冻结快照（state.db 67,334,144 B /
  trajectory.db 43,515,904 B，时点语义不可再生为同一批次）与 `pain-dataset.full.json`
  存放于 worktree 池 `…/adhoc-20261115-prompt-v2-k4wz9t/.tmp/`。该池有 2026-11-08 外部
  `robocopy /MIR` 清空事件前科，且 git-8 的任务 worktree 清理规则会连带删除 `.tmp`。
  v0.2 §11/§19 披露了「保存在本地 .tmp」的事实，但未把「唯一性 + 常规工具链可删除」
  列为显式风险。影响：一次例行清理即可永久消灭冻结批次与全保真数据集。修复建议（最小）：
  ① 本报告披露风险；② Owner 决策是否将冻结快照+full JSON 归档至仓外受控存储或
  `artifacts/`（git-16 本地管理目录）；③ v0.3 把该风险写进 §11.1。
- 历史泄漏：v0.2 §11.1 与 redaction audit §5 一致（早期未脱敏 blob 已入公开历史，
  处置为 Owner 决策，Agent 不 force-push）。一致。
- 数据撤回：v0.2 §6.3/§11.3 有要求，现状无机制（TARGET）。如实。

### Reviewer D（工程实现与可维护性）
- **F-2（P2）：v2 臂代码 head 双值缺显式和解说明。** 指纹采集 head `be7167dd9`
  （`prompt-hashes-v2.json`）与运行 head `520edea85`（`grid-manifest.json` / run-manifest）
  不同。内容锚定实际由「19 变体 SHA 指纹 + preflight 运行时重算比对」承担（manifest
  notes 明言），本评审已核验 19/19 提交文件 SHA 逐字匹配，提示词身份成立；
  `520edea85` 提交信息为 harness 修复（formation-artifact join via candidate uuid、
  admission-refused 合法终态、diagnoseOk 接受 CLI partial-exit）。影响：严格复现 v2 臂
  代码时需要额外一步核对两个 head 的 delta。修复建议：历史索引（Stage 4）记录双 head
  与指纹锚定关系，并给出 delta 范围说明。
- **F-3（P2）：Stage 2「引用索引」无约定落点。** v0.2 §13 Stage 2 交付要求引用索引但未
  规定文件位置/命名/最小字段，实施者可能自创目录体系。本次执行已按最小改动落地为
  `experiment/prompt-v2/reports/PD_LAB_HISTORICAL_EXPERIMENT_INDEX.md`（复用现有目录，
  纯 Markdown 引用，零新代码）。修复建议：v0.3 固化该落点与最小字段约定。
- 不需要新建公共 Schema：两种实验类型的关联所需字段（见 Stage 6）均可用现有
  Manifest/报告/索引表达。一致。

### Reviewer E（生产与发布安全）
- **F-4（P3）见 §5**；**F-5/F-6 见 §5**。
- 内部 PD-Lab 与产品化 Examiner 隔离：`LAB_ENTRY_MODULES` 七模块逐字核实一致
  （Stage 0 报告 §6），closure 测试在位；本次全部交付物为 docs/markdown，不在任何
  npm/Docker/插件闭包内。
- Promotion 阻断路径：v0.2 §9.5 与 AGENTS.md §23（AI 不合并、Owner 终裁）一致；
  `PASS_WITH_LIMITATIONS` ≠ `PROMOTE` 在 §9.4 明文。无绕过路径发现。

## 4. 发现汇总表

| Finding ID | Severity | 问题 | 源码证据 | 影响 | 修复建议 | 是否阻塞 |
|---|---|---|---|---|---|---|
| F-1 | P2 | 全保真冻结数据唯一副本位于 worktree 池 gitignored `.tmp`，与 v0.2 §6.3 自身原则冲突；池有清除事件前科，git-8 清理会删除 | `…/adhoc-20261115-prompt-v2-k4wz9t/.tmp/prompt-v2-inventory/`（108 MB，含冻结快照 DB）；Stage 0 报告 §7 | 一次例行清理即永久丢失冻结批次 | Owner 决策归档至受控存储/`artifacts/`；v0.3 写入 §11.1 显式风险 | NO |
| F-2 | P2 | v2 臂指纹 head `be7167dd9` 与运行 head `520edea85` 双值无和解说明 | `experiment/prompt-v2/prompts/prompt-hashes-v2.json` vs `grid-manifest.json`（本地 `.tmp`） | 严格复现需额外核对 delta | 历史索引记录双 head + 指纹锚定关系（Stage 4 已执行） | NO |
| F-3 | P2 | Stage 2「引用索引」无约定落点/命名/最小字段 | SPEC §13 Stage 2 | 实施者可能自创目录体系 | 固化 `experiment/prompt-v2/reports/PD_LAB_HISTORICAL_EXPERIMENT_INDEX.md` 为约定（本次落地） | NO |
| F-4 | P3 | SPEC 记录基线 `592f50b4a` 已过时（现 `23f2c17fd`，零 Lab 路径变化） | Stage 0 报告 §2 | 文档时效 | v0.3 刷新基线行 | NO |
| F-5 | P3 | `missing=47`（缺失 stage-artifact 槽位）易被误读为「47 包未评」；实际 109/109 包全部有评价 | `blindmap.json.missing[]`；验收报告 §4 | 术语歧义 | v0.3 术语表区分 packages/evals/missing slots | NO |
| F-6 | P3 | §10.3 发布闭包验收对 docs-only 阶段如何豁免无说明 | 本次执行全为 docs | 每次文档变更被误读为需跑发布闭包检查 | v0.3 注明 docs-only 变更豁免条件 | NO |

## 5. 按严重级的判定

- **P0（生产数据/安全/权限边界失效）：无。** 发布白名单、生产 DB 只读、Promotion 分离均核实完好。
- **P1（核心架构或实验结论不成立）：无。** v0.2 的六项关键修正（§1.3）全部经受住源码与产物核验。
- **P2/P3：6 项，全部不阻塞**，修复建议已纳入本次交付（F-2/F-3 已在 Stage 4 执行）或 v0.3 建议。

## 6. Gate 1 决定

**PASS。** SPEC v0.2 保留原文、不生成 v0.2.1（§3.3 标准：无重大事实错误或架构问题）。
独立评审报告本身与六项发现随本次 PR 交付 Owner；F-1 的存储归档属 Owner 决策项
（`BLOCKED_OWNER_AUTHORIZATION`），不阻塞后续阶段。
