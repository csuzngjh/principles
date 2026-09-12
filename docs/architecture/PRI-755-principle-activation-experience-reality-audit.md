# PRI-755 — Principle Activation Experience Reality Audit

> 状态: Reality Audit（Phase 0，只读调查，零代码变更）
> Baseline: `origin/main` @ `ef71be063d75c6721e20fe8f25aec84c2e82e7d0`
> Branch: `ai/PRI-755-reality-audit`（独立 worktree，主 checkout 未触碰）
> Date: 2026-09-12
> Live 证据来源: `D:\.openclaw\workspace\.pd\state.db`、`D:\.openclaw\workspace\.state\trajectory.db`（全部只读查询）

---

## 1. Executive Summary

**当前机制是：Runtime 每轮把 Owner 批准的原则注入为 system prompt 里的 `【ACTIVE BEHAVIOR DIRECTIVES】` 块，并在块尾附带一条自报指令；用户看到的"使用了 XX 原则"是 LLM 自愿输出的 `📌 应用了你的原则「<id>」：<一句话>` 行（B 类 = prompt 要求 + LLM 自觉），Runtime 只负责事后从 assistant 文本中捕获该行写入 receipt 账本——声明本身没有任何确定性保障。**

核心结论：注入链路是稳定且可观测的（每轮注入、每轮留痕、ID 齐全）；不稳定的是"用户可见声明"这一跳，它是 LLM 自愿行为，且模板自身就用"每会话每原则至多一行"的指令主动压制了多轮重复。缺失的不是数据记录，而是一个确定性（runtime-owned）的展示通道。

---

## 2. Reality Topology（真实链路）

```
Owner 批准 (approvals/artifacts)
        │
        ▼
activations 表 (channel='prompt', action='prompt_activate', deactivated_at IS NULL)
  · live 实况：恰好 1 条激活「Model-Evidence-Reversibility-Verification Loop」(2026-09-01 起)
        │
        ▼
每轮 before_prompt_build hook（OpenClaw 每次构建 prompt 都触发，非仅 session start）
  · 注册点: packages/openclaw-plugin/src/index.ts:346
  · 路径选择: shouldUseSharedHostRuntime (index.ts:141, flag abstraction_layer_v1)
    · live 实况: abstraction_layer_v1=false → 走插件本地路径（PromptActivationReader）
    · 开启时走 shared host-runtime: buildActivePrinciplePromptContext
      (packages/host-runtime/src/active-principle-prompt.ts)
        │
        ▼
读取 + 过滤 + 渲染
  · filterPromptActivations (prompt-activation-reader-contract.ts:39)
  · 与 legacy evolution principles 跨块去重 (prompt.ts:616)
  · 预算: RUNTIME_V2_PRINCIPLE_BUDGET = 2000 chars (prompt-activation-reader-contract.ts:3)
  · renderPrinciplesToDirectives → 【ACTIVE BEHAVIOR DIRECTIVES】+ 逐条 <directive> + 自报 footer
    (prompt-activation-reader-contract.ts:154-193)
        │
        ▼
prependSystemContext（system prompt 头部，最高保护：size-guard 最优先剥离其他块）
  · prompt.ts:763-772；truncateInjectionToBudget (size-guard.ts:40)
        │
        ▼
LLM Context（每轮都带，字节级不变 → prompt-cache friendly）
        │
        ├──(确定性，runtime-owned)──▶ 留痕三件套（每轮）:
        │     1. eventLog JSONL: runtime_v2_prompt_activations_injected
        │        (prompt.ts:644, 含 sessionId/principleIds/activationIds/artifactIds/char 数)
        │     2. session-tracker: setInjectedPrincipleIds → /pd-context 会话回执 (PRI-534)
        │     3. principle_applications presence 行 (PRI-531, flag principle_receipt_ledger,
        │        session×principle 去重, prompt.ts:703)
        │
        └──(非确定，LLM 自愿)──▶ assistant 回复末尾输出:
              「📌 应用了你的原则「<directive id>」：<一句话>」
                 │
                 ▼
               llm_output hook (llm.ts:200) / before_message_write 兜底
               (trajectory-collector.ts:134)
                 │  recordSelfReportFromText (principle-application-ledger.ts:211)
                 │  正则: /📌\s*应用了你的原则「([^」]{1,200})」[：:](.{0,200})/gu
                 │  flag: principle_receipt_self_report（60s 缓存）
                 ▼
               principle_applications effect 行 kind=self_reported
               （session×principle 去重 → 每会话只留第一条）
                 │
                 ▼
               读侧: /pd-context 会话回执 (commands/context.ts:123)
                    Console ReceiptsConsoleModel (PRI-533/590)
                    CLI pd principles-stats
```

---

## 3. Existing Mechanisms（既有机制清单）

### 3.1 能力矩阵

| 能力 | 是否存在 | 位置 | 状态（live 实证） |
|-|-|-|-|
| 原则审批记录 | ✅ | `state.db` approvals / artifacts 表（Runtime V2 审批链） | 活跃 |
| 原则激活记录 | ✅ | `state.db` activations（channel=prompt） | live 恰 1 条激活，含 activation_id/artifact_id |
| 原则注入记录（每轮） | ✅ | eventLog JSONL `runtime_v2_prompt_activations_injected`（prompt.ts:644） | 每轮写入，含完整 ID 数组 |
| 原则注入记录（会话级 presence） | ✅ | `principle_applications` kind=prompt_injected（PRI-531） | live 215 行 / 215 会话（去重生效） |
| 原则使用记录（effect: 工具闸门） | ✅ | gate.ts:175/345/636 → rule_blocked / auto_correct_applied | 机制在，live 窗口内 0 行（无 RuleHost 拦截发生） |
| 原则使用记录（effect: 自报） | ✅ | `principle_applications` kind=self_reported（PRI-532） | live 20 行 / 19 会话 |
| 用户展示记录（按需） | ✅ | `/pd-context` 会话回执（PRI-534）+ ReceiptsConsoleModel（PRI-533/590）+ `pd principles-stats` | 需用户主动查询，非自动推送 |
| 用户展示记录（自动） | ❌ | — | 不存在：Runtime 从不向聊天框写入任何"使用了原则"文本 |
| 逐轮"注入→行为"关联记录 | ❌ | — | 不存在：除自愿 📌 行外，没有把某一轮 assistant 行为绑定到该轮注入集合的记录 |
| （命名化石）`trajectory.db` principle_events | ⚠️ | trajectory.db principle_events 表 | 名字含 principle 但 117 行内容 100% 是 pain_detected/pain_recorded，principle_id 全 NULL |

### 3.2 Feature Flag 实况（live workspace `D:\.openclaw\workspace\.pd\config.yaml`）

| Flag | 仓库默认 | live 值 | 作用 |
|-|-|-|-|
| `features.prompt` | — | **true** | Runtime V2 prompt 通道总开关 |
| `abstraction_layer_v1` | — | **false** | false → 插件本地 PromptActivationReader 路径 |
| `principle_receipt_block_copy` (PRI-530) | ON（已毕业） | false | RuleHost 拦截文案归因 |
| `principle_receipt_ledger` (PRI-531) | ON（已毕业） | **true** | 账本写入 |
| `principle_receipt_self_report` (PRI-532) | **OFF**（feature-flag-contract.ts:383） | **true** | 自报指令注入 + 📌 捕获 |

数据保留: `RECEIPT_RETENTION_POLICY_DAYS = 90`（receipt-coverage.ts:19），账本按小时批量清理。

---

## 4. Root Cause：为什么"首轮稳定、多轮丢失"

**机制定性：Phase 4 的 B 类（prompt 要求 Agent 说，LLM 自觉执行）。Runtime 从头到尾没有生成过任何用户可见的声明文本。**

已验证的具体因子（按证据强度排序）：

1. **模板主动压制多轮重复（by design）。** 自报 footer 原文（prompt-activation-reader-contract.ts:185-189）：
   > "when a directive above actually changes what you do **in this turn**, append exactly ONE line…"
   > "**At most one line per directive per session.** Omit the line entirely if no directive changed your behavior."

   这是一条明确的"每会话每原则只报一次"的反刷屏指令。多轮沉默一半是设计意图，不是缺陷泄漏。

2. **声明条件是 LLM 的主观判断。** "本指令这一轮是否真的改变了我的做法"由模型自行裁量。首轮指令新鲜、判断容易为真；后续轮次指令已在生效中，"这一轮有没有改变"更容易被判为否 → 省略。

3. **注入字节级不变，无逐轮再强调。** 注入每轮都发生（`before_prompt_build` 每次 prompt 构建都触发，directive 块在 system prompt 中受 size-guard 最高保护，size-guard.ts:40 的剥离顺序最后才轮到 prependSystemContext）。**注入不是不稳定源**。但内容完全相同 → 长对话中对 system prompt 尾部的注意力自然衰减，没有任何"第 N 轮提醒"机制。

4. **Runtime 捕获侧也看不见重复声明。** `idx_pa_self_report_dedup`（session×principle 部分唯一索引）+ `INSERT OR IGNORE` → 同一会话后续 📌 行即使 LLM 输出了也不会入库。数据层只能回答"该会话是否至少自报过一次"，不能回答"第几轮自报、报了几次"。

5. **live 数据修正了"多轮必丢"的直觉（会话粒度）：** 2026-09-01→09-12 窗口内，
   - 注入会话 215 个；自报会话 19 个；自报会话 ⊆ 注入会话（19/19 完全重叠）。
   - 会话级自报率：0-1 用户轮会话 ≈ 2.0%（2/128*），多轮（≥2 用户轮）会话 21.6%（8/37）——长会话反而更容易至少报一次（更多机会）。
   - **每轮粒度才是真实体验：** 484 个用户轮 / 20 条自报 ≈ **4.1% 每轮可见声明率**。用户感知的"多轮不稳定"即此：绝大多数轮次没有声明，只是首轮的新鲜感让它看起来"稳定"。
   - \*分桶: 0 轮 64 会话（心跳/cron/subagent 等无用户输入触发——注入对这些会话同样发生！）、1 轮 114、2-3 轮 11、4+ 轮 26。注意 9/19 的自报会话落在"0 记录用户轮"桶：要么是自动化运行在无人可见处自报（用户永远看不到），要么是 user_turns 记录在该路径不完整——两种解释都指向"自报可见性比账本数字更差"。

6. **附带发现（rc-6 邻域数据质量）：** live 存在 `T-06 最简单干预` 的 self_reported 行，但该原则从未有 prompt 通道 presence 行——`recordSelfReportFromText` 不校验 marker 里的 id 是否真在本会话注入集合中，任何 📌 文本（含 LLM 幻觉/回显 legacy 块原则）都会入库。

---

## 5. Missing Link（缺什么，不泛泛）

**不缺的（已证明存在且健康）：**
- 注入本身（每轮、稳定、受保护）；
- 注入记录（每轮 eventLog + 会话级 presence，ID 齐全：principleId/activationId/artifactId/sessionId/runId）；
- 激活与审批数据（Runtime V2 全链）；
- Owner 按需查询面（/pd-context、Console Receipts、CLI stats）。

**缺的（三个精确缺口）：**

| # | 缺口 | 性质 |
|-|-|-|
| G1 | **确定性展示通道**：用户可见的"使用了 XX 原则"100% 依赖 LLM 自愿输出；Runtime 没有任何机制保证这条线出现 | 展示 + prompt 稳定性 |
| G2 | **逐轮使用关联**：没有记录把"第 N 轮 assistant 行为"与"第 N 轮注入集合"绑定（eventLog 有每轮注入，但没有逐轮使用/影响事件；自报账本被去重成会话粒度） | 数据记录（粒度，不是缺失） |
| G3 | **自报 ID 校验**：捕获侧不验证 📌 行的 id ∈ 本会话注入集合，账本可被污染（T-06 实证） | 接线（已有数据可修） |

---

## 6. Recommendation（最小方案分类）

### Already Exists（已有能力，只需接线/读取，零新表）

- **"第 N 轮注入了哪些原则"今天就能回答**：eventLog JSONL `runtime_v2_prompt_activations_injected`（每轮、含 activationIds）。任何未来的稳定性度量、回放、诊断都应优先消费它，而不是新建记录。
- Owner 可见性查询面已齐（/pd-context、ReceiptsConsoleModel、principles-stats）。

### Small Fix（确定性小修，符合现行架构）

1. **自报 ID 校验（G3）**：`recordSelfReportFromText` 已有会话注入集合可用（prompt.ts:684 已写入 session-tracker 的 `setInjectedPrincipleIds`）——对 marker id 不在集合内的行丢弃或打标，并在 warn 中可观测（rc-9）。消除 T-06 类污染。
2. **模板措辞调整（若 Owner 想提升可见率）**：现 flag `principle_receipt_self_report` 之下调整 footer 措辞（如"每轮只要指令影响了你，就报一行"）即可改变自报频率——零新机制，但仍是 LLM 自愿路径，稳定性上限由模型决定，预期必须如实设定。

### Need SPEC（需要架构设计，本审计不实施）

3. **确定性 Runtime 回执（G1/G2 的根治）**：若 Owner 判定"自愿声明"不可接受，需要由 runtime 在消息写路径上生成确定性的用户可见回执（消费已有的 eventLog/账本数据），并把逐轮使用关联落成持久事实。这跨越 plugin→宿主消息边界、涉及 OpenClaw message write 路径与新的持久状态，必须走 SPEC + MVP 四问（mvp-q-1~4），本阶段不做。

**明确禁止项核对**：本审计未建任何表、未加任何 subsystem、未改 Principle 生命周期 / RuleHost / Runtime-v2 / 任何既有机制。零代码变更，仅新增本报告。

---

## 附：Success Criteria 逐条回答

1. **"使用了 XX 原则"这句话是谁生成的？**
   LLM 自己生成的。指令来自 `renderPrinciplesToDirectives` 自报 footer（prompt-activation-reader-contract.ts:185-189，flag `principle_receipt_self_report`，live=ON），规范格式 `📌 应用了你的原则「<directive id>」：<一句话>`。Runtime 仅事后捕获入库（PRI-532），从不生成用户可见文本。
2. **原则什么时候进入 Agent？**
   每次 prompt 构建都注入（非仅 session start）：Runtime V2 prompt 通道激活 → 跨块去重 → 2000 字符预算 → `【ACTIVE BEHAVIOR DIRECTIVES】` 进 system prompt 头部（最高保护位）。
3. **是否存在可靠 activation 数据？**
   存在且 ID 链完整：activations（activation_id/artifact_id）→ 每轮注入事件（eventLog，含 activationIds 数组）→ presence 账本（会话粒度）→ self_report 账本（会话×原则粒度，仅首条）。
4. **为什么多轮稳定性下降？**
   因为声明是 LLM 自愿行为：模板自带"每会话每原则至多一行"的反重复指令 + 逐轮主观裁量 + 注入字节不变无再强调。注入链路本身每轮稳定（已排除注入故障）。每轮可见声明率 live 实测 ≈ 4.1%。
5. **最小修复是什么？**
   不建新系统。小修 = 自报 ID 校验（消账本污染）+ 可选 footer 措辞调整（现有 flag 范围内）。根治 = 确定性 Runtime 回执 SPEC（待 Owner 决策）。
