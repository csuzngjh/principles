# PRI-910 — Principle Identity Reconciliation Phase 1（只读对账审计）

> **状态**：Read-only audit，等待 Owner Review。**未修改任何生产数据 / schema / migration / activation / application / 代码。**
> **上游**：#1851（类型写入边界，已并）→ #1856（激活身份 fail-closed I3 + I2 lineage 解析，已并 42f0f4a7）→ #1860（Governance SPEC v0.4 身份契约冻结，已并 f65af4a5）。
> **本文取代** `docs/architecture/principle-identity-reconciliation.md`（Phase 3 设计稿）中的**数据现状**部分：该稿写于 #1856 合并前，其 live 计数（11）与"source_principle_id 从未被写"（0/921）已过期；其设计结论（Option A′）已被 #1856 实现采纳。规范裁决以 SPEC v0.4 §4A 为准，本文只做**存量对账**。

---

## 0. Executive Summary

**回答核心问题：历史 legacy identity 能否安全恢复为 canonical Principle UUID？—— 能，且全部关键存量已逐条验证可恢复。**

1. **身份可恢复性 = 100%（对全部有行为后果的数据）。** 22 条 activation 行（13 live）、19 个 application 身份（1262 行中的 1260 行）全部沿既有 lineage（artifact `sourceTrace` → dreamer task seed `candidateId` → 账本 `derivedFromPainIds`）解析到**恰好一个**账本 UUID；歧义（>1）为 **0**，与 SPEC §4A.5"恰好一条"判据完全一致。仅 2 条孤立 application 行（各 1 行，self_reported）无法恢复，归 C 类。
2. **不需要新 schema。** 解析算法就是生产代码 `resolveLedgerActivationId`（`activation/ledger-identity.ts`，#1856 落地）的存量重放；本审计用它逐条跑出全表（§4），零猜测、零文本相似度推断。
3. **真正的阻塞不在"能不能映射"，而在"映射到什么状态"。** 三个存量治理事实必须先由 Owner 裁决（§8）：
   - **8/13 live activation 指向的账本条目已于 2026-09-23 被置为 `archived`**（归档发生在激活之后）——治理面与行为面脱钩；
   - **5/13 live activation 指向的账本条目停留在 `candidate`**（从未 approve-active）；
   - **账本 122 条中 73 条（60%）的出生候选 kind ∈ {rule, prompt, implementation}**，按 #1851 类型边界今天不再具备入账资格；其中 **3 个 live + 2 个 archived 身份映射到 prompt 型条目**。
4. **前向止血已在代码里，但生产数据尚未吃到。** 本副本中 #1856 合并（2026-09-23T15:50Z）之后**没有任何新 activation / application 写入**（安装态运行时仍是旧版）；且 `pi_artifacts.source_principle_id` 的**文本污染仍在继续**（最近一条 2026-09-22，T-NN 断言型共 17 条 + 标题型 5 条）——evaluator 透传链的宽松盖章是 §4A.6 已记录边界，收口属 PRI-911/后续票，不在本 Phase 范围。

**结论：Phase 1 mapping table（§4）可作为迁移输入提交 Owner 批准；A 类 15 条恒等式证据充分，B 类 8 条逐项列明待裁决原因，C 类 3 条显式 unresolved 禁止猜测。**

---

## 1. 证据基线与可复现性

| 项 | 值 |
|---|---|
| 代码基线 | `origin/main @ f65af4a5`（含 #1851/#1856/#1860；**本地 main 曾落后，结论均以 origin/main 为准**） |
| 数据副本 | `D:/.openclaw/workspace/.pd/state.db`(+wal/shm) 字节副本 → `D:/pd-probe-pri910/state.db`，2026-09-24T01:11:01Z，`PRAGMA integrity_check = ok`，sha256[0:16]=`acbd45f6b211d2fc` |
| 账本副本 | `D:/.openclaw/workspace/.state/principle_training_state.json`，sha256[0:16]=`dfe70338c6f005a3` |
| 探针 | `D:/pd-probe-pri910/pri910.cjs`（better-sqlite3 `readonly:true`，复刻 `resolveLedgerActivationId` 判定序：direct-UUID+账本成员 → candidate_lineage 恰好一条 → unresolved）；输出 `report.json` |
| 生产库 | **从未打开写连接**；副本读取不触碰原文件 |

> 副本时生产进程可能在写（存在 wal/shm）。integrity ok + 只读连接；所有结论与 09-23 前的既有审计交叉一致，无因拷贝产生的矛盾行。

---

## 2. Identity Graph（现状，实测）

```
PainSignal
 └─ principle_candidates (138, candidate_id=UUID, recommendation_kind)
     │  intake 闸门（#1851）：仅 kind='principle' 允许写账本 —— 但 73/122 存量账本条目系边界前入账
     ▼
 Ledger  _tree.principles (122, 全部 UUID 键；status: candidate 111 / archived 11)
     │   每条 derivedFromPainIds 恰好 1 个 candidateId（multi=0, orphan=0）
     │   ← 铸造点；SPEC §4A I1 的唯一合法身份来源
     ▼
 pi_artifacts (921)   source_principle_id: NULL 894 | 账本验证 UUID 5 | 文本 22（T-NN 断言 17 + 标题 5）
     │   content_json.sourceTrace{dreamerArtifactId, philosopherArtifactId} = 内建 lineage
     │   dreamer task seed diagnostic_json.candidateId = 权威 candidate 回链
     ▼
 activations (22 行 / 13 live)   target_ref = ledger://<title> ×21 · ledger://<UUID> ×1 · impl://rule-… ×2行(同一身份)
     │   ‖ 身份铸造缺陷点 extractPrincipleId() title 兜底 —— 已由 #1856 在激活边界删除（I3 fail-closed）
     ▼
 principle_applications (1262 行 / 19 distinct principle_id；1168 行带 activation_id)
         注入/回执面仍以 activation 身份（多为 title）为键 —— SPEC §4A.6 "evidence 层身份未收口" 的实据
```

**规模速览**

| 面 | 存量 | 身份形态 |
|---|---|---|
| Ledger | 122 | UUID 122/122（无文本键） |
| Candidate | 138 | UUID；kind: principle 49 / rule 40 / prompt 17 / implementation 16（**按派生账本条目的出生证明统计**） |
| pi_artifacts | 921 | 5 条账本验证 UUID 盖章（均系 09-15/16 手工/脚本所盖，非链上自动）；22 条文本污染 |
| activations | 22（13 live） | text 21 · UUID 1 · impl:// 2 行 |
| applications | 1262 行 · 19 身份 | text 18 · UUID 1 |

---

## 3. Legacy Identity Classification

判据（= SPEC §4A.5）：**只允许** 结构化 lineage（artifact→sourceTrace→dreamer seed candidateId→账本 derivedFromPainIds，或 artifact 直带账本验证 UUID），且**恰好一条**。**禁止** title/text 相似度推断（本文所有"文本匹配"仅用于**检索候选 artifact**，最终裁决一律走 lineage 边；该类条目自动降为 B）。

| 类 | 判据 | 数量 |
|---|---|---|
| **A — 确定性映射** | lineage 恰好一条 + 出生候选 kind='principle' | **15 条恒等式**（14 条 candidate_lineage + 1 条已通过 artifact 检索再 lineage 复验，见注） |
| **B — 可映射但需 Owner 决策** | 映射本身唯一，但目标条目资格/状态存疑，或证据路径含检索性文本环节 | **8 条**（B1 prompt 污染 5 · B2 弱证据路径 2 · B3 rule 面命名空间 1） |
| **C — 不可恢复** | 无任何 artifact/activation/lineage 边可达 | **3 条**（合计仅 3 行 application，均 self_reported，无行为后果） |

### A 类（15）

§4 表中 `class=A` 的 15 行：全部 live 非 prompt 身份（10）+ 已归档但出生干净的 activation 身份（4：意图锚定/基准锚定/等待轮询/先证据后干预）+ 985c092e 的既有 UUID 自等式。

### B 类（8）

| # | legacy identity | 唯一映射目标 | 需要 Owner 决策的原因 |
|---|---|---|---|
| B1a | `Model-Evidence-Reversibility-Verification Loop`（678 app 行） | `0cf0e94a-…` | 出生候选 kind=**prompt**；activation 已停用但回执历史最厚 |
| B1b | `Owner 约定持久化并在阶段开工与生成类行动前强制召回比对`（**live**，59 行） | `56010589-…` | kind=**prompt**，#1851 边界下今天不能入账 |
| B1c | `有后果的变更前，以全局引用证据探明关联面…`（**live**，51 行） | `6d2f3fe6-…` | kind=**prompt**；且账本已 archived（09-23）而激活仍 live |
| B1d | `结论必须由可观察证据背书：无查验则显式降级为推断`（16 行） | `643884a7-…` | kind=**prompt** |
| B1e | `以接收者可理解为完成标准的沟通原则`（**live**） | `0521e029-…` | kind=**prompt**；账本已 archived 而激活 live |
| B2a | `基线锚定与不可劣化护栏：迭代改动必须相对已验收基线验证`（12 行） | `985c092e-…` | 经"标题检索 artifact→lineage"弱路径（2 个 artifact 同目标）；账本文本与身份文本措辞不同 |
| B2b | `基线锚定与不可劣化护栏：迭代须以可对比证据验收`（= artifact 文本盖章形态） | `985c092e-…`（同目标另一拼写） | 文本盖章 artifact 被 I3 拒绝（`text_stamp`）；与 B2a 是同一原则的第二拼写——归并须 Owner 确认 |
| B3 | `impl://rule-rulehost-pain_host_cffdcb9f…-evaluator-r1-*`（2 行 activation，同一 target_ref） | 一行 `direct_validated`→`2d23707d-…`，一行 unresolved | rule 面句柄混入 ledger:// 之外的命名空间；同一身份两行结果不同（artifact 一个手工盖了 UUID、一个仍存标题）。需裁决：rule 身份与 principle 身份分表 |

### C 类（3）

| legacy identity | 行数 | 取证 |
|---|---|---|
| `T-06 最简单干预` | 1（self_reported, 09-09） | 无同名 activation、无 artifact 标题匹配、`abstracted_principle` 无候选命中；系训练时代 T-NN 公理命名空间残留（账本 `ruleIds` 全空，T-NN **不是**账本 id） |
| `先以可观察证据验证系统状态`（截断形） | 1（self_reported, 09-19） | 同上；与 A 类 `先以可观察证据验证系统状态，再给出干预建议`（`18ba6e6d`）**文本近似**——按禁令不得据此并档，仅记为疑似同源供 Owner 裁决 |
| `impl://rule-…-mu2yt8y7` 行的标题盖章形态 | 0（activation 已死） | artifact `source_principle_id` 为标题文本 → I3 拒绝；行为后果为零 |

**C 类合计影响 = 3 行回执、0 个 live 行为。可安全记为永久 `unresolved`，不阻塞任何迁移。**

---

## 4. Evidence Mapping（Phase 1 mapping table 草案 v1）

每条：legacy identity → candidate（出生证明，含 kind）→ canonical 账本 UUID → 证据路径。lineage 边全部由探针在副本上实跑（`report.json` 含完整 artifact_id/task_id），下表为权威摘要。

| legacy identity | candidate_id（kind） | → canonical Principle UUID | 证据路径 | 类 | 账本 status | live? |
|---|---|---|---|---|---|---|
| 意图缺口即风险信号：方向性产出前先澄清并以小样验证 | 584f27d7 (principle) | `a2ac2b93-10a5-49bc-ac17-1e76ce348761` | artifact→sourceTrace→dreamer seed→账本 | A | candidate | ✅ |
| 交付前以受众视角自检可理解性并设置强制评审关卡 | 171f586a (principle) | `9269d7b3-781e-4610-887a-97cec37b0339` | 同上 | A | candidate | ✅ |
| 约定召回门：Owner 约定首次表达即持久化…强制召回校验 | 4c5140d6 (principle) | `df6155a1-32ab-4e5b-ab03-38481b798ae6` | 同上 | A | candidate | ✅ |
| 指令模糊时先确认意图边界，采用最保守的最小删减变更 | 6b88216c (principle) | `d03f6c64-f921-43e6-8fd6-a97899eaa29b` | 同上 | A | candidate | ✅ |
| 以可校验的持久化状态为决策依据，保持工作空间可信与整洁 | b9cc7bf5 (principle) | `6522447f-a051-4bb7-82f0-1bb1e26b8670` | 同上 | A | **archived** | ✅ |
| 交付前以可观察证据自检：将验收基准显式化并固化为流程门禁 | 9c902446 (principle) | `cf422443-9864-458d-bec6-c32ace20867f` | 同上 | A | **archived** | ✅ |
| 生成式任务须实施全时程约束锁定与分段校验门禁 | 22e820d7 (principle) | `bb0a4303-f7a3-4038-bc14-ad513d2f2356` | 同上 | A | **archived** | ✅ |
| 交付前强制重跑完整管线，以可版本追踪的证据核验宣称 | 9d5e2a25 (principle) | `7b5bb4e2-3294-4631-b0c5-8206fd6ec702` | 同上 | A | **archived** | ✅ |
| 以核验过的最新资产状态为产出依据，而非记忆 | 57d43479 (principle) | `52a5a168-e017-4820-bf0c-e6e8399b6c15` | 同上 | A | **archived** | ✅ |
| 覆盖性操作前先核实版本并保持可逆 | a6eac720 (principle) | `99b60115-0036-477a-b869-5200908d2cff` | 同上 | A | **archived** | ✅ |
| 意图锚定：主任务未验证完成或未显式放下前，不得自行推进次要议题 | 90882b98 (principle) | `87b83680-3bcb-41de-bd1a-4f08972bfa43` | 同上 | A | candidate | — |
| 基准锚定：已验收产出物必须在持久化基准约束下做最小改动并回归验证 | e6ac6dbd (principle) | `ada4bf68-f03a-481b-9168-b2d6d1db11f3` | 同上 | A | candidate | — |
| 等待与轮询循环必须绑定可观察状态转移条件…立即主动终止 | c4957de5 (principle) | `9c977511-83b7-40ed-9824-b76e673aa917` | 同上 | A | candidate | — |
| 先以可观察证据验证系统状态，再给出干预建议 | 3bf1ebf9 (principle) | `18ba6e6d-61aa-4adc-ab2e-efd95c384fc1` | 同上 | A | candidate | — |
| （已是 canonical）`985c092e-…d24` | （rule 型出生证明） | `985c092e-432a-45e8-ade5-42cc1de96d24` | direct_validated（自等） | A | archived | — |
| Owner 约定持久化并在阶段开工与生成类行动前强制召回比对 | 2dce0671 (**prompt**) | `56010589-e6ef-4d68-a3ef-056bc8ed675a` | lineage 唯一 | **B** | candidate | ✅ |
| 有后果的变更前，以全局引用证据探明关联面… | e57b62ca (**prompt**) | `6d2f3fe6-b465-4a77-ad6b-af10aac5fc7d` | lineage 唯一 | **B** | archived | ✅ |
| 以接收者可理解为完成标准的沟通原则 | fed0787f (**prompt**) | `0521e029-f638-4496-b3a1-eab015630fc9` | lineage 唯一 | **B** | archived | ✅ |
| Model-Evidence-Reversibility-Verification Loop | aabe9790 (**prompt**) | `0cf0e94a-90b9-4f3d-b728-13d804315fee` | lineage 唯一 | **B** | candidate | — |
| 结论必须由可观察证据背书：无查验则显式降级为推断 | 95427453 (**prompt**) | `643884a7-6e9e-427a-a8f7-37bb35221093` | lineage 唯一 | **B** | archived | — |
| 基线锚定与不可劣化护栏：迭代改动必须相对已验收基线验证 | （经 2 artifact 汇聚） | `985c092e-…d24` | 标题检索→lineage 复验（弱路径） | **B** | archived | — |
| 基线锚定与不可劣化护栏：迭代须以可对比证据验收（文本盖章变体） | 同上第二拼写 | `985c092e-…d24`（同一目标） | artifact 文本盖章 + 拼写归并 | **B** | archived | — |
| impl://rule-rulehost-pain_host_cffdcb9f… | — | `2d23707d-11a3-4484-a35d-124e19904eac`（仅盖章行） | rule 句柄混入；两行裁决不一致 | **B** | archived | — |
| T-06 最简单干预 | 无 | — | 无边可达 | **C** | — | — |
| 先以可观察证据验证系统状态（截断） | 无 | （疑似 18ba6e6d，禁并） | 无边可达 | **C** | — | — |

**映射唯一性**：activation 21 个 distinct legacy 身份（22 行中 2 行共享 impl 句柄）+ application 19 个身份，全部汇聚到 **21 个 distinct canonical UUID**（application 侧目标是 activation 侧的严格子集），无一 UUID 被两个语义不同的 legacy 身份争抢——985c092e 的 3 个键形（UUID / 两个标题拼写）是同一原则的多拼写，见 B2a/B2b。

---

## 5. Live Activation Assessment

**13 条 live activation：身份恢复全部成功（13/13 resolved，0 ambiguous，0 unresolved）→ 身份维度 `safe`；治理状态维度 `review_required`。**

| 维度 | 实测 | 判定 |
|---|---|---|
| 数量 / 身份形态 | 13 条，**全部 text 键**（0 UUID）；#1856 后本库无新激活（安装运行时未升级） | 恢复可行 |
| 可恢复性 | 13/13 lineage 恰好一条（3 跳：artifact→dreamer seed→账本），跳数确定性 scribe←philosopher←dreamer←intake | `safe` |
| 治理一致性 | **8/13 目标账本条目 status=archived，且归档日（09-23）晚于激活日**；5/13 status=candidate（从未 approve） | `review_required` |
| 类型污染 | 3/13 映射到 prompt 型出生证明条目 | `review_required` |
| 残留风险 | 注入面读 activations 不读账本 ⇒ 归档不撤行为；回执仍以 title 为键 | 见 §8 OD3/OD4 |

分类输出：**`review_required`（全部 13 条）** —— 无一需要放弃（identity 层面），但其中 0 条可以不加裁决地直接迁入 canonical 世界：3 条卡在 B1（prompt 污染），8 条卡在 B/OD3（archived-vs-live），5 条卡在 OD4（candidate-never-approved）。**没有任何一条 live activation 属于 C。**

## 6. Application Attribution Assessment

| 问题 | 答案 |
|---|---|
| 可恢复归因（application→activation→UUID 或直接身份解析） | **17/19 身份 = 1260/1262 行** 可达 canonical UUID（16 条经 activation lineage，1 条本就 UUID） |
| 不可恢复 | `T-06 最简单干预`（1 行）、截断变体（1 行）→ 永久 `unresolved`，保留原文不并档 |
| 行级 activation 绑定缺口 | **94 行 `activation_id IS NULL`**（93 self_reported + 1 rule_blocked，09-03～09-23 持续发生）：原则级身份可恢复，**事件级**无法归因到具体 activation——效果度量（effect/presence 两级语义）在 self_reported 通道上有结构性缺口，须在 Phase 3 写侧修复（回执写入时带 activation 句柄），存量行不可补造 |
| 双身份世界并存时间窗 | title 键与 UUID 键在 application 表重合度 18/19 —— **对账后旧键必须作为 `legacyIdentity` 别名保留**（回执行不重写原则文本键的历史证据价值 > 表整洁） |

---

## 7. Migration Proposal（仅设计，Phase 0–4）

> 每阶段独立可回退；全部存量修复是**读侧推导**（本审计已逐条跑通），唯一新增持久物是映射表本身。

**Phase 0 — Snapshot（本报告 + 探针固化）**
把 `pri910.cjs` 收编为版本化工具（建议 `scripts/audit/identity-reconcile.mjs`，只读 + `--json`）；每次运行产出带 sha256 输入指纹的报告。回退：无（只读）。

**Phase 1 — Mapping table（本文 §4 = draft v1）**
A 类 15 条经 Owner 批准后成为权威映射工件（建议入库为 `docs/audit/assets/identity-mapping-v1.json` 或随迁移包提交）；B 类挂起待 §8 裁决；C 类显式 `unresolved`。此阶段**零数据写入**。回退：删除工件。

**Phase 2 — Owner review（§8 清单逐项裁决）**
关键门禁（继承 OD4 阈值建议）：live activation 的 unresolved 必须为 0 —— 本审计实测已满足（13/13）。

**Phase 3 — Migration apply（唯一动数据的阶段，另行授权）**
1. `pi_artifacts.source_principle_id`：仅对**映射表中 live/archived activation 的 artifact**（≤22 个）补盖 canonical UUID；22 条文本盖章**不改写**（改令 I3 判定路径变化），以映射表旁证之。
2. `activations.target_ref` / `activation_id`：live 13 条切至 `ledger://<UUID>`；旧文本键行保留为 `legacyIdentity` 别名（新列或旁表，**不 UPDATE 抹除历史**）。
3. `principle_applications.principle_id`：**不重写存量**；新增解析视图/读侧双键（canonical 优先，legacy 兜底），94 行无 activation_id 的效果行如实标注不可事件归因。
4. 写侧同步：运行时升级后由 #1856 I3 天然拦截新 title 铸身份；evaluator 透传链的文本盖章收口另票（见 §8 OD7）。
回退：备份快照恢复 + 别名列幂等删除；每一步先影子读校验。

**Phase 4 — Legacy compatibility removal**
当 (a) 双读一致率 100% 持续一个发版周期、(b) 无新 title 键写入、(c) Owner 签署后：删除读侧 COALESCE 兼容查询（SPEC §4A.6 末条）、把 `extractPrincipleId()` 的宽松链限定为 display 专用。不可逆度最高，故最后。

---

## 8. Owner Decision List

| # | 决策 | 影响 | 审计建议 |
|---|---|---|---|
| **OD1** | 批准 §4 A 类 15 条为权威映射 | Phase 1 放行 | 批准 |
| **OD2** | B1 五条 prompt 污染（含 3 条 live）的去向：重铸（重新走 principle intake）/ 降级到 Prompt 治理面 / 仅打标保留 | live 行为连续性 | 建议先"仅打标"，不与身份迁移捆绑决策 |
| **OD3** | 8 条 archived 账本 vs 仍 live 的 activation（归档发生在激活后）：deactivate 还是误归档回退？ | 当前实际注入行为 | **本审计发现的最高优先级治理事实**，须逐条裁决 |
| **OD4** | 5 条 live activation 指向 status=candidate（从未 approve-active）：low-risk 自动激活路径与 INV-04 授权语义是否冲突 | 授权模型 | 明确"candidate 可否被激活"的合法语义 |
| **OD5** | C 类 3 行处置（保留原文 / 别名指向疑似同源） | 审计完整性 | 保留为 unresolved，禁止并档 |
| **OD6** | `impl://rule-…` 句柄混入 activation 身份空间（B3）：rule 面身份是否单列命名空间 | 行为面整洁 | 与 Selector 设计（PRI-911）合并裁决 |
| **OD7** | 22 条文本盖章 artifact（T-NN 断言型最近仍产生，09-22）：evaluator 透传链收口是否先于 Phase 3 独立成票 | I2 可观察性 | 建议独立票（#1851/#1856 同构边界修复，可单独验收） |
| **OD8** | 账本 73/122 非 principle 型存量条目的处置 | Principle reuse/复利的前置清洁度 | 超出 Phase 1，建议单开对账 Phase 1.5 |
| **OD9** | 94 行无 activation_id 的 effect 回执：写侧修复列入 Phase 3 范围？ | 效果度量可信度 | 列入 |

---

## 9. 纪律声明

```text
SCHEMA_MODIFIED          = NO
MIGRATION_APPLIED        = NO
ACTIVATION_MODIFIED      = NO   (只读查询)
APPLICATION_MODIFIED     = NO
CODE_MODIFIED            = NO   (探针在仓库外 D:/pd-probe-pri910/)
NEW_RESOLVER_CREATED     = NO   (复刻生产 resolver 判定序, 未入生产码)
CLEANUP_EXECUTED         = NO
PRODUCTION_DB_TOUCHED    = READ-COPY ONLY (字节副本, integrity ok, readonly:true)
FILES_WRITTEN            = docs/audit/principle-identity-reconciliation-phase1.md (未跟踪)
```

**Stop condition 已满足：审计完成，等待 Owner Review。不实现迁移、不开 PR 改数据。**
