# Scenario E — RuleHost Repair Loop（failure → evidence → repair → validated）

## 设计

E 不需要独立环境：验证对象是管道自身的失败→修复环（PRI-634 A/B 的核心交付）。
素材来自 C 场景 pain 的 code_tool_hook（rule）与 prompt 渠道链在真实运行中的失败路径。

## 观察记录（全部真实发生，零注入）

### E-1 Artificer 输出契约重试（prompt 链 70c44b4a）

`artificer-70c44b4a` attempt 1 `output_invalid` → retry_wait → **attempt 2 succeeded**。
LLM 输出不合契约时的自动重试路径生效（artificer_output_retry flag 域）。

### E-2 对抗重放门拦截 code-bearing 产物（rule 链 e6e9636b + 7067acd7）

evaluator 失败原因（原文）：

> PRI-634 R3: Artificer artifact … is code-bearing and the evaluator approved it,
> but the deterministic adversarial replay did not run
> (reason: no_adversarial_cases_after_merge). Refusing to report succeeded with
> adversarialResult=null — that is the chain-48371236 terminal state.
> Fix: have the Artificer emit affectedTools plus at least one positive
> golden-trace case carrying a path, or supply LLM adversarialCases.

**这正是 R4 的"adversarialResult 由运行时权威持有"防线**：LLM 自称通过不算数，
确定性重放没跑就不许报成功，且失败原因携带精确修复指引。规则产物未修复前
终止在 terminal state 而非放行——伪造保护生效。

### E-3 原则修订循环（prompt 链 cf9ceca8，最强证据）

rollout_reviewer 判定 `needs_revision`（INV-04：禁止带伤进审批队列），重开 scribe，
修订指令（原文摘录）：

1. 评估必须与对抗失败（**v2-path-boundary**：同名解释器但运行时上下文不同；
   **v2-combination**：版本+编码组合信号）和解——要么论证允许，要么调整原则范围与
   可验证动作；
2. 原则须为边界条件补充显式 antiPattern；
3. 测试装备需模拟真实环境变异（含隐藏配置差异）防止部分属性变更绕过校验。

**对抗重放不仅拦截，还产出了具体、可执行的修订要求**——failure → detailed evidence →
repair 的闭环在原则（非仅规则）层面运转。

### E-4 progressive evaluator 的 tier2 证据守卫（垃圾链 22107f3e / b95a3a35 / 70c44b4a）

> evaluator stage2: required tier2 evidence unavailable (diagnostician.raw.evidence)
> — refusing to issue a deep-evidence verdict without it.

P0 缺陷期间产生的上下文饥饿链全部被两段评估器拒绝签发深证据结论——
即使 dreamer 层的护栏缺失，评估层仍未放行垃圾（纵深防御）。
（注：这些链失败是 P0 的下游症状；修复后新链不再出现该形态。）

### E-5 历史 repair 轮（基线盘点确认）

09-01 链存在 `artificer-repair-evaluator-…-r1/r2` succeeded——PRI-634-A 的
修复轮在该工作区真实跑通过（与 memory 记录一致）。

## 结论

Gate 3（至少一次 repair success）：**达成**——E-1（artificer 重试转成功）与
E-3（needs_revision 重开修订）均为真实修复环；E-2 展示了"拒绝无证据成功"的
终态保护。规则渠道的完整 artificer-repair→PASS 环在本次窗口内未收敛
（Artificer 需补 affectedTools/golden-trace 输出——已作为 follow-up 记录）。
