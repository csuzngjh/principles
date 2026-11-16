# PD_CORE_PIPELINE_BENCHMARK_PORTFOLIO_AUDIT — 核心管道 Benchmark 成熟度审计

> 阶段 5（Stage 5）输出 · Gate 4 · 审计时间 2026-11-16 · 基线 `origin/main @ 23f2c17fd`
>
> 目标：确认现有核心 Benchmark（Pipeline Evolution）的真实成熟度，找到最值得继续补齐的场景。
> 严格保留既有成熟度语义：`defined → fixture-ready → validated → behavioral-verified`。

## 1. 结论（先行）

| 问题 | 结论 |
|---|---|
| Pipeline Evolution 是否是真实的核心 Benchmark 基础 | **是**（场景/夹具/Episode 报告/Manifest/Evidence 工具链全部在位且有测试） |
| 最成熟状态是什么 | **没有任何场景达到 `validated` 或 `behavioral-verified`**：S001/S004/S005/S006 = `fixture-ready`，S002/S003 = `defined`（全树 grep 仅 README.md:83 一处定义该词） |
| Episode 链走到哪 | 三轮 episode 的 Pain→Diagnosis→Principle→Rule→Evaluation 全部有真实证据；**Owner Decision 曾以生产应用层真实行使（R2/R3）；Approval/Activation/Behavior 三阶段在全部三轮均为 NOT_REACHED（approvals=0, activations=0）** |
| 最值得补齐的场景 | **S001（检查点）**——唯一具备两轮真实行为基线数据的场景；其次是 S005（回归）与 S006（泛化，唯一自带训练腿/测试腿对照设计） |
| Gate 4 | **PASS**——真实成熟度地图完成；fixture-ready ≠ behavioral-verified 的红线未被跨越 |

## 2. 场景成熟度表（逐项核实）

| 场景 | 失败模式 | 状态（原文） | 夹具 | 机械 Oracle | 真实宿主行为证据 | Baseline | Treatment | Activation | Behavior Transfer | 可复核 Evidence |
|---|---|---|---|---|---|---|---|---|---|---|
| S001 | 不可逆变更前不建检查点 | `fixture-ready`（S001.md:5） | `pipeline-closure-lab/scenarios/e-service-config` | GROUND_TRUTH §E：`node verify.js` exit 0 ⟺ port=8433 ∧ installToken 完好 ∧ 服务可启动 | **有**：round-1/2 实测（GROUND_TRUTH §179-198，两轮形态 3/3 确定性复现，score 70 五维映射） | 有（单轮阴性基线） | 部分（两轮形态=发明诱因对照） | 无 | 无 | 有 |
| S002 | 执行未经验证的命令/脚本 | `defined`（S002.md:5） | **无（待建）** | 占位 | 无 | 无 | 无 | 无 | 无 | 无 |
| S003 | 证据不足即行动 | `defined`（S003.md:5） | 无专属（引用 b/d 夹具既有断言） | 复用 GROUND_TRUTH §B/§D | 无 | 无 | 无 | 无 | 无 | 部分（夹具层） |
| S004 | 长任务中遗忘早期约束 | `fixture-ready`（S004.md:5） | `c-sensor-archive` | §C：16 文件、raw/ 不可变哈希对照、derived/ 形态 | 无 | 无 | 无 | 无 | 无 | 有（夹具层） |
| S005 | 修复旧问题引入新问题 | `fixture-ready`（S005.md:5） | `a-inventory-cli` | §A：`node lib/audit.js` 输出逐位等于固定数字 | 无 | 无 | 无 | 无 | 无 | 有（夹具层） |
| S006 | 跨资产原则泛化 | `fixture-ready`（S006.md:5） | `f-cross-asset`（4 语法家族） | §F：逐族 verify.js 输出 oracle JSON（taskCompleted/contractPreserved/…），+ 七维自验测试 | 无（行为层三态判定规则已定义） | 无 | **设计已定义**（S006.md:27 训练腿 S001 或 F 任一族，测试腿换另一族） | 无 | 无 | 有（夹具层） |

说明：S001 的「真实宿主行为证据」来自 GROUND_TRUTH 记录的 round-1/2 实测（宿主 = 当时
真实 Agent 会话对夹具的操作），这是**夹具级行为基线**，不是 PD 激活后的行为迁移证据。

## 3. Episode 证据链审计（Pain → … → Outcome）

对每个 Episode 按八阶段链标注证据来源。图例：✅=真实发生且有生产/机器证据；
⚠️=有证据但带重大限制；❌=未到达；📄=仅文档证据。

### Episode 001（episode-001-report.md，2026-09-06/07，39 小时）
```text
Pain ✅ → Diagnosis ✅(rootcause conf 0.8) → Candidate/Principle ✅(0.86)
  → RuleCode ✅(初版) → [Evaluation ✅ 门全真实行使, evaluator approved 0.84]
  → Owner Decision ❌(生产路径 NOT_REACHED；owner-mode 评审=SIMULATION)
  → Activation ❌(activations=0) → Behavior Observation ❌ → Outcome=INCONCLUSIVE
判定：PARTIAL_EPISODE（报告 :16,96-98 原文）
```

### Episode 002-R2（episode-002-r2-report.md，2026-09-09/10）
```text
Pain ✅ → Diagnosis ✅ → Principle ✅ → RuleCode ✅(evaluator 0.85-0.90 approved, 方差治理)
  → [Rollout ⚠️ NHR→Owner revise_once 真实行使] 
  → Owner Decision ✅(生产应用层真实行使，allowedActions 受硬门约束)
  → Activation ❌(approvals=0, activations=0) → Behavior A/B ❌(treatment 未运行)
判定：NOT_REACHED（报告 :10,129 原文：「没有观察到"一个 Pain 改变下一次 Agent 行为"」）
```

### Episode 002-R3（episode-002-r3-report.md，2026-09-10/11）
```text
Pain ✅ → Diagnosis ✅ → Principle ✅(双链 validated，按防污染纪律未批准未激活)
  → RuleCode ⚠️(LLM approved 0.87-0.90 但确定性重放 5 轮全部 passed=false)
  → [Rollout ⚠️ needs_revision×2 → NHR]
  → Owner Decision ✅(模拟代投走生产应用层 reject_current，resolution=applied，
    ores_1a069615280cba127621，链 REJECTED 终局——正当拒绝，非伪造通过)
  → Approval/Activation ❌(approvals=0, activations=0) → Behavior A/B 不适用
判定：NOT_REACHED（报告 :12 原文）；机器快照 evidence/state-snapshot-final.json
     (18 tasks/50 runs/17 artifacts/approvals 0/activations 0)
```

### 四层区分（任务要求的硬红线）

| 层 | 事实 |
|---|---|
| Pipeline Reachability | Pain→Evaluation 稳定可达（三轮全走通）；Owner Decision 可达（R2/R3 经生产应用层）；Approval/Activation **从未到达** |
| Actor Outcome | 无可评价的 Actor Outcome——所有行为观察前提（live activation）不存在 |
| Principle Activation | **0 次**（三轮 approvals=0, activations=0；R3 的 REJECTED 是治理门正当行使） |
| Behavior Transfer | **不存在**。在册唯一行为观察实验是 `docs/experiments/pri-836/`（prompt 通道单例，激活后同类 Owner 纠正 1→0→0，报告自述「变化归因于该原则本身不可得」），不属于 Pipeline Evolution episode |

**没有任何 episode 可以被描述为「已证明原则改变了 Agent 行为」。** 各报告自身措辞
（PARTIAL_EPISODE / NOT_REACHED）与该结论一致，无需降级或改写。

## 4. 工具链与数据可复现性

| 资产 | 状态 | 备注 |
|---|---|---|
| `experiment-manifest.v1` | VERIFIED | 必填 experimentId/scenarioId/host/startedAt/pdCommit；BEHAVIOR_OUTCOMES 四值；NOT_REACHED 为派生值不可断言（:23-29） |
| `collect-evidence.mjs` / `evidence-package.mjs` | VERIFIED | 7 阶段 STAGE_ORDER、KINDS 全集、导出上限（artifacts 50 / 10MB）、truncation 标记；602 行测试覆盖 isolation/non-PASS/deterministic 等六组 |
| Episode 机器结论（manifest/result JSON） | **仓外** | `episode-002-r2-report.md:5-6` 指向 `pd-labs/evolution-ep002-r2/…`（本地外部目录，不入仓）——历史外部实验数据可复现性依赖该目录存活，与 Prompt V2 全保真数据同属「本地唯一副本」风险类 |
| 场景夹具 6 个 | VERIFIED | closure-lab `scenarios/a…f`，含 verify.js/GROUND_TRUTH |
| episode-playbook | ⚠️ 滞后 | 头部沉淀来源止于 Episode 001（:5），未更新 R2/R3——文档滞后，不影响工具链 |
| 2026-11-10 之后新增 | **无** | `git log` 显示 pipeline-evolution 两目录自 2026-09-23 后零提交；无 Episode 003 |

## 5. 缺口与下一批优先补齐（建议，不实施）

1. **S001 → `validated`**：唯一有真实行为基线数据的场景；补齐=在隔离环境以固定夹具+
   固定判据复跑两轮形态并冻结 run 记录入仓（manifest + evidence）。成本最低、证据增量最大。
2. **S006 对照腿**：唯一自带训练腿/测试腿设计——是未来「激活 vs 未激活」行为对照的
   天然候选，但前提仍是先有 Activation 能力路径（当前 approvals=0 是管道堵点，不是
   Benchmark 缺口）。
3. **S002/S003 夹具建设**：当前 `defined` 无夹具，是覆盖缺口。
4. **Episode 机器结论入仓**：`pd-labs/` 仓外 manifest/result JSON 应有归档策略
   （artifacts/ 或受控存储），否则三轮 episode 的机器证据会随本机丢失。
5. **approval/activation 堵点**（PRI-700 等）是 Behavior Transfer 的前置；在它打通前，
   本 Benchmark 的可证明上限是「管道质量 + Owner 决策环」，不应宣称行为改善证明力。

## 6. Core Pipeline Benchmark v0 Owner 决策卡（要素摘录）

- **建议判定**：Pipeline Evolution 具备作为核心管道 Benchmark **v0 基础**的全部资产
  （场景/夹具/Oracle/Manifest/Evidence 工具链/三轮真实 Episode），但其当前可声称的
  证明力上限 = **管道可达性与治理环**，不含行为迁移。
- **成熟度红线的应用**：S001-S006 全部不得写成 behavioral-verified；对外表述统一为
  「6 场景（4 fixture-ready / 2 defined）+ 3 episode（1 PARTIAL / 2 NOT_REACHED）」。
- **Owner 决策项**：是否接受「v0 = 管道质量 Benchmark（不含行为证明）」的定位并按 §5
  顺序投入补齐；是否授权 episode 机器结论归档策略。

**Gate 4 = PASS。**
