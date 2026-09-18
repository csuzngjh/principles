# PRI-815 — FROZEN_COGNITIVE_CONTRACT (Phase A output, Phase B input)

> 状态：**冻结记录（record-only）**。本 PR 不实施 PrincipleFormation / 任何生产拓扑变更。
> 依据：PHASE_A_REPORT.md FINAL GATE = PROCEED_TO_PHASE_B（final closure round, 8/8 conditions PASS）。
> Phase B 的唯一实验变量是 durable lifecycle 拓扑（3 → 1）；以下认知契约在 Phase B 期间**禁止调整**。

```text
COGNITIVE_CONTRACT_VERSION = pri815-frozen-cognitive-contract.v1
FROZEN_AT = 2026-09-18 (final blocker closure round, PR #1753)

THREE COGNITIONS (all KEEP):
  Dreamer    = KEEP（生产 DreamerPromptBuilder，coreGrounding=true；多候选发散）
  Philosopher= KEEP（生产 PhilosopherPromptBuilder，coreGrounding=true；收敛/批判/风险）
  Scribe     = KEEP（生产 ScribePromptBuilder，coreGrounding=true；正式化 + intentContract）

FORMATION EVIDENCE (KEEP — the validated Phase A information-flow repair):
  Scribe/formalize 输入 = 生产 payload + 三块冻结证据：
    sourceDiagnosis（含 rootCause/violatedPrinciples/evidence 数组）
    dreamerProposals（全部候选，非仅选中项）
    provenance（source pain / diagnosis task / artifact ids）

CANDIDATE PRIORITY CONTRACT (KEEP, frozen text = pri815-b-addendum.v1):
  source intent (sourceDiagnosis)
  > critique conclusions (philosopherArtifact)
  > proposals as candidate evidence (dreamerProposals)
  含：不得复活被批判否定的候选；不得拼接互斥候选；不得以更长输出冒充更好。

OWNER RE-ANCHOR SEMANTICS (KEEP — final closure round 的裁决语义):
  explicit current Owner decision（明确 Owner authority 事件：
  re-confirmation / 新验收标准 / 新 scope）
  > historical acceptance baseline
  > inferred prior preference
  Owner 显式给出新目标/标准/scope → 旧 baseline 被 supersede，
  Agent 不得用旧基准反向否决 Owner 当前明确裁决。
  反向约束（不是任何新消息自动覆盖原则）：re-anchor 必须来自
  明确 Owner authority evidence（显式 re-confirmation / owner-accepted
  state / Owner 显式授权条款），禁止模型从"Owner 可能想改方向"猜测。

ARM IDENTITY HASHES (from PHASE_A_REPORT):
  Arm A system prompt = a47db8f47552
  Arm B system prompt = bc47a6df83bd（delta = addendum v1 + 3 evidence blocks）
  shared Dreamer/Philosopher builders = 生产 dist（origin/main d68f6406 构建产物）

GENERATOR CONFIG (frozen):
  model = glm-5.3（ZAI coding endpoint）
  temperature = 0；maxTokens = 8000；validator = 生产 Default*Validator
  lineage-echo repair = 生产 reconcileLineageEcho 语义（PRI-541 层，
  harness 保真度已在 closure round 补齐）

PHASE B 禁改清单：
  prompt 文本 / candidate priority / Owner authority 语义 /
  formation evidence 组成 —— 全部冻结；Phase B 只动 durable lifecycle。
```

已知共同弱点（记录在案，不阻塞 Phase B，Phase B 也不得顺手修）：
- 6406fbff5ee282 场景：owner-waived delivery 豁免在**两臂**契约字段中均缺失（对称弱点，A/B 各 1 overblock）。若未来修，属认知契约修订（需重开质量实验），不是 Phase B 变量。
- legitimate_exception 措辞方差（豁免条款有无的 repeat 间抖动）双臂皆存在；GPT6 复核 0 TRUE_CONTRADICTION。
