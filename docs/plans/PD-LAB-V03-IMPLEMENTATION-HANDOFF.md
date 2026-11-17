# PD-Lab v0.3 实施交接与验收工作包

状态：DRAFT，尚未实施。源码核验提交：`4388fe6d1`（PR #2685 分支最终内容，已随 #2685 squash 合并为 main `4b9d07c8d`，四份 v0.3 文档在两处字节一致；2026-11-17 两轮复核，对照合并前后 main 无源码漂移）。本文件让后续 AI 按固定顺序实现 [SPEC](../specs/SPEC-PD-LAB-EXPERIMENT-INTEGRATION-001-v0.3.md)。它不授权真实模型调用、生产数据访问、生产写入或发布；需要这些的步骤都标了所需的 Owner 决策。

## 1. 开始任何任务前

1. 读 SPEC §2 与当前任务对应的 R 阶段、[TECH](../specs/TECH-PD-LAB-EXPERIMENT-INTEGRATION-001-v0.3.md) §1–3，以及本任务列出的其他章节。涉及数据或分数时读 [CONTRACT](../specs/CONTRACT-PD-LAB-DATA-AND-SCORING-001-v0.3.md) 对应章节。
2. 对本任务引用的每个文件和导出，在当前 `origin/main` 上确认仍然存在、行为与 TECH §2 一致。逐项记录“仍成立 / 已漂移 / 未知”。有漂移就先停下报告，不要按旧描述实现。
3. 按 AGENTS.md §23A 创建并认领自己的 worktree：`npm run dev:worktree -- <PRI-id|adhoc> <slug>`，再 `npm run dev:worktree:claim -- --writer <writer>`。不在主检出里写代码。
4. 运行 `npm run error:context -- --paths <本任务要改的文件，逗号分隔> --signals <概念，逗号分隔>`，把 HIGH 命中的 Must check 写进验证计划。
5. Linear 工作先按 AGENTS.md §21 读工单和最新评论。
6. 只做一个任务。范围外的发现记为后续项，不顺手实现。

所有任务共同的禁止事项：

- 不修改 `~/.pd/runtime/`、`~/.openclaw/extensions/principles-disciple/`、任何 `<workspace>/.pd/`（AGENTS.md §1.1）。
- 不把全保真数据、真实路径的配置、运行产物、`.tmp/` 或 `artifacts/` 加入提交。
- 不调用外部模型，除非任务明确写了“需要 D2”且 D2 已批准。
- 不修改 `ab-eval.mjs` 面向**历史批次**的评审提示词和输出格式；新 Judge Protocol 按版本化路径新增，不追溯修改历史记录、报告和哈希。
- 不从产品包或 `scripts/build/lab-payload.mjs` 的闭包导入 `scripts/dev/pd-lab/` 或 `experiment/`。

## 2. 需要 Owner 先做的决策

AI 不得替 Owner 填这些值。缺少某项时，只做不依赖它的任务。

| ID | 决策 | 阻塞的任务 |
| --- | --- | --- |
| D1 | 晋级门 v0 的 L0–L3 是否生效；生效后 PR 描述是否加“变更等级 / 实验链接 / 晋级决策状态”三行 | 不阻塞实现；决定 T6 决策卡是否作为发布前置 |
| D2 | T6 及 T7a 实际裁判调用的模型/provider、调用许可与总预算；α（默认建议双侧 0.05）、重复次数、硬护栏；确认性分析的 `minimumIndependentSourceGroups`、区间方法/置信水平和精度目标；是否允许外部模型调用 | T7a 的真实裁判模型校准、T6 的真实运行；也决定是否允许仅作探索性的 T6 |
| D3 | 快照节奏（建议不超过 30 天一次，且每次正式实验前一次）、执行人、快照存放位置 | T1 的真实快照执行 |
| D4 | 试点使用的 INTENT 文档内容，以及能否用于实验工作区 | T6 的 `on` 臂 |
| D5 | Owner 盲评校准的样本对数（建议 30–50 对）、Owner 复核投入与一致率/位置偏差通过门槛 | T7a 的人工盲评校准；**不授权任何模型调用** |
| D6 | 全保真数据授权及使用边界：允许使用的样本范围（16 条已冻结样本及其快照/Blob）、存储位置、可访问机器、保留期限、是否允许 §5.4 的最小化历史证据投影、撤回流程 | T1 的真实快照执行、T7a 对真实快照的探测、T6 的全部真实运行 |

## 3. 任务依赖

```text
T0 现实映射（R0）──────────────────────────────────┐
T1 快照工具（R0；真实快照执行需 D3+D6）─────────────┤
T2 harness 测试入 CI（R1）──→ T3 配置解耦与两臂身份（R1）──→ T5 机械烟测（R1）──┐
T4 离线计分与判定（R1）───────────────────────────────────────────────────────┤
                                                                               ↓
                              T7a 准入/来源分组/裁判校准（R2；真实快照需 T1+D6，实时裁判模型校准需 D2，Owner 盲评需 D5）
                                                                               ↓
                              T6 Intent 开关试点（R3；门禁见任务卡）
                                                                               ↓
                              T7b 数据扩充（R4 起）──→ T8 行为切片（R5）──→ T9 迁移与 Benchmark（R6）──→ T10 纵向（R7）
```

T0、T1（工具部分）、T2、T4 互不依赖，可以并行。T3 必须在 T2 之后，否则重构没有回归保护。T5 依赖 T3+T4。**T7a 是 T6 的前置：样本准入和必要的裁判校准未完成前，T6 不得运行。** T7b 在 T6 之后启动并长期运行。

## 4. 工作包

每个任务卡包含八个字段：文件、输入/输出、依赖、测试入口、成功条件、失败条件、回滚、Owner 授权。“验收”全部满足才算完成；“停止条件”任一出现即停止并报告，不绕过。

### T0：现实映射与术语（R0）

- **文件**：`docs/reports/PD_LAB_V03_T0_REALITY_MAP.md`（新增）、`docs/architecture/GLOSSARY.md`（Pain Signal 条目）。
- **输入/输出**：输入为 TECH §2.2 的三个未核验项；输出为只读审计报告 + 术语同步。不改任何代码或数据。
- **依赖**：无。
- **内容**：
  1. 实验工作区里运行 `pd diagnose run`、`pd runtime internalization run-once` 时，轨迹保留清扫会不会执行。从 `packages/pd-cli/src/commands/` 的这两个命令出发，追到 `packages/principles-core/src/runtime/trajectory-retention.ts`，给出调用链和结论。会执行的话，写出在派生配置里关闭它的配置键（见 `resolveTrajectoryRetentionPolicy`）。
  2. Codex、WorkBuddy 采集路径中工具返回和长轮次的存储方式与上限，对照 `after-tool-call-helpers.ts` 的 500 字符和 `trajectory.ts` 的 16KB 外置。
  3. OpenClaw 宿主原生会话文件的位置和保留方式，能否按 `session_id` 关联回 `pain_events`。
- **测试入口**：`npm run check:docs-structure`。
- **成功条件**：三项各有源码文件与行号；GLOSSARY 修改与 SPEC §2.1 一致；结构检查通过。
- **失败条件**：结论依赖于只能在生产机器上观察的行为时，写成“需在生产机器核实”，不猜。
- **回滚**：revert 两个文档文件。
- **Owner 授权**：不需要。

### T1：含 Blob 的只读快照工具（R0）

- **文件**：`experiment/prompt-v2/scripts/snapshot-and-discover.mjs`（修改）、`scripts/__tests__/pd-lab-snapshot.test.ts`（新增）。
- **输入/输出**：输入为 `--source-workspace <dir>`（必填，替代写死的 `D:/.openclaw/workspace/...`）与 `--out <dir>`（必填，不传退出码 2）；输出为 TECH §5.1 定义的快照（两个库 + 被引用 Blob + `blob-manifest.json` + README 索引）。状态库和轨迹库路径用 `storage-paths.ts` 的解析规则得出，不手拼。
- **依赖**：无（工具本身）；**真实生产快照执行需 D3 + D6**。
- **测试入口**：`npm run test:scripts -- pd-lab-snapshot`。
- **成功条件**：测试通过——在临时目录用真实 schema 建一个小工作区（含一条带 `blob_ref` 的轮次和对应 blob 文件），以子进程运行脚本，断言：两个库都被备份且 `integrity_check` 为 ok；被引用 blob 被复制、未被引用的 orphan 未复制、逐文件哈希与 Manifest 一致；跨源一致性字段（快照窗口起止、两库最新行时间戳）被记录；源目录所有文件的 mtime 和哈希在运行前后不变；缺 `--source-workspace` 或 `--out` 时退出码为 2。
- **失败条件**：源库 `integrity_check` 不为 ok；blob 引用数与复制数对不上且无法解释。
- **回滚**：revert 脚本与测试；已产生的快照保留（只读副本，删除需 Owner）。
- **Owner 授权**：首次真实执行需 D3（节奏/执行人）+ D6（数据范围），输出到 `artifacts/pd-lab/snapshots/<YYYY-MM-DD>/` 并确认 `git check-ignore -v artifacts/` 命中 `/artifacts/`。

### T2：harness 测试入 CI（R1）

- **文件**：`scripts/vitest.config.ts`（include 追加）、`scripts/__tests__/pd-lab-harness-characterization.test.ts`（新增）。
- **输入/输出**：输入为现有三个测试（`pdspec001-ab-metrics`、`pdspec001-atomic-file`、`pdspec001-blindpack`）；输出为它们在 CI 中真实执行。
- **依赖**：无。
- **步骤**：
  1. 在干净 worktree 里运行 `npx vitest run experiment/prompt-v2/scripts/__tests__/`，记录结果。若有失败，先停下报告失败原因，不要为了通过而改测试。
  2. 全部通过后，在 `scripts/vitest.config.ts` 的 `include` 中加 `'../experiment/prompt-v2/scripts/__tests__/**/*.test.ts'`。
  3. 新增特征测试固定 T3 必须保持不变的行为：`childEnv()` 删除五个指针变量；`armOrderFor(runId, i, arms)` 对固定输入的输出。`deriveExperimentConfig` 的特征测试放到 T3 第 2 步：先用改动前的代码对同一份输入生成预期输出，再重构。
- **测试入口**：`npm run test:scripts`。
- **成功条件**：本地 `npm run test:scripts` 通过且运行列表包含三个原有测试文件和新特征测试；**CI 的 vitest 任务日志中能看到这三个测试文件被采集执行**（以 CI run 的测试清单为证，不以文件存在为证）。
- **失败条件**：原有测试在干净检出上失败；CI 不采集该目录。
- **回滚**：回退 include 与新测试文件。
- **Owner 授权**：不需要。

### T3：harness 配置解耦与两臂身份（R1）

- **文件**：`scripts/dev/pd-lab/experiment-config.mjs`（新增，只导出 `loadExperimentConfig(file)`）、`scripts/dev/pd-lab/experiment-config.example.json`（新增）、`experiment/prompt-v2/scripts/ab/ab-lib.mjs`（修改）、同目录入口 `ab-run.mjs`、`ab-grid.mjs`、`ab-stage.mjs`、`ab-preflight.mjs`、`ab-preflight-v21.mjs`、`ab-metrics.mjs`、`ab-blindpack.mjs`、`ab-blindpack-paired.mjs`、`ab-dreamer-paired.mjs`、`ab-eval.mjs`、`ab-blind-summary.mjs`、`ab-diversity-eval.mjs`（均修改：必填 `--config`、角色映射）、`experiment/prompt-v2/scripts/analysis/*.mjs`（修改）、根 `package.json`（`lab:*` 脚本）、`experiment/prompt-v2/configs/prompt-v2-round1.json` / `dreamer-v21-round2.json`（新增，历史取值）、`scripts/__tests__/pd-lab-experiment-config.test.ts`（新增）。
- **输入/输出**：输入为 TECH §4 的配置格式；输出为不再含写死路径/臂名的 harness 与角色显式的两臂身份。
- **依赖**：T2（先有回归保护）。
- **内容**：
  1. `loadExperimentConfig` 按 TECH §4.1/§4.4/§4.5 实现：格式、禁止根派生、路径安全（最近现存祖先解析、junction、runId 穿越校验）、`baselineArm`/`candidateArm` 校验、未注册 feature flag 拒绝；新实验必须验证 `preregistration.file` / `preregistration.sha256` 与 front matter `experimentId` 绑定，历史配置仅接受 TECH §4.1 定义的闭集 `legacy.batch`。
  2. `ab-lib.mjs`：删除六个常量导出，改为 `useExperimentConfig(config)`；`deriveExperimentConfig(wsPath, arm)` 改为**结构化 YAML 派生**（TECH §4.3：js-yaml 解析、只动声明段、未声明语义逐键等价）；`materializeWorkspace` 按 `workspaceFiles` 复制文件（sha256 校验、target 不得逃逸、中间目录无符号链接）；`preflightIsolation()` 改用配置派生禁止根。
  3. 各入口增加必填 `--config`；臂名从配置 `arms` 取；**删除 `ab-metrics.mjs` 的 `index.v1`/`index.v2`、`ab-blindpack*.mjs` 的 `armA='v1'` 默认值和全部 `(v1|v2)`/`(v2c|v21)` 正则**，配对与盲评一律按 `baselineArm`/`candidateArm` 角色映射（TECH §4.4 的消费清单）；`ab-grid.mjs` 的 `--arms` 去掉默认值；`ab-run.mjs` 的 run-manifest 改记 TECH §7 字段（含配置与预注册 SHA-256）；批次特有 preflight 检查只由 `legacy.batch` 的两个已登记值显式启用。
  4. **ingress 运行契约**（TECH §7）：`--score` 取 `painEvent.score`；`--reason` 截到 500 并记录截断；session 绑定失败记 `ingress_binding_failed` 终态、不再自动降级 unbound；`--host` 按样本 `host_kind` 决定，空值不伪装 OpenClaw；记录 `ingressMode` 与输入 digest；臂顺序用全局样本索引 + 冻结种子；为合法无候选/defer 增加独立终态；`loadDataset` 脱敏检查扩到全部样本。
  5. 历史配置文件头 `_note` 写明“历史批次取值，不是默认值”；`_note` 仅接受字符串且不影响执行语义。`legacy` 仅接受 `{ batch: "prompt-v2-round1" | "dreamer-v21-round2" }`，拒绝任意附加字段；不得把它用于新实验。新实验必须绑定预注册文件及摘要且不得声明 `legacy`；历史回放必须声明 `legacy.batch` 且省略 `preregistration`，不得补造预注册。
- **测试入口**：`npm run test:scripts`（CF-01 至 CF-16）。
- **成功条件**：`rg -n "D:/|C:/" experiment/prompt-v2/scripts/ab experiment/prompt-v2/scripts/analysis` 无结果；`npm run check:workspace-tools`、`npm run test:scripts` 通过；删除 `baselineArm`/`candidateArm` 的负向测试失败如预期；用两份历史配置运行 `lab:preflight`，在没有那些路径的机器上逐项指出缺失路径而非抛未捕获异常；CF-07 验证两臂派生配置只在声明键上不同；CF-13 至 CF-16 证明 `_note`/`legacy` 闭集校验、预注册摘要与 `experimentId` 绑定，以及 `lab:run` 的二次 preflight 均按 TECH §4.1/§7 fail-closed，合法历史配置明确记录 `NOT_APPLICABLE_LEGACY`。
- **失败条件**：某入口的行为无法在不改变记录文件格式的前提下参数化；特征测试需要改预期才能通过。
- **回滚**：revert 全部改动；不删除已产生的运行。
- **Owner 授权**：不需要（不触碰真实数据）。

### T4：离线计分与判定（R1）

- **文件**：`scripts/dev/pd-lab/alignment-report.mjs`（新增，导出 `mergeJudgments`、`buildAlignmentReport`）、`scripts/dev/pd-lab/build-decision-input.mjs`（新增 CLI）、`scripts/__tests__/pd-lab-alignment-report.test.ts`（新增）。
- **输入/输出**：输入为计划 + 评审记录 + 仲裁记录 + `source-groups.json`；输出为 CONTRACT §5.2/§6.2/§6.5 的 `FinalComparison[]` 与 `decision-input.json`。纯函数：不读文件、不读环境变量、不取当前时间。
- **依赖**：无（与 T3 并行；仅最终接线 `lab:card` 需要 T3 的入口脚本存在）。
- **测试入口**：`npm run test:scripts`。
- **成功条件**：
  - CONTRACT §7 的 SC-01 至 SC-19 每条一用例，断言 `pointEstimate`、`missingBounds`、`status`、`decision` 全部字段（SC-14 必须证明单侧旧阈值 11 被拒绝）。
  - CONTRACT §6.5 的性质验证清单（W/L 不重复计数、UNKNOWN 中立、TIE 不冒充 UNKNOWN、缺失保留分母、组等权、重复不增样本、边界可复算、`unknownsCouldChangeVerdict` 双向枚举）各有测试。
  - 双侧 `k(n, 0.05)` 对 CONTRACT §6.5 表中每个 n 的值逐一断言，并证明 `n=1..5` 不存在 `k≤n` 的可拒绝阈值。
  - `build-decision-input.mjs` 以子进程运行在合成目录上：计划内缺一条评审时输出 UNKNOWN 而不是少一个单元；`blindmap.json` 缺映射时退出非零。
  - `alignment-report.mjs` 中没有 `fs`、`process.env`、`Date` 的引用。
- **失败条件**：CONTRACT 手算例之间自相矛盾（报告具体条目，由 Owner 裁定，不自行挑一个）。
- **回滚**：revert 新文件（无生产消费者）。
- **Owner 授权**：不需要。

### T5：机械烟测（R1）

- **文件**：`scripts/__tests__/pd-lab-smoke.test.ts`（新增）。
- **输入/输出**：输入为临时目录构造的两个臂身份（允许指向同一 worktree）、2 样本合成全保真数据集（不含真实内容）、合成快照（含合成 Blob Manifest）、带 YAML front matter `experimentId` 的合成预注册文件及其 SHA-256、最小 `config.yaml`（`modelEnv` 仅指向测试 sentinel，不使用真实 provider 凭据）；输出为 `lab:preflight` → `lab:run` → `lab:metrics` → `lab:blindpack` → 合成 Judge Protocol 评审记录 → `lab:summary` → `lab:card` 的全链路产物。不得调用真实 `lab:eval` 模型裁判。
- **依赖**：T3、T4。
- **测试入口**：`npm run test:scripts`（CI 或任意 Linux 机器）。
- **`lab:run` 的隔离方式**：必须以子进程调用真实 `lab:run` 入口及实际 harness 编排（`ab-grid`/`ab-run`），但把临时 arm worktree（两臂可以指向同一 worktree）的 `packages/pd-cli/dist/index.js` 指向确定性的 fixture CLI。fixture 只实现 harness 使用的子进程参数/JSON 契约，并只写入合成工作区状态；不得加载真实生产数据库、读取真实数据、调用真实模型/provider 或访问网络。所需的 TypeBox schema 模块必须使用同一源码版本构建的真实产物；不得手写替代 schema。若 fixture CLI 无法通过真实 schema 校验，先补齐测试构建依赖，不得降低 schema 或伪造验证通过。不得为此新增生产 `--dry-run` 开关或通用执行抽象。
- **成功条件**：`lab:preflight` 通过；`lab:run` 确实被调用并产生每样本/每臂运行记录、run-manifest 和预期终态；断言命令参数、全局样本索引下的臂顺序、配置与预注册 digest、attempt 保留及已完成单元恢复时不重跑（RF-05）；在 `lab:preflight` 后、`lab:run` 前修改预注册文件但不更新固定 SHA-256，或使配置失效，`lab:run` 的二次 preflight 必须在创建 run 记录/启动 fixture CLI 前拒绝（CF-16）；`decision-input.json` 的 `plannedGroups` 等于合成来源组数；把一个臂的 `expectedHead` 改错后 preflight 失败（RF-02、CF-04）；快照 Blob 哈希或预注册 SHA-256 改错后 preflight 失败；合成裁判记录可以完成离线汇总和决策卡生成。
- **边界**：此烟测证明 Lab harness 的命令/记录/恢复/离线分析接线，不证明真实 PD runtime 的行为正确；真实 CLI、宿主、模型集成仍由获授权的后续试点验证。`lab:eval` 不在本烟测执行，避免模型调用。
- **失败条件**：只跑到 preflight 而没有实际调用 `lab:run`；fixture 逃逸到真实数据/网络/provider；或必须增加生产运行模式才能构造合成执行——出现时停止并报告，不得把部分烟测标成全链路通过。
- **回滚**：revert 测试文件。
- **Owner 授权**：不需要。

### T7a：准入、来源分组与裁判校准（R2，T6 的前置）

- **文件**：`scripts/dev/pd-lab/admission-probe.mjs`（新增 + `npm run lab:probe`）、`docs/reports/PD_LAB_V03_ADMISSION_PROBE.md`（新增，只含计数和问题代码）、数据集发布目录下的 `source-groups.json`（新增）、校准报告（新增）。
- **输入/输出**：输入为 T1 的快照与已冻结数据集；输出为按路径的准入结果、完整来源组映射、裁判校准证据，以及 `BLOCKED / EXPLORATORY_ONLY / CONFIRMATORY_READY` 三态资格结论。
- **依赖**：T0（宿主事实）、T1（快照工具；对真实快照运行需 D6）、T3（配置驱动）、T5（链路已烟测）；**实时裁判模型调用需 D2，Owner 盲评需 D5**。合成协议校验不需要 D2/D5。
- **内容**：
  1. **准入探测**：按 TECH §5.2 实现，覆盖表内全部检查（含 `SOURCE_GAP` 与 `SOURCE_RETENTION_EXPIRED` 的区分规则、`DIGEST_MISMATCH`、`EXPECTATION_UNRESOLVED`、`AUTHORIZATION_UNVERIFIED`）。对 T1 快照运行一次，结果写入探测报告。
  2. **来源分组**：为已冻结数据集生成 `source-groups.json`（CONTRACT §3）：`caseId = experimentPainId`，同一 `session_id` 机械同组，跨会话合并逐条写人工依据；16 条样本按会话分组，最多 14 个独立来源组，不得按 16 条 Pain 计数。
  3. **裁判校准分层执行**：
     - Judge Protocol 的 schema、四值解析、UNKNOWN 原因、输入 digest、盲包泄漏和位置交换逻辑先用合成 fixture 做确定性测试；不调用模型。
     - 真实裁判模型对盲评包进行判断属于模型调用，必须先取得 D2 对具体模型/provider、许可和预算的批准；没有 D2 时不得发起调用，报告标记 `judgeModelCalibration=NOT_RUN`，不能声称已校准。
     - Owner 盲评样本量、投入时间和一致率/位置偏差通过门槛由 D5 批准。D5 只授权 Owner 人工评审，不替代 D2 的模型调用许可。
     - 在 D2、D5 均具备后，用 `owner-spotcheck-list.mjs` 抽样；报告 Owner 与裁判一致率、位置偏差（同一包交换顺序再评一次的翻转率）、分歧类型、模型/provider/version、实际调用数和失败 attempt。协议使用 CONTRACT §5.1 的 `A_BETTER / B_BETTER / TIE / UNKNOWN`。
  4. **资格分级**：按 T6 预注册所需路径统计 READY 的独立来源组数 `n`，不是 Pain 条数、重复次数或评审票数；计划冻结后不得因结果缺失缩减分母。
     - `BLOCKED`：授权或完整性不合格，T6 所需路径没有 READY 来源组（`n=0`），或 D2/D5 未批准、实时裁判校准未运行/失败。此时不得启动 T6；只可继续不依赖这些授权的合成测试、机械探测和数据补齐。
     - `EXPLORATORY_ONLY`：实时裁判校准已通过且授权齐备，但 `n` 小于当前预注册 α 下首次可达到双侧显著阈值的最小组数，或 `n` 未达到 D2 预注册的 `minimumIndependentSourceGroups` / 精度目标。默认 α=0.05 时，`1 ≤ n ≤ 5` 属于此类。只有 D2 明确批准、预注册明确标为探索性且禁止晋级结论时，才可开展探索性 T6。
     - `CONFIRMATORY_READY`：T6 所需数据路径与授权通过、实时裁判校准通过、D2/D5 已批准，且 `n ≥ max(n_min(alpha), minimumIndependentSourceGroups)` 并满足预注册精度目标；`n_min(alpha)` 是由 CONTRACT §6.5 的双侧检验公式计算出的首次可达组数，默认 α=0.05 时为 6。报告必须给出精确 `k(n, α)`；当 α=0.05 时，6–8 组需全部确定胜/负，9–11 组阈值按 CONTRACT §6.5 计算，不能笼统说 6–11 组都需全胜。当前 16 条样本最多 14 个来源组，14 组需 12 组确定胜。
  5. 未达到确认性门槛时，后续对齐结果只能标为“探索性/试验”，不得进入晋级决策；不得把 `n ≥ 6` 本身当作功效或精度已足够。
- **测试入口**：`npm run test:scripts`；探测触发用例覆盖 DT-02、DT-03 与 TECH §5.2 表中每个问题代码各一条；资格分级为默认 α=0.05 下 `n=0/1/5/6/8/9/11/12/14` 及裁判未校准/校准失败分别提供边界测试；非默认 α 用公式计算 `n_min(alpha)` 并测试边界。
- **成功条件**：探测报告给出每条路径（CONTRACT §2.4）的 READY 数和独立来源组数；`source-groups.json` 覆盖全部样本且机械规则可复算；报告分别标记合成协议校验、实时裁判校准、Owner 盲评状态；三态资格结论可由 READY 组数、D2/D5 批准和预注册精度参数机械复算。
- **失败条件**：T6 所需路径 `n=0` 时为 BLOCKED；`n<n_min(alpha)` 或裁判/精度门槛未达时不得进入确认性 T6（默认 α=0.05 时即 `n<6`）；任何无 D2 的实时模型调用或无 D5 的 Owner 盲评均视为越权并立即停止。
- **回滚**：探测与分组是只读派生物，revert 工具与报告即可。
- **Owner 授权**：对真实快照运行需 D6；实时裁判模型校准需 D2；Owner 盲评需 D5（投入建议 2–4 小时，SPEC §14）。

### T6：Intent ON/OFF 试点（R3）

- **文件**：`experiment/intent-engineering-onoff/PREREGISTRATION.md`、`DECISION_CARD.md`（新增）；运行记录在 `experimentRoot`。
- **输入/输出**：输入为两臂配置（`off`/`on`，同一 worktree）与 T7a 的准入结果；输出为判定与决策卡。
- **依赖（全部满足才可启动，缺一即阻塞）**：
  1. PR #2684 **已合并到 main**，且试点 worktree HEAD 包含其提交；
  2. 生产入口 Reader 已核实（SPEC §11.1 第 2 条的运行时证据）；
  3. `intent_engineering` 开关在 main 的 feature-flag 权威中注册且默认值核实；
  4. D2（T6 与 T7a 实时裁判模型/provider/许可/预算、α、重复次数、护栏、最低独立来源组数及区间精度策略）已批准；
  5. D4（INTENT 文档内容与使用许可）已批准；
  6. D6（全保真数据授权）已批准；
  7. T7a 已完成并给出资格状态：确认性试点必须为 `CONFIRMATORY_READY`；若为 `EXPLORATORY_ONLY`，仅在 D2 明确批准且预注册标记为探索性时允许运行，决策卡不得建议 `PROMOTE`；`BLOCKED` 不得启动 T6；
  8. 不得根据“PR 已创建、CI 通过或代码存在”宣称功能已在 main 生效。
- **研究边界（SPEC §11.2）**：回顾性历史管道实验——历史 Pain 发生时没有当前 INTENT 文档；只验证当前 Intent 对历史案例重新诊断的影响；不得解释为历史行为违反当时 Owner 意图；不得外推为真实宿主长期行为改善；PROMOTE 只对应 SPEC §10 的决策 2。
- **预注册**（Owner 批准后不改；文件顶端 YAML front matter 必须声明 `experimentId: intent-engineering-onoff`；配置中的 `preregistration.file` 与 `preregistration.sha256` 绑定该文件原始字节；下列为建议值）：
  - 两臂：`baselineArm=off`、`candidateArm=on`，同一 worktree，唯一差异 `featureOverrides.intent_engineering` 与 `on` 臂的 `workspaceFiles`（D4 的 INTENT 文档，目标 `.principles/INTENT.zh-CN.md`，路径规则以 `getIntentFilename()` 为准）。
  - 样本：T7a 按 T6 所需路径准入的样本（原 16 条，按 `source-groups.json` 最多 14 个独立来源组）；预注册冻结的 `plannedGroups` 是统计分母，重复运行或结果缺失不得增减来源组数。
  - 主要结果：philosopher 阶段产出的两臂盲评偏好，评审问题为“哪个更符合这份 INTENT 文档表达的意图”，判定按 CONTRACT §6.5（双侧 α）。
  - 次要结果：每臂的冲突门拦截数（`owner_boundary_conflict`、`core_principle_conflict`）；schema 通过率、链路完成率、阶段时延、提示词字符量。
  - 硬护栏：`on` 臂链路完成率低于 `off` 臂；任何一条被拦截的候选经 Owner 抽查判为误拦。
  - 必须披露的限制：后见信息（历史 Pain 无当时 INTENT）；裁判与生成器同族（`ab-eval.mjs` 文件头注释在 T6 前修正为与代码一致的 ZAI GLM-5.3）。
- **干预到达证据**：`on` 臂每个样本必须能从运行记录或阶段产物找到 Intent 快照被捕获的证据（内容哈希）；`off` 臂必须没有。缺失样本计入分母并标为未交付（SPEC §9），不删除。
- **执行顺序**：`lab:preflight` → `lab:run`（经 `ab-grid`）→ `lab:metrics` → `lab:blindpack` → Owner 按 `analysis/owner-spotcheck-list.mjs` 抽查 20% → `lab:eval` → `lab:summary` → `lab:card`。
- **决策卡**：`experiment/intent-engineering-onoff/DECISION_CARD.md`，格式参照 `experiment/prompt-v2/reports/DREAMER_V22_OWNER_DECISION_CARD.md`；数字全部来自 `decision-input.json`；证据按 TECH §7 归档（复制、核对哈希、写索引后，决策卡引用归档索引）。若资格为 `EXPLORATORY_ONLY`，必须醒目标明“探索性、无确认性推断”，不得建议 `PROMOTE`；`PROMOTE` 仅可出现在 `CONFIRMATORY_READY` 且全部硬门通过的结果中。
- **测试入口**：无新测试；验证走运行证据与决策卡数字溯源（每个数字能在 `decision-input.json` 中找到）。
- **成功条件**：决策卡完整（判定 + `unknownsCouldChangeVerdict`、确定胜/负/未定组数、硬护栏、干预到达率、限制和允许的决策建议）；运行清单同时记录并核对 `configSha256` 与 `preregistrationSha256`，且预注册摘要等于 Owner 批准版本；资格状态、分析精度和探索/确认性边界与预注册一致；Owner 给出独立决策。
- **失败条件**：preflight 失败；两臂派生配置在 `intent_engineering` 之外还有差异；`on` 臂干预到达率为 0；预算用尽。
- **回滚**：实验无生产副作用；决策为 HOLD 即止步于决策 2，不进入决策 3。
- **Owner 授权**：D2、D4、D6（外加 SPEC §10 的三决策框架）。

### T7b：数据扩充（R4 起，长期）

- **文件**：数据集发布目录（版本化）、扩充台账报告。
- **输入/输出**：输入为授权信号库存与 T7a 的准入机制；输出为按 SPEC §6.2 八步流程交付的新数据版本与计数台账。
- **依赖**：T6 之后启动（用试点结论修订未决参数）；持续依赖 T7a 的准入与分组机制。
- **内容**：历史数据补齐（优先重复偏差、意图依据清楚、跨场景价值高的来源组）、前瞻真实观察（保留未触发 Pain 的机会作分母）、数据来源持续治理（授权/脱敏/撤回）、长期数据集维护（版本与保留集）。
- **测试入口**：每轮发布跑 `lab:probe` 与泄漏检查。
- **成功条件**：新增独立完整案例数、来源多样性、待补齐率与授权状态可审计；同一来源组变体不跨保留集。
- **失败条件**：授权不明或来源轨迹缺失的样本进入完整案例集。
- **回滚**：新数据版本独立发布，不影响旧版本；撤回按 CONTRACT §3 传播。
- **Owner 授权**：每轮数据范围的授权扩展需 Owner 决策（D6 的增量）。

### T8–T10：后续阶段（R5–R7）

这三项在 T6、T7a/T7b 的结果出来后重新细化，本版只给范围：

- **T8 首个行为切片（R5）**：在 `scripts/dev/pipeline-closure-lab/` 的可重建夹具或前瞻机会上，做有/无目标原则的比较。验收见 SPEC §11 的 R5 和 HT-01 至 HT-04。
- **T9 职责迁移与 Benchmark v1（R6）**：只有出现第二个不同领域的真实实验调用 harness 后，才把 harness 迁入 `scripts/dev/pd-lab/`，并退役重复入口；验收 RF-01、RF-03、RF-04。固定参照榜单需要独立来源组数满足预注册精度。
- **T10 持续数据与纵向（R7）**：按 D3 的节奏持续快照、扩充和撤回演练。

## 5. 验收用例目录

以下是待实现的测试义务，不是已有测试。每条映射到真实入口，不能只检查源码字符串。SC 用例的输入和预期只在 CONTRACT §7 定义。

| ID | 触发条件 | 必须观察到的结果 | 所属任务 |
| --- | --- | --- | --- |
| CF-01 | 不传 `--config` | 退出码 2，打印用法，不读任何文件 | T3 |
| CF-02 | 配置含未声明字段 | 拒绝，`problems[]` 指出字段名 | T3 |
| CF-03 | `experimentRoot` 经符号链接指向 `~/.pd` 下 | 拒绝，指出禁止根 | T3 |
| CF-04 | 某臂 `expectedHead` 与实际 HEAD 不同 | preflight 失败，不建任务 | T3、T5 |
| CF-05 | `dataset.sha256` 不匹配 | 拒绝运行 | T3 |
| CF-06 | `workspaceFiles.target` 为 `../x` 或中间目录含符号链接 | 拒绝，不写任何文件 | T3 |
| CF-07 | `featureOverrides` 设置 `intent_engineering: true` | 该臂派生配置中 `features.intent_engineering.enabled` 为 true，另一臂不变，其余内容结构化等价 | T3 |
| CF-08 | 运行者 shell 设置了 `PD_WORKSPACE_DIR` 指向某目录，且 `experimentRoot` 在其中 | 拒绝 | T3 |
| CF-09 | 配置缺 `baselineArm`/`candidateArm`，或两者相同，或不在 `arms` 中 | 拒绝；下游任何入口不得按字母序推断基线 | T3 |
| CF-10 | `featureOverrides` 含未注册 flagId | 拒绝，指出 flag 名 | T3 |
| CF-11 | `snapshot.sha256.blobManifest` 不匹配或被引用 Blob 哈希不符 | preflight 拒绝 | T3、T5 |
| CF-12 | 同一样本在不同分片组合下运行 | 臂顺序一致（全局索引 + 冻结种子） | T3 |
| CF-13 | `_note` 非字符串、`legacy.batch` 不在闭集、`legacy` 含附加字段或 legacy 配置同时提供预注册；合法历史 batch 则省略预注册 | 非法配置拒绝；合法 legacy 运行清单标记 `NOT_APPLICABLE_LEGACY` 且不伪造预注册 digest | T3 |
| CF-14 | 新实验预注册文件缺失或原始字节 SHA-256 不匹配 | preflight 在建任务/启动子进程/调用模型前拒绝 | T3、T5 |
| CF-15 | 预注册 YAML front matter 的 `experimentId` 与配置不一致 | preflight 拒绝，不产生运行记录 | T3 |
| CF-16 | `lab:preflight` 通过后、`lab:run` 前修改预注册文件但不更新配置中固定的 SHA-256，或使配置失效 | `lab:run` 二次 preflight 在写 run 记录或启动子进程前拒绝 | T3、T5 |
| DT-01 | 任务完成但扩大范围 / 外部故障却符合预期 | 两者不能由任务成功标志替代偏差判断 | T7a |
| DT-02 | Pain 存在，关键早期对话缺失 | INCOMPLETE，补齐原因；不计完整案例 | T7a |
| DT-03 | 轮次 `blob_ref` 指向的文件缺失或哈希不匹配 | `TURN_BLOB_MISSING` 或 `DIGEST_MISMATCH`，不用空内容继续 | T7a |
| DT-04 | 同源 10 变体，跨训练和保留集 | 发现来源泄漏并拒绝发布 | T7a |
| DT-05 | 模型推断的期望 | 不能当用户明示；有来源与审阅状态 | T7a |
| DT-06 | 授权撤回或只允许结构审计 | 禁止全保真运行；结构审计与运行资格分开 | T7a |
| DT-07 | 会话首行晚于 Pain 触发时间，但会话创建时间与首行一致 | 记 `SOURCE_GAP`（正常边界），不误判 `SOURCE_RETENTION_EXPIRED` | T7a |
| DT-08 | T6 所需 READY 独立来源组数为 0、1–5、6–8、9–11、12–14 | 分别得到 BLOCKED / EXPLORATORY_ONLY / 精确 `k(n, α)` 门槛；确认性资格还必须满足预注册最低组数与精度目标 | T7a |
| DT-09 | D2 未批准、D5 未批准或裁判校准未运行/失败 | 不调用实时裁判模型、不做未授权 Owner 盲评，T7a 不得输出 `CONFIRMATORY_READY` | T7a |
| PT-01 | 决策点后的用户纠正存在于源轨迹 | 完整源保留，actor 输入排除且可核查 | T8 |
| PT-02 | 同秒事件顺序无法确定 | 不猜序；阻塞受影响分支 | T8 |
| PT-03 | 生产入口截断早期要求 | 报告实际可见范围；不能以源完整掩盖输入缺失 | T7a |
| PT-04 | 当前管道合法拒绝或未生成原则 | 保留终局与原因（独立终态），不伪造审批/激活 | T6 |
| PT-05 | 样本 `host_kind` 为空 | 不伪装 OpenClaw 入口；按真实来源处理或标记不适用 | T3 |
| HT-01 | 配置开启但宿主无到达证据 | 不写已注入；声明证据级别 | T6、T8 |
| HT-02 | 明确未交付，但行为与对照完整 | 有效负结果留在分母，不删除样本 | T8 |
| HT-03 | 环境变量指向生产或 junction 逃逸 | preflight 拒绝，源状态不变 | T3 |
| HT-04 | 中断、重试、已完成单元恢复 | 不重复调用已完成单元；尝试历史保留，不能挑优 | T6 |
| RF-01 | 迁移前后同一冻结输入 | 结构结果、分母、证据与限制一致 | T9 |
| RF-02 | 换合法 worktree 或机器配置 | 不改源码路径即可运行；依赖不泄漏主检出 | T5 |
| RF-03 | Console 真实消费 Examiner | 产品功能与旧协议兼容 | T9 |
| RF-04 | 内部研究代码成为产品 import 闭包 | 负向检查失败，不以白名单扩容掩盖 | T3、T4、T9 |
| RF-05 | 使用合成数据与 fixture CLI 运行 `lab:run` | 实际 harness 入口产生记录、run-manifest、终态并验证恢复；无真实数据、网络或模型调用 | T5 |

## 6. 给接班 AI 的任务记录

每次交接保存一份记录，这是人可读清单，不是新的任务状态服务：

```text
任务 / R 阶段：
当前 commit 与 worktree：
§1 第 2 步的核验结果（仍成立 / 已漂移 / 未知）：
本任务改变的行为：
保持不变的历史契约：
已批准的 Owner 决策（D1–D6）及证据：
未决参数及被阻塞的具体动作：
应通过的用例及实际测试入口：
实际执行结果（PASS / FAIL / NOT_RUN / NOT_APPLICABLE）：
原始证据与派生产物位置、隐私范围：
Complexity Delta：
回滚方式、下一项任务：
```

纯文档交付不满足 T1–T10 的实现验收。未运行的宿主、模型或发布检查必须显式列出。

## 7. 常见误读的正确处理

| 容易误读为 | 应落实为 |
| --- | --- |
| Pain 就是失败事件 | 依据上下文比较行为与期望，任务结果只是证据之一 |
| 样本是 Pain 文本加摘要 | 信号锚定完整源轨迹，阶段输入另行投影 |
| 快照复制两个 `.db` 就是完整轨迹 | 长轮次正文在 blob 目录；工具返回可能只有预览；跨源一致性要单独证明 |
| 复制了 `trajectory.db` 就能重放完整诊断 | `fullTrace` 依赖 `state.db` 的任务/运行证据；历史证据边界见 TECH §5.4 |
| 臂名靠字母序分基线/改动 | 角色由 `baselineArm`/`candidateArm` 显式声明并贯穿全部下游 |
| `confidence` 可以当 `--score` 传 | 数据集 `score` 字段才是 CLI 语义；两者不得混用 |
| session 绑定失败降级重录即可 | 完整轨迹实验中绑定失败是样本级失败，不是自动降级继续 |
| 完整跑管道必须生成并激活原则 | 通过真实路径保留合法拒绝、未到达及其证据 |
| 有 UNKNOWN 就不能下结论 | 改动对基线按 CONTRACT §6.5 判定；只有榜单正式排名要求零未知 |
| 16 条样本接近判定门槛可放宽统计 | 双侧阈值与预注册绑定；放宽即新协议版本，须重新预注册 |
| 对齐 50 分表示达标 | 50 分只表示持平；是否满足期望看二元结果 |
| 已有 ITT 可直接吃胜/平/负 | 二元满足与偏好评分分开，按真实语义复用 |
| 缺结果删掉就能算分 | 从计划保留分母，输出缺失范围和判定 |
| 重构就是新建 pd-lab 目录包装旧脚本 | 新职责进新目录；旧 harness 原地参数化，迁移等第二个真实消费者 |
| 历史 Pain 的管道结果能说明宿主行为改善 | 历史案例无法重放行为，只支持管道层结论 |
| T6 的 PROMOTE 等于默认开启 | PROMOTE 只到 §10 决策 2；默认开启是决策 3，需要宿主行为证据 |
| 文档 Stage 全 PASS 就是研究成功 | 分开交付、研究有效性、交付能力、行为效果与晋级 |

## 8. 文档包边界

SPEC 拥有目标与研究要求；TECH 拥有模块、接线和实验配置格式；CONTRACT 拥有数据及算法；本文件拥有任务顺序和验收入口。修订时在拥有该事实的文档改一处并检查引用，不复制成多个“最新版本”。

本轮仅文档，运行时 Complexity Delta 八项均为 NO。T3 的实验配置格式、T4 的计分实现、T7a 的准入探测各自需要重新评估 Delta，不能继承 NO。文档检查和评审不证明真实数据、模型效果或生产发布已经验证。
