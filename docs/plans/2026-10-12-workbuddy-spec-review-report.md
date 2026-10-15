# WorkBuddy 宿主适配器 SPEC — 独立评审与证据核查报告

> **日期**：2026-10-12
> **评审对象**：`docs/specs/workbuddy-host-adapter-spec.md`（DRAFT v0.1.0）及配套材料（四份调研文档 + 两份官方文档快照）
> **评审方式**：两个相互独立的只读 AI 评审 agent（非 SPEC 作者），分别承担「架构评审」与「证据核查」；全部论断经实际阅读代码 / 比对官方快照 / 复验本机引擎得出
> **关联工单**：[PRI-952](https://linear.app/principlesdisciple/issue/PRI-952)（实现工单，Phase A 即本报告的修订闭环）

---

## 总体结论（合并）

| 维度 | 结论 |
|---|---|
| 架构方向 | **有条件批准**——command hook + 子进程适配器 + 三事件 MVP 选型正确；7 项 Major 须修订 |
| 证据可信度 | **高**——官方引用 / file:line / Codex 行为对比几乎全部有据；无 Blocker；3 项 Major 为时效性问题（本机已升级 5.8.1） |
| 能否进 Phase 0 | **暂缓**——先完成 SPEC v0.2 修订（10 项 Major，清单见 §3） |

两份评审的发现互为补充：架构评审找「设计缺口」，证据核查找「事实失真」，无相互矛盾之处。另证据核查员在本机现行引擎（5.8.1）上做了补充复验，推翻了 SPEC 中一条「桌面版未实现」的现时表述（详见 §2-M1）。

---

## 1. 架构评审报告（独立 agent，只读）

### 总体结论

**有条件批准**——架构方向（走 ADR-0020 薄适配器、`command` hook + 子进程、三事件 MVP）判断正确、证据基础扎实，但存在 7 项 Major（改动面清单遗漏 MVP 关键路径、ADR-0027 证据契约缺失、Phase 0 探针不完备、OD-01 失败语义文档缺口、MVP 范围划错一处、encoder 白名单安全语义坑、启动机制范本引用不存在），须完成修订后方可进入 Phase 0 探针与 codec 冻结。

### 发现列表

#### [Major] M1. §5「4 处 hostKind 类型联合」清单严重不完整，遗漏位置位于 MVP 关键路径

- **证据**：SPEC §5 改动面 5（spec:209）仅列 4 处。实测 `'openclaw' | 'codex'` 联合散布于至少 12 处，其中 SPEC 未列且位于 MVP 三事件路径上的有：
  - `packages/principles-core/src/runtime-v2/intervention-evidence-normalizer.ts:74`（`HOST_KINDS = new Set(['openclaw','codex'])`，:234/:562 经 `enums.require` 强校验）——WorkBuddy 的干预/deny 证据会被归一化器拒绝；
  - `packages/principles-core/src/trajectory-types.ts:82-83`（`TrajectoryPainEventInput.hostKind?: 'openclaw' | 'codex'`）——G1 承诺的 PostToolUse 痛点证据若无此扩展则 pain_events 无宿主归因（persist NULL=unknown）；
  - `packages/pd-console/src/server/routes/activations.ts:93-101`——`GET /api/v1/activations` 的 `host` 参数非 openclaw/codex 直接 400（:96-98）；
  - `packages/pd-console/src/server/routes/approvals.ts:147`、`packages/pd-console/src/server/routes/evidence-outcomes.ts:81`、`packages/pd-console/src/ui/api.ts:539,784,1123,1128,1167`、`validators.ts:1294,2213`、`FocusPage.tsx:415,1221`。
- **问题**：SPEC §2 审计结论「新增代码只有一个包 + 一个 installer + 若干类型联合与 flag 条目」（spec:77）低估了联合扩展面。更严重的是 §1.4 mvp-q-2 承诺「pd-console activations 可查」（spec:57）——不扩展 activations route 该观测路径不成立，即可观测性承诺依赖一个未列入改动面的代码修改。
- **建议**：改动面 5 改为「hostKind 联合全链审查」任务项，分两层：MVP 必改（trajectory-types、intervention-evidence-normalizer、activations/approvals routes、prompt-injection 三处）与可延后（pd-console UI 侧）；§2 审计结论同步改为「类型联合扩展点需全链枚举，当前枚举不完整」。

#### [Major] M2. SPEC 未引用 ADR-0027 证据与交付契约，WorkBuddy 的 delivery/application proof capability 完全未定义

- **证据**：SPEC 头部 Architecture anchor 仅列 ADR-0020（spec:7），Evidence base 六份文档无 ADR-0027（spec:6）。而 `docs/adr/0020-codex-cli-host-adapter.md:3`（2026-10-07 evidence reference）明确「ADR-0027 defines shared evidence and delivery semantics. Host-specific proof capability remains distinct」。ADR-0027 §2.3/§2.4（`docs/adr/0027-...md:64-79`）规定 Delivery 记录的授权写入者是「Trusted host adapter」，且每宿主 capability 须声明 Supported/Unsupported/Unknown + proof reference + maximum confirmation strength。Codex 侧已有对应实现：`packages/codex-adapter/src/pd-hook.ts:329-369`（encode-before-deny-evidence、`codex_permission_decision_encoded` 边界、runtime_verified application claim）。
- **问题**：SPEC G1/G5 声称沉淀证据链，但未回答：SessionStart stdout 直注能否作为 delivery confirmation？WorkBuddy 注入通道（stdout 直注）连 Codex 的 additionalContext 回执都没有——按 ADR-0020 文件头警告「a durable Codex receipt is not automatically confirmed context receipt」，WorkBuddy 的交付证明强度只会更低，SPEC 对此只字未提；deny evidence recorder 的 WorkBuddy 对应物也未定义。
- **建议**：§10 新增「与 ADR-0027 的关系」小节：声明 WorkBuddy 的 delivery proof capability（初判：SessionStart stdout 直注 = attempt-only，无 confirmed receipt），明确 MVP 是否要求 runtime_verified application evidence，还是降级为 attempt-only 并记录证据强度差。

#### [Major] M3. Phase 0 探针遗漏：settings/hooks 变更的生效门（/hooks review + 启动快照）与卸载缓存窗口

- **证据**：官方 hooks 快照 `docs/plans/2026-10-12-workbuddy-official-hooks-reference.md:836-841`：「Editing the settings file does **not** hot-load hooks. CodeBuddy Code: 1. Captures a snapshot at startup… 4. Requires review in the `/hooks` panel before changes apply.」SPEC §7.1 探针第 4 项仅列「enabledPlugins 形状」（spec:232）；SPEC §5 改动面 2 的 install/uninstall 流程无任何 review/重启后置步骤（spec:206）。对比 Codex SPEC §5.7 后置步骤明确要求打印 `/hooks` 信任指引（`docs/architecture/CODEX_CLI_ADAPTER_SPEC.md:716-719`）。
- **问题**：若 WorkBuddy hooks 配置变更也需 `/hooks` 面板 review 才生效，则 installer 写 settings.json 后用户不 review 则 hook 不触发——PD 静默不生效，正是 SPEC §4.4 自己要消除的「静默失效比不生效更糟」。卸载同理：启动快照意味着卸载后当前会话 hook 仍会触发一个会话窗口。探针与 installer 设计均未覆盖。
- **建议**：探针第 4 项扩展为「启用机制全链：enabledPlugins 形状、写入后是否需 /hooks review、是否需重启、plugin 目录热更新行为、卸载后的缓存窗口」；installer install()/uninstall() 增加结构化后置指引（rc-9 可观测，对齐 Codex SPEC §5.7 先例）。

#### [Major] M4. OD-01 fail-closed 设计：分事件效力、与 PRI-943 belt 的交互、exit 2 message 形态均未定义

- **证据**：SPEC §4.4 表格（spec:178-189）笼统表述「PD 内部错误 → exit 2 + stderr 结构化诊断 + stdout deny JSON」。但：
  - 官方 `hooks-reference.md:641-649`：exit 2 的阻断力**分事件**——PreToolUse 阻断工具调用（:641）；PostToolUse「tool already ran」仅 surfacing message（:642）；SessionStart 是「N/A – message shown to the user」（:648）。SPEC 未分事件说明，实施者会误以为三事件都 fail-closed；
  - `hooks-reference.md:632`：exit 2 的 message 取自 stdout JSON `reason`/`stopReason` 或纯文本——并非 `hookSpecificOutput.permissionDecisionReason`，SPEC「stdout deny JSON」的确切形态未定义（这属于探针第 2 项未知，SPEC 却写成既定设计）；
  - `packages/codex-adapter/src/pd-hook.ts:379-445`（PRI-943 belt）与 :501-513：Codex 侧对「stdout 写抛错 / host 关管道 / 序列化失败」三种进程边界失败全部降级 `{}` + exit 0。WorkBuddy 坚持 fail-closed 时，流死场景下没有 stdout 就没有 deny message——belt 是否需要重写、如何重写，SPEC 无决策。
- **问题**：OD-01 是核心设计决策，但决策文档缺失三个实施必需的边界定义；且与 Codex 现行行为的不一致未纳入跨宿主 parity 考虑。
- **建议**：§4.4 增加 (a) 分事件 exit 2 效力表；(b) 明确 fail-closed 适用范围（建议仅治理路径内部错误，环境类错误沿用 codex belt 降级）并记录理由；(c) exit 2 的 stdout 形态标注「待 Phase 0 探针 2 确认」；(d) §8 增加流死/序列化失败场景的进程级测试。

#### [Major] M5. MVP 范围划错：UserPromptSubmit 被放 Phase 2，导致 prompt injection 路径 per-session 化，与 G1「与 Codex 侧语义一致」矛盾

- **证据**：SPEC §4.2（spec:158-159）将 `UserPromptSubmit → before_prompt_build` 标为 Phase 2，MVP 仅靠 `SessionStart`（spec:157）承载原则注入。而 Codex 侧 `packages/codex-adapter/src/host-adapter.ts:31-41` 的 SUBSCRIBED_EVENTS 含 `before_prompt_build`——Codex 的原则注入是 per-turn（UserPromptSubmit additionalContext）。SPEC §0（spec:19）与 G1（spec:39）则声称三条 MVP-Core 路径「与 Codex 侧语义一致」。§3.5 差异表（spec:123）把「SessionStart stdout 直注（更轻）」当优点，未揭示 per-turn 注入缺失。
- **问题**：三条 MVP-Core 路径之一的 prompt injection 在 WorkBuddy MVP 上退化为「每会话一次」。会话中 Owner 批准新原则后无法在当前会话生效（compact 边界有部分缓解——`hooks-reference.md:455` SessionStart matcher `compact` 会重新触发）。补上此缺口的成本极低：事件映射加一行、encoder 已支持 additionalContext（`output-encoder.ts:35`）、hooks.json 加一个订阅。属于「该做没做」。
- **建议**：二选一——(a) 将 UserPromptSubmit 升入 MVP（推荐，工作量小且消解 G1 矛盾）；(b) 保留 Phase 2 但修正 G1 表述为「闸门/证据两路径与 Codex 一致；注入路径为 session 级，per-turn 差异记录在案」，并在 §3.5 差异表明确列为已知缺口。

#### [Major] M6. encoder 白名单允许显式 `permissionDecision: "allow"`——在 WorkBuddy 上等于 PD 主动 bypass 权限系统

- **证据**：SPEC §4.3（spec:173）白名单允许 `permissionDecision`（仅 allow/deny）。官方 `hooks-reference.md:692`：`"allow"` – **Bypass the permission system and execute the tool directly**。Codex 范本 `packages/codex-adapter/src/codec/output-encoder.ts:20-37` 的实际行为是：仅 deny 时发 `permissionDecision: 'deny'`，allow 决策**省略**该字段。Codex SPEC §1.2 Non-Goals 明确「Auto-approving Codex permissions silently」（`CODEX_CLI_ADAPTER_SPEC.md:69`）；ADR-0020 §3.B（`0020-...md:141-142`）确立 PD 被动观察者角色。
- **问题**：SPEC 未定义 shared runtime 产出 `decision: 'allow'` 时的编码方式。若实施者按白名单字面发显式 `allow`，PD 就把「本该由用户在权限对话框确认的工具调用」静默放行——这是「静默授权」，与 PD 产品边界直接冲突，也是白名单留给实施者的安全坑。
- **建议**：§4.3 明确 `decision: 'allow'` 编码为**省略 permissionDecision**（对齐 codex 范本，让宿主走正常权限流程）；白名单中删除显式 allow，或给出「PD 主动 bypass 权限系统」的明确论证与 Owner 批准记录。

#### [Major] M7. §4.1 启动机制引用不存在的范本文件，插件入口的依赖解析策略未定义

- **证据**：SPEC §4.1（spec:149）：「node 脚本经 `.cjs` wrapper 启动，参考 codex 的 `pd-hook-entry.cjs`」。仓库搜索证实 **`pd-hook-entry.cjs` 不存在**（codex-adapter 实际入口为 `dist/pd-hook.js`，见 `packages/codex-adapter/package.json:13-15` 的 `exports` 与 `packages/codex-adapter/src/pd-hook.ts:1` 的 shebang ESM 形态；`tests/pd-hook-entry-belt.test.ts` 是 belt 测试而非范本）。同时，WorkBuddy 插件环境下 `@principles/core` 等运行时依赖如何解析（bundle 进插件目录 / 依赖 `~/.pd/runtime` / 官方 `CODEBUDDY_PLUGIN_DATA` node_modules 模式，见 `plugins-reference.md:481-489,518,532-552`）完全未定义，且不在 Phase 0 探针清单（spec:228-234）中。
- **问题**：违反 P1 Evidence-First（引用不可核对）；且「hook command 如何在插件目录解析依赖」是 Phase 1 第一个会撞上的实施未知，却不被任何探针覆盖。
- **建议**：删除或更正 `pd-hook-entry.cjs` 引用；新增设计小节定义插件入口的依赖解析策略，并纳入 Phase 0 探针（在真实插件目录中验证 `node <entry>` 可解析 `@principles/*`）。

#### [Minor] N1. 引用精确性合集（§2 Reality Audit）

- **证据**：spec:69 称 pd-hook.ts「514 行」——实际 515 行；spec:75 引 `tests/bdd/support/vitest-bdd.js`——实际为 `vitest-bdd.ts`；spec:67 称 WorkBuddy 是 HostAdapter「第三实现」——`host-adapter.ts:14` 注释明确「Only `CodexHooksHostAdapter` implements this interface」，OpenClaw 并未实现该接口（ADR-0020 §2.2/§10.5，`abstraction_layer_v1` 默认 false 走 legacy 路线），WorkBuddy 实为**第二个实现、第三个宿主包**；spec:209 引 `prompt-injection-projection.ts` 未标包名——实际位于 `packages/host-runtime/src/`（非 principles-core）。
- **建议**：逐项修正；「第三实现」改为「HostAdapter 的第二个实现（Codex 之后）、第三个宿主包」，避免误导回归面判断。

#### [Minor] N2. §3.5 差异表遗漏「生效门」行；§3.2 generation_id 口径偏差

- **证据**：SPEC §3.5（spec:116-123）无「hook 信任/生效门」行——Codex 有 `/hooks` trust flow 且「PD hooks will not execute until trusted」（`CODEX_CLI_ADAPTER_SPEC.md:144`），WorkBuddy 插件级 hooks 不受 frontmatter 门（`plugins-reference.md:159`）但 settings 变更需 `/hooks` review（`hooks-reference.md:836-841`），两侧机制不同且都决定「安装后如何生效」。SPEC §3.2（spec:99）称「UserPromptSubmit/Stop 带 generation_id」——官方 `hooks-reference.md:479` 将 generation_id 列为 **common field**（所有事件可带、optional、omitted when unavailable），并非两事件特有。
- **建议**：§3.5 增加「生效门」行（含待探针确认标注）；§3.2 改为「generation_id 为公共可选字段，同一 turn 内共享」。decoder 现有设计（可选、缺失不合成）本身稳健，仅事实陈述需修正。

#### [Minor] N3. Node >=20 基线契约未继承（ADR-0020 §10.4）

- **证据**：`0020-...md:292`：「Node.js `>=20` as the plugin support baseline… Setup and health validation must fail loud before hook activation when node is missing or reports a version below 20」，且 installed-bundle/codex-adapter/host-runtime 测试须过 Node 20 和 22。SPEC §5 改动面 2 的 detect() 只查 marker/settings 条目（spec:206）；SPEC §9 风险 6（spec:292）承认 node/PATH 问题但未升级为契约。
- **问题**：WorkBuddy hook 经 Git Bash 起 node 子进程；node 缺失或 <20 时 hook 崩溃——若 OD-01 fail-closed 落地，这恰是最常见的现实触发场景（会把环境故障放大为全工具阻断），却无 setup 前置校验。
- **建议**：installer detect()/install() 增加 node 存在性与 >=20 校验（结构化 reason+nextAction）；§8 声明 Node 20/22 测试矩阵或引用 ADR-0020 §10.4 既有覆盖并说明 workbuddy-adapter 如何纳入。

#### [Minor] N4. §4.6 TranscriptReader 未声明 ADR-0020 §11.2 的隐私边界与门控

- **证据**：`0020-...md:408-418`（§11.2）确立 Codex ingestion 边界：「Only the transcript explicitly provided by the authenticated Workspace hook may be read; scanning `$CODEX_HOME/sessions` to guess a "latest session" is forbidden」，且受 quiet flag + consent disclosure 双门控。SPEC §4.6（spec:195-197）仅提「脱敏评估 + 复用遥测匿名化管道」。
- **问题**：WorkBuddy 侧读 transcript 是否需要独立 flag / Owner consent、「读+配对」的输出落点（pain_events 证据链？）均未回答；「只读宿主注入路径、不扫描目录」的不变式未成文。
- **建议**：§4.6 显式引用 ADR-0020 §11.2 边界原则；声明 MVP 不做 ingestion（无 flag/consent 需求）或将其独立立项；定义「读+配对」输出落点。

#### [Minor] N5. 并发 hook 执行未纳入验证计划

- **证据**：官方 `hooks-reference.md:846`：「All matching hooks run in parallel」（Codex 同，`CODEX_CLI_ADAPTER_SPEC.md:184`）。SPEC §8 验证计划（spec:259-268）无并发场景。
- **问题**：每次调用 spawn 新 node 进程 + SQLite 写入（pain evidence / state.db）；codex-adapter 已验证该模式，但 WorkBuddy SPEC 声称同构复用却未把并发写入安全列为验收项。
- **建议**：§8 增加一条：PostToolUse 并发触发下的 SQLite 写入安全（引用 codex 侧既有证据或补进程级并发测试）。

#### [Minor] N6. 缺少 Complexity Delta 表（AGENTS.md §13）

- **证据**：`AGENTS.md:823-852` 要求每个 non-trivial implementation 报告七项 Complexity Delta（含 New host/platform-specific behavior、New runtime feature flag 等）。SPEC 声称遵守 AGENTS.md（spec:54、spec:257）但全文无该表。
- **建议**：SPEC 增补 Complexity Delta 表——本 SPEC 的预期答案为：新持久化状态 NO、新子系统 NO、新公开抽象 NO、新 flag YES（host.workbuddy）、新跨包依赖 NO、新宿主行为 YES——逐项附理由，帮助 Owner 决策。

#### [Minor] N7. OD-05 的 channel 硬编码清单比 SPEC 引用的更广

- **证据**：SPEC OD-05（spec:282）与取证报告（`2026-08-28-workbuddy-adapter-verification.md:85`）仅引 `sqlite-activation-safety-store.ts:137,188,189`。实测还有 :226、:249、:282、:354、:393，以及 `activation-compatibility-read-model.ts:86`、`sqlite-activation-state-store.ts:142`。
- **建议**：「全链审查」从风险表一句话升级为 OD-05 前置条件，附完整位置清单或可复现的 grep 模式（已核实这些 SQL 均以 channel 为条件、无 hostKind 维度，复用结论本身成立）。

### 对 OD 表的逐条意见

**OD-01（fail-closed）**：方向认可——WorkBuddy exit 2=阻断有官方依据（`hooks-reference.md:641`）。但须按 M4 修订（分事件效力、belt 交互、exit 2 形态），并补两点：(a) 缓解措施建议分级——仅对「治理路径内部错误」（dispatch/encode 抛错）fail-closed，环境类错误（node 缺失、stdin 非法、workspace 解析失败）保持 fail-open + stderr，否则 PD 自身最常见的环境故障会被放大为全工具阻断；(b) 与 Codex 的失败语义不一致必须**显式记录为有意差异**并纳入 §8 parity 断言——否则 PRI-632 跨宿主契约冻结时会把它当 regression 修掉；同时记录「Codex 侧是否/何时对齐」的决策，防止跨宿主语义漂移被当成 bug「修复」。

**OD-02（三事件 MVP）**：基本合理，与 Codex MVP 的 before_tool_call/after_tool_call/session_start 对应。但 UserPromptSubmit 划 Phase 2 是范围划错（见 M5）。PreCompact defer 理由成立（需新增 HostEventKind，触及共享 runtime 事件词表——`host-adapter.ts:38-53` 证实 6 种词表冻结）；「上帝视角归因」独立立项合理（§10 已建议紧随立项），建议补 restart condition 防止无限期 defer。

**OD-03（quiet 默认 off）**：与 ADR-0014 / ADR-0020 §2.4 先例一致。但 SPEC §6「安装器不主动写 flag 到 config.yaml（PRI-645 先例）」（spec:220）与 ADR-0020 §10.5「Fresh setup and migration must persist both entries explicitly under `.pd/config.yaml.features` rather than relying only on registry defaults」（`0020-...md:304-314`）存在未消解张力——SPEC 应明示选择及理由（建议：按 ADR-0020 §10.5 显式持久化，与 host.codex 验收先例一致）。

**OD-04（本机安装）**：与 WorkBuddy 插件模型匹配（`plugins-reference.md:288,682` enabledPlugins in settings.json）。缺两项论证：(a) Codex 侧已退役本机全局 hooks 安装转 Marketplace-only（`codex-host-installer.ts:247-268`），SPEC 应记录 WorkBuddy 开本机安装的差异依据（无等价 marketplace 接入渠道 + 插件 hooks 无 trust flow）；(b) installer 写 enabledPlugins 即生效、无 Owner 在宿主内的显式同意步骤——与 ADR-0020 §3.F「Silent dual-install without consent violates the confirm-first principle」（`0020-...md:153-154`）的关系需说明（promptHost() 选项满足「选择宿主」，但 hook 生效同意在 WorkBuddy 侧无对应物；建议 install 结果带显式 reason+nextAction 并打印生效指引）。

**OD-05（复用 code_tool_hook）**：无意见，结论正确——已核实的硬编码 SQL 均以 channel 为条件、无 hostKind 维度，WorkBuddy activation 走同一 channel 不冲突；仅按 N7 补全清单并把全链审查升级为前置条件。

**OD-06（modifiedInput）**：defer 合理。但注意 ADR-0020 §10.2.1 明文「The `modify` path is used exclusively for `before_prompt_build`… not for tool-input rewriting (Codex 0.147 has no `modifiedInput` field)」（`0020-...md:269`）——WorkBuddy 实施 OD-06 时该 ADR 论断需修订，SPEC §10 的增量 ADR 计划应显式包含此点，否则实施时会撞上「ADR 说不允许」的意图冲突。

### 建议补充的章节、测试或前置工作

1. **§10 增加「与 ADR-0027 的关系」小节**：声明 WorkBuddy 的 delivery/application proof capability 与证据强度（M2）。
2. **§4.4 增加分事件 exit 2 效力表 + belt 交互决策 + exit 2 stdout 形态**（待探针 2 确认的显式标注）（M4）。
3. **§4.3 明确 `decision:'allow'` = 省略 permissionDecision**（对齐 codex 范本 `output-encoder.ts:20-37`），白名单删除显式 allow 或给出 bypass 论证（M6）。
4. **§5 改动面 5 改为「hostKind 联合全链审查」**，分 MVP 必改（trajectory-types、intervention-evidence-normalizer、activations/approvals routes、prompt-injection 三处）与可延后（pd-console UI）（M1）。
5. **MVP 范围二选一决策入档**：UserPromptSubmit 升 MVP，或修正 G1 并记录 per-turn 注入缺口（M5）。
6. **Phase 0 探针补充项**：settings 写入后 /hooks review 与重启行为、卸载缓存窗口、node 可发现性（Git Bash PATH）、插件入口依赖解析策略、并发触发、exit 2 message 形态（M3/M4/M7、N3/N5）。
7. **§8 补充测试**：Node 20/22 矩阵（或引用 ADR-0020 §10.4 覆盖说明）、跨宿主失败语义差异 parity 断言、并发写入测试、流死/序列化失败进程级测试（M4、N3、N5）。
8. **§4.6 声明 ADR-0020 §11.2 边界**（只读宿主注入 transcript_path、禁扫描目录猜 latest session）（N4）。
9. **增补 Complexity Delta 表**（AGENTS.md §13）（N6）。
10. **mvp-q-2 的「pd-console activations 可查」与 activations route 扩展绑定**——该观测承诺目前依赖一个未列入改动面的修改（M1 联动）。

**评审说明**：本报告为只读评审，未修改任何仓库文件。所有 file:line 引用均已通过 Read/Grep 实际核验；SPEC 中经核验**准确**的引用包括：host-adapter.ts:186-221 与 :38-53、codex pd-hook.ts:305-313 与 :263-264、installers/index.ts:27-60、codex-host-installer.ts:234、feature-flag-contract.ts:333、codec/input-decoder.ts:18-24、codec/output-encoder.ts:20-50、pain-signal-bridge.ts:78、prompt-injection-projection.ts:15-16、prompt-injection-event-evidence.ts:32、prompt-injection-contract.ts:15，以及 §3.1/§3.3 对官方 hooks/plugins 快照的退出码、超时、Git Bash、插件环境变量、事件 payload 字段等事实陈述。

---

## 2. 证据核查报告（独立 agent，只读）

### 总体结论

**可信度评级：高。** SPEC 的官方文档引用、代码 file:line、Codex 行为对比、退出码/payload/输出字段语义几乎全部有据且逐一复验通过；主要短板是「桌面版 5.3.14 二进制取证」类声明的时效性——取证对象已被本机 5.8.1 替换，其中「updatedToolOutput 桌面版未实现」已被现行引擎推翻（12 处命中），但 SPEC 的 command+子进程选型、fail-closed 设计方向不受影响。

### 核查明细表（A. 重点核查项）

| # | 声明（所在文档 + 章节） | 结果 | 信源（file:line 或快照章节） | 说明 |
|---|---|---|---|---|
| 1 | 事件数口径：plugins 表 26（无 Setup）/ hooks「27+」/ 桌面版含 Setup 共 27（SPEC §3.2、capability-map §0/§4.2、取证 §2.1/§7-2） | ✅有据 | plugins 快照 §I.3 事件表（逐行计数恰 26 行，无 `Setup`）；hooks 快照 Feature Overview「27+ events」；取证文档 §2.1 列表含 `Setup` | 三方口径陈述与快照逐一相符，且各自说明了「以本机取证为准」，无混淆。**补充强化**：本人在现行 5.8.1 引擎 `cli/dist/codebuddy-lite-wb.mjs` 复验，27 个事件全部命中（含 `Setup`，PreToolUse:7…Setup:11） |
| 2 | 退出码语义：exit 2=阻断性错误、其他=非阻断放行；stdout permissionDecision（allow/deny/ask）与 modifiedInput（SPEC §3.3） | ✅有据 | hooks 快照「Basic Mode: Exit Codes」与「PreToolUse Decision Control」 | 逐字一致：「Exit code 2 – Blocking error. Message source priority: stdout (JSON reason/stopReason field or plain text) > stderr. Stderr is only a fallback」；「Other exit codes – Non-blocking errors…execution proceeds」；`"allow"`/`"deny"`/`"ask"`/`modifiedInput` 拼写语义均一致 |
| 3 | http fail-OPEN 三路径（非 2xx/超时/非法 JSON → allowed: true）（SPEC §3.4、取证 §3.1） | ✅有据（附注见说明） | 取证文档 §3.1 代码摘录；hooks 快照中 http 仅出现于类型列表与 frontmatter 示例（url+method: POST），无任何失败语义记载；取证文档 §7-3 明确标注「官方文档不写 http 类型的失败语义」 | 证据链完整。**但 SPEC §3.4 本身未显式标注「官方文档未记载失败语义」**（该标注在取证文档 §7-3）——Minor。且 5.8.1 架构下 http 实现位置已变（lite-wb.mjs 中 `allowed: true` 0 命中），fail-OPEN 未在现行版复验，应视为 5.3.14 历史取证 |
| 4 | payload 字段名：session_id/transcript_path/cwd/permission_mode/hook_event_name/tool_name/tool_input/tool_response/generation_id（SPEC §3.2） | ✅有据 | hooks 快照「Hook Input」及各事件 Input JSON 示例 | 逐字段一致；SPEC「SessionStart 必填不含 cwd」的细节也与快照示例相符（SessionStart Input 无 cwd）；「无 turn_id、UserPromptSubmit/Stop 带 generation_id」相符（快照全文无 turn_id）。补充复验：现行引擎 transcript_path:39、tool_response:18、generation_id:2、hook_event_name:56、permission_mode:25 均有命中 |
| 5 | 输出字段拼写语义（hookSpecificOutput/permissionDecisionReason/modifiedInput/additionalContext/updatedToolOutput/continue/stopReason/reason/suppressOutput/systemMessage）（SPEC §3.3/§4.3） | ⚠️口径差异 | hooks 快照 Common JSON Fields / PreToolUse / PostToolUse / UserPromptSubmit / SessionStart Decision Control | 拼写与语义全部与快照一致（现行引擎亦全部命中）。**但**「updatedToolOutput 桌面版 5.3.14 grep 0 命中」在 capability-map §4.1 有据（历史取证），而现行 5.8.1 引擎 `updatedToolOutput` **12 处命中**——SPEC §4.3「禁止发出（桌面版未实现）」与 §7.4「桌面版未实现，版本门禁」未加版本限定，现时表述已过时。另 capability-map §1.2 称 additionalContext 覆盖 PreToolUse，官方快照 PreToolUse Decision Control 节未列该字段（仅 PostToolUse/UserPromptSubmit/SessionStart 明确列出）——该行依赖本机取证，宜标注 |
| 6 | SPEC 全部 file:line 引用 | ✅有据（1 处 Minor） | 逐一阅读验证 | host-adapter.ts:186-221（HostAdapter 接口）、:38-53（6 种 HostEventKind）、pd-hook.ts 共 514 行属实（:305-313 createProductionHostRuntime 调用、:263-264 flag 短路）、input-decoder.ts:18-24（事件映射表）、output-encoder.ts:20-50（白名单守卫，:26 deny 仅 before_tool_call）、tool-semantics.ts:29-32（buildToolSemanticRegistry 校验抛错）、installers/index.ts:27-60、codex-host-installer.ts:234（CodexHostInstaller 类定义）、feature-flag-contract.ts:333（host.codex 条目）、pain-signal-bridge.ts:78、prompt-injection-projection.ts:15-16、prompt-injection-event-evidence.ts:32、pd-console/src/shared/prompt-injection-contract.ts:15、sqlite-activation-safety-store.ts:137,188,189（WHERE channel='code_tool_hook'）——全部存在且内容相符。**Minor**：SPEC §2 写 `vitest-bdd.js`，实际为 `tests/bdd/support/vitest-bdd.ts`（扩展名不符） |
| 7 | URL / 文档路径 / 包名 / feature flag 命名 | ✅有据 | 快照头部 URL（workbuddy.ai/docs/cli/plugins-reference、/hooks）与可行性文档 §8 一致；`packages/workbuddy-adapter`、`@principles/workbuddy-adapter`、`host.workbuddy` 为设计新增（对标 @principles/codex-adapter 先例，package.json 实证）；SPEC 引用的 5 份调研文档 + 2 份快照均存在于 docs/plans/；`~/.codebuddy/settings.json`（官方口径）vs `~/.workbuddy/settings.json`（本机实际，含 enabledPlugins）本机复验：后者存在、前者不存在，与取证 §5-3 相符 | 另：SPEC §5 六改动面全部验证相符（含 prompts.ts:105 promptHost、feature-flag-lifecycle.ts:39 QUIET_FLAG_LIFECYCLE、host-runtime/src/host-tool-declaration.ts 的 `.pd/host-tool-semantics/<hostKind>.json`） |
| 8 | 「Codex 适配器 pd-hook.ts 只 exit 0、deny 走 stdout JSON」 | ✅有据 | pd-hook.ts 全文 514 行逐路径核对 | 所有 return 路径 exitCode 均为 0（stdin 非法 JSON :225-226、decode 失败 :234、运行时 catch :375、flag-off :264）；main() :471 `process.exitCode = result.exitCode`；deny 经 encodeOutput → `hookSpecificOutput.permissionDecision='deny'` + reason（output-encoder.ts:28-31）。SPEC §4.4 失败语义表与代码逐行相符 |
| 9 | 关键数字：27 事件 / 60s / prompt 30s / 0.5 天 / 桌面版 5.3.14 / v1.16.0 | ✅有据 | 27：快照+取证+本人在 5.8.1 复验 27/27；60s：hooks 快照「time out after 60 seconds」「Timeout – 60 seconds by default」；30s：hooks 快照 prompt「timeout … (default: 30s)」；0.5 天：可行性 §7-1「预计 0.5 天」+ 取证 §6-1「约 0.5 天」（同为调研估计，非外部事实）；5.3.14：capability-map/取证文档头部一致；v1.16.0：两份快照头部「CodeBuddy Code v1.16.0 and later」 | 5.3.14 有据但注意：本机 install-manifest.json 显示当前已是 **5.8.1**（2026-10-11 安装），5.3.14 取证对象已不在盘 |
| 10 | 「桌面版与 CodeBuddy CLI 同引擎（cli/dist/codebuddy.js）」 | ⚠️口径差异 | 两份快照头部注意栏、capability-map §4.3、取证 §7-1 | 论断有据且与官方 canonical（codebuddy.ai）互证；**但本机现行 5.8.1 的 `cli/dist/codebuddy.js` 已不存在**（dist 下仅 codebuddy-lite-wb.mjs 与 lazy-lite-wb）——字面路径失效，「在本机 cli/dist/codebuddy.js 复核」的纪律（capability-map §4.3）当前无可执行对象 |

### 核查明细表（B. SPEC 其他声明）

| # | 声明（SPEC 章节） | 结果 | 信源 | 说明 |
|---|---|---|---|---|
| 11 | 「不改 HostAdapter 接口；不新增 HostEventKind（现有 6 种）」（§0） | ✅有据 | host-adapter.ts:38-53、:186-221 | 6 种事件与接口字段（hostId/hostKind/subscribedEvents/decodeEvent/encodeOutput）属实 |
| 12 | 「host.workbuddy quiet 类默认 off；host.codex 2026-08-12 翻转先例」（§0/§6） | ✅有据 | feature-flag-contract.ts:333（`host.codex` 现为 core/enabled:true，描述含「flipped 2026-08-12」）；ADR-0020 §10.5 | 与「参照翻转先例」表述相符 |
| 13 | 「安装器不主动写 flag（PRI-645 先例）」（§6） | ✅有据 | docs/architecture/feature-flag-governance.md §3.3「installer 默认值快照——已按 PRI-645 收敛为 sparse shell」；mvp-config.ts:341-352（fresh config 只写 `features: {}`） | 与 ADR-0020 §10.5 早期「显式持久化」要求存在历史张力，但 PRI-645（2026-09-02）为更新先例，SPEC 引用正确 |
| 14 | 「pd-console 无 hook 事件接收端点（POST 404）」（§3.4、取证 §2.2） | ✅有据 | pd-console/src/server 全量 grep 无 hooks 路由；GET 端点 /api/workspaces、/api/v1/config/summary、/api/v1/activations、/api/v1/evidence-chain 均存在（index.ts:480/520/536、routes/evidence-chain.ts） | 静态复验通过 |
| 15 | 「http fail-OPEN = ADR-0020 §1 记录的 Codex 陷阱 E3 的 HTTP 版」（§3.4） | ✅有据 | ADR-0020 §1：「E3: invalid output is fail-OPEN not fail-closed」 | 引用准确 |
| 16 | 「本 SPEC 是 ADR-0020 §10『thin protocol adapters』的第三个实例」（§10） | ✅有据 | ADR-0020 §10.2：「Both host packages become thin protocol adapters」；§1「Future hosts (Claude Code, OpenCode, Pi) are anticipated」 | 取证文档 §3.3 的 ADR-0020 §10 引文逐字相符 |
| 17 | 「transcript_path 35 处标准字段；InstructionsLoaded 实测为空；核心类型 2.5 个月稳定；路径 ~/.workbuddy/projects/&lt;encoded-cwd&gt;/&lt;sessionId&gt;.jsonl；含 reasoning 与 providerData」（§4.3/§4.6/§9） | ✅有据 | transcript 文档 §4.1（35 处）、§6.2（InstructionsLoaded 空）、§8.1 修正结论（2.5 个月稳定）、§2.1（路径规则）、§3.1/§5.2/§8.3（reasoning、providerData） | 逐条相符 |
| 18 | 「0.5 天探针是 8-28 复核唯一未闭环项」（§0/§7.1） | ✅有据 | 取证文档 §5-1「未做端到端实测」+§6-1「约 0.5 天」 | 相符 |
| 19 | 「PD 内部错误 fail-closed 的理由引用 8-28 复核 §3.1 原话」（§4.4） | ✅有据 | 取证文档 §3.1：「静默失效比不生效更糟」 | 原话相符 |
| 20 | 「8 BDD/测试路径：docs/specs/features/story-a/ 存在、mvp-config.test.ts 存在」（§8） | ✅有据 | docs/specs/features/story-a/ 目录（含 codex-shared-host-runtime.feature）；packages/create-principles-disciple/tests/mvp-config.test.ts | 新建 workbuddy-shared-host-runtime.feature 与现有命名模式一致 |
| 21 | 「既有本机噪音基线：health-check-model / workspace-lifecycle Windows EBUSY」（§8） | ❌无据 | 全仓 grep：无 health-check-model 命名基线；workspace-lifecycle 仅存在于 scripts/dev 与 WORKTREE_GOVERNANCE（非测试噪音基线） | EBUSY 噪音现象本身有据（docs/testing/test-archaeology-report.md:160、docs/specs/test-temp-lifecycle-management.md），但这两个具体基线名称无据 |
| 22 | 「PRI-632 / PRI-673 / PRI-560（Done, archived）/ PR #1438 回写」（§10） | 无法验证 | 全仓 grep 仅命中 SPEC 自身；PRI-632/673/560 及 PR #1438 在仓库其他文档无记载（ADR-0020 §11 提及的是 PR #1437/#1440） | Linear/GitHub 外部系统状态，仓库内无法验证，明确标注 |

### 核查明细表（C. 调研文档补充核查）

| # | 声明（文档 + 章节） | 结果 | 信源 | 说明 |
|---|---|---|---|---|
| 23 | 可行性勘误 1-4（http 作废、command+adapter、中文站作废、能力事实准确） | ✅有据 | 取证 §3.1、§7-1/2/3/5；两份快照 | 四条勘误均与证据相符 |
| 24 | 「AGENTS.md:22-25（MVP 三问）、第 31 行核心承诺」（可行性 §5/§8） | ❌无据 | AGENTS.md 实际：22-25 行为「PD owns」列表，31 行为「general agent orchestration」（PD does NOT own 列表）；MVP 四问实际在 §4（:323-387：mvp-q-1 :329 … mvp-q-4 :367） | 行号错误；「重复纠正感→沉淀感」承诺实际位于 docs/product/PRODUCT_IDENTITY.md:66（可行性引用的 docs/product/emotional-value.md **不存在**） |
| 25 | 「pd-console index.ts:114-115（host/port 3100）」（可行性 §1/§8） | ⚠️口径差异 | 实际在 index.ts:125-126（`let port = 3100; let host = '127.0.0.1'`）；114-115 行为 workspace 解析日志 | 内容属实、行号漂移 |
| 26 | 「dist 三文件：production-rulehost-gate.js / active-principle-prompt.js / production-pain-evidence.js」（可行性 §1/§8） | ✅有据 | packages/host-runtime/dist/ 三文件均在 | 文件存在（行号未逐一验证，且 8-21 后代码演进大概率漂移） |
| 27 | 「9 智能体均已实现」（可行性 §1） | ✅有据 | runtime-v2/agent-spec.ts:92-97（diagnostician/dreamer/philosopher/scribe/artificer…）+ observer/（correctionObserver/empathyObserver） | 相符 |
| 28 | 「桌面版真实在用：sheetagent(SubagentStop)、tencent-docx(SessionStart)、tencent-pptx(PreToolUse+matcher:Skill)」（取证 §2.1） | ⚠️部分复验 | 本机 `~/.workbuddy/plugins/cache/workbuddy-builtin/`：sheetagent hooks.json 确有 SubagentStop ✅；tencent-docx plugin.json 确有 `"hooks": "./hooks/hooks.json"` 且 hooks.json 有 SessionStart ✅；**tencent-pptx 三个缓存版本（5.6.2/5.7.6/5.7.7）均无 hooks 字段/目录** ❌ | 8-28 当时 tencent-pptx 状态无法确证（疑被后续插件更新移除），该条标注存疑 |
| 29 | capability-map §1.1「Setup 属取证独有发现（无官方文档）」 | ✅有据 | plugins 快照 26 事件表无 Setup；hooks 快照 Feature Overview 事件枚举含 `Setup`（bootstrap/maintenance 段）——即 Setup 在 hooks 文档概述中出现但未进 plugins 表 | 与 capability-map §4.2 自洽说明相符（官方两文档覆盖不一致） |
| 30 | capability-map §2.3「idle_prompt > 60 秒触发」；§5-5「60s/30s」；§5-4「Git Bash 强制 + CODEBUDDY_CODE_GIT_BASH_PATH」 | ✅有据 | hooks 快照 Notification 节「after idle > 60 seconds」；Execution Details；Windows Git Bash 段 | 逐字相符 |
| 31 | 「Plugin agent 不支持 hooks/mcpServers/permissionMode」（可行性 §6-3、capability-map §1.4/§5-1） | ✅有据 | plugins 快照 §I.2：「plugin agents do not support the `hooks`, `mcpServers`, or `permissionMode` fields」 | 逐字相符 |
| 32 | 「plugin hooks.json 不受 allowUntrustedFrontmatterHooks 门禁」（SPEC §3.1、取证 §7-4） | ✅有据 | hooks 快照 Safety Gate 表「Plugin hooks/hooks.json (not frontmatter) ✅ Not subject to the gate」；plugins 快照 §I.3 差异表 | 逐字相符 |
| 33 | capability-map §1.4「Sub-agent 嵌套 5 层、spawn 预算 200、SDK 8 类事件」等 | 无法验证 | 无对应官方快照（sub-agents/sdk 文档未存档）；二进制已更新无法复验 | 明确标注无法验证 |

### 需修正声明清单（按严重度）

**Blocker：无。** 未发现使 SPEC 决策方向（command 类型 + 子进程适配器 + fail-closed）失效的矛盾；所有核心选型依据在官方快照中仍然成立。

#### Major

| ID | 位置 | 问题 | 建议 |
|---|---|---|---|
| M1 | SPEC §4.3「禁止发出 updatedToolOutput（**桌面版未实现**）」、§7.4 表同列；capability-map §4.1/§1.2「桌面版 5.3.14 的 PostToolUse 只能追加」 | 现行引擎（5.8.1，`cli/dist/codebuddy-lite-wb.mjs`）中 `updatedToolOutput` **12 处命中**——「桌面版未实现」的现时表述已被推翻（5.3.14 grep 0 命中本身有据） | 将表述限定为「5.3.14 取证时未实现；本机现行 5.8.1 已实现（12 处命中），Phase 0 探针须以现行版本重新确认」；版本门禁设计保留，但门禁依据从「未实现」改为「未复验」 |
| M2 | SPEC §9 风险 1/§7.1、capability-map §4.3、取证 §7-1：复核纪律「在本机 `cli/dist/codebuddy.js` 复核」；「桌面版与 CLI 同引擎（cli/dist/codebuddy.js）」 | 本机 WorkBuddy 已升级 5.8.1（install-manifest.json，2026-10-11），`cli/dist/codebuddy.js` **已不存在**（现为 codebuddy-lite-wb.mjs）。所有 5.3.14 计数类取证（事件命中数、payload 字段计数、http fail-OPEN 代码摘录、updatedToolOutput 0 命中）在当前机器**不可复现** | 将这些声明显式标记为「5.3.14 历史取证」；更新复核路径为现行引擎文件；Phase 0 探针范围相应扩大（「同引擎同源」实质仍成立——现行引擎 27 事件全命中佐证——但字面路径需更正） |
| M3 | 可行性文档 §5「AGENTS.md 第 22–25 行」「AGENTS.md 第 31 行核心承诺」；§5 mvp-q-4「docs/product/emotional-value.md（第 31 行）」；§8「AGENTS.md:22-25, 31」 | 三处行号/路径均错误：MVP 四问实际在 AGENTS.md §4（:323-387）；line 31 内容为「general agent orchestration」；emotional-value.md 不存在（承诺原文在 PRODUCT_IDENTITY.md:66） | 更正为 AGENTS.md:323-387 与 docs/product/PRODUCT_IDENTITY.md:66 |

#### Minor

| ID | 位置 | 问题 | 建议 |
|---|---|---|---|
| m1 | SPEC §4.1「参考 codex 的 `pd-hook-entry.cjs`」 | 该文件名不存在；codex 侧实际 wrapper 为 `plugins/principles-disciple/hooks/pd-hook.cjs`（hooks.json 以 `node "${PLUGIN_ROOT}/hooks/pd-hook.cjs"` 调用，`.cjs`+node 模式本身有据） | 更正文件名为 pd-hook.cjs |
| m2 | SPEC §2「`packages/principles-core/tests/bdd/support/vitest-bdd.js`」 | 实际文件为 `vitest-bdd.ts` | 更正扩展名 |
| m3 | SPEC §8「既有本机噪音基线（health-check-model / workspace-lifecycle Windows EBUSY）」 | 仓库无这两个命名的测试基线 | 改为泛指「Windows EBUSY 类既有噪音（见 docs/testing/test-archaeology-report.md）」或给出真实基线名 |
| m4 | 取证文档 §2.1「tencent-pptx(PreToolUse + matcher: "Skill")」 | 本机 tencent-pptx 三个缓存版本均无 hooks 声明（sheetagent/tencent-docx 复验相符） | 加注「现行版本已不含 hooks，8-28 当时状态待考」 |
| m5 | 可行性文档 §1/§8「pd-console/src/server/index.ts:114-115」 | 行号漂移（实际 :125-126） | 更新行号 |
| m6 | SPEC §3.4 | 未显式标注「官方文档未记载 http 失败语义」（该关键证据链闭环在取证文档 §7-3） | 在 §3.4 显式引用，避免读者误以为官方有记载 |
| m7 | capability-map §1.2「additionalContext（PreToolUse/PostToolUse/UserPromptSubmit/SessionStart）」 | 官方快照 PreToolUse Decision Control 节未列 additionalContext（其他三个注入事件明确列出） | 标注「PreToolUse 支持 additionalContext 系本机取证，官方文档未明确」 |
| m8 | SPEC §10 PRI-632/PRI-673/PRI-560/PR #1438 | 仓库内无任何佐证 | 标注「以 Linear 为准，本核查无法验证」 |

### 信源本身的问题

1. **官方两份快照事件数自相矛盾**：plugins-reference 事件表列 26 个（无 `Setup`），hooks 文档称「27+ events」。调研文档已正确处理（以本机取证 27 为准），且本人在现行 5.8.1 引擎复验 27/27 事件命中（含 `Setup`），支持「27」口径。
2. **官方文档完全不记载 http 类型的失败语义**：四种 hook 类型中，http 仅出现在类型列表和一个 frontmatter 示例（url + method: POST），非 2xx / 超时 / 非法 JSON 的处理只字未提——fail-OPEN 发现无任何文档依据，只能靠二进制取证（取证文档 §7-3 已如实标注）。
3. **官方 hooks 快照 PreToolUse Decision Control 示例缺 `additionalContext`**：PostToolUse/UserPromptSubmit/SessionStart 均明确列出该字段，唯独 PreToolUse 节未列——官方文档内部覆盖不完整（capability-map 的 PreToolUse additionalContext 依赖本机取证）。
4. **快照头部自身的环境性注记已过时**（已于 2026-10-12 当日修正）：两份快照注意栏原称「WorkBuddy 桌面版与其共用引擎（`cli/dist/codebuddy.js`）」——本机 5.8.1 该路径已不存在（现为 `cli/dist/codebuddy-lite-wb.mjs`）。「同引擎同源」的实质仍成立（现行引擎 27 事件全命中佐证），但字面路径引用需随版本更新。
5. **快照 Debug 节自陈未实现**：「codebuddy --debug 打印 hook execution like…」上方明确写「Note: This feature is not yet supported.」——引用该示例佐证可观测性时需注意。
6. **中文站 workbuddy.cn Hooks 页为旧版**（7 事件、仅 command 类型）——调研文档已全部标注作废，处理正确。

**核查方法附注**：本报告全部结论基于只读检查。代码引用均以实际行号阅读验证；官方声明均与两份快照逐字比对；二进制取证类声明除引用 8-28 取证记录外，另在本机现行引擎（5.8.1，`cli/dist/codebuddy-lite-wb.mjs`，9.5MB）上做了事件名/字段名计数复验。凡仓库外系统（Linear 工单状态、GitHub PR）一律标注「无法验证」。

---

## 3. 合并行动清单（SPEC v0.2 修订闭环，对应 PRI-952 Phase A）

以下为两份报告去重合并后的修订项，共 10 项 Major + 14 项 Minor：

### Major（10 项，修订完成前不得进入 Phase 0 探针）

| # | 来源 | 修订项 |
|---|---|---|
| 1 | 架构 M1 | §5 改动面 5 改为「hostKind 联合全链审查」：MVP 必改（trajectory-types:82-83、intervention-evidence-normalizer:74、activations/approvals routes、prompt-injection 三处）+ 可延后（pd-console UI）；§2 审计结论同步修正；mvp-q-2 观测承诺与 activations route 绑定 |
| 2 | 架构 M2 | §10 新增「与 ADR-0027 的关系」：WorkBuddy delivery proof capability 声明（SessionStart stdout 直注初判 attempt-only）+ MVP 证据强度决策 |
| 3 | 架构 M3 | Phase 0 探针扩展启用机制全链（enabledPlugins 形状 / `/hooks` review / 重启 / 卸载缓存窗口）；installer install/uninstall 增加结构化后置指引 |
| 4 | 架构 M4 | OD-01 补：分事件 exit 2 效力表（PreToolUse 阻断 / PostToolUse 仅 surfacing / SessionStart 仅示众）+ 与 Codex PRI-943 belt 的交互决策 + exit 2 stdout 形态标注「待探针确认」；§8 补流死/序列化失败进程级测试 |
| 5 | 架构 M5 | MVP 范围二选一入档：UserPromptSubmit 升 MVP（推荐）或修正 G1 + §3.5 记录 per-turn 注入缺口 |
| 6 | 架构 M6 | §4.3 明确 `decision:'allow'` = 省略 permissionDecision（对齐 codex 范本）；白名单删除显式 allow 或附 bypass 论证 |
| 7 | 架构 M7 | 删除不存在的 `pd-hook-entry.cjs` 引用（改为 pd-hook.cjs 事实）；新增插件入口依赖解析策略小节并纳入探针 |
| 8 | 证据 M1 | `updatedToolOutput` 表述改为「5.3.14 取证时未实现；现行 5.8.1 已实现（12 处命中），Phase 0 以现行版重新确认」；版本门禁依据改为「未复验」 |
| 9 | 证据 M2 | 所有 5.3.14 计数类取证声明标记「历史取证」；复核路径更新为现行引擎文件（先 `ls` 引擎目录） |
| 10 | 证据 M3 | 可行性文档行号/路径更正：AGENTS.md:323-387（MVP 四问）、PRODUCT_IDENTITY.md:66（情绪价值承诺，emotional-value.md 不存在） |

### Minor（14 项）

| # | 来源 | 修订项 |
|---|---|---|
| 1 | 架构 N1 / 证据 m2 | pd-hook.ts「514 行」→515 行；`vitest-bdd.js`→`vitest-bdd.ts`；「第三实现」→「第二个实现、第三个宿主包」；prompt-injection-projection.ts 补包名（host-runtime） |
| 2 | 架构 N2 | §3.5 增加「生效门」行（含待探针确认标注）；§3.2 generation_id 改为「公共可选字段，同一 turn 内共享」 |
| 3 | 架构 N3 | installer detect()/install() 增加 node 存在性与 >=20 校验；§8 声明 Node 20/22 测试矩阵或引用 ADR-0020 §10.4 |
| 4 | 架构 N4 | §4.6 显式引用 ADR-0020 §11.2 边界（只读宿主注入 transcript_path、禁扫描目录）；声明 MVP 不做 ingestion 或独立立项；定义「读+配对」输出落点 |
| 5 | 架构 N5 | §8 增加 PostToolUse 并发触发下的 SQLite 写入安全验收项 |
| 6 | 架构 N6 | 增补 Complexity Delta 表（AGENTS.md §13，七项） |
| 7 | 架构 N7 | OD-05 channel 硬编码全链审查升级为前置条件，附完整位置清单（sqlite-activation-safety-store :137/188/189/226/249/282/354/393、activation-compatibility-read-model:86、sqlite-activation-state-store:142） |
| 8 | 证据 m1 | SPEC §4.1 `pd-hook-entry.cjs`→pd-hook.cjs（与架构 M7 合并处理） |
| 9 | 证据 m3 | SPEC §8 噪音基线改为泛指（docs/testing/test-archaeology-report.md） |
| 10 | 证据 m4 | 取证文档 §2.1 tencent-pptx 条加注「现行版本已不含 hooks，8-28 当时状态待考」 |
| 11 | 证据 m5 | 可行性文档 pd-console index.ts:114-115→:125-126 |
| 12 | 证据 m6 | SPEC §3.4 显式标注「官方文档未记载 http 失败语义」 |
| 13 | 证据 m7 | capability-map §1.2 additionalContext 覆盖 PreToolUse 标注「系本机取证，官方文档未明确」 |
| 14 | 证据 m8 | SPEC §10 PRI 工单/PR 标注「以 Linear 为准」 |

### OD 表待 Owner 批准（评审特别标注）

- **OD-01**：评审建议分级 fail-closed（仅治理路径内部错误；环境类错误沿用 codex belt 降级），且须显式记录为与 Codex 的有意差异 + parity 断言，防 PRI-632 契约冻结时被当 regression
- **OD-03**：ADR-0020 §10.5「显式持久化」与 PRI-645「sparse shell」的历史张力需明示选择（评审倾向显式持久化）
- **OD-04**：Codex 已 Marketplace-only，WorkBuddy 开本机安装的差异依据 + 无宿主内显式同意步骤与 ADR-0020 §3.F confirm-first 的关系需说明
- **OD-06**：实施时需修订 ADR-0020 §10.2.1「modify 仅限 before_prompt_build」的论断（增量 ADR 显式包含）

---

*本报告由两个独立只读评审 agent 于 2026-10-12 产出，经主编整合、去重、合并行动清单；原始发现均保留原文。评审过程未修改任何仓库文件；本报告及同日对 SPEC 头部、快照头部的状态性更新除外。*
