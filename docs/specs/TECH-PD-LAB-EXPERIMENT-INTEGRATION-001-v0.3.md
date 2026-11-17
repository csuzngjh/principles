# TECH-PD-LAB-EXPERIMENT-INTEGRATION-001 v0.3

## 状态与阅读入口

设计状态：DRAFT。本文是 [SPEC v0.3](SPEC-PD-LAB-EXPERIMENT-INTEGRATION-001-v0.3.md) 的技术分解，不是实现记录，也不授权任何真实运行。

源码核验提交：`4388fe6d1`（已合入 main `b759f3ee0`，2026-11-17）。§2 的每一行都在该提交读过源码；标注“未核验”的条目必须由实施者先核验再动手。

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
| `ab-lib.mjs` `deriveExperimentConfig(wsPath)` | 读取**生产工作区**的 `.pd/config.yaml` 作模板；删除 `ui:` 之后的段；重映射 `workspace.default`；开启 `diagnostician_async_cli`；把 `pi-ai.amd-ds-vision` 绑定替换为 `pi-ai.glm`；关闭六个非学习链 agent | 没有按臂覆盖功能开关的能力；模型档位替换是历史批次特有逻辑 |
| `ab-lib.mjs` `materializeWorkspace(arm)` | 在 `EXPERIMENT_ROOT/workspaces/<arm>[-s<shard>]` 建 `.pd/`、`.state/`，把快照的 `trajectory.db` 整库复制进去，写派生配置；用临时文件加 rename 原子落位 | 没有向工作区放入额外文件（如 INTENT 文档）的能力 |
| `ab-lib.mjs` `runPd(arm, args)` | 以 `<worktree>/packages/pd-cli/dist/index.js` 起子进程，追加 `--workspace <ws> --json`，环境经 `childEnv()` 清除五个工作区指针变量后注入 `PD_WORKSPACE_DIR` | 臂等于“一个 worktree 的 dist”，两臂共用同一提交时需允许共用 worktree |
| `ab-lib.mjs` `loadDataset()` | 只接受全保真数据集；文件缺失或带脱敏标记即抛错，没有回退到公开副本 | 保留此行为 |
| `ab-run.mjs` | 每臂每分片依次执行 `pd pain record` → `pd diagnose run` → 循环 `pd runtime internalization run-once --runner dreamer\|philosopher\|scribe`；记录落在 `runs/<runId>/records/<sample>.<arm>[.repN].json` | 这条链正是 PR #2684 接入 Reader 的入口（`packages/pd-cli/src/commands/{pain-record,diagnose}.ts`） |
| `ab-grid.mjs` | 把样本切成最多 8 个分片并行跑 `ab-run`；任一分片非零退出则整体失败；`--arms` 默认 `v1,v2` | 臂名默认值要改成必填 |
| `ab-metrics.mjs` | 用正则 `^([^.]+)\.(v1\|v2)(?:\.rep(\d+))?\.json$` 解析记录；按 (样本, 阶段, 重复) 配对，缺一侧进 `missing` | 臂名写死在正则里 |
| `ab-blindpack.mjs` / `ab-blindpack-paired.mjs` | 生成匿名评审包和独立的 `blindmap.json`；A/B 顺序随机并固定；组包后做泄漏自检 | 每个包只有一种显示顺序，没有位置交换 |
| `ab-eval.mjs` | 调用 `open.bigmodel.cn` 的 `glm-5.3`，需要 `ZAI_API_KEY`；输出含 `pairwise.preferred: A\|B\|tie` | 文件头注释写的是另一个模型，以代码为准；裁判与生成器同族 |
| `ab-blind-summary.mjs` | 从 `blindmap.json` 发现臂名并解盲汇总 | 已不写死臂名，可直接复用 |
| `ab-preflight.mjs` | 六项检查，其中“V1 臂 HEAD 等于基线提交”“两臂代码差异恰为 7 个 prompt 层文件”是 Prompt V2 批次特有 | 通用检查与批次特有检查要分开 |
| `analysis/owner-spotcheck-list.mjs` | 确定性抽取 20% 评审包给 Owner 盲审，答案表另存 | Owner 校准可复用 |
| `analysis/paired-analysis.mjs` | 正则写死 `(v2c\|v21)`；默认 run 为 `paired-2`、`grid-3` | 历史批次专用，只做路径参数化 |

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
| 生产诊断输入由 `SqliteContextAssembler` 构造：优先已晋升的证据窗口，否则经 `TrajectoryTurnReader` 按 `sessionIdHint` 回退读轨迹；窗口超过 `maxConversationEntries` 时只保留最近的条目 | `packages/principles-core/src/runtime/store/context/sqlite-context-assembler.ts` | “源里有完整轨迹”不等于“模型看到了完整轨迹” |
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
| `scripts/dev/pd-lab/alignment-report.mjs` | `mergeJudgments(input)`、`buildAlignmentReport(input)` | 裁判记录归并；按计划聚合、算缺失界、给出判定。纯函数，无 I/O | `build-decision-input.mjs` |
| `scripts/dev/pd-lab/build-decision-input.mjs` | CLI | 读取一次运行的计划、评审结果和管道指标，写出 `decision-input.json` | `npm run lab:card` |
| `scripts/dev/pd-lab/admission-probe.mjs` | CLI | 只读打开快照，对每个样本输出准入结果和问题代码，不输出正文 | `npm run lab:probe` |

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
| `experimentId` | 是 | 匹配 `^[a-z0-9][a-z0-9-]*$`；与预注册文件一致 |
| `experimentRoot` | 是 | 绝对路径；规范化后不得位于任何禁止根或任何臂的 worktree 之内 |
| `additionalForbiddenRoots` | 是 | 绝对路径数组，可为空数组；列出本机的生产工作区等 |
| `dataset.file`、`dataset.sha256` | 是 | 全保真数据集及其 SHA-256；不符即拒绝 |
| `snapshot.dir`、`snapshot.sha256.state`、`snapshot.sha256.trajectory` | 是 | 快照目录及两个库文件的 SHA-256 |
| `baseConfigFile` | 是 | 作为派生模板的 PD `config.yaml`；替代直接读取生产工作区 |
| `profileRebind` | 否 | `{ from, to }`；仅历史批次的模型档位替换使用 |
| `arms.<armId>.worktree` | 是 | 绝对路径；多个臂可以指向同一 worktree |
| `arms.<armId>.expectedHead` | 是 | 40 位十六进制提交；preflight 与 `git rev-parse HEAD` 比对 |
| `arms.<armId>.featureOverrides` | 否 | `{ <flagId>: boolean }`；写入该臂派生配置的 `features.<flagId>.enabled` |
| `arms.<armId>.workspaceFiles` | 否 | `[{ source, target, sha256 }]`；`target` 是相对工作区的路径，不得逃逸 |
| `modelEnv` | 是 | 环境变量名数组；只检查存在，不读取、不记录值 |

`armId` 匹配 `^[a-z][a-z0-9]*$`，至少两个。未声明的字段一律拒绝。配置里不出现凭据。

禁止根由代码派生并始终生效，配置只能追加：`os.homedir()` 下的 `.pd`、`.openclaw`、`.codex`；主检出；运行者 shell 里 `PD_WORKSPACE_DIR`、`OPENCLAW_WORKSPACE`、`OPENCLAW_WORKSPACE_DIR`、`PD_STATE_DIR`、`OPENCLAW_HOME` 当前指向的目录；`additionalForbiddenRoots`。

### 4.2 选择与存放

- 每个入口脚本通过 `--config <file>` 接收配置。没有默认值、没有环境变量回退；缺少时以退出码 2 结束并打印用法。
- 含本机真实路径的配置不入库，放在 `experimentRoot` 旁或 `artifacts/pd-lab/<experimentId>/`。
- 入库的只有两类：`scripts/dev/pd-lab/experiment-config.example.json`（占位符样例），以及 `experiment/prompt-v2/configs/` 下记录两轮历史批次原始取值的历史配置。历史配置里的 `D:/...` 路径是历史事实，不是默认值。

### 4.3 校验规则

`loadExperimentConfig` 对解析结果按 `unknown` 处理，逐字段校验。路径比较一律先取真实路径（沿用 `ab-lib.mjs` 中 `canonical()` 的做法，Windows 下转小写），再判断包含关系，以拒绝经 junction 或符号链接逃逸。任何一项失败都收集到 `problems[]` 一并抛出，不部分生效。

## 5. 数据

### 5.1 快照

快照是只读一致副本，沿用 `snapshot-and-discover.mjs` 的做法：以只读方式打开源库，用 better-sqlite3 的 backup API 生成副本，对源和副本都做 `integrity_check`，核对表行数。需要的修改只有三项：

1. 源工作区通过参数传入，不写死。
2. 把轨迹 blob 目录一并复制，并在报告中记录文件数、总字节数和逐文件哈希。blob 目录的实际位置以 `resolvePdPath(workspaceDir, 'TRAJECTORY_BLOBS_DIR')` 的解析结果为准。
3. 输出目录通过参数传入；落在 `artifacts/pd-lab/snapshots/<日期>/`，并按 AGENTS.md git-16 写索引 `README.md`。

快照只能在能合法访问生产工作区的机器上由 Owner 授权执行。它不修改生产工作区，不改保留策略。

### 5.2 准入探测

`admission-probe.mjs` 以只读方式打开快照的 `trajectory.db`，对数据集里的每个样本按 `painEvent.session_id` 检查并输出 CONTRACT §2.4 的结果。第一版只覆盖 OpenClaw 轨迹库，检查项为：

| 检查 | 问题代码（CONTRACT §2.4） |
| --- | --- |
| 该会话在 `user_turns` 或 `assistant_turns` 中没有任何行 | `SOURCE_GAP` |
| 该会话在快照里最早的一行晚于 Pain 触发时间（之前的行已不在快照里） | `SOURCE_RETENTION_EXPIRED` |
| 轮次带 `blob_ref` 但快照里没有对应 blob 文件 | `TURN_BLOB_MISSING` |
| `tool_calls.result_preview` 命中 500 字符截断形态 | `TOOL_RESULT_PREVIEW_ONLY` |
| Pain 没有可定位的会话或时间锚点 | `PAIN_ANCHOR_MISSING` |
| `user_turns.turn_index` 不连续 | `SOURCE_GAP` |

输出只含样本标识、计数和问题代码，不含任何正文，因此探测报告可以入库。库打不开时沿用 `TrajectoryDbUnavailableError` 的语义直接失败，不输出“零问题”。

### 5.3 历史数据与新数据

历史 Prompt V2 的 16 条选择和 106 条库存保留原义。准入探测输出的是新版本资格，不修改历史 digest，也不追溯否定历史实验。

历史 Pain 没有当时的仓库和环境快照，因此只进入管道研究；行为研究使用夹具和前瞻采集（SPEC §6.1）。新增真实样本从授权范围内的信号库存关联轨迹；语义变体标记父来源组。

## 6. 计分、判定与报告

### 6.1 两条统计路径

- **对齐偏好**：胜/平/负，按 CONTRACT §6.1 的层级聚合。这是新的纯计算，由 `alignment-report.mjs` 实现。
- **二元“是否满足期望”**：F∈{0,1,UNKNOWN}，直接调用 `challenge-statistics.mjs` 的 `computeITT`、`computePCR`、`computeFIR`。

两者共享分配身份、来源分组和证据引用，不共享含义模糊的 `score` 字段。0.5 是无实质偏好的平局，不是半次行为失败。`definePrimaryEndpoint` 是封闭的 Examiner 端点集合，新指标不伪装成已有端点。

### 6.2 从现有评审输出到比较结论

`build-decision-input.mjs` 负责适配，不改 `ab-eval.mjs` 的输出格式：

1. 从预注册的计划枚举全部比较单元（样本 × 重复 × 主阶段），而不是扫描已有文件。
2. 读 `blindmap.json` 把每条评审的 A/B 还原成臂身份；读评审文件的 `pairwise.preferred`。
3. 交给 `mergeJudgments` 得到每个单元的最终结论；计划内没有评审的单元为 UNKNOWN 并带原因。
4. 读来源组映射（数据集发布里的 `source-groups.json`），交给 `buildAlignmentReport`。
5. 把管道指标（`ab-metrics.mjs` 的输出）原样附上，不参与对齐分数。

### 6.3 判定

判定规则在 CONTRACT §6.5 定义。实现要点：以来源组为单位；只有确定的胜和确定的负计数；UNKNOWN 不帮助任何一方；输出用 `BEHAVIOR_OUTCOMES` 的词汇，并说明补齐未知结果是否可能改变判定。

### 6.4 报告

报告从计划枚举单元。重复运行与技术重试区分：trial 是计划中的随机性观测，attempt 是恢复记录，多次重试不变成多个样本。内部计算使用未舍入值，展示保留一位小数。

`decision-input.json` 是决策卡的唯一数据来源。决策卡是人写的 Markdown，数字必须能在该文件中逐项找到。

## 7. 执行与恢复

- **入口**：根 `package.json` 增加 `lab:preflight`、`lab:run`、`lab:metrics`、`lab:blindpack`、`lab:eval`、`lab:summary`、`lab:card`、`lab:probe`，分别直接指向对应脚本。它们是别名，不是新的编排器；各步之间的人工检查点（模型预算、Owner 抽查）保持显式。
- **Preflight**：通用检查始终执行，包括隔离、每臂 HEAD 等于 `expectedHead`、每臂 `packages/pd-cli/dist/index.js` 存在、数据集与快照哈希、`modelEnv` 存在、派生配置只在声明的 `featureOverrides` 上不同。Prompt V2 批次特有的两项检查只在历史配置声明对应字段时执行。任一失败即非零退出，不建任务、不调用模型。
- **实验工作区**：每臂每分片独立。派生配置必须保证实验工作区不会清扫复制进来的轨迹（是否需要显式关闭取决于 §2.2 的未核验项；配置键见 `resolveTrajectoryRetentionPolicy`）。
- **运行清单**：`run-manifest` 记录配置文件的 SHA-256、每臂 HEAD、每臂派生配置的 SHA-256、数据集与快照哈希，替代现在写死的 `heads.v1/v2`。
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
