# PHASE7_OWNER_DECISION_CARD.md — Phase 7 最终 Owner 决策卡（2026-11-15）

依据：本轮生产溯源（11-11 事件族 5 候选→3 注册全链还原+telemetry 复用门实况）、12 入口写入调用图、association 全库消费者盘点、Distiller 契约影响分析。基线 `161763546`；无模型调用、无生产写入、无代码改动。配套 SPEC：LEDGER_WRITE_SAFETY_SPEC.md / RECOMMENDATION_ASSOCIATION_CONSUMER_SPEC.md。

## 决策 1：Ledger 是否需要立即修复？——**需要（建议立即，分三步灰度）**

证据：同一事件族 3 条近义原则已进入生产 Ledger（946754bf active / 26858b6f / c2f14d1a），其中两条是在复用门**正确识别重复（confidence 0.95/0.72）之后**仍被注册的——防线形同虚设的原因不是"没检测"，而是 park 不粘、create 无审计、写层零防御（LEDGER_SPEC §1.2 三层缺陷）。另 2 条候选（3cbc8f58/22fda599）靠桥接 park 挂起至今——持有方式是脆弱的（换路径即失效）。

建议顺序（每步独立可回滚）：
1. **精确查重层**（确定性、零业务策略变更、零 Schema 迁移）——最先；
2. **park 持久化统一 + park 后自动再创建禁令 + create 审计**——次之；
3. **"评估不可用 → 挂起转人工"（Rule 4 修订）**——最后，需 Owner 明确批准（改变 PRI-939 既有策略）。

存量处置：已注册的 26858b6f/c2f14d1a 建议 Owner 用现有归档通道（Console archivePrinciple）处置或 `pd candidate review` 式合并——本 SPEC 不含存量清理实现，命令与影响需 Owner 另行授权。

## 决策 2：精确查重采用什么方案？——**锁内规范化摘要前置检查（无 Schema 变更）**

方案：`normalizePrincipleText`（NFKC+标点/空白规范化+小写）→ sha256 → 在 `addPrincipleToLedger` 的 `mutateLedger` 锁内、写入前对全库（54 条量级）即时比对；命中→不写、返回既有条目、以既有 `appendReuseEvidence`（actor=ai_owner/exact-dedupe-guard）落审计。全 12 入口自动覆盖（唯一 chokepoint）；TOCTOU 关闭（检查-写入同锁）；零迁移（摘要不持久化，语料 10^2 量级即时计算成本可忽略）。
明确边界：只防逐字/标点/空白级精确重复（生产对非逐字同，由决策 3 的语义门负责）——不冒充语义查重。细节见 LEDGER_SPEC §三/§五/§六。

## 决策 3：LLM 评估不可用时采用什么策略？——**推荐 C（挂起转人工），保持 A 为回滚位**

三策略对比全文见 LEDGER_SPEC §4.1。要点：
- A（现状 fail-open）：数据安全差（2026-10-06 一天 5 次 unavailable 实证放行）；
- B（fail-closed 禁建）：推翻 PRI-939"评估失败永不阻塞学习"的 Owner 已决策略，且候选上下文丢失；
- **C（推荐）**：评估失败→候选挂起（复用既有 `reuse_pending_owner` 通道+新 reason），诊断/候选不停、账本不受损、候选零丢失可批量裁决。**前提**是决策 1 第 2 步先行（park 持久化+解除留痕），否则挂起可被越过（本事件族已实证）。
残余风险披露：评估长故障→挂起队列增长（可见、可逆、精确层持续工作）。
Rule 2（uncertain→create）不变——那是业务判定不是故障。

## 决策 4：是否批准 Bridge 消费 recommendationAssociation？——**批准 Phase A（flag-off 灰度），前置一项拓扑验证**

方案：桥接种子前按已持久化的 `sourceRecommendationJson` 关联分组——`linked` 的 rule→principle 同组；每组只种 1 条 Dreamer（锚=principle 候选）；载体候选经既有 `inputArtifactRefs`（`candidate://`）进入锚链上下文；rule 通道产物从锚链派生并保持 40/40 人审门语义不变。新 quiet flag 默认 **off**（回滚=开关）。
**前置门**：单 Philosopher 双通道 Scribe（prompt+code_tool_hook）的后继拓扑从未在生产出现过——orchestrator 幂等键 `(parentTaskId,kind,channel)` 结构上支持，但必须先补编排级验证再实现（ASSOCIATION_SPEC §四.3/§六.2）。
红线已内置：不删 Rule/Prompt 载体；分组≠绑定（Ledger 绑定仍走 Owner 门）；未确认关联不自动合并；Candidate 创建策略不变（Owner 评审面不动）。

## 决策 5：是否批准后续 Distiller 输入/输出契约升级？——**批准"输入侧注入"预研，输出侧维持单原则（暂不升级）**

基于现有代码的影响分析（§5 边界）：

| 问题 | 结论 |
|---|---|
| 如何提供既有原则上下文？ | 复用 Router 已有的 `RouterTrustedPrincipleSource.readTrustedPrinciples`（adapter 现成端口，Router 经 trustedContext 低信任通道注入；PRI-1146 P1-02 确立"原则数据不进 system prompt"纪律）——Distiller 同款注入：builder 增 trustedContext 段+runner 传入（**契约改动，非提示词文字改动**；RootCause 不动） |
| `buildReuseShortlist` 能否直接复用？ | 能作为"候选上下文挑选器"（读 Ledger→top-K），但**不能作为过滤器**——词法召回率不足（见下） |
| 词法评分器召回率够吗？ | **不够**（实测）：同 Pain 高重叠 0.68 可见；跨 Pain 语义家族 91 对仅 1 对过 0.15（S02↔S08、S03↔S12、S04↔S06 均 0 分）——作为 top-K 上下文"聊胜于无"，作为拦截器会漏掉绝大多数家族 |
| 是否在 Distiller 输出增加复用判断？ | 不建议现在做——语义复用判断已在 Ledger 复用门存在（LLM 评估+Owner 裁决），Distiller 重复建一套会产生第二个语义真源（违反 P4）；且 Distiller 无 Owner 通道 |
| 如何保留同一 RootCause 的多个独立纠正机制？ | 现状：次要机制已在 rootCause 字段保留（RootCause/Distiller/Router 三层均未丢失信息，只是 Router 不路由次要因素）——最小路径是**Router 侧**允许路由次要机制（defer/principle 追加），而非 Distiller 多原则输出 |
| 多机制输出的兼容代价？ | `abstractedPrinciple` 数组化 = 破坏性契约升级：Router 提示词"AT MOST ONE principle entry"以 Stage B 单原则为前提（须同步改）、committer/intake/复用门/内化桥/上轮预注册的指标口径全部受影响——**不能只加一个数组字段**；收益（多机制表达）可用"Router 路由次要机制"以更小代价获得 |

结论：Distiller 契约升级**暂缓**；若 Owner 批准，先做输入侧 trustedContext 注入的独立 SPEC（与决策 4 的分组、决策 1 的写层防护无依赖，可并行设计）。与上轮 V2.2 预注册的衔接：预注册 Treatment A（播种侧去重）应改由本卡决策 4 的分组方案承载——预注册需按新证据修订后重批。

## 决策 6：并行/串行安排

```
可并行（互不依赖）：
  线 1：精确查重层（决策 2）→ park 持久化（决策 1 步 2）→ Rule 4 修订（决策 3，需单独批准）
  线 2：association 分组拓扑验证 → Phase A 实现（决策 4）
  线 3：Distiller trustedContext 注入预研 SPEC（决策 5 批准后）
  线 4：存量重复原则处置（Console 归档/合并，Owner 操作）
必须串行：
  - 决策 3 依赖决策 1 步 2（挂起必须先能粘住）；
  - 决策 4 的实现依赖其前置拓扑验证通过；
  - 线 1 与线 2 都改桥接/种子路径——合并顺序需协调（建议线 1 先合，线 2 rebase）；
  - 全部实现须在 Owner 批准对应 SPEC 后进行（本轮零实现）。
```

## 附：本轮证据索引

- 溯源原始数据：`.tmp/prompt-v2-ab/next-task/`（trace-first-write.mjs + 生产 state.db/ledger/telemetry 只读查询记录）
- 生产 telemetry：`D:/.openclaw/workspace/.pd/telemetry/critical-events.jsonl`（9 条 reuse 事件，含 18:08:19 的 0.95-reuse-park 与 18:26:35 的 0.72-reuse-park）
- 生产 Ledger：`D:/.openclaw/workspace/.state/principle_training_state.json`（54 条只读快照）
- 源码定位：两份 SPEC 内全部 文件:行号 引用
