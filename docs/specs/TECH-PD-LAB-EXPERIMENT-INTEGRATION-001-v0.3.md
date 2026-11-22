# TECH-PD-LAB-EXPERIMENT-INTEGRATION-001 v0.3

## 状态与阅读入口

设计状态：DRAFT。本文是 [SPEC v0.3](SPEC-PD-LAB-EXPERIMENT-INTEGRATION-001-v0.3.md) 的技术分解，不是实现记录，也不授权任何真实运行。

源码核验提交：`4388fe6d1`（PR #2685 分支最终内容；该 PR 已 squash 合并为 main `4b9d07c8d`，四份 v0.3 文档在两处字节一致，2026-11-17 第一轮）；同日第二轮复核对照合并前后 main——其间 main 仅新增 `docs/reports/` 文件，本文引用的源码事实无漂移。§2 的每一行都在该提交读过源码；标注“未核验”的条目必须由实施者先核验再动手。第二轮复核新增的事实（两臂身份、运行契约、历史证据链、裁判输出）以 `2026-11-17b` 标注。

| 开发任务 | 必须读取 |
| --- | --- |
| 所有实现 | SPEC §2、对应 R 阶段；本文 §1–3；[实施交接](../plans/PD-LAB-V03-IMPLEMENTATION-HANDOFF.md) 的对应任务 |
| 实验配置、入口、隔离 | 本文 §4、§7 |
| 数据快照、准入或投影 | 本文 §5；[数据与评分契约](CONTRACT-PD-LAB-DATA-AND-SCORING-001-v0.3.md) §1–3 |
| 裁判、计分、判定或决策卡 | 本文 §6；契约 §4–8 |
| 迁移或发布闭包 | 本文 §8–9 |

权威顺序：当前 Owner 指令与 AGENTS.md → SPEC 的产品/研究语义 → CONTRACT 的数据与算法定义 → 本文的模块与接线 → HANDOFF 的任务组织。发现矛盾须定位到具体条款并纠正，不选择最方便实现的一份。数据字段与算法只在 CONTRACT 定义；实验配置文件格式只在本文 §4 定义。

## 1. 技术决策

1. **先让一项真实改动拿到结果，再扩展数据和榜单。** 第一批代码只做三件事：把已有 Prompt A/B harness 的环境绑定改成显式配置、补离线计分与判定、用一项真实改动跑通并产出决策卡。
2. **旧代码原地改，新代码进 `scripts/dev/pd-lab/`。** 已有 harness 留在 `experiment/prompt-v2/scripts/`，不搬迁、不加代理层。新增的配置读取、计分、准入探测是全新职责，直接放进 `scripts/dev/pd-lab/`。理由见 §3.1。
3. **完整源样本与阶段输入分开。** 快照保存源轨迹；生产诊断走它真实的输入构造路径，不把研究 JSON 塞进 Prompt。
4. **计分是纯派生。** 冻结的计划和已归并的比较结论决定报告；计分函数不读生产 DB、不调用模型、不决定 Owner 意图。
5. **元数据、运行事实、Owner 决策各守其权威。** Manifest 定义实验身份；领域执行记录说明发生了什么；Lab 只引用合法 Owner 决策。
6. **技术可执行不等于授权可执行。** 所有真实入口在运行前验证授权、预算、数据可用性和隔离，缺任何一项即 fail-closed。

非目标：中央实验服务、通用 Runner、数据库注册中心、通用重试引擎、新用户 UI、改造生产 Principle/Approval/Activation schema、统一所有宿主的 transcript 格式。

## 2. 当前接线（已核验事实）

### 2.1 Prompt A/B harness

位置：`experiment/prompt-v2/scripts/ab/`。它驱动真实 pd-cli，已用于 Prompt V2（臂 `v1`/`v2`）和 Dreamer V2.1（臂 `v2c`/`v21`）两轮实验。

| 文件 | 已核验行为 | 对复用的影响 |
| --- | --- | --- |
| `ab-lib.mjs` | 导出 `WORKTREES`、`PRODUCTION_WORKSPACE`、`V1_BASE_COMMIT`、`EXPERIMENT_ROOT`、`SNAPSHOT_DIR`、`DATASET_FILE` 六个常量，值是 `D:/Code/_worktrees/...`、`D:/.openclaw/workspace` 等本机路径；`preflightIsolation()` 内另写死 `C:/Users/Administrator/.pd` 等六个生产路径 | 换机器或换实验必须改源码 |
| `ab-lib.mjs` `deriveExperimentConfig(wsPath)` | 读取**生产工作区**的 `.pd/config.yaml` 作模板；用字符串正则删掉 `ui:` 之后的段（含 `feedback:`）；正则重映射 `workspace.default`；正则开启 `diagnostician_async_cli`；字符串替换 `pi-ai.amd-ds-vision` 绑定为 `pi-ai.glm`；正则关闭六个非学习链 agent | 全程是字符串手术，不是结构化 YAML 处理；没有按臂覆盖功能开关的能力；模型档位替换是历史批次特有逻辑（2026-11-17b） |
| `ab-lib.mjs` `materializeWorkspace(arm)` | 在 `EXPERIMENT_ROOT/workspaces/<arm>[-s<shard>]` 建 `.pd/`、`.state/`，把快照的 `trajectory.db` 整库复制进去，写派生配置；用临时文件加 rename 原子落位 | **`state.db` 是新建的空库**（2026-11-17b，见 §2.2）；没有向工作区放入额外文件（如 INTENT 文档）的能力 |
| `ab-lib.mjs` `runPd(arm, args)` | 以 `<worktree>/packages/pd-cli/dist/index.js` 起子进程，追加 `--workspace <ws> --json`，环境经 `childEnv()` 清除五个工作区指针变量后注入 `PD_WORKSPACE_DIR` | 臂等于“一个 worktree 的 dist”，两臂共用同一提交时需允许共用 worktree |
| `ab-lib.mjs` `loadDataset()` | 只接受全保真数据集；文件缺失或带脱敏标记即抛错，没有回退到公开副本；**脱敏标记只探测第一条样本**（`dataset.samples?.[0]?.painEvent`，2026-11-17b） | 保留 fail-closed；检查必须扩到全部样本（§7 运行契约） |
| `ab-run.mjs` | 每臂每分片依次执行 `pd pain record` → `pd diagnose run` → 循环 `pd runtime internalization run-once --runner dreamer\|philosopher\|scribe`；记录落在 `runs/<runId>/records/<sample>.<arm>[.repN].json` | 这条链正是 PR #2684 接入 Reader 的入口（`packages/pd-cli/src/commands/{pain-record,diagnose}.ts`） |
| `ab-run.mjs` ingress 细节（2026-11-17b） | `--reason` 截到 4000 字符，但 CLI 上限 500 且超限**直接拒绝**（`pain-record.ts` `MAX_REASON_LENGTH`）；`--score` 取的是 `painEvent.confidence`（数据集另有 `score` 字段）；`--host openclaw` 对所有样本写死；`--session` 绑定失败（`session_not_found\|sentinel`）时自动去掉 `--session/--host` 重录为无会话 Pain 并继续实验；终态只有 `done`/`done-admission-refused`/`incomplete`/`failed`，合法无候选与 defer 没有独立终态；臂顺序 `armOrderFor(runId, si, …)` 用的是**分片内**样本索引 | 运行契约修订见 §7；`--score` 应取 `painEvent.score`；完整轨迹实验中 session 绑定失败必须显式失败而非静默降级 |
| `ab-grid.mjs` | 把样本切成最多 8 个分片并行跑 `ab-run`；任一分片非零退出则整体失败；`--arms` 默认 `v1,v2` | 臂名默认值要改成必填；分片下臂顺序需用全局样本索引与冻结种子（§7） |
| `ab-metrics.mjs` | 用正则 `^([^.]+)\.(v1\|v2…)(?:\.rep(\d+))?\.json$` 解析记录（`ARMS=['v1','v2','v2c','v21']` 写死）；配对逻辑用 `index.v1`/`index.v2` 两个变量，**`v1` 恒为基线侧**；按 (样本, 阶段, 重复) 配对，缺一侧进 `missing` | 臂名与基线角色都写死：字母序决定 baseline/treatment，换臂名后角色 silently 错位（2026-11-17b）。两臂身份必须由配置显式声明（§4.1） |
| `ab-blindpack.mjs` / `ab-blindpack-paired.mjs` | 生成匿名评审包和独立的 `blindmap.json`；A/B 顺序随机并固定；组包后做泄漏自检；**per-agent 配对的 `armA='v1'`/`armB='v2'` 是默认参数**（2026-11-17b） | 每个包只有一种显示顺序，没有位置交换；默认臂角色同样按字母序假设，需改为显式角色映射 |
| `ab-eval.mjs` | 调用 `open.bigmodel.cn` 的 `glm-5.3`，需要 `ZAI_API_KEY`；输出含 `pairwise.preferred: A\|B\|tie`——**没有 UNKNOWN 选项**；超过 9000 字符的阶段输出被 `slice(0,9000)` 截断后送评，无有损标记（2026-11-17b） | 文件头注释写的是 OpenRouter Ernie，与代码不符，T6 前必须修正注释；新 Judge Protocol 按 CONTRACT §5.1 支持 UNKNOWN 并标记有损输入 |
| `ab-blind-summary.mjs` | 从 `blindmap.json` 发现臂名并解盲汇总 | 已不写死臂名，可直接复用 |
| `ab-preflight.mjs` | 六项检查，其中“V1 臂 HEAD 等于基线提交”“两臂代码差异恰为 7 个 prompt 层文件”是 Prompt V2 批次特有 | 通用检查与批次特有检查要分开 |
| `analysis/owner-spotcheck-list.mjs` | 确定性抽取 20% 评审包给 Owner 盲审，答案表另存 | Owner 校准可复用 |
| `analysis/paired-analysis.mjs` | 正则写死 `(v2c\|v21)`；默认 run 为 `paired-2`、`grid-3` | 历史批次专用，只做路径参数化；角色映射同样不得按字母序 |

测试现状：

- `experiment/prompt-v2/scripts/__tests__/` 下有 3 个测试文件（`pdspec001-ab-metrics`、`pdspec001-atomic-file`、`pdspec001-blindpack`）。仓库里没有任何 npm script 或 CI workflow 引用这个目录，**它们不在 CI 里运行**。
- `scripts/__tests__/` 由 `npm run test:scripts` 运行（`scripts/vitest.config.ts`，CI 的 `.github/workflows/ci.yml` 调用）。`scripts/__tests__/pdspec001-redaction.test.ts` 已经从这里导入 `experiment/` 下的模块。
- `npm run check:workspace-tools`（`scripts/check-workspace-tools.cjs`）扫描 `scripts/dev/` 下除 `pipeline-closure-lab`、`pipeline-evolution` 外的全部 `.mjs/.cjs/.js/.ts`，拒绝 `X:\Code\`、`X:\Users\` 形式的写死路径。它不扫描 `experiment/`。

### 2.2 数据来源

| 事实 | 位置 | 对数据集的影响 |
| --- | --- | --- |
| 轨迹分表：`sessions`、`assistant_turns`、`user_turns`、`tool_calls`、`pain_events` 等，以 `session_id` 关联 | `packages/principles-core/src/runtime/trajectory-schema.ts` | 完整轨迹必须跨表重建，不能只读 `pain_events` |
| 超过 16KB 的轮次正文写入独立 blob 文件，库内只留 `blob_ref` 和最长 200 字符的 `raw_excerpt` | `packages/openclaw-plugin/src/core/trajectory.ts`（`DEFAULT_INLINE_THRESHOLD`、`TRAJECTORY_BLOBS_DIR`） | 只复制 `.db` 文件的快照会丢失长轮次正文 |
| 快照脚本只备份 `state.db` 和 `trajectory.db` 两个文件，源路径写死为 `D:/.openclaw/workspace/...` | `experiment/prompt-v2/scripts/snapshot-and-discover.mjs` | 现有快照不含 blob；换机器不可用 |
| 工具返回只存预览，上限 500 字符，超出以 `...` 结尾 | `packages/openclaw-plugin/src/hooks/after-tool-call-helpers.ts`（`RESULT_PREVIEW_MAX_LENGTH`） | OpenClaw 路径的工具返回在库里不完整 |
| `tool_calls`、`assistant_turns`、`user_turns` 默认保留 90 天，由常驻 worker 分批删除；代码默认启用 | `docs/specs/SPEC-PD-TR-001-trajectory-retention-2026-11-11.md`；`packages/principles-core/src/runtime/trajectory-retention.ts`（`TRAJECTORY_RETENTION_DEFAULTS`） | 历史案例的源轨迹会到期消失 |
| 生产诊断输入由 `SqliteContextAssembler` 构造：优先已晋升的证据窗口，否则经 `TrajectoryTurnReader` 按 `sessionIdHint` 回退读轨迹（PRI-350）；窗口超过 `maxConversationEntries` 时只保留最近的条目 | `packages/principles-core/src/runtime/store/context/sqlite-context-assembler.ts` | “源里有完整轨迹”不等于“模型看到了完整轨迹” |
| **`fullTrace` 依赖 `state.db`，不是 `trajectory.db`（2026-11-17b）**：`buildFullTraceFromSource` → `SourceTraceLocator.locate` → `SqliteTrajectoryLocator` 的全部查询落在工作区 `state.db` 的 `runs`/`tasks` 表（`pain-signal-runtime-factory.ts` 以 `SqliteConnection(workspaceDir)` 构造）；实验工作区的 `state.db` 由 `materializeWorkspace` 新建，历史任务/运行/工具证据不在其中 | `packages/principles-core/src/runtime/store/trajectory/sqlite-{source-trace,trajectory}-locator.ts`、`pain-signal-runtime-factory.ts:704-718` | 对历史 Pain，实验内 `fullTrace` 恒为 null，仅会话轮次经 PRI-350 回退可见；“完整轨迹重放”的边界按 §5.4 定义，不得默认成立 |
| 读轨迹库失败必须抛 `TrajectoryDbUnavailableError`，不能当作空结果 | `packages/principles-core/src/trajectory-store.ts`（另有 `openTrajectoryDbReadonly`） | 准入探测要区分“库不可用”和“没有记录” |
| 已冻结数据集 16 条，其中 S01/S08 同一会话、S02/S04 同一会话；14 条来自 OpenClaw，2 条 `host_kind` 为空 | `experiment/prompt-v2/dataset/pain-dataset.json`（公开脱敏副本） | 按会话分组最多 14 个独立来源组 |
| 数据集样本内嵌 Pain、诊断目标、历史阶段产物和候选，**不内嵌对话轨迹**；轨迹靠整库快照提供 | 同上 | 准入探测必须读快照的 `trajectory.db` |

未核验，T0 必须补齐：

- `pd diagnose run` 与 `pd runtime internalization run-once` 是否会在实验工作区触发轨迹保留清扫。若会，复制进去的旧快照会被删行，同一样本在不同日期运行会得到不同输入。
- Codex 与 WorkBuddy 采集路径的工具返回和长轮次存储方式。
- 宿主原生会话文件的位置、保留方式，以及能否按 `session_id` 关联回 Pain。

### 2.3 其他被复用的所有者

| 现有所有者 | 已核验行为 | 使用方式与限制 |
| --- | --- | --- |
| `scripts/dev/pipeline-evolution/lib/experiment-manifest.mjs` | 导出 `MANIFEST_SCHEMA`（`experiment-manifest.v1`）、`BEHAVIOR_OUTCOMES`（`IMPROVED / NO_IMPROVEMENT / REGRESSION / INCONCLUSIVE`）、`parseManifest`、`loadManifest`、`newManifestTemplate` | 判定结论复用 `BEHAVIOR_OUTCOMES` 的词汇，不另造一套；不把 manifest 扩成运行事实库 |
| `scripts/dev/principle-learning-lab/lib/challenge-statistics.mjs` | 导出 `computeBFRR`、`computePCR`、`computeFIR`、`computePairedEffect`、`buildPlannedPairs`、`computeITT`、`computeTreatmentFidelity` 等 | 二元“是否满足期望”直接调用；不能把 0.5 传进二元接口 |
| `scripts/dev/principle-learning-lab/lib/challenge-behavior-report.mjs` | 消费统计、冻结和注入证据，属于产品发布闭包 | 首轮不动 |
| `scripts/build/lab-payload.mjs` | 七个 Examiner 入口的递归闭包 | 任何 import 或路径迁移都要检查正向产品功能和负向研发隔离 |
| `packages/host-runtime/src/production-pain-evidence.ts` | 技术工具结果记为轨迹/健康证据，不自动当作 Pain | 研究侧不得恢复“工具失败等于 Pain”的假设 |

## 3. 模块组织

### 3.1 物理位置

| 位置 | 放什么 | 约束 |
| --- | --- | --- |
| `experiment/prompt-v2/scripts/` | 已有 harness 及其历史批次脚本 | 原地修改；本阶段不搬迁、不改文件名 |
| `scripts/dev/pd-lab/` | 新增职责：实验配置读取、计分与判定、决策卡输入、准入探测 | 只放有真实调用方的文件；不为旧脚本建代理 |
| `scripts/__tests__/pd-lab-*.test.ts` | 上述新增职责的测试，以及 harness 的特征测试 | 由 `npm run test:scripts` 在 CI 运行 |
| `experiment/<experimentId>/` | 每个新实验的预注册、配置样例、决策卡 | 不放全保真数据 |

新代码放 `scripts/dev/pd-lab/` 而不是继续堆进 `experiment/prompt-v2/` 的理由有两条，都来自 §2.1 的核验结果：该目录自动受 `check:workspace-tools` 的写死路径检查保护；它的测试目录已经在 CI 里。这不是“统一目录”，旧 harness 的迁移仍按 §8 的条件另行决定。

产品化计算模块保持产品可达所有者。`scripts/dev/pd-lab/` 可以导入 `challenge-statistics.mjs`；任何产品包和 `lab-payload.mjs` 的闭包都不能导入 `scripts/dev/pd-lab/` 或 `experiment/`。

### 3.2 新增模块与接口

每个模块只暴露下表列出的导出。不为它们再建接口、工厂或 Provider。

| 文件 | 导出 | 职责 | 首个调用方 |
| --- | --- | --- | --- |
| `scripts/dev/pd-lab/experiment-config.mjs` | `loadExperimentConfig(file)` | 读取、校验并冻结实验配置；失败时抛出带 `problems[]` 的错误 | `ab-lib.mjs` 及各 `ab-*.mjs` 入口 |
| `scripts/dev/pd-lab/alignment-report.mjs` | `mergeJudgments(input)`、`buildAlignmentReport(input)`、`twoSidedThreshold(n, alpha)` | 裁判记录归并；按计划聚合、算缺失界、给出判定。纯函数，无 I/O。`twoSidedThreshold` 是 CONTRACT §6.5 双侧阈值的唯一统计权威（PRI-1258 起导出给资格引擎复用） | `build-decision-input.mjs`、`t6-qualification.mjs` |
| `scripts/dev/pd-lab/build-decision-input.mjs` | CLI | 读取一次运行的计划、评审结果和管道指标，写出 `decision-input.json` | `npm run lab:card` |
| `scripts/dev/pd-lab/admission-probe.mjs` | CLI | 只读打开快照，对每个样本输出准入结果和问题代码，不输出正文 | `npm run lab:probe` |
| `scripts/dev/pd-lab/judge-protocol.mjs` | `JUDGE_PROTOCOL_REF`、`judgeProtocolDigest()`、`parseJudgeResponse(rawText)`、`buildJudgePackage(input)`、`swapJudgePackage(...)`、`checkPackageForLeaks(pkg)`、`comparisonInputDigestOf(pkg, identityMap)`、`buildProtocolRecord(input)`、`validateProtocolRecord(record)`、`restoreDisplayVerdict(...)` 及协议常量 | CONTRACT §5.1 版本化 Judge Protocol：协议定义与 digest、四值严格解析（非法拒绝绝不转 TIE）、盲评包组装与泄漏扫描、A/B 位置交换与受控身份还原、记录 schema 校验。纯函数，无 I/O（真实模型调用属 D2，不在本模块） | `judge-protocol-validate.mjs`、`t6-qualification.mjs`、测试 |
| `scripts/dev/pd-lab/judge-protocol-validate.mjs` | CLI | 对合成协议 bundle（盲包+绑定+原始响应+记录+仲裁）做机械复核：digest 重算、泄漏重扫、交换一致性、失败 attempt 保留、位置翻转率披露 | `npm run lab:judge-validate` |
| `scripts/dev/pd-lab/t6-qualification.mjs` | `nMinForAlpha(alpha)`、`validateQualificationInput(input)`、`qualifyT6(input)` | T6 三态资格引擎（BLOCKED / EXPLORATORY_ONLY / CONFIRMATORY_READY）：n、D2 冻结参数、授权与校准状态的纯函数判定；无 D2 的模型调用/无 D5 的盲评为违规披露。纯函数，无 I/O | `t6-qualify.mjs`、测试 |
| `scripts/dev/pd-lab/t6-qualify.mjs` | CLI | 读取资格输入记录，写出机械可复算的 `qualification.json`（BLOCKED 是合法计算结果，不是 CLI 失败） | `npm run lab:qualify` |

接口形状以 CONTRACT §2.4（准入结果）、§5（归并）、§6（聚合与判定）为准。本表的文件名是实施约定；如仓库惯例要求改名，在对应任务的 PR 里同时改本表。

### 3.3 数据流

```text
授权源记录 → 只读一致快照（含 blob）→ 准入探测/来源分组 → 冻结数据集
                                              ↓
预注册 + 实验配置 → preflight → 现有 pd-cli 入口（每臂独立工作区）
                                              ↓
                             运行记录 / 阶段产物 / 管道指标
                                              ↓
                      匿名评审包 → 裁判记录 → 确定性归并
                                              ↓
                  decision-input.json → 决策卡 → Owner 晋级决策
```

模型只用于需要判断的语义比较。路径解析、哈希、分组键、分母、重复检测、恢复状态和统计由确定性代码完成。

## 4. 实验配置

### 4.1 格式

配置是一个 JSON 文件，`schema` 固定为 `pd-lab-experiment-config.v1`。它只描述“这次实验在这台机器上用什么”，不描述研究设计（研究设计在预注册和 CONTRACT §4 的计划里）。

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `schema` | 是 | 等于 `pd-lab-experiment-config.v1` |
| `experimentId` | 是 | 匹配 `^[a-z0-9][a-z0-9-]*$`；新实验必须与预注册文件 front matter 中的 `experimentId` 一致；历史 `legacy` 配置保留其历史批次 ID，不伪造预注册 |
| `preregistration.file`、`preregistration.sha256` | 新实验必填 | 预注册文件的绝对路径与**原始文件字节** SHA-256（64 位十六进制）；文件顶端 YAML front matter 必须声明同一 `experimentId`。preflight 只读校验存在性、摘要和身份绑定 |
| `baselineArm` / `candidateArm` | 是 | 两臂角色显式声明，见 §4.4 |
| `experimentRoot` | 是 | 绝对路径；规范化后不得位于任何禁止根或任何臂的 worktree 之内 |
| `additionalForbiddenRoots` | 是 | 绝对路径数组，可为空数组；列出本机的生产工作区等 |
| `dataset.file`、`dataset.sha256` | 是 | 全保真数据集及其 SHA-256；不符即拒绝 |
| `snapshot.dir`、`snapshot.sha256.state`、`snapshot.sha256.trajectory`、`snapshot.sha256.blobManifest` | 是 | 快照目录、两个库文件与 Blob Manifest 的 SHA-256；preflight 逐一验证，并按 Manifest 校验每个被引用 Blob 的存在性和哈希 |
| `baseConfigFile` | 是 | 作为派生模板的 PD `config.yaml`；替代直接读取生产工作区 |
| `profileRebind` | 否 | `{ from, to }`；仅历史批次的模型档位替换使用 |
| `arms.<armId>.worktree` | 是 | 绝对路径；两个臂可以指向同一 worktree（同一提交的开关实验） |
| `arms.<armId>.expectedHead` | 是 | 40 位十六进制提交；preflight 与 `git rev-parse HEAD` 比对；两臂都必须提供 |
| `arms.<armId>.featureOverrides` | 否 | `{ <flagId>: boolean }`；写入该臂派生配置的 `features.<flagId>.enabled`；flagId 必须已注册，未注册即拒绝 |
| `arms.<armId>.workspaceFiles` | 否 | `[{ source, target, sha256 }]`；`target` 是相对工作区的路径，不得逃逸，中间目录不得含符号链接 |
| `modelEnv` | 是 | 环境变量名数组；只检查存在，不读取、不记录值 |
| `_note` | 否 | 可选字符串，仅供人阅读；不改变执行语义，但仍属于配置文件字节并计入配置 SHA-256 |
| `legacy` | 仅历史批次 | 严格闭集对象 `{ batch: "prompt-v2-round1" | "dreamer-v21-round2" }`；只启用对应历史批次的专用 preflight 检查，不接受其他属性；新实验禁止声明 |

`armId` 匹配 `^[a-z][a-z0-9]*$`，恰好两个（`baselineArm` 与 `candidateArm`）。除上表明确列出的 `_note`、`legacy` 外，未声明字段一律拒绝。新实验必须提供 `preregistration` 且不得声明 `legacy`；历史回放必须声明上述 `legacy.batch` 且省略 `preregistration`。两种模式互斥，历史回放不得补造或追溯声称存在预注册。`_note` 不参与执行判断，但会随整个配置文件一起进入 SHA-256。配置里不出现凭据。配置文件自身的 SHA-256 与 `preregistration.sha256` 一并记入 run-manifest（§7），使“配置—预注册—运行”三方可对账。

禁止根由代码派生并始终生效，配置只能追加：`os.homedir()` 下的 `.pd`、`.openclaw`、`.codex`；主检出；运行者 shell 里 `PD_WORKSPACE_DIR`、`OPENCLAW_WORKSPACE`、`OPENCLAW_WORKSPACE_DIR`、`PD_STATE_DIR`、`OPENCLAW_HOME` 当前指向的目录；`additionalForbiddenRoots`。

### 4.2 选择与存放

- 每个入口脚本通过 `--config <file>` 接收配置。没有默认值、没有环境变量回退；缺少时以退出码 2 结束并打印用法。
- 含本机真实路径的配置不入库，放在 `experimentRoot` 旁或 `artifacts/pd-lab/<experimentId>/`。
- 入库的只有两类：`scripts/dev/pd-lab/experiment-config.example.json`（占位符样例），以及 `experiment/prompt-v2/configs/` 下记录两轮历史批次原始取值的历史配置。历史配置里的 `D:/...` 路径是历史事实，不是默认值。

### 4.3 派生配置：结构化解析，不做字符串手术

`deriveExperimentConfig` 不得继续用正则修改 YAML 文本。用仓库既有的 YAML 能力（根与 core 依赖均已含 `js-yaml`，`pd-config-validate.ts` 已有从 `unknown` 校验解析结果的做法）结构化处理：

1. 以 `js-yaml` 解析 `baseConfigFile`，得到对象树。
2. 只修改声明过的段：`workspace.default`、`ui` 与 `feedback`（按历史批次语义移除）、`features`（来自该臂的 `featureOverrides`）、`profileRebind` 的绑定引用、`trajectoryRetention`（T0 结论需要时关闭清扫）。
3. 序列化回 YAML 写入臂工作区。

约束：

- 未声明的配置语义**不得改变**：除上述段外，派生结果与模板逐键等价（测试断言）。
- 两臂派生配置的差异**必须能机械验证**：preflight 重新派生两份配置并做结构化 diff，差异只允许出现在声明过的键上；出现任何未声明差异即失败。
- `featureOverrides` 里的 flagId 必须在 feature-flag 权威中已注册；未注册的 flag 拒绝（防止拼错 flag 名造成两臂实际相同的假实验）。
- 模板本身解析失败、包含无法结构化表达的构造时，显式报错，不回退到文本替换。

### 4.4 两臂身份

`baselineArm` 与 `candidateArm` 是实验的唯一角色声明（改动对基线设计的 candidate=改动臂、reference=基线臂在 CONTRACT §4 中映射到这两个字段）：

- 两个臂 ID 必须不同，且都必须存在于 `arms`；两臂都必须有 `expectedHead`。
- 允许两臂指向同一 worktree（同一提交、仅开关不同的实验）；preflight 对同一 worktree 的两臂分别比对同一个 `expectedHead`。
- **所有下游消费同一角色映射**：`ab-run`（记录中的臂角色标注）、`ab-grid`（分片转发的臂集）、`ab-metrics`（替代 `index.v1`/`index.v2` 的字母序配对）、`ab-blindpack`/`ab-blindpack-paired`（替代 `armA='v1'` 默认值）、`ab-dreamer-paired`、`ab-blind-summary`、`ab-eval`（输入包的角色无关性）、`analysis/paired-analysis.mjs`、盲评包 `blindmap.json` 与 `decision-input.json` 全部从配置取角色，不得按字母序、声明顺序或文件名推断 baseline。
- 删除 `baselineArm`/`candidateArm` 声明后，任何入口必须在配置校验阶段失败（这是防止“字母序复活”的负向测试）。

### 4.5 路径安全

`loadExperimentConfig` 与 preflight 的路径校验统一遵循：

- 解析结果一律按 `unknown` 处理，逐字段校验（rc-1）；任何一项失败都收集到 `problems[]` 一并抛出，不部分生效。
- 路径比较先取真实路径再判断包含关系（沿用 `ab-lib.mjs` 中 `canonical()` 的做法，Windows 下转小写）。
- **规范化要穿透不存在路径**：目标目录可能尚不存在（快照目录、实验根）。解析时对**最近的现存祖先**取真实路径（`fs.realpathSync` 于祖先 + 剩余段拼接），再规范化完整路径后做包含判断；不得只依赖目标目录自身的 realpath。
- 覆盖：非存在目录的符号链接父目录、Windows Junction（`lstat` 识别 reparse point）、`workspaceFiles.target` 的中间目录符号链接、`experimentRoot` 与所有臂 worktree 的互相包含关系（实验根不得在任何 worktree 内，worktree 也不得在实验根内）、`runId` 的路径穿越（`runId` 匹配 `^[A-Za-z0-9._-]+$`，拼入路径前再校验一次）、快照与数据集路径必须位于配置声明的位置且规范化后在实验根或归档根内。
- 任何隔离检查失败，必须在**创建实验目录、写入任何数据或启动任何子进程之前**终止（退出非零并列出全部违规项，一次性报告，不部分生效）。

## 5. 数据

### 5.1 快照

快照是只读一致副本，沿用 `snapshot-and-discover.mjs` 的做法：以只读方式打开源库，用 better-sqlite3 的 backup API 生成副本。T1 交付的快照必须包含并验证：

| 内容 | 要求 |
| --- | --- |
| `state.db` | backup API 副本；源与副本 `integrity_check` 均 ok；核心表行数逐一核对 |
| `trajectory.db` | 同上 |
| Blob 文件 | **只复制授权数据范围内实际被引用的 blob**（按库内 `blob_ref` 扫描），不复制无关 orphan 文件；逐文件 SHA-256 |
| `blob-manifest.json` | 逐文件清单（相对路径、字节数、SHA-256、被引用计数）；其整体 SHA-256 记入实验配置 `snapshot.sha256.blobManifest` |
| 引用完整性 | 每个 `blob_ref` 都能解析到 Manifest 中的一个文件且哈希一致；Manifest 中每个文件至少被一个 `blob_ref` 引用（孤儿要么剔除要么注明） |
| README 索引 | 按 AGENTS.md git-16：源路径、时间、文件数、总字节、逐库与 Manifest 哈希 |

**跨源一致性**：两个 SQLite 库与 blob 文件不是同一个原子事务。快照必须定义源端稳定窗口或等效的一致性验证——例如记录快照起止时间、比对两库的“最后写入时间”证据（各自最新的行时间戳）、并在报告中声明该窗口内的写入活动；无法证明跨源一致时，快照标记为 `PARTIAL_CONSISTENCY` 并注明缺口，不得标记为完整一致快照。所有源访问只读；快照只能由 Owner 授权在合法访问生产工作区的机器上执行，不修改生产工作区，不改保留策略。

需要的源码修改：源工作区与输出目录改为必填参数；blob 目录位置以 `resolvePdPath(workspaceDir, 'TRAJECTORY_BLOBS_DIR')` 的解析结果为准；输出落在 `artifacts/pd-lab/snapshots/<日期>/`。preflight 对快照的验证（§4.1）：`state.db`、`trajectory.db`、`blob-manifest.json` 三者哈希逐一比对，并按 Manifest 抽验/全验每个被引用 blob 的存在性和哈希；数据集 SHA-256 与配置文件 SHA-256 一并验证。只验两个库文件不足以认定快照完整。

### 5.2 准入探测

`admission-probe.mjs` 以只读方式打开快照的 `trajectory.db`，对数据集里的每个样本按 `painEvent.session_id` 检查并输出 CONTRACT §2.4 的结果。第一版只覆盖 OpenClaw 轨迹库，检查项为：

| 检查 | 问题代码（CONTRACT §2.4） |
| --- | --- |
| 该会话在 `user_turns` 或 `assistant_turns` 中没有任何行 | `SOURCE_GAP` |
| 会话创建时间早于快照内最早行、`turn_index` 起始值大于 0 或有其他保留证据表明更早的行曾存在（区分规则见 CONTRACT §2.4） | `SOURCE_RETENTION_EXPIRED`；证据不足时记 `SOURCE_GAP` 并在 impact 说明 |
| 轮次带 `blob_ref` 但快照里没有对应 blob 文件 | `TURN_BLOB_MISSING` |
| `blob_ref` 对应文件存在但哈希与 Manifest 不符 | `DIGEST_MISMATCH` |
| `tool_calls.result_preview` 命中 500 字符截断形态 | `TOOL_RESULT_PREVIEW_ONLY` |
| Pain 没有可定位的会话或时间锚点 | `PAIN_ANCHOR_MISSING` |
| `user_turns.turn_index` 不连续且无保留证据 | `SOURCE_GAP` |
| 数据集样本缺期望档案或期望未解决 | `EXPECTATION_UNRESOLVED` |
| 样本的授权引用无效或过期 | `AUTHORIZATION_UNVERIFIED` |

输出只含样本标识、计数和问题代码，不含任何正文，因此探测报告可以入库。库打不开时沿用 `TrajectoryDbUnavailableError` 的语义直接失败，不输出“零问题”。

### 5.3 历史数据与新数据

历史 Prompt V2 的 16 条选择和 106 条库存保留原义。准入探测输出的是新版本资格，不修改历史 digest，也不追溯否定历史实验。

历史 Pain 没有当时的仓库和环境快照，因此只进入管道研究；行为研究使用夹具和前瞻采集（SPEC §6.1）。新增真实样本从授权范围内的信号库存关联轨迹；语义变体标记父来源组。来源分组按 CONTRACT §3：历史数据集的 `caseId` 取 `experimentPainId`，同一 `session_id` 机械同组，跨会话合并需要人工依据。

### 5.4 历史证据边界与最小投影

§2.2 已核验：实验工作区只复制 `trajectory.db`，`state.db` 是新建的；诊断 `fullTrace` 的解析链（`SqliteContextAssembler.buildFullTraceFromSource` → `SourceTraceLocator` → `SqliteTrajectoryLocator`）查询的是 `state.db` 的 `runs`/`tasks` 表。因此**新建实验任务访问不到原始历史任务、运行记录和工具证据**；实验内对历史 Pain 的 `fullTrace` 恒为 null，只有会话轮次经 PRI-350 的 `TrajectoryTurnReader` 回退可见。

规则：

1. **不得为了恢复历史上下文直接复制整份生产 `state.db`**——那会把无关的治理事实、任务与凭据线索带进实验环境。
2. 如实验需要 `fullTrace`，定义**最小化、可验证的历史证据投影**：按入选样本的 Pain 锚点，从生产 `state.db` 只读导出对应的 `tasks`/`runs` 行（不含其他任务），连同行数与哈希进入快照，导入实验工作区。投影的字段范围在预注册声明，导入前后哈希一致。
3. 无法恢复必要证据时：该样本按 CONTRACT §2.4 降级准入资格（`PIPELINE_REPLAY` 视缺口 `BLOCKED` 或记 `SOURCE_GAP`），记录具体缺失原因；**不得把这种运行称为“完整管道重放”**，报告中单列其证据级别。

## 6. 计分、判定与报告

### 6.1 两条统计路径

- **对齐偏好**：胜/平/负，按 CONTRACT §6.1 的层级聚合。这是新的纯计算，由 `alignment-report.mjs` 实现。
- **二元“是否满足期望”**：F∈{0,1,UNKNOWN}，直接调用 `challenge-statistics.mjs` 的 `computeITT`、`computePCR`、`computeFIR`。

两者共享分配身份、来源分组和证据引用，不共享含义模糊的 `score` 字段。0.5 是无实质偏好的平局，不是半次行为失败。`definePrimaryEndpoint` 是封闭的 Examiner 端点集合，新指标不伪装成已有端点。

### 6.2 从现有评审输出到比较结论

`build-decision-input.mjs` 负责适配。历史三值输出（`pairwise.preferred: A|B|tie`）按原义映射进四值协议（tie→TIE，无 UNKNOWN 语义），`ab-eval.mjs` 现有输出格式不因此改动；新协议版本的输出扩展见 §6.6：

1. 从预注册的计划枚举全部比较单元（样本 × 重复 × 主阶段），而不是扫描已有文件。
2. 读 `blindmap.json` 把每条评审的 A/B 还原成臂身份；读评审文件的 `pairwise.preferred`（新协议记录为 `A_BETTER / B_BETTER / TIE / UNKNOWN`）。
3. 交给 `mergeJudgments` 得到每个单元的最终结论；计划内没有评审的单元为 UNKNOWN 并带原因。
4. 读来源组映射（数据集发布里的 `source-groups.json`），交给 `buildAlignmentReport`。
5. 把管道指标（`ab-metrics.mjs` 的输出）原样附上，不参与对齐分数。

### 6.3 判定

判定规则在 CONTRACT §6.5 定义。实现要点：以来源组为单位；只有确定的胜和确定的负计数；UNKNOWN 不帮助任何一方；输出用 `BEHAVIOR_OUTCOMES` 的词汇，并说明补齐未知结果是否可能改变判定。

### 6.4 报告

报告从计划枚举单元。重复运行与技术重试区分：trial 是计划中的随机性观测，attempt 是恢复记录，多次重试不变成多个样本。内部计算使用未舍入值，展示保留一位小数。

输出契约补充（PR #2696 评审整改，2026-11-17 Owner 指令）：`decision-input.json` 中 `decision.groups[]` 是**派生诊断明细**——每组 `[lower_g, upper_g]` 与分类可从计划 + FinalComparison 独立复算（有测试），不是独立统计结果；`rankingQualification` 块如实披露正式排序资格的全部未满足项（`rankingEligible` 在 T4 恒为 false），`evidenceProblems[]` 披露未验证证据（评审记录缺 judge slot/attempt 绑定、比较输入 digest 冲突、证据绑定缺失——这些使单元保持 UNKNOWN，但不使运行失效，CLI 仍 exit 0；结构错误仍非 0）。三层概念严格分离：`ESTIMABLE`（点值可计算）≠ `rankingEligible`（正式排序资格）≠ `decision.outcome`（描述性判定）；Owner 晋级由治理 Gate 决定，不出现在这三个字段里。

2026-11-18 第四轮整改（PR #2696，Owner 指令）：T4 判定实现改为精确有理数聚合与全 BigInt 双侧阈值（数值实现修正，统计规则零改动）；bindings 增加 sourceGroupsDigest（实际生效分组+rationales 的规范化摘要）；计分面限定单候选（多候选计划 fail-closed 拒绝，CANDIDATE_IDENTITY_CONFLICT）；FinalComparison 证据引用与冻结 assignment 矛盾即拒；FAILED attempt 允许无判词（审计保留、不投票）。

`decision-input.json` 是决策卡的唯一数据来源。决策卡是人写的 Markdown，数字必须能在该文件中逐项找到。

归并语义补充（PR #2696 第三次整改：Judge Slot / Attempt 完整性，2026-11-17 Owner 指令；冻结规则见 CONTRACT §5.2a，`mergeJudgments` 逐条实现并有测试）：**Judge Slot 是投票单位**——`requiredJudgments` 按有效且独立席位计，一个 slot 无论落盘多少条 attempt 记录至多贡献一席，attempt 数量永远不能增加席位；T4 的 slot 身份来源是计划级预注册表 `judgeProtocol.judgeSlots` 的**引用完整性验证**（注册/校准属 T7a），无注册表时报告以 `JUDGE_SLOT_REGISTRATION_UNVERIFIED` 披露，`rankingEligible` 恒 false 不放宽。绑定/冲突检查（证据绑定、`comparisonInputDigest` 一致性、slot 存在性/注册比对）在**去重之前**对原始候选集执行，冲突记录进 `evidenceProblems` 并阻断该单元正式判定，绝不按 judgmentId 字典序、时间戳、最大 attempt 或文件顺序挑选保留；同 slot/attempt 的完全相同重复落盘幂等计一票（`DUPLICATE_ATTEMPT_RECORD`），跨 attempt 一致重试归并为一席（`MULTI_ATTEMPT_AGREEMENT`），内容存在任一差异即 `CONFLICTING_ATTEMPT_RECORDS`（该席零票、单元 UNKNOWN）；`attemptStatus: FAILED` 是唯一可审计失败终态，声明失败的尝试不投票并披露（`ATTEMPT_FAILED_EXCLUDED`），无权威失败状态时不得自动择优；`attempt` 缺失不默认 1（`ATTEMPT_MISSING`）。归并与报告对输入顺序不变（乱序输入产生逐字节相同的输出，有 permutation 测试）；`decision.groups[]` 字段名为契约定义的 `lower_g`/`upper_g`（本轮起实现与测试对齐）。统计公式、α/2、k 值表与聚合公式零改动。

### 6.5 evaluationContext：阶段忠实度评价的输入

现状（§2.1）：`ab-run.mjs` 的 `collectArtifacts` 只记录 `LENGTH(output_payload)` 和产物 ID，**不落盘实际阶段输入**，无法支撑“阶段忠实度”维度的盲评。T3/T4 为每个阶段定义并保存 `evaluationContext`：

| 字段 | 内容 |
| --- | --- |
| `stageInputProjection` | 实际阶段输入的受控投影（Stage A 的诊断上下文、Stage B 的 rootcause 输入等），从运行记录/工作区只读提取 |
| `upstreamArtifacts` | 评价该阶段所必需的上游产物引用（digest 绑定） |
| `inputSource` | 每份输入的来源与 digest（来自哪个臂工作区、哪个产物） |
| `timeBoundary` | 输入的截止时点（对齐 SPEC §5.3 投影规则） |
| `missing[]` | 缺失信息及原因（如 §5.4 的历史证据缺口） |
| `truncation` | 截断状态：未截断 / 截断位置 / 是否有损 |

要求：

- **充分性**：盲评包必须能看到足以判断对应评分维度的证据；只给 `LENGTH` 或只给产物 ID 不算充分。
- **防泄漏**：evaluationContext 进入盲评包前必须过与 `ab-blindpack` 同源的泄漏自检，且不得包含：baseline/candidate 臂身份、工作区绝对路径、生产数据库身份、`v1`/`on`/`off` 等臂名词、其他可能揭示实验臂的信息。臂身份只在 `blindmap.json` 侧保存。
- 有损/缺失输入按 CONTRACT §5.1 处理：标记 `lossyInput`，关键证据缺失判 UNKNOWN。

### 6.6 Judge Protocol 版本化与 ab-eval 适配

- **新实验必须绑定版本化 Judge Protocol**（`judgeProtocolRef`），字段与约束按 CONTRACT §5.1（四值判定含 UNKNOWN、UNKNOWN 原因、尝试记录、仲裁引用、输入 digest、显示顺序）。
- **旧历史评审文件与格式保留原义**：`ab-eval.mjs` 现有 `pairwise.preferred: A|B|tie` 三值输出及其历史 eval 文件不追溯修改。新协议版本可以修改评价提示词与输出 schema（增加 UNKNOWN），但不得破坏历史记录的可解析性——解盲汇总等共享消费方按文件内的协议标记分派。
- **9000 字符截断的显式策略**：新协议下，完整输入正常评价；被截断的输入标记 `lossyInput` 并在包内注明截断位置；评分维度所依赖的关键证据落在截断区时，该单元判 UNKNOWN 而非降分。
- **文件头模型说明修正**：`ab-eval.mjs` 头部注释声称使用 OpenRouter `baidu/ernie-5.5-flash-preview:free`，实际代码调用 ZAI `glm-5.3`（`open.bigmodel.cn`，`ZAI_API_KEY`）。T6 前修正注释使其与代码一致；决策卡与协议中显式披露生成器与裁判同族（同模型家族）的限制及其缓解（盲评、位置随机、Owner 抽查 ≥20%）。

## 7. 执行与恢复

- **入口**：根 `package.json` 增加 `lab:preflight`、`lab:run`、`lab:metrics`、`lab:blindpack`、`lab:eval`、`lab:summary`、`lab:card`、`lab:probe`，分别直接指向对应脚本。它们是别名，不是新的编排器；各步之间的人工检查点（模型预算、Owner 抽查）保持显式。
- **Preflight**：通用检查始终执行，包括隔离、每臂 HEAD 等于 `expectedHead`、每臂 `packages/pd-cli/dist/index.js` 存在、数据集与快照哈希（含 Blob Manifest 与被引用 Blob 逐文件验证，§4.1/§5.1）、`modelEnv` 存在、两臂派生配置的结构化 diff 只含声明差异（§4.3）、`baselineArm`/`candidateArm` 角色有效（§4.4）。新实验还必须在创建任务或调用模型前验证 `preregistration.file` 存在、原始字节 SHA-256 等于 `preregistration.sha256`，且 YAML front matter 的 `experimentId` 等于配置值；缺失、摘要不符或身份不符均 fail-closed。`lab:run` 必须在首次写入 run 记录或启动任何子进程前重新执行同一 preflight，并从当前文件重新计算配置与预注册摘要；不得复用过期的预检结果。只有 `legacy.batch` 为两个已登记历史值之一时，才执行该批次对应的冻结 HEAD、prompt fingerprint/source-delta 专用检查；通用检查仍全部执行，不接受任意自定义 legacy 规则。任一失败即非零退出，不建任务、不调用模型。
- **实验工作区**：每臂每分片独立。派生配置必须保证实验工作区不会清扫复制进来的轨迹（是否需要显式关闭取决于 §2.2 的未核验项；配置键见 `resolveTrajectoryRetentionPolicy`）。
- **运行清单**：`run-manifest` 记录 `experimentId`、`configSha256`、`preregistrationStatus` 与 `preregistrationSha256`（新实验为 `VERIFIED` 并记录实际摘要；历史 `legacy` 配置为 `NOT_APPLICABLE_LEGACY` 且摘要为 null）、每臂 HEAD、每臂派生配置 SHA-256、数据集与快照哈希（含 Blob Manifest），替代现在写死的 `heads.v1/v2`。不得只记录预注册路径而省略内容摘要。
- **ingress 运行契约**（修订 `ab-run.mjs`）：
  - `--score` 取数据集 `painEvent.score`，不取 `confidence`；两者语义不同（CLI 校验 0–100，默认 80）。
  - `--reason` 在送入 CLI 前截到 500 字符以内并记录截断事实；CLI 的 `MAX_REASON_LENGTH=500` 超限是硬拒绝，超限样本按数据缺陷处理而非静默截到 4000。
  - **完整轨迹实验中 `--session` 绑定失败（`session_not_found` 等）必须把该样本记为失败**（`ingress_binding_failed`），不得自动降级为无会话 Pain 继续实验——无会话重录改变研究对象的输入类别。只有实验预注册明确包含“无会话臂”时才允许 unbound，且必须显式配置。
  - `--host` 由样本的 `host_kind` 与来源证据决定：`host_kind=openclaw` 且会话证据支持时才用 `openclaw` 入口；`host_kind` 为空的样本不得伪装成 OpenClaw，按其真实来源选择入口或标记不适用。
  - 每个样本记录实际 `ingressMode` 与运行输入 digest（送入 CLI 的参数化输入的 SHA-256），随 run 记录落盘。
  - 分片执行时，臂顺序由**全局样本索引**（在完整数据集中的序号）与冻结的随机种子生成；不得用分片内局部索引，否则分片组合变化会改变同一样本的臂顺序。
- **终态语义**：在现有 `done`/`done-admission-refused`/`incomplete`/`failed` 之外，为合法无候选结果（链路完成但未形成候选）、defer（管道显式延迟）建立独立终态；这些终态不计为 Harness 失败，进入各自的分析分桶。只有真正的执行/基础设施错误才进 `failed`。
- **数据集校验**：`loadDataset()` 的脱敏标记检查扩展到**全部样本**（逐样本探测），不只是第一条。
- **恢复**：沿用现有的每分片记录和租约恢复，不建平行运行状态库。已完成单元不重跑；重试按预注册、对两臂一致的策略执行并保留全部 attempt；判分后不得重跑到满意为止。
- **归档**：`experimentRoot` 是运行现场。引用进决策卡的证据必须先按 AGENTS.md git-16 归档到主检出的 `artifacts/pd-lab/<experimentId>/`（复制、核对文件数与总字节和逐文件哈希、写索引），决策卡引用归档索引和哈希。

无模型预算或无数据授权时，只允许机械验证、合成夹具和离线重算。

## 8. 重构切片与兼容

| 切片 | 第一变化 | 保持不变 | 回滚 |
| --- | --- | --- | --- |
| 特征测试入 CI | harness 现有测试和新增特征测试在 CI 运行 | 被测代码 | 回退测试接线 |
| 配置解耦 | 六个常量和写死路径改为配置 | 两臂命令序列、隔离规则、记录文件格式、历史批次输入 | 回退代码；不删除已产生的运行 |
| 离线计分 | 新增纯归并与聚合 | 二元统计、历史报告、`ab-eval.mjs` 输出 | 撤回新报告，不改历史分数 |
| 快照含 blob | 快照脚本参数化并复制 blob | 既有快照及其哈希 | 回退脚本；新快照保留 |
| harness 迁入 `scripts/dev/pd-lab/` | 仅在出现第二个不同领域的真实实验后进行 | 输出、错误语义、发布边界 | 实现与调用方成组回退 |
| 旧入口退役 | 删除已无调用方的重复入口 | 历史读取能力 | 保留恢复提交与兼容清单 |

每个切片先记录调用方和测试，再修改。源码被历史证据 hash 绑定时，按已有 rebinder 机制处理并证明结果不变，不直接改写历史指纹。

## 9. 验证

- 新增职责的测试放 `scripts/__tests__/pd-lab-*.test.ts`，通过 `loadExperimentConfig`、`buildAlignmentReport` 等真实导出驱动，不测内部辅助函数。
- CLI 参数测试走真实解析入口：以子进程运行脚本并断言退出码与输出。
- 字符串存在性检查只适合文档链接，不证明运行正确。
- 涉及 import 或路径的改动运行 `scripts/__tests__/lab-payload-closure.test.ts`，并补一条负向断言：产品闭包不含 `scripts/dev/pd-lab/` 与 `experiment/`。
- 每个任务的具体命令和预期结果见 HANDOFF。

本技术文档不增加可执行代码。实施任务各自填写实际的 Complexity Delta，不能继承本文的 NO。
