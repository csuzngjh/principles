# PRI-1047 实现报告：RuleCode 草案来源核验统一与定点 source-correction 恢复

日期：2026-10-26。分支 `ai/PRI-1047-rulecode-source-correction`（worktree `D:\Code\_worktrees\principles\PRI-1047-rulecode-source-correction`）。设计文档：`docs/specs/SPEC-PRI-1047-RULECODE-SOURCE-VERIFICATION-v0.1.md`。

## Owner Review Card

**1. 问题（已核实）**：原候选 52d98a96（code_tool_hook，pain manual_1791868470372_8c47edyh）Scribe run4 把「Owner原文：」标签+省略号改写当 textualBasis，结构 validator 判 valid、任务标 succeeded；Artificer 前置核验判 textual_basis_unanchored 停 needs_human_review，且该停点无正式恢复路径（binding 修订已耗、retry 无反馈回喂）——真实断路。

**2. 之前行为**：Scribe 成功边界只查结构（非空字符串）；锚定判定只匹配归一化后 ≤12 字符前缀（标签误拒、前缀同后段编造可过）；Scribe 不消费 lastValidatorErrors（重试与首轮零差异）；NHR Artificer 无人能定点重开。

**3. 之后行为**：Scribe 成功前执行与 preflight 同一口径的「连续原句」锚定检查，错误引用产出字段级错误并入 lastValidatorErrors 回喂下一 attempt（跨 epoch 新鲜、成功清理、原 maxAttempts 上限）；Console 新增认证 source-correct-once 入口，单次 CAS 原子完成「授权消费 + Scribe 新 epoch 重开」；新 Scribe 成功后 orchestrator 定点 CAS 续接**原** Artificer（核验停点、保留 taskId/依赖、经 MAX(revision_epoch) 视图消费新工件），再走既有级联推进 Evaluator。

**4. 复用机制**：collectUpstreamNormalisedText（材料池+PRI-1018 血缘）、BasePeerRunner.handleValidationError/parseLastValidatorErrors/isFreshForNextAttempt（零改动）、Artificer 的 priorValidatorErrors 回喂模式、reviseRuleBindingOnce 的链解析/CAS/幂等形态、commitNextTaskProposal 单一仲裁入口、sqlite-pi-artifact-store 的 epoch 当前视图。

**5. Complexity Delta**：新持久化元数据（PITaskMetadata 可选 `sourceCorrectionCauseId`/`sourceCorrectionReceipt`）：YES（既有任务元数据 owner 最小扩展，旧版本忽略未知字段）；新公共操作 `reviseRuleSourceOnce` + Console 子路由：YES（现有认证恢复入口的最窄扩面）；新模块 textual-basis-anchor.ts：判定单一化搬迁（preflight 本地副本删除）；feature flag/子系统/后台进程/跨包依赖/外部网络能力：NO。

**6. 设计理由**：把「修正上游材料」与「重试生成器」拆开——错误引用是**生产者**缺陷，必须在生产者成功边界拦截并回喂，而不是等消费者（Artificer preflight）拒绝后再无路可回；一次定点授权恢复是修复该死锁的最小闭环。

**7. 验证**：见下节 R01–R08 与证据路径。

**8. 风险**：anchor 池仍是 scribe 意图材料 ∪ 上游材料（既有口径）；锚定是确定性字符串匹配而非语义判定（转述失败是预期行为）；lease 计数修复改变重开任务 attempt_count 语义（epoch 内计数），旧数据无迁移需要（只影响重开后的计数）。

**9. 回滚**：revert PR + 官方版本通道降级；治理数据/绑定/历史工件全部保留；新 metadata 字段为可选加法。

**10. Follow-ups**：新规则 unknown 事实 fail-open（见质量发现 §5）；PRI-1044 真实 Codex 全生命周期验收；PRI-1048 界面队列。

## 验收执行结果

### R01 — 修复前断路锁定 + 回喂闭环（GREEN）
`packages/principles-core/src/runtime-v2/__tests__/scribe-source-anchoring-feedback.test.ts`（4 测试）：
- 真实 run4 形状锁定「无锚定入参的 DefaultScribeValidator valid=true / assessIntentBasis textual_basis_unanchored」断路两半；
- 主回路：坏引用被拒不落工件（retry_wait + lastValidatorErrors 字段级错误）；第二次**真实 startRun 输入**含 `<previous_validation_errors>` + `factKind 'design_approval'` + `continuous verbatim span`（不回喂旧实现在此失败=红绿）；修正连续原句通过、工件落库、lastValidatorErrors 成功清理；
- 原 maxAttempts 上限：maxAttempts=2 两次坏输出 → failed 终态、无第三次模型调用；
- 跨 epoch 新鲜度：sourceAttemptCount=9 的陈旧记录不进入新轮。

### R02 — 锚定区分力（GREEN）
`textual-basis-anchor.test.ts`（12 测试）：连续原句/短连续片段/英文大小写空白标点差异通过；标签前缀、引号包裹、省略号（U+2026 与 ASCII …）跨接、前缀同后段编造、转述、推荐文本冒充、空/畸形/过短、空池全部拒绝。

### R03 — 真实 SQLite 恢复链 + 全负控（GREEN）
`rule-source-correction-recovery.test.ts`（13 测试）+ Console 路由 `rule-candidate-bindings.test.ts`（6 测试，含新 source-correct-once HTTP 用例）：
- 全链：binding 修订已耗（ruleBindingRevisionCauseId 保留）+ scribe revisionCount=3 → artificer NHR(textual_basis_unanchored) → 授权 → scribe 新 epoch（revisionCount=4、attemptCount=0、**maxAttempts=3 原值**、receipt 绑定 actor/requestId/digest/decisionId）→ 新工件 → `commitNextTaskProposal` 判 `source_correction_reopened`、原 taskId/依赖不变、revisionCauseId=cause、消费 MAX-epoch 新工件（无回落）→ artificer 重跑成功 → 既有级联重开 evaluator（同 taskId）→ receipt.reopenOutcome=reopened；
- 负控：同 cause 双击/崩溃重放/换 requestId → revision_already_started（无第二额度）；重绑（revision 2）→ source_correction_budget_exhausted；活租约 → 拒绝且零消费；旧摘要 → scribe_artifact_changed；绑定失配/非 owner basis → binding_revision_stale；任意 taskId 组合 → artificer_target_mismatch；非材料停点 → stop_reason_not_source_material；Scribe failed/NHR → 下游零重开；停点漂移 → conflict 可观测且重放不循环；崩溃窗（artificer 已重开、outcome 未记）→ 幂等 no-op + outcome 回填；无 receipt 的普通修订波走通用级联（findExistingSuccessor 不识别 NHR 的旧缺口由 receipt 分支前置覆盖）；历史工件/花费保留；artificer 计数唯一（无重复同 ID/新分支）；
- HTTP 入口：403 未认证零变更、400 注入字段、200 幂等。

### R04 — 隔离一致副本真实 GLM 生成（GREEN）
隔离副本 = 生产 state.db 的 SQLite backup + .state ledger + config 副本（worktree `.tmp/pri1047-iso/`，gitignored；授权 actor=pri1047-r04-isolated 实验标记）。真实 profile **zai/glm-5.3-flash，maxTokens=32000，timeout=600000ms，reasoning=low**（config 实读值）。经**生产 Codex worker cycle**（runCodexWorkspaceWorkerCycle：共享 auto-consumer + Codex 工具语义 + trustedFacts 端口 + 行为证据包）：
- 授权 revision_started（epoch 4，causeId `rule-source-correction:52d…:1`）；
- Scribe run5（12:34:59Z）真实 GLM 一次通过：新 textualBasis=「应改进：非简单行为变更先调查现状，交付SPEC和技术方案，明确调用链、输入输出、成本、失败处理、验收及回滚，经Owner确认后再编码；方向认可和操作权限不得替代设计确认。」——**材料池内连续原句**（"应改进："本身是证据 note 的一部分），identityResolution 回执完整（owner_rule_binding / ce2b7885 / revision 1 / decision 7814f382）；
- Artificer run5（12:35:44Z）真实 GLM 生成新 Rule 工件（1043 字符，sourceTrace.scribeArtifactId=run5 工件，goldenTraceCases=6 + ownerGoldenTraceCases=3，epoch3 工件，代码未手改）；
- Evaluator run3 真实 GLM：runnerDecision=**approved**；rollout_reviewer run3：**approve_rollout** + rollout_dispatch_refused（=正式待审批边界，隔离副本不冒充 Owner 新批准）；
- 失败样本：本 epoch 零模型失败（首试即过）；修复前 run4 坏引用工件（epoch 3）原样保留在库。
- 附带发现并修复既有缺陷：lease-manager 把全局 run 序号写回任务 attempt_count，重开 epoch 首败即触顶（生产 run4 的 4/3 即此形状）——已改为 epoch 内计数（runs 序号不变），含回归测试。

### R05 — 独立冻结反例（GREEN 16/16）
`.tmp/pri1047-iso/run-r05-frozen.mjs` + `r05-frozen-report.json`（冻结表在生成/修订提示之外编写）：
- not_approved → block：git commit 两变体、npm publish、heredoc 写、apply_patch 新增/异路径（**换命令/写工具/路径成立，非仅 git commit**）；
- approved / not_required → allow；
- unknown / 事实缺失 → 契约化降级：allow + matched=false + reason 明示（可观测、与 not_approved 可区分）；
- 只读（rg/git status/cat）与已批 SPEC 日常开发（npm test）不误拦；
- 全部经 **CODEX_TOOL_SEMANTICS**（Bash/apply_patch 实际映射）。

### R06 — 机制泛化（机制级证据）
恢复/锚定/回喂机制零硬编码：R03 使用 diag committer 生成的随机 candidateId（无生产 UUID/命令/中文句子依赖）；R02 含英文材料反例；`requiredFacts: []` 原则不受锚定影响（既有 vslice/全量套件绿）。不支持事实（unsupported）仍诚实返回 trusted_fact_provider_absent（既有 preflight 套件 36 绿），未当通过证据。

### R07 — 能力声明与执行时事实分离
preflight 的 describeRequiredFact 能力核验（DesignGateFact v 契约）与运行时 resolveRequiredFact 分离未动（既有测试覆盖）；绑定/Rule 审批/本 SPEC 均不充当目标任务的 design_approval（R03 负控 + preflight resolution:'unknown' 语义保留）。

### R08 — 工程门禁
principles-core 全量 exit 0（≈8.9k 测试）；host-runtime、pd-cli、pd-console（2956+1 expected fail）、codex-adapter（修复测试 spy 对 run-id 旧耦合的假设后）全量 exit 0；tsc 全部通过；error:context Pass 1/Pass 2 已跑（EP-03/EP-05 证据落入测试）；PR CI 见 PR 状态。

### R09 — 安装/生产（未完成，如实标注）
- 工程交付：本 PR（代码+SPEC+changeset+报告）。
- 实际安装：**未完成**——PR 未合并、未发版、未安装到 `~/.pd/runtime` 与 Codex 私有 runtime。状态=「工程完成、生产未验收」。
- 生产恢复：**NOT RUN**——Owner 已授权（限定原 52d 候选、一次 source-correction epoch、该 epoch Scribe ≤3 attempts、沿用既有 profile/maxTokens/timeout 与下游修订上限），但正式入口须等本修复经官方通道进入已安装 runtime 后执行；执行入口：Console `POST /api/v1/governance/rule-candidate-bindings/52d98a96-65b9-4952-82c5-51ba2d853c53/source-correct-once`（认证，字段见 SPEC §4.3）。

### R10 — Codex 原生执行（NOT RUN）
属 PRI-1044。本票不以生成成功冒充拦截效果。

## 新规则质量发现（供审批决策，非阻塞工程）

1. **unknown 事实 fail-open**：新规则对 designGate 缺失/unknown 返回 allow+matched=false（SPEC §7.2 隔离语义：规则不执行、不伪装获批、可观测）；与 2026-10-24 旧规则的 fail-closed（unknown≈not_approved 均 block）不同。实际效果：宿主运行时未解析出设计决定时该门禁不拦截。SPEC §192 要求 unknown 与 not_approved 可区分——新规则更合规，但拦截强度弱于旧规则，是 Owner 审批与 PRI-1044 live 验收需要显式裁决的点。
2. 新规则门禁面为 canonicalKind execute/write 全集（旧规则仅 git commit/push 词元）——覆盖更广（npm publish/heredoc 写均拦），只读豁免由 canonicalKind 判定。
3. 评估链在隔离副本对同一新工件给出 evaluator approved + rollout approve_rollout（dispatch 拒绝=待审批）；非 Owner 批准。

## ERR 对照
EP-03（失败不得变成功）：Scribe 不合格输出不落工件/不 succeeded；EP-05（rc-7 循环状态新鲜）：lastValidatorErrors 跨 attempt/epoch 新鲜度断言；EP-06（构建新鲜度）：R04 从重建后 dist 运行。无新增 ERR 落册项（未见可复用工程根因的新类；lease 计数缺陷属本票修复范围且已在 SPEC 记录）。

## 独立评审与修复（ adversarial review round 1）

独立评审结论 FIX-REQUIRED（2 P1 / 3 P2 / 5 P3），全部处置：
- **P1#1 barrel 快照**：runtime-v2-barrel-surface.json 补 4 个新导出并按快照排序规则重排（count 1977→1981），architecture-regression 499/499 绿。
- **P1#2 lease 语义契约测试更新**：owner-evidence-recovery T10（resume 后租约 attempt=1 而非全局序号 3，run 拼写仍 run_3）与 runtime-state-manager.integration「retry_wait preserves attemptCount」（种子 1+两次租约=3）——按新 epoch 语义显式更新并在测试内注明契约依据，非静默放绿。
- **P2#3 conflict 结果非终态**：orchestrator 分支改为 receipt 存在即独占（无论 outcome），outcome 已记录 → `source_correction_reopen_noop`+`outcome_recorded:*`，周期 reconciliation 重放不再经通用级联绕开停点核验重开被拒 Artificer；分支同时前移至 proposeNextTask 之前（兼修 P3#8）；R03 测试强化（重放后 artificer 仍 NHR、无新 artificer 被种）。
- **P2#4 null 材料静默跳过**：collectUpstreamNormalisedText 返回 null 的全部不可解析形态现发 `anchor_material_unavailable`（reason=upstream_material_unresolvable）事件（rc-9）。
- **P2#5 decisionId 写读不对称**：绑定身份缺 decisionId → `binding_decision_missing` 拒绝（零消费），不再写空串（空串会使 scribe 元数据整体不可 hydrate）。
- **P3#6 幂等排序**：same-cause 检查提前到 artificer 状态检查之前（晚到重放返回 already_started 而非误拒）。
- **P3#7 outcome 回填 CAS**：改为单次重试 + 重读当前行（rc-7），失败由 outcome_recorded 判定路径与重放幂等兜底。
- **P3#9 新鲜度碰撞窗**：继承自 pitask-metadata 评审 P1 的既有已档限制，SPEC §3.3 补注（仅提示质量影响，validator 全量重检）。
- **P3#10 leaseIsLive 重复**：评审裁定镜像可接受，保留。

## Owner 评审 R6 修复轮（2026-10-27，六项全处置）

Owner 复核（2 P1 Spec + 2 P2 Spec + 1 P1 Standards + 1 P2 Standards）六项全部核实**属实**并修复；核心 8774→8790 测试零失败。

### 六项处置明细

**#1 [P1] 新规则误拦只读调查（Spec）** — 属实，且比表面更深。三层根因+一层诊断发现：
1. **宿主动作分类未统一**：`derived.bashRisk` 仅 OpenClaw enrichment 计算（且把 `git commit` 误判 safe）；Codex 宿主无 provider 恒 unknown；golden-trace 回放硬编码 unknown——not_approved×只读组合在任何系统验证面都不可能出现。修复：新增共享分类器 `bash-risk.ts`（含 git 变更子命令补全），host-runtime 生产 gate 无 provider 时确定性默认、OpenClaw 委托、回放推导三方共用。
2. **系统验证缺该组合**：`deriveRuleCodeVerification` 反事实变体表从未包含 execute 类×not_approved×只读命令→allow。修复：新增系统反事实 `system-contract:design_approval:*:readonly:denied-readonly`（replay_rulecode 与 evaluator 自动携带）。已验证该反事实对 R04 旧规则判 FAIL（确定性执法生效）。
3. **生成约束缺失**：RULECODE_SPEC_TEXT 增补 APPROVAL-GATE READ-ONLY SEMANTICS（bashRisk safe×not_approved 必须放行；门禁面=变更动作；系统反事实自动验证；模型用例保持历史形状）。
4. **诊断发现（初版修复的死锁）**：首版曾要求模型申报 not_approved 用例（提交侧覆盖验证）——与 replay 工具的 historical-fact 契约死锁（模型自造 designGate 事实被拒 historical_fact_invalid，10轮空转 no_submit 耗尽 6 次预算；transcript 取证见 .tmp/pri1047-iso-r6diag）。已撤销并转向系统反事实通道（架构正位：事实态合成是系统职责）。

**重生成验证（R7，隔离副本 .tmp/pri1047-iso-r7，真实 GLM）**：首轮即过；7 探针全 PASS（not_approved×git status/rg/cat→allow；not_approved×git commit/apply_patch→block；unknown→中性放行；approved→allow）；自带金样 4/4；evaluator approved（"只放行只读调查…对 write 与非只读 execute 读取受信事实"）；rollout 至待审批边界。方法论自证：同一探针组打 R04 旧工件复现 3 项只读误拦。**注意：R05 节"只读不误拦"声明作废**——其夹具只走事实缺失路径，被本轮证伪。真实 Codex 宿主内拦截/放行证据仍 NOT RUN（生产恢复待 Owner）。

**#2 [P1] Scribe 成功边界漏批依赖声明审计** — 属实（复现：空 requiredFacts/required:false 均过校验、preflight 停 approval_dependency_undeclared）。修复：共享谓词 `findUndeclaredApprovalDependency`（textual-basis-anchor.ts）同时接入 DefaultScribeValidator 与 preflight（P4 单一判定）；空数组/required:false 现死于生产者边界并经 lastValidatorErrors 回喂。

**#5 [P1] 旧回执劫持后续修订轮** — 属实。修复：续接分支限定 `revisionCauseId === sourceCorrectionCauseId`（重开时同轮原子写入）；binding revision 覆写后正常后继流接管，receipt outcome 不被覆写。

**#3 [P2] 普通并发写入致永久冲突** — 属实。修复：定点续接重构为有界「读取→守卫→CAS」重试（3次），CAS 丢失重评全部守卫——瞬时竞争重试（测试：无关字段并发写后第二次 CAS 成功、outcome=reopened）、真实漂移按守卫分类、仅持续竞争记终态 cas_retry_exhausted。

**#4 [P2] 界面未接通 source-correct-once** — 属实（52d 候选 binding 预算耗尽后卡片无路可走）。修复（PR#2170 侧，含 #2169 分支合并）：core 新增只读 `previewRuleSourceCorrection`（与 reviseRuleSourceOnce 同批前置判定，点击时权威复核）；契约/校验器（ready 必带全套 CAS 输入，半空即整包拒收）；模型 bound+blocked 项派生；`correctRuleSource` API + 面板「修正源材料并继续」CTA + unavailable 可观测行 + 双语四键。pd-console 2983 测试绿。

**#6 [P2] 回执解析隐式转换** — 属实（复现：数组包装 digest/kind 经 String/regex 强转通过）。修复：严格 typeof 前置；数组毒化样例回归锁定。

### 验证汇总
- core 8774+16 回归测试零失败；host-runtime 41 绿；openclaw gate 72 绿；pd-cli tsc 过；pd-console 2983 绿。
- 旧 R04 工件探针复现（方法论）/新系统反事实抓旧规则（执法生效）/R7 真实重生成全探针 PASS（端到端）。

## Owner 评审 R8 修复轮（2026-10-27 第二轮，共同根因四项全修）

### 根因与修复（SPEC §8 修订已落档）

R7 轮的四个共同根因全部修复：
1. **黑名单未命中即 safe** → 分类器重写为正面证据契约：显式只读白名单（含参数形状核验：find 写 flag / env 命令形状 / git 全局选项+子命令 / git 写文件选项 / branch-tag-remote-stash-config 列表形状）+ 结构核验（引号感知 tokenizer、管道/组合/换行分段、输出重定向确认写、命令替换递归≤3、进程替换不支持→unknown）。未识别→unknown；确认变更→normal；rm -rf/chmod/chown→dangerous。
2. **关键词不分词元**（format/form.ts/grep touch 误触发）→ 结构化解析后仅对命令位与显式选项判定；参数/路径中的普通文本不再参与。
3. **生成端第二份白名单** → 生成规范明文禁止规则自带命令/前缀/关键词白名单；宿主分类器为唯一分类来源。R8 生成物实测零自带白名单（代码 1672 字符，纯分类消费）。
4. **独立验证仅 git status 特例** → 13 条命令族探针表（只读查询 6 / 配置仓库变更 2 / 全局选项 1 / 输出文件 1 / 管道脚本与管道变更 2 / 内联代码 1），期望硬编码；3 条代表探针交叉 approved；与既有变体表（mutating×全事实态）互补。

### 红证据与拒绝证明（沙箱内判定，未执行任何真实命令）

- **红证据**：修复前源码 + R7 原始工件（SHA 3b783f93…）复现 Owner 九条矩阵 → **7/9 偏离**（4 漏拦 + 3 误拦），逐条一致。
- **分类一致性**：独立硬编码期望矩阵 70+ 条（期望与分类器完全解耦）全绿；负面性质断言（白名单外永不 safe）；回放派生与分类器逐条一致；分类与审批事实独立性锁定。
- **拒坏规则**（真实派生通道，13 探针逐条执行）：R7 原始工件 2/13 失败（自带白名单盲区：git grep / git -C . status）→ 拒绝 ✓；全拦 execute 规则 6/13 → 拒绝 ✓；全放 execute 规则 7/13 → 拒绝 ✓。

### R8 真实重生成（新隔离副本 .tmp/pri1047-iso-r8）

- 沿既有正式链（source-correct-once → scribe 新 epoch → artificer），沿用原 profile（zai/glm-5.3-flash / 32000 / 600000ms / maxAttempts 6）。**模型尝试 1/1 首轮即过**（run_5 succeeded；对比 R6 死锁轮 6 次耗尽）。
- **新工件 SHA256 = 80230780167f23cddf4011f1eb0ee9ad64729daf102c7a1834ed7543a22c5fed**（1672 字符）。四分支：approved/not_required→allow；not_approved × read/search 或 execute+bashRisk=safe→allow；not_approved × 其余（含 unknown）→block（理由复述 Owner 原话要点）；事实缺失/unknown→中性 allow+matched=false。零自带命令白名单。
- **独立验收 ALL PASS**（生产沙箱，零失败）：9 条 Owner 矩阵全对；**18 条未进入生成反馈的独立变体**全对（含 git log --grep=commit、head、tail -f、git stash show、printf、wc -c < file、bash -c "git status"、python3 -c 删文件、curl>file、rm、mv、git checkout -b、push --force-with-lease、echo&&git add 等）；4 事实态 × 3 代表命令中性契约全对；分类一致性逐条全对。验收脚本区分力证明：同一脚本对 R7 旧工件 6 项 FAIL。

### R8 链路终态与审批记录（如实）

- evaluator（run_3，对 R8 新工件）：**needs_revision**（score 0.78）。其 strengths 五条全部认可规则四分支符合契约（含"只读豁免依赖宿主正向校验而非自建白名单"）；needs_revision 的唯一 requiredChange 是"补可执行金样覆盖四分支"——该覆盖**实际已由系统反事实通道执行**（13 探针 + 变体表全交叉 + 独立验收全过），evaluator 的 traceCoverage 口径未把 system_counterfactual 计入可执行覆盖，属判定器与 R6/R8 架构的已知错位（记录在案，不在本轮扩大修复）。修订机制按既有语义种下 artificer-repair-evaluator 任务（retry_wait attempt 1）。
- rollout_reviewer run_2（approve_rollout + rollout_dispatch_refused）输入的是**旧评估工件**（run_2=历史链），非本轮新工件。
- **52d 候选审批记录 = 0 条**：本轮新工件未走到审批环节（止于 evaluator needs_revision）。
- **报告勘误**：R7 轮报告"rollout 至待审批边界"表述错误——R7 副本实查 rollout_reviewer 一直 pending attempt 0（从未运行）、审批记录 0 条。R04 轮的"待审批边界"指当时旧链 rollout 的 dispatch_refused 停点，非 R7 新工件状态。

### 结论

工程修复完成（生成 1/1 + 独立质量验收全过 + 三类坏规则被拒 + 全量回归 8714 零失败），可进入合并审阅。安装后真实 Codex 拦/放验收（PRI-1044）仍单独 NOT RUN。
