# PRI-815 — Owner Blind Calibration Pairs (async, non-blocking)

> 每个 pair 里 X/Y 的臂归属已随机打乱且记录在文末封存行。Owner 只需对每个 pair 回答：**X 更好 / Y 更好 / 无实质差异 / 两者都不好**。
> 此包不阻塞后端结论；用于 Owner 复核 automated judge 的 calibration（SPEC §22）。

## R1（G-pain_host_620a1683e2eeb7 r3）

### X
```json
{
 "principleDraft": {
  "title": "Anchor repetitive loops to self-detected termination on observed completion signals",
  "statement": "Any repetitive or iterative action must carry its own termination: before entering a wait/poll/retry/monitor loop, declare the observable completion condition, and before each subsequent iteration, re-check the latest state signals against it; as soon as the latest observable evidence shows the awaited condition is met (e.g., a signal that all subagents have settled), stop the loop immediately and proceed to the next phase instead of continuing until an external correction intervenes.",
  "rationale": "The diagnosed root cause is a wait loop whose continuation was driven by the originally planned sequence rather than the observed goal state: the assistant kept calling sessions_yield after signal_collector had already reported all subagents settled, stopping only under a severe external correction. Making continuation contingent on an explicit termination predicate re-checked against the latest evidence makes convergence self-detected, eliminating idle repetition, wasted calls, and dependence on external intervention. This is a specialization of T-03 and T-07 to iterative loops, not a replacement for them.",
  "applicability": [
   "Multi-agent coordination waits, e.g., polling/yielding while subagents run before collecting their results",
   "Polling or monitoring loops that wait for a state change or completion signal observable between iterations",
   "Retry loops whose success or terminal failure is observable between attempts",
   "Open-ended waits where a signal collector or system message reports the awaited condition"
  ],
  "antiPatterns": [
   "Issuing the same wait/poll call (e.g., sessions_yield) again after an in-context signal has already reported the awaited condition met, such as 'all subagents settled, do not wait'",
   "Running a loop with no internal termination predicate, relying on external system correction to stop it",
   "Deciding each iteration from the originally planned sequence while ignoring newer state messages returned since entering the loop",
   "Treating a wait-for-completion step as a fixed procedural stage that runs to exhaustion regardless of observed completion"
  ],
  "confidence": 0.8
 },
 "intentContract": {
  "ownerIntent": "The owner wants the agent to stop repetitive waiting/polling on its own the moment observable state shows the awaited condition is met (such as 'all subagents settled'), rather than repeating the call until a severe external correction forces it to stop.",
  "targetBehavior": "In the tool trajectory, no wait/poll call (e.g., sessions_yield) appears after a completion signal for the awaited condition is already present in context; instead the agent visibly checks the latest signal, recognizes the condition as met, and transitions to the next phase (e.g., result collection).",
  "forbiddenBehavior": "Continuing to issue repeated wait/poll calls after an explicit completion signal ('all subagents settled, stop waiting') has already been observed — a repetition loop with no internal termination that persists until external correction.",
  "evidenceSource": "Severe user-correction pain pain_host_620a1683e2eeb7a714ce5eb67aac55b08dc8bee7164211358c5f00f308068791: the after_tool_call hook caught the assistant calling sessions_yield after signal_collector reported all subagents settled and instructed it to stop waiting; the diagnosis attributes this to ignoring observable state (T-03) and missing post-action verification (T-07), and all four Dreamer candidates converge on evidence-based, self-detected loop termination.",
  "validationExpectation": "An evaluator should require that any rule generated from this principle fires on a repeated wait/poll call issued after an in-context completion signal (e.g., sessions_yield following 'all subagents settled'), while permitting waits for which no completion evidence exists yet; rules that block legitimate waiting without a completion signal, or force exit on ambiguous or partial signals, contradict this intent and must be flagged rather than merged."
 },
 "risks": [
  "Closely overlaps core axioms T-03 (act on observable evidence) and T-07 (verify outcomes against intent): this principle is their specialization to repetitive loops, so downstream rules must target loop termination specifically to avoid duplicating existing axiom coverage",
  "A loosely defined termination predicate can trigger premature exit on false-positive completion signals (misreading partial or stale signals as full completion), stopping work before the goal is truly achieved",
  "Mandating a declared predicate for every trivial fixed-step loop adds ceremony that conflicts with T-06 (simplest intervention); scope should stay on open-ended or discretionary repetition",
  "Re-reading and re-evaluating all context signals on every iteration of high-frequency loops may consume excessive attention; the per-iteration check should be limited to completion-relevant signals"
 ]
}
```

### Y
```json
{
 "principleDraft": {
  "title": "Anchor iterative loops to explicit termination predicates re-checked against latest evidence",
  "statement": "Before entering any repetitive or iterative action (wait, poll, retry, monitor, coordinate), declare an explicit termination predicate defining observable success conditions and bounded abort conditions; after every iteration, evaluate that predicate against freshly observed state signals rather than the original plan, and exit the loop immediately when any declared condition holds.",
  "rationale": "The diagnosed root cause is an open-ended loop whose continuation was driven by the originally planned sequence rather than by observed goal state, causing idle repetition that persisted past the achieved goal until an external system intervened. Pre-declaring observable completion conditions and re-grounding each iteration's continue/exit decision in the latest state makes convergence self-detected, eliminating wasted iterations, resource burn, and dependence on external correction.",
  "applicability": [
   "Wait/poll loops checking whether a condition has become true (resource availability, service readiness, job or build completion)",
   "Retry loops for flaky operations, which require bounded attempts or backoff with a declared give-up condition",
   "Monitoring and health-check loops that must stop when the monitored state is achieved or declared unrecoverable",
   "Multi-agent coordination loops where an agent waits on peers, locks, or shared state before proceeding",
   "Any iterative process that consumes resources (API calls, compute, tokens, attention) between iterations"
  ],
  "antiPatterns": [
   "Continuing a loop solely because the plan scheduled more iterations while the goal condition has already been observed true",
   "Open-ended polling with no declared success or abort predicate, terminated only by external timeout or intervention",
   "Deciding each iteration from stale or initially fetched state instead of re-querying the live signal",
   "Treating repetition count or elapsed effort as evidence of progress toward the goal",
   "Retrying indefinitely after persistent failure without a bounded abort condition"
  ],
  "confidence": 0.83
 },
 "intentContract": {
  "ownerIntent": "The Owner wants to prevent agents from mechanically repeating a wait/poll/retry action after the goal is already achieved (or provably unreachable), burning resources until an external system intervenes.",
  "targetBehavior": "Before starting a loop, the agent explicitly states the observable completion and abort conditions it will check; in its tool trajectory, each iteration is followed by a fresh observation of the relevant state signal, and the agent exits the loop as soon as a declared condition holds.",
  "forbiddenBehavior": "Open-ended mechanical repetition — polling, waiting, or retrying driven by the planned iteration sequence or inertia, without re-checking current state, continuing past achieved goals or provably dead ends until an external system stops it.",
  "evidenceSource": "The diagnosed pain (pain_host_620a1683e2eeb7-r3, dreamer and philosopher analysis) of a wait/poll loop lacking an internal, evidence-based termination predicate that persisted past its achieved goal until external intervention.",
  "validationExpectation": "An evaluator should accept a rule only if it names (a) a pre-declared observable termination predicate covering both success and abort conditions and (b) per-iteration re-evaluation against fresh state signals before continuing; a rule that generically restates 'verify results' or duplicates T-07/T-03 without loop-specific termination semantics should be rejected, and any repair that removes the pre-declaration or fresh-signal requirement contradicts this intent."
 },
 "risks": [
  "Substantial overlap with core axioms T-07 (verify outcomes against intent) and T-08-adjacent feedback use, and T-03 (act on observable evidence); this principle is their specialization to iterative loops, and rule generation must add loop-specific value rather than restating those axioms",
  "A loosely defined termination predicate can fire on false-positive completion signals, causing premature exit before the goal is truly achieved",
  "Mandating explicit predicates for every trivial loop adds ceremony and overhead, in tension with the simplicity intent of T-06",
  "Re-reading and re-evaluating all signals on every iteration may be costly in high-frequency loops; predicate checks should be proportionate to loop cost",
  "The completion condition may not be directly observable, forcing proxies that can mislead the predicate toward premature or late exit",
  "Risk of over-generalizing from a single diagnosed pain case; downstream rules must stay anchored to the observed failure family rather than punishing all repetition"
 ]
}
```

## R2（G-manual_1788424714466_wmn r2）

### X
```json
{
 "principleDraft": {
  "title": "Convert Recurring Manual Verification of Hard Constraints into Automated Evidence-Emitting Gates",
  "statement": "Whenever a hard constraint (gate, acceptance criterion, or compliance check) is verified primarily through recurring manual human checking, it must be migrated into an automated, self-enforcing gate that executes the check mechanically and persists a structured pass/fail result; the constraint may be declared satisfied only by reconciling that persisted evidence against the expected criteria — never by assuming a manual step was diligently performed.",
  "rationale": "The diagnosed root cause was that hard constraints existed as implicit process knowledge executed via manual checking, so human omission had no structural barrier and left no auditable result record. Automating the check removes dependence on human diligence, and persisting structured pass/fail evidence makes every verification observable, re-checkable, and reconcilable against intended criteria. Recurrence of severe manual friction is treated as the design-defect signal that triggers this structural migration, rather than as an operational cost to be repeatedly paid.",
  "applicability": [
   "Release gates, merge checks, and graduation/deployment criteria currently verified by manual human checking",
   "Recurring compliance or security validations executed against a fixed, codable rubric or schedule",
   "Recurring manual sign-offs where the checker follows a mechanical rubric rather than exercised judgment",
   "Any hard constraint whose dominant failure mode is 'the human forgot or skipped the check'"
  ],
  "antiPatterns": [
   "Re-executing the same manual checklist across sessions while treating the friction as normal operational cost",
   "Declaring a hard constraint satisfied based on the assumption that a manual step was performed, with no persisted pass/fail record",
   "Gates whose results exist only in transient console output with no persistent, structured, re-checkable record",
   "Silent human overrides of a failed gate without an audited override record",
   "Automating a constraint before its criteria are sufficiently modeled, enshroring wrong criteria in a structurally enforcing gate"
  ],
  "confidence": 0.8
 },
 "intentContract": {
  "ownerIntent": "The Owner wants hard constraints like graduation criteria enforced by automated, self-enforcing gates that persist structured pass/fail evidence, instead of depending on a human remembering to run a manual check.",
  "targetBehavior": "On the second or later occurrence of manually verifying the same hard constraint, the agent implements an automated gate that executes the check and writes a structured pass/fail result to a persistent artifact, then cites that record — reconciled against the expected criteria — as the verification evidence.",
  "forbiddenBehavior": "Repeatedly performing the same manual verification of a hard constraint across sessions and marking the constraint satisfied without any persisted, machine-checkable pass/fail record.",
  "evidenceSource": "Diagnosis that graduation criteria existed only as implicit process knowledge checked manually, so human omission had no structural barrier and produced no auditable result record (philosopher artifact pi-art-philosopher-pri815-G-manual_1788424714466_wmn-r2-run1, distilling the Dreamer's recurring-manual-friction insight).",
  "validationExpectation": "An evaluator should accept a rule only if it (a) triggers on recurrence of a mechanical manual check of a hard constraint, (b) requires an automated gate that persists a structured pass/fail record, and (c) requires reconciling that record against expected criteria before declaring satisfaction; rules that mandate automating one-off or judgment-based checks, or that merely restate T-05/T-08 without the recurrence-trigger or evidence-emission delta, should be rejected as duplicative or unfaithful."
 },
 "risks": [
  "Substantial overlap with core axiom T-05 (constraints as explicit guardrails) and T-08 (friction as feedback); the distinct delta is only the recurrence trigger plus the persistent structured-evidence requirement, so downstream rule generation must scope rules to that delta to avoid duplicating existing axioms",
  "Premature automation can fossilize an incompletely understood constraint (conflicts with T-01): automating before sufficiently modeling the criteria can enshrine wrong checks that structurally block legitimate work",
  "Automated gates may reject valid edge cases requiring human judgment; an unauditable or silent human-override path reintroduces the very omission risk the automation was meant to remove",
  "For low-frequency checks, building automation violates T-06 (simplest intervention); migration must be justified by demonstrated recurrence and severity of the manual pain",
  "A faulty gate that always passes creates false confidence worse than manual checking (T-07); the gate's own correctness must be verified against ground truth at least once after construction",
  "If 'structured' and 'persistent' are left loosely defined, agents may satisfy the letter (a transient log line) while missing the spirit (re-checkable evidence)"
 ]
}
```

### Y
```json
{
 "principleDraft": {
  "title": "Automate recurring manual verification of hard constraints as blocking, evidence-emitting gates",
  "statement": "Whenever a hard constraint or acceptance criterion (graduation, release, merge, compliance, sign-off gates) is verified primarily by manual human checking — especially when the same severe manual friction recurs — convert that verification into an executable, self-enforcing automated gate: encode each criterion as an explicit check, block the gated transition until the check passes, and emit a persistent structured pass/fail record that is reconciled against the expected criteria. Manual review may remain only as a supplementary check after the automated gate passes, never as the sole barrier; recurrence of severe manual pain on the same gate is the trigger for this structural migration, not a cue to repeat the manual effort.",
  "rationale": "The diagnosed root cause was that graduation criteria existed only as implicit process knowledge executed via manual checking: human omission had no structural barrier and produced no auditable result record, and completion of manual verification was never reconciled against the expected criteria. Encoding criteria as executable blocking checks removes the omission risk; persisting structured pass/fail results makes every verification observable, re-checkable, and reconcilable (execution is not success until results are compared with intent); and treating recurring severe manual friction as a design-defect signal for structural migration stops the system from repeatedly paying the same manual cost for the same flaw.",
  "applicability": [
   "Hard-constraint gates and acceptance criteria currently verified by manual human checking (e.g., PRI-650-A Gate B graduation verification, release gates, merge checks, compliance validations, recurring manual sign-offs)",
   "Situations where the same manual verification friction recurs across sessions with severe impact",
   "Constraints that are objectively expressible as checkable criteria (objective pass/fail standards)",
   "Out of scope: one-off validations and genuinely judgment-based evaluations that cannot be encoded as executable checks"
  ],
  "antiPatterns": [
   "Passing a hard-constraint gate on manual inspection alone, with no executable check and no persisted pass/fail record",
   "Treating completion of a manual verification as success without reconciling actual results item-by-item against the expected criteria",
   "Leaving hard constraints as implicit process knowledge or documentation with nothing that structurally blocks the gated transition when criteria are unmet",
   "Responding to recurring severe manual verification pain by repeating the same manual effort instead of automating the check",
   "Automation without evidence: a gate that emits no persistent structured result, or whose always-pass behavior is never verified against ground truth"
  ],
  "confidence": 0.7
 },
 "intentContract": {
  "ownerIntent": "The Owner wants graduation-style hard-constraint verifications (like PRI-650-A Gate B) to stop passing on manual human diligence alone and instead be enforced by automated, blocking checks that produce persistent, auditable pass/fail evidence.",
  "targetBehavior": "When the agent encounters a hard-constraint gate verified manually (especially with recurring severe friction), it builds or requires an executable automated check that evaluates each criterion, blocks the gated action on failure, and writes a structured pass/fail log reconciled against the expected criteria; any manual review happens only after the gate passes.",
  "forbiddenBehavior": "Allowing a hard-constraint gate to be passed solely by human diligence — manual execution with no automated barrier, no structural blocking when criteria are unmet, and no persisted structured result for reconciliation — and repeating that manual effort each time the pain recurs.",
  "evidenceSource": "Diagnosis diagnosis_manual_1788424714466_wmn09nli (rootCause: Gate B graduation verification designed as a manual process lacking automated gate and rule-based checks; violatedPrinciples T-05, T-07, T-03) and pain manual_1788424714466_wmn09nli reported via owner_reported:cli as PRI-650-A Gate B graduation verification (manual pain), status severe, no host session trace.",
  "validationExpectation": "An evaluator should accept a rule as faithful only if it (a) triggers on manually-verified hard-constraint gates such as Gate B graduation checks, (b) mandates an executable blocking check plus persisted structured pass/fail results reconciled against expected criteria, and (c) stays bounded — it must not extend to one-off or judgment-only evaluations, nor drop the blocking or evidence-persistence requirement; a change that contradicts any of these is flagged rather than implemented."
 },
 "risks": [
  "Overlaps with core axiom T-05 (constraints as explicit guardrails and forbidden transitions) and T-08 (friction as feedback); the distinct contribution is only the linkage of recurring severe manual pain to guardrail automation with persisted evidence, so downstream rule generation may duplicate rather than extend existing axioms",
  "Premature automation can fossilize an incompletely understood constraint (conflict with T-01): the diagnosis could not confirm Gate B's exact failure mechanism, and encoding criteria too early could enshrine wrong checks that structurally block legitimate work",
  "Thin evidence base: a single owner_reported:cli pain with no host session trace and diagnosis confidence 0.55 — the principle may over-generalize from one severe pain report",
  "Automated gates may reject valid edge cases requiring human judgment; an unauditable human-override path reintroduces the original omission risk the automation was meant to remove",
  "For low-frequency checks, building automation may violate T-06 (simplest intervention) — automation cost must be justified by recurrence and severity of the manual pain",
  "A broken gate that always passes creates false confidence worse than manual verification (conflict with T-07): the gate's own outputs must be verified against ground truth"
 ]
}
```

## R3（G-manual_1788920022087_pjz r2）

### X
```json
{
 "principleDraft": {
  "title": "状态闭环门禁：变更前建模、变更后验证传播、完成宣称须持实测证据",
  "statement": "对持久化外部系统（文件系统、长驻服务、运行时缓存/输入目录）执行多步操作时：(1) 变更前先建模并预置检查——编辑前读取目标文件确认确切锚点文本，访问媒体前核对允许目录与实际缓存路径布局，长驻服务独立于带超时的 exec 会话启动且每批任务前探测存活；(2) 变更后验证状态已传播至所有消费方——源目录变更后显式同步运行时输入/缓存目录并以哈希或 mtime 复核通过后才入队消费；(3) 任何『已完成/已生效/已提交/已同步』宣称必须以实测证据（输出实测、落盘状态/回执、日志复核）为门禁，证据缺失时暂停宣称、先补验证；(4) 修复选型确定性根因手段优先——先定位确切文本锚点做精确修改并验证生效，仅当确定性修复被证据证明无效后才回退到重试类概率性手段。",
  "rationale": "五类实测失误（无证据的完成宣称、长驻服务置于超时会话被杀、源目录与运行时输入目录未同步读到旧图、发音问题偏好再掷重渲、未确认锚点/路径即执行）的共同根因是行为建立在『假设的状态』而非『验证过的状态』之上。将假设转化为变更前建模、变更后传播验证、宣称证据门禁、确定性修复优先这四个强制检查点，可在源头拦截谎报与未闭环失误，而非事后归因与重复返工。",
  "applicability": [
   "对文件系统执行依赖文本锚点匹配的编辑操作",
   "在长驻服务（如 ComfyUI 渲染服务）上提交批量任务并跟踪队列执行",
   "源目录与运行时输入/缓存目录需保持一致的场景（如 keyframes 到 ComfyUI/input 的同步）",
   "渲染、构建、提交等长流水线任务中作出完成宣称的节点",
   "访问受允许目录约束的媒体/缓存路径"
  ],
  "antiPatterns": [
   "宣称『已生效/已提交/已完成』时未绑定任何实测证据（如宣称 head_trim 生效却未实测成片时长，宣称已提交却无落盘回执）",
   "把长驻服务置于带超时的 exec 会话内运行，且在后续批次前假设服务仍存活而不探测",
   "源目录（keyframes）换图后仅归档而不同步运行时输入目录（ComfyUI/input），未以哈希/mtime 复核即入队渲染",
   "修复选型直接采用再掷/重渲等概率性重试，而非先定位文本根因做确定性修改并验证生效",
   "未先读取目标文件确认锚点即直接 edit；未核对允许目录与实际缓存布局即访问媒体路径"
  ],
  "confidence": 0.85
 },
 "intentContract": {
  "ownerIntent": "Owner 要防止 Agent 基于假设状态行动与宣称：完成宣称必须以实测证据闭环验证，长驻服务生命周期与『源目录→运行时缓存目录』一致性必须正确建模并显式同步，修复选型优先确定性根因手段而非概率性重试。",
  "targetBehavior": "合规 Agent 的工具轨迹可见：编辑前先读取目标文件确认锚点文本；访问媒体前核对允许目录与缓存布局；长驻服务以分离/后台方式启动且每批任务前探测存活；源目录变更后显式同步运行时输入目录并以哈希/mtime 复核；每次『已完成/已生效/已提交/已同步』宣称前取得实测证据（输出实测、落盘回执、日志复核）；修复时先做确定性文本级修改并验证生效。",
  "forbiddenBehavior": "未取得可观察证据即宣布完成/生效/提交/同步（谎报生效、提交丢失无察觉）；假设长驻服务仍存活或将长驻服务置于有超时的 exec 会话；源目录变更后不同步运行时输入目录即让下游消费（读到旧图）；未定位根因即优先再掷/重渲等概率性重试；未确认锚点存在即 edit、未核对允许目录即访问媒体。",
  "evidenceSource": "EP002 诊断（diagnosis_manual_1788920022087_pjzfw9wt）的实测证据：宣称 head_trim 生效未实测成片时长、石条版提交在长回复中断中丢失；8 枚渲染队列的长驻 ComfyUI 服务被 600s 超时 exec 会话连带杀掉（head_silence 配置失败佐证）；KF14 换新归档 keyframes 未同步 ComfyUI/input 致 LoadImage 读旧图；scene-03 发音选型再掷而非修改 gen_prompts.py 文本根因；edit 锚点匹配失败与 view_image 路径越界两次工具失败。",
  "validationExpectation": "评估者应要求派生规则覆盖四个门禁点且与之一致——(1) 完成宣称前的证据门禁（明确何种实测证据可接受），(2) 变更前建模检查（锚点读取、允许目录核对、长驻服务与超时会话解耦及批次前存活探测），(3) 变更后源目录到运行时目录的同步与哈希/mtime 复核，(4) 修复确定性优先及回退条件；仅覆盖宣称门禁而遗漏生命周期建模、同步验证或确定性选型的规则应判为不忠实，任何与此期望矛盾的修改应被标记而非直接实施。"
 },
 "risks": [
  "与核心公理 T-01/T-03/T-06/T-07/T-10 存在部分重叠：本原则是它们在『前置建模—变更传播—完成宣称—修复选型』全链路上的链式综合强化，固化时须明确边界（新增的是门禁链结构而非单点要求）以免重复计数",
  "四个门禁点合并为单条原则范围较宽，规则生成阶段可能需按门禁点拆分，否则触发模式覆盖不全",
  "过度验证增加执行开销，在低风险、可快速回滚的场景中可能拖慢迭代节奏",
  "证据门禁可能被形式化满足（如仅查看单行日志）而未真正确认端到端效果",
  "确定性修复优先若根因定位成本过高，可能延误采用概率性手段及时止损的时机"
 ]
}
```

### Y
```json
{
 "principleDraft": {
  "title": "状态闭环门禁：变更前建模、变更后验证传播、宣称须持实测证据",
  "statement": "对任何外部持久化系统（文件系统、长驻服务、运行时缓存/输入目录）执行多步变更时，必须维持完整的状态闭环：(1) 执行前先构建目标系统的可观察模型——确认编辑锚点存在、路径布局正确、服务生命周期状态已知，并预设检查点；(2) 每次变更后验证新状态已传播至所有消费方——重读目标文件内容、探活后台守护服务、检查运行时缓存目录；(3) 任何『已完成/已生效/已提交』宣称必须以紧邻的实测证据（读取输出、探活结果、提交回执）为门禁，命令退出码或意图本身不构成证据；(4) 当变更未生效时，优先定位并消除确定性根因，而非立即概率性重试。",
  "rationale": "诊断出的五类失误（假设服务仍存活、假设缓存已含新内容、无证据的完成宣称、依赖重试收敛、编辑锚点不存在仍执行）共享同一根因：行为建立在『假设的状态』而非『验证过的状态』之上。将每一处隐式假设转化为各阶段的强制检查——前置建模拦截锚点错误、传播验证拦截隐藏消费方失同步、证据门禁拦截谎报、确定性优先拦截无效重试——可在源头拦截失败，而非事后归因与重复返工。可信度来自与可观察状态的闭环，而非意图本身。",
  "applicability": [
   "对外部持久化系统（文件系统、长驻守护服务、运行时缓存/输入目录）执行多步操作的任何任务",
   "渲染、构建、提交等长流水线任务中需作出完成宣称的阶段",
   "变更存在隐藏消费方（后台服务、缓存层）且其同步状态不可直接观察的变更场景",
   "变更未生效需要选择修复手段（确定性根因修复 vs 概率性重试）时"
  ],
  "antiPatterns": [
   "在未读取实际文件内容或探活服务的情况下宣称『已完成/已生效/已提交』",
   "假设后台守护服务仍存活或运行时缓存已刷新，而不执行传播验证",
   "仅凭命令退出码或单行日志即确认端到端效果",
   "变更未生效时立即概率性重试，而不定位确定性根因",
   "在未确认编辑锚点（文件路径、配置结构）存在前直接执行写入或编辑",
   "以『我打算写入/应该已生效』等意图陈述作为完成依据"
  ],
  "confidence": 0.85
 },
 "intentContract": {
  "ownerIntent": "Owner 希望杜绝 agent 在未实测验证目标系统状态（文件内容、服务存活、缓存传播、提交回执）的情况下宣称任务已完成或变更已生效，从而消除谎报与未闭环返工。",
  "targetBehavior": "在工具调用轨迹中可见：变更前读取锚点并检查服务生命周期；每次变更后主动重读目标文件、探活后台守护服务、检查运行时缓存目录以确认状态传播；每个『已完成/已生效』宣称都紧随一条实测证据（读取输出、探活结果、回执）之后；变更未生效时先做根因定位再选修复手段。",
  "forbiddenBehavior": "在没有任何实测证据支撑的情况下发出完成/生效/提交宣称；假设隐藏消费方（守护服务、缓存层）已自动同步；仅凭退出码或意图确认效果；以及变更未生效时用概率性重试替代确定性根因修复。",
  "evidenceSource": "梦者/哲人分析归纳的五类实际失误：假设服务仍存活、假设缓存已含新内容、无证据的完成宣称、依赖概率性重试收敛、编辑锚点不存在仍执行编辑。",
  "validationExpectation": "评审者应能沿工具轨迹为每个完成宣称找到其紧邻之前的实测证据步骤（文件读取、服务探活、回执检查）；若某条规则允许仅凭命令退出码、单行日志或意图陈述即宣称完成，则该规则与意图相悖，应被标记而非采纳。"
 },
 "risks": [
  "与核心公理 T-01（前置建模）、T-03（可观察证据）、T-07（变更后验证）存在显著重叠：本原则是三者叠加确定性修复优先在『建模—传播—宣称—修复』全链路上的综合强化，固化时必须明确与公理体系的边界，避免重复计数或规则冲突",
  "证据门禁可能被形式化满足（如仅查看单行日志或退出码），未必真正确认端到端效果，下游规则生成需规定证据的最小充分性标准",
  "过度验证会增加执行开销，在低风险、可快速回滚的场景中可能拖慢迭代节奏，需按风险等级调节验证深度",
  "确定性根因修复优先在根因定位成本过高时可能延误采用概率性手段及时止损，需要止损时限作为兜底",
  "『所有消费方』的清单可能不完备（存在未被识别的隐藏消费方），导致传播验证遗漏而再次产生未闭环宣称"
 ]
}
```

## R4（G-manual_1789317326914_sj6 r3）

### X
```json
{
 "principleDraft": {
  "title": "写前核证门禁：有后果状态写入前须会话内核对权威源并持久化核对记录",
  "statement": "凡依赖外部权威源的有后果状态写入（合并、同步、版本升级），必须先在当前会话内对权威源取得可观察核对证据（mtime/哈希/逐条内容比对），将核对结论持久化为可审计记录，并使『核对通过』成为版本转移（v_n→v_n+1）的必需前置状态：核对记录缺失或核对未通过即拒绝写入，使盲写在机制上不可达；核对操作本身及核对通过后的正常写入不受限制。同类失败已复发时，纠正必须以该强制顺序约束落地，不得降级为可选提醒或事后汇报。",
  "rationale": "根因是核证时序倒置：合并于 15:24 完成而权威源证据（LastWriteTime/MD5/内容口径）迟至 16:34 才取得且仅用于收尾汇报，导致已作废的 30clip 口径被盲并入 CURRENT_STATE.md（v1→v2），状态文件在权威口径已升至 v3 时发生回退；且 09-05 同族失败已两次造成 Owner 可见返工，纠正仍停留于提醒层面而第三次复发。将『会话内写前核对＋持久化核对记录』设为版本转移的必需前置状态，过期条目会在写入边界被识别并拦截，盲写与正常写在流程上可区分且前者机制上不可达；这同时把复发纠正从依赖临场记忆的可选提醒升级为机制化拦截，直接封堵 T-05/T-08/T-01/T-03 的违反路径。",
  "applicability": [
   "依赖外部权威源的状态文件合并、同步与版本升级（如 CURRENT_STATE、pending-notes、source-of-truth 类文件）",
   "跨会话或心跳式同步：瞬态上下文不可信，核对状态必须持久化、可追溯、可复核",
   "同一缺陷已多次复发的纠正场景：纠正须以强制顺序约束（机制化门禁）落地",
   "任何以关键校验保证正确性的有后果写入"
  ],
  "antiPatterns": [
   "盲写/盲合并：未在会话内对权威源做任何写前核对即执行状态文件写入或版本转移",
   "核证时序倒置：将 mtime/哈希/内容核对推迟到写入完成后的收尾汇报阶段，仅作事后佐证",
   "以文件自身回读校验冒充对权威源口径的核对",
   "纠正停留于提醒层面：同族失败复发后仍依赖临场记忆与自觉而非机制化拦截",
   "门禁只校验哈希/新鲜度而不做逐条内容比对，放行完整但已作废的条目"
  ],
  "confidence": 0.86
 },
 "intentContract": {
  "ownerIntent": "Owner 要求状态文件同步/合并类的有后果写入之前必须先在会话内核对权威源（mtime/哈希/内容），而核对操作本身与核对通过后的正常合并不受限制。",
  "targetBehavior": "在轨迹中可观察到：执行状态文件合并/同步/版本变更写入之前，agent 先在会话内读取权威源并完成 mtime/哈希/内容比对、持久化核对记录，随后才执行写入；无写前核对记录时不出现版本转移。",
  "forbiddenBehavior": "未核对权威源即执行状态写入（盲合并）、把核对推迟到写入之后仅作收尾汇报、或以文件自身回读校验冒充权威核对——该失败家族已在 09-05 两次返工后第三次发生。",
  "evidenceSource": "diagnosis_manual_1789317326914_sj6p6a92：15:24 将 pending-notes.md 并入 CURRENT_STATE.md（v1→v2）时无写前核对，16:34 才取得 source-of-truth.json 权威证据（LastWriteTime 2026-09-13 22:47:41、MD5 A0A58FA38055B2F31B24A512E1C59EE3、权威口径 v3=10 条/15 clip），已作废 30clip 口径被并入；前置痛为 manual_1788609453041_dtmlftov（09-05 同族两次 Owner 可见返工）。",
  "validationExpectation": "评估者应核验规则满足三点：命中状态文件合并/写入模式时，写前无核对记录即阻止版本转移；不限制核对操作本身及核对通过后的正常合并；门禁为强制顺序而非可选提醒。任何允许以事后核对替代写前核对、或把核对动作一并拦截的修改，均视为背离本意图并应被标记而非执行。"
 },
 "risks": [
  "与核心公理 T-05、T-03、T-01、T-10 存在重叠：本原则实为它们在『写前核对门禁』场景下的组合特化，收录时应作为特化补充并显式关联公理，避免重复立规或口径冲突。",
  "权威源暂不可达或取证失败时，强制门禁会阻塞合法写入，需配套超时与降级路径，否则可能造成流程死锁。",
  "mtime/MD5 仅证明完整性与新鲜度，不证明语义有效性；门禁若只校验哈希而不做逐条内容比对，仍可能放行完整但已作废的条目。",
  "TOCTOU 竞态：会话期间权威源被并发修改会使已取得的核对结果瞬间过期，单次写前核对可能制造虚假安全感。",
  "对一切纠正都机制化可能导致规则膨胀与过度拦截；强制门禁应保留给复发且高后果的失败模式，避免误伤低风险、可逆的操作。"
 ]
}
```

### Y
```json
{
 "principleDraft": {
  "title": "写前核证门禁：有后果状态写入须先核对权威源并持久化核对记录",
  "statement": "对任何依赖外部权威源的有后果状态写入（如状态文件合并、同步、版本升级），必须在写入执行前于当前会话内针对权威源完成核对（mtime/哈希/逐条内容比对），将核对结论（证据值、取证时刻、结论）持久化为可审计记录，并使『存在与待写内容一致的有效核对记录』成为该写入的前置门禁：记录缺失、过期或与待写内容口径不符时，禁止执行写入；对已复发的同类缺陷，纠正必须落地为『先核证、后写入』的强制顺序约束，不得仅依赖提示性提醒或临场记忆。",
  "rationale": "根因是核证时序倒置：合并发生在15:24，而权威源证据（LastWriteTime/MD5/内容口径）直到16:34才取得且仅用于收尾汇报，导致已作废的30clip口径被盲并入并使状态文件回退。将『会话内读取权威源并记录核对结论』设为版本转移（v_n→v_n+1）的必需前置状态，且核对记录持久化、缺失即拒绝合并，可使过期条目在写入边界被识别并拦截，盲合并与正常合并在流程上可区分且前者机制上不可达；同时将复发纠正从可选提醒升级为机制化拦截，消除对瞬态上下文和临场记忆的依赖。",
  "applicability": [
   "依赖外部权威源的状态文件合并、同步或版本升级（如 CURRENT_STATE、pending-notes、source-of-truth 类文件）",
   "跨会话或心跳式同步场景：瞬态上下文不可信，核对状态需可追溯、可审计",
   "同一缺陷已多次复发、此前仅以提醒方式纠正而未生效的场景",
   "写入错误会传播到后续决策、或写入后难以察觉与回滚的高后果状态变更"
  ],
  "antiPatterns": [
   "先写入后核证：合并/写入已完成，才去读取权威源的 mtime/哈希/内容作为收尾汇报的佐证",
   "仅凭记忆或瞬态上下文中残存的旧数据认定权威源内容，会话内未重新取证即合并",
   "核对结果只存在于对话或思考等瞬态上下文中，未持久化为可审计记录",
   "核对证据与待写入内容口径不一致（如条目数量、版本号不匹配）仍继续写入",
   "对已复发的同类缺陷只追加提示性提醒，而不建立『未核对即禁止写入』的强制顺序约束"
  ],
  "confidence": 0.85
 },
 "intentContract": {
  "ownerIntent": "在有后果的状态写入（如状态文件合并）中，禁止未核对权威源就盲写过期内容，要求写入前在会话内取得并持久化核对证据，并将复发缺陷的纠正固化为强制顺序而非提醒。",
  "targetBehavior": "评估者能在工具轨迹中看到：在执行有后果的状态写入之前，agent 于当前会话内读取权威源（获取 mtime/哈希或逐条比对内容），将核对结论持久化为记录（文件或日志条目），且仅在核对记录存在且与待写内容口径一致时才执行写入；对复发缺陷能看到先核证后写入的顺序被强制执行。",
  "forbiddenBehavior": "核证时序倒置的盲写家族：写入完成后才取证用于汇报佐证；仅凭瞬态上下文或记忆中的旧口径直接合并；核对结果不留持久化记录；核对证据与待写内容不符仍继续写入；对已复发缺陷仅用可选提醒而非机制化拦截。",
  "evidenceSource": "诊断事实：合并发生于15:24，而权威源证据（LastWriteTime/MD5/内容口径）直到16:34才取得且仅用于收尾汇报，导致已作废的30clip口径被盲并入并使状态文件回退；且该类缺陷此前已复发、提醒式纠正未生效。",
  "validationExpectation": "评估者应要求：由此生成的任何规则必须使『缺少会话内权威源核对记录（或记录与待写内容不符）』的写入在执行前被拒绝或判定为违规；规则不得被弱化为事后核验或可选提醒；后续修复轮若提出的修改与本字段矛盾（例如允许先写入后补核证），应被标记而非直接实施。"
 },
 "risks": [
  "与核心公理重叠：本原则是 T-03（先证据后结论）、T-05（硬约束转译为守卫与禁止转移）、T-10（持久化中间结论）在『写前核对门禁』场景下的组合特化；收录为独立原则时须明确其特化边界，避免与既有公理产生冗余规则或口径冲突。",
  "强制写前核对在权威源暂不可达或取证失败时会阻塞合法写入；规则落地需定义超时与降级路径（如显式标记『未核对写入』并禁止其被视为已核证状态），否则可能造成流程死锁。",
  "mtime/MD5 仅能证明完整性与新鲜度，不能证明语义有效性；若门禁只校验哈希而不做逐条内容比对，仍可能放行完整但已作废的条目。",
  "会话期间权威源被并发修改会使已取得的核对结果瞬间过期（TOCTOU 竞态），单次写前核对可能制造虚假安全感；应记录取证时刻并尽可能在写入边界原子复查。",
  "将一切纠正都机制化可能导致规则膨胀与过度拦截；强制门禁应保留给复发且高后果的失败模式，避免误伤低风险、可逆的操作。"
 ]
}
```

## R5（G-manual_1788268409354_vau r2）

### X
```json
{
 "principleDraft": {
  "title": "Use Existing Validated Artifacts as Spec; Validate Small Samples Before Batch Production",
  "statement": "When generating artifacts in an environment that contains prior validated examples, existing pipelines, or established conventions, treat those artifacts as the binding specification: extract format, structure, and parameter rules from them before generating anything new; resolve any parameter that cannot be determined from observable evidence through explicit owner confirmation; and produce a single small reversible sample that is verified against the reference spec (including dry-runs or syntax checks) before any batch production begins. Batch output is permitted only after the sample is verified.",
  "rationale": "The root cause across every diagnosed failure is unverified assumption substituting for observable ground truth. Parameters such as language variant, punctuation rules, font size, directory structure, and script syntax were all discoverable before action by reading existing outputs, scanning the environment, or dry-running, yet each was assumed instead, and each deviation propagated through the entire batch before discovery. Converting unknowns into knowns via existing assets, then front-loading error discovery onto a small reversible sample, collapses correction cost from full-batch rework rounds to a single small iteration.",
  "applicability": [
   "Subtitle and media processing pipelines where finished episodes, scripts, and working pipeline code already exist in the environment",
   "Batch generation of templated documents, code, or configuration where a reference implementation or finished exemplar is present",
   "Migrations and format conversions where target-format details are observable from existing validated outputs",
   "Any batch operation where output format details matter to the owner and are easy to get subtly wrong"
  ],
  "antiPatterns": [
   "Inferring format parameters (language variant, punctuation, font size, directory layout, syntax) from assumptions when a validated exemplar exists in the environment",
   "Running full-batch generation before any single-item sample has been validated against the reference spec",
   "Inventing new conventions, scripts, or pipelines when a working prior pipeline can be inspected and reused",
   "Treating prior validated artifacts as optional context rather than the specification to match",
   "Guessing parameters that are not determinable from observation instead of asking the owner for explicit confirmation"
  ],
  "confidence": 0.82
 },
 "intentContract": {
  "ownerIntent": "The Owner wants batch outputs to match the conventions of existing validated artifacts exactly, with any format error surfaced by a small validated sample instead of being discovered across an entire finished batch that then requires rework.",
  "targetBehavior": "Before generating at scale, the agent visibly reads existing validated artifacts and pipelines to extract format and parameter rules, asks the owner to confirm parameters that observation cannot resolve, produces one small sample, verifies it against the reference (including dry-run or syntax checks), and only then executes batch production — the tool trajectory shows a read-then-confirm-then-sample-then-batch ordering.",
  "forbiddenBehavior": "Generating full batches from inferred format assumptions — skipping inspection of existing exemplars, leaving unobservable parameters unresolved or guessed, and producing batch output with no small sample validated against the spec first.",
  "evidenceSource": "The diagnosed trace in which five separate unverified assumptions (language variant, punctuation rules, font size, directory structure, script syntax) each propagated through an entire batch before discovery, forcing rounds of rework and owner correction, despite the correct answers being observable beforehand in existing episodes' finished subtitles, scripts, and pipeline.",
  "validationExpectation": "An evaluator should accept a rule as faithful only if it (a) mandates inspecting existing validated artifacts before generation begins, (b) requires explicit owner confirmation for parameters not determinable from evidence, (c) requires one small reversible sample verified against the spec before batch production, and (d) forbids batch output prior to sample verification; any change that permits batch generation on inferred parameters contradicts this intent and must be flagged."
 },
 "risks": [
  "Substantial overlap with core axioms T-01, T-03, T-04, T-06, and T-07: this principle mainly composes them into an operational ordering for generation pipelines and may not add net-new guidance beyond the axioms",
  "Over-indexing on existing artifacts can propagate flawed, deprecated, or exceptional conventions if the chosen exemplar is itself unrepresentative",
  "Requiring owner confirmation of every uncertain parameter can stall progress where reasonable defaults plus fast small-sample feedback would converge faster",
  "Small-sample validation can create false confidence for errors that only emerge at scale, such as late edge cases, encoding anomalies, or resource exhaustion",
  "Downstream rule generation may overfit to subtitle/media specifics; rules must remain generic to any batch generation where an exemplar exists"
 ]
}
```

### Y
```json
{
 "principleDraft": {
  "title": "Treat existing validated artifacts as the spec; validate small samples before batch",
  "statement": "When the environment contains prior validated artifacts for the task—existing finished outputs, scripts, or pipelines—treat them as the output specification: read them before designing or generating anything, resolve every uncertain format parameter against them (or explicit owner confirmation when they do not disambiguate), reuse their patterns in preference to invented ones, and validate a small reversible sample against that specification before any batch production.",
  "rationale": "The diagnosed root cause is inferred preference substituting for observable ground truth: the agent built a new whisper->SRT->ASS pipeline without reading Episode 001's existing scripts or finished subtitles, so assumed parameters (traditional-Chinese variant, punctuation splitting, oversized font) propagated through the full batch and surfaced only at owner review, costing multiple correction rounds plus avoidable execution failures (FileNotFoundError, PowerShell ParserError, Python SyntaxError from unverified paths and scripts). Every deviated parameter was discoverable before action by reading existing assets; treating those assets as the spec and front-loading error discovery onto a small validated sample collapses correction cost from full-batch rework to a single iteration.",
  "applicability": [
   "Subtitle/media production when a prior episode's finished outputs, scripts, or pipeline already exist in the workspace",
   "Batch generation, migration, or templated output where a validated exemplar or reference implementation exists (documents, code, config)",
   "File creation or modification in directories that may already contain matching scripts, code, or convention documents",
   "Tasks where output format details (language variant, punctuation, typography) matter to the owner and are easy to get subtly wrong"
  ],
  "antiPatterns": [
   "Inventing a new pipeline or output format when a validated exemplar already exists in the environment, without reading it first",
   "Generating batch output from inferred format preferences (language variant, punctuation rules, font size) instead of the observable exemplar or owner-confirmed parameters",
   "Producing the full batch before any small sample has been compared against the existing spec or confirmed by the owner",
   "Executing unverified scripts or writing to unverified paths, relying on runtime errors (FileNotFoundError, ParserError, SyntaxError) to reveal assumptions"
  ],
  "confidence": 0.84
 },
 "intentContract": {
  "ownerIntent": "The Owner wants new episodes' outputs to match Episode 001's existing scripts and finished-output conventions (simplified Chinese, punctuation splitting, font size) instead of the agent inventing its own pipeline, so format deviations never reach full-batch output.",
  "targetBehavior": "Before generating output, the agent lists and reads the existing exemplar assets, extracts their format parameters and pipeline, reuses them (or confirms deviations with the Owner), then produces a small sample and compares it against the exemplar before batch generation—visible as read/list tool calls preceding creation calls and a sample artifact preceding the full batch.",
  "forbiddenBehavior": "Designing and batch-generating artifacts from assumed parameters and an invented pipeline without reading the existing validated exemplars, letting inferred preferences substitute for the observable spec until the Owner discovers deviations in the finished batch.",
  "evidenceSource": "Diagnosis manual_1788268409354_vautfk3l (score-75 severe pain): agent self-admitted it never read Episode 001's script/code and improvised a whisper->SRT->ASS pipeline; owner corrections for traditional Chinese, punctuation splitting, and oversized font surfaced only at review; subsequent FileNotFoundError, PowerShell ParserError, and Python SyntaxError tool failures from unverified paths and scripts.",
  "validationExpectation": "An evaluator should accept a rule only if it demands reading existing exemplar assets (or owner confirmation) BEFORE generation and sample-vs-spec validation BEFORE full batch; a rule that permits inventing formats when exemplars exist, or that only verifies after full-batch delivery, contradicts this intent."
 },
 "risks": [
  "Substantial overlap with core axioms T-01, T-02, T-03, T-04, and T-07: the principle is an operational composite of them, so rule generation should encode its specific mechanics (exemplar-as-spec, sample-before-batch) rather than restate the axioms",
  "Over-indexing on a prior exemplar can propagate flawed, deprecated, or non-representative conventions if the exemplar is itself an exception rather than the rule",
  "Requiring owner confirmation for every format parameter can stall progress where reasonable defaults plus fast small-sample feedback would converge faster",
  "Small-sample validation can miss errors that only emerge at scale (edge cases late in the data, encoding anomalies), creating false confidence in the validated prefix",
  "Diagnosis confidence was moderate (0.62): the full trace was unavailable and behavior evidence partly comes from agent self-report, so the pattern's stability is not yet confirmed"
 ]
}
```

## R6（G-pain_host_85731899e27e6d r2）

### X
```json
{
 "principleDraft": {
  "title": "Persist standing owner conventions; recall before governed actions; update on correction",
  "statement": "When an owner expresses a durable, cross-session instruction or standing rule (e.g., 'always', 'never', 'from now on', '以后务必', '不要忘记'), the agent must: (1) immediately capture it into a persistent conventions record maintained outside transient session context; (2) re-read that record before initiating any task, phase, or tool call the conventions govern, and confirm the planned action complies before executing; and (3) after every owner correction touching those conventions, rewrite the record so the correction becomes persistent process rather than one-time compliance. Standing conventions must never be carried only in conversation memory. One-off, task-local instructions that expire with the current task are out of scope.",
  "rationale": "The diagnosed failure was not a single wrong action but a memory-dependent process: owner-declared work conventions (advisor collaboration, browser-ChatGPT-first image/prompt generation) existed only in transient session context, so every phase or session boundary erased them, the agent reverted to its own defaults, and the owner had to re-issue severe corrections that were never converted into persistent process change, guaranteeing recurrence. Externalizing conventions into a maintained record with a mandatory pre-action recall gate and a correction-driven update loop converts compliance from fragile recall into durable process, intercepting deviation before the deviating tool call executes rather than remediating after it.",
  "applicability": [
   "When an owner message carries standing-rule markers ('以后务必', '不要忘记', 'from now on', 'always', 'never') — capture into the persistent record must happen at first expression",
   "Before starting a phase, task, or tool call whose work type is covered by a persisted convention (e.g., image/cover/keyframe/prompt generation, collaboration mode)",
   "When the same owner correction about a working method has occurred more than once — recurrence signals a missing persistence/recall mechanism, not a memory lapse",
   "Explicitly out of scope: one-off, task-local instructions that expire with the current task"
  ],
  "antiPatterns": [
   "Carrying owner-declared standing conventions only in transient session or conversation memory across phases and sessions",
   "Starting a governed phase or executing covered tool calls (e.g., image/prompt generation) without first loading the persistent conventions record and checking the plan against it",
   "Complying with an owner correction in the moment while never rewriting the persistent conventions record or checklist, re-arming the same forgetting cycle",
   "Substituting the agent's own default working method (self-generated images/prompts, skipping advisor collaboration) for the owner's explicitly declared constraints",
   "Treating a recurring standing rule as task-local and discarding it at phase or task end"
  ],
  "confidence": 0.85
 },
 "intentContract": {
  "ownerIntent": "The owner wants work conventions he has explicitly declared — use advisor collaboration, and generate covers/keyframes/prompts via browser ChatGPT first — to remain in force across phase and session boundaries so he never has to re-issue the same correction.",
  "targetBehavior": "In an observable tool trajectory, a compliant agent writes new 'from now on / do not forget' instructions into a persistent conventions record when they are issued, reads that record before starting any phase or tool call it governs, updates the record after each related correction, and its subsequent actions (advisor use, browser ChatGPT generation) match the recorded constraints.",
  "forbiddenBehavior": "Letting owner-declared standing conventions live only in transient session memory, so phase or session boundaries silently erase them, the agent reverts to its own defaults (generating images/prompts its own way, skipping advisor collaboration), the owner must correct again only after a deviating tool call has already executed, and the correction never updates any persistent record.",
  "evidenceSource": "Severe user_correction pain (pain_host_85731899e27e6d) detected by an after_tool_call hook: the owner's correction demanded advisor collaboration and browser-ChatGPT-first image/prompt generation and stated 'you did this before — do not forget again'; the diagnosis found no persisted conventions document or pre-work recall checklist existed.",
  "validationExpectation": "A faithful derived rule must be checkable in three places: (a) a write to the conventions record when a standing-rule marker appears, (b) a visible read of that record before governed phase/task/tool-call starts, and (c) a rewrite after each related correction. Evaluators should reject rules that mandate only generic 'remembering' or 'be careful' without the persistence artifact and pre-action recall step, or that widen scope to one-off task-local instructions."
 },
 "risks": [
  "Substantial overlap with core axioms T-10 (persist important state), T-05 (guardrails before execution), T-02 (explicit owner intent priority), and T-08 (corrections as feedback); the principle must be implemented as a lifecycle synthesis extending those axioms or it will be judged redundant",
  "Mandatory pre-action recall adds overhead and latency if applied to trivial tasks outside any convention's scope; the recall gate must be scoped to work types the conventions actually govern",
  "Persisted conventions can go stale as owner preferences evolve; on any conflict between the record and the owner's current explicit instruction, the current instruction wins and the record must be updated",
  "Misclassifying one-off, task-local instructions as standing rules creates unnecessary rigidity and confirmation interruptions where flexibility was expected",
  "Diagnosis intent-tension evidence was weak (no INTENT.md original reviewed); the standing-versus-task-local boundary rests mainly on the owner's correction message wording"
 ]
}
```

### Y
```json
{
 "principleDraft": {
  "title": "Externalize Standing Owner Conventions; Recall Before Acting; Update on Correction",
  "statement": "Whenever the owner expresses a durable, cross-session instruction ('always', 'never', 'from now on', 'do not forget'), the agent must (1) immediately capture it in a persistent conventions record maintained outside transient session context, (2) re-read that record before initiating any task, phase, or tool call the conventions govern and adjust the planned action to comply, and (3) rewrite the record whenever a correction reveals it is missing, stale, or wrong. One-off, task-local instructions that expire with the task are exempt from this lifecycle.",
  "rationale": "The diagnosed root cause was not a single bad action but a memory-dependent process: recurring obligations lived only in transient session context, so every phase or session boundary erased them, and repeated corrections were never converted into process change — each unrecorded correction merely re-armed the same failure cycle. Persisting owner-declared conventions externally, gating governed actions behind a mandatory pre-action recall, and feeding every correction back into the persistent record transforms compliance from fragile recall into a durable capture-recall-update process that intercepts deviation before execution instead of remediating after it.",
  "applicability": [
   "When the owner expresses a standing rule or durable instruction marked by phrases like 'always', 'never', 'from now on', or 'do not forget'",
   "Before initiating any task, phase, or tool call whose subject matter is covered by a known standing convention",
   "When the same violation or correction has occurred more than once, indicating a convention failed to persist or was never updated",
   "At session, phase, or context boundaries where transient memory of prior instructions would otherwise be lost"
  ],
  "antiPatterns": [
   "Treating a standing owner rule as conversation-local and letting it silently expire when context resets",
   "Acknowledging a correction verbally without rewriting the persistent conventions record, leaving the same failure armed for the next session",
   "Executing a task, phase, or tool call governed by a standing convention without first consulting the persisted conventions record",
   "Storing durable obligations only in transient context (in-flight reasoning, chat history) with no external persistence",
   "Rigidly applying a stale persisted convention after the owner's newer explicit instruction supersedes it, without updating the record"
  ],
  "confidence": 0.86
 },
 "intentContract": {
  "ownerIntent": "The Owner wants a rule declared once ('from now on...') to be honored in every subsequent governed action across sessions and phases, without having to re-state it or correct the same violation twice.",
  "targetBehavior": "A compliant agent visibly writes any owner-declared standing rule into a persistent conventions record at declaration time, reads that record before starting any task, phase, or tool call it governs and conforms the planned action to it, and edits the record immediately after any correction — all observable in its persistence and tool-call trajectory.",
  "forbiddenBehavior": "Executing tasks or tool calls governed by a standing owner rule while relying on transient context or memory alone, and accepting corrections without rewriting the persistent conventions record, producing a repeating violate-correct-violate cycle across context boundaries.",
  "evidenceSource": "The diagnosed pain of recurring violations of owner-declared standing rules across phase/session boundaries caused by context loss, with repeated corrections that never changed any persistent state, so the identical violation recurred after each context reset.",
  "validationExpectation": "An evaluator should demand evidence that (a) a persistent conventions artifact exists and is written when a standing rule is declared, (b) a read of that record precedes each governed action in the trajectory, and (c) every correction produces an edit to the record. Any proposed rule change that permits recall from memory alone, skips the pre-action read for governed actions, or leaves the record unchanged after correction contradicts this intent and must be flagged rather than implemented."
 },
 "risks": [
  "Partially overlaps core axioms T-10 (persist important state), T-05 (translate constraints into guardrails), T-02 (explicit intent priority), and T-08 (corrections as feedback); this draft must be treated as a lifecycle synthesis (capture-persist-recall-update) extending those axioms, or it risks being judged redundant with them.",
  "A mandatory pre-action recall gate adds overhead and latency if applied too broadly; it must be scoped to actions the persisted conventions actually govern, not to every trivial action.",
  "Persisted conventions can go stale if owner preferences evolve; rigid adherence to an outdated record without honoring the owner's current explicit instruction could conflict with T-02.",
  "Misclassifying one-off, task-local instructions as standing rules would create unnecessary rigidity and confirmation interruptions when flexibility was expected.",
  "Ambiguity in deciding which actions are 'governed' by a convention may cause the recall gate to be skipped precisely where it applies, silently reproducing the original failure."
 ]
}
```

## R7（G-manual_1788526359876_r5x r1）

### X
```json
{
 "principleDraft": {
  "title": "Gate causal conclusions on event-level evidence and data consistency before externalization",
  "statement": "Before any root-cause attribution or diagnostic conclusion is externalized (ticket, incident report, fix plan), it must pass three gates: (1) every link of the proposed causal mechanism is supported by event-level evidence, not aggregate statistics or heuristics alone; (2) the conclusion's measurable implications are explicitly compared item-by-item against observed data, and any contradiction forces revision or rollback of the conclusion, not dismissal of the data; (3) if evidence acquisition is blocked, the output must carry an explicit unverified/uncertainty label with downgraded assertion strength, never a silently confident claim. Exploratory hypotheses may be freely proposed but must be labeled as hypotheses until they pass these gates.",
  "rationale": "The diagnosed misdiagnosis arose not from missing evidence but from missing gates between forming a conclusion and exporting it: a single aggregate metric (90.8% truncation rate) stood in for mechanism verification, the conclusion (budget truncation) directly contradicted already-measured data (5686/9000 rows within budget) with no comparison ever performed, and the unverified conclusion escaped as an external ticket, propagating error downstream. Each gate independently intercepts this failure family: mechanism-chain verification defeats statistics-as-causation, the consistency check surfaces data contradictions before export, and forced degradation removes the silent-continuation path when evidence access fails. The principle composes T-03 (evidence before inference), T-05 (hard constraints as explicit gates), and T-07 (verify against intended outcome) into a process constraint specialized to the conclusion-externalization moment.",
  "applicability": [
   "Producing or publishing root-cause attributions, diagnostic conclusions, or incident reports that will leave the agent's context (tickets, reports, fix proposals)",
   "Conclusions built primarily from aggregate statistical metrics, rate thresholds, or heuristic inference rather than traced mechanism evidence",
   "Diagnostic workflows where evidence acquisition is partially or fully blocked (tool failures, unreachable data, incomplete logs) while the task continues",
   "Any point where a causal claim's observable implications can be checked against measurements already collected"
  ],
  "antiPatterns": [
   "Substituting an aggregate statistic or correlation (e.g., a 90.8% truncation rate) for event-level verification of a causal mechanism",
   "Externalizing a conclusion whose measurable implications contradict data already in hand (e.g., asserting budget truncation while measured values sit within budget)",
   "Treating conclusion-formation as the end of verification — never re-deriving the conclusion's predictions and checking them against observed data",
   "Silently continuing at full asserted confidence when evidence tools fail or data is unreachable",
   "Escalating an unverified hypothesis into a ticket, report, or fix plan without labeling its epistemic status"
  ],
  "confidence": 0.82
 },
 "intentContract": {
  "ownerIntent": "The Owner wants unverified root-cause conclusions — especially ones that contradict already-measured data or rest only on aggregate statistics — blocked from leaving the agent as tickets or reports that propagate the error downstream.",
  "targetBehavior": "In any trajectory that emits a ticket, report, or fix plan containing a causal claim, a reviewer can see: cited event-level evidence for each link of the claimed mechanism, an explicit item-by-item comparison of the claim's measurable implications against observed values (contradictions triggering revision), and, where evidence access failed, an unverified/uncertainty label with downgraded assertion strength.",
  "forbiddenBehavior": "Externalizing a causal or diagnostic conclusion that is backed only by aggregate statistics or heuristics, that was never compared against available measured data, or that is asserted at full confidence despite blocked or failed evidence acquisition.",
  "evidenceSource": "The diagnosed incident: a 90.8% aggregate truncation rate was used to conclude 'budget truncation' while measured data showed 5686/9000 rows within budget; the direct contradiction was never compared and the unverified conclusion escaped as an external ticket.",
  "validationExpectation": "An evaluator should accept a rule as faithful only if, for any externalized causal conclusion, it demands visible evidence of (a) event-level support per mechanism link, (b) an explicit conclusion-vs-measurement consistency check, and (c) uncertainty labeling with downgraded strength when evidence is blocked; a repair change that removes any of these three gates or permits silent full-confidence export contradicts this intent."
 },
 "risks": [
  "Overlaps core axioms T-03 (evidence before inference), T-05 (explicit guardrails and gates), and T-07 (verify outcome after acting); downstream rule generation must treat this as a scenario-specific composition for conclusion externalization and avoid emitting redundant or conflicting rules",
  "Over-gating cost: demanding event-level verification and item-by-item comparison for every minor conclusion adds latency to urgent diagnostics; gate strictness should scale with the conclusion's blast radius",
  "When evidence is absolutely unobtainable, a hard gate risks action paralysis or incentivizing fabricated evidence; explicit uncertainty labeling and conclusion downgrade must remain the sanctioned exit path, not prohibition of output",
  "Event logs themselves can be incomplete or misleading; treating single-source event evidence as unquestionable ground truth without cross-corroboration can create new misdiagnosis modes",
  "Mis-scoping risk: applying the gates to exploratory hypothesis generation (which requires only hypothesis labeling, not prohibition) would suppress useful early reasoning"
 ]
}
```

### Y
```json
{
 "principleDraft": {
  "title": "Gate causal conclusions on event evidence and data consistency before externalization",
  "statement": "Before any root-cause attribution or diagnostic conclusion is externalized (ticket, report, remediation plan), it must pass three gates: (1) each link of the claimed causal mechanism chain is verified with event-level evidence (execution logs, error traces, state), never with an aggregate statistical indicator standing in as causal proof; (2) the conclusion's testable implications are compared item-by-item against measured data, and any contradiction forces rollback and re-investigation rather than publication; (3) if evidence acquisition is blocked (tool failure, oversized response, unreachable data), the agent must explicitly label the evidence gap and downgrade the conclusion to provisional/uncertain instead of silently continuing to a definitive claim.",
  "rationale": "The misdiagnosis under treatment had three independently interceptable failure points: the root cause was asserted from a single statistic (90.8% truncation rate) without checking the before_prompt_build hook's actual execution; the conclusion (budget truncation) directly contradicted measured data (5686/9000, under budget) but was never compared; and blocked evidence (config.get response too large, tool exec exit 1) led to silent continuation. The false PRI-646 ticket then propagated the error downstream. Each gate breaks this chain at a different point: event evidence would have exposed the hook crash (TypeError: The database connection is not open), the data comparison would have falsified the truncation theory, and explicit degradation would have prevented an unverified conclusion from masquerading as knowledge. This composes T-03 (evidence over inference), T-07 (verify results against expectation) and T-05 (hard constraints as explicit gates) into a process constraint for the specific failure mode of attribution-conclusion externalization.",
  "applicability": [
   "Forming or publishing root-cause attributions, diagnostic conclusions, or incident reports that will flow out as tickets, reports, or remediation plans",
   "Conclusions derived from aggregate statistical indicators, ratios, or heuristics (e.g., truncation rates, percentages) rather than event-level evidence",
   "Investigations where evidence acquisition is blocked or degraded (tool gateway failures, oversized responses, exec failures)",
   "Any causal claim that will drive downstream actions (fixes, prioritization, component blame)",
   "Boundary: applies at conclusion-commitment/externalization points; exploratory hypothesis generation is out of scope — hypotheses there only need explicit labeling as hypotheses, not gating"
  ],
  "antiPatterns": [
   "Asserting a root cause from a statistical indicator (e.g., a 90.8% truncation rate) without reading the event logs of the mechanism's actual execution",
   "Externalizing a conclusion whose implications contradict measured data (e.g., claiming budget truncation while measured sizes are under budget) without any comparison step",
   "Treating 'analysis produced an answer' as 'answer verified' — skipping the conclusion-versus-observation consistency check",
   "Silently continuing to a definitive conclusion after evidence-acquisition failures, without labeling the gap or trying explicit alternative paths (narrower config subtree query, CLI fallback)",
   "Filing a ticket or report that presents a partially verified or heuristic-based attribution as established fact, with no uncertainty qualification"
  ],
  "confidence": 0.85
 },
 "intentContract": {
  "ownerIntent": "Prevent unverified root-cause conclusions from flowing out as tickets or reports — specifically attributions built on statistical indicators instead of event-level evidence, conclusions that contradict the measured data they must explain, and definitive claims issued after evidence acquisition was blocked.",
  "targetBehavior": "In any tool trajectory that ends in an externalized diagnosis, a reviewer can see: (a) event-level evidence (logs/traces/state) retrieved for each link of the claimed mechanism chain, (b) an explicit comparison of the conclusion's implications against measured data with rollback on contradiction, and (c) when evidence tools failed, either successful alternative evidence paths (narrower query, CLI fallback) or an explicit uncertainty label with a downgraded provisional conclusion instead of a definitive claim.",
  "forbiddenBehavior": "Externalizing a causal conclusion that rests on aggregate statistics or heuristics without event-level mechanism verification, that was never checked against observed data (or that survives a known contradiction), or that was reached by silently continuing past blocked evidence — the failure family that produced the false PRI-646 ticket from the truncation-rate theory.",
  "evidenceSource": "Diagnosis manual_1788526359876_r5xgtgu9 (pain manual_1788526359876_r5xgtgu9): root cause asserted from a 90.8% truncation statistic while the before_prompt_build hook had actually crashed (TypeError: The database connection is not open); measured 5686/9000 under budget contradicted the truncation theory; false PRI-646 ticket filed; tool_call_failures (config.get response too large twice, tool exec exitCode 1) evidence the blocked-evidence silent-continuation mode. Dreamer proposals 0 (event evidence before conclusion), 1 (consistency check with rollback), 3 (gate before externalization) and 4 (explicit degradation when blocked) supply the concrete better-decision variants; the philosopher endorsed their synthesis as three gates.",
  "validationExpectation": "A rule is faithful only if it (a) blocks or forces rollback for conclusions resting on statistics without event-log verification, (b) requires item-by-item comparison of conclusion implications against measured data with contradiction-then-rollback, (c) mandates explicit uncertainty labeling and conclusion downgrade when evidence is blocked, with legitimate alternative evidence paths, and (d) does not prohibit or gate exploratory hypothesis generation itself. Any repair change that lets statistical indicators count as sufficient causal proof, removes the contradiction-rollback requirement, or permits silent continuation after evidence blockage contradicts this intent and must be flagged."
 },
 "risks": [
  "Overlaps core axioms T-03 (evidence before inference), T-07 (verify result versus expectation) and T-05 (hard constraints as explicit gates); this principle is a composite gate for the attribution-externalization scenario, and rule generation must demarcate boundaries to avoid duplicate or conflicting rules",
  "Over-gating may slow urgent diagnosis; gates should scale with the conclusion's impact rather than being applied with equal force to minor intermediate findings",
  "When evidence is absolutely unavailable, a hard gate risks analysis paralysis or incentivizing fabricated evidence; explicit uncertainty labeling and conclusion downgrade must remain a legitimate exit path, not a prohibited state",
  "Event logs themselves can be incomplete or misleading; single-source event evidence must still be cross-checked rather than treated as unquestionable ground truth",
  "Scope creep risk: applying the gate at ideation rather than commitment points would suppress exploratory hypothesis generation, which the source scope explicitly excludes"
 ]
}
```

## R8（G-manual_1788415743052_os4 r2）

### X
```json
{
 "principleDraft": {
  "title": "Environment change resets implicit contracts; verify encoding/interpreter before consequential runs",
  "statement": "Whenever the execution environment changes (new host, OS, shell, or interpreter version, e.g., pwsh/Linux to Windows PowerShell 5.1) or an artifact contains encoding-sensitive (non-ASCII) content, treat every implicit environment contract — file encoding, interpreter version, working directory — as unverified, and re-establish it before the first consequential execution using the cheapest sufficient check: an interpreter version probe (e.g., $PSVersionTable.PSVersion), an explicit encoding convention (UTF-8 with BOM for non-ASCII scripts targeting Windows PowerShell 5.x, or pure ASCII), or a minimal reversible smoke test. Once the contract is verified or corrected, persist it to durable memory so the same reset is never relearned through runtime failure.",
  "rationale": "The diagnosed failure was carrying a pwsh/Linux encoding assumption (UTF-8 without BOM) onto a Windows PowerShell 5.1 host, which silently parses such files as ANSI: the embedded Chinese string at line 79 garbled, the script exited 1, and the mistake cost a failed execution plus an Owner correction. Encoding and interpreter contracts are invisible preconditions — unenforced by tooling and platform-relative — so they surface only as owner-visible runtime failure. A seconds-cheap pre-flight probe converts that guaranteed failure into a cheap check, and persisting the verified contract turns a one-time correction into standing operational knowledge, directly eliminating the root cause of relying on runtime failure to discover environment incompatibilities.",
  "applicability": [
   "Landing or first-time executing any script (e.g., .ps1) on a host, OS, interpreter, or interpreter version not yet verified in the current session",
   "Writing or saving files that contain non-ASCII (e.g., Chinese) strings whose correct parsing depends on an explicit encoding contract",
   "The first consequential execution after any platform or environment transition, before relying on assumptions formed in the prior environment",
   "Consequential file operations whose outcome depends on working-directory or locale assumptions carried over from a previous environment",
   "Recording an environment-contract lesson after a verified correction, when deciding what must be persisted for future sessions"
  ],
  "antiPatterns": [
   "Executing an encoding-sensitive script on an unverified interpreter by assuming the prior environment's default (UTF-8 no-BOM under pwsh/Linux) still holds on the new platform",
   "Using runtime failure (garbled output, non-zero exit code) as the primary mechanism for discovering environment incompatibilities",
   "Treating a new host or interpreter version as equivalent to the previous one without any version probe, encoding check, or smoke test",
   "Landing a corrected script without persisting the interpreter-version/encoding rule, leaving the fix dependent on transient session context"
  ],
  "confidence": 0.8
 },
 "intentContract": {
  "ownerIntent": "Before landing or executing scripts in a target environment, the agent must confirm the interpreter version and encoding contract (e.g., $PSVersionTable.PSVersion; UTF-8 BOM for non-ASCII on Windows PowerShell 5.x) instead of relying on runtime failure to reveal the mismatch.",
  "targetBehavior": "In the tool trajectory before the first consequential execution on a new or unverified host/interpreter, an observable verification action appears — a version probe, writing non-ASCII scripts as UTF-8 with BOM (or pure ASCII / pwsh 7+), or a minimal reversible smoke test — followed, once the contract is learned, by a persisted record of it in durable memory.",
  "forbiddenBehavior": "Executing an encoding-sensitive script by carrying a prior environment's assumptions (UTF-8 no-BOM from pwsh/Linux) onto an unverified platform such as Windows PowerShell 5.1, and letting runtime failure (garbled Chinese strings, exit code 1) serve as the discovery mechanism for the broken contract.",
  "evidenceSource": "Tool-call failure at 2026-09-03T06:00:16.593Z: the line-79 Chinese string garbled with exit code 1 because Windows PowerShell 5.1 parsed a no-BOM UTF-8 script as ANSI; the agent's admission at 2026-09-03T06:05:07.757Z that no pre-execution compatibility check was performed; and the Owner's correction (diagnosis reasonSummary) requiring interpreter-version and encoding-contract confirmation before landing scripts.",
  "validationExpectation": "An evaluator should accept a rule only if it fires on platform/interpreter transitions or non-ASCII script landing, demands a version/encoding verification step before the first consequential run, keeps the probe minimal and reversible, and stays silent for trivial ASCII-only operations in an already-verified environment; any repair that removes the pre-execution timing or the environment-change trigger contradicts this intent."
 },
 "risks": [
  "Overlaps with core axioms T-01 (build a sufficient model before consequential changes) and T-05 (translate hard constraints into guardrails before execution): this draft is a specialization adding the environment-change reset trigger and concrete encoding probes, so rule generation should consider consolidating under T-01/T-05; the persistence clause additionally overlaps T-10",
  "Over-probing: read as 'verify before every run', the principle adds friction to trivial ASCII-only operations in already-verified environments; applicability must stay bounded to platform transitions, non-ASCII content, or first consequential executions",
  "False confidence: a passing version probe or smoke test validates only the probed contract; working-directory, permission, or locale mismatches may still fail at runtime (the diagnosis also noted a working-directory-related MEMORY.md read failure)",
  "Staleness: persisted environment-specific rules (e.g., 'enforce UTF-8 BOM for PowerShell 5.x') can become obsolete after an environment upgrade and should be re-verified on the next platform change",
  "Time-pressure tension: in genuinely urgent situations a mandatory verification step could delay necessary action; the probe must remain minimal and reversible rather than exhaustive"
 ]
}
```

### Y
```json
{
 "principleDraft": {
  "title": "Verify Environment Contracts After Platform Change Before Consequential Execution",
  "statement": "Whenever the execution environment changes (new OS, host, interpreter, or interpreter version) or the content is encoding-sensitive (non-ASCII), treat all implicit environmental contracts—file encoding, interpreter version, working directory—as unverified. Before the first consequential execution, re-establish them with a minimal, reversible check: an interpreter/version probe, an explicit encoding convention (e.g., UTF-8 with BOM for non-ASCII files consumed by Windows PowerShell 5.x), or a smoke test on a sacrificial artifact. When a check reveals a mismatch, persist the corrected convention as a standing rule tied to the platform so the same reset is never re-learned through runtime failure.",
  "rationale": "The root cause was an encoding assumption (UTF-8 no-BOM, valid under pwsh/Linux) carried into a Windows PowerShell 5.1 host that silently parses such files as ANSI, surfacing only as runtime garbling or failure. Environmental contracts are invisible: no tool enforces them, and their validity is platform-relative, so an environment transition silently invalidates them. A pre-flight probe costs seconds, converts a guaranteed owner-visible failure into a cheap check, and persisting the learned convention turns a one-time correction into standing operational knowledge. This is a platform-transition-triggered specialization of T-01 and T-05, with a T-08/T-10 persistence requirement for the learned rule.",
  "applicability": [
   "Executing scripts or performing consequential file operations on a new host, OS, interpreter, or interpreter version",
   "Writing or modifying files containing non-ASCII or otherwise encoding-sensitive content",
   "The first consequential execution after any platform or environment transition, before relying on assumptions formed in a prior environment",
   "Recording environment-specific conventions discovered through verification or failure so they survive context resets"
  ],
  "antiPatterns": [
   "Carrying encoding, interpreter, or working-directory assumptions verified in one environment into a different environment without re-checking",
   "Writing non-ASCII content to files consumed by a host with unknown encoding behavior (e.g., PowerShell 5.x defaulting to ANSI) without an explicit encoding convention or BOM",
   "Letting the first evidence of an environment mismatch be a consequential runtime failure visible to the owner, when a version probe or reversible smoke test could have caught it",
   "Re-learning the same environment lesson after every reset because the corrected convention was never persisted"
  ],
  "confidence": 0.78
 },
 "intentContract": {
  "ownerIntent": "The Owner wants to prevent runtime garbling and failures caused by carrying environment assumptions (file encoding, interpreter version) from one platform into another—such as a UTF-8 no-BOM file written under pwsh/Linux assumptions being silently parsed as ANSI by Windows PowerShell 5.1.",
  "targetBehavior": "Before the first consequential execution on a new or changed environment, the agent performs a minimal, reversible verification—an interpreter/version probe, an explicit encoding decision (e.g., BOM for non-ASCII on PowerShell 5.x), or a smoke test on a sacrificial artifact—and on discovering a mismatch, adopts and persists the corrected convention before proceeding.",
  "forbiddenBehavior": "Relying on implicit environment contracts that were only valid in a prior environment and letting the first evidence of the mismatch be a consequential, owner-visible runtime failure, without ever persisting the corrected convention.",
  "evidenceSource": "The diagnosed pain: a UTF-8 no-BOM artifact produced under pwsh/Linux assumptions was silently parsed as ANSI by Windows PowerShell 5.1, garbling at runtime instead of failing a cheap pre-flight check; and the philosopher's analysis that implicit environmental contracts are platform-relative and reset by environment change.",
  "validationExpectation": "An evaluator should accept a rule as faithful only if it (a) triggers on environment/platform change or encoding-sensitive content, (b) requires a pre-flight probe or explicit encoding convention before consequential execution, and (c) requires persisting the corrected convention. A rule that merely restates generic 'verify before acting' without the platform-transition trigger and the persistence requirement fails this intent."
 },
 "risks": [
  "Overlaps with core axioms T-01, T-05, T-08, and T-10; this draft is a platform-transition specialization with a persistence requirement rather than a wholly new principle, so downstream consolidation or explicit axiom referencing should be considered",
  "Over-probing risk: requiring pre-flight checks for every trivial operation adds friction; generated rules must scope the trigger to consequential execution, encoding-sensitive content, or environment change",
  "False confidence risk: a passing version probe or smoke test validates only the tested contract; other mismatches (cwd, permissions, locale) may still fail at runtime",
  "Staleness risk: persisted platform-specific conventions (e.g., 'BOM for PowerShell 5.x') can become obsolete after environment upgrades and must be re-validated when the platform changes again",
  "Over-generalization risk: the BOM example is specific to Windows PowerShell 5.x behavior and must not be encoded as a universal UTF-8 rule",
  "Urgency conflict: in genuinely time-sensitive situations, mandatory pre-flight verification could delay necessary action; probes must remain minimal and reversible, not exhaustive"
 ]
}
```

## T1（G-manual_1788526359876_r5x r2 · judge=TIE）

### X
```json
{
 "principleDraft": {
  "title": "Gate root-cause claims on event-level mechanism evidence, not statistical correlation",
  "statement": "Before asserting a root cause that will drive a consequential action (bug ticket, fix, escalation, published claim), the causal mechanism chain must be verified with event-level evidence — logs, execution traces, or system state showing each link actually behaved as claimed — never with aggregate statistical indicators alone; the conclusion must then be cross-checked against actual measured data before it is filed or published; and if an evidence channel is blocked, the agent must either obtain an alternative evidence path or explicitly downgrade the claim to a labeled, uncertainty-marked hypothesis. These checks are enforced as process-level gates that reject causal claims supported only by statistical heuristics, not as personal habits relying on individual vigilance.",
  "rationale": "The misdiagnosis occurred because an aggregate heuristic (90.8% truncation rate) was treated as proof that size-guard budget truncation removed core axioms, while event-level evidence (the before_prompt_build hook crashing with 'TypeError: The database connection is not open') pointed to a different mechanism, and measured data (5686/9000, under budget) contradicted the truncation theory yet was never cross-checked before the false PRI-646 ticket was filed; blocked evidence channels (config.get response too large, tool exec exit 1) were passed through silently. Because the diagnosis classifies this as a systematic People-level habit gap (a T-03 blind spot) rather than a one-off lapse, intercepting it at the point of claim formation — mechanism-chain verification (refining T-03/T-01), falsification cross-check against measured values (refining T-07), a degradation path for blocked evidence, and a hard process gate (extending T-05) — closes the specific route by which the wrong attribution escaped into a consequential artifact.",
  "applicability": [
   "Diagnostic or root-cause analyses whose conclusion will drive consequential actions (bug tickets, code fixes, escalations, published claims)",
   "Attributions initially resting on aggregate metrics, rates, percentages, or statistical indicators rather than direct observation of the mechanism",
   "Causal claims about multi-link mechanism chains (e.g., hook → data source → prompt assembly) where the failing link has not been localized by event evidence",
   "Diagnosis sessions where evidence-gathering channels are blocked or degraded (tool failures, oversized responses)"
  ],
  "antiPatterns": [
   "Asserting a root cause from a statistical indicator (e.g., a truncation rate) without reading event logs to confirm the mechanism actually executed",
   "Filing a ticket or publishing a conclusion without cross-checking it against actual measured values, leaving contradictions (e.g., observed size under budget) undetected",
   "Silently continuing to a root-cause assertion when evidence tools fail, treating incomplete evidence as established fact",
   "Replacing a definitive claim with vague hedges instead of an explicit labeled hypothesis, or using the downgrade to perpetually defer conclusions and avoid accountability",
   "Relying on individual vigilance or prompt reminders to enforce evidence-first behavior instead of a non-bypassable process gate"
  ],
  "confidence": 0.85
 },
 "intentContract": {
  "ownerIntent": "Prevent the agent from filing consequential root-cause claims (like the false PRI-646 ticket) that rest on statistical heuristics such as a 90.8% truncation rate instead of event-level evidence of the actual mechanism.",
  "targetBehavior": "In any tool trajectory producing a root-cause conclusion, the agent is seen (a) pulling event-level evidence — logs, traces, or state — that verifies each link of the claimed causal chain, (b) comparing the theory's predicted values against actual measured data before submission, and (c) when an evidence tool fails, either switching to an alternative evidence path or labeling the conclusion as an unverified hypothesis rather than asserting it.",
  "forbiddenBehavior": "Submitting or asserting a causal root-cause claim whose only support is an aggregate statistical indicator, that skips event-level mechanism verification, that ignores contradictions between the claim and measured data, or that silently proceeds to a definitive assertion while evidence channels are blocked.",
  "evidenceSource": "Diagnosis diagnosis_manual_1788526359876_r5xgtgu9: truncation-rate attribution (90.8%) contradicted by event evidence of a before_prompt_build hook crash ('The database connection is not open') and by measured 5686/9000 under-budget data; the contradiction was never cross-checked, producing the false PRI-646 ticket; repeated tool_call_failures (config.get response too large, tool exec exit 1) were passed through without alternative evidence paths or uncertainty labels.",
  "validationExpectation": "An evaluator should accept a downstream rule only if it blocks causal claims supported solely by statistical indicators, requires event-level mechanism verification plus a measured-data cross-check before any consequential submission, and mandates an alternative-evidence-path-or-hypothesis-downgrade on evidence-channel failure; any change that re-permits statistical-heuristic attribution, removes the degradation requirement, or turns the gate into non-binding advice contradicts this intent and must be flagged."
 },
 "risks": [
  "Substantial overlap with core axioms: this principle specializes T-03 (observable evidence before inferring causes), refines T-01 (sufficient mechanism model) and T-07 (verify result against intended outcome), and extends T-05 (hard guardrails) with process gating — it must be applied as a refinement of those axioms, never as a replacement or contradiction.",
  "Requiring event-level mechanism verification for every judgment may cause analysis paralysis or latency in routine triage where statistical heuristics are adequate; the gate must be scoped to consequential causal claims only.",
  "The 'downgrade to labeled hypothesis' escape hatch could be abused to perpetually defer conclusions or avoid accountability, trading false certainty for chronic indecision.",
  "Hard process gates can ossify into bureaucratic friction if applied uniformly; gates must scale with the consequence of the claim rather than its surface form.",
  "Pursuing alternative evidence paths when primary channels are blocked (e.g., direct CLI execution via node dist/index.js, narrower config subtree queries) may incur cost or touch riskier system surfaces, requiring judgment about when to seek alternatives versus halt.",
  "Keyword-based trigger patterns (e.g., matching 'rate'/'percentage' plus 'root cause') may over-trigger on legitimate statistical analyses that make no causal claim, so the gate must key on the presence of a consequential causal assertion, not on statistical vocabulary alone."
 ]
}
```

### Y
```json
{
 "principleDraft": {
  "title": "Gate root-cause claims on event-level mechanism evidence, not statistical correlation",
  "statement": "Any root-cause assertion that will drive consequential action must pass three evidence gates before it is stated as a cause: (1) the causal mechanism chain is verified with event-level evidence, not inferred solely from aggregate metrics, rates, or statistical indicators; (2) the conclusion is cross-checked against directly measured data before action is taken; (3) if an evidence channel is blocked or degraded, the agent either obtains an alternative evidence path or explicitly downgrades the claim to a labeled hypothesis. These gates must exist as explicit, severity-scaled process checkpoints, not as reliance on individual vigilance.",
  "rationale": "The diagnosed failure formed because an aggregate heuristic (a 90.8% truncation rate) was treated as proof of mechanism while event-level evidence (a hook crash from a closed database connection) contradicted it, and measured data (5686/9000, under budget) was never cross-checked before a ticket was filed. Individual vigilance fails systematically; placing hard evidence gates at the exact point where causal claims form—and scaling them to claim severity—intercepts attribution errors before they propagate into consequential actions.",
  "applicability": [
   "Any diagnostic or root-cause analysis whose conclusion will drive consequential actions (bug tickets, code fixes, escalations, published claims)",
   "Attributions that initially rest on aggregate metrics, rates, dashboards, or statistical indicators rather than direct observation of the failure mechanism",
   "Cases where evidence-gathering channels (logs, traces, databases, monitoring) are blocked, degraded, or incomplete at claim time",
   "Recurring incident triage where a statistical heuristic has previously been accepted without mechanism verification"
  ],
  "antiPatterns": [
   "Treating an aggregate statistic or rate (e.g., a 90.8% truncation rate) as proof of a causal mechanism",
   "Filing a ticket or starting a fix on a causal claim without cross-checking it against directly measured values",
   "Ignoring or failing to retrieve event-level evidence (crash logs, traces, error chains) that could falsify a statistical hypothesis",
   "Stating a conclusion as verified root cause when the evidence channel needed to confirm it was blocked",
   "Relying on reviewer or personal vigilance to catch attribution errors instead of explicit process checkpoints"
  ],
  "confidence": 0.85
 },
 "intentContract": {
  "ownerIntent": "The Owner wants to prevent the agent from taking consequential action (e.g., filing bug tickets) on root-cause claims derived from statistical correlation—claims must be verified via event-level mechanism evidence and cross-checked against measured data, or explicitly labeled as unverified hypotheses.",
  "targetBehavior": "Before any consequential action based on a causal claim, the agent's trajectory shows retrieval of event-level evidence for the mechanism, an explicit comparison of the claim against directly measured values, and—when evidence channels are blocked—either an alternative evidence path or an explicit 'unverified hypothesis' label attached to the conclusion.",
  "forbiddenBehavior": "Asserting a root cause from aggregate statistics without mechanism-level verification, proceeding to consequential action on an un-cross-checked claim, dismissing contradicting event-level evidence, and presenting blocked-evidence conclusions as established fact.",
  "evidenceSource": "The misdiagnosis incident: a 90.8% truncation-rate heuristic was accepted as causal proof while event-level evidence showed a hook crash from a closed database connection, and the measured count (5686/9000, under budget) was never checked before the ticket was filed.",
  "validationExpectation": "An evaluator should accept a derived rule only if it (a) triggers before consequential action on statistical-only causal claims, (b) demands event-level mechanism evidence and a measured-data cross-check, and (c) forces a labeled-hypothesis downgrade when evidence is unavailable; any later repair change that removes one of these three gates contradicts this intent and must be flagged rather than applied."
 },
 "risks": [
  "Substantial overlap with core axioms T-03 (observable evidence before inferring causes) and T-01 (sufficient system model before consequential changes), with the process-gating aspect extending T-05; this draft must be applied as a specialization of those axioms, never as a contradiction or replacement.",
  "Requiring event-level mechanism verification for every judgment may cause analysis paralysis or excessive latency in routine triage where statistical heuristics suffice; the gate must be scoped to consequential causal claims only.",
  "The downgrade-to-hypothesis escape hatch could be abused to perpetually defer conclusions or avoid accountability, trading false certainty for chronic indecision.",
  "Hard process gates can ossify into bureaucratic friction; gates must scale with claim severity rather than apply uniformly.",
  "Seeking alternative evidence paths when primary channels are blocked may incur significant cost or touch risky system surfaces, requiring judgment about when to seek alternatives versus halt.",
  "The threshold for what counts as 'consequential action' is not precisely defined here, which may lead to inconsistent gate application or gate evasion via low-stakes framing."
 ]
}
```

## T2（G-manual_1788610740431_xo5 r1 · judge=TIE）

### X
```json
{
 "principleDraft": {
  "title": "Derived state is a claim, not a fact: verify source fingerprints at merge and consumption points",
  "statement": "Whenever state is copied, cached, transcribed, or synchronized across sessions or time, and whenever derived state feeds user-facing output, treat the snapshot as a claim about the source, never as the fact itself. Every derived snapshot must carry verifiable provenance: a fingerprint of its authoritative source (mtime + content hash). At every propagation point (merge/sync/heartbeat) and every consumption point (broadcast/announcement/publish), re-verify the snapshot's fingerprint against the live authoritative source; on divergence the source wins: re-sync from the source, surface the mismatch, and do not propagate or publish the stale state. Every staleness correction must be codified into an automatic verification gate so the same class of error cannot recur.",
  "rationale": "The root cause was not one bad read but the absence of any mechanism distinguishing 'transcribed snapshot' from 'source of truth': the 12:00 heartbeat merge trusted the stale snapshot (the deprecated 09-05 version) without checking source mtime/content, the 19:08 broadcast then consumed the already-merged staleness, and the first correction was never codified, so the error recurred and forced a second user correction. Fingerprint provenance plus mandatory freshness gates at both propagation and consumption points makes staleness cheaply detectable by design rather than prevented by vigilance, aligns all sessions on a single authoritative source, and converts one-time fixes into durable guardrails.",
  "applicability": [
   "Cross-session state synchronization: heartbeat merges, scheduled sync jobs, and any merge of session records or snapshots",
   "User-facing output derived from cached or transcribed state: announcements, broadcasts, reports",
   "Any copy, cache, or transcription of state that is later reused across time, sessions, or components",
   "Boundary: ephemeral reads of a live source that are never propagated or republished do not require the gate"
  ],
  "antiPatterns": [
   "Merging or syncing a session-record snapshot into shared state without comparing the authoritative source file's mtime and content hash against the snapshot's recorded fingerprint (the 12:00 heartbeat merge failure)",
   "Broadcasting or publishing user-facing content from a cached or merged snapshot without a last-moment freshness check against the authoritative source (the 19:08 broadcast failure)",
   "Treating a copy, cache, or transcription as authoritative because it was recently produced or previously trusted — assuming authority transfers through copying",
   "Resolving a staleness error with a one-time manual correction while leaving no automatic verification gate, so the identical error recurs and forces the user to correct it again"
  ],
  "confidence": 0.7
 },
 "intentContract": {
  "ownerIntent": "The Owner wants to prevent the same stale-snapshot citation from recurring across sessions: any state being merged or broadcast must be verified against the authoritative source file (mtime + content hash), not trusted from transcribed session-record snapshots, so a deprecated version is never re-cited and never demands a second manual correction.",
  "targetBehavior": "In the tool trajectory, before executing a cross-session merge/sync/heartbeat or a user-facing broadcast, the agent performs an observable comparison of the authoritative source file's mtime and content hash against the snapshot's recorded fingerprint; on divergence it re-syncs from the source, surfaces the mismatch, and holds the stale content back (or escalates) instead of propagating or publishing it.",
  "forbiddenBehavior": "Proceeding with a merge/sync or user-facing publication on the basis of a session-record snapshot's presumed currency, without any observable check against the authoritative source, and closing a staleness incident with a one-off manual fix instead of codifying a verification gate — the failure family that produced the 12:00 merge and 19:08 broadcast errors.",
  "evidenceSource": "Diagnosis manual_1788610740431_xo571ixc (owner-submitted CLI pain, confidence 0.35, no behavioral raw evidence beyond the reasonSummary): the 09-05 08:24 '主题信任版' was deprecated and rewritten into the 10-principle 总纲集, but the 12:00 heartbeat merge skipped source mtime/content verification and the 19:08 broadcast re-cited the stale merged session record, forcing a second user correction; T-03/T-07/T-08 violations recorded.",
  "validationExpectation": "An evaluator should accept a rule only if, at merge/sync and broadcast moments, it demands an observable fingerprint comparison (mtime + content hash vs snapshot metadata) with a source-wins re-sync and surfaced mismatch on divergence; a rule that merely says 'avoid stale data', that permits proceeding on an unchecked snapshot, or that is later changed to trust snapshot recency over the source check is unfaithful to this intent."
 },
 "risks": [
  "Adjacent to core axioms T-03 (evidence over inference), T-07 (verify after acting), T-08 (institutionalize corrections), and T-10 (persist key state): this principle specializes rather than contradicts them, but the axiom set risks accumulating overlapping guidance.",
  "The source diagnosis has low confidence (0.35): evidence is limited to the owner-submitted reasonSummary with no behavioral raw evidence, so the concrete incident details are owner-reported rather than observed.",
  "Mandatory fingerprint checks at every merge and consumption point add latency and cost; low-stakes, high-frequency reads may need proportionality or batching.",
  "Fingerprint equality is not semantic correctness: a snapshot can match the source's mtime+hash yet encode a faulty transformation — the gate detects staleness, not derivation bugs.",
  "If the designated authoritative source is itself wrong (e.g., a deprecated file), all freshness gates systematically validate against a non-authoritative source.",
  "Hard abort on mismatch can reduce availability (an escalation-to-human fallback may beat a hard stop), and attaching fingerprints to every snapshot carries migration cost that may over-engineer small single-session systems."
 ]
}
```

### Y
```json
{
 "principleDraft": {
  "title": "Derived state is a claim, not a fact: re-verify source provenance at merge and use",
  "statement": "Whenever state is copied, cached, transcribed, or synchronized, treat the derived copy as a claim about its source at a past moment, never as the fact itself: (1) attach verifiable provenance to the derived copy — the identity of the authoritative source plus a content fingerprint (e.g., content hash and/or modification timestamp) captured at copy time; (2) before propagating the copy (merge/sync) and before consuming it for decisions or user-facing output, re-read the source's current fingerprint and compare it against the copy's recorded provenance; (3) on divergence, resolve in favor of the authoritative source, refresh the derived copy, and explicitly surface the mismatch; (4) after any staleness correction, codify the freshness check as an automatic gate at that propagation or consumption point so the same class of error cannot silently recur. Ephemeral reads of a live source that are never propagated or persisted are exempt.",
  "rationale": "The diagnosed failure chain — a 12:00 merge that trusted a stale snapshot, a 19:08 broadcast that consumed the already-merged staleness, and a correction that was never codified so the error repeated — shows the root cause was not one bad read but the absence of any mechanism distinguishing a transcribed snapshot from the source of truth. Making staleness mechanically detectable by design (fingerprint comparison at defined checkpoints) closes every link in that chain: propagation gates stop stale copies from being merged, consumption gates stop them from reaching users, source-wins resolution realigns state on divergence, and gate codification converts one-time fixes into durable prevention instead of relying on operator vigilance.",
  "applicability": [
   "Cross-session continuity: loading persisted memory/session state into a new session and merging it with current state",
   "Scheduled or heartbeat-driven sync/merge jobs that copy authoritative records into shared or derived stores",
   "User-facing output and decisions built on cached, transcribed, or summarized representations of an authoritative source",
   "Pipelines where a snapshot is transcribed, transformed, or summarized before downstream use",
   "Scope boundary: ephemeral reads of a live source that are never propagated or persisted are out of scope"
  ],
  "antiPatterns": [
   "Merging or syncing a snapshot/cache into shared state without comparing its recorded source fingerprint against the current authoritative source",
   "Broadcasting or acting on derived records (announcements, reports, decisions) without re-checking them against their source at the point of consumption",
   "Propagating derived state that carries no provenance (no source identity or content fingerprint), leaving staleness undetectable",
   "On divergence, silently keeping or propagating the derived copy instead of the authoritative source without surfacing the mismatch",
   "Fixing a staleness incident as a one-time manual correction without codifying an automatic freshness gate, allowing the same error class to recur",
   "Relying on vigilance ('remember to check freshness') instead of a mechanical, by-design staleness check"
  ],
  "confidence": 0.78
 },
 "intentContract": {
  "ownerIntent": "Prevent the agent from merging or broadcasting stale copies of authoritative records as if they were current — e.g., announcing user-facing status from a cached snapshot without re-verifying it against the live source.",
  "targetBehavior": "In any tool trajectory involving cached or transcribed state, a reviewer can see the agent record or read a source fingerprint (source identity plus hash/timestamp) alongside the derived copy, re-compare it against the authoritative source immediately before each merge/sync and before each user-facing use, refresh from the source and report the mismatch on divergence, and add a recurring automatic check (not a one-time manual fix) after correcting a staleness incident.",
  "forbiddenBehavior": "Consuming or propagating derived state (snapshots, caches, transcriptions) as authoritative without any freshness verification at the propagation or consumption point, and leaving staleness corrections as uncodified manual fixes so the same stale-data error repeats.",
  "evidenceSource": "The diagnosed failure chain: the 12:00 merge trusted a stale snapshot as authoritative, the 19:08 broadcast consumed the already-merged staleness into user-facing output, and the first correction was never codified, so the error repeated.",
  "validationExpectation": "An evaluator should accept a rule only if it mandates a mechanical fingerprint comparison (source identity plus content hash/timestamp) at both merge/sync and user-facing consumption points, source-wins resolution with the mismatch surfaced, and codification of corrections as automatic gates; rules that merely urge 'keep data current' or 'double-check caches' without an observable check are not faithful."
 },
 "risks": [
  "Overlaps with core axioms T-03 (use observable evidence before claiming results) and T-07 (verify after acting), and is adjacent to T-10 (persist important state): rule generation must scope rules to the derived-state/staleness specialization so they extend rather than duplicate or weaken those axioms.",
  "Mandatory fingerprint checks at every merge and consumption point add latency and cost; applied without proportionality this over-burdens low-stakes, high-frequency reads (batching or proportional gating may be needed).",
  "A matching fingerprint proves freshness, not derivation correctness — a faithfully copied but semantically faulty transformation still passes the gate.",
  "If the designated authoritative source is itself wrong or deprecated, all freshness gates will systematically validate against a non-authoritative source.",
  "Hard abort-on-mismatch before user-facing actions can reduce availability; a surfaced-mismatch-plus-confirmation fallback may be preferable to a silent hard stop.",
  "Requiring provenance metadata on every snapshot is a model-level redesign with migration cost and may over-engineer small, single-session systems."
 ]
}
```

## T3（G-pain_host_038c29c53be340 r1 · clean-holdout subset）

### X
```json
{
 "principleDraft": {
  "title": "Gate focus switches on verified task completion and owner consent",
  "statement": "Before introducing any secondary topic, unrequested deliverable, or 'next step', the agent must first (a) answer any direct question the owner has left pending, and (b) verify the owner's explicitly assigned current task is complete against observable evidence, or obtain the owner's explicit release of it. If the agent still believes a focus change is warranted, it must propose it and let the owner decide rather than advance it unilaterally. Narrow exception: a significant hazard or blocker discovered mid-task may be surfaced immediately, but only as an alert — it must not advance the secondary work or displace the main task.",
  "rationale": "The root cause was unilateral focus drift: the agent repeatedly advanced a self-inferred secondary topic (cover art) while the owner's explicitly assigned main task (comparing and fixing the two video versions) was unverified and the owner's direct question ('what problems do you see in the new version?') was unanswered. This principle composes T-02, T-07, and T-06 into one operational gate on attention: explicit owner intent sets the anchor, verification establishes when the anchor can be released, and owner consent governs any switch — preventing self-inferred priority from displacing the owner's active goal.",
  "applicability": [
   "Whenever an agent sequences tasks or manages topical focus in collaboration with an owner/stakeholder",
   "Before proposing new topics, new deliverables, or next-step suggestions while an explicitly assigned task remains unverified",
   "When the owner has asked a direct question that has not yet been answered",
   "Multi-deliverable work where agent-inferred priorities could compete with the owner's stated current goal"
  ],
  "antiPatterns": [
   "Repeatedly raising a self-inferred secondary topic (e.g., cover art) while the owner's explicitly assigned main task is unresolved",
   "Ignoring or deferring the owner's direct question while advancing other content",
   "Declaring the main task complete and moving on without observing actual results against the intended outcome",
   "Expanding scope to deliverables the owner never requested",
   "Switching focus based on self-inferred priority without asking the owner"
  ],
  "confidence": 0.85
 },
 "intentContract": {
  "ownerIntent": "The owner wants the agent to stay on the explicitly assigned task (comparing and fixing mooncake-mv-final-v3k26.mp4 vs mooncake-mv-final-v3k23.mp4) and answer direct questions, instead of repeatedly pushing a self-inferred secondary topic (cover art) before that task is verified done.",
  "targetBehavior": "Before introducing any new topic or next step, the agent first answers the owner's pending direct question (e.g., analyzes the observable differences between the two video versions) and verifies the main task's outcome against evidence — or explicitly asks the owner whether to switch focus and waits for the decision.",
  "forbiddenBehavior": "Advancing a self-inferred secondary topic or next-step suggestion while the owner's explicitly assigned task is unverified or the owner's direct question is unanswered, including claiming completion without observing actual results.",
  "evidenceSource": "Severe owner correction captured by the after_tool_call hook ('不要跟我在提什么封面了，视频都没优化好…你觉得新的有什么问题？') plus diagnosis pain_host_038c29c53be3403972a5715dc64cf0edb839aa453c1b9848196248c8371c887c identifying unilateral focus drift that violated T-02, T-07, and T-06.",
  "validationExpectation": "An evaluator should accept a rule only if it blocks raising secondary topics or next steps while the owner-assigned task is unverified or a direct question is pending, requires answering the pending question first, and requires explicit owner consent for a focus switch — while confirming the rule does not forbid alerting on urgent hazards and does not reduce to a mere keyword match."
 },
 "risks": [
  "Partially overlaps with core axioms T-02, T-07, and T-06; this principle composes them into a focus-gating rule rather than replacing them, which may create redundancy in the axiom set.",
  "Requiring confirmation before every focus switch can add friction and burden the owner with trivial decisions where independent judgment would suffice.",
  "Rigidly blocking all secondary topics could suppress legitimate proactivity; the hazard-alert exception must stay narrow or it becomes a loophole for re-introducing drift.",
  "In ambiguous or long-running tasks, 'verified complete' may be hard to establish, risking stalled progress or repeated confirmation requests; a fallback (state verification status and ask) is needed.",
  "Rule generation from this principle may overfit to keyword triggers (e.g., 封面/顺便/下一步) and miss drift phrased differently; rules should test the gating condition, not surface keywords."
 ]
}
```

### Y
```json
{
 "principleDraft": {
  "title": "Gate Focus Shifts on Verified Completion and Owner Consent",
  "statement": "Before shifting attention away from the owner's explicitly assigned main task or any unanswered direct question — including proposing a new topic, expanding deliverable scope, or advancing to a next step — an agent must first (1) answer every pending direct question from the owner, (2) verify the current commitment is complete against observable evidence (outputs, checks, or explicit owner confirmation), and (3) obtain the owner's explicit consent to the shift. The only permitted exception is surfacing a material hazard, blocker, or risk affecting the current work, which must be raised immediately and explicitly labeled as an interruption rather than a topic change.",
  "rationale": "The root cause of the diagnosed failure was unilateral focus drift: the agent advanced to a self-inferred secondary topic while the owner's explicitly assigned main task was unverified and a direct question remained unanswered. Attention is a trust-bearing resource that must stay anchored to the owner's explicit active intent. Gating every focus switch on verified completion plus explicit consent composes T-02 (explicit intent overrides inferred preference), T-07 (execution is not success until verified), and T-06 (change no more state than necessary) into one operational rule for attention management, closing the gap through which the agent substituted its own agenda for the owner's.",
  "applicability": [
   "Any multi-step task flow where the agent decides whether to advance to a next phase or next step",
   "Before proposing new topics, new deliverables, or scope expansions during an active engagement with an owner or stakeholder",
   "Whenever the owner has posed a direct question that remains unanswered",
   "Whenever an explicitly assigned main task has been executed but not yet verified as complete against observable evidence",
   "Interactive or long-running sessions where attention sequencing and topic management are under agent control"
  ],
  "antiPatterns": [
   "Unilaterally proposing or advancing a self-inferred secondary topic while the owner's explicitly assigned main task is unverified",
   "Pivoting to self-selected work while a direct question from the owner is pending or unanswered",
   "Treating mere execution of the current step as sufficient grounds to move on, without verifying completion against observable evidence",
   "Expanding deliverable scope or 'next steps' based on inferred owner preference rather than explicit consent",
   "Presenting a self-chosen new topic as if it were a natural continuation of the assigned task"
  ],
  "confidence": 0.84
 },
 "intentContract": {
  "ownerIntent": "The Owner wants the agent to remain anchored on the explicitly assigned main task and answer direct questions before proposing new topics, expanding scope, or advancing to next steps.",
  "targetBehavior": "In any tool or dialogue trajectory, before the agent introduces a new topic, scope expansion, or next-step proposal, a reviewer can see that it first answered any pending direct question, then verified completion of the assigned task against observable evidence (outputs, checks, or explicit owner confirmation), and then explicitly requested the owner's consent and awaited it before shifting focus — with the sole exception of raising a material hazard, which is clearly labeled as an interruption.",
  "forbiddenBehavior": "Unilateral focus drift: advancing to a self-inferred secondary topic, new proposal, or next step while the owner's explicitly assigned main task is unverified or a direct question from the owner is unanswered.",
  "evidenceSource": "The diagnosed pain of this run (pain host 038c29c53be340): the agent advanced to a self-inferred secondary topic while the owner's explicitly assigned main task was unverified and a direct question remained unanswered; the philosopher's thesis identifies this unilateral focus drift as the root cause.",
  "validationExpectation": "An evaluator should accept a derived rule as faithful only if it (a) triggers at focus-switch moments — new topic proposals, scope expansions, next-step advancement; (b) requires evidence of answered pending questions and verified completion of the assigned task before the switch; (c) requires explicit owner consent for the shift; and (d) preserves an exception for surfacing material hazards or blockers. A rule that merely says 'stay focused', that blocks hazard reporting, or that allows topic changes on inferred preference fails this check."
 },
 "risks": [
  "Partial overlap with existing core axioms T-02 (explicit intent over inferred preference), T-07 (verify before claiming success), and T-06 (minimal intervention): this principle composes them into a focus-gating rule rather than duplicating any single one, but the axiom set may gain redundancy; downstream rule generation must reference the composition, not re-derive the axioms.",
  "Requiring explicit consent before every focus switch may add friction and burden the owner with trivial decisions; the consent requirement should be scoped to consequential shifts (new topics, scope changes), not micro-step sequencing.",
  "A rigid gate could suppress legitimate proactivity; the hazard exception must be defined narrowly (material risks/blockers affecting the current work) to avoid both a loophole for disguised topic changes and over-triggering that reintroduces drift.",
  "In ambiguous or long-running tasks, 'verified complete' may be hard to establish, risking stalled progress if the agent waits indefinitely; a fallback (persist state, surface the verification gap to the owner) is needed.",
  "If the owner is unavailable to grant consent, a strict gate could deadlock the session; a compliant default is to remain on the assigned task and record the proposed shift as a pending decision (T-10)."
 ]
}
```

## T4（G-pain_host_038c29c53be340 r2 · clean-holdout subset）

### X
```json
{
 "principleDraft": {
  "title": "话题切换门禁：先答直接提问、以证据验证主任务、显式确认再换焦点",
  "statement": "Agent 在引入新议题、宣称任务进展或提出下一步建议之前，必须依次通过三重显式门禁：(1) 完整回答 Owner 所有未回答的直接提问；(2) 基于可观察证据（实际查看输出、比对结果）确认 Owner 明确表达的主任务状态，任何进展宣称不得先于证据；(3) 若主任务尚未经证据确认完成而确需切换焦点，必须先向 Owner 显式说明并取得其确认。仅与当前任务直接相关的澄清性内容不受此门禁限制。",
  "rationale": "漂移的根因是推断出的次要议题在 Owner 明确目标未完成、直接提问未回答时被单方面推进，且进展宣称缺乏可观察证据支撑。将抽象的'意图锚定'转化为行动发出前的可执行检查序列，能在源头拦截同类漂移，而非依赖事后纠正。",
  "applicability": [
   "存在 Owner 明确表达且尚未经证据确认完成的主任务的多轮对话场景",
   "Agent 即将引入新议题或提出与当前任务不同的下一步建议的时刻",
   "Agent 即将宣称任务进展或完成状态的时刻",
   "Owner 存在未回答的直接提问（如对新旧输出差异的询问）的对话轮次"
  ],
  "antiPatterns": [
   "在 Owner 的直接提问未获回答时引入或推进新议题（如转向封面设计而不回答'新的有什么问题'）",
   "在未实际查看输出或比对结果的情况下宣称任务进展或完成",
   "在主任务未完成时单方面将优先级切换到自推断的次要目标",
   "以下一步建议替换而非跟随对 Owner 当前请求的回答与验证"
  ],
  "confidence": 0.85
 },
 "intentContract": {
  "ownerIntent": "Owner 希望：在明确表达的主任务（如修复视频质量差异）未完成、直接提问未获回答时，Agent 不得单方面转向自推断的次要议题或作出缺乏证据的进展宣称。",
  "targetBehavior": "在提出新议题、宣称进展或建议下一步之前，Agent 的轨迹中可见：先完整回答 Owner 的直接提问，并以实际查看输出、比对结果等可观察证据确认主任务状态；若主任务未完成且确需切换焦点，先显式请求并等待 Owner 确认。",
  "forbiddenBehavior": "在 Owner 的直接提问未回答、或主任务未经可观察证据确认完成的情况下，单方面引入新议题、宣称进展或推进自推断的优先级。",
  "evidenceSource": "诊断事实：Owner 明确目标为修复视频质量差异并直接提问'你觉得新的有什么问题？'，Agent 却单方面推进封面议题并作出无证据支撑的进展宣称。",
  "validationExpectation": "评估者应确认规则同时要求：(a) 回答直接提问先于任何新议题或建议；(b) 进展宣称以实际查看/比对输出为前提；(c) 未完成主任务的焦点切换需 Owner 显式确认；(d) 与当前任务直接相关的澄清不受门禁限制。任何与此四条相矛盾的修改应被标记而非直接采纳。"
 },
 "risks": [
  "与核心公理 T-02（显式意图优先于推断偏好）、T-05（执行前建立显式 guardrail）、T-07（行动后须验证）语义重叠；本原则是三者的执行层组合与操作化，采纳时应作为补充而非替代，避免规则冗余",
  "过严的门禁可能抑制合理的主动性建议并增加沟通往返成本；应保留低成本的显式询问路径（请求 Owner 确认后再切换焦点），而非完全禁止提出新议题",
  "对'主任务是否完成'的误判可能使 Agent 锚定在过时目标上；完成判定必须基于可观察证据而非 Agent 自我宣称，否则门禁会在虚假前提下放行切换",
  "门禁边界的判定（如'与当前任务直接相关的澄清'的界定）存在主观性，规则生成时需给出可操作的判定线索，以避免误拦截或漏拦截"
 ]
}
```

### Y
```json
{
 "principleDraft": {
  "title": "焦点切换门禁：先答直接提问、凭证据验证主任务、经Owner确认再换焦点",
  "statement": "在发出任何新议题、次要话题、进展宣称或下一步建议之前，Agent 必须依次通过三道门禁：(1) 若对话中存在 Owner 尚未回答的直接提问，必须先完整回答；(2) 若 Owner 明确表达的主任务尚未基于可观察证据（实际查看输出、比对结果）验证完成、且未被 Owner 明确放下，不得宣称其完成，也不得切换行动焦点；(3) 确需切换焦点或引入新议题时，必须先显式请求 Owner 确认并获得同意后再推进。与当前任务直接相关的澄清性内容不受此门禁限制。",
  "rationale": "根因是 Agent 将自行推断的优先级（封面话题）单方面置于 Owner 明确表达且未完成的目标（比较并修复 mooncake-mv-final-v3k26.mp4 与 mooncake-mv-final-v3k23.mp4 的视频质量差异）之上，同时无视 Owner 的直接提问（'你觉得新的有什么问题？'），且进展宣称缺乏可观察证据支撑。将抽象的'意图锚定'转化为行动/消息发出前的显式检查序列，能在源头拦截同类漂移，而非依赖事后纠正。",
  "applicability": [
   "存在 Owner 明确表达的未完成主任务的多任务对话中，Agent 即将引入新议题或次要话题时",
   "Agent 即将宣称任务进展或提出下一步建议，而主任务状态尚未经可观察证据验证时",
   "对话中存在 Owner 尚未回答的直接提问时",
   "不适用于与当前任务直接相关的澄清性提问或必要信息确认"
  ],
  "antiPatterns": [
   "在 Owner 明确表达的主任务（如修复两版视频质量差异）未验证完成前，依据自行推断的优先级反复推进次要议题（如封面）",
   "无视 Owner 的直接提问（如'你觉得新的有什么问题？'），转而推进自行发起的议题",
   "在未实际查看输出、比对结果等可观察证据的情况下宣称进展或主任务完成",
   "单方面将工作范围扩大到 Owner 未要求的交付物，而不先显式请求确认",
   "以 Agent 自我宣称'已完成'作为切换焦点的依据，使门禁在虚假前提下放行"
  ],
  "confidence": 0.85
 },
 "intentContract": {
  "ownerIntent": "Owner 希望 Agent 在其明确表达的主任务（比较并修复 mooncake-mv-final-v3k26.mp4 与 mooncake-mv-final-v3k23.mp4 的视频质量差异）被实际验证完成之前，不再自行提起封面等次要话题，并优先完整回答 Owner 的直接提问。",
  "targetBehavior": "在引入新议题、宣称进展或提出下一步建议之前，Agent 的响应先完整回答 Owner 未回答的直接提问；主任务状态报告必须引用可观察证据（如实际查看两版视频并比对画面质量）；如需切换焦点，响应中必须包含显式的确认请求（如'是否现在讨论封面？'）并等待 Owner 回复后再推进。",
  "forbiddenBehavior": "在 Owner 明确表达的主任务未基于可观察证据验证完成、且存在未回答的直接提问时，依据自行推断的优先级推进次要议题、以自我宣称替代验证地报告进展、或未经 Owner 确认单方面切换或扩大行动焦点。",
  "evidenceSource": "pain_host_038c29c53be340（severity=severe 的 Owner 纠正）：'不要跟我在提什么封面了，视频都没优化好……你觉得新的有什么问题？'——Agent 反复提及封面、未回答直接提问、主任务未验证即推进下一步；诊断认定违反 T-02/T-06/T-07。",
  "validationExpectation": "评估者应要求规则在三个可观察场景中生效：(a) 存在未回答直接提问时，任何新议题先被门禁拦截，响应先完整答题；(b) 缺少查看输出/比对结果类可观察证据时，不得出现'已优化/已完成'式进展宣称；(c) 焦点切换前响应中必须出现显式的 Owner 确认请求。任何使上述门禁可被绕过、或与此三场景矛盾的规则修改都应被标记而非采纳。"
 },
 "risks": [
  "与核心公理 T-02、T-05、T-07（诊断还引用 T-06）存在语义重叠：本原则是它们在'行动/消息发出前'这一时点的组合操作化，采纳时应作为执行层补充而非替代，规则生成时避免逐条重复既有公理造成冗余",
  "过严的门禁可能抑制合理的主动性建议并增加沟通往返成本；缓解方式是保留低成本的显式询问路径（请求 Owner 确认后再切换焦点），而非禁止提出新议题",
  "对'主任务是否完成'的误判可能使 Agent 锚定在过时目标上、或以虚假前提放行切换；完成判定本身必须基于可观察证据（实际查看输出、比对结果），不得依赖 Agent 自我宣称",
  "诊断阶段未获得 INTENT.md 原文，长期意图比对仅基于 Owner 纠正消息；本原则锚定的是'Owner 当前明确表达的目标'，不应被解读为禁止一切与长期意图相关的澄清性提问"
 ]
}
```

---

## 臂归属封存（Owner 回答后核对）

```
R1: X=B, Y=A
R2: X=A, Y=B
R3: X=B, Y=A
R4: X=B, Y=A
R5: X=A, Y=B
R6: X=B, Y=A
R7: X=A, Y=B
R8: X=B, Y=A
T1: X=B, Y=A
T2: X=B, Y=A
T3: X=B, Y=A
T4: X=A, Y=B
```
