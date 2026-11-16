# LEDGER_WRITE_SAFETY_SPEC.md — Phase 7 P0：Ledger 写入安全整改 SPEC（2026-11-15）

状态：**设计稿，未实施**。基线源码 `161763546`（PR #2653 分支，本轮核实未漂移）。全部证据来自生产只读数据与本轮源码追查；无模型调用、无生产写入、无代码改动。

## 一、生产重复记录根因（§2.1 完整溯源）

同一事件族（Agent 未获授权修改 Owner 配置文件）在 2026-11-11 的 65 分钟内被上报 **5 次**（5 次独立诊断）（17:21 / 17:26 / 17:50 前后 / 18:26 前后各一次 Pain），经 5 轮独立诊断产生 **5 条 principle-kind 候选**，最终 **3 条进入 Ledger、2 条仍挂起**：

| # | 候选 | 时间线 | 复用门实况 | Ledger 结果 |
|---|---|---|---|---|
| 1 | `370c1dda` | 17:27:45 创建 → 17:27:52 消费 | 门运行；短名单**非空**（2e42ef1b@0.34 / 96608bec@0.21 / 836e759a@0.18，生产评分器重建）→ LLM 评估返回 **create/uncertain**（裁决无持久记录） | **946754bf**（后经 Owner 批准转 active） |
| 2 | `3cbc8f58` | 17:50:17 创建 | 桥接 park（`awaiting_owner/reuse_pending_owner` 已写入；**telemetry 事件丢失**——该桥实例未注入 sink） | 仍 pending（park 稳定持有） |
| 3 | `22fda599` | 17:53:33 创建 | 同上（awaiting_owner 持有） | 仍 pending |
| 4 | `2fd0e91b` | 18:08:14 创建（Router 重试 5 次后成功） | **18:08:19 门触发：LLM 评估 reuse、confidence 0.95、选中 946754bf**（telemetry `reuse_gate_triggered` 持久化）→ park；**33 秒后**（18:08:52）被第二次 intake 消费并注册 | **26858b6f**（candidate） |
| 5 | `19aa989d` | 18:26:27 创建 | **18:26:35 门触发：reuse、confidence 0.72、选中 26858b6f**（telemetry 持久化）→ park；**8 秒后**（18:26:43）被第二次 intake 消费并注册 | **c2f14d1a**（candidate） |

### 1.1 两条指定记录的完整链路

**946754bf-8baf-4fe4-a1ea-110bf78a1c4e**（active）：

```
Pain manual_1794418012684_irykvcps（17:26:52 提交，user_correction，host=openclaw）
→ diag_rootcause-diagnosis_manual_1794418012684_irykvcps（run_1 succeeded 17:26:52-17:27:28，People 类）
→ diag_distiller-…（17:27:28-17:27:21 成功）
→ diag_router-…（run_1 17:27:28-45 成功）
→ principle_candidates 行 370c1dda-…（kind=principle，admission admitted，17:27:45.776）
→ consumed 17:27:52.170（CandidateIntakeService.intake，复用门：短名单 3 条→LLM 评估判 create）
→ writeProbationEntry → addPrincipleToLedger（盲写）→ 946754bf，createdAt 17:27:52.160
→ 后续链：dreamer-370c1dda-prompt（17:28:32）→ rulehost philosopher/scribe → artificer/evaluator
→ Owner 批准激活 → activatePrinciple → status=active（updatedAt 2026-11-13T03:26:50）
SHA-256：raw text 5fe6a4a13ae17ed8…（79 字符）；NFKC+空白规范化 c5395207f6749583…
```

**26858b6f-7e45-45a6-b4ef-95bcf2610dd7**（candidate）：

```
Pain manual_1794417662834_86wvtpyy（17:21 前后提交——比第一条的 Pain 早 6 分钟，同一事件）
→ diag_rootcause-…（17:21 成功）→ diag_distiller-…（17:21 成功）
→ diag_router-… attempt1-3 失败（output_invalid ×2 + max_attempts，17:22-17:25）
   attempt4 失败（18:06:49 output_invalid）→ attempt5 成功（18:07:53-18:08:14）——修复重试
→ principle_candidates 行 2fd0e91b-…（admitted，18:08:14.664）
→ intake #1 18:08:19：复用门触发 → LLM 评估 reuse/confidence 0.95/选中 946754bf
   （telemetry critical-events.jsonl 2026-11-11T18:08:19.017Z）→ reuse_pending_owner，候选 PENDING
→ 18:08:52.569：第二次 intake 消费并注册 → 26858b6f（盲写）
   → dreamer-2fd0e91b-prompt（18:09:06 成功）→ philosopher/scribe 链完成
SHA-256：raw text a79dd1da3d72a71c…（80 字符）；规范化 011856488aece52e…
与 946754bf 逐字/规范化均不同（互分 0.6842）→ 精确查重抓不住这对，语义门抓到了（0.95）但 park 未被遵守
```

### 1.2 为什么两条都进了 Ledger（直接回答）

三层缺陷叠加，缺一不成立：

1. **写层零防御**：`addPrincipleToLedger`（`principle-tree-ledger.ts:509-515`）是 `store.tree.principles[id]=principle` 盲写——无文本比对、无规范化摘要、无近似检查。任何到达第 6 步的 intake 必然落库。
2. **park 是建议性的，不是持久阻断**：18:08:19 的 park 没有写入任何"此候选已被判为重复"的持久状态——CLI 路径的 park 不写 `awaiting_owner`（只有桥接路径写，`pain-signal-bridge.ts:1452`），且**没有任何机制阻止后续 intake 对同一候选重新评估**。33 秒后的第二次 intake（桥接周期或人工命令）重新走门：LLM 评估重新掷骰（无 temperature 约束，reasoning=high），翻转即 CREATE；或者是 Owner 通道 `pd candidate review --decide create`（固定裁决，门放行）。**两种路径都不留任何持久审计记录**（create 裁决/评估 create 均无 telemetry、无 evidence——只有 park 和 unavailable 才有事件）。
3. **词法阈值的结构性盲区**：第一次写入时门其实运行了且短名单非空，但 LLM 评估判 create（与后来 0.95 的自相矛盾，说明语义评估本身不稳定）；而词法层对"同族不同措辞"（跨 Pain 家族）大多 <0.15 不可见（Phase 5/6 实测 91 对仅 1 对可见）。

**即：门每次运行都工作（0.95/0.72 两次正确识别），但识别结果既不能持久阻断（park 可被越过），也不留痕（create 无审计），写层又不设防。**

### 1.3 附带发现（同一事件族的额外证据）

- Router 修复重试（attempt 5）本身不产生重复候选（committer 幂等）——重复来自"多次独立上报同一事件"+"park 不粘"。
- telemetry 覆盖不一致：桥接实例未注入 sink 时 park 事件**静默丢失**（`pain-signal-runtime-factory.ts:848` 注释自认"degrades to the pre-Option-A in-process singleton"）——3cbc8f58/22fda599 的 park 因此不可审计。
- 18:26:35 的 park 选中了 **26858b6f** 作为复用目标（此时它已在账本中）——系统把第二个重复当成了"正本"，说明重复注册会自我强化（正本混淆）。

## 二、完整写入调用图（§2.2 全量入口盘点）

`addPrincipleToLedger`（`principle-tree-ledger.ts:509`）的全部生产调用方（反向追踪）：

| # | 入口 | 位置 | 复用门 | 候选级幂等 | 备注 |
|---|---|---|---|---|---|
| 1 | `writeProbationEntry`（intake 主路径） | `adapter/principle-tree-ledger-adapter.ts:143-152` ← `candidate-intake-service.ts:863` | **有**（hook 注入时；全部生产 CLI/桥路径已接线） | `existsForCandidate`（血缘匹配） | 两条生产重复都走此入口 |
| 2 | `pd candidate review --decide` | `pd-cli/src/commands/candidate.ts:858-868` | **固定 Owner 裁决**（不跑 LLM；create 裁决直接放行） | 有 | create 决定**零持久审计** |
| 3 | `pd candidate intake`（手动） | `candidate.ts:1069` → `createReuseGatedIntakeService` | 有 | 有 | R7 修复后已接线 |
| 4 | `pd candidate repair` | `candidate.ts:1650` | 有 | 有 + CR-05 恢复幂等 | |
| 5 | internalization backfill | `candidate.ts:1945` | 有 | 有 | |
| 6 | diagnose 内联 intake | `pd-cli/src/commands/diagnose.ts:675-678` | 有 | 有 | **park 不写 awaiting_owner**（缺陷） |
| 7 | pain-retry intake | `pd-cli/src/commands/pain-retry.ts:1051` | 有 | 有 | |
| 8 | 桥接自动 intake（enabled pipeline） | `pain-signal-runtime-factory.ts:831-837` | 有（`effectiveConfig` 缺失时静默无门——全部现存生产调用方均传） | 有 + CR-05 | park 写 awaiting_owner；**sink 缺失时 park 事件丢失** |
| 9 | 桥接 disabled 变体 | `pain-signal-runtime-factory.ts:907` | **无**（裸构造） | — | 仅 capability-disabled 时存在，永不产生候选（休眠安全） |
| 10 | evolution-reducer（legacy） | `openclaw-plugin/src/core/evolution-reducer.ts:407` | **无**（仅按 painId 查重，`evolution-reducer.ts:269-272`） | 无 | `evolution_worker=false`（生产 config）→ **休眠**；derivedFromPainIds=[painId] 可与入口 1 区分 |
| 11 | bootstrap / init 种子 | `bootstrap-rules.ts:118`、`init.ts:225` | 无 | 无（按 ID） | 公理种子；重跑会同 ID 覆盖（幂等靠 ID 稳定） |
| 12 | pruning 清理 | `pruning-read-model.ts:382` | n/a | n/a | 仅改写 derivedFromPainIds（孤儿清理），同锁全量重写 |
| — | 状态翻转（非新增） | `adapter activatePrinciple:315`、console `updatePrinciple` | n/a | — | 只改 status/updatedAt |
| — | 模拟/演示 | `synthetic-baseline-runner:207`、`pain-flood-simulation:309`、`demo-story-a-runner:383` | **无** | — | 非生产路径；若误用会对真实 Ledger 写入 |

**并发写入竞争分析**：

- 文件锁（PRI-459，`mutateLedger`）保证单写者+原子落盘——**无丢失更新、无撕裂**。
- 但**查重决策全部发生在锁外**：`existsForCandidate`（intake 步骤 2）、`buildReuseShortlist`（步骤 4d）、LLM 评估都在获得写锁之前完成。两个并发 intake（不同候选、近义文本）都会在对方落库前完成评估→双双 CREATE（TOCTOU）。同候选并发 intake 亦然（两个条目同时通过步骤 2）。
- 41 分钟间隔的生产对说明竞争窗口在实践中是分钟级（诊断/重试周期），非毫秒级——但结构性存在。

**候选状态绕过**：intake 不检查 `candidate.status`（consumed 候选重放→`existsForCandidate` 兜住；pending 候选可被任意路径重复 intake→第二次评估可翻转）。**重试导致重复注册**：Router 修复重试不重复建候选（committer 按 recommendationRef 幂等）；`repair`/backfill 重 intake 有 `existsForCandidate` 兜底——真正的重试重复来自"park 后再驱动"（§1.2）。

## 三、精确重复防护设计（A 类——确定性）

### 3.1 现有资产复用（不新增持久化体系）

| 需求 | 现有机制 | 复用方式 |
|---|---|---|
| 事务边界 | `mutateLedger` 单写者文件锁（`principle-tree-ledger.ts:444-456`） | 查重在锁内执行——天然原子 |
| 规范化 | 无现成"纯文本规范化摘要"函数；`tokenizeForReuse`（词法）过粗、`computeTrustedPrincipleDigest`（含 id/status/version）不可用于内容比对 | 新增一个纯函数（见 3.2），不改 Schema |
| 查重比对集 | `store.tree.principles` 全集（生产 54 条，代码注释自证"order 10^2"） | 锁内即时计算各条目规范化摘要并比对——**不需要持久化摘要字段**；若未来语料到 10^4 再考虑缓存字段 |
| 查重后的处置语义 | `appendReuseEvidence`（`principle-tree-ledger.ts:627-670`，append-only、(principleId,candidateId) 幂等、fail-closed） | 命中后按"复用"语义落证据（见 3.4），零新表 |
| 调用方感知 | `LedgerAdapter.writeProbationEntry` 返回 entry；intake 结果已携带 `ledgerEntryId` | 命中时返回**既有条目**，调用方自然把候选解析到既有原则 |

### 3.2 规范化与摘要（确定性算法）

```
normalizePrincipleText(text):
  1. NFKC 归一化（与 tokenizeForReuse 同一基线，reuse-shortlist.ts:75）
  2. 全角/半角标点统一为空格（保留 CJK 词边界）
  3. 空白序列折叠为单空格、首尾 trim
  4. toLowerCase（拉丁部分；CJK 不受影响）
digest = sha256(normalized)
```

- 纯函数、无时钟无随机、可单测枚举等价类。
- 明确边界：只保证"逐字/标点/空白级差异"判等（T1 场景）；**不承诺**同义改写判等（那是 B 类职责）——生产对（raw/规范化均不同）由语义门负责，本设计不冒充能防它。
- `triggerPattern/action` 不参与摘要：LedgerPrinciple 的行为主体是 text；rule 类条目走 RuleCandidateBinding 另有 digest 机制。

### 3.3 强制点：唯一 chokepoint = `addPrincipleToLedger` 锁内前置检查

- 位置：`mutateLedger` 回调内、写入 `store.tree.principles[id]` 之前。
- 命中（存在同摘要条目且 status ∈ {candidate, probation, active}）→ **不写入**，返回既有条目 + `created:false, matchedPrincipleId`。
- 未命中 → 原样写入。
- 覆盖入口：#1-#8 全部自动受益；#10-#12 同样受益/不受影响；bootstrap 重跑从"同 ID 覆盖"升级为幂等跳过（行为改善，无破坏）。
- 豁免面：无需豁免——同文本两次注册在任何入口都没有正当性；archived/deprecated 不参与比对（与复用门的语料口径一致，`reuse-retrieval.ts:35-39`）。

### 3.4 命中处置与来源保全

- `writeProbationEntry` 收到 `created:false` → 不新建，返回既有 entry（intake 步骤 2 的幂等语义自然延伸）；intake 结果加 `deduplicatedAgainst: <existingId>`（可观察，rc-9）。
- 审计：命中时以 `appendReuseEvidence(existingId, { painId, candidateId, decision:'reuse', actor:{kind:'ai_owner', id:'exact-dedupe-guard'}, reason:'exact normalized-text match at write boundary', decidedAt })` 落账——复用现有证据机制（其 actor 枚举已含 `ai_owner`，validator 无需改动）；INV-R07 幂等键天然防重复追加。
- 候选状态：消费为既有条目（`markCandidateConsumed` 既有路径），不挂起——精确重复没有人工裁决价值。

### 3.5 并发安全

- 检查+写入同处 `mutateLedger` 锁内 → 检查-然后-插入原子化，TOCTOU 关闭。
- LLM 评估仍可并发重复跑（成本问题非正确性问题）；可选优化：intake 步骤 2 后增加"同文本候选快速路径"（锁内预检），本轮 SPEC 不强制。

## 四、语义重复处理策略（B 类）与评估失败策略（§3.1）

### 4.1 三策略对比

| 维度 | A. 维持 Fail-open（现状） | B. Fail-closed（评估失败禁建） | C. 失败即挂起（禁直接注册，转人工） |
|---|---|---|---|
| 数据安全 | 差——评估不可用窗口内近重复必然入库（2026-10-06 生产遥测 5 次 unavailable 实证） | 好 | 好（候选保留、账本不受损） |
| 可用性 | 好（Rule 4：学习永不阻塞） | 差——评估服务故障=学习停摆；评估不可用已在生产发生过 5 次/1 天 | 好——诊断/候选生成不停，只暂停"注册"这一步 |
| 对正常新原则的影响 | 无 | 评估抖动即误伤新原则 | 仅近似可疑者受影响；精确层（§三）不受影响 |
| Owner 审核负担 | 低（但坏数据混入后置成本更高——本事件族 3 条重复已入库待清理） | 零排队（直接拒绝会丢失候选上下文） | 排队增长与评估故障时长成正比；既有 `pd candidate review` 面已支持裁决 |
| 实施复杂度 | 零 | 低（改 Rule 4 分支）但**推翻 PRI-939 Owner 已决策略**，需要重新决策 | 低-中：把"评估不可用"映射到既有 park 通道（复用 `reuse_pending_owner` 形态 + 新 reason），并让 park 持久化 |

### 4.2 推荐（Owner 保留最终决策权）

**推荐 C，并以两条配套修复为前提**（否则 C 形同虚设）：

1. **park 持久化统一**：所有路径的 park（CLI diagnose/pain-retry/candidate 手动/桥接）都写入 `awaiting_owner/reuse_pending_owner` 处理状态（桥接已做，`pain-signal-bridge.ts:1452`；CLI 三处补齐）——使 park 成为**可恢复的持久状态**而非进程内记忆。
2. **park 后的 CREATE 必须留痕且需显式意志**：
   - 带 gate 的重评估路径不得自动越过 park：对已处于 `awaiting_owner/reuse_pending_owner` 的候选，自动 intake 直接幂等返回 park（不重掷 LLM——同一输入的重复评估只会制造翻转机会）；只有 Owner 通道（`pd candidate review --decide reuse|create`）能解除。
   - Owner 的 create 裁决落持久审计（复用 admission document 的 evaluation 追加或 reuseEvidence 的对称形状——具体落点在实现 SPEC 定，本轮只定要求：**谁、何时、基于什么理由解除了 park**）。
- Rule 4 的残余风险如实披露：评估长时间故障时挂起队列会增长——但精确层（§三）持续工作，且挂起候选零丢失（可随时批量裁决）；相比 A 的"静默混入重复"，C 的故障模式是**可见且可逆的**。
- 不改变业务策略的部分：`uncertain → create`（Rule 2）保持现状——那是"评估成功但语义存疑"的正常业务判定，不是故障路径。

### 4.3 本事件族在推荐方案下的重放

- 17:27 首条：评估判 create（业务判定，保持）→ 注册 ✓（第一份正当）。
- 18:08 park（0.95）→ 持久 awaiting_owner → 后续自动 intake 幂等 park → **26858b6f 不会注册**；Owner 可 `--decide reuse` 一键合并。
- 18:26 park（0.72 → 26858b6f）→ 同上 → **c2f14d1a 不会注册**（且因 26858b6f 未注册，选中目标会回到 946754bf，更干净）。
- 精确层对两条均无贡献（文本非逐字同）——如实声明。

## 五、数据迁移影响

- **无 Schema 变更**（首选设计）：规范化摘要锁内即时计算；审计走既有 `reuseEvidence`；park 持久化走既有 admission document 处理状态（`awaiting_owner` 枚举已存在，`admission-document.ts:59`）。零迁移。
- 可选后续（语料 >10^3 时再议）：LedgerPrinciple 增加持久 `contentDigest` 缓存字段——需要 ledger-codec 兼容旧文件（字段缺省=即时计算），属于独立后续 SPEC，本轮不做。
- 导出面影响：`addPrincipleToLedger` 返回类型若扩展为 `{principle, created, matchedPrincipleId}`，需同步 `export-surface-baseline.json`（`runtime/__tests__/fixtures/export-surface-baseline.json:316` 已含该函数名）与 openclaw-plugin re-export 适配器——**破坏性签名变更的替代方案**：保持返回 `LedgerPrinciple` 不变，新增伴生查询函数 `findExactDuplicatePrinciple(stateDir, text)` 供调用方在写入后核对，或通过 `writeProbationEntry` 的返回扩展传递——实现 SPEC 择一，本设计稿倾向后者（零破坏）。

## 六、回归测试方案

1. **单元（纯函数）**：normalizePrincipleText 等价类（全角/半角、空白、大小写、标点）；digest 稳定性（同输入跨进程一致）。
2. **锁内原子性**：并发 N 写者对同一/近义文本——恰一次落库（复用 PRI-1151 跨进程确定性测试模式：dist 子进程 + stdin barrier）。
3. **chokepoint 覆盖**：12 个入口逐一验证命中行为（特别是 review --decide create 与 evolution-reducer 休眠路径）。
4. **park 持久化**：CLI park 后处理状态=awaiting_owner；park 后自动 intake 幂等返回（不重评估）；Owner `--decide reuse` 解除→reuseEvidence 落账；`--decide create` 解除→审计记录存在。
5. **幂等回归**：existsForCandidate/CR-05/INV-R07 既有测试不回退；bootstrap 重跑幂等。
6. **负控制**：不同文本不误拦（T3/T5 场景重放：互补机制 0 分共存）。
7. **生产对重放**：以 26858b6f 的真实候选材料在隔离副本重放全链——期望 park 持久、零注册。

## 七、风险与回滚

- 风险 1：规范化过宽误伤（不同原则被判同文）——概率极低（判等条件是逐字级）；负控制测试覆盖。
- 风险 2：park 持久化后评估服务长故障导致队列堆积——可见、可批量裁决、精确层仍在工作（§4.2 已披露）。
- 风险 3：返回形状变更破坏既有调用方——首选零破坏方案（§五）。
- 回滚：精确层是单点纯函数+锁内前置检查——revert 单 commit 即恢复现状；park 持久化/自动重评估禁令各自独立成 commit，可独立回滚；审计追加是 append-only，回滚无需清数据。
- 灰度建议：精确层先行（确定性、零业务策略变更）；park 持久化次之；"评估不可用→挂起"（Rule 4 修订）最后且需 Owner 明确批准。
