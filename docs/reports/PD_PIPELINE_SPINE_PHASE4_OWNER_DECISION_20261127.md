# PD Pipeline Spine — Phase 4 Owner 决策材料（2026-11-27）

| 项 | 值 |
|---|---|
| 生成日期 | 2026-11-27 |
| 分析基线 | `origin/main` = `3f068988cf04b22501a5c190f52f88630d1cb12f` |
| 输入 1 | Phase 4a Flag 普查：`docs/reports/PD_PIPELINE_SPINE_PHASE4_FLAG_CENSUS_20261127.md`（分支 `ai/PRI-1294-flag-census` @ `1dee49b7e`） |
| 输入 2 | Phase 4b PD-Lab 评估：`docs/reports/PD_PIPELINE_SPINE_PHASE4_PDLAB_ASSESSMENT_20261127.md`（分支 `ai/PRI-1294-pdlab-assessment` @ `8d247235c`，本分支已逐字节并入） |
| 规范注记 | 工单引用 SPEC-PD-PIPELINE-SPINE-001 v0.9 §6 Phase 4；仓库现为 v0.14（仍 **Draft for Owner Review，未批准**）；Phase 4 条文两版逐字节一致（`git show 1e9e4e493` vs HEAD diff 实证），语义无漂移 |
| error:context | Pass 1（计划模式）：无自动命中，人工复核 Pattern Index 选取 EP-02/06/09 作为报告完整性检查项；Pass 2（diff 模式）见本分支提交前运行记录 |
| 本轮边界 | 只审计不实施：未删除任何开关代码，未运行任何真实模型实验，未读取真实快照/全保真数据/API Key |

---

## 0. 一页结论

1. **4a Feature Flag 清理：A 类 = 0。** 55 个注册开关（core 9 / quiet 34 / gone 12）逐项实证后，无任何开关同时满足 A 类纯死开关判据——本轮**没有需要 Owner 逐项批准的删除项**，Phase 4a 在当前基线的可清理对象为空。
2. **4b 阶段合并：两个候选均「③ 不建议合并」。** 职责独立性有源码级价值（候选 A 的确定性继承防线、候选 B 的发散-批判明文契约），且 Phase 0 漏斗基线不含逐阶段耗时/token 字段，「中段跳数是真瓶颈」的前置未被证明；真实实验 BLOCKED（D2–D6 无适用授权）且 NOT_RUN。
3. **因此 Phase 4 的两个实施阶段（清理 PR、合并实施）当前均无对象。** 本轮交付即审计终态；保留原结构是合法成功结论，不是未完成。

---

## A. Feature Flag 清理决策

### A.1 分类结果汇总（55/55，无抽样）

| 分类 | 数量 | 构成 | 处置建议 |
|---|---|---|---|
| A 类（纯死开关） | **0** | — | 无可清理项 |
| B 类（默认 ON，有紧急制动/回退价值） | **26** | core 9 + quiet 默认 ON 17（其中 `diagnostician_split_pipeline` 记 B*，见 A.4） | 保留 |
| C 类（默认 OFF，活跃实验/Owner opt-in） | **17** | 全部 quiet；含 PRI-1170 三 host AA、PRI-1171/1274 摄入与授权族等 | 保留 |
| UNCLASSIFIED（分类学外） | **12** | 全部 `category=gone` tombstone | **保留（兼容 tombstone）** |

判定说明：`gone` 是运行时 category，不等于审计 A 类——tombstone 本身承担「拒绝历史配置重新启用 + 可观察告警」的兼容职责（`feature-flag-contract.ts` computeEffectiveFlags gone-guard 与 unknown-flag warning），是历史 `.pd/config.yaml` 兼容的唯一保护机制，12 个 tombstone 每条都挂有 Owner 退役记录（PRI-738/752/751/819 R-06/1137、GFI-COMPLETE-REMOVAL-001），一律保留。

### A.2 A 类清单 = 空的依据

详见普查报告 §2 总表与 §3。关键反例（曾被视为候选的开关均非 A 类）：

- `diagnostician_split_pipeline`：能力选择职责确于 PRI-638 死亡（split 已是唯一实现），但其 registry 条目仍是 PRI-638 legacy-`false` 升级保护 shim + Console 写侧退役 + 契约测试锁定 → **B\*（保留，兼容 shim）**；
- 全部 gone tombstone：承担配置兼容/防复活职责 → 非 A；
- 全部默认 ON 的 quiet/core flag：flag-OFF 均为可观察的恢复/降级路径（应急制动、legacy 回退、迁移熔断、L3→L2 降级）→ B 类非死开关。

### A.3 B/C 保留清单

逐条（当前默认状态、制动价值、关闭后行为、保留理由）见普查报告 §4（B，26 条）与 §5（C，17 条）；本材料不重复展开。

### A.4 需要 Owner 关注的边界发现（不在 55 行分类内，均不在本轮处理）

| # | 发现 | 影响 | 建议 |
|---|---|---|---|
| BF-3 | `code_tool_hook` / `defer_archive` 应急停用只影响 CLI 队列与 installer 校验；host-runtime 消费循环硬编码三通道（`internalization-consumer-cycle.ts:722` `enabledChannels: Set(['prompt','code_tool_hook','defer_archive'])`） | core 开关的「紧急停用」语义在 host 推进路径上不完全贯通 | 立后续工单决策是否贯通；不改本轮 |
| BF-2 | `computeEffectiveFlags` 确认生产零调用（测试口径 API）；生产走另一套有效配置读取 | 两套消费 API 并存债务（governance 文档已登记） | 归入既有债务工单；不改本轮 |
| BF-7 | `workbuddy_live_keyword_pain` capability 在 WorkBuddy 内 UNSUPPORTED（无持久观察 writer，候选恒 observation_only） | 开关两态仍活但能力不可达 | 走 lifecycle RETIRE 流程，待 Owner 决策；不改本轮 |
| BF-1/6 | governance/lifecycle 文档仍引用已合并删除的 `runtime-v2/` 旧路径；`QUIET_FLAG_LIFECYCLE` 中 split-pipeline 的 consumers 字段 PRI-638 后过期（zombie guard 未覆盖该字段） | 文档漂移 | docs 修正建议，独立小 PR |
| 交互 | `diagnostician_split_pipeline`（B*）与 4b 候选 A 共享：若未来清理该 flag 分支，会改变候选 A 实验的臂构造方式 | 跨阶段耦合 | 任一侧动它前先核对评估报告 §0/§3.6 |

### A.5 对「后续实际清理阶段」的影响

指令 §八的每开关独立小 PR 流程**当前无启动对象**（A=0）。若未来基线演进产生新 A 类候选，按原流程执行：Owner 逐项批准 → 冲突矩阵先查 PRI-1299/1300/1301/1302 触碰文件 → 一开关一 PR → 保留配置兼容 tombstone 机制 → 历史 `.pd/config.yaml` 旧键加载回归测试。

---

## B. LLM 阶段合并决策

### B.1 候选 A（`diag_distiller` + `diag_router`）：③ 不建议合并

依据（详见评估报告 §3/§9.1）：抽象与路由被四层机制强制分离（prompt 角色声明、runner 注释、`postFetchTransform` 确定性继承 `diag-router-runner.ts:763-913`、cardinality 契约）；合并把「LLM 物理上无法改写抽象」降级为单次生成自我一致，是已知风险方向。漏斗侧两段成功率 96.8%/92.2%，失败热点在更上游，无耗时/token 字段支持瓶颈前提。合并的具体损失：中间 distiller artifact 证据、段级失败定位与恢复缓存、B 失败早停优势、defer 决策隔离。

### B.2 候选 B（prompt 渠道 `dreamer` + `philosopher`）：③ 不建议合并

依据（详见评估报告 §4/§9.2）：发散-收敛分离是两段 prompt 的明文契约（「exploration agent, not the final principle author」/「NOT required to accept every candidate」）；合并后独立批判消失、择优与生成同源。漏斗侧两段成功率 99.4%/99.5%，prompt 渠道月产量个位数——即便合并完美成立，绝对节省是每月个位数调用；工单红线明确排除「省一次调用」作为合并理由。实施侧另有硬约束：`PRINCIPLE_SEMANTIC_EDGES` 被 prompt 与 defer_archive 渠道共享，合并实现必须显式拆分边集才能守住「仅 prompt 渠道」。

### B.3 授权门缺口（D2–D6，评估报告 §8 逐项）

| 授权 | 状态 | 说明 |
|---|---|---|
| D2（模型/预算/统计） | **BLOCKED** | 无绑定本实验的批准记录；最近一次机械复算 `D2_NOT_APPROVED`（2026-11-22）；`lab:eval` 外部裁判调用同样需 D2 |
| D3（真实快照） | **BLOCKED** | 无适用决策记录 |
| D4（真实 INTENT） | **BLOCKED**（或预注册声明 N/A） | 取决于 `intent_engineering` 冻结状态（生产默认 OFF） |
| D5（Owner 盲评） | **BLOCKED** | 无适用决策记录 |
| D6（全保真数据） | **BLOCKED** | 无适用决策记录；全保真副本存在性未验证 |

授权记录存放位置已核实：HANDOFF 文档只是 DRAFT 参数清单；每轮批准以 `evidence.approvals.{d2,d5,d6}` 绑定轮次 artifact。旧实验授权、口头授权、聊天摘要、合成 fixture 均不构成批准。本轮零模型调用、零真实快照读取、零 API Key 访问。

### B.4 若 Owner 想推翻「不建议合并」：顺序化最低路径

(a) 只读扩展 Phase 0 快照脚本输出逐阶段耗时/尝试/token/成本并重跑修复后基线 → (b) 若瓶颈成立，按 B.3 逐项取得 D2–D6 授权 → (c) 按评估报告 §5 冻结预注册（两候选各自独立单因素 paired A/B，两臂唯一差异=阶段拓扑）→ (d) 以实验结果（含全分母）而非讨论决定。任何一步缺失都停在原地。

### B.5 实验设计可用性

两候选的实验矩阵、质量/性能/治理指标（含失败分母保留）已在评估报告 §5–§7 设计完毕，复用现有 `lab:run/metrics/blindpack/summary/card` 全链，不新建任何系统；已知适配点（ab-run 三段拓扑硬编码的有界参数化、合并 prompt 冻结、共享边集拆分）已如实列出。设计 ≠ 结果，需授权后才可运行。

---

## C. Owner 需要拍板的决策点

| # | 决策点 | 选项 | 默认建议 |
|---|---|---|---|
| 1 | 4a 清理阶段 | 确认 A=0 → 挂起/关闭「实际清理」阶段；或指定复议开关 | 确认 A=0 |
| 2 | 4b 合并阶段 | 接受两候选「③ 不建议合并」→ 关闭 4b；或要求先补漏斗逐阶段字段再评估 | 接受 ③ |
| 3 | 边界发现 BF-1/2/3/6/7 | 是否立项为后续独立工单（明确不在 PRI-1294 范围内实施） | 各自立项小工单 |
| 4 | （可选）漏斗增强 | 是否授权只读扩展 Phase 0 快照脚本输出逐阶段耗时/token 并重跑修复后基线 | 值得做（B.4 第一步，独立于合并意向） |
| 5 | SPEC 状态知悉 | v0.14 仍 Draft 未批准；Phase 4 条文与 v0.9 逐字节一致 | 知悉即可 |

## D. 并行冲突与回滚

- **冲突矩阵**：A=0 → 无清理目标文件 → 与 PRI-1299（Successor Lookup）、PRI-1300（Repair 血缘）、PRI-1301（executor 拆分）、PRI-1302（Orchestrator spike）**零文件冲突**；4b 不实施 → 无实施冲突。
- **本 PR 回滚**：docs-only，revert 单提交即可；无运行时影响、无 schema/状态变更、无开关行为变更。

## E. 证据索引

- 普查报告：`docs/reports/PD_PIPELINE_SPINE_PHASE4_FLAG_CENSUS_20261127.md`（251 行，55/55 逐项 `path:line` 证据，自审 §7 + 边界发现 §8 BF-1~BF-8）
- 评估报告：`docs/reports/PD_PIPELINE_SPINE_PHASE4_PDLAB_ASSESSMENT_20261127.md`（442 行，§0–§10）
- 主 Agent QC 记录（2026-11-27）：分类 tally 复算 25+1+17+12=55；抽查引用 8 处（`pain-signal-runtime-factory.ts:683`、`diagnose.ts:501`、`pd-config-effective.ts:199-224`、`internalization-consumer-cycle.ts:722`、`diag-router-runner.ts:763-913`、`internalization-job-graph.ts:35`、`feature-flag-contract.ts` gone-guard、`PD-LAB-USAGE.md` D2–D6 表）全部与基线源码吻合；两分支 diff 均仅含各自报告文件；伪影 grep 双报告零命中。
- Linear：PRI-1294（In Progress → In Review，本材料随 PR 交付；审计完成 ≠ 工单完成，工单终态以 Owner 对上述决策点的裁决为准）。

---

*生成者：PRI-1294 Phase 4 主 Agent（zcode）。生产事实以基线 `3f068988c` 源码为准；本材料不引入新的权威事实源，一切细节以其引用的两份子报告为准。*
