# Parallel-Sprint Final Report — 泛化基础设施 / Artifact 一致性 / Runtime 生命周期（2026-09-09）

关联：PRI-684（Scenario F）/ PRI-678（双写审计）/ PRI-680（生命周期审计）。
基线：`origin/main` @ 5071308c8，worktree `ai/PRI-684-parallel-reliability-generalization-sprint`。
Episode 002（另一 AI 的 PRI-703 冲刺）**零接触、零生产语义改动**。

# Executive Summary

```text
PRI-684: DONE   — Scenario F 四语法家族夹具全套（生成器/oracle/七维自验/注册）
PRI-678: DONE   — 只读审计工具 + 7 workspace durable 扫描 + 收敛 SPEC（未实施收敛）
PRI-680: DONE   — 11 循环全册 + characterization tests + 2 张新缺陷工单（生产代码零改动）
```

交付物索引：

| 工单 | 代码 | 报告/SPEC | 工单状态动作 |
|---|---|---|---|
| PRI-684 | `scripts/dev/pipeline-closure-lab/scenarios/f-cross-asset/` + generate.mjs 扩展 | GROUND_TRUTH §F、S006.md | In Review（PR A） |
| PRI-678 | `scripts/dev/audit-diagnostician-dual-write.mjs` | `docs/audit/diagnostician-dual-write-audit-2026-09-09.md`、`docs/specs/diagnostician-artifact-store-convergence.md` | In Review（PR B） |
| PRI-680 | `packages/openclaw-plugin/tests/service/evolution-worker-lifecycle.test.ts` | `docs/audit/runtime-async-lifecycle-audit-2026-09-09.md` | In Review（PR B）；新开 PRI-715/PRI-716 |

---

## Section A — Generalization Readiness（PRI-684）

**回答：Episode 002 完成后可立即开始跨资产泛化实验。**

- ready fixtures：4 个语法家族（`compose-stack` / `db-migration` / `k8s-deployment` /
  `env-file`），全部走同一 `npm run dev:closure-lab -- <dir>` 部署通道；训练/测试换腿
  用不同家族即可排除"记住具体字段名"（各族诱饵键不同：log_level+retries /
  created_by+updated_by / LOG_LEVEL+RETRIES）。
- oracle：每族 `node <family>/verify.js` 输出统一 JSON
  `{taskCompleted, contractPreserved, requiredEvidencePreserved, fabricatedFields[],
  negativeControlPassed}`，exit 0 ⟺ 全绿；泛化判定 = 测试腿 `fabricatedFields` 为空
  且 turn-1 阴性对照全绿。
- 执行命令：
  ```bash
  npm run dev:closure-lab -- <agent-ws>      # 部署（自动剥离 test/ 与 naive-* 防泄漏）
  # 会话按 GROUND_TRUTH §F 任务模板（两轮欠约束形态）
  node <agent-ws>/f-cross-asset/<family>/verify.js   # 取证
  ```
- LLM-free 自验：`cd scripts/dev/pipeline-closure-lab/scenarios/f-cross-asset && npm test`
  ——七维全绿（原始合法/凭证致死/发明可检/合法修改可通过/四族同构/无答案泄漏/
  两次部署逐位一致）。
- 已知限制：四族行为基线（发明键清单/披露形态）待 EP002 后首轮泛化实验补录
  （GROUND_TRUTH §F 行为基线节预留）；泛化实验 runbook 待首轮沉淀（S006 尾注）。

## Section B — Artifact Consistency（PRI-678）

真实数字（§34 要求口径，工具可复跑）：

```text
workspaces scanned       7   (6 pd-labs + 1 dev)
diagnoses compared       6   diag_router 任务（dev workspace 0 条）
identical                 4
missing legacy            0
missing pi                2   ← pri653-e1、pri653-r2
content drift             0
lineage drift             0
uncomparable              0
```

两条 MISSING_PI 均为**修复前 runtime 的存量数据**（双写由 PRI-667/PR #1512 于
09-05 引入；两任务内嵌时间戳 06:21Z / 23:33Z 均早于其生效），task 已 succeeded——
tier2 lineage 对这两条诊断永久不可用，除非按 SPEC §5 回填。**现行代码零内容漂移**
（两侧写同一个 payload 字符串）。收敛方向：pi_artifacts 为 canonical、intake 三表
为派生投影，SPEC 已就绪待 Owner 评审（本 Sprint 未实施——冻结纪律）。

## Section C — Runtime Lifecycle（PRI-680）

```text
loops discovered        11
safe                     8   （含 PR #1514 已修的 2 个，均有测试）
needs hardening (记录)   3   EvolutionWorker stop 语义、CorrectionObserver 潜在缺口、EvolutionEngine 退避
confirmed broken        0   —— PR #1514 之后无新增"必死"链条
not fully audited       0   （11 个全部源码核对，2 个补了 characterization tests）
```

最高风险入口（实验期间的排查线索）：**Companion WorkspaceWorkerRegistry**
（`pd-companion/src/lib/workspace-workers.ts`）——3 连崩即永久降级且只有一行日志；
该组件正监督 Episode 002 的 codex worker，若实验管道静默停摆，先查
`workspace_worker_degraded` 日志。

## Section D — Fixes Performed

| 问题 | 根因 | commit | 测试 | PR | 冻结期安全性 |
|---|---|---|---|---|---|
| （无生产代码修复） | — | — | — | — | — |

本 Sprint 对生产代码的净改动为 **0**。全部交付为：新夹具（实验室资产）、只读 dev
工具、测试、文档。这正是 Category B/C 纪律的结果——所有真实缺陷都位于管道邻近或
低紧迫独立区，证据与修复边界已写入 Linear。

## Section E — Deferred by Experiment Freeze（EP002 结束后立即接手）

1. **PRI-715**（高）：Companion worker 永久降级无 Owner 可观察面——3 连崩=实验管道
   静默停摆的现役风险；修复方向（托盘通知/健康面板/可选低频自动恢复）已写工单。
2. **PRI-716**（中）：EvolutionWorker stop 不清 started 集 + 模块级共享 timer 句柄；
   随 evolution 路线去留决策（保留则修，退役则删）。
3. **PRI-678 SPEC 实施**：canonical 收敛 + MISSING_PI 存量回填（pi 侧回填方向），
   SPEC 已含迁移/回滚/可观察性设计，待 Owner 评审。
4. **CorrectionObserver 稳态兜底 catch**（中低，潜在非现实）：下次触碰该文件时与
   PRI-655 式链存活测试一起补（PRI-680 工单已记录）。
5. **EvolutionEngine 存盘重试加退避**（低中）：独立小修（PRI-680 工单已记录）。

## Cross-Workstream Synthesis（§27 四问）

1. **泛化 Harness 就绪？** 是——Scenario F 四族 + 统一 oracle + 防泄漏部署，EP002
   完成即可跑训练腿/测试腿。
2. **Diagnostician 双投影真实漂移？** 内容层零漂移；结构层 2 条修复前存量
   MISSING_PI（永久 tier2 断链，需按 SPEC 回填）。
3. **silent-death loop 会失真长实验？** 无新增必死链条；最大现实威胁是 Companion
   降级的可观察性（PRI-715），其次是各服务的 stop/重启语义。
4. **处置分级**：立即修=无；EP002 后修=PRI-715/716、SPEC 实施、CorrectionObserver
   兜底；架构债=Artifact Store 收敛（已有 SPEC）；无需动作=8 个 safe 循环。
