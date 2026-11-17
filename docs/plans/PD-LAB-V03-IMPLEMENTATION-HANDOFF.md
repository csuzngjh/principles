# PD-Lab v0.3 实施交接与验收工作包

状态：DRAFT，尚未实施。源码核验提交：`4388fe6d1`（含 main `b759f3ee0`，2026-11-17）。本文件让后续 AI 按固定顺序实现 [SPEC](../specs/SPEC-PD-LAB-EXPERIMENT-INTEGRATION-001-v0.3.md)。它不授权真实模型调用、生产数据访问、生产写入或发布；需要这些的步骤都标了所需的 Owner 决策。

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
- 不修改 `ab-eval.mjs` 的评审提示词和输出格式；不修改历史批次已产生的记录、报告和哈希。
- 不从产品包或 `scripts/build/lab-payload.mjs` 的闭包导入 `scripts/dev/pd-lab/` 或 `experiment/`。

## 2. 需要 Owner 先做的决策

AI 不得替 Owner 填这些值。缺少某项时，只做不依赖它的任务。

| ID | 决策 | 阻塞的任务 |
| --- | --- | --- |
| D1 | 晋级门 v0 的 L0–L3 是否生效；生效后 PR 描述是否加“变更等级 / 实验链接 / 晋级决策状态”三行 | 不阻塞实现；决定 T6 决策卡是否作为发布前置 |
| D2 | 试点的模型预算、裁判模型、α（默认建议 0.05）、重复次数、硬护栏阈值，以及是否允许调用外部模型 | T6 的真实运行 |
| D3 | 快照节奏（建议不超过 30 天一次，且每次正式实验前一次）、执行人、快照存放位置 | T1 |
| D4 | 试点使用的 INTENT 文档内容，以及能否用于实验工作区 | T6 的 `on` 臂 |
| D5 | 裁判校准的样本对数（建议 30–50 对）与通过门槛 | T7 的校准部分 |

## 3. 任务依赖

```text
T0 现实映射（R0）──────────────┐
T1 含 blob 的快照（R0，需 D3）──┤
T2 harness 测试入 CI（R1）────→ T3 配置解耦（R1）──→ T5 机械烟测（R1）──┐
T4 离线计分与判定（R1）─────────────────────────────────────────────────┤
                                                                         ↓
                                       T6 PR #2684 开关试点（R2，需 D2/D4）
T0 + T1 + T4 ──→ T7 准入探测与裁判校准（R3，校准需 D5）
T6 + T7 ──→ T8 首个行为切片（R4）──→ T9 职责迁移与 Benchmark v1（R5）──→ T10 纵向（R6）
```

T0、T1、T2、T4 互不依赖，可以并行。T3 必须在 T2 之后，否则重构没有回归保护。

## 4. 工作包

每个任务的“验收”全部满足才算完成；“停止条件”任一出现即停止并报告，不绕过。

### T0：现实映射（R0）

- **目标**：补齐 TECH §2.2 列出的三个未核验项，并同步术语漂移。
- **只读审计，产出一份报告** `docs/reports/PD_LAB_V03_T0_REALITY_MAP.md`：
  1. 实验工作区里运行 `pd diagnose run`、`pd runtime internalization run-once` 时，轨迹保留清扫会不会执行。从 `packages/pd-cli/src/commands/` 的这两个命令出发，追到 `packages/host-runtime/src/trajectory-retention.ts`，给出调用链和结论。会执行的话，写出在派生配置里关闭它的配置键（见 `resolveTrajectoryRetentionPolicy`）。
  2. Codex、WorkBuddy 采集路径中工具返回和长轮次的存储方式与上限，对照 `after-tool-call-helpers.ts` 的 500 字符和 `trajectory.ts` 的 16KB 外置。
  3. OpenClaw 宿主原生会话文件的位置和保留方式，能否按 `session_id` 关联回 `pain_events`。
- **术语**：在 `docs/architecture/GLOSSARY.md` 的 Pain Signal 条目改为 SPEC §2.1 的定义，保留“旧 `source` 取值只表示来源”的说明。不改任何代码或数据。
- **验收**：三项各有源码文件与行号；GLOSSARY 修改与 SPEC §2.1 一致；`npm run check:docs-structure` 通过。
- **停止条件**：结论依赖于只能在生产机器上观察的行为时，写成“需在生产机器核实”，不猜。

### T1：含 blob 的只读快照（R0，需 D3）

- **目标**：让快照包含长轮次正文，能在任何授权机器上执行，并按节奏执行第一次。
- **改动**：`experiment/prompt-v2/scripts/snapshot-and-discover.mjs`
  - 新增必填参数 `--source-workspace <dir>`，替代第 33–34 行写死的 `D:/.openclaw/workspace/...`；状态库和轨迹库路径用 `packages/principles-core/src/runtime/store/storage-paths.ts` 的解析规则得出，不手拼。
  - 复制 `resolvePdPath(<workspace>, 'TRAJECTORY_BLOBS_DIR')` 解析出的 blob 目录；报告里加 `blobs: { fileCount, totalBytes, manifestSha256 }`，逐文件哈希写入 `blob-manifest.json`。
  - `--out` 改为必填；不传即退出码 2。
- **测试**：`scripts/__tests__/pd-lab-snapshot.test.ts`。在临时目录用真实 schema 建一个小工作区（含一条带 `blob_ref` 的轮次和对应 blob 文件），以子进程运行脚本，断言：两个库都被备份且 `integrity_check` 为 ok；blob 被复制且哈希一致；源目录所有文件的 mtime 和哈希在运行前后不变；缺 `--source-workspace` 或 `--out` 时退出码为 2。
- **首次执行**（D3 指定的人在生产机器上）：输出到 `artifacts/pd-lab/snapshots/<YYYY-MM-DD>/`，按 AGENTS.md git-16 写 `README.md`，并确认 `git check-ignore -v artifacts/` 命中 `/artifacts/`。
- **验收**：测试通过；首次快照的 README 写明源路径、时间、文件数、总字节和哈希。
- **停止条件**：源库 `integrity_check` 不为 ok；blob 引用数与 blob 文件数对不上且无法解释。

### T2：harness 测试入 CI（R1）

- **目标**：T3 重构前，让现有 harness 行为有 CI 保护。
- **步骤**：
  1. 在干净 worktree 里运行 `npx vitest run experiment/prompt-v2/scripts/__tests__/`，记录结果。若有失败，先停下报告失败原因，不要为了通过而改测试。
  2. 全部通过后，在 `scripts/vitest.config.ts` 的 `include` 中加 `'../experiment/prompt-v2/scripts/__tests__/**/*.test.ts'`。
  3. 新增特征测试 `scripts/__tests__/pd-lab-harness-characterization.test.ts`，固定 T3 必须保持不变的行为：`childEnv()` 删除五个指针变量；`armOrderFor(runId, i, arms)` 对固定输入的输出。`deriveExperimentConfig` 目前直接读生产工作区，无法在不改源码的前提下测试，它的特征测试放到 T3 第 2 步：先用改动前的代码对同一份输入生成预期输出，再重构。
- **验收**：`npm run test:scripts` 本地通过，且运行列表中包含三个原有测试文件和新特征测试。
- **停止条件**：原有测试在干净检出上失败。

### T3：harness 配置解耦（R1）

- **目标**：换机器、换 worktree、换一项改动，不再修改源码。
- **新增** `scripts/dev/pd-lab/experiment-config.mjs`，只导出 `loadExperimentConfig(file)`，按 TECH §4 实现格式、禁止根派生和校验。同时新增 `scripts/dev/pd-lab/experiment-config.example.json`（占位符路径）。
- **修改** `experiment/prompt-v2/scripts/ab/ab-lib.mjs`：
  1. 删除 `WORKTREES`、`PRODUCTION_WORKSPACE`、`V1_BASE_COMMIT`、`EXPERIMENT_ROOT`、`SNAPSHOT_DIR`、`DATASET_FILE` 六个常量导出，改为一个 `useExperimentConfig(config)`，由入口脚本在解析 `--config` 后调用一次；其余函数从这个配置取值。未调用就使用任何函数时抛错。
  2. `deriveExperimentConfig(wsPath, arm)` 从 `config.baseConfigFile` 读模板，不再读生产工作区；`profileRebind` 存在时才做档位替换；再按该臂的 `featureOverrides` 设置 `features.<flagId>.enabled`；若 T0 结论是实验工作区会清扫轨迹，同时写入关闭清扫的配置。
  3. `materializeWorkspace(arm, …)` 在现有步骤后按 `workspaceFiles` 复制文件，复制前校验 `sha256`，`target` 规范化后必须在工作区内。
  4. `preflightIsolation()` 改用配置派生的禁止根（TECH §4.1），删除函数内写死的六个生产路径。
- **修改各入口**：`ab-run`、`ab-grid`、`ab-stage`、`ab-preflight`、`ab-preflight-v21`、`ab-metrics`、`ab-blindpack`、`ab-blindpack-paired`、`ab-dreamer-paired`、`ab-eval`、`ab-blind-summary`、`ab-diversity-eval`、`analysis/*.mjs` 全部增加必填 `--config`。
  - 臂名从配置的 `arms` 取，删除 `ab-metrics.mjs`、`ab-blindpack*.mjs`、`analysis/paired-analysis.mjs` 正则里写死的 `(v1|v2)`、`(v2c|v21)`，改为由臂名列表构造（臂名已限制为 `^[a-z][a-z0-9]*$`，无需转义）。
  - `ab-grid.mjs` 的 `--arms` 去掉默认值，必须显式给出且每个都在配置中。
  - `ab-run.mjs` 的 `run-manifest` 改记 TECH §7 列出的字段，替代 `heads.v1/v2`。
  - `ab-preflight.mjs` 中“V1 臂 HEAD 等于 `V1_BASE_COMMIT`”“两臂差异恰为 7 个 prompt 文件”两项，只在配置提供 `legacy.promptV2` 段时执行；该段只在历史配置里出现。
- **历史配置**：新增 `experiment/prompt-v2/configs/prompt-v2-round1.json`、`dreamer-v21-round2.json`，取值逐一抄自改动前的常量（含 `D:/...` 路径）。文件头的 `_note` 字段写明“历史批次取值，不是默认值”。在 `experiment-config.mjs` 里允许 `_note` 和 `legacy` 两个字段，其他未知字段仍拒绝。
- **入口命令**：根 `package.json` 增加 TECH §7 列出的 `lab:*` 脚本。
- **测试**：`scripts/__tests__/pd-lab-experiment-config.test.ts` 覆盖 CF-01 至 CF-08（§5）；T2 的特征测试保持通过。
- **验收**：
  - `rg -n "D:/|C:/" experiment/prompt-v2/scripts/ab experiment/prompt-v2/scripts/analysis` 无结果（历史配置在 `configs/` 下，不在这两个目录）。
  - `npm run check:workspace-tools` 通过。
  - `npm run test:scripts` 通过。
  - 用两份历史配置分别运行 `npm run lab:preflight -- --config <file>`，在没有那些路径的机器上失败，且失败信息逐项指出缺失的路径，而不是抛未捕获异常。
- **停止条件**：某个入口的行为无法在不改变记录文件格式的前提下参数化；特征测试需要改预期才能通过。

### T4：离线计分与判定（R1）

- **目标**：实现 CONTRACT §5、§6.1、§6.2、§6.5，不调用模型。
- **新增** `scripts/dev/pd-lab/alignment-report.mjs`，导出：
  - `mergeJudgments({ plan, judgments, arbitrations })` → `FinalComparison[]`，按 CONTRACT §5.2 的 6 步。
  - `buildAlignmentReport({ plan, comparisons, sourceGroups, design, alpha })` → CONTRACT §6.2 的输出，`design=CHANGE_VS_BASELINE` 时附 §6.5 的 `decision`。
  - 两者都是纯函数：不读文件、不读环境变量、不取当前时间。
- **新增** `scripts/dev/pd-lab/build-decision-input.mjs`：按 TECH §6.2 读取 `--config`、`--run-id`、`--plan <file>`、`--source-groups <file>`，写 `decision-input.json`。二元“是否满足期望”结果存在时，调用 `challenge-statistics.mjs` 的 `computeITT` 一并输出。
- **测试**：`scripts/__tests__/pd-lab-alignment-report.test.ts`
  - CONTRACT §7 的 SC-01 至 SC-18，每个一条用例，断言 `pointEstimate`、`missingBounds`、`status` 和 `decision` 的全部字段。
  - CONTRACT §7 末尾列出的数值性质，用固定随机种子各生成至少 200 组计划验证。
  - `k(n, 0.05)` 对 CONTRACT §6.5 表中每个 n 的值。
  - `build-decision-input.mjs` 以子进程运行在合成目录上：计划内缺一条评审时输出 UNKNOWN 而不是少一个单元；`blindmap.json` 缺映射时退出非零。
- **验收**：`npm run test:scripts` 通过；`alignment-report.mjs` 中没有 `fs`、`process.env`、`Date` 的引用。
- **停止条件**：CONTRACT 的手算例之间自相矛盾。报告具体条目，由 Owner 裁定，不自行挑一个。

### T5：机械烟测（R1）

- **目标**：证明 T3、T4 在一台不是 Owner 工作站的机器上能走通全部非模型步骤。
- **步骤**：在 CI 或任意 Linux 机器上，`scripts/__tests__/pd-lab-smoke.test.ts` 用临时目录构造：两个指向当前 worktree 的臂、一份 2 个样本的合成全保真数据集（不含真实内容）、一份合成快照、一份最小 `config.yaml`。依次以子进程运行 `lab:preflight`；再把预先写好的合成运行记录和评审文件放进 `runs/<id>/`，运行 `lab:metrics`、`lab:summary`、`lab:card`。
- **验收**：preflight 通过；`decision-input.json` 的 `plannedGroups` 等于合成来源组数；把一个臂的 `expectedHead` 改错后 preflight 失败（RF-02、CF-04）。
- **停止条件**：preflight 必须依赖 `pd-cli` 的真实运行才能通过。此时把这条依赖记下来，烟测只覆盖到 preflight 之前。

### T6：PR #2684 开关试点（R2，需 D2、D4，PR #2684 已合入 main）

- **目标**：回答“`intent_engineering` 开启是否让管道产出更贴近 Owner 意图，有没有新的误拦”。结论限定在管道层。
- **预注册**：运行前提交 `experiment/intent-engineering-onoff/PREREGISTRATION.md`，Owner 批准后不改。下列为建议值，Owner 可改：
  - 两臂：`off` 与 `on`，指向同一个 worktree（PR #2684 合入后的 main 提交）。唯一差异是 `featureOverrides.intent_engineering` 和 `on` 臂的 `workspaceFiles`（D4 的 INTENT 文档，目标路径 `.principles/INTENT.zh-CN.md`，文件名规则见 `packages/principles-core/src/runtime/intent/intent-doc.ts` 的 `getIntentFilename`）。
  - 样本：已冻结的 16 条；来源组按 CONTRACT §3 生成（同会话同组）。
  - 主要结果：philosopher 阶段产出的两臂盲评偏好，评审问题为“哪个更符合这份 INTENT 文档表达的意图”，判定按 CONTRACT §6.5。
  - 次要结果：每臂的冲突门拦截数（`owner_boundary_conflict`、`core_principle_conflict`）；schema 通过率、链路完成率、阶段时延、提示词字符量。
  - 硬护栏：`on` 臂链路完成率低于 `off` 臂；任何一条被拦截的候选经 Owner 抽查判为误拦。
  - 必须披露的限制：历史 Pain 发生时没有这份 INTENT 文档，属于后见信息；裁判与生成器的模型关系。
- **干预到达证据**：`on` 臂每个样本必须能从运行记录或阶段产物中找到 Intent 快照被捕获的证据（PR #2684 的快照哈希）；`off` 臂必须没有。缺失的样本计入分母并标为未交付（SPEC §9），不删除。
- **执行顺序**：`lab:preflight` → `lab:run`（经 `ab-grid`）→ `lab:metrics` → `lab:blindpack` → Owner 按 `analysis/owner-spotcheck-list.mjs` 抽查 20% → `lab:eval` → `lab:summary` → `lab:card`。
- **决策卡**：`experiment/intent-engineering-onoff/DECISION_CARD.md`，格式参照 `experiment/prompt-v2/reports/DREAMER_V22_OWNER_DECISION_CARD.md`，必须写出：判定结果和 `unknownsCouldChangeVerdict`；确定胜、确定负、未定组数；硬护栏；干预到达率；限制；建议的 `PROMOTE / HOLD / REJECT`。数字全部来自 `decision-input.json`。证据按 TECH §7 归档。
- **验收**：决策卡中的每个数字能在 `decision-input.json` 中找到；运行清单的配置哈希与预注册引用一致；Owner 给出独立决策。
- **停止条件**：preflight 失败；两臂派生配置在 `intent_engineering` 之外还有差异；`on` 臂干预到达率为 0；预算用尽。

### T7：准入探测、来源分组与裁判校准（R3）

- **准入探测**：按 TECH §5.2 实现 `scripts/dev/pd-lab/admission-probe.mjs` 和 `npm run lab:probe`。测试覆盖 DT-02、DT-03 和 TECH §5.2 表中每个问题代码各一条触发用例。对 T1 的快照运行一次，结果写入 `docs/reports/PD_LAB_V03_ADMISSION_PROBE.md`（只含计数和问题代码）。
- **来源分组**：为已冻结数据集生成 `source-groups.json`（CONTRACT §3），机械规则部分由代码生成，人工合并部分逐条写依据。
- **裁判校准（需 D5）**：用 `owner-spotcheck-list.mjs` 的方式抽样，Owner 盲评；报告 Owner 与裁判的一致率、位置偏差（同一包交换顺序再评一次的翻转率）和分歧类型。未达门槛时，后续所有对齐结果标为“试验”，不进入晋级决策。
- **验收**：探测报告给出每条路径（CONTRACT §2.4）的 READY 数；校准报告给出一致率和翻转率。
- **停止条件**：`PIPELINE_REPLAY` READY 数为 0 到 2。此时把完整性改为分级的提案报给 Owner，不继续 T8。

### T8–T10：后续阶段（R4–R6）

这三项在 T6、T7 的结果出来后重新细化，本版只给范围：

- **T8 首个行为切片（R4）**：在 `scripts/dev/pipeline-closure-lab/` 的可重建夹具或前瞻机会上，做有/无目标原则的比较。验收见 SPEC §11 的 R4 和 HT-01 至 HT-04。
- **T9 职责迁移与 Benchmark v1（R5）**：只有出现第二个不同领域的真实实验调用 harness 后，才把 harness 迁入 `scripts/dev/pd-lab/`，并退役重复入口；验收 RF-01、RF-03、RF-04。固定参照榜单需要独立来源组数满足预注册精度。
- **T10 持续数据与纵向（R6）**：按 D3 的节奏持续快照、扩充和撤回演练。

## 5. 验收用例目录

以下是待实现的测试义务，不是已有测试。每条映射到真实入口，不能只检查源码字符串。SC 用例的输入和预期只在 CONTRACT §7 定义。

| ID | 触发条件 | 必须观察到的结果 | 所属任务 |
| --- | --- | --- | --- |
| CF-01 | 不传 `--config` | 退出码 2，打印用法，不读任何文件 | T3 |
| CF-02 | 配置含未声明字段 | 拒绝，`problems[]` 指出字段名 | T3 |
| CF-03 | `experimentRoot` 经符号链接指向 `~/.pd` 下 | 拒绝，指出禁止根 | T3 |
| CF-04 | 某臂 `expectedHead` 与实际 HEAD 不同 | preflight 失败，不建任务 | T3、T5 |
| CF-05 | `dataset.sha256` 不匹配 | 拒绝运行 | T3 |
| CF-06 | `workspaceFiles.target` 为 `../x` | 拒绝，不写任何文件 | T3 |
| CF-07 | `featureOverrides` 设置 `intent_engineering: true` | 该臂派生配置中 `features.intent_engineering.enabled` 为 true，另一臂不变，其余内容逐字节相同 | T3 |
| CF-08 | 运行者 shell 设置了 `PD_WORKSPACE_DIR` 指向某目录，且 `experimentRoot` 在其中 | 拒绝 | T3 |
| DT-01 | 任务完成但扩大范围 / 外部故障却符合预期 | 两者不能由任务成功标志替代偏差判断 | T7 |
| DT-02 | Pain 存在，关键早期对话缺失 | INCOMPLETE，补齐原因；不计完整案例 | T7 |
| DT-03 | 轮次 `blob_ref` 指向的文件缺失或哈希不匹配 | `TURN_BLOB_MISSING` 或 `DIGEST_MISMATCH`，不用空内容继续 | T7 |
| DT-04 | 同源 10 变体，跨训练和保留集 | 发现来源泄漏并拒绝发布 | T7 |
| DT-05 | 模型推断的期望 | 不能当用户明示；有来源与审阅状态 | T7 |
| DT-06 | 授权撤回或只允许结构审计 | 禁止全保真运行；结构审计与运行资格分开 | T7 |
| PT-01 | 决策点后的用户纠正存在于源轨迹 | 完整源保留，actor 输入排除且可核查 | T8 |
| PT-02 | 同秒事件顺序无法确定 | 不猜序；阻塞受影响分支 | T8 |
| PT-03 | 生产入口截断早期要求 | 报告实际可见范围；不能以源完整掩盖输入缺失 | T7 |
| PT-04 | 当前管道合法拒绝或未生成原则 | 保留终局与原因，不伪造审批/激活 | T6 |
| HT-01 | 配置开启但宿主无到达证据 | 不写已注入；声明证据级别 | T6、T8 |
| HT-02 | 明确未交付，但行为与对照完整 | 有效负结果留在分母，不删除样本 | T8 |
| HT-03 | 环境变量指向生产或 junction 逃逸 | preflight 拒绝，源状态不变 | T3 |
| HT-04 | 中断、重试、已完成单元恢复 | 不重复调用已完成单元；尝试历史保留，不能挑优 | T6 |
| RF-01 | 迁移前后同一冻结输入 | 结构结果、分母、证据与限制一致 | T9 |
| RF-02 | 换合法 worktree 或机器配置 | 不改源码路径即可运行；依赖不泄漏主检出 | T5 |
| RF-03 | Console 真实消费 Examiner | 产品功能与旧协议兼容 | T9 |
| RF-04 | 内部研究代码成为产品 import 闭包 | 负向检查失败，不以白名单扩容掩盖 | T3、T4、T9 |

## 6. 给接班 AI 的任务记录

每次交接保存一份记录，这是人可读清单，不是新的任务状态服务：

```text
任务 / R 阶段：
当前 commit 与 worktree：
§1 第 2 步的核验结果（仍成立 / 已漂移 / 未知）：
本任务改变的行为：
保持不变的历史契约：
已批准的 Owner 决策（D1–D5）及证据：
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
| 快照复制两个 `.db` 就是完整轨迹 | 长轮次正文在 blob 目录；工具返回可能只有预览 |
| 完整跑管道必须生成并激活原则 | 通过真实路径保留合法拒绝、未到达及其证据 |
| 有 UNKNOWN 就不能下结论 | 改动对基线按 CONTRACT §6.5 判定；只有榜单正式排名要求零未知 |
| 对齐 50 分表示达标 | 50 分只表示持平；是否满足期望看二元结果 |
| 已有 ITT 可直接吃胜/平/负 | 二元满足与偏好评分分开，按真实语义复用 |
| 缺结果删掉就能算分 | 从计划保留分母，输出缺失范围和判定 |
| 重构就是新建 pd-lab 目录包装旧脚本 | 新职责进新目录；旧 harness 原地参数化，迁移等第二个真实消费者 |
| 历史 Pain 的管道结果能说明宿主行为改善 | 历史案例无法重放行为，只支持管道层结论 |
| 文档 Stage 全 PASS 就是研究成功 | 分开交付、研究有效性、交付能力、行为效果与晋级 |

## 8. 文档包边界

SPEC 拥有目标与研究要求；TECH 拥有模块、接线和实验配置格式；CONTRACT 拥有数据及算法；本文件拥有任务顺序和验收入口。修订时在拥有该事实的文档改一处并检查引用，不复制成多个“最新版本”。

本轮仅文档，运行时 Complexity Delta 八项均为 NO。T3 的实验配置格式、T4 的计分实现、T7 的准入探测各自需要重新评估 Delta，不能继承 NO。文档检查和评审不证明真实数据、模型效果或生产发布已经验证。
