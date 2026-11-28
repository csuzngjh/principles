# PD-CAE Stage 0 Owner 决策摘要

> 详细证据报告：`docs/reviews/PD-CAE-STAGE0-REALITY-AUDIT.md`  
> 审查基线：`e30202366f53df60ccaf7589f7988cf445a52fba`（origin/main）  
> 状态：只读 Stage 0 完成；未改生产代码/配置/数据库/RuleCode；未创建 PR；未进入 Stage 1。  
> 测试：NOT RUN；结论来自静态源码、现有测试源码和只读 Git 证据。

## 一句话结论

**建议进入一个非常窄的 Stage 1，但仅限 offline trajectory replay 与证据质量闭合；不建议现在做任何生产 Shadow/Live 扩张。** 最终评级：`LIMITED`。

---

## 原 SPEC 哪些地方是正确的？

1. **不新建事件数据库、不新建 RuleContextV3、不新建 Temporal Engine、不实时调用 LLM、不改 Service Host。** 这些约束与真实架构匹配，应该保留。
2. **先审计 `tool_calls → RuleContextV2 → RuleCode → Host Gate` 证据质量。** 这正是当前真正瓶颈。
3. **不把 `row.id`/`created_at` 当真实因果顺序。** 源码证实 SPEC 判断正确。
4. **不把 `requireApproval` 当宿主暂停能力。** 三宿主当前都不会因此暂停工具。
5. **不宣称三宿主能力一致。** 源码证实三宿主在 hook coverage、identity、outcome、attribution、facts degradation、deny channel 上差异很大。
6. **先 Shadow/负控而不是直接 Live。** 方向正确，但还需要再提前一步：先做 offline replay，因为当前输入证据本身尚不可信。

---

## 哪些地方需要修改？

1. **把 Stage 1–4 改成 conditional decision points。** 当前不能把它们视为已批准实施路线。
2. **把 repeated-failure/Ordering 明确挂在 readiness gate 后。** 没有可信顺序、可信失败 outcome、目标归因前，不得进入 Shadow。
3. **修正“缺 normalizedPath 才跳过”的表述。** 更精确地说：shell 即使无真实资源也可能用整串 command 作为非空 normalizedPath 进入评估；“被评估”不等于“资源已归因”。
4. **补充 `unknown` outcome 的真实行为。** 它不是被静默丢弃，也不是单行降级；任一行 unknown 会使整个 history window unavailable。
5. **补充 OpenClaw 证据缺口。** adapter 未透传 toolCallId/runId；无身份时内容 dedupe 会折叠真实重复调用。
6. **补充宿主事实语义差异。** OpenClaw 在 truncated/execute/other 窗口仍可能输出伪 `priorReadOfTarget='no'`；Codex/WorkBuddy已有 conservative degradation。
7. **补充生成/评估 oracle 缺口。** 现有 Golden Trace 能携带 `ruleContext`，但不能证明跨工具、跨参数形状、跨路径写法的泛化；keyword/case-overfit 仍可能通过。
8. **明确 coverage denominator。** 覆盖率必须分为 hook unreachable、non-evaluable kind、no target、synthetic target、opaque command、resource-attributed、context unavailable、attribution unprovable、evaluated、matched、wouldBlock。

---

## 哪些功能其实已经实现？

以下不是设想，已经在生产源码中存在：

- shared production RuleHost gate；
- `RuleContextV2`、history window、facts、validators；
- host-specific RuleContext providers；
- `tool_calls` shared writer，含 `tool_use_id/project_dir/host_kind` 字段；
- Golden Trace case-level `ruleContext`；
- Shadow/Live activation 与 Owner approval/artifact digest 绑定；
- `rulehost_evaluated` telemetry；
- child-process/vm RuleCode sandbox、timeout/resource budgets；
- Service Host bounded worker ownership；
- recoveryControl marker 与 promotion 层恢复探针。

因此，CAE 不需要重建一套系统。真正要做的是**修复证据语义和评估闭环**。

---

## 最重要的真实问题是什么？

1. **`unknown` outcome 与 RuleContext ABI 冲突。** production 会写 unknown，但 assembler 只接受 success/failure/blocked；一行 unknown 让整窗不可用。
2. **真实 ordering 不可证明。** `sequenceId` 是 insertion row id；`created_at` 是写入/补记时间；verified backfill 可改变可见顺序。
3. **same-target 只在窄场景成立。** direct file path 尚可；shell、patch、多目标、agent、MCP、无路径工具都不可靠。
4. **三宿主能力不对称。** Codex identity/project scope较好但 hook coverage窄且 shell outcome常 unknown；WorkBuddy deny evidence最强但 id可选；OpenClaw hook广但 toolCallId丢失、dedupe与facts语义风险最大。
5. **生成与评估还不能证明轨迹泛化价值。** 即使手写规则可以扫 raw history，也没有 oracle 证明它区分盲目重试、有效验证后重试和合理幂等重试。

---

## 最小改动方案是什么？

**当前批准范围应保持零生产代码变更。** 最小方案是：

1. 建立 offline Golden Trace trajectory fixture pack；
2. 建立 characterization tests，固定 unknown、truncated、backfill/order inversion、dedupe、attribution 等当前行为；
3. 输出真实 coverage matrix；
4. 仅在证据证明必要时，逐个窄修：
   - OpenClaw toolCallId/runId 透传；
   - verified-only insert 的 project scope；
   - OpenClaw facts degradation 对齐；
   - `unknown` row-level semantics；
   - Codex hostKind attribution。

不要做：新 DB、新表、新后台服务、新 Rule Engine、Temporal DSL、Action Broker、RuleContextV3、生产 RuleCode 激活。

---

## 是否值得进入 Stage 1？

**值得，但必须重新定义 Stage 1。**

推荐的 Stage 1 是：

> Offline Trajectory Replay + Evidence Readiness Audit

不是：

> 生产 Shadow rollout / ABI expansion / 三宿主适配 / RuleContextV3 / Temporal Engine

Stage 1 成功标准应是能回答：

- unknown 行占比及 upgrade 情况；
- backfill/order inversion 是否真实发生；
- 每宿主可 resource-attributed 的调用比例；
- context unavailable 的真实原因分布；
- 一个 repeated-failure 规则能否在离线 labeled matrix 上区分正控/负控/幂等重试/无效证据；
- replay 与 production input assembly 是否一致。

---

## 如果不值得直接 Shadow，具体障碍是什么？

1. `unknown` outcome 会破坏 history availability。
2. 没有可信 host-native ordering。
3. OpenClaw 缺 toolCallId，重复调用可被 dedupe 折叠。
4. shell/agent/MCP target attribution 不足。
5. OpenClaw truncated facts 可能输出伪 `no`。
6. RuleCode evaluator 不能惩罚 keyword/case-overfit。
7. Shadow telemetry没有 gold label/任务后果，不能证明误拦或价值。

---

## 宿主选择建议

- **Offline replay / evidence pilot：优先考虑 Codex 形状**，因为 `tool_use_id` required、project/time cutoff较完整；但 shell outcome unknown 必须先处理。
- **真实 deny channel 验证：WorkBuddy 最强**，因为其 output/probe证据链最清晰，且 RuleContext attribution严格；但 call_id可选、无 designGate。
- **不建议以 OpenClaw 做第一 pilot**，直到 toolCallId/runId 透传、dedupe、facts degradation 得到修复或量化。

---

## Owner 需要做的决策

1. 是否批准进入上述窄义 Stage 1（offline only）？
2. 是否接受把 v1.1 SPEC 修订为“Stage 1–4 conditional decision points”？
3. 是否允许在后续独立任务中读取真实 workspace 的只读统计（unknown/NULL attribution/truncated/coverage分布）？本次未做。
4. 是否把 OpenClaw toolCallId/runId 透传列为第一候选窄修复？这很可能是投入产出比最高的修复，但仍需先确认宿主稳定 id 语义。

---

## 文件与状态

- 完整报告：`docs/reviews/PD-CAE-STAGE0-REALITY-AUDIT.md`
- 本摘要：`docs/reviews/PD-CAE-STAGE0-OWNER-DECISION.md`
- 本地工作区最终 HEAD：`e30202366f53df60ccaf7589f7988cf445a52fba`（与 origin/main 同步；任务开始时曾记录为 `3f068988cf04b22501a5c190f52f88630d1cb12f` 落后 9 个提交，审查期间发生 fast-forward）
- 审查目标 HEAD：`e30202366f53df60ccaf7589f7988cf445a52fba`
- 验证状态：静态源码审查完成；测试 NOT RUN；生产数据 NOT READ；Stage 1 NOT STARTED；未修改生产代码/配置/数据库/RuleCode。
