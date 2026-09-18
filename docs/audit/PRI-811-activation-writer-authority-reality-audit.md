# PRI-811 — Activation Writer Authority Reality Audit

> 只读审计。审计对象：PD 系统中 Activation 事实是否只有一个可信写入来源（Writer Authority）。
> 本报告不修改任何代码、schema、数据库；所有发现等待 Owner 决策。

---

# Executive Summary

一句话：**Activation Writer Authority: PARTIAL**

- **行为强制通道（code_tool_hook）治理严格达标**：approval → shadow → Owner 凭据晋升，决策账本 append-only（DB 触发器禁 UPDATE/DELETE），运行时纯只读消费，未发现任何绕过路径或隐藏遗留写入者。
- **但 "activation" 作为一个事实，目前有多个**被设计认可的**写入者类别**：低风险通道（prompt/defer_archive）经 rollout reviewer 的 `approve_rollout` 会**不经 Owner approval 直接激活**（authority 标注 `system_policy`，`docs/architecture/ACTIVATION_CHANNELS.md` 明文路由表），外加 system_safety 自动隔离、break-glass 停用、migration backfill、legacy cleanup DELETE。
- 运行时实证：两个已发现的 live 工作区（`C:/Users/Administrator/.openclaw/workspace/.pd/state.db`、`D:/Code/principles/.pd/state.db`）中 `activations`、`activation_decisions`、`activation_control_states`、`global_rulecode_pauses` 四表**当前均为 0 行**。

---

# Phase 0 — Environment Snapshot

| 项 | 值 |
| --- | --- |
| commit | `a07981c97bb707d9abf81f1dece2ef62270de363` |
| branch | `main` |
| 工作区状态 | 干净（仅 2 个无关 untracked 文档：PRI-835 审计报告、PRI-815 SPEC v0.3） |
| 审计日期 | 2026-09-18 |
| 方法 | 源码追踪（INSERT/UPDATE/DELETE 全量扫描）+ DDL 阅读 + live DB 只读查询 |

---

# Phase 1 — Activation Storage Map

权威 DDL：`packages/principles-core/src/runtime-v2/store/sqlite-connection.ts:439-570`

| Location | Purpose | Authority |
| --- | --- | --- |
| `<workspace>/.pd/state.db` 表 `activations` | 激活事实主表（channel: prompt / code_tool_hook / defer_archive；action 含 shadow_activate / live_activate / prompt_activate / defer_archive） | 单库单表，无第二存储 |
| `activations.idempotency_key`（UNIQUE INDEX `idx_activations_idempotency`） | 幂等键，格式 `${artifactId}::${channel}`（activation-types.ts:268） | 唯一性约束所在 |
| `activations.activation_id` | **注意：非主键、非唯一**（`act_prompt_<principleId>` / `act_code_<ruleId>` 按主体派生） | 防重依赖幂等键 + promote 时 COUNT 守卫（state-store:194-198） |
| 表 `activation_decisions` | RuleCode 决策账本，**append-only**（`activation_decisions_no_update/no_delete` 触发器 RAISE ABORT，sqlite-connection.ts:525-530）；principal_kind CHECK 限定 `configured_owner` / `system_safety` / `break_glass` | 决策正本 |
| 表 `activation_control_states` | 执行门（`eligible` / `safety_isolated`，乐观锁 version） | enforcement 正本 |
| 表 `activation_evidence_snapshots` | 晋升证据快照，不可变（触发器禁改禁删） | 证据正本 |
| 表 `global_rulecode_pauses` | 全局紧急暂停（UNIQUE 索引保证至多一条 paused） | 暂停正本 |
| 表 `principle_applications.activation_id` | 回执账本对 activation 的引用（读模型，非激活状态） | derived |

未发现任何第二激活存储：无 JSON/文件态激活、无内存 store 生产接线（`MemoryActivationStateStore` 仅从 index 导出，grep 全仓无生产调用）、无旧表残留（`confirm_first_state` 已 DROP；runs_backup 为无关历史）。

---

# Activation Reality Map

```
Pain 信号
  ↓ internalization 管线（scribe → artificer → evaluator → rollout_reviewer）
pi_artifacts (Candidate/Artifact, validationStatus=validated)
  ↓ ActivationDispatcher.dispatch (activation-dispatcher.ts:171)
  │   ├─ rolloutDecision='approved' → 独立核验 approvals 行（:198-260，不信任调用方）
  │   ├─ 低风险 prompt/defer_archive + auto_activate → 直接激活（:265-273）
  │   ├─ code_tool_hook → 强制入 approval 队列（:265-270）
  │   └─ skill 通道高置信(≥0.95)自动晋升 → 现无 writer，实际 refused 死路
  ↓
[需 Owner] approvals.approve（CLI `pd activation approve` / Console 审批页）
  ↓ ApprovalCompletionService → dispatch('approved')
SqliteActivationStateStore.recordActivation（INSERT OR REPLACE，state-store:86）
  ↓                                    ↑
[RuleCode 通道] shadow_activate        [prompt 通道] prompt_activate（可 system_policy 自动）
  ↓ Owner 晋升门（RuleCodeOwnerDecisionService.promote：凭据+note+confirm+readiness+版本锁）
SqliteActivationSafetyStore.commitPromotion（决策账本 + action 改写 live + version+1）
  ↓
Runtime 只读消费：RuleHost 强制 / prompt 注入
```

---

# Phase 2 — Writer Inventory

全仓 `INTO activations / UPDATE activations / DELETE FROM activations` 生产语句扫描闭合（测试文件另列）。

| # | Writer | Location | Trigger | Can modify Activation? | 分类 |
| --- | --- | --- | --- | --- | --- |
| W1 | `SqliteActivationStateStore.recordActivation` | sqlite-activation-state-store.ts:86 | 仅 `ActivationDispatcher.activateArtifact`（dispatcher:385）调用 | INSERT（+幂等 REPLACE；code_tool_hook 附带建 control 行） | **A 权威**（经 dispatcher 门） |
| W2 | `ActivationDispatcher` 低风险直激活路径 | activation-dispatcher.ts:265-273 | rollout reviewer `approve_rollout`（LLM）经 `dispatchRolloutActivation`（host-runtime/internalization-consumer-governance.ts:125-133，rolloutDecision='auto_activate'）；或 CLI `pd runtime activation dispatch`（按 artifact 内记录的 review 决策重放，runtime-activation.ts:301-346） | **prompt/defer_archive 通道可不经 Owner approval 创建 activation** | **B 派生（设计认可的 system_policy 写入者）** — 见裁决 |
| W3 | `SqliteActivationStateStore.deactivateActivation` | state-store:160 | CLI `pd activation deactivate`（runtime-activation.ts:434，写 governance 审计文件）；Console `POST /activations/:id/disable`（routes/activations.ts:140-194 → model:677-697）；llm-dogfood 脚本 | UPDATE 置 deactivated_at（只朝停用方向） | A 权威（撤销方向） |
| W4 | `SqliteActivationStateStore.promoteActivation` | state-store:170 | **无生产调用者**（rule-host-writer.ts:367-370 注释明示 tests-only，PRI-818 已审计） | UPDATE shadow→live | D（死代码，勿接线） |
| W5 | `SqliteActivationSafetyStore`（决策族） | sqlite-activation-safety-store.ts:140-411 | CLI promote（RuleCodeOwnerDecisionService + commitPromotion，runtime-activation.ts:570-636）；Console owner-decision 路由（continue-observing / promote / reject-after-shadow / emergency-deactivate / recover-to-shadow / emergency-pause / release，routes/activations.ts:90-118） | 决策账本 INSERT + activations UPDATE（deactivate/supersede/promote）+ recover_to_shadow **INSERT 新 shadow 行**（:255） | **A 权威**（RuleCode 决策正本） |
| W6 | OpenClaw 插件安全熔断 `observeRuleCodeSafety` | openclaw-plugin/src/core/rulecode-safety-circuit.ts:70 | 运行时熔断跳闸（越权 scope / 受保护命令 / 健康失败） | INSERT `safety_isolate` 决策 + control_states 置 isolated（只朝隔离方向） | B 派生（system_safety，schema principal_kind 认可） |
| W7 | schema migration v002 | sqlite-connection.ts:762 | 一次性幂等 backfill（存量 code_tool_hook 激活补 control 行） | INSERT OR IGNORE control_states | B 派生（bounded migration） |
| W8 | `pd legacy cleanup --apply` | pd-cli/src/commands/legacy-cleanup.ts:219 | 操作员显式命令，dry-run 默认，--apply 才删；V1 artifact 三表事务删除 | **DELETE FROM activations** | C legacy（数据清理工具，删除方向，双向门） |
| W9 | e2e-seed 脚本 | pd-console/scripts/e2e-seed.ts:196 | 仅 `scripts/e2e-start.mjs` 在临时 workspace 调用 | INSERT | 测试（非生产路径） |
| W10 | demo-story-a / llm-dogfood / proven-channel-baseline | demo-story-a-runner.ts:151 直调 recordActivation；llm-dogfood.ts:382；proven-channel-baseline.ts:173（**no-op**） | hidden demo 命令（临时 workspace 默认 + `--allow-demo-write-to-existing-workspace` 显式才可写既有 workspace）；baseline 拒绝生产 workspace | INSERT / 停用 | 测试/Demo（bounded） |

**结论**：生产代码对 `activations` 表的写入口共 5 个语义族（W1/W3/W5/W6/W7）+ 1 个删除工具（W8）。**未发现**命名迷惑型历史入口、隐藏 flag 写入者、或任何绕过 store 的裸写（全量 grep 闭合）。

---

# Phase 3 — Consumer Inventory（运行时全部只读）

| Consumer | Purpose | Runtime Impact | 写? |
| --- | --- | --- | --- |
| OpenClaw RuleHost（openclaw-plugin/src/core/rule-host.ts:327-420） | 读 `activations ⋈ pi_artifacts ⋈ activation_control_states` + `global_rulecode_pauses`，编译规则并拦截工具调用（live/shadow） | 行为强制主消费者；重复 target_ref 全跳过；safety_isolated/非 eligible/全局暂停全部跳过 | 否 |
| OpenClaw prompt hook（hooks/prompt.ts:682-740） | 读 prompt 通道激活注入系统提示（预算 2000 字符，prompt-activation-reader-contract.ts:4） | 行为影响（提示注入）；authority 标注 `owner` / `system_policy` / unknown | 否 |
| host-runtime `buildActivePrinciplePromptContext`（active-principle-prompt.ts） | 同上，宿主中立实现 | 同上 | 否 |
| host-runtime `production-rulehost-gate.ts:198` | 读全局暂停状态做门判定 | 拦截判定 | 否 |
| codex-adapter pd-hook / workspace-worker | Codex 宿主 prompt 注入 + 遥测 | 提示注入 | 否 |
| Console ActivationsConsoleModel.getActivations（readonly 连接） | 治理面板列表/审核 | 展示 | 否 |
| activation-compatibility-read-model / governance-projection / chain-integrity-read-model / milestone-readers / compatibility-scan / installer.ts:1203 | 各读模型与体检 | 展示/诊断/遥测 | 否 |

**运行时既不生成也不升级 activation**——RuleHost 对事实的唯一"写"是回执账本 `principle_applications`（独立读模型，非激活状态）。满足"Runtime 只读"。

---

# Phase 4 — Entry Point Audit

**Console**
- 审批页 approve → dispatcher `'approved'`（独立核验 approval 行，ApprovalsConsoleModel:150-200/353-420；flag `story_a_approval_completion` 门控，关闭时明确跳过不静默）。
- owner-decision 路由：promote / reject-after-shadow / recover-to-shadow / continue-observing / release **强制 ownerActor**（server/index.ts:487-492：auth 开启 + owner identity 配置才解析出 ownerActor，否则 403）；emergency-deactivate / emergency-pause 允许回退 **break-glass**（routes/activations.ts:99-101）。
- ⚠️ `POST /activations/:id/disable`（routes/activations.ts:140-194）**路由层不要求 Owner 身份**，仅 `confirmed=true` 即停用激活。依赖 Console 自身 token 认证层兜底；而 Console 无 token 时明示"无认证运行"（server/index.ts:598）。方向仅为停用（降低风险），但属于绕过 governance 决策账本的停用路径（不写 activation_decisions）。
- Console 不能创建 activation（无 dispatch 入口；approve 链除外）。

**CLI**
- `pd activation approve`：Owner 审批→激活闭环（approval 核验在 dispatcher 内独立执行）。
- `pd runtime activation dispatch`（hidden）：按 artifact 内记录的 review 决策重放——`approve_rollout`→`auto_activate`（mapRolloutDecision，runtime-activation.ts:132-142），prompt 通道可直激活；`needs_revision` 一律 refuse；无 confirm 时 `would_activate` 干跑。
- `pd activation deactivate`：停用 + 落 governance 审计文件。
- `pd activation promote`：Owner 凭据（env > `~/.pd/owner.json`，ADR-0022）必需；无凭据解析为 break_glass 时服务层**拒绝 promote**（"break-glass 只能停不能升"，rulecode-owner-decision-service.ts:96-100）；flag `rulecode_owner_live_decision` + `rulecode_safety_controls` 双门。
- `pd legacy cleanup --apply`：唯一生产 DELETE 入口（见 W8）。
- 无 "force activate"、"bypass approval" 类 flag。

**Plugin / Runtime**
- 自动消费环（flag `internalization_auto_consumer`，feature-flag-contract.ts:73）与 `pd runtime internalization run-once` 共用 rollout reviewer → `dispatchRolloutActivation(auto_activate)`。**prompt 通道在此自动激活，无 approval 行、无 decision 行**，读侧以 `authority: 'system_policy'` 透明标注（prompt-activation-reader-contract.ts:10-16；PRI-807 审计 C-23 已记录为有意设计）。
- 运行时不自动升级状态；唯一运行时自动状态变更是安全熔断的**隔离方向**（W6）。

**Migration / Legacy**
- schema migration v002（bounded backfill）+ 旧表 `confirm_first_state` 已 DROP。无遗留激活入口、无 hidden flag 写入者。

**运行时数据实证（只读查询，2026-09-18）**
- `C:/Users/Administrator/.openclaw/workspace/.pd/state.db`：`activations`=0、`activation_decisions`=0、`activation_control_states`=0、`global_rulecode_pauses`=0、无孤儿引用。
- `D:/Code/principles/.pd/state.db`：同上全 0。
- 与记忆"激活累计 1"（09-12 RuleCode 冲刺）不冲突——当时激活在实验 workspace，当前两处 live 库均无激活事实。

---

# Phase 5 — Authority Verdict

## Current Reality Verdict: **PARTIAL**

1. **谁是唯一 Writer？** 不存在"单一函数"意义的唯一写者；存在**单一存储 + 双权威层**：激活状态由 `SqliteActivationStateStore` 独家落表（唯一生产 INSERT，仅 dispatcher 可达）；RuleCode 决策与晋升由 `SqliteActivationSafetyStore` 独家落账本并改写状态。两 store 写**同一张表**（append-only 账本 vs 可变状态行），这是已挂账的 ERR-083 双源问题，非本次新发现。
2. **是否存在第二 Writer？** 存在三个**设计认可的**非 Owner 写入者：
   - `system_policy`：prompt/defer_archive 低风险通道经 rollout reviewer（LLM）`approve_rollout` 自动激活（W2）。有架构文档背书（ACTIVATION_CHANNELS.md 路由表）+ 读侧透明标注，但 **Owner approval 不是激活的唯一入口** —— 按本审计 PASS 标准这是 PARTIAL 的直接原因。
   - `system_safety`：熔断自动隔离（W6，只朝收紧方向）。
   - break_glass：仅停用/暂停方向（schema CHECK 限定）。
3. **是否存在绕过 Owner 的路径？** code_tool_hook（行为强制通道）：**未发现**。approval 由 dispatcher 独立核验、shadow-first、晋升四重门。prompt 通道：`system_policy` 自动激活即"不经 Owner"——是文档化设计而非漏洞，但治理语义上 Owner 对"哪些原则进提示词"失去事前决定权，仅保留事后 deactivate。
4. **是否需要处理历史入口？** 不需要"处理"，但需 Owner 知情：`pd legacy cleanup --apply`（W8）是唯一 DELETE 入口，双向门+事务；e2e/demo/dogfood 均有 workspace 隔离守卫。无隐藏遗留写入者。

---

# Phase 6 — Complexity Check（发现分类）

| 发现 | 分类 | 说明 |
| --- | --- | --- |
| prompt/defer_archive 低风险通道 LLM 自动激活（W2） | **Governance Gap** | 能力是既有且已连接的；缺的是"Owner 是否接受该授权范围"的显式决策。不缺功能，不需要新系统。 |
| Console `disable` 路由无路由层 Owner 身份 | **Governance Gap** | 认证依赖 Console token 层；停用方向；是否要求 ownerActor 属 Owner 决策。 |
| state-store 与 safety-store 同表双写 | **Existing Connection/权威切分问题（ERR-083，已在案挂账）** | promoteActivation 注释自证（state-store:177-179）；等待既定裁决，本审计不裁。 |
| `activations.activation_id` 非主键非唯一 | 结构观察 | 防重靠幂等键 + promote COUNT 守卫；promote 已拒绝多行重复。记录，不建议本任务改动。 |
| skill 通道 auto-promotion（≥0.95 免审） | **False Problem（现状不可达）** | dispatcher 未接 skill writer，实际必 refused；无现实绕过。 |
| legacy cleanup / e2e / demo 写入者 | 既有 bounded 工具 | 守卫齐全，保持。 |

**Missing Capability：0 项。不因发现而设计新系统。**

---

# Recommendation（仅保持/关闭/后续处理）

- **保持**：code_tool_hook 全链（approval→shadow→Owner 晋升）、安全熔断、schema v002 backfill、legacy cleanup 双向门、测试/Demo workspace 隔离、`SqliteActivationStateStore.promoteActivation` 保持无生产调用（勿接线）。
- **后续单独处理（待 Owner 决策，本审计不实施）**：
  1. prompt 通道 `system_policy` 自动激活是否收紧为"入 approval 队列"或加 flag —— 治理决策，影响产品每日自治行为面。
  2. Console `disable` 是否要求 ownerActor（或至少落 decision 账本）。
  3. ERR-083 双源裁决（已在案，非本审计新立）。
- **关闭**：无（本审计未发现可立即关闭的误报问题）。

---

# Evidence Index（主要证据，禁止命名推断原则下全部可复查）

- DDL/触发器：`packages/principles-core/src/runtime-v2/store/sqlite-connection.ts:439-570`
- 唯一生产 INSERT + FK fail-loud：`sqlite-activation-state-store.ts:73-106`
- dispatcher approval 独立核验：`activation-dispatcher.ts:198-260`；低风险直激活：`:265-273`
- 自动激活生产接线：`packages/host-runtime/src/internalization-consumer-governance.ts:125-133`；rollout reviewer 调用：`internalization/rollout-reviewer-runner.ts:895-910`（`channel: ctx.channel ?? 'prompt'`）；消费环 flag：`feature-flag-contract.ts:73`
- 决策映射：`packages/pd-cli/src/commands/runtime-activation.ts:132-142`
- 晋升四重门：`rulecode-owner-decision-service.ts:89-174`
- 熔断 system_safety 写：`packages/openclaw-plugin/src/core/rulecode-safety-circuit.ts:60-81`
- Console 路由与 actor：`packages/pd-console/src/server/routes/activations.ts:90-118,140-194`；ownerActor 解析：`server/index.ts:487-492`
- 唯一 DELETE：`packages/pd-cli/src/commands/legacy-cleanup.ts:219`
- 设计文档：`docs/architecture/ACTIVATION_CHANNELS.md:104-110`；先前审计记录：`docs/audit/pri-807-phase0/LINEAGE_CHAIN.md:112`（C-23）
- 只读消费证据：`openclaw-plugin/src/core/rule-host.ts:327-420`；`prompt-activation-reader-contract.ts:10-16`
- live DB 实证：两工作区四表 0 行（2026-09-18 只读查询）

---

# Owner Review Card

**1. Problem** — Activation（"哪条原则/规则正在管着 AI 行为"这件事）是不是只有一个可信的记账人？谁有没有绕过你的审批偷偷开关？

**2. Current Reality** — 拦截代码行为的规则通道管得很严：必须你批准 → 先影子观察 → 你凭身份+凭据+确认才能转正式，账本只增不改不删。但"提示词通道"（把原则写进 AI 的系统提示）目前允许管线里的评审 LLM 自动激活，不经你批准——这是架构文档里写明的设计（低风险自动、高风险找你审批），不是黑客后门；运行时的 AI 只读这些记录，自己不会造假。

**3. Writer Inventory** — 正式写入口 6 类：激活登记（只此一家的 INSERT）、停用、规则决策账本（含晋升/恢复/紧急停）、安全熔断自动隔离、一次性数据迁移补写、legacy 清理删除命令。测试/演示另有带围栏的写入，不碰生产。

**4. Consumer Inventory** — 运行时（OpenClaw 钩子、Codex 适配器、Console 面板、各种体检读模型）全部只读，零运行时自产激活。

**5. Authority Verdict** — **PARTIAL**。主威胁模型（规则拦截行为）达标；"激活"整体上有多个设计认可的写入身份（你、系统策略、系统安全、紧急破窗），其中 system_policy 自动激活意味着**你的批准不是激活的唯一入口**。

**6. Risks** — (a) 未经你批准的原则可能天天进提示词（目前两库实证 0 行，尚未实际发生）；(b) Console 无 token 模式下本机可停用激活（只能关不能开）；(c) 同一张激活表有两条写入权威（已挂账 ERR-083）。

**7. Recommended Next Action** — 三件事请你拍板（都不急，目前无现实损害）：① 提示词通道自动激活要不要收紧成"必须你批"或加开关；② Console 停用按钮要不要要求你的身份；③ ERR-083 双源问题按既定挂账推进。

**8. What NOT to Build** — 不要新建"激活权限中心"、不要加新状态机、不要给熔断/迁移/清理工具套新框架、不要动 `promoteActivation` 死代码、不要因 skill 通道的纸面自动晋升写任何代码（现状不可达）。

---

*审计结束。未修改代码、未创建 PR/Issue、未改动任何数据库。等待 Owner Review。*
