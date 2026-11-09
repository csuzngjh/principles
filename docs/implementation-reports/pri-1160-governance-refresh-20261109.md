# PRI-1160 治理材料复核与补缺（2026-11-09 接手轮）

- 文档 ID：`pri-1160-governance-refresh-20261109`
- **结论：KEEP_NATIVE · 治理材料待 Owner 裁决。治理后复测 NOT RUN。**
- 性质：读取、分析、文档、离线基线。治理写入 0、生产配置变更 0、宿主启动 0、模型调用 0、Console 操作 0。
- 依据：已推送提交 `2308a677d`（分支 `ai/PRI-1105-aa-b-optional-trim`）中的逐条清单 `pri-1160-legacy-four-governance-20261109.md`、冻结基线 `pri-1160-retest-baseline-pre-20261109.json`、复测脚本 `scripts/dev/aa-selector/pri1160-legacy-retest.mjs`、检查点 `20261109T1440Z-zcode-pri1160`。本文只补缺，不改写原材料；冻结样本、历史结果与 `LATEST.json` 均未改动。

## 1. 原材料复核

| 任务要求的字段 | 原清单位置 | 复核结论 |
|---|---|---|
| principleId、来源及证据、当前用途、实际装配、重叠、停用损失、恢复、推荐与理由 | §1 总表、§2 逐条 | 完整，标注了事实/推断/未知 |
| artifact / activation | §3 只给出激活 ID 的构成规则；JSON 按设计只存哈希 | **缺口**：恢复命令需要 artifactId 实值 → 本文 §4 |
| 当前状态与历史快照分开报告 | 只用了 13:21Z 快照 | **缺口**：接手时未重核 → 本文 §2 |
| 基线固定预算、轮转与输入 | §4 与脚本 `ROUNDS` | 完整；可复现性此前未验证 → 本文 §3 |
| 复测报告「关键约束是否仍在」 | 脚本 `compare()` 只报告原则在场性 | **缺口**：合并或修订路径的内容级保留未覆盖 → 本文 §5 |
| Console 定位与操作 | §3 | 完整（代码核实，界面未实点）；本文 §4 补全带实值的深链与命令 |
| Token | §4 标 NOT RUN | 维持：仓库内没有与生产所用模型对应的可靠 tokenizer |

## 2. 当前状态复核：与 13:21Z 快照一致

- 新快照：2026-11-09T15:04:21Z 复制生产 `state.db` 与 `config.yaml`。复制前后 WAL 均为 0 字节；源文件 sha256 复制前后一致，副本相同（`24c6e36c0e85…`）。
- 全库哈希与 13:21Z（`830fbd24b8ab…`）不同。五张治理表逐行摘要（行序无关）全部相等：`activations` 32 行、`approvals` 57 行、`activation_decisions` 3 行、`activation_control_states` 2 行、`pi_artifacts` 1192 行。差异来自非治理表的正常写入。
- 治理读入口（`readPromptActivationCandidates`）：prompt 激活 18 条 = owner 14 + system_policy 4，读取告警 0。四条仍为 system_policy，基础序位 1、2、3、5。
- 结论：当前激活与历史快照一致，无需拆开报告。Owner 尚未在 Console 操作（PRI-1160 最后更新 14:46Z，之后无治理表变化）。

## 3. 冻结基线可复现性：逐轮哈希完全一致

- 装配代码：`8a791cfcfb`（基线所用 main）到当前 main `e7c7e6bba` 之间，`packages/host-runtime/src`、`packages/principles-core/src`、`packages/openclaw-plugin/src` 只有 `runtime/adapter/pi-ai-http-transport.ts` 一处改动，与装配无关。共享装配入口与渲染逻辑逐字节未变。
- 用同一脚本、同一 20 轮，在 15:04Z 快照的沙箱副本上重跑 PRE：总字符 **81,364 → 81,364**；20/20 轮的 `finalSha256`、`finalChars`、`policy`、`includedPidHashes`、`droppedCount` 全部相等；原则映射（哈希 → 块长、授权、激活哈希）相等；沙箱元数据相等。
- 结论：冻结基线既是历史基线，也是当前治理前的普通 Native 状态。治理后复测直接与该冻结文件比较。基线来自现行共享装配入口；历史 188 条走退役的列表路由，只用于解释预算占用的来源，不用于判断当前收益。

## 4. 操作员 ID 表与可执行命令（补缺）

| 编号 | Console 标题（= principleId） | activationId | artifactId | 序位 | 授权 |
|---|---|---|---|---|---|
| L1 | 意图缺口即风险信号：方向性产出前先澄清并以小样验证 | `act_prompt_意图缺口即风险信号：方向性产出前先澄清并以小样验证` | `pi-art-scribe-584f27d7-6b43-4676-942e-e6224dac7d83-prompt-run_scribe-584f27d7-6b43-4676-942e-e6224dac7d83-prompt_1` | 1 | system_policy |
| L2 | Owner 约定持久化并在阶段开工与生成类行动前强制召回比对 | `act_prompt_Owner 约定持久化并在阶段开工与生成类行动前强制召回比对` | `pi-art-scribe-2dce0671-76fe-4938-8758-107afffeae45-prompt-run_scribe-2dce0671-76fe-4938-8758-107afffeae45-prompt_1` | 2 | system_policy |
| L3 | 约定召回门：Owner 约定首次表达即持久化，阶段切换或敏感操作前强制召回校验 | `act_prompt_约定召回门：Owner 约定首次表达即持久化，阶段切换或敏感操作前强制召回校验` | `pi-art-scribe-4c5140d6-2946-4fa9-82af-8dc8aea59693-prompt-run_scribe-4c5140d6-2946-4fa9-82af-8dc8aea59693-prompt_1` | 3 | system_policy |
| L4 | 指令模糊时先确认意图边界，采用最保守的最小删减变更 | `act_prompt_指令模糊时先确认意图边界，采用最保守的最小删减变更` | `pi-art-scribe-6b88216c-319e-448d-9723-4c2750971484-prompt-run_scribe-6b88216c-319e-448d-9723-4c2750971484-prompt_1` | 5 | system_policy |

以上 ID 由治理读入口在 15:04Z 副本上读出，并与前一轮本地清单 `legacy-items.tsv` 逐项比对一致。这些只是关联标识，不含原则正文、凭据或路径。

- **定位**：Console「生效情况」`/activation?activationId=<上表 activationId 经 encodeURIComponent>`。页面读取 `activationId` 查询参数，滚动到对应卡片（`packages/pd-console/src/ui/pages/activation/ActivationPage.tsx:655`）。
- **停用**：在卡片上点「停用」并确认（`POST /api/activations/:id/disable`，`confirmed=true`）。
- **停用后恢复（L1、L3、L4）**：先预演 `pd runtime activation dispatch -a <上表 artifactId> -w "D:\.openclaw\workspace"`（默认 dry-run，不写入）；确认结果后加 `--confirm` 入队；再到 Console「治理焦点」`/focus` 批准。恢复后为 owner 授权，激活 ID 重新生成，装配顺序移到末尾，块长减 8。参数以 `packages/pd-cli/src/commands/runtime-activation.ts:1853-1872` 为准。
- **L2 没有正式恢复途径**：派发会被身份闸门以 `candidate_kind_invalid` 拒绝。处理方法见原清单 §2 的「合并备选」。

## 5. 关键约束检查清单（补缺；治理前事先登记）

脚本 `compare()` 的比较规则保持冻结，不作改动。以下各项从其输出字段读取，K3 需人工核对：

| 编号 | 检查项 | 判据 |
|---|---|---|
| K1 | 非受治理原则没有被挤出 | 每轮 `removedOther` 为空。若非空，逐条说明原因。预期只有重排序会引起，例如恢复项移到末尾后，FIFO 轮次发生换位 |
| K2 | 保留项的块变化只来自授权属性 | `keptBlockChangeChars` 每条只能是 0 或 −8（system_policy 改为 owner 时，授权属性变化带来 −8）。出现其他数值即视为正文变化，需要核对 |
| K3 | 合并路径的内容保留（仅当 Owner 选择 L2→L3 合并） | L3 新版正文须包含 L2 的三个独有要点：纠正过的行为也要持久化；新任务开工也触发召回；发现偏差即暂停。同时保留 L3 自身「以当前指令为准」的规则。对照新版正文逐点勾选 |
| K4 | 没有治理范围之外的新增激活 | `hardAnomalies` 为空 |
| K5 | 停用项确实已不在场 | 被停用项不出现在任一轮的 `includedPidHashes` 中，且 `governedItems[].presentNow=false` |

## 6. 逐条裁决（沿用原清单推荐，列明信息缺口）

| 编号 | 推荐 | 理由（详见原清单 §2） | 信息缺口 | 为何不改判为「停用」或「信息不足」 |
|---|---|---|---|---|
| L1 | **保留** | 唯一覆盖「意图缺口时先澄清或先出小样」这一主题；与 Owner 原则的正文重合不超过 0.055 | 对 Agent 决策的行为价值未知 | 停用需要正面证据，即内容可省或有害。缺少证据不构成停用理由。保留是可逆的现状 |
| L2 | **保留**（附合并备选） | 有三个独有要点；停用后**不可恢复** | 行为价值未知；与 L3 同源，部分重叠 | 不可逆的一步必须放在最后。如需去重，先修订 L3 并批准，再停用 L2 |
| L3 | **保留** | 提供约定召回门，并带有冲突处理规则；可恢复，也可修订 | 行为价值未知 | 同 L1 |
| L4 | **保留** | 覆盖非破坏性的模糊指令；与 Owner 原则只部分重叠，不能互相替代 | 行为价值未知；激活与 Phase B 切换的先后未知 | 同 L1 |

**未来策略候选：未发现。** 没有任何场景级证据表明某条原则只适合在特定场景省略：本轮没有行为数据，也没有逐场景的相关性数据。L2 与 L3 的重叠是内容去重问题，按治理合并路径处理，不作为策略候选。

## 7. 治理后复测（NOT RUN）：一次性执行步骤

前提是 Owner 已在正式 Console 完成全部决定。**若四条全部保留**：治理表不会变化，直接记录 `KEEP_NATIVE` 收口，不需要复测。否则按以下步骤执行一次：

1. **取快照**：按一致性守卫复制生产 `state.db` 与 `config.yaml` 到沙箱。WAL 须为 0，源哈希在复制前后须一致；不满足就重取，不要用不一致的副本。
2. **准备清单**：使用 `D:\Code\principles\artifacts\pri-1160\legacy-items.tsv`。也可以按 §4 表重建，每行三列，用制表符分隔：activationId、artifactId、principleId 哈希。脚本只按第 3 列识别受治理项。
3. **运行**（工作树根目录，host-runtime 已构建）：
   `node scripts/dev/aa-selector/pri1160-legacy-retest.mjs --ws <沙箱> --items <清单> --pre docs/implementation-reports/pri-1160-retest-baseline-pre-20261109.json --out <治理后报告.json>`
4. **报告**：分列以下各项，任一项不得合并或省略：
   - 旧内容减少：`oldContentReductionChars`。
   - 补位：`refillChars` 与 `added`。
   - 最终正文净变化：`netFinalChange`。
   - K1–K5 逐项结论。
   - 每轮会计恒等式。
   - Token：NOT RUN，仓库内没有对应生产模型的可靠 tokenizer。
   - 只用现行共享入口的结果判断当前收益。

## 8. 命令、结果与证据路径

| 项 | 命令或路径 | 结果 |
|---|---|---|
| 一致性快照 | 生产 `D:\.openclaw\workspace\.pd\{state.db,config.yaml}` → `D:\Code\_worktrees\principles\PRI-1160-governance-refresh\.tmp\pri-1160-refresh\snap\.pd\` | WAL 0/0；源哈希复制前后一致；副本 `24c6e36c0e85…` |
| PRE 重跑 | `node scripts/dev/aa-selector/pri1160-legacy-retest.mjs --ws .tmp/pri-1160-refresh/pre-ws-1504z --items .tmp/pri-1160-refresh/legacy-items.tsv --out .tmp/pri-1160-refresh/pre-1504z.json` | `ok`，20 轮，四条均为 system_policy |
| 对比 | `node .tmp/pri-1160-refresh/refresh-compare.mjs` → `.tmp/pri-1160-refresh/refresh-compare.json` | 可复现：是；轮差 0；原则差 0；治理表全等：是 |
| 冻结基线（已提交） | `docs/implementation-reports/pri-1160-retest-baseline-pre-20261109.json` | 81,364 字符 / 20 轮 |
| 复测脚本（已提交） | `scripts/dev/aa-selector/pri1160-legacy-retest.mjs` | 比较规则冻结，未改 |
| 逐条清单（已提交） | `docs/implementation-reports/pri-1160-legacy-four-governance-20261109.md` / `.json` | 未改 |
| 受治理项清单（保留到会话之外） | `D:\Code\principles\artifacts\pri-1160\legacy-items.tsv`（附 README） | 与读取器逐项一致 |
| 前一轮本地原始证据 | `D:\Code\_worktrees\principles\PRI-1105-aa-b-optional-trim\.tmp\pri-1160\` | 只读复制，未写入 |

本轮原始副本（含生产库副本）只保留在本工作树 `.tmp/` 中，不提交、不外传。