# PRI-904 Activation → Injection Root-Cause Audit

> 只读审计报告（2026-09-27）。问题：target activation = live、production 正常产生 injection events、live prompt activations = 16，但每次注入固定 9 项且始终是 `activated_at` 最早的 9 项。目标 = 找到 **16 → 9 的第一个确定性断点**。
> 证据源：当前仓库源码、live `.pd/state.db`（readonly）、`.state/logs/events_*.jsonl` 注入账本、仓库外纯函数 replay。零修改。

---

## 1. Executive Summary

16 条候选全部通过 activation reader、资格过滤与 artifact 解析，进入预算选择循环；**第一个确定性断点是 `trimToBudget` 的 2000 字符预算循环**（`packages/principles-core/src/runtime-v2/activation/prompt-activation-reader-contract.ts:115`）：候选按 `activated_at ASC`（FIFO）顺序贪心装入，第 9 项后余额 107 字符，第 10 项（210 字符）触发 `truncated=true; break`。仓库外 replay 用 live DB 的精确字符数复现账本观测值 **selected=[1..9]、injectedCharCount=1893、truncated=true**，与 405+ 条生产注入事件逐字节一致。

target（排名 #14）与另外 6 条 09-22 后激活项因**同一位置性原因**缺席——restore 路径无任何特殊处理。在当前 16 条构成下，ASC 贪心预算物理上最多只容纳 9 项（#10–#16 中最便宜的 186 字符也 > 剩余 107），因此即使把 `break` 改成跳过继续，本轮选择集也不变。

**根因判定：主因 E = BUDGET_TRUNCATION_STARVATION（预算截断导致的位置性饿死）；次因 = FIFO ordering 作为放大器（ASC 固定顺序使新激活永久排在存量之后）。** 复现成立：**STARVATION CONFIRMED**（replay B：仅改排序为 `activated_at DESC`、算法与数据不变，target 即入选）。

## 2. Production Chain

live 工作区 `D:\.openclaw\workspace\.pd\config.yaml`：`features.prompt.enabled=true`、`features.abstraction_layer_v1.enabled=false` → OpenClaw 插件走 **legacy（plugin-local）路由**（`packages/openclaw-plugin/src/index.ts:388-391`：`runtimeGate.enabled=false` 时直接调 `handleBeforePromptBuild(event, ctx)`，第 3/4 参 `sharedActivePrinciplePrompt` 为 `undefined`）。

```text
OpenClaw before_prompt_build hook
  → handleBeforePromptBuild                     packages/openclaw-plugin/src/hooks/prompt.ts:300
    → new PromptActivationReader(...)           prompt.ts:595
      → SqliteActivationStateStore.listPromptActivations()
        SELECT ... FROM activations
        WHERE channel='prompt' AND deactivated_at IS NULL
        ORDER BY activated_at ASC               ← 显式 FIFO 排序，无 LIMIT
        (packages/principles-core/src/runtime-v2/activation/sqlite-activation-state-store.ts:108)
      → filterPromptActivations                 16/16 通过
      → resolvePrincipleFromArtifact            16/16 通过（全部 principle/validated/有 text）
    → dedup vs legacy evolution reducer         prompt.ts:629  crossBlockDuplicateIds=[] → 16/16 保留
    → trimToBudget(dedupedV2, 2000, escapeXml)  prompt.ts:636  ★ 断点：9 入选、#10 break
    → recordRuntimeV2ActivationsInjected        prompt.ts:657  injectedCount=9, injectedCharCount=1893,
                                                       budget=2000, v2Truncated=true, legacySelectedCount=0
```

路由判定复核（非猜测）：

- 安装后的插件 bundle（`~/.openclaw/extensions/principles-disciple/dist/bundle.js`）含 `Runtime V2 activated principles:` 头部与 `if(remaining<entry.length+1){truncated;break}` 循环，与源码 `trimToBudget` 逐一等价；
- 生产注入事件携带 plugin-local 独有字段（`legacySelectedCount`/`legacyTotalChars`/`crossBlockDuplicateIds`），且 `legacySelectedCount=0`、`crossBlockDuplicateIds=[]`（09-25/09-27 采样）——排除 shared 路由（shared 路由下 `v2Result.principles` 恒为空、由 host 发事件）。
- host-shared 路由（`packages/host-runtime/src/active-principle-prompt.ts` 的 `renderPrinciplesToDirectives` 贪心循环）本次不在生产路径上，但它复制了同一个「按 ASC 顺序装不下就 break」的模式——修复应同时覆盖两处（见 §9）。

## 3. 16 → 9 Trace

Q1（reader）：读 `.pd/state.db` `activations` 表，SQL 显式 `ORDER BY activated_at ASC`，**无 LIMIT**，返回完整 16 条。

| # | activation_id (= `act_prompt_` + principleId) | activated_at | deactivated_at |
|---|---|---|---|
| 1 | 意图缺口即风险信号：方向性产出前先澄清并以小样验证 | 2026-09-18T23:42:53.642Z | NULL |
| 2 | 交付前以受众视角自检可理解性并设置强制评审关卡 | 2026-09-18T23:44:17.545Z | NULL |
| 3 | Owner 约定持久化并在阶段开工与生成类行动前强制召回比对 | 2026-09-18T23:46:34.005Z | NULL |
| 4 | 约定召回门：Owner 约定首次表达即持久化，阶段切换或敏感操作前强制 | 2026-09-18T23:47:35.697Z | NULL |
| 5 | 有后果的变更前，以全局引用证据探明关联面，耦合点原子统一变更并验证配对 | 2026-09-19T17:11:54.107Z | NULL |
| 6 | 指令模糊时先确认意图边界，采用最保守的最小删减变更 | 2026-09-19T22:23:21.516Z | NULL |
| 7 | 以可校验的持久化状态为决策依据，保持工作空间可信与整洁 | 2026-09-22T15:09:36.260Z | NULL |
| 8 | 交付前以可观察证据自检：将验收基准显式化并固化为流程门禁 | 2026-09-22T16:01:19.111Z | NULL |
| 9 | 生成式任务须实施全时程约束锁定与分段校验门禁 | 2026-09-22T16:01:48.711Z | NULL |
| 10 | 交付前强制重跑完整管线，以可版本追踪的证据核验宣称 | 2026-09-22T16:01:52.143Z | NULL |
| 11 | 以核验过的最新资产状态为产出依据，而非记忆 | 2026-09-22T16:04:09.580Z | NULL |
| 12 | 覆盖性操作前先核实版本并保持可逆 | 2026-09-23T10:47:27.973Z | NULL |
| 13 | 以接收者可理解为完成标准的沟通原则 | 2026-09-23T10:47:45.465Z | NULL |
| **14** | **结论必须由可观察证据背书：无查验则显式降级为推断（TARGET）** | **2026-09-25T01:04:28.074Z** | **NULL** |
| 15 | 以接收者理解为传达完成标准：先平实结论，后按需展开 | 2026-09-25T13:23:23.102Z | NULL |
| 16 | 产出闭环验证：交付前必须以可观察证据校验产物新鲜度与正确性 | 2026-09-25T15:36:19.050Z | NULL |

Q2（资格过滤）：`filterPromptActivations`（channel/action/deactivatedAt 三项，contract:40）16/16 通过；`resolvePrincipleFromArtifact`（kind='principle'、status='validated'、text 非空）16/16 通过（§表全部行满足，现查）；legacy 跨块 dedup 实测 0 排除。**16 在到达预算循环之前没有任何一条被淘汰。**

Q3（working set / selector）：链上不存在任何名为 workingSet/cap 的中间集合；「9」不来自上游任何选择器，只在 `trimToBudget` 内产生。结论基于 production caller（prompt.ts:595→636）与 bundle 字符串比对，不基于变量名。

## 4. Ordering Evidence

- SQL 层：`ORDER BY activated_at ASC` 为显式排序（sqlite-activation-state-store.ts:108），非 SQLite 偶然返回顺序；
- reader 层（plugin-local 与 host-shared 两个实现）均按 store 返回顺序 push，无二次排序；
- 预算循环按数组顺序贪心，首个装不下即 `break`（contract:131-134）；
- 结果：入选集合恒等于「ASC 前缀」，实测 405+ 注入事件（09-24→09-27）+ canary×3 全新 session 全部 selected=[1..9]——顺序效应与 session 历史无关，已排除「历史 context」归因。

## 5. Budget Evidence

Q4 —— 「为什么恒等于 9」的算术（字符数 = `escapeXml` 后的 `- [<pid>] <text>` entry 长度，现测自 live DB）：

| # | entry 字符 | 装入后 remaining（初始 2000−32=1968） |
|---|---|---|
| 1 | 208 | 1759 |
| 2 | 150 | 1608 |
| 3 | 223 | 1384 |
| 4 | 226 | 1157 |
| 5 | 143 | 1013 |
| 6 | 147 | 865 |
| 7 | 290 | 574 |
| 8 | 216 | 357 |
| 9 | 249 | **107** |
| 10 | 210 | **107 < 210+1 → truncated=true, break** |

- 预算常量 `RUNTIME_V2_PRINCIPLE_BUDGET = 2000`（contract:3）；header `Runtime V2 activated principles:` 32 字符；
- `truncated=true` 的设定点：`prompt-activation-reader-contract.ts:131-133`（生产路由）；shared 路由对应 `active-principle-prompt.ts` 预算循环（同一模式）；
- 注入内容 = `lines.join('\n')` = 32 + Σ(1..9 entries)=1805 + 9 个换行 = **1893** —— 与生产事件 `injectedCharCount=1893` 精确一致（公式经反向求解并 replay 验证）；
- 无硬编码「9」：Case A（hard cap）排除（全链无 cap=9；SQL 无 LIMIT）；Case B/C 的复合：先按 FIFO 排序、再贪心 break 截断，9 是当前 16 条构成下 ASC 前缀的最大容量。
- 关键辅助事实：#10–#16 的 entry 长度为 186–286，全部 > 剩余 107 —— 截断点之后没有任何更小的候选可以被「跳过继续」装进，本轮 break 与 continue 的选择集相同。

## 6. Starvation Replay

Q5 —— 仓库外纯函数 replay（`/tmp/pd_acts_exact.json`，16 条 live 数据 + 精确 escapeXml 长度，复刻 `trimToBudget` 算法）：

**A. 现状（activated_at ASC）** → selected=[1,2,3,4,5,6,7,8,9]，9 项，1893 字符，truncated=true，target 未注入。**与生产账本完全一致 → replay 保真度成立。**

**B. 仅改排序为 activated_at DESC，算法/预算/数据不变** → selected=[16,15,14,13,12,11,10,9]，8 项，1907 字符，truncated=true，**target(#14) 注入**。

**C. 不截断诊断** → 16 项全量内容 = 32 + 3470 + 15 换行 = 3517 字符，超预算 1517；到 #14 时累计超支 971 字符。

**D. break→continue（跳过继续）** → 选择集仍为 [1..9]（#10–#16 无一 ≤ 107）——证明本轮饥饿由「预算 + ASC 前缀」共同造成，`break` 语义是放大器但当前数据下非独立充分因。

**结论：STARVATION CONFIRMED。** 判定依据是 replay B：其他一切不变、只把顺序反过来，target 立即进入注入集并在 8/16 的位置稳定保有席位。这不是概率或「可能」——同一函数、同一数据、同一预算下的确定性输出差异。

## 7. Restore-path Comparison

Q6 —— target 与 #10–#13、#15–#16（09-22T16:01:52Z 之后的其余 6 条）逐条对比：

| 维度 | target (#14) | 其余 6 条 (#10–13, #15, #16) |
|---|---|---|
| channel / action | prompt / prompt_activate | 同 |
| deactivated_at | NULL | NULL |
| artifact kind / status | principle / validated | 同 |
| filterPromptActivations | 通过 | 通过 |
| resolvePrincipleFromArtifact | 通过 | 通过 |
| legacy dedup 排除 | 否（crossBlockDuplicateIds=[]） | 否 |
| 注入缺席原因 | ASC 排名 #14 > 预算容量 9 | ASC 排名 #10–#16 > 同一容量 |

7 条被排除的机制**完全相同**（位置性截断）。target 的 restore 痕迹（无 `activation_decisions` 恢复行、approval `decided_by=owner-authorized-pri904`）不进入注入链任何判定——reader/selector 不读 decisions 表。**问题不是 target 的 restore 特例，是后发激活的共性饥饿。**

## 8. Root Cause

Q7 判定：

```text
主因：E. BUDGET_TRUNCATION_STARVATION
次因：F 的排序半 —— ORDERING (activated_at ASC 固定 FIFO) 作为放大器
```

论证：
1. 排除 A/B/C/G：reader 返回完整 16（§3）、无资格过滤损耗（§3 Q2）、无 cap/LIMIT（§4）、序列化无缺陷（replay 逐字节复现 1893，§5/§6-A）。
2. 排除纯 D（selector ordering starvation 单独成立）：预算 2000 只装得下 ~9.5 条当前均值条目——**任何固定顺序的贪心都会截断某个后缀**；若只有排序问题而无预算压力，7 条新项会全部注入。
3. 排除纯「break 语义」归因：replay D 证明把 break 换成 continue 在当前数据下选择集不变（§6-D）。
4. E 成立的确定性证据：截断点（remaining=107 at #10）由预算算术唯一决定，且对 #10 之后的所有激活构成**永久性前缀饥饿**——除非存量退役，后发者永无入选机会（新项越靠后越无机会，与「学习环刚激活的原则最需要生效」的产品意图直接冲突）。
5. FIFO(ASC) 半因的证据：replay B 单变量翻转顺序即翻转为「最新 8 项入选」——顺序策略决定谁被饥饿，预算决定必然有人被饥饿。

一句话：**2000 字符预算下，贪心截断 + 固定 FIFO 顺序使注入集恒等于「最老的 9 条」前缀，全部后发激活（含 PRI-904 target）被确定性地、永久地位置性饿死。**

## 9. Minimal Fix Surface

只描述，不实现。断点集中在两处同模式循环，修复无需新 subsystem / 新 DB / 新 activation model / 新 Resolver / migration：

1. **首选：selector 局部轮转策略（一处函数体内改动）** —— `trimToBudget`（contract:115，生产路由）与 `buildActivePrinciplePromptContext` 预算循环（host-runtime/active-principle-prompt.ts，shared 路由）同构修改：在贪心装填时不再要求严格前缀，改为按一个确定性的轮转起点（如按 activation 序号取模推进 offset）选起点，保证长期内每条 live activation 在若干轮内至少获得一次注入席位。改动局限在既有函数体，无新持久状态（offset 可由已注入计数等既有事实推导），两路由共享 contract 层即可同步生效。
2. **次选：recency 加权排序** —— 在 dedup 之后、trim 之前把候选顺序从纯 ASC 改为（例如）recency 优先或 owner/receipt 证据加权。replay B 证明单改这一行排序键即可让 target 立即恢复在场。代价：老原则反向饥饿（同样需要在 §1 的轮转里对冲）。
3. **预算政策（Owner 决策项，非代码缺陷修复）** —— 2000 字符（约 9 条当前均值条目）已小于任何有意义的多原则工作集；若 Owner 希望 16 条都有稳定在场，须同时调整 `RUNTIME_V2_PRINCIPLE_BUDGET` 或收紧原则文本长度。本次审计未动任何预算值。
4. **观测面（可顺手）** —— 截断事件当前只报 `truncated=true`，不含「被截断的 activationIds 及各自 entry 长度」；在既有事件字段上补一个有界列表即可让下次饥饿可判。属现有 emit 的字段扩展，非新事件类型。

最小验证差集：以上任一改动都以 §6 replay 三态（A 保持可复现 / B 或 D 行为变化符合预期）为回归基线。

## 10. Owner Review Card

1. **Problem** — 学习环完整走通并恢复为 live 的 Principle（PRI-904 target）从未进入注入；追查发现是全部 7 条后发激活的共性饥饿。
2. **Before** — 16 live activations → 每次注入固定「最老 9 条」，后发 7 条（含 target）永久缺席，事件层 `truncated=true` 无解释力。
3. **After** — （本审计不改代码）根因定位到 `trimToBudget` 预算断点 + FIFO 放大器，replay 三态证实。
4. **Existing mechanism reused** — 全程复用既有 reader/contract/事件账本；诊断脚本为仓库外一次性文件，未落库。
5. **Complexity Delta** — 全 NO：新增 truth source / schema / subsystem / public abstraction / flag / 跨包依赖 / host 特判 / 外部网络能力均为零。本交付是一份只读文档。
6. **Design reason** — 只回答「第一个确定性断点」，未顺手修任何代码，未调任何预算/配置。
7. **Verification** — replay A 与生产账本逐字节一致（9 项 / 1893 字符 / truncated=true）；单变量 replay B 翻转入选集；16/16 资格事实、路由字段（`legacySelectedCount=0`、`crossBlockDuplicateIds=[]`）、bundle 字符串比对均现查。
8. **Risk** — 若修复采用 recency 优先，存量老原则反向饥饿；若调预算，prompt 膨胀侵蚀宿主 context；任何改动都会使 PRI-904 B/P 窗行为率口径变化（FC6 敏感）。
9. **Rollback / recovery** — 审计本身无副作用；行为回滚 = 不改即维持现状。target 恢复在场的零代码临时出路：退役/停用部分老原则使前缀腾位（属 Owner 决策，非本审计建议自动执行）。
10. **Follow-ups** — host-shared 路由同模式循环的同步修复、截断观测字段扩展、预算政策评审，均未实施；PRI-904 观察窗继续按原协议推进（W-del 事实层不变：decision 层已恢复、injection 层因本根因未恢复）。

---

*只读审计。未修改源码、DB、activation、ledger、配置；未创建 PR；未调整 budget/cap。*
