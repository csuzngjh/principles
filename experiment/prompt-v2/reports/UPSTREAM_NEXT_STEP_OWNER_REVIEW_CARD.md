# UPSTREAM_NEXT_STEP_OWNER_REVIEW_CARD.md — Phase 6 最终 Owner 决策卡（2026-11-15）

依据：本轮六项调查（Ledger 源码+演练、三 Agent 提示词提取、14 Pain 全量真实输出审计、联合根因分析），全部基于源码 `161763546` 与冻结实验/生产只读数据；无模型调用、无生产写入、无代码改动。

## A. Ledger（Principle Ledger 去重能力）

| 问题 | 回答（证据） |
|---|---|
| 能否拦截完全重复的原则？ | **候选级：能**（同 candidateId 重放实测 `written:false`，T0）。**跨候选逐字文本：写层不能**（T1 双变体均注册成功）；检索半场能标记（1.0）但拦截依赖 LLM 评估+Owner |
| 能否拦截语义近似的原则？ | **部分**——词法 bigram≥0.15 才可见（真实跨链重复 T2=0.3265 可见）；低于阈值结构性失明（跨 Pain 家族实测 0 分）；可见后依赖评估（不可用即 Rule 4 放行） |
| 会否误拦截真正不同的原则？ | **实测未见**（T3/T5 互补机制 0 分共存；机器从不自动合并——reuse 一律挂起等 Owner） |
| 是否需要进一步开发？ | **是**（若要闭环）：缺口=①写层零文本查重；②评估不可用时的 Rule-4 放行；③跨 Pain 词法盲区；④冲突识别缺失（`conflictsWithPrincipleIds` 无自动写者）。属代码/SPEC 级改动，非提示词级 |
| 当前是否存在原则重复进入系统的实际风险？ | **是——已实际发生**：生产 Ledger 近逐字重复对 `946754bf`(active)/`26858b6f`(candidate) 于 2026-11-11（门启用后）先后注册（互分 0.6842）；另有交付验证族/证据族等多个语义家族并存。对照面：门也真实成功拦截过 3 次（reuseEvidence 落账：3824d083/96608bec×2，含"Gate挂起后Owner裁决复用"原文） |

总判定：**PARTIAL_SUPPORT**（详见 DREAMER_V22_LEDGER_DEDUP_VERIFICATION.md）。

## B. Router

| 问题 | 回答（证据） |
|---|---|
| 是否引入了重复 recommendations？ | **语义上否、结构上是**：14 Pain 无同 kind 重复条目；但 12/14 Pain 输出 2-3 条（S01/S11 恰 1 条）**同一机制的多载体**条目（principle+rule[+prompt]），每条独立成候选→独立成链 |
| 是否存在候选拆分过度？ | 拆分本身是提示词设计行为（ROUTING RULES）；"过度"发生在下游放大（每候选 1 链 × Philosopher 链间不可见 × 12/12 implements 关联无消费者）。**Router 是引入点、桥接是放大器**——单改 Router 提示词不闭环 |
| 是否损失了独立纠正机会？ | **否**——全部 recs 可追溯到蒸馏原则+根因；defer 纪律有效（S01/S11 实证"证据不足不固化"） |
| 是否值得进行 Prompt 优化？ | **证据不支持优先做**：Router 无独立性指令是事实，但加指令会触及 rule 载体的独立治理价值（确定性拦截+人审门 40/40），且不解决跨 Pain 冗余；若要减少跨链重复，有效干预点是**消费关联数据的链协调**（架构级），不是提示词 |

## C. Distiller

| 问题 | 回答（证据） |
|---|---|
| 是否造成抽象层级重复？ | Pain 内**否**（单原则契约，结构上不可能）；**Pain 间是**——语义家族跨 Pain 形成（调查先行 S02/S08、状态核实 S03/S12、意图对齐 S04/S06、授权族），词法检测 91 对仅 1 对可见——这是 Ledger 重复注册的直接上游 |
| 是否压缩了独立机制？ | **是**——≤200 字符×1 条预算：S02/S13 复合压缩两机制一句；S12/S14 的根因次要机制（持久化/自动召回）降级为根因注记、不再被路由（Dreamer 可部分恢复） |
| 是否需要 Prompt 优化？ | **提示词级收益有限**：跨 Pain 家族的根因是"无既有原则库视野"——修复需要给它 trustedContext 式输入通道（契约改动），纯提示词改不出来；S08 scope 放大为 P3 级观察（可在下一轮提示词修订中附带收紧 SCOPE CALIBRATION） |

## D. RootCause

| 问题 | 回答 |
|---|---|
| 是否存在上游根因重复？ | **否**——14/14 Pain 恰 1 条根因；S01/S11 示范了证据不足时的正确降级行为 |
| 是否应当冻结现有 Prompt？ | **是**——本轮未发现 RootCause 层任何重复/丢失问题；它是对照组，任何上游改动都不应波及它 |

## E. 下一轮决策（选项与裁定）

**裁定：LEDGER_REMEDIATION_REQUIRED（主）＋ 三 Agent 提示词冻结（FREEZE_UPSTREAM 伴随成立）。**

理由（按证据强度排序）：

1. **Ledger 是唯一有"实际损害"实证的层**：生产重复对已注册（2026-11-11），且最小修复是确定性的（写层加逐字文本/哈希查重——T1 证明该层目前零防御；修复不改任何语义行为）。同时可要求"评估不可用"时的放行必须保留现有可观察警告（diagnose.ts:935 已有，保持）。
2. **FREEZE_UPSTREAM 对三 Agent 成立**：RootCause 干净（冻结）；Router/Distiller 的"问题"是设计行为+输入通道缺失，**纯提示词改动无法闭环**，且有破坏现有治理价值的风险（rule 载体、defer 纪律、单原则契约）。在关联数据消费者/输入通道这两个架构位 Owners 决策之前，改提示词属于盲改。
3. **若 Owner 仍要推进提示词优化**：优先级 Distiller > Router（证据：跨 Pain 家族在蒸馏层形成），但必须与输入通道改动（原则库视野注入）同一 SPEC 提出方可生效——完整设计材料已交付 `UPSTREAM_PROMPT_DESIGN_INPUT.md`，由 ChatGPT 评估并出 SPEC。
4. **不是 BLOCKED**：本轮数据充分（14 Pain 全量、真实演练、生产实证），无不可判定项阻塞决策；逐机制损失清单一项子任务 BLOCKED-数据不足（已在联合报告 §四.4 标注，不影响本裁定）。

**与上轮预注册的衔接**：本裁定不推翻 V2.2 预注册（Treatment A=播种侧去重实验）——它收窄了其实施前提：M2 若走"router/distiller 提示词级自去重"路线，需按本卡补充输入通道/关联消费的架构评估；M1（ledger 注册演练）已由本轮完成（见 DREAMER_V22_LEDGER_DEDUP_VERIFICATION.md）。

## 附：本轮六份交付物

1. DREAMER_V22_LEDGER_DEDUP_VERIFICATION.md（Phase 1）
2. ROUTER_RECOMMENDATION_QUALITY_AUDIT.md（Phase 2）
3. DISTILLER_RECOMMENDATION_QUALITY_AUDIT.md（Phase 3）
4. UPSTREAM_REDUNDANCY_ROOT_CAUSE_REPORT.md（Phase 4）
5. UPSTREAM_PROMPT_DESIGN_INPUT.md（Phase 5，三 Agent 完整提示词+契约+真实样本）
6. UPSTREAM_NEXT_STEP_OWNER_REVIEW_CARD.md（本文件）

中间数据：`.tmp/prompt-v2-ab/next-task/`（全部可复现脚本+JSON）。未提交、未合并、未调用付费 API、生产数据库零写入。
