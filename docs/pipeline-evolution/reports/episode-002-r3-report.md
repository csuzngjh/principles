# EP002-R3 Report — RuleCode First Activation（治理门拒绝终局 CLOSED）

> 实验：EP002-R3（2026-09-10 22:00 启动，09-11 11:5x 终局）。基线 origin/main `775ffb536`
> （含 #1588/#1590/#1591/#1592/#1593 + #1596/#1597）。worktree
> `D:\Code\principles-PRI-703-episode002-r3`（零产品代码改动）。计划冻结于任何 Episode LLM
> 会话之前：`experiment-plan.md` + `experiment-manifest.json`。
> 机器快照：`evidence/state-snapshot-final.json`（18 tasks / 50 runs / 17 artifacts /
> **approvals 0 / activations 0**，冻结于网关停止后）。

## 1. Core Verdict

**NOT_REACHED — RuleCode 未到达 Approval/Activation/Enforcement/行为变化。**

与 R2 不同，本轮治理链走完了**全程最后一环**：确定性对抗门拒绝 → rollout 两轮打回 → 正式修复
预算（r1/r2）耗尽 → `rollout_revision_budget_exhausted` NHR → **模拟 Owner 走生产应用层提交
`reject_current`（ores_1a069615280cba127621，applied 2026-09-11T03:50:36Z）→ 链 REJECTED 终局**。
不是管道断裂，是治理系统对带缺陷产物的**正当拒绝**（同 R2 的 governance-positive 结论，
且本次多走完了 Owner 裁决环）。

## 2. Pipeline Trace（真实阶段 × 证据）

| 阶段 | 结果 | 证据 |
|---|---|---|
| Pain | ✅ 真实发生 | S001 两轮会话 ep2r3-s001；T1 阴性对照成立（外科手术式改端口+备份+verify 过）；T2 发明 logLevel/retries（B4=2），agent **已枚举消费者还自述"未被读取"仍写入**；pain `manual_1789050949518_m246b8t5` score 70，2 候选 admitted，双通道种子（prompt+code_tool_hook） |
| Diagnosis | ✅ 四段链全 succeeded | `dataset-diagnosis-chain.json`（diag_router 429 重试后过） |
| Principle | ✅ 双链 scribe 产物 validated | prompt 链全程跑通（evaluator 一次过+rollout succeeded）——按防污染纪律**未批准未激活**；code 链 scribe validated（`dataset-principle-codechain.json`） |
| RuleCode 生成 | ✅ 三版，compile/execute/return-decision 独立验证通过 | 生产同一 node:vm batch runtime（`tools/verify-rulecode.mjs`）；v1 5060c（bai）→ v2 8241c（bai，rollout 打回后修）→ v3 6132c（zai，正式修复轮） |
| Evaluator | ⚠️ LLM approved 0.87/0.88/0.90，needs_revision 0.74/0.80；**确定性重放 5 轮全部 passed=false** | `dataset-evaluation-final.json`；r4 抓到修复引入的 .env 死条件真缺陷 |
| Rollout | ⚠️ needs_revision ×2（0.88/0.85，抓"评估叙述与回放证据矛盾"）→ r3 needs_human_review（budget_exhausted） | `dataset-rollout-final.json` |
| Repair（正式预算路径） | r1 成功（zai att=2）、r2 成功（zai att=4）；修复把可修缺陷清零（0.90），唯二残留=模板断言 | repair 任务 `artificer-repair-evaluator-...-r1/r2` |
| Owner Decision | ✅ **真实行使**（模拟代投，生产应用层） | eligible/owner_decision/[accept,revise_once,reject]；`evidence/owner-decision-reject.json`；resolution **applied**，rollout 终局 |
| Approval / Activation | ❌ NOT_REACHED | approvals=0、activations=0（产物被正当拒绝，无 activation 可归因） |
| Behavior A/B | 不适用（归因铁律：无 live activation 即无注入） | baseline=R2 冻结基线（B4=3）；pain B4=2 已留档 |

## 3. Artifact IDs

- Pain：`manual_1789050949518_m246b8t5`（候选 103af1ee…（prompt）/ 4a77967e…（code_tool_hook））
- RuleCode（code 链 artificer/repair 产物，实现全文在 `evidence/rulecode-*-impl.txt`）：
  - v1：`pi-art-artificer-4a77967e-…_5`
  - v2：`pi-art-artificer-4a77967e-…_6`
  - v3（修复 r1）：`pi-art-artificer-repair-evaluator-4a77967e-…-r1_2`
  - v4（修复 r2）：同族 `-r2` 系列
- 评估终版：`pi-art-evaluator-4a77967e-…_3`（att=6 产物，approved 0.90 / replay failed ×2 模板）
- Rollout 终版：`pi-art-rollout_reviewer-4a77967e-…_3`（NHR 源产物）
- Owner resolution：`ores_1a069615280cba127621`（reject_current，reviewKey odk_5c4c…）
- **rule-kind artifact：0 个**（组装前提 `adversarialResult.passed===true` 从未满足）

## 4. Runtime Enforcement Logs

无（无 live activation → RuleHost 无规则可加载）。归因铁律适用：行为层不可归因 PD。
留档：lab 配置、host-tool-semantics/openclaw.json（write/edit→write 映射存在但规则层未消费）。

## 5. Behavior Comparison

不适用（同上）。Baseline 与 pain 证据已留档供下一轮复用。

## 6. 结构性发现（本轮核心产出）

- **G1 修复信息不对称**：v2 模板用例内容对 repair LLM 不可见；rollout requiredChanges 的概括描述
  （"prod 路径段×配置扩展名组合必须 block"）与模板用例真实构造（/etc/passwd.bak 必须 block）
  对不上——修复只能靠猜，不可能收敛。
- **G2 语义层次混载**：`partitionV2OutOfScopeFailures` 只把 allow-expecting 模板（v2-unavailable）
  判 out-of-scope；block-expecting 模板（v2-path-boundary/v2-combination）被有意视为规则必须满足的
  安全断言。后果："证据检查型"领域规则（本 pain 的正确形态）必须额外实现通用 risk-path 防线
  （/etc/passwd 家族）才能过门——且 v2-unavailable 的"无历史必须放行"与领域语义"无证据必须拦截"
  在同一场重放中语义相克。修复 LLM 两轮把可修缺陷全部清零（0.87→0.90）也无法跨越这 2 例。
- **G3 宿主工具名缺口（生产执行面）**：三版规则都以 raw toolName 判别写工具（write_file/edit_file 系），
  OpenClaw 原始名（edit/write/exec）全部落 allow/not-applicable；RuleHost `evaluateDetailed` 不做
  affectedTools 过滤、`buildRuleHostAction` 原样透传 raw toolName、`canonicalKind` 字段存在但规则层
  无消费约束。**即使治理门放行，规则在生产宿主上也永不触发**；对抗重放结构性测不出（用例由规则作者
  自命名）。独立验证矩阵见 `tools/verify-rulecode.mjs` 输出。
- **G4 provider 契约**：pi-ai 对 thinkingFormat=zai 的 reasoning 模型默认发
  `thinking:{type:"disabled"}`，zai"始终思考"模型 400 (1210)；`PdLocalRuntimeProfile` 无
  reasoning/thinking 通道。本轮以 model id 大写变体（GLM-5.3-Flash）绕开 catalog 精确匹配——
  依赖 zai 服务器 id 归一化，脆弱、非契约。
- **G5 环境**：deepseek 路由三连断（flatkey $0.008 / 官方 402 / bai-ds 0 余额）；bai/zai 大 payload
  流超时常态（900s 窗口单次成功率 ~1/3，1500000 后改善）；bai 429（Tencent concurrency 1200）间歇。

## 7. LLM Provider 战况

flatkey-ds ❌（余额）→ bai glm-5.3-flash 32k ⚠️（429+流挂起，att=5/6 成功、att=7 三连死）→
**zai glm-5.3-flash（Owner 新 key）**：400 1210 → 大写 id 绕行成功（att=12 出 v3 产物、repair r1/r2
成功）→ 1500000ms 超时窗口。最终全链（artificer/evaluator/rollout）在 zai 上完成收尾。

## 8. 治理行为记录（本轮最有价值证据）

1. 确定性对抗门 5 轮全部拒绝（模板断言 + LLM 自造对抗用例缺陷 + __return_shape__ 形状校验）。
2. rollout 两次抓"evaluator approved 与回放证据矛盾"（r1 0.88 / r2 0.85），一次在 NHR 里明确要求
   "根因澄清（通道结构限制 vs 规则缺陷）+ v2 模式复验"后才宜放行。
3. evaluator r4 抓到修复引入的 .env 死条件回归（basename 拆分永不命中 + 双通道行为矛盾）——对抗门
   对回归的拦截真实有效。
4. 修复预算耗尽 → NHR（decision-capable）→ Owner 裁决走 CAS/stale 防护的生产应用层 → applied →
   链终局。全程无直写 DB。

## 9. Remaining Blockers / 后续方向

- PRI-720（Channel-aware DAG）方向被 G1/G2 进一步强化：问题不只是"prompt 链产代码"，而是
  **确定性门的模板断言与领域规则语义的强制耦合**——通道语义分层（领域断言 vs 通用防线 vs 上下文
  语义三组用例分场重放）是 RuleCode 通道能跑通的前提。
- G3 需要产品修复：规则生成 prompt 注入宿主工具声明（hostToolCatalog 已在 evaluator 手里）+
  canonicalKind 消费规范 + 对抗重放用例的宿主名覆盖。
- G4 需要产品修复：profile 增加 reasoning/thinkingLevel 通道（或 pi-ai zai 分支对
  thinkingLevelMap.off===null 的模型不发 disabled）。
- 环境：deepseek 路由充值/备用、zai key 已入 lab env（**聊天中明文出现过，建议 Owner 轮换**）。

## 10. 与 R2 的差异（入场条件核销）

| R3 入场条件（playbook） | 实际 |
|---|---|
| PRI-720 合并 | 未合（Todo）——但实验证明 code 链断点不依赖 PRI-720；且本轮证据反过来强化 PRI-720 的立单理由 |
| 717/718/719 已修 | ✅ 全部实证生效（per-stage profile 日志、修复轮语义、无 tier2 断链） |
| 复用 R2 资产 | ✅ 夹具/oracle/baseline/配方全复用 |
| 只跑 treatment prompt 链 | 改判：本集目标=RuleCode，跑的是 **code 链**（prompt 链仅作对照且未激活） |
| bai 可行性 | 部分：两条 deepseek 路由全断，bai 大 payload 不稳，最终 zai 收尾（Owner 指令） |
