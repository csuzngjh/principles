# Evidence Foundation Phase 0 Audit — 当前能力盘点与最小修改点

> **PRI-685**（SPEC: PD Pipeline Evolution Evidence Foundation v1.0）Phase 0 产出。
> 基线 = origin/main `13401a6de`（PR #1515 合并后）。所有事实均对当前仓库与
> `D:\pd-labs\`（PRI-653 真实实验数据留存）核实，非 SPEC 假设。

## 1. 当前 Lab 已有什么（Implementation Truth）

| 资产 | 位置 | 状态 |
|---|---|---|
| 确定性夹具 a–e（公式种子） | `scripts/dev/pipeline-closure-lab/scenarios/` + `generate.mjs` | 入仓，byte-exact |
| 机械断言 + 行为参考基线 | closure-lab `GROUND_TRUTH.md`（A/B 两层分离） | 入仓 |
| 取证查询 runbook（人读） | closure-lab `FORENSICS.md` §1–5 | 入仓 |
| 取证自动化（机器版） | `scripts/dev/pipeline-evolution/collect-evidence.mjs`（452 行，`npm run dev:evolution-evidence`） | 入仓，只读 DB |
| 演化场景契约（ExperienceScenario） | `docs/pipeline-evolution/scenarios/S001–S005.md`（YAML frontmatter + 固定章节） | 入仓，纯文档 |
| 运行协议 + 指标定义 | `docs/pipeline-evolution/README.md`（能力矩阵 / failureLayer / 版本比较口径） | 入仓 |
| 实验报告惯例 | `reports/first-run-report.md`、`reports/2026-09-05-round2-report.md` | **手写** |
| 真实实验数据 | `D:\pd-labs\pri653-e1|r2|r2b`（state.db + trajectory.db + evidence 快照） | 本机留存，可复算 |

collector 现有能力（读 `state.db` + `trajectory.db` + telemetry，全部只读）：
per-chain 阶段表（task 级 status/bucket/attempts）、能力矩阵（PASS/FAIL/UNKNOWN/
PENDING/BLOCKED_OWNER，**UNKNOWN 保留纪律已实现**）、failureLayer 归因、
approvals/activations 计数、trajectory sessions/pains/toolCalls、对抗门事件（≤20）。

## 2. SPEC 与现状对照（哪些已存在 / 哪些是缺口）

| SPEC 条目 | 现状 | 判定 |
|---|---|---|
| §6 Experiment Manifest | 报告头部手写表格（PD sha / 插件版本 / OpenClaw / 模型 / flags / workspace——字段面已定义） | **缺口**：机器化生成+消费 |
| §7 Evidence Package 目录 | 单个 JSON/MD 输出（`--json` / `--out`） | **缺口**：manifest+index+trace+metrics+report 一体化 |
| §8 Evidence Index（claim→evidence，CONFIRMED/NOT_CONFIRMED/UNKNOWN/BLOCKED/INVALID） | 无 | **缺口**（核心增量） |
| §9 Pipeline Trace | `chains[].stages`（task 级 trace）已存在 | **部分存在**：缺 artifactId/evidence 关联字段 → 增强 |
| §10 Pipeline Execution Metrics | `capabilityMatrix` 语义已对齐（证据先行、UNKNOWN 保留） | **部分存在**：缺指标矩阵文件化 |
| §10 Governance Metrics | 完全没有（正确拒绝/审批等待/修复触发未统计） | **缺口** |
| §10 Behavior Metrics | collector 恒 UNKNOWN（Phase-4 行为验证独立执行） | **部分存在**：缺 NOT_REACHED/INCONCLUSIVE 词表化 |
| §11 数据绑定完整性（session→…→activation 关联校验） | 链路 join 已实现（candidate.task_id → diagnosis_<painId>）；无完整性判定输出 | **缺口**：evidence_integrity |
| §12.1 `--experiment` | 无 | **缺口** |
| §12.2 按实验过滤（禁"最近10条"fallback） | fallback = 最近 10 correlation / 10 candidates / 10 pains | **缺口**（SPEC 点名的现状） |
| §12.3 截断标记 | bound 已存在（clip 200 / LIMIT 200/10）但**无 truncated 标记** | **缺口**：标记 |
| §13 Artifact 导出副本（sourceId/hash/schemaVersion/createdAt） | 无导出 | **缺口** |
| §14 Checkpoint 收缩语义 | closure-lab `generate.mjs` canonical/deploy 模式 = 测试输入快照，无"checkpoint=成功"语义 | **已满足**（文档确认即可） |
| §15 Owner Review Card 自动生成 | 手写报告 | **缺口** |
| AC1–AC5 | AC1 字段面有/格式无；AC2 部分（无 claim 层）；AC3 已实现（UNKNOWN 纪律）；AC4 部分；AC5 数据在、工具无 | 见上 |

**ExperienceScenario / closure-lab / collect-evidence 三个既有资产全部保留复用，零重复建设。**
本 SPEC 与 PRI-634-F closure-harness SPEC 的 Phase 2「round recorder」是同一演进方向——
该 Phase 2 从未实施，故本 SPEC 是**真缺口**而非重复。

## 3. SPEC 与代码不一致处（设计修正，不盲目实现）

1. **`--experiment <裸ID>` 不可实现**（SPEC §12.1 示例）。仓库没有实验注册表
   （Evolution Case Registry 是 SPEC 自身的 Phase 2 非目标），裸 experimentId 无法定位
   任何数据。修正为 `--experiment <experiment-manifest.json 路径>`——manifest 即实验
   的定义与归属权威（P4；metadata authority，非运行事实权威——运行事实仍归
   state.db/trajectory.db/telemetry 所有，冲突时以存储为准）。
2. **状态词表分层**。SPEC §8 词表（CONFIRMED/NOT_CONFIRMED/…）与 collector 既有
   bucket（PASS/FAIL/UNKNOWN/PENDING/BLOCKED_OWNER）是**两层不是一层**：bucket 是
   task 事实层（绑定 `tasks.status` 语义，保留不动），claim status 是结论层（evidence
   index 用 SPEC 词表，从事实+证据映射）。PENDING ≠ UNKNOWN（进行中不是未知）。
3. **Pipeline 指标允许 UNKNOWN 逃逸**（SPEC §10 表格只写 PASS/FAIL 的行）。链在
   前置阶段死亡时（如 artificer timeout 后）"Replay executed" 强判 FAIL 正是 SPEC
   Problem 2 反对的语义过度推断——改为 PASS/FAIL/**UNKNOWN**（AC3 优先）。
4. **artifacts/ 与 telemetry/ 导出有界**。全量导出会复制无界 telemetry；按实验链
   过滤后的 pi_artifacts 副本 + 既有 ≤20 对抗事件导出即可（§13"允许导出副本"的
   最小读法）。
5. **§6 manifest 的 host/model/flags 不可全自动抓取**（OpenClaw 版本、会话模型是
   实验环境知识）。init 工具自动抓 PD 侧（git sha / package 版本），其余字段由
   operator 按 Phase 0 快照惯例填——与现行报告纪律一致，不发明环境探测。

## 4. 最小修改点

```
scripts/dev/pipeline-evolution/
├── collect-evidence.mjs            [改] --experiment <manifest> 过滤（session→pain→
│                                        candidate→correlation 绑定 + 时间窗）、
│                                        truncated 标记、--package <dir> 一体化输出
├── init-experiment.mjs             [新] manifest 生成小工具（自动抓 PD sha/版本，
│                                        模板含 SPEC §6 全字段）
└── lib/evidence-package.mjs        [新] 纯函数库：evidence index（claim→evidence +
                                        evidenceIntegrity）、metrics（pipeline/
│                                        governance/behavior 三层）、pipeline trace、
│                                        Owner Review report 渲染（确定性，同 JSON 同报告）

scripts/__tests__/
└── pipeline-evolution-evidence.test.ts  [新] 合成 workspace 夹具（better-sqlite3 建
                                          state.db/trajectory.db）+ 条件跳过的真实
                                          pri653-e1 数据校验

docs/pipeline-evolution/README.md   [改] 运行协议接线（Phase 0 建 manifest / Phase 3
                                        取证 --experiment --package）
package.json                        [改] dev:evolution-init alias
```

- 不新建 runtime database、不动 PD 核心数据模型、不动 RuleHost/管道逻辑（SPEC 限制）。
- 全部为 dev 资产（scripts/dev + docs），Complexity Delta 见 PR。
- 兼容性：既有 `--workspace/--chain/--session/--json/--out` 用法不变；JSON 输出新增
  字段（truncated 标记等）为加法，无删除。

## 5. 真实数据迁移面（AC5）

`D:\pd-labs\pri653-e1`：pain `manual_1788488518040_7vcuslxs`（session `bfaef519…`，
score 65，真实纠正）→ 诊断 4 阶段 succeeded → 4 candidates consumed → 2 条 peer 链
（prompt / code_tool_hook）→ evaluator 一成一败 → 修复轮 → rollout（一 needs_review
一 pending）——含第二 pain `manual_1788544763213_sh7k5lgd`（诊断 3×failed，链早夭），
恰好同时覆盖 CONFIRMED 与 NOT_CONFIRMED 的 claim 形态。retroactive manifest + 
`--experiment --package` 全流程可在此数据上验收（无 approvals/activations → 
owner_decision/activation 应输出 UNKNOWN/BLOCKED 而非 PASS，正是 AC3 的活例）。
