# PD 意图工程 MVP 设计文档 v0.3

**版本**：v0.3（取代 v0.1、v0.2）
**状态**：Draft（待 maintainer 评审）
**目标周期**：2–3 周验证
**前置阅读**：`docs/product/PRODUCT_IDENTITY.md`、`docs/adr/0014-mvp-first-strategy-and-product-pivot.md`、`docs/plans/2026-06-diagnostician-split/00-diagnostician-refactor-plan.md`、`docs/architecture/unified-friction-observer.md`

> **v0.3 修正要点**：v0.2 曾提议把意图合并进 `CURRENT_FOCUS.md`。经代码核查，这是错误的——
> `CURRENT_FOCUS.md` 是易失的工作记忆（自动压缩、被 agent 回写、机械版本号），其
> `extractSummary` 压缩会**静默丢弃**非白名单段落（包括意图锚）。意图必须是独立、持久、
> owner 自有、语义版本化的文件。v0.3 改为**独立 INTENT 文件 + 复用注入机制（而非文档）**，
> 并把「持久 INTENT ↔ 易失 CURRENT_FOCUS」的差异作为 drift 检测的基础。

---

## 0. 一句话结论

意图工程 MVP 不做 GDI、不做运行时 IntentHost、不做评估审判庭、不新增常驻 cron/observer。

它做的是：

> **新增一份独立、持久、owner 自有的意图文件，在 agent 行动前（事中）复用现有注入机制注入一个 Socratic 建设性摩擦闸门，让 agent 在关键决策点同时拷问「这一步」和「意图本身」；事后诊断（三段式管道 Stage A）输出意图张力作为兜底层。**

两条铁律：

1. **摩擦双向**——既摩擦 agent 偏离合理意图，也摩擦一个可能不专业/过时/错误的意图。意图不是真值。
2. **PD 逼问，不裁决**——用 Why/Risk/Moat 强制暂停与发问，价值决策权始终归 owner。

---

## 1. 三份 owner 文档的定位（为什么意图必须独立）

PD 已有/将有三份面向 owner 的文档，**职责、作者、变更频率各不相同**，不能混用：

| 文档 | 语义 | 作者 | 变更频率 | 生命周期 | 存放 |
|------|------|------|----------|----------|------|
| `THINKING_OS.md` | 普世认知公理（T-01..T-10） | 框架提供，owner 微调 | 极低 | 稳定 | `.principles/` |
| **`INTENT.md`（新）** | **持久产品意图（Why/Outcome/Non-negotiables/Stop）** | **owner 自有** | **低（按周/里程碑）** | **稳定、语义版本** | **`.principles/`** |
| `CURRENT_FOCUS.md` | 易失会话/任务意图 + 工作记忆 | **机器为主**（agent 回写 + 自动压缩） | 极高（每 session） | 易失、机械压缩 | `memory/okr/` |

**关键洞察**：drift 的可检测性，恰恰依赖「持久 INTENT」与「易失 FOCUS/动作」之间存在一个**稳定的对比基线**。

```
drift = 易失的 CURRENT_FOCUS / agent 实际动作  ⟂  偏离  ⟂  持久的 INTENT
```

把两者并进一个文件，会塌缩这个对比维度，drift 就无从判定。因此 INTENT 独立不是「多一份负担」，而是功能能成立的前提。三份文档语义清晰：`.principles/` = 稳定锚，`memory/` = 易失态。

---

## 2. 为什么不能复用 `CURRENT_FOCUS.md` 文档（代码级证据）

v0.2 错误地想把意图塞进 CURRENT_FOCUS。核查 `principles-core/src/prompt-builder/focus-compression.ts` 与 `openclaw-plugin/src/core/focus-history.ts` 后，三条硬冲突：

1. **压缩静默删锚（致命）**：core `extractSummary` 压缩时只保留 `header/snapshot/nextSteps/current` 四类段落；段落识别仅匹配 `状态快照/当前任务/下一步/参考`。任何「意图」段落不在白名单 → 一旦超过 100 行/15KB 触发压缩即被丢弃。违反 ERR-002 / Runtime Contract Rule 9（禁止静默降级）。
2. **循环污染**：`extractWorkingMemory` 把 agent 自己的输出回写进 CURRENT_FOCUS。意图住在这里 = 被审判者在改写审判标准，drift 的「稳定参照系」前提消失。
3. **节奏/版本错配**：CURRENT_FOCUS 每 session 变、24h 自动压缩、版本号机械自增；意图按周变、需语义版本。复用其 history 追踪意图演化会被机械压缩事件淹没。

**结论**：可复用的是**注入/校验/版本的代码范式**（`safeReadCurrentFocus` 那条已验证的 read→validate→inject→backup 路径），**不可复用的是 CURRENT_FOCUS 这个文件及其压缩管道**。INTENT 用一个**镜像但独立**的读取器，绝不接入 CURRENT_FOCUS 的压缩/回写逻辑。

---

## 3. 核心理念

### 3.1 事中 > 事后（事后是兜底，不废弃）

官网定位 "pause, question, and calibrate **before executing**"。零摩擦执行有缺陷的任务只会更快系统性失败。所以主战场是**行动前摩擦**；事后诊断兜住「决策点没拦住的」与「owner 放行后被证伪的」。

```
事中（主）：注入 INTENT + Socratic 摩擦  ── 关键决策点暂停、逼问
   │  （未拦住 / owner 放行后仍出问题）
   ▼
事后（兜底）：Stage A 输出 intentTension  ── 复盘沉淀为原则
```

### 3.2 摩擦双向：意图不是真值

普通 owner 的产品判断未必专业，意图可能弱/过时/错。PD 价值不是忠实执行意图，而是拷问意图。输出必须能表达**张力来源**：

| 来源 | 谁可能有问题 | PD 动作 |
|------|--------------|---------|
| `action_drift` | agent 偏离合理意图 | 摩擦 agent：拉回/要求说明 |
| `intent_suspect` | 意图本身弱/过时/与证据矛盾 | 摩擦 owner：逼其重述/更新意图 |
| `healthy_tension` | 行动与意图有张力但都成立 | 表面化，交 owner 裁决 |

### 3.3 PD 逼问，不裁决（产品边界）

`PRODUCT_IDENTITY` 明确 PD 不拥有自主价值决策。摩擦意图只能 Socratic：

- ✅ 「你说这步为了 X，但按 INTENT 它更像在优化 Y，且无证据支持 X——确认继续？」
- ❌ 「你的目标错了，改成 Y。」

PD 背后只是 LLM，产品判断大概率不如真做产品的 CEO；逼问不裁决既防盲从 owner，也防盲信 PD 自己。

---

## 4. 与 PD 当前现状的融合

### 4.1 新增独立持久文件 `INTENT.md`

位置：`.principles/INTENT.md`（与 THINKING_OS 同级，归「稳定锚」区，远离 `memory/` 易失区）。

字段（1–3 必填，4 可选；缺失整体降级、不报错，且降级要有结构化 reason）：

```md
# INTENT.md

## 1. Why            — 为什么存在 / 服务什么长期目标
## 2. Desired Outcome — 完成后可观察的变化
## 3. Non-negotiables — 不可牺牲项
## 4. Stop / Escalation — 必须停下问 owner 的情形
```

注意：**不要再放「Current Focus」字段**——「当前焦点」本就是易失的，归 `CURRENT_FOCUS.md`。INTENT 只放持久内容。这正是 4.4 drift 判定的两端。

### 4.2 复用注入机制（镜像，不接入压缩）

新增 `IntentDocReader`（plugin 层），**镜像** `safeReadCurrentFocus` 的 read→validate→template-recover 模式，但：

- 读 `.principles/INTENT.md`，**不调用** `autoCompressFocus` / `cleanupStaleInfo` / `extractWorkingMemory`；
- 校验用独立的 `validateIntentDoc`（core 纯逻辑），缺字段仅 warning；
- 版本：owner 主动编辑触发的语义快照（git 即可；可选 `.principles/.intent-history/`），与 CURRENT_FOCUS 的机械压缩版本互不干扰。

注入时机复用现有 prompt 构建路径——在注入 CURRENT_FOCUS 的同一处，**额外**注入 INTENT + 摩擦块（受 flag 控制）。

### 4.3 事中摩擦块（注入形态，受 `intent_engineering` flag，默认 off）

```
<intent_friction enabled="true">
执行接下来的关键改动前，用三问校准（关键决策点触发，不要逐工具盘问）：
1. Why：这一步如何服务 INTENT 的 Why / Desired Outcome？说不清就停。
2. Risk：是否触碰 INTENT 的 Stop/Escalation？是则升级 owner。
3. Tension：它与 INTENT 冲突吗？若你判断 INTENT 本身可能过时/不对，
   明确说出并暂停——这是建设性摩擦，不是抗命。最终由 owner 裁决。
</intent_friction>
```

显式授权质疑 INTENT 本身（双向），裁决权交回 owner。

### 4.4 收口「没做完的 Strategy Alignment」为事中注入，而非新 cron

BOOTSTRAP 模板里的每日 "Strategy Alignment" cron（对比 24h 操作是否偏离 CURRENT_FOCUS）是 demo 没接完的部分。**不要补成常驻 cron**（踩 ADR-0014 暂停的 MissionScheduler，且接近 `unified-friction-observer.md` 里无路线图条目的目标偏移 observer）。

正确收口：把「漂移检查」从*定时扫描*改为*行动前注入*——drift 的两端正好是 **CURRENT_FOCUS（agent 当前在做的）vs INTENT（持久该做的）**。注入摩擦块时让 agent 自检这两者是否一致。零新增运行时，复用 MVP-Core 的 prompt 通道。

### 4.5 事后诊断接入（Stage A，兜底层）

- `DiagRootCauseOutputV1Schema`（`runtime-v2/diagnostician/diag-rootcause-output.ts`）**additive-optional** 加 `intentTension`；
- `rootcause-prompt-builder.ts` 仿 `PHASE 3.5 — Core Axiom Grounding`（`buildCoreAxiomBlock` + `coreGrounding` 门控）加 `PHASE 3.6 — Intent Tension Check`，受 `intentGrounding` 门控；
- 经 Stage C additive 透传到冻结的 `DiagnosticianOutputV1`，不改下游契约。

### 4.6 与其他子系统的边界（非依赖）

- **THINKING_OS（公理）**：普世、跨项目；INTENT per-project。摩擦三问可引用公理（T-01/T-08），但**意图判定只用 INTENT 做参照系，原则抽象 grounding 只用公理**，两套不交叉。
- **CURRENT_FOCUS**：drift 的「当前态」一端；INTENT 是「应然」一端。两文件协作，不合并。
- **correction-observer**：关键字热通道；意图摩擦是冷通道，互补不复用。
- **激活通道**：确认原则走现有 `prompt/defer_archive/rule_host`，不新增通道。
- **feedback_channel**：意图张力案例可作后续反馈素材（不在本 MVP）。

---

## 5. 数据模型

### 5.1 事中（无新持久结构）

摩擦只注入文本 + 复用 INTENT 文件本身。owner 回应（继续/升级/改 INTENT）走 INTENT 文件编辑 + git。

### 5.2 事后诊断字段（Stage A 输出，camelCase 对齐现有 schema）

```ts
type IntentTensionSource = 'action_drift' | 'intent_suspect' | 'healthy_tension' | 'none';

interface IntentTension {
  source: IntentTensionSource;          // 枚举而非 boolean —— 让 intent_suspect 可被表达
  confidence: number;                   // 0..1；证据不足 <0.3 并入 ambiguityNotes
  relatedIntentFields: string[];        // why | desired_outcome | non_negotiables | stop_escalation
  evidence: string[];                   // 默认 ≤3 条（保护注意力）
  explanation: string;
  suggestedOwnerAction:
    | 'confirm_drift'   // agent 偏离 → 沉淀原则
    | 'revise_intent'   // 意图本身要改 → 引导编辑 INTENT.md
    | 'observe'         // 证据不足 → 挂起
    | 'dismiss';        // 健康张力/误报
}
```

### 5.3 lineage 一致性（Runtime Contract Rule 6 / ERR-004/008）

`confirm_drift` 转候选原则时，`derivedFromPainIds`/`sourceTaskId` 与触发 pain 同源；Stage A→C 透传走相同 `taskId` re-inject（`DefaultDiagRootCauseValidator` 已有模式）。加 mismatch 测试。

---

## 6. 三层架构总览

```
┌─ 层 1：事中建设性摩擦（主） ─────────────────────────────┐
│ IntentDocReader 注入 .principles/INTENT.md + <intent_friction> │
│ → agent 在关键决策点走 Why/Risk/Tension，可质疑 INTENT 本身    │
│ → drift 自检：CURRENT_FOCUS/动作 vs INTENT；触碰 Stop 即升级    │
│ 机制：现有 prompt 通道（MVP-Core）。flag: intent_engineering   │
└──────────────────────────────────────────────────────────┘
              │ 未拦住 / owner 放行后仍出问题
              ▼
┌─ 层 2：事后诊断（兜底） ─────────────────────────────────┐
│ Stage A 输出 intentTension（三源）→ Stage C additive 透传     │
│ → owner 轻量裁决（confirm_drift/revise_intent/observe/dismiss）│
└──────────────────────────────────────────────────────────┘
              │ confirm_drift / revise_intent
              ▼
┌─ 层 3：意图维护与沉淀 ───────────────────────────────────┐
│ revise_intent → 引导编辑 INTENT.md + git 语义快照            │
│ confirm_drift → 候选原则（≤3）→ 现有审批队列 → 激活通道       │
└──────────────────────────────────────────────────────────┘
```

---

## 7. 非目标与治理红线

### 7.1 不做
- GDI / 偏离分数 / 对齐百分比（反 Goodhart，ADR-0014 反量化）。
- 运行时 IntentHost / 工具前意图硬 block（漂移非离散动作；硬拦截归 RuleHost）。
- Intent IR / DAG / 状态机 / 多评估 Agent。
- 常驻 cron / 后台 observer。
- 不把意图合并进 CURRENT_FOCUS（见 §2）。

### 7.2 治理红线（写进 issue）
> 事中意图摩擦在能力上离 `unified-friction-observer.md` 的「目标偏移 observer」和冻结的 GAP/BALM/LRAS 只有一步。本 MVP **刻意做窄**：独立文件 + 复用 prompt 注入 + flag 默认 off + 仅关键决策点触发 + 不做常驻观测。**禁止以本功能为入口启动任何 post-MVP 引擎。** 触发 AGENTS.md 反模式词即停。

---

## 8. 落地映射（文件 / flag / CLI）

### 8.1 Feature flag（PRI-239 强制，默认 off）
`feature-flag-contract.ts` 的 `DEFAULT_FEATURE_FLAGS` 增加：
```ts
{ id: 'intent_engineering', category: 'quiet', enabled: false, since: '2026-06-23',
  description: 'INTENT.md-grounded constructive-friction injection + Stage-A intent-tension detection' },
```
`isFeatureEnabled(flags, 'intent_engineering')` 门控注入与字段产出；config 走 `.pd/config.yaml`，单一 snake_case key。

### 8.2 core（纯逻辑）
- `runtime-v2/intent/intent-doc.ts`：`IntentDocSchema` + `validateIntentDoc`（untrusted，`unknown`→校验，缺字段 warning）。
- `runtime-v2/intent/intent-friction-block.ts`：`buildIntentFrictionBlock`（仿 `buildCoreAxiomBlock`，flag-off 时 byte-identical，EP-03 无静默 fallback）。
- `runtime-v2/diagnostician/diag-rootcause-output.ts`：`DiagRootCauseOutputV1Schema` 加 `Type.Optional(IntentTensionSchema)` + validator。

### 8.3 plugin / CLI（I/O 边界）
- `openclaw-plugin/src/core/intent-doc-reader.ts`：`safeReadIntentDoc`（**镜像** `safeReadCurrentFocus`，但不接压缩/回写）。
- prompt 构建处：flag-on 时把 INTENT + friction 块拼到 CURRENT_FOCUS 注入段之后。
- `pd intent init` / `pd intent show`（过 CLI/Operator Gate）；或 `/pd-intent` 插件命令对齐 `/pd-focus` 风格。
- 事后裁决复用 `pd pain record` → 诊断 → 审批队列（`ApprovalQueueStore`：approve/reject/resetToPending + 既有 edit），**不新建 `pd pain review`**。

### 8.4 CLI / Operator Gate（凡碰 `pd-cli/src/commands/**`）
`--json` 严格单对象；`process.exit` 后立即 return；`--no-*` 加 parser 级测试；失败路径不写状态；降级输出结构化 reason + nextAction。

---

## 9. MVP 三问

1. **不做会怎样？** 诊断只能归因 People/Design/Assumption/Tooling，无法处理「技术对但方向错」「意图本身有问题」——一人 CEO 用 agent 做产品的头号痛（过度工程/范围蔓延）。30 天内必复发。✅
2. **怎么观测？** 事中：注入文本含 friction 块，owner 在会话里看到 agent 暂停发问。事后：`pd pain record` 后 diagnosis 含 `intentTension`，`pd task show` 可见。复用 `THINKING_OS_USAGE` 式命中统计追踪触发频率。✅
3. **怎么关？** `intent_engineering` flag `enabled:false`，改 `.pd/config.yaml`，注入与字段同时消失。✅

---

## 10. 风险与防护

| 风险 | 防护 |
|------|------|
| 压缩/改写擦除意图（v0.2 的硬伤） | **独立文件**，不接 CURRENT_FOCUS 压缩/回写（§2） |
| 摩擦变噪声 | 只在关键决策点触发；prompt 明确不逐工具盘问 |
| PD 越权裁决价值 | Socratic only，owner 拍板（§3.3） |
| 借此启动 GAP/observer | 治理红线；不新增 cron/observer；flag off |
| 意图过时 | INTENT 语义版本 + git；`intent_suspect` 主动提示 revise |
| owner 注意力被增加 | 证据 ≤3、候选原则 ≤3、裁决 ≤30s |
| 全失败误判为意图问题 | `source` 含 `none`/`healthy_tension`；不足 → confidence<0.3 + observe |
| 一人多项目混淆 | INTENT 严格 per-workspace；公理才跨项目 |

---

## 11. 验收标准

**功能**
- flag off：注入与诊断 byte-identical 于现状（回归）。
- flag on：注入文本含 INTENT + friction 块；缺字段仅 warning；**INTENT 文件独立存在，不被任何压缩逻辑触碰**（专门测试压缩不影响 INTENT）。
- Stage A 输出 `intentTension`，能产出 `intent_suspect`（敢质疑意图）。
- 事后裁决走现有审批队列，无新命令。

**质量（核心）**
- 10 个 case（技术对但偏航 / 意图本身弱 / 普通执行失败 / 意图模糊）对比 flag on/off：是否更早拦住偏航？是否识别出 ≥1 个 `intent_suspect`？候选原则是否更高层？

**负担**
- 事中摩擦不显著拖慢正常任务；单次事后裁决 ≤30s。

---

## 12. 实现顺序

**Week 1 — core + flag**：注册 flag；`IntentDocSchema`+`validateIntentDoc`；`buildIntentFrictionBlock`；`DiagRootCauseOutputV1Schema` 加 `intentTension`+validator。
**Week 2 — 注入 + 诊断**：`safeReadIntentDoc`（镜像，不接压缩）；prompt 构建按 flag 注入；`PHASE 3.6` 门控；Stage A→C 透传 + lineage 测试。
**Week 3 — 维护 + 验证**：`pd intent init/show`（过 gate）；裁决映射审批队列；10 case A/B；降级 reason、flag on/off 回归、压缩不触碰 INTENT 的专项测试、CLI gate 测试。

---

## 附录 A：`.principles/INTENT.md` 模板

```md
# INTENT.md

## 1. Why
<为什么存在 / 服务什么长期目标，3–5 行>

## 2. Desired Outcome
<完成后可观察的变化，3–5 行>

## 3. Non-negotiables
<不可牺牲项，3–5 行>

## 4. Stop / Escalation
<必须停下/升级 owner 的情形，3–5 行>
```

## 附录 B：Stage A `intentTension` 输出模板

```yaml
intentTension:
  source: action_drift | intent_suspect | healthy_tension | none
  confidence: 0.0-1.0
  relatedIntentFields: [why, desired_outcome, non_negotiables, stop_escalation]
  evidence: [ "...", "...", "..." ]   # ≤3
  explanation: "..."
  suggestedOwnerAction: confirm_drift | revise_intent | observe | dismiss
```

## 附录 C：关键现状文件索引

- `openclaw-plugin/src/core/focus-history.ts` — `safeReadCurrentFocus`（要**镜像**的注入范式）；其 `autoCompressFocus`/`extractWorkingMemory`/`extractSummary` 即 INTENT **不可**复用的压缩/回写逻辑（§2 证据）
- `openclaw-plugin/src/commands/focus.ts` — `/pd-focus`（`/pd-intent` 对齐其风格）
- `principles-core/src/prompt-builder/focus-compression.ts` — `extractSummary` 段落白名单（会丢非白名单段落 → 证明意图不能寄居 CURRENT_FOCUS）
- `principles-core/src/runtime-v2/diagnostician/diag-rootcause-output.ts` — Stage A 输出 schema（接入点）
- `principles-core/src/runtime-v2/diagnostician/rootcause-prompt-builder.ts` — `PHASE 3.5` 范式（仿照加 3.6）
- `principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts` — flag 注册
- `templates/.../BOOTSTRAP.md` — 未做完的 Strategy Alignment（本设计收口为事中注入）
```
