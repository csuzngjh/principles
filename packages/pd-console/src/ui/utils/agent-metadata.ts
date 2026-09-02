/**
 * Agent Metadata — Control Center agent grouping & role descriptions
 *
 * Pure data module (no React, no I/O). Defines:
 * - Which dependency cluster each of the 9 internal agents belongs to
 * - Bilingual role / detail / impact / tech-detail text for progressive disclosure
 * - Whether toggling the agent off requires inline confirmation (isCore)
 *
 * Content source: design-prototype/control-center.html (approved prototype).
 * Agent names match INTERNAL_AGENT_NAMES from @principles/core (camelCase).
 *
 * ERR entries:
 * - rc-1: pure static data, no untrusted input
 * - rc-2: no `as` bypasses
 * - rc-5: consumers use Object.hasOwn() to look up metadata by agent name
 */

import type { InternalAgentName } from '@principles/core/runtime-v2';

// ── Types ────────────────────────────────────────────────────────────────────

export type AgentGroup = 'core_trio' | 'code_chain' | 'quality_polish' | 'sidechain';
export type ImpactLevel = 'danger' | 'amber' | 'green';
export type GroupTag = 'must' | 'recommend' | 'optional' | 'independent';

export interface AgentMeta {
  name: InternalAgentName;
  group: AgentGroup;
  /** 中文角色名（如"诊断师"） */
  displayNameZh: string;
  displayNameEn: string;
  /** 一句话角色（L1 折叠态显示） */
  roleZh: string;
  roleEn: string;
  /** 展开后的详细说明（L2），段落用 \n\n 分隔 */
  detailZh: string;
  detailEn: string;
  /** 关掉会怎样（L2 impact box） */
  impactLevel: ImpactLevel;
  impactZh: string;
  impactEn: string;
  /** 技术细节（L3 嵌套折叠）— 键为标签，值可含反引号包裹的 code 片段 */
  techDetailZh: Record<string, string>;
  techDetailEn: Record<string, string>;
  /** 是否核心代理（关掉需 inline confirm）。true 对应原型 data-core="true" */
  isCore: boolean;
  /** MVP 状态说明（可选，仅 philosopher/rolloutReviewer 有） */
  mvpNoteZh?: string;
  mvpNoteEn?: string;
  /** 操作入口（可选，仅侧链代理用于跳转管理页面） */
  action?: ActionMeta;
}

/**
 * 操作入口（可选，仅侧链代理用于跳转管理页面）
 */
export interface ActionMeta {
  /** 链接文本（中） */
  linkTextZh: string;
  /** 链接文本（英） */
  linkTextEn: string;
  /** 路由路径 */
  to: string;
}

export interface AgentGroupMeta {
  id: AgentGroup;
  labelZh: string;
  labelEn: string;
  tag: GroupTag;
  tagLabelZh: string;
  tagLabelEn: string;
  hintZh: string;
  hintEn: string;
}

// ── Group order (matches render order on the page) ───────────────────────────

export const GROUP_ORDER: AgentGroup[] = [
  'core_trio',
  'code_chain',
  'quality_polish',
  'sidechain',
];

// ── Group metadata ───────────────────────────────────────────────────────────

export const AGENT_GROUPS: AgentGroupMeta[] = [
  {
    id: 'core_trio',
    labelZh: '核心三件套',
    labelEn: 'Core Trio',
    tag: 'must',
    tagLabelZh: '必须一起开',
    tagLabelEn: 'Must together',
    hintZh: '关掉任何一个，PD 都无法把错误转化为原则',
    hintEn: 'Disabling any one breaks the error-to-principle pipeline',
  },
  {
    id: 'code_chain',
    labelZh: '代码实现链',
    labelEn: 'Code Chain',
    tag: 'recommend',
    tagLabelZh: '推荐一起开',
    tagLabelEn: 'Recommend together',
    hintZh: '只开 artificer 会降级为纯提示通道；只开 evaluator 无意义',
    hintEn: 'Only artificer degrades to prompt-only; only evaluator is meaningless',
  },
  {
    id: 'quality_polish',
    labelZh: '质量打磨',
    labelEn: 'Quality Polish',
    tag: 'optional',
    tagLabelZh: '可选 · 单独开关',
    tagLabelEn: 'Optional · toggle individually',
    hintZh: '让原则更精炼，关掉也能用，只是质量略粗',
    hintEn: 'Refines principles; disabling is fine, just slightly rougher quality',
  },
  {
    id: 'sidechain',
    labelZh: '侧链服务',
    labelEn: 'Sidechain',
    tag: 'independent',
    tagLabelZh: '独立 · 单独开关',
    tagLabelEn: 'Independent · toggle individually',
    hintZh: '不影响主管道，只影响 pain 信号检测精度',
    hintEn: 'Does not affect the main pipeline; only pain signal detection precision',
  },
];

// ── Agent metadata (covers all 9 INTERNAL_AGENT_NAMES) ───────────────────────

export const AGENT_METADATA: Record<InternalAgentName, AgentMeta> = {
  diagnostician: {
    name: 'diagnostician',
    group: 'core_trio',
    displayNameZh: '诊断师',
    displayNameEn: 'Diagnostician',
    roleZh: '问"为什么会出错"，找到根本原因',
    roleEn: 'Asks "why did it go wrong" and finds the root cause',
    detailZh:
      '当 Agent 做错了什么，诊断师负责像事故复盘一样追问"为什么"，找到根本原因，而不是只记下"出错了"。然后把原因抽象成一条原则候选。\n\n它其实是 3 个子阶段串联：找根因 → 抽象原则 → 决定怎么处理。',
    detailEn:
      'When an Agent makes a mistake, the Diagnostician runs a post-mortem asking "why" to find the root cause — not just recording "it failed". It then abstracts the cause into a principle candidate.\n\nIt is actually 3 sub-stages chained: find root cause → abstract principle → decide how to handle.',
    impactLevel: 'danger',
    impactZh: 'Pain 信号无法进入内化管道。诊断是入口，关掉后整个流程瘫痪，无法生成新的原则候选。',
    impactEn: 'Pain signals cannot enter the internalization pipeline. Diagnosis is the entry point; disabling paralyzes the entire flow — no new principle candidates can be generated.',
    techDetailZh: {
      '输入': '`DiagnosticianContextPayload`（pain 信号上下文）',
      '输出': '`DiagnosticianOutputV1` · rootCause / violatedPrinciples / recommendations[] / confidence',
      // PRI-638: the split flag no longer selects an implementation nor
      // disables anything — the capability switch is the agent binding here.
      '编排': '由 `PainSignalBridge` 触发；开关 = 本页面的代理启用开关（`internalAgents.agents.diagnostician.enabled`）',
      '阶段': '`diag_rootcause` → `diag_distiller` → `diag_router`',
    },
    techDetailEn: {
      'Input': '`DiagnosticianContextPayload` (pain signal context)',
      'Output': '`DiagnosticianOutputV1` · rootCause / violatedPrinciples / recommendations[] / confidence',
      // PRI-638: the split flag no longer selects an implementation nor
      // disables anything — the capability switch is the agent binding here.
      'Orchestration': 'Triggered by `PainSignalBridge`; switch = this agent\'s enable toggle (`internalAgents.agents.diagnostician.enabled`)',
      'Stages': '`diag_rootcause` → `diag_distiller` → `diag_router`',
    },
    isCore: true,
  },

  dreamer: {
    name: 'dreamer',
    group: 'core_trio',
    displayNameZh: '梦想家',
    displayNameEn: 'Dreamer',
    roleZh: '想出 2-3 种不同的纠正方案',
    roleEn: 'Proposes 2-3 distinct correction options',
    detailZh:
      '诊断完成后，梦想家从不同角度提出多个纠正方案——就像 brainstorming，先发散再收敛。每个方案都包含"当时做错了什么 / 应该怎么做 / 为什么"。\n\n它是内化引擎的第一站，接收诊断产物，输出候选方案。',
    detailEn:
      'After diagnosis, the Dreamer proposes multiple correction options from different angles — like brainstorming, diverge first then converge. Each option includes "what went wrong / what should be done / why".\n\nIt is the first stop of the internalization engine, receiving diagnosis output and producing candidates.',
    impactLevel: 'danger',
    impactZh: '内化引擎失去入口。Dreamer 是链首，关掉后无候选方案生成，内化瘫痪。',
    impactEn: 'The internalization engine loses its entry point. Dreamer is the chain head; disabling means no candidates are generated — internalization is paralyzed.',
    techDetailZh: {
      '输入': '诊断阶段的 distilled principle / candidate artifact',
      '输出': '`DreamerOutput` · 1-5 个候选，每个含 badDecision / betterDecision / riskLevel / strategicPerspective',
      '注意': '`InternalizationAutoConsumerService` 当前仅自动消费 dreamer，下游需手动触发',
    },
    techDetailEn: {
      'Input': 'Distilled principle / candidate artifact from the diagnosis stage',
      'Output': '`DreamerOutput` · 1-5 candidates, each with badDecision / betterDecision / riskLevel / strategicPerspective',
      'Note': '`InternalizationAutoConsumerService` currently only auto-consumes dreamer; downstream must be triggered manually',
    },
    isCore: true,
  },

  scribe: {
    name: 'scribe',
    group: 'core_trio',
    displayNameZh: '抄写员',
    displayNameEn: 'Scribe',
    roleZh: '把方案写成正式的原则条文',
    roleEn: 'Writes the chosen option into a formal principle statement',
    detailZh:
      '梦想家给出多个方案后，抄写员负责把选中的方案转写成清晰、可执行的原则条文——就像把会议纪要整理成正式文档。\n\n这条原则文本是后续所有工作的承载者：评估员会反向溯源到这里做质量校验。',
    detailEn:
      'After the Dreamer proposes multiple options, the Scribe transforms the selected one into a clear, executable principle statement — like turning meeting notes into a formal document.\n\nThis principle text is the carrier for all downstream work: the Evaluator traces back here for quality checks.',
    impactLevel: 'danger',
    impactZh: '无原则文本产出。Scribe 是原则承载者，关掉后管道断裂，核心瘫痪。',
    impactEn: 'No principle text is produced. Scribe is the principle carrier; disabling breaks the pipeline — core is paralyzed.',
    techDetailZh: {
      '输入': 'Philosopher artifact（或 dreamer 直连）',
      '输出': '`ScribeOutputV1` · principleDraft + sourcePhilosopherArtifactId（lineage 强制校验）',
      '语言': '支持 Owner 偏好语言（`outputLanguage`，PRI-336）',
    },
    techDetailEn: {
      'Input': 'Philosopher artifact (or direct from dreamer)',
      'Output': '`ScribeOutputV1` · principleDraft + sourcePhilosopherArtifactId (lineage enforced)',
      'Language': 'Supports Owner preferred language (`outputLanguage`, PRI-336)',
    },
    isCore: true,
  },

  artificer: {
    name: 'artificer',
    group: 'code_chain',
    displayNameZh: '工匠',
    displayNameEn: 'Artificer',
    roleZh: '把原则变成可执行的拦截代码',
    roleEn: 'Turns the principle into executable interception code',
    detailZh:
      '原则写好后，工匠负责把它变成代码——一个 `evaluate()` 函数，会在 Agent 发起工具调用时拦截检查。这比"提示词"更刚性、更可靠。\n\n同时生成 golden trace 测试用例，确保代码行为符合预期。',
    detailEn:
      'Once the principle is written, the Artificer turns it into code — an `evaluate()` function that intercepts and checks Agent tool calls. This is more rigid and reliable than "prompt wording".\n\nIt also generates golden trace test cases to ensure the code behaves as intended.',
    impactLevel: 'amber',
    impactZh: '降级运行。退回纯 prompt 通道，principle 文本仍可内化，但无 RuleHost 实现代码。',
    impactEn: 'Degraded mode. Falls back to prompt-only channel; principle text can still be internalized, but no RuleHost implementation code.',
    techDetailZh: {
      '输入': 'Scribe artifact（principleDraft）',
      '输出': '`ArtificerRuleOutput` · implementationCode + goldenTraceCases + affectedTools',
      '信任边界': 'activation-capable，LLM 输出作 `unknown` 处理，validateOutput + lineage 通过才 commit',
      'L2 模式': '`rulehost-code-generation` flag 开启 write-test-fix 循环（沙盒回放 → 重试，最多 3 次）',
    },
    techDetailEn: {
      'Input': 'Scribe artifact (principleDraft)',
      'Output': '`ArtificerRuleOutput` · implementationCode + goldenTraceCases + affectedTools',
      'Trust boundary': 'activation-capable; LLM output treated as `unknown`; commit only after validateOutput + lineage pass',
      'L2 mode': '`rulehost-code-generation` flag enables write-test-fix loop (sandbox replay → retry, max 3)',
    },
    isCore: true,
  },

  evaluator: {
    name: 'evaluator',
    group: 'code_chain',
    displayNameZh: '评估员',
    displayNameEn: 'Evaluator',
    roleZh: '审查原则和代码质量，决定能否生效',
    roleEn: 'Reviews principle & code quality, decides whether it can activate',
    detailZh:
      '工匠写完代码后，评估员做质量审查：原则是否清晰？代码是否符合原则意图？有没有覆盖足够多的场景？\n\n给出 approved / needs_revision / rejected 决策。只有 approved 的原则才能通过 RuleHost 通道激活。',
    detailEn:
      'After the Artificer writes the code, the Evaluator does a quality review: is the principle clear? Does the code match the principle intent? Does it cover enough scenarios?\n\nIt returns an approved / needs_revision / rejected decision. Only approved principles can activate via the RuleHost channel.',
    impactLevel: 'amber',
    impactZh: '降级运行。Principle 仍写入，但无 validated 标记，RuleHost 通道无法激活。',
    impactEn: 'Degraded mode. Principle is still written, but without the validated mark — RuleHost channel cannot activate.',
    techDetailZh: {
      '输入': 'Artificer artifact + Scribe artifact（反向溯源 principle 文本）',
      '输出': '`EvaluatorOutputV1/V2` · decision + score + strengths/concerns + codeReview',
      'V2 模式': '运行 adversarial sandbox replay，通过则持久化 `artifactKind: "rule"` artifact',
    },
    techDetailEn: {
      'Input': 'Artificer artifact + Scribe artifact (reverse-traces principle text)',
      'Output': '`EvaluatorOutputV1/V2` · decision + score + strengths/concerns + codeReview',
      'V2 mode': 'Runs adversarial sandbox replay; on pass, persists `artifactKind: "rule"` artifact',
    },
    isCore: true,
  },

  philosopher: {
    name: 'philosopher',
    group: 'quality_polish',
    displayNameZh: '哲学家',
    displayNameEn: 'Philosopher',
    roleZh: '从多个方案中选出最优并精炼',
    roleEn: 'Selects the best option from multiple candidates and refines it',
    detailZh:
      '梦想家给出多个方案后，哲学家负责收敛——选出最优的一个，精炼成单一原则候选。\n\n关掉它，梦想家的产出会直接交给抄写员，原则可能略粗糙，但人工审批时仍可修改。',
    detailEn:
      'After the Dreamer proposes multiple options, the Philosopher converges — selects the best one and refines it into a single principle candidate.\n\nDisabling it means the Dreamer output goes directly to the Scribe; principles may be slightly rougher, but can still be edited during Owner review.',
    impactLevel: 'green',
    impactZh: '无影响。Dreamer 产出直接给 Scribe，质量略粗但人工审批可纠正。属设计预期。',
    impactEn: 'No impact. Dreamer output goes directly to Scribe; slightly rougher quality but Owner review can correct. This is by design.',
    techDetailZh: {
      'MVP 状态': 'MVP-Quiet（ADR-0014 §2.5）。默认关闭，代码保留。',
      '输出': '`PhilosopherOutputV1` · principleCandidate + sourceDreamerArtifactId',
    },
    techDetailEn: {
      'MVP status': 'MVP-Quiet (ADR-0014 §2.5). Off by default; code retained.',
      'Output': '`PhilosopherOutputV1` · principleCandidate + sourceDreamerArtifactId',
    },
    isCore: false,
    mvpNoteZh: 'MVP-Quiet（ADR-0014 §2.5）。默认关闭，代码保留。',
    mvpNoteEn: 'MVP-Quiet (ADR-0014 §2.5). Off by default; code retained.',
  },

  rolloutReviewer: {
    name: 'rolloutReviewer',
    group: 'quality_polish',
    displayNameZh: '上线评审员',
    displayNameEn: 'Rollout Reviewer',
    roleZh: '原则生效前的最后一道审查',
    roleEn: 'Final review before a principle goes live',
    detailZh:
      '评估员通过后，上线评审员做最终把关——评估上线风险、安全检查，决定是否真的推向 rollout。\n\n它在 MVP_CORE_TASK_KINDS 白名单中（队列可见），但 auto-consumer 不会自动推进它——作为原则进入 approval 队列前的最后一道人工关，由 Owner 手动触发。',
    detailEn:
      'After the Evaluator passes, the Rollout Reviewer does the final gate — assessing rollout risks and safety checks, deciding whether to actually push to rollout.\n\nIt is in the MVP_CORE_TASK_KINDS whitelist (visible in the queue), but the auto-consumer does NOT advance it — it is the last manual Owner gate before the approval queue, triggered by hand.',
    impactLevel: 'green',
    impactZh: '手动触发的最后关。不被 auto-consumer 自动消费。',
    impactEn: 'Manual last gate. Not auto-consumed by the auto-consumer.',
    techDetailZh: {
      'MVP 状态': 'MVP-Core（手动）。在 `MVP_CORE_TASK_KINDS` 中，但不被 auto-consumer 自动推进——由 Owner 手动触发（`pd runtime internalization run-once --runner rollout_reviewer`）。',
      '输出': '`RolloutReviewerOutputV1` · approve_rollout / needs_revision / reject + rolloutRisks + safetyChecks',
      '实现': '唯一不继承 `BasePeerRunner` 的 peer runner',
    },
    techDetailEn: {
      'MVP status': 'MVP-Core (manual). In `MVP_CORE_TASK_KINDS`, but NOT auto-advanced — triggered by hand (pd runtime internalization run-once --runner rollout_reviewer).',
      'Output': '`RolloutReviewerOutputV1` · approve_rollout / needs_revision / reject + rolloutRisks + safetyChecks',
      'Implementation': 'The only peer runner that does not extend `BasePeerRunner`',
    },
    isCore: true,
    mvpNoteZh: 'MVP-Core（手动触发）。在白名单中但不被 auto-consumer 自动消费。',
    mvpNoteEn: 'MVP-Core (manual trigger). In the whitelist but not auto-consumed.',
  },

  correctionObserver: {
    name: 'correctionObserver',
    group: 'sidechain',
    displayNameZh: '纠正观察员',
    displayNameEn: 'Correction Observer',
    roleZh: '后台优化"纠错关键词"，减少误报',
    roleEn: 'Background optimizer for "correction keywords", reducing false positives',
    detailZh:
      'PD 用一组关键词检测 Agent 是否在被纠正。但关键词会过时或误报。纠正观察员定期审查历史，自动调整关键词权重，衰减误报。\n\n它在后台每 15 分钟跑一次，不影响主管道。',
    detailEn:
      'PD uses a set of keywords to detect whether an Agent is being corrected. But keywords go stale or produce false positives. The Correction Observer periodically reviews history, auto-adjusting keyword weights and decaying false positives.\n\nIt runs in the background every 15 minutes and does not affect the main pipeline.',
    impactLevel: 'amber',
    impactZh: '纠错关键词停止自优化。确定性 pain 检测仍工作，但误报会逐步累积。',
    impactEn: 'Correction keywords stop self-optimizing. Deterministic pain detection still works, but false positives gradually accumulate.',
    techDetailZh: {},
    techDetailEn: {},
    isCore: true,
    action: {
      linkTextZh: '管理关键词',
      linkTextEn: 'Manage Keywords',
      to: '/control-center/signal-keywords?category=correction',
    },
  },

  empathyObserver: {
    name: 'empathyObserver',
    group: 'sidechain',
    displayNameZh: '共情观察员',
    displayNameEn: 'Empathy Observer',
    roleZh: '从用户语气中捕捉传统检测漏掉的挫败感',
    roleEn: 'Catches frustration that traditional detection misses',
    detailZh:
      '传统 pain 检测只能抓"命令失败""抛异常"这类硬错误。但用户说"又来了""怎么还是这样"时，其实已经很不满意了——这种情感摩擦硬检测抓不到。\n\n共情观察员用语义分析实时捕捉这类信号，弥补检测盲区。',
    detailEn:
      'Traditional pain detection only catches hard errors like "command failed" or "exception thrown". But when a user says "here we go again" or "why is this still happening", they are already frustrated — this emotional friction is invisible to hard detection.\n\nThe Empathy Observer uses semantic analysis to catch these signals in real time, covering the detection blind spot.',
    impactLevel: 'amber',
    impactZh: '退回纯确定性 pain 检测。常规对话下 pain 触发稀疏，内化速度显著下降。',
    impactEn: 'Falls back to deterministic-only pain detection. In normal conversation, pain triggers become sparse — internalization speed drops significantly.',
    techDetailZh: {},
    techDetailEn: {},
    isCore: true,
    action: {
      linkTextZh: '管理关键词',
      linkTextEn: 'Manage Keywords',
      to: '/control-center/signal-keywords?category=empathy',
    },
  },
  signalCollector: {
    name: 'signalCollector',
    group: 'sidechain',
    displayNameZh: '信号采集器',
    displayNameEn: 'Signal Collector',
    roleZh: '统一捕捉用户纠正与情绪反馈（合并原 correction + empathy）',
    roleEn: 'Unified capture of user corrections and emotional feedback (merges former correction + empathy)',
    detailZh:
      '以前有两套并行的用户反馈检测：correction（抓"你错了"）和 empathy（抓情绪挫败），词库重叠且各自维护。\n\n信号采集器把两者合并成一套：关键词快扫 + 本地 LLM 深度判断，按信号强度分流——明确纠错直接触发诊断，情绪推测走 GFI 累积。',
    detailEn:
      'Previously there were two parallel user-feedback detectors: correction (catching "you are wrong") and empathy (catching emotional frustration), with overlapping keyword stores maintained separately.\n\nThe Signal Collector merges them into one: keyword fast-scan + local LLM deep judgment, routed by signal strength — explicit corrections trigger diagnosis directly, emotional inference accumulates via GFI.',
    impactLevel: 'amber',
    impactZh: '退回纯关键词检测（高精度短语仍工作），LLM 深度判断关闭。歧义词和未命中场景召回率下降。',
    impactEn: 'Falls back to keyword-only detection (high-precision phrases still work); LLM deep judgment disabled. Recall drops for ambiguous terms and missed cases.',
    techDetailZh: {},
    techDetailEn: {},
    isCore: false,
  },
};
