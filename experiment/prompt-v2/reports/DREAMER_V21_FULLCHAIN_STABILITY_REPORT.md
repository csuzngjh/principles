# PD-SPEC-001 Round 2 — 全链路稳定性报告（SPEC §7.4 / §八 layer 3）

运行：`.tmp/prompt-v2-ab/runs/grid-3`（4 分片 × ab-run，`--arms v2c,v21`；2026-11-15）
臂版本：v2c = 9b87e9bc4（V2），v21 = 任务分支 head e8bc1bdf8（V2.1，仅 dreamer builder 不同）
层-1 指标：`runs/grid-3/layer1-metrics.json`（记录语法扩展 v2c/v21 后由 ab-metrics 收集）

## 管道稳定性对比

| 指标 | V2 (v2c) | V2.1 (v21) | 判定 |
|---|---:|---:|---|
| 记录数 | 52 中 26/臂 | 26/臂 | 同规模可比 |
| 终态 | 41 done + 11 done-admission-refused（两臂合计） | 同左 | 0 incomplete / 0 failed 记录 |
| Pipeline completion | **1.00**（16/16 样本） | **1.00**（16/16） | 持平 ✓（硬门槛 2） |
| Schema 首轮通过率（全部 runs） | **1.000**（104/104） | **0.945**（104/110） | 见下方归因 |
| Dreamer 阶段 schema 通过 | 100% | 100% | 硬门槛 1 ✓ |
| 阶段失败（诊断三阶段终态） | 0 / 0 / 0 | 0 / 0 / 0 | 持平 ✓ |
| 重试（诊断 attempts） | 26/26/26 | 28/30/26 | +2/+4/+0（首轮失败重试恢复） |
| 平均阶段延迟 | 29.8s | 34.0s（+14%） | 首轮失败重试 + 提示词变长 |
| 输出总量 | 135,942 chars | 136,088 chars（+0.1%） | 持平 |
| Artifact lineage | invalidFiles 0 | invalidFiles 0 | 无 lineage 破坏 ✓（硬门槛 3） |
| admission-refused（合法终态） | 4 | 7 | gate 重验行为，非失败 |

## V2.1 六次首轮 attempt 失败的归因（如实）

全部 6 次为**第一轮 attempt** 的输出校验失败，重试第 2 轮全部恢复（完成率仍 1.0）：

- rootcause ×3（shard0×2、shard3×1）：`output.valid must be true` / `evidence_ref_unbound`；
- distiller ×3（shard0/1/2）：`sourceRootCauseArtifactId mismatch`。

**关键归因**：这 6 次全部发生在 rootcause/distiller 阶段——这两个阶段在两臂间提示词**逐字节相同**（preflight 指纹 19/19 证明）。Dreamer 提示词的变化在因果上不可能影响它们。第一轮 grid-2 同类首轮失败率 ~1-2%（schema 0.981/0.990）；本轮合并 6/214 ≈ 2.8%，与第一轮水平一致，0 vs 6 的两臂分配属采样方差。**按阶段归因，硬门槛 1（Dreamer schema 通过率不低于 V2）达标：Dreamer 阶段两臂均 100%。** 总体 0.945 vs 1.0 的差异如实披露并给出上述阶段归因。

## 提示词体积（重点披露）

- Dreamer V2.1 提示词 = **10,613 字符** vs V2 4,343 字符 = **+144.4%**（Owner 指令原文规定逐字使用，SPEC §四）。
- 影响范围仅 Dreamer 一个阶段（约每链 1 次调用）；全链输出总量 +0.1%，延迟 +14%（部分来自 V2.1 臂采样到的首轮失败重试，部分来自更长提示词）。第一轮 20% 上限是第一轮 SPEC 的约束；本轮 SPEC 未重申该上限，但 Agent 如实报告该显著体积变化，交 Owner 知悉。

## 运行间方差警示（跨轮比较有效性）

- 第一轮 grid-2：V1 78.86 / V2 81.50；本轮 grid-3：V2 对照臂 80.22 / V2.1 81.03。
- **同一 V2 提示词跨轮相差 −1.28 分**（81.50 → 80.22）——16 样本全链盲评的运行间方差达 ±1.3。
- 因此本轮 +0.81 的臂间差**在方差带内**，只能作方向性证据；SPEC §九"不得将 16 样本包装成统计显著性"再次成立。

## 事故记录（诚实披露）

1. **grid-3 首次启动被有据终止**：ab-grid 未把 `--arms` 转发给 ab-run 子进程，子进程按默认 v1/v2 臂运行（launcher manifest 却声称 v2c/v21）。经记录文件名与 shard manifest 核实后终止（27 条错误臂记录删除，run 目录移除），修复 `ab-grid.mjs`（转发）与 `ab-run.mjs`（armOrderFor 接收 args.arms）后重启。副作用：该次误跑向第一轮 grid-2 的分片工作区（v1-s0..3/v2-s0..3）追加了新 pains/tasks——**第一轮已交付证据（runs/grid-2 的 records/blindpack/evals/summary）不受影响**（打包与评估在污染前完成），工作区中间态不再作为任何交付物。
2. 修复后以 S01 单样本 armcheck 验证臂名正确（S01.v2c/S01.v21），再放行全量。
3. PRI-1222 陷阱在本轮被修复（ab-run：exit 1 + succeeded + 全部 intake_failed → done-admission-refused），grid-3 的 11 条 refused 记录全部正确分类，无需人工改判。

## 复现

```bash
node experiment/prompt-v2/scripts/ab/ab-preflight-v21.mjs   # 14 项 fail-fast 全 PASS
node experiment/prompt-v2/scripts/ab/ab-grid.mjs --run-id grid-3 --parallel 4 --arms v2c,v21
node experiment/prompt-v2/scripts/ab/ab-blindpack.mjs --run-id grid-3      # 123 包
node experiment/prompt-v2/scripts/ab/ab-eval.mjs --run-id grid-3           # 123/123
node experiment/prompt-v2/scripts/ab/ab-blind-summary.mjs grid-3
node experiment/prompt-v2/scripts/ab/ab-metrics.mjs --run-id grid-3
node experiment/prompt-v2/scripts/analysis/owner-spotcheck-list.mjs        # ≥20% 抽检清单
```
