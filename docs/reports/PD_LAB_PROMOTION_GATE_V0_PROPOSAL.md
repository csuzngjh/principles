# PD_LAB_PROMOTION_GATE_V0_PROPOSAL — 研发变更晋级门 v0（人工可执行方案）

> 阶段 7（Stage 7）输出 · 提案时间 2026-11-16
>
> 本提案只交付**治理方案**，不改 CI 强制规则、不加自动化平台。第一版 = 一份人工可执行的
> 研发变更检查清单，前置事实依据：两种实验类型已完成最小跨域关联验证
> （`GENERALIZED_WITH_LIMITATIONS`，见 PD_LAB_CROSS_DOMAIN_VALIDATION.md）。

## 1. 适用范围与原则

- 适用：PD 仓库内一切「重要研发变更」的生产晋级判断；实验与晋级分离（SPEC v0.2 §9）。
- 原则四条：
  1. 代码可在隔离分支/worktree 开发与实验（git-1）；
  2. 默认关闭的候选功能可按正常流程合并，**未经实验 + Owner Promotion 不得生产启用**；
  3. 若合并即改变默认生产行为（L2/L3），实验证据必须先于合并；
  4. 实验 PASS ≠ 生产 PROMOTE；紧急安全修复走受控例外。

## 2. 变更等级 × 实验要求（检查清单主表）

| 变更类型 | 定义与例子 | 实验要求 | 晋级材料 |
|---|---|---|---|
| **L0** 文档和无行为变化修改 | docs、注释、格式、非关键 UI 文案 | 常规 CI + Markdown/链接检查 | PR 说明即可；无需实验记录 |
| **L1** 等价重构 | 声称行为等价的内部替换、核心路径性能优化 | 契约回归 + 相关 Benchmark Regression（如 closure-lab 夹具、字符级 parity）；核心路径必须跑相关回归 Suite | PR 内声明等价性证据 + 回归结果引用 |
| **L2** Prompt / 策略 / 算法变化 | 六 Agent prompt 修订、评分或选择逻辑行为变更 | **预注册**（Primary Metric、方向、最小改善幅度、Hard Guardrails、样本范围、停止规则）+ Baseline/Treatment 对照 + 质量与成本验证（参照 #2653 模式：配对样本、盲评、成败与降级如实分列） | 实验索引条目（Experiment ID、Dataset 版本+Digest、Run、Evaluator 与独立性声明、Report、限制）+ Owner Promotion Decision |
| **L3** 核心 Pipeline / Principle / Runtime / 安全变化 | 状态机、候选准入、生成/选择/审批/激活、权限、数据治理 | 完整工作流对照（Pain→…→Outcome 八阶段链，参照 Pipeline Evolution episode 方法）+ 相关 Benchmark + 负例/硬护栏 + Evidence Package + Owner 审查；安全/权限/Owner 意图/证据真实性/错误激活等**不可被单一平均分抵消** | 上项全部 + 八阶段链逐阶段证据 + 硬护栏逐条结果 + Owner Promotion Decision（或 EMERGENCY_EXCEPTION 记录） |

不得通过拆分 PR 把 L3 降级为 L2/L1（SPEC §9.2 既有规则）。

## 3. Owner Promotion Decision（独立于实验结果）

| 决策 | 含义 |
|---|---|
| `PROMOTE` | 证据满足预注册目标与硬护栏，Owner 批准进入正常发布/启用流程 |
| `HOLD` | 证据不足、有限制或需补实验（如 `PASS_WITH_LIMITATIONS` 的常见去向） |
| `REJECT` | 未改善、不可接受回归或违反护栏 |
| `EMERGENCY_EXCEPTION` | 安全/隐私/数据完整性紧急修复受控例外：最小修复 + 记录风险与批准 + 保留回滚 + 事后补验证；不得用于常规 Prompt/策略优化 |

领域结果词汇保持原义不换算：`PASS_WITH_LIMITATIONS`、`PARTIAL_EPISODE`、`NOT_REACHED`、
`IMPROVED/NO_IMPROVEMENT/REGRESSION/INCONCLUSIVE`。**`PASS_WITH_LIMITATIONS` 的默认去向
是 HOLD，不是 PROMOTE。**

## 4. v0 的执行载体（最小改动）

1. **记录位置**：L2/L3 的实验证据沿用本次已建立的模式——实验目录内索引 + `docs/reports/`
   审计报告（如 `PD_LAB_HISTORICAL_EXPERIMENT_INDEX.md`）；不新建平台/数据库/服务。
2. **PR 模板衔接**：L2/L3 PR 在描述中填写「变更等级 + 实验索引链接 + Promotion Decision
   状态」三行；评审者按 §2 主表核对。不改 `.github/PULL_REQUEST_TEMPLATE.md`（本阶段
   只交付方案；模板修订是 Owner 批准后的独立小 PR）。
3. **实验准入的停止条件**（沿 SPEC §16）：数据授权不明确 / 输入无法冻结 / Baseline-Treatment
   不可比 / 可能写生产 / 评价器重大偏差未解决 / Evidence 不可复核 / 硬护栏失败 / 全保真数据
   治理缺口未决——任一触发即停止该实验，记录后另寻路径。
4. **与现有治理的接口**：Owner 合并权（AGENTS.md §23）不变；Linear 工单按 §21 正常流转，
   Promotion Decision 作为工单证据评论，不新造状态机。

## 5. 何时升级到 CI（v1+ 的触发条件，现在不做）

- 出现 ≥3 个 L2/L3 变更走完人工流程后，评估把「L3 PR 必须含实验引用 / Evidence Digest
  校验 / Owner Decision 存在性」做成轻量 CI 检查；
- 普通 CI 永不默认执行昂贵真实模型实验（SPEC §13 Stage 5）；
- 发布闭包负向测试（lab-payload-closure 等）已是现有护栏，继续沿用，不重复建设。

## 6. 本次不做的事（边界重申）

- 不改 CI 规则、不改 PR 模板、不加 feature flag、不建自动化平台、不开发扫描器；
- 不追溯要求历史变更补实验（#2653 等历史实验以索引+限制如实记录即可）；
- 不把本提案当作已生效规则——生效需 Owner 明确批准（建议以 Owner 在本 PR 上的裁决为准）。

## 7. Owner Review Card（要素）

1. Problem：重要行为变更缺少与风险相称的实验论证与晋级判断的统一清单。
2. Before：L2/L3 变更是否需要实验、需要什么证据、谁批准，全靠个案判断。
3. After：一张四等级×实验要求主表 + 四值 Promotion Decision + 最小执行载体（文档模式）。
4. 复用：SPEC v0.2 §9 全部语义 + #2653 实验模式 + Pipeline Evolution episode 方法 + 现有 PR/Linear 流程。
5. Complexity Delta：全部 NO（纯文档治理方案，零代码零平台）。
6. Verification：两种实验类型已实证该模式可承载（跨域验证 GENERALIZED_WITH_LIMITATIONS）。
7. Risk：人工执行依赖纪律，无强制门；L2/L3 的「实验先于合并」在默认开启型变更上可能与交付压力冲突（owner 裁量）。
8. Rollback：本提案未被批准即无效力；批准后撤销 = 删除本文件。
9. Follow-ups：CI 化触发条件（§5）、PR 模板三行（Owner 批准后）、历史实验的 Promotion Decision 补录（如 Owner 认为需要）。
