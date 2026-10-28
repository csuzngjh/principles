# SPEC-CODEX-PAIN-CLOSURE-001 — Codex 痛苦反馈处理闭环修复

版本：v0.2，2026-10-14；替代 2026-10-13 的 v0.1 草案，新增真实入口、成功诊断后续接、后台活性和强制成功验收。

状态：**Draft / 等待 Owner 审阅；尚未授权实施或变更治理状态。**

基线：仓库 `b0f807b95d8c86e88fe46b7f2a63eec1923af24a`，本机安装产品 2.3.3 的 sourceCommit 与之相同。实施前必须重新核对基线及安装版本。

关联：PRI-958（准入处置可观察性）、PRI-959（手动反馈证据边界）。本 SPEC 不声称这两张票已获批准，不将票号或源码注释视为 Owner 授权凭证。

## 1. 结论与 Owner 审阅摘要

目标是让 PD 在 Codex 中如实记录执行结果，并把 Owner 明确提交的行为反馈推进到可审阅的候选；卡住时能直接说明原因和下一步。

本次修复分四部分：

1. 真实失败不再被默认记为成功，无法确认的结果明确记为未知。
2. Owner 明确提交的陈述成为独立、注明来源的诊断依据；不要求工具先报错，也不默认采集整段对话。
3. 自动路径、手动 CLI 和控制台使用一致的准入事实，避免后台拒绝、事后却显示可以收编。
4. 已成功诊断但后处理未完成的记录由现有 worker 持续续接；收编、seed 和重启之间没有无人消费的断点。

Owner 需要审阅的行为调整是第 2 部分：允许绑定真实 Codex 会话的明确 Owner 陈述，满足候选准入的“输入依据存在”条件。它不等于独立验证了陈述，也不免除其他质量、复用、类型、审批和激活检查。

本文件交付的是设计；下面的接口、字段、状态和验收要求均是拟议契约，不代表已实现。

## 2. 成功标准与范围

正常路径：

```text
Owner 提交反馈
  → 明确来源及真实会话关联
  → 后台诊断
  → 准入判定并保存处置
  → 复用判断 / 支持类型的候选收编
  → 已支持的内部化与验证步骤
  → Owner 审阅
  → 只有 Owner 明确决定后才批准、激活
```

“正常工作”不要求每条反馈都生成新原则，也不要求每种候选都进入 Principle Ledger。合理终态还包括补证、复用待审、非支持类型、延期、拒绝和归档；这些终态必须可查且解释准确。**正常正向样例必须实际到达 Owner 审阅入口；仅显示 blocked/unsupported 不算正向验收成功。**

“不再挂起”定义为：在 PD 已启用、真实 worker 持续运行、声明支持的渠道及 provider 可用的条件下，已接收且满足准入的信号最终到达可审阅结果，不依赖人工 intake/backfill 或重新提交；中断后由 worker 自动恢复。外部服务永久不可用、机器关机和 Owner 主动暂停不可能保证成功，但必须成为明确、有界、可恢复的阻碍，不能无期限假称正在处理。

包括：Codex 执行结果适配、明确手动反馈、共享准入与持久化、相关 CLI/Console 展示、既有后台链的联调验收，以及针对原问题的有界恢复设计。

不包括：一般任务执行、自动工具重试、全会话默认采集、原则自动批准/激活、通用记忆、新调度器、重新设计 PD v2/ADR、开放未支持的 Codex 治理通道、批量清理历史记录。无关 UI 整理和工作区其他修改不得进入实现。

## 3. 已验证事实与尚未证明的事项

### 3.1 已验证

- 本次诊断主任务和三个阶段全部 succeeded，生成三个 pending 候选；实际停止于收编前的准入。
- 原始命令结果含 `degraded`、`needs_evidence/input_evidence_empty`，没有 Ledger 条目和后续内部化任务。
- PD 轨迹库把部分真实失败命令记录为 success/exit_code=0。已按完整命令匹配失败测试样例，而非只凭文本猜测。
- 已安装公开纯函数对字符串失败输出、`{exit_code:1}` 都返回 failure=false/exitCode=0；对 `{exitCode:1}` 返回失败。
- 本次 Codex CLI 只读取轨迹库的失败工具行；`reason` 是诊断上下文，不计入输入轨迹证据。
- 完整准入检查空输入证据；CLI candidate 部分检查不复查输入/输出证据，因此真实候选在两条路径上得到相反结果。
- OpenClaw 的一个手动入口传递 `correctionEvidence`。这不证明所有 OpenClaw 入口相同，也不证明其全部 pending 候选具有相同原因。

### 3.2 不得当作已证明

- 历史每条漏记对应的原始 PostToolUse stdin 形状尚未捕获。
- “轨迹库全部 success”不能推出宿主实际全部成功。
- 历史 consumed 时间差不能证明手工或自动调用。
- 修复工具结果记录不能证明 Owner 所指出的行为错误，也不能保证所有下游阶段成功。
- 单独看到 peer agent `enabled=false` 不能推出后台全链停机，必须看实际 consumer 开关及执行报告。

### 3.3 v0.2 自评发现的生产断点（代码已核对，尚未运行故障注入）

- `internalization/diag-router-runner.ts:366-377` 先提交诊断并标记任务 succeeded，bridge 随后才执行 `onDiagnosisComplete`；两者之间退出会丢失后处理推进。
- `worker/workspace-worker.ts:117-127` 只选择 pending/retry_wait 的诊断任务；`pain-signal-bridge.ts:738-740` 对 succeeded 返回 existing result，不能证明续接。
- `pain-signal-bridge.ts:859-871` 对 intake 异常仅记录 telemetry 并跳过；任务已 succeeded，候选可能长期 pending。
- `pain-signal-bridge.ts:980-992` 在 seed 失败后仍可能把候选标 consumed；消费状态不能证明有后续任务。
- `pd codex worker --status` 的 ready 计算不执行周期，不检测实际消费；Companion 不读取 worker stdout 的周期报告。注册/配置就绪不能作为活性证明。
- v0.1 的新 CLI 参数没有连接 Codex 实际触发入口、宿主 lineage 获取或安装交付；参数存在不等于用户反馈会被提交。

这些是 v0.2 的必修范围，不允许归为仅改善展示的后续工作。

## 4. 现有实现映射与最小缺口

| 责任 | 当前实现定位 | 最小修复 |
| --- | --- | --- |
| Codex 输入适配 | `packages/codex-adapter/src/codec/input-decoder.ts` | 把已验证的宿主执行事实准确传到既有共享处理路径 |
| 工具结果归类与轨迹写入 | `packages/host-runtime/src/production-pain-evidence.ts` | 成功/失败/未知不混淆；保留原始来源与归类原因 |
| transcript 工具事实 | `packages/codex-adapter/src/ingestion/transcript-decoder.ts`、`ingestion/admission.ts` | 保持 consent 边界；不把自动痛苦准入等同于所有工具结果可观察性 |
| CLI 取证与报告 | `packages/pd-cli/src/commands/build-trajectory-evidence.ts`、`pain-record.ts` | 保留失败工具取证，另接明确 Owner 陈述 |
| 入口与诊断上下文 | `packages/principles-core/src/runtime-v2/pain-ingress-payload.ts`、`pain-signal-bridge.ts` | 复用 correctionEvidence；区分陈述、轨迹和模型输出 |
| 准入 | `packages/principles-core/src/runtime-v2/admission-gate.ts` | 同一完整检查决定自动/手动写入资格 |
| 候选权威 | `packages/principles-core/src/runtime-v2/store/candidate/` | 候选行保存当前准入处置，读取侧仅投影 |
| 手动收编及复用 | `packages/pd-cli/src/commands/candidate.ts`、`services/reuse-gated-intake.ts` | 删除部分检查被当作完整许可的语义；保留 reuse gate |
| 后台执行 | `packages/codex-adapter/src/worker/workspace-worker.ts`、`packages/host-runtime/src/internalization-consumer-cycle.ts`、Companion 已有 worker | 验证现有 wiring，不增调度器 |

以上是导航，不是固定修改清单。实施须查看 exports、所有生产消费者、现有测试及迁移；发现现有能力已经满足要求时，优先补连接而不是创建新抽象。

## 5. 执行结果契约（CR-01）

### 5.1 三种结果

工具执行结果须明确区分 success、failure、unknown：

- success：有当前工具契约认可的成功事实。
- failure：有当前工具契约认可的失败事实，例如已验证的非零进程退出码。
- unknown：工具只返回文本、缺失结束信息、仍在执行、字段格式错误或无法确认结果。

缺失退出码不得变成 exitCode=0；未知不得计入成功或失败证据。已有 `tool_calls` 中记录未知时使用 `outcome='unknown'`、`exit_code=NULL`，并携带有界结构化原因；所有读取该 outcome 的消费者必须理解新值。此为拟议共享契约变更，不得仅修改写入方。

并非所有工具都有进程退出码。成功的结构化读取工具不得因为没有退出码被一律归为未知；判据遵循宿主及工具的已验证语义。MCP 的工具错误、shell 进程失败、PD Hook 自身 fail-open 退出是不同事实，不得混用。

### 5.2 来源与结束时点

宿主特定字段转换位于 Codex adapter；共享 host-runtime 继续拥有共用归类及写入责任。不得在各消费者复制解析器。

先用当前 Codex 的真实成功/失败/运行中 Hook 样本确认结构。已认可字段须验证类型、范围及结束状态；矛盾字段不得静默挑一个。文本出现 failed、error 或 success 不足以判定结果。

若 Hook 只有文本，明确返回未知。只有在既有授权允许时，才可利用已有宿主工具事实读取路径获得最终结果；不得借本次修复绕过 conversation ingestion 的 consent 开关或扫描整段用户对话。

不得把工具失败自动升级成 Owner 行为痛苦。已有自动触发阈值、写工具边界和 cooldown 保持原有责任；“记录执行结果”和“自动创建痛苦”必须区分。

验收必须证明当前 Codex 的真实失败能够被准确记录并被 CLI 取证。若现有授权下无法获得失败事实，仅能交付 unknown，则 CR-01 为 PARTIAL，不能宣布修复完成；须先提交最小授权/契约阻碍供 Owner 判断。

## 6. 明确 Owner 陈述契约（CR-02）

### 6.1 明确输入，禁止推断

扩展既有 `pd pain record` 的注册及处理，拟议参数 `--owner-statement <text>` 单独承载 Owner 明确要求记录的反馈。不是自动把 `--reason` 复制到 evidence。

- `reason` 继续作为报告摘要，可以由 AI 起草。
- `owner-statement` 是 Owner 明确提交或明确授权代理原样转交的文本；AI 推断、改写总结、诊断结论都不能冒充原话。
- CLI 参数是明确报告渠道，不是密码学身份认证；产品必须披露其“经 CLI 显式提交”的来源，不能夸大成独立认证。
- AI 只有在已获得明确转交授权时可使用该参数；仅有 `source=manual`、`origin=owner_manual` 或模型自称得到授权，都不足以凭空生成原话。
- Codex 的 session、rollout identity、host turn、logical observation key 保持真实且一致。不得去掉 lineage 或伪装成 unbound 来绕开检查。

验证：文本非空、字符上限沿用当前明确手动输入的 500 字符限制；超长拒绝而非截断 Owner 意图。对存储、日志及展示沿用现有敏感信息保护与边界；受保护内容需标记处理，不声称未经处理的原文仍完整可见。

### 6.2 存储与证据语义

复用已有 `correctionEvidence` 持久化路径作为文本唯一权威，不另建 Owner 反馈库。扩展其校验和来源元数据以表示 explicit submission；入口、诊断输入、重入和 retry 验证保持同样严格。

这份材料分类为 **owner_statement / Owner 陈述**，不是 behavior_trace、system_event 或 verified fact。诊断须披露“陈述未经独立验证”，并可建议补证、延期或拒绝。

保持 `evidence[]` 的轨迹/系统事件语义，不为凑数量加入伪轨迹。Owner 陈述存在时，仅改变空输入依据检查；置信度阈值、诊断输出证据有效性、推荐类型、reuse gate、审批及激活规则不降低。

诊断引用 Owner 陈述须关联对应 pain 和陈述内容版本；不得把无关 session 的陈述接到候选上。模型引用不能替代陈述本身，模型产生“证据”不得反向证明输入材料存在。

### 6.3 与既有契约的关系

本条是对 `docs/superpowers/specs/2026-09-01-pain-evidence-ingress-contract-spec.md` §7.4/§8.1 中“reason 不等于轨迹证据”的明确补充，并保留原规定：reason 本身仍不能被塞入 entries。

审批本 SPEC 前此调整不生效。实施必须同步入口 payload 校验、上下文读取、retry/恢复消费者、CLI 和相关行为文档；不得悄悄把所有历史 manual 信号解释成 Owner 陈述。OpenClaw 现有行为作兼容性回归，不自动扩大其授权范围。

### 6.4 Codex 中实际可触发的入口（CR-07）

主入口采用一个可确定解析的明确用户请求：在 Codex 当前消息中输入 `PD记录痛苦：<反馈原文>`。这是本 SPEC 拟定义的普通消息前缀，不冒充 Codex 已有 slash command。该前缀本身表达仅记录冒号后这段文本的授权；不授权读取其他消息。

复用已存在的 UserPromptSubmit → before_prompt_build Hook：

1. Codex adapter 只对当前 prompt 开头的准确前缀进行确定性解析，提取非空反馈；普通纠错、引用中的前缀、工具输出或模型自述不触发明确提交。
2. 使用本次 Hook 已验证的 session_id、turn_id；rollout identity 来自同一 raw payload 的 transcript_path 经现有 validateCodexTranscriptPath/CODEX_HOME 边界校验，不读取其对话内容。transcript_path=null 或校验失败时拒绝，不搜索其他文件。通过现有共享 PainToPrincipleService.recordPain(asyncMode=true) → createPainSignalBridge → PainSignalBridge.submitPainSignal 持久入队并产生回执；这些API确已存在，但明确Hook入口连接与去重需要本次实现。不让模型猜 ID或选择“最新”文件。
3. 当前文本按 §6.1/6.2 保存为明确 Owner 陈述；这是该消息的显式授权渠道，与默认全对话 ingestion 分开。ingestion flag 关闭时仍不读取对话表或 transcript，不以关闭它作为拒绝这次明确提交的理由。
4. 同一宿主观察键 `codex|<rolloutIdentity>|<hostTurnId>|user` 必须映射同一 canonical pain；Hook 重放、模型随后调用 CLI、通用纠正检测和重启均不得把同一明确报告创建成两条痛苦。复用既有 governance_signal_admissions 的唯一 observation-key→canonical_pain_id 登记及任务续接责任，由 host-runtime 原子认领登记并保留可重放的已校验提交材料；CLI回读/复用登记ID，不无条件生成第二个随机manual ID。明确入口须在通用纠正检测前识别，同一事件不同时经过两位pain写者。

   登记在trajectory.db、诊断任务在state.db，不假设跨库单事务；复用既有 ensure/reconcile continuation：登记成功但task尚未创建时，worker按登记材料幂等补建；task已创建但登记链接未写时，按同一canonical pain/task key补链接。回执必须区分登记、任务持久化和后台执行，禁止凭任一写成功假称全步骤已完成。用于重放的提交快照是输入事实的不可变副本，不是第二个可变Owner陈述权威。
5. Hook 内不运行 LLM，不等待完整诊断；只在持久化成功后返回包含 painId/taskId 的已接收回执。后台不可用或主动暂停时回执明确表示已保存但无法自动推进，不回复正在诊断。
6. CLI `--owner-statement` 是明确 operator/恢复入口，不能作为本次用户入口的唯一交付。默认 CLI 同步、启用 async、`--wait` 的现有区别保持，并分别测试。

安装包中须交付该入口说明及可用的 PD 痛苦反馈 skill/模板；用户不需要抄 session/turn ID、开终端或人工 intake。自然语言泛化及未经明确授权的自动提交不在本次范围。不能只修改 OpenClaw 模板而未交付当前 Codex 实际使用的插件渠道。

缺失或矛盾宿主 lineage 时在变更前拒绝并明确原因，不临时转成另一个宿主或 unbound。若当前 Codex 版本不支持声明的 Hook，必须解决兼容交付或停止发布正常工作的结论；不得将 unsupported 当主入口验收通过。

无前缀 `pd pain explicit` bridge 的当前 turn 上下文按 Hook payload 的 `session_id` 分区保存，文件名只含该 session id 的 SHA-256 摘要。Hook 写入/清理以该事件 payload 的 session 身份为准；Stop 只清理 session 与 turn 均匹配的上下文，SessionStart 只清理自身 session。CLI 回读必须以宿主提供的 `CODEX_SESSION_ID` 选择分区；环境缺失，或同时提供的 `CODEX_THREAD_ID` 与之冲突时拒绝，不能读“最近文件”或接受模型传入的 lineage。写新上下文失败时必须尝试撤回本 session 旧上下文并披露撤回失败。文件仍只含 lineage 与路径，不保存 prompt 或 transcript 内容。

## 7. 准入统一及持久化（CR-03）

### 7.1 权威与数据

准入处置归属既有 candidate store，拟新增 `principle_candidates.admission_json` 可空、带 schema version 的字段；内部包含不可变的 evaluations 历史、currentEvaluationId 指针及独立可变的 processing 域。不是审批事实，不替代 Ledger/approval/activation 权威。Telemetry 和 Console 只读该事实，不建立第二处可写权威。

每条处置至少包含：candidateId、sourcePainId、sourceRunId、artifactId、decision、reason、nextAction、evaluatedAt、policyVersion、输入材料/诊断内容的 fingerprint，以及材料分类摘要。不要在该字段复制完整 Owner 文本。

同一材料fingerprint/sourceRunId/policyVersion的重复评估幂等复用既有evaluation；确有新材料/策略的重评追加新版本、更新currentEvaluationId，不覆盖旧decision/reason/evaluatedAt。保留历史可按版本查询；processing重试只能改变进度域，不得篡改准入历史。字段修改走同一个store/CAS权威并做大小/类型守卫，日志和CLI预览有界，超限不能默默截去历史。

共享完整 evaluator 同时供自动收编和 CLI 使用：

1. 从权威关联解析真实诊断输入、输出和原始推荐类型。
2. 校验 lineage、材料版本及置信度，运行同一准入策略。
3. 保存处置成功后，才允许对应版本候选进入 intake。

写处置失败：本轮不得写 Ledger、标 consumed 或 seed 后续任务，返回 `admission_persistence_failed` 与 nextAction；诊断已成功的事实仍保持 succeeded。

拒绝准入允许写“拒绝处置”这一观察事实，但禁止治理变更。这里须区分审计记录与 Ledger/approval/activation，不能把拒绝路径概括为完全零写入。

### 7.2 所有写入路径一致

`candidate intake`、repair/backfill、diagnose、pain retry、worker 的候选推进路径必须遵守相同完整判据。现有 CLI 部分检查可保留为前置快速拒绝，但不得作为最终写入许可。

手动命令、dry-run 或高置信度不豁免证据检查。`--force` 若存在，仍不可覆盖完整准入、类型、复用、审批和激活边界。

读命令不写处置、不调用 LLM。dry-run 可用当前权威材料计算预览，必须明确“本次预览判定”和评估依据；不得冒充历史处置或已经持久化的决定。

旧记录 `admission_json=NULL` 显示“历史准入处置未记录”。它不等于已接收，也不等于历史曾被某原因拒绝。真实变更命令执行前可完整重评并保存当前结果；材料不可解析则拒绝并指明缺失项，禁止默认放行。

### 7.3 重入、并发、崩溃

评估与写入许可绑定候选材料 fingerprint。intake 前材料变化时重新评估或拒绝，禁止使用旧 admitted 放行新内容。

并发状态更新使用现有原子转移/CAS 和幂等机制。保存 admitted 后崩溃不等于 consumed；重试必须检查已有 Ledger 结果及 seeded task，避免重复写入。候选不能因另一条候选已收编而被误标 consumed。

准入与后处理进度是两个不同维度。`admission_json` 可携带独立的 processing 子域记录续接的最近失败、尝试次数、nextRetryAt 和完成标记；不把 intake/seed 失败改成准入拒绝。诊断级无候选/材料损坏阻碍记在已有父任务的有版本元数据中，不能伪造候选。材料 fingerprint 只由真实输入/输出内容计算，不包含可变化的 processing 元数据。

只允许原始类型恰为 principle 的候选进入 Principle Ledger；unknown/缺失类型 fail closed，rule/prompt 使用既有支持路由或显示 not_internalizable。禁止通过显示层的类型兜底提升写权限。

## 8. Owner 可见状态及返回值（CR-04）

显示状态是既有任务、候选、准入、审批与激活事实的投影，不新增独立痛苦状态机。

| 显示状态 | 必须有的事实 | 用户看到的下一步 |
| --- | --- | --- |
| 已接收 / 排队中 | 接收与任务已持久化，但未开始执行 | 后台状态或明确 worker 阻碍 |
| 正在诊断 | 实际运行中的诊断任务 | 诊断任务及最后更新时间 |
| 诊断完成，等待补证 | 诊断成功、当前处置 needs_evidence | 缺少什么、通过哪个既有入口提交 |
| 等待复用决定 | 既有 reuse gate 已 park | Owner 选择复用或新建 |
| 后台处理中 | 有已 seed 的支持类型内部化任务 | 当前阶段、失败/暂停原因 |
| 等待 Owner 审阅 | 既有审阅所需工件及审批事实就绪 | 打开审阅入口 |
| 暂停 / 不支持 / 失败 | 对应结构化阻碍 | 可执行 nextAction，不给无任务的空转命令 |
| 已激活 | 对应真实 Owner 决定及已生效激活事实 | 查看作用范围和撤回方式 |

混合批次逐候选展示，不因一条成功隐藏另一条补证。部分检查、材料未知、证据处理过的情况明确披露。

`--json` stdout 仅一个合法机器结果；warnings 不破坏纯 JSON。沿用既有状态与退出码约定，不把 degraded 改成 succeeded 来改善体验。

提交反馈的 AI 应根据结果中的最远阶段和每条候选处置回复。异步 enqueue 只能说已接收/排队；明确 blocked 或终态后不得说仍在诊断。纯结构化结果验收与真实 AI 回复验收分别报告，不能以前者证明后者。

## 9. 后台链及能力边界（CR-05）

复用已有 Companion workspace 注册、Codex worker 与 shared consumer。验证实际配置和运行报告，不能只看进程存在或 tasks 行数。

验收工作区声明明确的真实 provider/profile 和已支持渠道。正常执行按现有 `internalization_auto_consumer` 与 `internalization_full_chain` 机制处理；不得无说明地把全部 peer agent enabled 改成 true。

provider 失败、worker 暂停、能力不支持必须可查。worker 重启后恢复已持久化的可执行任务；不额外建立通用重试/调度系统。

### 9.1 诊断后处理必须被真实 worker 消费

在现有 workspace worker 周期内增加有界诊断后处理续接，复用 candidate store、既有 reconciliation_cursor 和共享完整处理入口，不创建新后台进程或通用任务系统。

扫描的不只是 pending/retry_wait 诊断任务，还包括：

- 已 committed/succeeded 的诊断，其候选尚未完成准入/收编/路由；
- 已保存 admitted、但 intake 因异常未完成；
- 已有 Ledger 或已 consumed，但缺少其支持渠道应有的后续 task；
- 已创建后续 task，但状态/关联写入中断。

输入取已提交的诊断/候选与持久化材料，续接不得为修复后处理重新调用诊断 LLM。完成、等待 Owner、明确拒绝、unsupported 和已耗尽重试记录不持续空转；只有输入版本变化或明确恢复授权才重新判断其受阻步骤。

续接入口与 fresh path 使用同一完整准入、reuse gate、类型路由、intake/seed 幂等机制。不能直接调用仅拼 existing result 的读取路径冒充恢复。只读状态/CLI 不执行该续接。

每周期有固定小预算，复用既有游标公平扫描，持续诊断 backlog 不得饿死续接。pending诊断、到期retry诊断、诊断后处理三类工作，每个持续eligible的类别必须在最多3个完整周期内获得一次执行机会；类内按稳定最老顺序推进，新增任务不得持续插队。类别服务游标/扫描游标通过现有reconciliation_cursor保存，重启不重置为永久优先pending；并发仍由现有lease/CAS仲裁。这里的完整周期计数排除正在执行的有界阶段及Owner主动暂停，墙钟时间还须加有效执行deadline，不假设周期耗时为零。

对 eligible orphan 必须给出本周期处理数、remaining count、最老年龄和材料关联；旧 consumed 也参与检测。seed 失败不能被 consumed 隐藏，也不能因为 candidate consumed 就跳过恢复。

一条候选后处理完成的判据是：准入拒绝/Owner 等待等有已保存处置，或其支持路由要求的真实写入及后续 task 链接已经存在。不用 consumed、telemetry、进程退出码或单条 report 的 succeeded 代替这些事实。

### 9.2 有界失败与调度公平性

复用已存在的 timeout、lease、retry/backoff/maxAttempts，并为后处理异常持久化独立的有限续接计数；默认最多 3 次自动后处理尝试，不能消耗/重置已成功诊断的 attemptCount。短暂持久化/intake/seed 故障可恢复；坏材料、无法解析 lineage 等确定无效输入不得每周期无限 pending。

重试耗尽明确进入 manual_action_required/failed 的可读阻碍并保留事实；不靠重置预算来反复重跑。Owner 主动暂停不是失败，不消耗重试预算。等待补证/复用决定不是技术 retry，禁止循环请求 LLM。

如果连阻碍状态都无法持久化，报告独立的 workspace storage degradation，停止该工作区治理写入，不能只在 stdout 打印后继续假称正常。基础设施恢复后扫描重新接起；无法读到事实时不得宣布该信号完成。

有界候选选择须覆盖 pending 与已到期 retry_wait，避免持续 pending 让重试任务长期得不到执行。复用现有公平选择/游标；不得靠提高单周期限额掩盖饥饿。

### 9.3 活性与时间契约（CR-08）

分开报告配置/注册 readiness 与真实 execution liveness。复用 Companion 监督及既有状态/日志持久化渠道，记录 worker 最近周期开始/完成、正在运行的阶段、deadline、最近进展及 restart budget。不能新建独立 heartbeat daemon。

默认 worker 轮询间隔为 120 秒。无 backlog 的就绪验收：持久接收后至开始实际诊断不超过两个完整轮询机会（默认 240 秒，另加被报告的当前正在执行步骤剩余上限）。Hook 持久回执验收为 5 秒内、provider 调用数为 0；模型最终回复时延与 Hook 回执分开报告。

全流程上限由本次真实配置计算并展示：各阶段有效 timeout × 有限尝试预算 + backoff 上界 + worker 排队周期上界。必须使用已 seed 拓扑而非假定所有候选走相同全链；不得硬编码“几分钟一定完成”。有 backlog 时展示排队位置/最老年龄、下次可执行时间，并验证有限到达队列能够收敛。持续过载须明确显示 capacity/backlog 阻碍，不能伪称有固定全链完成时间。

运行阶段不得超过有效 deadline 后仍无界等待；无运行阶段时，若超过两个轮询窗口未出现 cycle/推进证据，显示 worker 未运行或周期失败，而非正在诊断。机器关闭/Companion 未启动期间不声称后台能推进；重新启动后必须从持久事实继续。

Companion 子进程重启预算耗尽后显示真实恢复入口；注册工作区、进程存在或 `--status mode=ready` 单独都不是活性证据。错误通知只在有意义的状态变化时发生，不每周期打扰 Owner。

自动推进的边界是 Owner 审阅；不得自动批准、激活、写 Owner Outcome 或宣称行为改善已获证明。模型提出的治理方案仍是待审建议。

## 10. 历史数据与原问题恢复（CR-06）

默认不修改历史工具成功记录，不对全部历史 manual 信号补造 Owner 陈述，不删除或归档治理资产。

原问题可先完整重评以恢复可观察性；当前输入为空且无明确陈述的情况下，正确结果仍是补证，而非假称已修复内容。

如 Owner 决定恢复原信号，应通过既有 `pd pain retry` 的有界扩展提交明确 Owner 陈述：拟增加与 record 一致的陈述输入以及 dry-run/确认恢复语义。这些参数尚未存在完整实现，不是现在可执行的操作说明。

恢复契约：

1. 保留 canonical painId 与真实 Codex lineage，不通过新建无关 pain 绕过历史记录。
2. dry-run 列出将引用/新增的诊断尝试、候选、Ledger 和 task；本步骤零治理变更。
3. 实际执行保留旧诊断/工件/处置，不把新评估冒充提交当时的处置；采用已有 run/attempt 血缘记录新尝试。
4. 相同恢复请求重复执行不重复 Ledger、审批或 seed；不得用任意 force 绕过准入。
5. 没有经过验证的同 pain 重试/幂等语义时，返回 unsupported，不临时拼第二套恢复服务。
6. 运行前按既有守则备份；恢复只能由授权的运行时命令执行。AI 不直接编辑 `.pd` 或安装文件。

历史失败纠正若需要读取宿主材料，须有来源、授权和版本的可追溯证据；不是本 SPEC 的自动批量迁移。新信号路径可先验收，但历史恢复未验收须明确写 PARTIAL。

## 11. 验收矩阵

| ID | 场景与目的 | 必须通过的观察 |
| --- | --- | --- |
| A01 | 实际 Codex 成功/非零退出，防止误记 | 同一 tool identity 的 PD 结果与宿主相符；失败可被 CLI 读取 |
| A02 | 文本、缺字段、运行中、错误类型、矛盾结果 | 未知不变成功，不产生假失败；有 reason/nextAction |
| A03 | 成功工具 + Owner 明确陈述行为错误（正常正向） | 从实际 Codex 用户入口提交，正确陈述及 lineage，无人工 intake/backfill，实际到达支持渠道的 Owner 审阅入口；补证/拒绝/unsupported 不能代替该正向成功 |
| A04 | 仅 AI 起草 reason，无陈述且无轨迹 | 不伪造陈述，完整准入仍补证 |
| A05 | 自动空证据 / 低置信度 / 无效输出证据 | 不降低既有门禁；不写 Ledger、不 seed |
| A06 | session/turn/pain/陈述版本不一致 | 变更前拒绝；不得借观测写入自行证明关联 |
| A07 | 自动拒绝后 CLI route/review/intake/dry-run | 同一材料得到一致完整判断；预览不假称历史或已写结果 |
| A08 | 旧候选无处置字段、材料缺失或坏 JSON | 旧库可读；未知不放行，不自动回填历史原因 |
| A09 | 诊断已成功后各后处理边界故障 / 并发材料变化 | 对诊断 commit 后、admission 写入前后、Ledger 写入后、seed 前后、consumed 写入前后逐点中断，重启真实 worker 自动续接；诊断 LLM 不重复，无重复 Ledger/seed，无陈旧准入放行 |
| A10 | kind=rule/prompt/defer/unknown + reuse park | 既有类型与复用边界保持；不会三个都强行入 Ledger |
| A11 | 正常真实 provider + Companion worker | 经 installer/插件实际入口→manifest注册→Companion spawn→真实消费→实际审阅入口；默认同步 CLI、async CLI、--wait 和 Hook 入队分别验证；保留 Owner 人工门 |
| A12 | worker 关闭、provider 失败、渠道不支持 | 显示真实阻碍，不无限声称正在诊断；不提前批准/激活 |
| A13 | dry-run、JSON、process.exit 被 stub、恢复重复执行 | 真实 Commander 注册测试；失败停控制流；dry-run 零治理变更 |
| A14 | OpenClaw 与 unbound CLI 回归 | 当前授权及合法入口兼容；既有反馈及类型路由不误改 |
| A15 | 原信号的授权恢复 | 保留历史、同 pain 血缘、完整准入、幂等及可查处置；旧evaluation仍可读，current指向新版本，processing不覆盖decision；不自动激活 |
| A16 | 实际提交反馈后 AI 回复 | 回复准确区分接收、诊断、补证和待审；与机器结果一致 |
| A17 | 显式前缀、普通纠错、引用/模型文本、重复 Hook | 只认可当前用户明确请求；同宿主观察键只一条 canonical pain；无需用户填写 lineage；ingestion off 不读整段对话 |
| A18 | intake 暂时失败 / consumed 但 seed 缺失 | 自动续接并最终到真实审阅入口；重复恢复无重复事实，不能靠手动 backfill 使测试通过 |
| A19 | 无效重入材料 / provider长期失败 / 后处理预算耗尽 | 坏材料不无限 pending；有限 retry 后稳定显式阻碍，nextAction可执行；不重置预算，不把暂停算失败 |
| A20 | worker未启动/崩溃/预算耗尽、只有ready状态 | readiness 不冒充 liveness；真实周期/推进时间可查；重启后既有信号继续；有效deadline内且长于240秒的运行阶段不被误报停滞 |
| A21 | 持续pending与到期retry同时存在、续接backlog | 持续注入pending并放入due retry和orphan，跨worker重启，每个eligible类别最多3个完整周期得到服务；记录实际游标与队列事实，有限队列最终收敛 |
| A22 | 正向样例全流程时间和当前配置 | Hook回执、启动、各阶段deadline及实际拓扑完成时间均满足§9.3；不靠provider调用一直未结束掩盖挂起 |

测试分层：validator/纯逻辑 → SQLite round-trip/migration → 真实 CLI parser → adapter/worker 生产路径 → 真实 Codex 与 OpenClaw 回归。Owner 可见场景须检查相关 `.feature` 并增加/执行对应 BDD；不得删场景或降低期望。

回归负向控制至少覆盖原问题两类：旧归类器把真实失败记成功；旧部分门禁与完整门禁不一致。禁止仅验证 helper 自己返回的形状。

实现前执行 error:context plan mode，最终 diff 再执行 diff mode。已路由 EP-03/EP-04（HIGH）、EP-02（MEDIUM）、EP-06（LOW）；语义上追加 EP-01 信任边界和 EP-09 有效验证要求。将相关 Required Evidence 对应到上述验收，不为了流程数量制造 ERR。

发布前跑相关包/消费者测试及 `npm run verify:merge`，记录实际输出。真实宿主与模型行为验收单列；未执行、失败、unsupported 均明确报告，不用机器测试绿代替已安装宿主证据。

**发布“Codex 痛苦正常工作”的硬条件：A01、A03、A09、A11、A17、A18、A20、A22 在已安装目标版本真实 Codex/Companion 路径执行通过，并有可重跑证据。** 故障注入在隔离验收工作区/既有可注入边界进行，不破坏生产治理数据。支持prompt渠道至少一个正向样例通过；不以仅到candidate/仅seed task/测试替身审阅队列替代。缺项或失败时标 PARTIAL，不发布完整修复结论。

报告需关联 painId、候选、诊断源run、准入材料版本、真实后续任务、审阅工件/审批入口、worker周期时间和安装sourceCommit；读取数据库关联事实，而非只收集截图或report。负向样例可到拒绝/等待状态，正向样例必须完成。

## 12. 交付顺序、发布和回滚

建议三段交付，始终保持同一个 SPEC 的验收索引：

1. 执行事实修复及兼容迁移：CR-01；先闭合真实失败样例。
2. 准入持久化与显示统一：CR-03/04；对应 PRI-958，不在这段扩大证据许可。
3. Owner 陈述、已安装Codex入口、worker后处理续接、活性及恢复验收：CR-02/05/06/07/08；须获得本 SPEC 对陈述边界的明确批准。入口和续接是该段必交付，不可拆成日后follow-up。

不同段独立审阅和验证，不宣称前两段已解决所有手动反馈。实现前搜索同类 Linear 票并沿既有 workflow 关联，中文记录；不凭本 SPEC 自动创建或更新外部票。

仓库编辑→构建/检查→正常发布/installer 更新→核对安装 sourceCommit→真实宿主验收。禁止补丁式修改 `~/.pd/runtime`、OpenClaw 安装目录或 `<workspace>/.pd` 文件。

schema 为加法迁移：保留旧任务、候选、工件、审批和激活。旧版本可能不能理解 unknown/admission_json；因此不能未经 round-trip 验证直接降级二进制。回滚路径是安装已验证兼容版本、保留新增数据；必要时在更新前用已有 consumer 控制暂停执行，不新建 feature flag。Owner 陈述授权若撤回，通过回滚相应入口/策略停止新使用，历史事实不物理删除。

## 13. Complexity Delta 与 MVP 问题

| 项目 | 拟议变化 |
| --- | --- |
| 新的独立 durable source of truth | NO；准入处置由现有 candidate store 唯一拥有。增加一项此前未持久化的事实，不另建同事实权威 |
| 新 persisted schema/state | YES；candidate admission_json（含独立processing子域）、Owner 陈述来源元数据、unknown outcome及既有父任务中的诊断级阻碍/进展。既有字段不能表达这些事实；按迁移/round-trip/旧记录验收，兼容回滚保留数据 |
| 新 subsystem/service/background process | NO；复用 bridge、store、worker、consumer |
| 新 public abstraction/interface | YES（既有契约扩展）；结果/候选/陈述、明确Hook入口及后台续接须让真实消费者理解，不新建 provider 或 registry；生产路径与消费者测试验证 |
| 新 runtime feature flag | NO；现有 consumer/回滚机制足够 |
| 新 cross-package dependency | NO；保持既有 core→adapter 依赖方向约束 |
| 新 host/platform-specific behavior | YES（既有 Codex adapter 修复）；封装宿主事实转换，避免共享模块解析宿主专用包；真实宿主 fixture/smoke 验证，可独立回滚 adapter |
| 新 external/network capability | NO；使用现有 provider/installer，不扩大对话读取许可 |

接口增量隐藏的是材料解析、lineage 校验及同一完整判定，不让每个 CLI/Console 自行拼装另一套门禁。没有新的变化轴，不创建通用证据框架。

- `mvp-q-1-what-if-skip`：失败会继续被记成功，明确反馈可能长期停在不可解释的 pending，Owner 要重复调查和手工干预。
- `mvp-q-2-how-observed`：真实 Codex 结果、候选处置、控制台下一步及可审阅工件是观察路径；业务改善不是本次工程验收结论。
- `mvp-q-3-how-disabled`：使用现有 consumer 控制及兼容 installer 回滚，保留治理资产，不新增旗标。
- `mvp-q-4-emotional-value`：减少反复报告和猜测处理状态的负担；让 Owner 能看见反馈被怎样处理，并保留决策控制。此为设计目标，不能当作已测得的情绪改善。

## 14. 实施停止条件与 Owner 决策

以下任一成立时停止依赖该假设的实施并提交具体证据，不自行扩大范围：

- 无法在当前授权下获取真实 Codex 执行终态。
- 陈述来源只能由 AI 猜测，无法做到明确提交及诚实披露。
- 单一候选处置与跨包消费者无法一致，或迁移破坏旧库读取。
- 恢复原问题需要直接改运行目录、伪造历史或绕过既有审批。
- 目标渠道在 Codex 不支持，却需要新增架构才能满足。

Owner 审阅内容：是否批准 CR-02 的“明确陈述可满足输入依据条件”；是否接受三段交付与上述严格验收。审阅本文件不等于批准任何候选原则或激活，也不等于已经执行历史恢复。

文档检查、测试、构建、安装、真实宿主流程和后续行为改善分别报告。此次 v0.2 仅修订 SPEC，未实施、未恢复原信号、未批准或激活新原则。新增CR-07/08及§9的连接修复也是待审设计，不把自评通过等同于运行验收通过。
