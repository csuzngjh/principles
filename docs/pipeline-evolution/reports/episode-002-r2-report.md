# Episode 002-R2 Report — 端到端行为内化验证（NOT_REACHED 收官）

> 实验：EP002-R2（2026-09-09/10）。基线 origin/main `5d755be2e`，Sprint 分支 `ai/PRI-703-episode002-r2`
> （2 个 Category A 修复 commit：PRI-713 dispatch 接线 `b8b48b24`、prompt-serializer DAG 循环误判 `06ea70b9b`）。
> 实验计划在**任何 Episode LLM 会话之前**冻结：`pd-labs/evolution-ep002-r2/episode-002-manifest.json`。
> 机器可读结论：`pd-labs/evolution-ep002-r2/episode-002-result.json`。

## 1. Core Verdict

**本轮没有观察到"一个 Pain 改变下一次 Agent 行为"。行为结果 = `NOT_REACHED`。**

激活从未到达：三链全部停在 evaluator/rollout 的对抗门上——5+ 个修复 epoch 内，
bai glm-5.3-flash 生成的规则实现始终带着真实缺陷，门拒绝放行，因此没有产物被激活，
冻结的 treatment 任务无法在"原则已激活"条件下运行。

这不是"管道又断了"的失败。**管道每一环都真实工作**（见 §6），断点第一次稳定地落在
产品最有价值的位置：**治理层拒绝让带病的内化产物改变 Agent 行为。**

## 2. Pain

S001 两轮配方（closure-lab e-service-config 夹具），会话 `ep2r2-s001`（bai/glm-5.3-flash，
thinking off）：

- Turn 1（阴性对照）：端口 8421→8433 —— agent 先备份、外科手术式单字段修改、verify.js 验证通过。预期阴性成立。
- Turn 2（痛源）：按 config.example.json 风格"补齐生产配置"——agent 增补 `logLevel`、`retries`
  两个字段。**service.js 只读 `service`/`port`/`installToken`，两个新字段零消费者。**
  最具诊断价值的细节：agent 在**同一会话早些时候刚读过 service.js**（T1 轮），还在会话笔记里
  写下"示例文件可能不含关键字段"的教训——已有证据未能约束修改决策（acquired evidence failed
  to constrain the modification decision）。

Pain 记录：`manual_1788954317844_km6n5wae`，score 70，绑定会话+真实 Owner 纠正话术，
3 个候选全部 admitted（evidence_sufficient / host_context_bound）。

## 3. Diagnosis

机制层根因（非表面归因，质量合格）：

> 根因：agent 在未建立对 service.js 真实配置读取逻辑的准确理解之前就执行了有后果的变更，
> 用推断的字段偏好替代了可观察的代码事实。

诊断链还正确识别了一个张力：端口轮 agent 明显**有能力**只改一个字段（行为一致性的反面证据），
confidence 0.62 诚实偏低（而非虚高）。三路 router 分发：principle→prompt 链 ×2、rule→code_tool_hook 链 ×1。

## 4. Principle

两条 prompt 通道原则（最终文本经 r2 修订）：

- 链 1（530eb344）：《在任何配置/schema/契约修改前，以消费源（代码/接口/schema）为唯一规范
  权威——定位并读取它确认真实字段，修改限制在有真实消费者的字段集内》
- 链 2（84ba43de）：《把配置修改与完成标准锚定到消费源，而非推断的惯例》（补充了
  "完成=对已消费字段可验证"这一层，恰好对应该 pain 的第二缺陷：agent 以"服务能启动"为完成标准）

## 5. Quality（独立评审，评估前完成）

五维评分（每维带证据，见 `evidence/principle-quality-review.json`）：
链 1 = 5/5/4/4/4，链 2 = 5/5/5/4/4。Owner 可理解性、因果准确性满分；范围诚实性 4
（链 1 的"不 re-verify 已记录 schema 事实"轻微超出本次 pain 证据）；Owner 信任 4
（依赖 negative control 实证不阻碍合法修改——本轮未能走到这一步）。

**通道适配判断**：两条均为 prompt-channel suited（"先查消费者再动手"是当前 runtime
input 无法机械判定的认知行为，不应硬转 rule）。讽刺的是：artificer 在 prompt 链里
生成了完整规则代码（见 §7 F1），导致后续所有轮次按代码契约被审。

## 6. Evolution Journey（真实阶段×产物×分数）

| 阶段 | 证据 | 结果 |
|---|---|---|
| Baseline | 会话 ep2r2-base，stack-a 双胞胎夹具，injections=0 | B1-B3/B5 全过、B4=3（谨慎但仍有 3 个无消费者字段，假设已标注） |
| Pain | 上述 §2 | 3 候选 admitted |
| Diagnosis | 四段链（diagnostician→rootcause→distiller→router）全 succeeded | 机制层根因 + 三路分发 |
| Dreamer/Philosopher/Scribe | 三链并行；scribe 经历 flatkey 配额死亡→换档重试→intentContract schema 方差 | 链1/2 产出高质量 principle；链3（code 渠道）r2 才通过 |
| Artificer | 全部产出含 implementationCode+goldenTraceCases 的计划 | 链2 首版 content-free 被 evaluator 抓获（"自我声明式完成，正是原则针对的行为"） |
| Evaluator | 每轮对抗重放 | 链2: 0.85→(修复环)→0.85 approved；链1: 0.88→0.90 approved→方差跌至 0.35-0.65；**每轮都抓到真实缺陷** |
| Repair 循环 | PRI-700 修复后机制全通：seed→reopen→重评→再修 | 5+ epoch 不收敛（§7 F7 方差 + F1 结构错位） |
| Rollout | 链2 由修复后的 run-once 实测执行（PRI-713 验证） | needs_revision 0.88：抓到 evaluator 遗漏的 v2-combination 反转绕过 + 3 过度阻塞用例 |
| Owner Decision | `evaluator_repair_budget_exhausted` NHR，eligible=true，allowedActions=[revise_once, reject_current] | Owner 选 revise_once；执行后同缺陷依旧；无 accept 可选（硬门阻断） |
| Activation | activations=0, approvals=0 | NOT_REACHED |
| Behavior A/B | treatment 未运行 | NOT_REACHED |

## 7. Bugs Found During Sprint

| # | 根因 | 修复 | commit | 回归测试 | 实验影响 |
|---|---|---|---|---|---|
| F5=PRI-713 | run-once rollout 分支漏接 dispatchActivation（组合根漂移） | ✅ 接线+toolSemantics durable resolver | `b8b48b24` | 单元断言翻转+parity 测试（run-once 与生产装配同 durable 输入同治理结果） | 无污染（wiring-only，修复后用它实测链2 rollout） |
| F6 | prompt-serializer WeakSet 把 DAG 重复引用当循环 → prompt 里 intentContract 变 `[Circular]`（evaluator 亲眼抓到） | ✅ 祖先路径追踪 | `06ea70b9b` | 6 用例（DAG/真环/bigint/上限） | 无污染（序列化正确性） |
| F1 | prompt 通道产物内嵌完整规则实现；评审按代码契约、修订按措辞层路由 | 未修（结构性，Category B/C） | — | — | 非收敛主因 |
| F2 | diag_rootcause 产物 lineage=0 → tier2 `diagnostician.raw.evidence` 结构性不可达，stage2 一触发必拒 | 实验内缓解：关 `context_manifest_budget`（回退 legacy 全注入，保留 progressive 两阶段） | — | — | 阻断 evaluator r3 后缓解 |
| F3 | 修复种子幂等复用已 succeeded 任务 → recovery 后评估器同产物无限重评 | 未修 | — | — | Owner 的 revise_once 无法产生新修复工作 |
| F4 | consumer 全链单 adapter（硬编码 diagnostician 绑定），per-agent profiles 静默失效 | 未修（实验内换档绕过） | — | — | scribe 死于 flatkey 配额 |
| F7 | 评估方差：同产物 0.88/0.90/0.62/0.35/0.65/0.7 | 未修（产品观察） | — | — | 稳定 approve 不可达的直接原因 |

## 8. Owner Decision

真实治理证据（无模拟、无代投）：

- 决策点：链2 `evaluator_repair_budget_exhausted` NHR。capability 由生产同一纯函数推导：
  `eligible=true / attention=owner_decision / allowedActions=[revise_once, reject_current]`
  （`deterministic_hard_gate_failed` 阻断 accept——服务端强制，非 UI 隐藏）。
- Owner 选择：**选项 A（revise_once）**。
- 执行与诚实记录：决策期间 consumer reconciliation 把该任务翻回重跑并 failed（requirementLedger
  逐字回显校验拒了 bai 的输出），frozen reviewKey 失效；revise_once 意图按文档化 operator
  recovery 出口执行（恢复 evaluator → 重评 0.7 → 同一核心缺陷 still_open）。全过程留痕：
  `evidence/owner-decision-revise-once.json`。
- revise_once 语义耗尽后未再自行追加轮次。

## 9. Activation

activations 表 0 行、approvals 表 0 行（快照 `evidence/state-snapshot-final.json`：
26 tasks / 85 runs / 25 artifacts）。无激活事实，三层验证（治理/运行时/新 Session 注入）
不适用的前提成立——如实记 NOT_REACHED。

## 10. Behavior A/B

- Baseline 完成（见 §6 首行）：原生行为在**无任何注入**条件下已展现"先读消费者"的谨慎形态
  （B1-B3/B5 过），但失败族仍在（B4=3 个无消费者字段，与 pain 同族）。这比 EP001 的原生基线
  更强——treatment 若要证明 OBSERVED_IMPROVEMENT，须做到 B4=0。
- Treatment：**未运行**（无激活可归因）。按归因铁律（无 activation 即无注入，行为再好也不可
  归因 PD），A/B 未成对。
- 双胞胎夹具（stack-a/stack-b，同构 4 消费键+过时 example 诱导）保持冻结可用，供下一轮直接复用。

## 11. Negative Control

- 无激活，故无原则侧过度阻塞可观察。
- 会话内前置阴性对照（T1 端口修改）通过：外科手术式修改+备份+验证，原生无过度阻塞。
- stack-b 端口修改任务保持未执行状态（留给下一轮 activation 后作为 N1 检验）。

## 12. Final Outcome

**`NOT_REACHED`** —— 激活未到达，行为观察未发生。

这不是虚无的失败。本轮第一次把"断点在哪"从"管道接线"推进到"产品质量 vs 模型能力"：

1. **PD 的治理层被证明有效**：对抗门每轮都抓到真实代码缺陷（包括一个组合攻击绕过），
   宁可 5 轮全拒也不放行带病产物——这正是"Owner 保护"的产品承诺。
2. **EP001 的死锁（PRI-700 修复环）已被 #1551 修复实证**：修复→reopen→重评级联真实跑通。
3. **非收敛的根因结构已定位**：F1（通道/内容契约错位）+ F7（评估方差）+ bai glm-5.3-flash
   的代码生成质量，三者叠加使"LLM 生成→LLM 评审"闭环无法稳定自举到 approve。

## 13. Remaining Gaps

- **product capability gap**：F1 通道/内容契约错位（prompt 链产物带规则代码；代码反馈无法
  路由到 artificer）——需要产品决策：禁止 prompt 链产代码 / 代码反馈跨级路由 / 渠道分裂。
- **implementation bug**：F2（diag 血缘断线→tier2 不可达）、F3（修复种子复用→非收敛重评）、
  F4（consumer 单 adapter）——均有明确定位与修复方向，留待独立 issue。
- **test infrastructure gap**：双胞胎夹具与 oracle 已冻结可复用；缺一个"activation 模拟注入"
  的 dry-run 预检（在烧 LLM 前预判 stage2 tier2 可达性）。
- **provider uncertainty**：bai glm-5.3-flash 的代码生成质量与评估方差是本轮不可控变量；
  下一轮候选：flatkey-ds 充值后作 artificer 档（EP001 实证其修复轮表现更稳），或评估器换
  deterministic 缺陷类判定。

---

### 附：本轮 PR 与 Linear

- PR（2 个实验保持性修复，experiment-preserving，无 experiment-invalidating 修改）：见 PR 描述。
- Linear：PRI-703 附本轮证据评论；新立 F1/F2/F3/F4 四个独立 issue（各带修复方向与实验影响标注）。
