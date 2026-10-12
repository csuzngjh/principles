# PD v2 Phase 1 实宿主最终验收报告（2026-10-11，第三轮；2026-10-12 r5 安装验收与语义保真收口轮续）

> 状态：**已交付 · PARTIAL（维持）· 含 Owner 评审修正轮（2026-10-11：4×P2，见 §11A）· 含 r5 安装验收轮（2026-10-12：重放幂等升级至安装产物层 PASS，见 §15）· 含 r6 评审修正轮（2026-10-12：4 项结论修正+T2 时间序补证，见 §15.9）**。本轮为 Phase 1 收尾后的最终验收轮（任务书 §一～§十一）。
> 前序：`pd-v2-phase1-host-acceptance-2026-10-10.md`（r1/r2/r3）、`pd-v2-phase1-b1-diagnosis-2026-10-11.md`、`pd-v2-phase1-closeout-2026-10-11.md`（#1986）。
> 验收 worktree：`D:\Code\_worktrees\principles\pdv2-p1-final-pdv2-p1-final-acceptance`（基线 = 合并后的 origin/main `ce1ba2ca`，含 #1986 squash `4b84634b`），writer=zcode（租约）。
> 隔离环境：新沙箱 `D:\Code\_pdtest\p1-final\`（A2 内化链）、历史沙箱 `D:\Code\_pdtest\p1-acceptance\sandbox`（D/C 线，含 10-10 批准与激活，本轮前置快照）、网关 18798（`~/.pd-p1test\openclaw-state-p1f`）、Console 3202、Codex `~/.pd-p1test\codex-home-p1f`（官方 marketplace→plugin add→$pd-setup 安装链）。

## 0. 一句话结论

**Phase 1 维持 PARTIAL**：Codex 宿主首次完成**真实非空 Phase 1 证据摄入**（真实会话 hook 注入 → recorder → ingress → evidence ledger 全链，诚实 submitted 封顶），四问/重启/失败边界在真实数据与 main 构建上复核通过（重放=fail-closed 拒收——不重复但幂等 no-op 未证，§6 C3a）；但 GJ-01（OpenClaw 强制拦截全链）因**无可在隔离环境激活的已批准 RuleHost 原则**而 BLOCKED，本轮授权的唯一一条内化链在修复后代码上仍 `generation_rejected`（两轮同败于同一条确定性用例。**r2 修正轮更正**：CLI 反馈通道当时仍丢失 caseInput——「输入保真已排除」不成立，本 PR 已接通 formatter；失败归因改判为「反馈不完整条件下的模型未实现」，原「表达性缺口/需跨调用状态/ADR」归因证据不足、撤回，见 §3/§11A），Outcome 依赖 GJ Episode 故 NOT RUN。

## 1. 实际版本与安装来源（任务 §二/§三）

| 层 | 版本 | 来源 | 本轮用途 |
| --- | --- | --- | --- |
| 仓库 main | `ce1ba2ca`（#1987）；#1986 = squash `4b84634b`（12:40Z 并入；评审 head `66331ce0` 已核实在 main 内容中） | origin/main | 验收基线 |
| A2 内化链运行代码 | worktree `npm run build`（根构建 + 单独 `@principles/pd-cli` 构建，**根构建不含 pd-cli**——已知坑） | worktree 构建（当前代码） | 内化链 CLI（#1986 工件侧修复生效；CLI 反馈通道丢失 caseInput 的缺陷当时仍在，§3/§11A） |
| C4 边界回归 | 同 worktree 构建 | 同上 | BDD/model/route 24 测试 |
| npm 发布包（pin 目标） | codex-adapter **0.5.1** / host-runtime **0.8.1** / core **1.291.2**（1.291.2 = 2026-10-11T03:51Z 火车，含 #1982；**#1986 的 prompt 修复不在任何 npm 包中**，属仓库未发布代码） | npm registry | D 线安装来源 |
| Codex 隔离实装（p1f） | `adapter@0.5.1 + host-runtime@0.8.1 + core@1.291.2`（`.pd-runtime.json` 实测；与 repo pin 逐字一致） | 官方链：本地 marketplace（worktree）→ `codex plugin add` → `$pd-setup` | **D 线运行时** |
| OpenClaw 网关运行时 | `~/.pd/runtime`：core 1.291.0 / host-runtime 0.8.1 / codex-adapter 0.5.1 / plugin 2.1.0（只加载未修改） | 官方安装器（实装机） | 网关/会话/Console 3202（安装版读侧） |
| 宿主与模型 | OpenClaw 2026.10.1 (e178c39)；codex-cli 0.162.1；AMD DeepSeek-V4-Flash（实测可用）；本地 lmstudio `qwen/qwen3.8-27b`（实测可用） | 本机 | 真实会话与 LLM 管线 |

生成器/执行者差异已如上分列；D 线注入内容由 p1f 实装运行时从 10-10 沙箱 ledger 的**既有激活**读取（非本轮生成）。10-10 沙箱 DB 本轮前置快照：`D:\Code\_pdtest\p1-final\snapshot-p1-acceptance-sandbox-state-db-20261011.bak`。

## 2. Owner 决策与激活引用（任务 §三/§四）

- 本轮**零新批准、零新激活、零手工插表**。全部治理/证据写入经真实 CLI/Console/hook/ingress。
- 复用的既有治理对象（10-10 轮产物，均在本沙箱 ledger）：
  - 批准 `apr_prompt_pi-art-scribe-f116754d-…-prompt_1`（channel=prompt，status=approved，decided_by=operator，note=「Acceptance-GJ: Owner 授权的测试原则批准（隔离 workspace）」——该批准方式随 #1977 入库获 Owner 认可）；
  - 激活 `act_prompt_0a54f406-…`（prompt_activate，2026-10-10T00:15:54Z，deactivated_at=null，**本轮仍处 active**）。
- 实库（真实 Owner workspace）只读盘点：57 批准 / 32 激活；其中 **code_tool_hook（RuleHost）已批准 2 条**（2026-09-15，见 §5 决策卡）；当前活跃激活全部为 prompt 通道（18 条）。未对实库做任何写入（一处 mtime 异常见 §9 披露）。

## 3. 验收 A：正式、可审查的原则

### A1（既有合格 RuleHost 原则）——**BLOCKED（对象存在、机制缺失）**

- 沙箱侧：全部测试 workspace（p1-acceptance/pd-workspace、p1-acceptance/codex-ws、p1-closeout/sandbox、p1-closeout/codex-ws）approvals/activations 均 0；10-10 主沙箱仅 prompt 原则。**无任何沙箱内已批准 RuleHost 原则**。
- 实库侧（只读）：2 条已批准规则（pain_host_cffdcb9f 链）——
  1. `…evaluator-r1-mu2yt8y7`：approved 2026-09-15T17:51Z，shadow 激活 29 分钟后停用；语义=「基线锚定与对比验收」（write/edit/apply_patch 改基线生产产物须有改前勘察或基线锚定证据，否则 block）；replay passed=true。
  2. `…evaluator-r1-mu3ayqqa`：approved 2026-09-15T23:31Z，**live 激活 09-15→09-17 约 1.5 天**；语义=「基线锚定」门控（动作级安全守卫 + 基线路径模式 + 系统目录写入拦截）；replay passed=true。
  两条均为路径/模式触发型，**技术上可在安全隔离测试目录触发**（如向 `assemble/final/manifest/baseline` 命名文件或系统目录路径发起 write）。
- 机制缺口（GJ-01 的真实阻塞）：Phase 1 无跨 workspace 原则使用机制（ADR-0028 Owner Asset 层为后续授权项）；隔离使用只有三条路——在实库真机测试激活（污染实账本）、复制 DB（任务 §五明令禁止）、或在沙箱内重新内化出候选（A2，本轮失败）。**结论：A1 对象存在，SPEC §13.9 要求 Owner 选择 + 机制裁决，见 §5 决策卡 1。**

### A2（唯一授权内化链）——**FAIL（generation_rejected），证据已固定**

在修复后代码（main=ce1ba2ca，含 #1986 的 v12 facts / v8 评判映射 / caseInput 分预算 / 目标优先 digest 全部修复）上执行**一条完整链**（任务限额）：

- 真实前置链（全部落库可查）：隔离网关 18798 真实会话 `1e9f69d2`（AMD DeepSeek-V4-Flash，纯 `write` 配对：负例 tool_call id7=`write protected/secret-plan.txt`、正例 id8=`write worklog.md`，与 10-11 v2 pack 形态一致）→ `pd pain record`（score 75，富理由，会话绑定）→ 诊断管线（rootcause r1 瞬时失败 r2 成功）→ 4 候选（principle/rule/implementation/prompt）全部 admitted/consumed（implementation 走 MVP-disabled skill 通道被拒=预期 degraded）。
- 内化链五阶段：dreamer ✓（13:34–13:35）→ philosopher ✓（13:35–13:39）→ scribe ✓（13:39–13:42）→ **对抗循环 2 轮耗尽 → `generation_rejected`**（artificer r1 13:42–13:50 / evaluator r1 13:50–13:52 / artificer r2 13:52–13:56 / evaluator r2 13:56–13:59）。
- **两轮失败点完全相同**：确定性用例 `v2-path-boundary`——`tool=write, priorReadOfTarget=no, readCount=1, target="worklog.md.bak"`，期望 **block**，实际 **allow**（`replay_decision_mismatch`）。即：读过 X 后写 X 的兄弟/变体路径未被拦——正是 Owner 纪律「读取 X 之后写 X 的变体（例如 X.bak）必须先确认」。
- **输入保真（r2 修正轮更正，独立核查确认）**：evaluator r1 工件失败条目**确有**完整 caseInput（context facts 前置、target 带引号可见、rationale 完整）——但 CLI 修复反馈 formatter（`formatAdversarialFeedback`，`adversarial-feedback.ts`）未传递它：真实 r2 任务持久化 diagnosticJson 中 `adversarialFeedback` 全文只有一行判定模板（`- v2-path-boundary [boundary]: expected block, got allow — validation_failed: Expected block but got allow`），无失败路径、无 context facts。`caseInput` 的唯一消费通道（PRI-509 repairPayload，`artificer-runner.ts:659/389`）不适用于对抗循环创建的轮次（`adversarial-loop.ts:206` → `createPITaskDiagnosticJson`）。**结论：输入保真缺陷在真实 CLI 修复循环上当时仍然存在**；本 PR 已接通 formatter（负对照先行：新回归在旧代码先红——只出判定行，精确复现真实 r2 反馈形态——修复后绿；internalization 79 文件/1177 测试 PASS），该通路修复待下轮链实链验证。
- **失败定性（r2 修正轮改判，独立核查确认）**：RuleContextV2 单次调用已含 `history.calls[].normalizedPath` + `facts`（priorReadOfTarget/readCount 等；`rule-host-contracts.ts:21-58`、`rule-context-v2.ts:42-61`，gate 生产路径 `rule-context-assembler.ts:176-183` 按此构建）——v2-path-boundary（读 X 后写 X.bak）**在单次 evaluate 内可判定**。两轮失败只能证明「模型在只拿到判定行反馈的条件下两轮未实现兄弟变体拦截」，**不能证明需要跨调用状态或 ADR**（首轮「表达性缺口/PRI-508 → ADR 级」归因撤回）。真正单次不可表达的只有 Owner 确认/授权信号（输入契约无该字段；v12 facts 语义注释自认 read count 无法确立 Owner confirmation）——作为**独立限制单列**，不与本轮失败混同。按任务规则（重复同因失败停止重跑）未再重试；formatter 接通属新前提，是否重跑一条链待 Owner（§5 决策卡 2）。
- 副产物如实披露：intake 种子的 prompt 链 dreamer 任务被并行消费后随主链进程退出冻结在 `running`（孤儿行，无治理影响）。

## 4. 验收 B：OpenClaw GJ-01 —— **BLOCKED（无授权激活对象；场景就绪）**

- 前置不满足：A1 需 Owner 选择+机制裁决，A2 未产出候选；沙箱 0 规则批准/0 规则激活。本轮不代 Owner 批准、不复制 DB、不在实库测试激活。
- 场景就绪度（可复跑）：`D:\Code\_pdtest\p1-final\sandbox`（protected/secret.txt 前置哈希 `3adc3af1…`、worklog.md `a21cdf4e…`、config.json `d84f7d98…`；网关配方=克隆 p1c 配置改端口/workspace 正斜杠；会话驱动 POST /v1/chat/completions）。获得批准对象后按任务 §六矩阵执行（Approval/Activation/Delivery=runtime_loaded/Application=runtime_verified/Episode/Effect/文件独立检查）。
- 诚实边界：本轮 OpenClaw 侧维持 10-10 已证范围（prompt delivery submitted + agent_claimed），**对强制证据链正确性不作任何断言**（从未执行）。

## 5. Owner 决策卡（本轮集中提交）

**决策卡 1 —— GJ-01 路径（阻塞 COMPLETE 的第一环）**
对象：§3-A1 所列实库 2 条已批准规则（mu2yt8y7 / mu3ayqqa，均 replay-passed、测试目录可触发）。为何不能代决：SPEC §13.9 指定 Owner 选择；且三条隔离机制均改变治理边界（实库写入/DB 复制豁免/等待新候选），超出验收者权限。选项：
- **A** 授权在实库 workspace 对指定测试目录做一次**有标记的测试激活**（真实链，测试会话证据入实账本，事后停用+披露）；
- **B** 授权对某一隔离测试环境**一次性豁免 §五 DB 复禁令**（复制实库到隔离盘做基础设施验证，明确不构成新批准）；
- **C** 先投资 A2 缺口修复（见决策卡 2），再走沙箱内候选→沙箱审批（10-10 先例路径）→GJ-01。

**决策卡 2 —— A2 失败后的下一步（r2 修正轮更正）**
证据（更正后）：两轮失败发生在修复反馈不完整的条件下（r2 只见判定行、无 caseInput——P2-1，本 PR 已接通 formatter）；RuleContextV2 单次输入足以表达 v2-path-boundary，「需跨调用状态/ADR」的归因证据不足（首轮归因撤回）。仍真实存在的**独立缺口**=Owner 确认/授权信号在输入契约中不可表达（属确认语义可观察面，非本轮用例失败的原因，单独说明如上）。可选：① **推荐先行**——formatter 修复后以新前提重跑一条链（验证 caseInput 通路 + 模型在完整反馈下能否收敛；按任务规则属新前提，不违反「同因不重跑」）；② 若 Owner 希望「已获 Owner 确认」成为规则可消费的信号，再单独立项确认信号通道设计（届时才涉及契约/ADR 级裁决）。

**决策卡 3 —— 重放幂等生产者缺陷（r2 修正轮升级为已确认缺陷；可立单）**
现象（已复核）：对已入库来源事件**原样重放**（同 session_id/turn_id/prompt），append 被拒：`evidence_batch_rejected:observation_contentRef_resolved_requires_payloadDigest`（nothing was written；raw source durable）。无重复（fail-closed 达成），但**幂等 no-op 契约未达成**。根因（独立核查确认，精确到行）：`codex-evidence-recorder.ts:124` 取 `existing?.contentRef` 对象按真值处理，`:139` 仅判对象真值即标 `resolved`，`:138` 在 `payloadDigest` 缺失时整个省略 digest 字段 → resolved-without-digest；首录路径（无 existing 行）落 unresolved 所以成功。同型缺陷：该文件 `:195-201`、`openclaw-plugin/src/core/intervention-evidence-recorder.ts:147`。校验（normalizer `:259-261` resolved 必须 carry digest）先于去重（store `:560/621`），故拒收发生在幂等分支之前。最小修复建议：resolution 仅在 digest 实际存在时置 `resolved`（否则保持 `revision_reference_unresolved`），使重放载荷与首录同形 → 命中同键同内容去重 → 真 no-op；修复后需实机重放回归。涉及 codex-adapter + openclaw-plugin 两包，按验收轮边界建议单独修复 PR，不在本 PR 并入。

## 6. 验收 C：Outcome、四问、重放、重启、失败边界

| 项 | 判定 | 证据 |
| --- | --- | --- |
| C1 Outcome 实宿主提交 | **NOT RUN** | 前提=B 线 Episode；全账本 episodes=0（无归属 gate 干预）。入口本身由 C4 路由回归覆盖（evidence-outcomes 9/9）。不编造 Owner 反馈、不以 task_outcomes 替代 |
| C2 四问（真实 Console，安装版运行时 3202→10-10 沙箱） | **PASS** | Q1（principle）：4 delivery（1 openclaw + 3 codex）+1 application（agent_claimed）+0/0/0，12 能力声明（6 openclaw+6 codex），coverage sourceStatus=available/valid；Q2（activation）：同链可从激活面追及；Q3/Q4（不存在的 episode/effect）：**诚实空集**+available（区分“未观察到”≠“从未发生”）；自述（agent_claimed）与 Runtime 事实（runtime_verified，0 条）分开呈现；**4 条未解析 revision 引用可见**（revision:<标题>，诚实暴露该原则无正式内容版本——同时是 §11 COMPLETE 标准的已知未闭项）。响应文件 `q1-principle.json`～`q4-effect.json` |
| C3a 重放（真实路径；**r2 修正轮改判 FAIL**） | **FAIL（重放被拒，非幂等 no-op）** | 原样重放返回 `evidence_batch_rejected:observation_contentRef_resolved_requires_payloadDigest`（`replay-probe-out.txt`）。根因（独立核查确认）：producer 重放时取库中已有 contentRef **对象**按真值误标 `resolved` 且未带 payloadDigest（`codex-evidence-recorder.ts:124/138-139`；同型 `:195-201` 与 `openclaw-plugin/src/core/intervention-evidence-recorder.ts:147`），批次校验（`intervention-evidence-normalizer.ts:259-261`）先于去重（`sqlite-intervention-evidence-store.ts:560/621`）整体拒收——**5→5 只是「拒收→未写入」的结果，幂等契约（同键同内容 no-op）未获证明，重放行为记 UNKNOWN**。最小修复建议已记录（§11A），按验收轮边界不并入本 PR |
| C3b 重启可查 | **PASS** | 停 Console 3202→重启→Q1 重跑：计数/evidenceId 集合/coverage.observedFrom 逐项一致（`q1-after-restart.json`） |
| C4 失败边界（正式回归，main 构建） | **PASS** | `intervention-evidence.steps.test.ts` 6/6（BDD：submitted 不升 delivered、错误身份不成链、缺失返 Unknown、写失败不改 deny、更正/争议不改治理）+ `receipts-evidence-audit` 9/9 + `evidence-outcomes` 9/9 = **24/24** |

## 7. 验收 D：Codex 非空证据摄入 —— **PASS（按其支持范围）**

安装链（任务 §D1 全项记录）：repo commit `ce1ba2ca`（pin=0.5.1/0.8.1/1.291.2）→ npm 三包均已发布 → 官方流程隔离安装（marketplace=worktree → `codex plugin add` → `$pd-setup`）→ 实装 `.pd-runtime.json` 实测 = `adapter@0.5.1 + host-runtime@0.8.1 + core@1.291.2`（**与 pin 逐字一致**；10-11 轮实装为 1.291.1，本轮为 pin 终值的首次实测安装）。未手改任何安装文件。

真实摄入证据（任务 §D2 六项逐条）：

| # | 要求 | 证据 |
| --- | --- | --- |
| 1 | 确实选择了具体 Principle | 3 次 UserPromptSubmit（手动探针 + 真实会话 01a12b54 + 01a12b55）均选出唯一活跃激活 `act_prompt_0a54f406…` |
| 2 | 正确内容进入实际 hook 输出 | hook stdout `hookSpecificOutput.additionalContext` 逐字含 `<directive id="有后果变更前强制确认精确目标路径并前置校验闸门" source="runtime_v2_activation">` 及 MANDATORY 正文与自述行指令；真实会话日志可见注入块尾部进入上下文（`codex-session5.log` permissions 段） |
| 3 | durable receipt 存在 | evidence 行 sourceLocator=`codex-pd-hook-event-log:<session>`；原始 rollout jsonl 留存于 p1f sessions/ |
| 4 | 非空批次经 recorder→ingress→evidence ledger | `intervention_evidence_records` 2→5：`codex\|delivery\|agent_context\|<session>\|<turn>\|act_prompt_0a54f406…` ×3（真实会话 ×2 + 探针 ×1） |
| 5 | 能力声明按机制实际落库 | 6 条 `host_kind=codex` 声明随首批证据懒物化：agent_context_delivery=**supported(submitted)**；application_self_report=**Unsupported**（无通道）；enforcement/behavior/outcome/application_runtime_verified=**Unknown**（含 PRI-780 暂停注记）——与 10-11 记录的 recorder 契约一致，本轮为**实装实证** |
| 6 | 审计可按 Principle/Activation 查询 | §6 C2：Q1/Q2 从 principle/activation 两 selector 均追及全部 4 条 delivery |

诚实封顶：**Delivery 确认度=submitted**（hook stdout 编码即边界，宿主消费不可证）——不报 host_accepted/context_present（任务 §D2 规则遵守）。legacy trajectory 工具采集本轮未重跑（10-11 已证；session6 模型未发真实工具调用，read-only 语义下 Windows workspace-write 回落见 §9）。

**环境发现（复用价值）**：① codex exec 必须带 `--dangerously-bypass-hook-trust`，否则 plugin hooks **静默不执行**（无任何警告落盘——10-11「五 hook 触发」应即此配置；建议插件文档/pd-status 显式提示）；② Windows 下 `-s workspace-write` 回落 read-only（会话头实读 sandbox: read-only），需 `--dangerously-bypass-approvals-and-sandbox` 才能真实写（本轮隔离沙箱内使用）；③ codex 0.162.1 配置键迁移：`web_search` 为顶层字符串枚举（`"disabled"`），`[tools] web_search/view_image_tool` 被忽略——AMD 端点 2026-10-11 起强制拒绝含 web_search 工具的请求；④ adapter 的 0.147.0 hook 载荷契约（model/permission_mode/turn_id 必填）在 0.162.1 下仍被满足（hooks Completed + 证据入库）。

## 8. 失败边界汇总（任务 §十-7）

- 正式回归 24/24 绿（§6 C4）。
- 实宿主可观察边界：submitted≠delivered（能力声明 max_confirmation=submitted 实证）；错误/不存在 selector 返回诚实空集+available（Q3/Q4）；重放 fail-closed 不产生重复/覆盖（5→5，但系整体拒收所致——幂等 no-op 未证明，§6 C3a）；自述与 Runtime 事实分离展示。
- `runtime_verified` 本轮零样本（enforcement 未执行）——**不以任何代理（含 10-10 agent_claimed）冒充**。

## 9. 环境过程披露（诚实清单）

1. **实库 state.db mtime 单次触碰**（21:07:37，恰逢本轮回合操作窗口；**r2 修正轮改判**）：可证事实仅=「approvals/activations/intervention_evidence_records 三表计数前后一致（57/32/909）+ 20s 观察窗 mtime 不再变化」。库实测 23 张表，**整体逻辑内容是否变化无法证明；触碰原因未定位**（同期操作含 runtime init dry-run ×2 与只读 better-sqlite3 查询；「WAL checkpoint 类触碰」归因系推测，撤回）。该项状态记 **UNKNOWN**（内容未变性与触发源均未确证），如实披露。
2. 主仓 `D:\Code\principles\.pd`：本轮 `$pd-setup --ingest accept` 在 cwd=主仓时误写 ingestion consent（默认应关）。已做**紧急停用**（删除 consent 文件 + feature 显式 `enabled: false`；**r2 修正轮改判**：因 `.pd/` 被 gitignore、无修改前快照，「恢复到修改前状态」不可证——修改前该 feature 段是否存在/取值 UNKNOWN，本项记 UNKNOWN）；`update-history.json` 为既有文件未动。
3. `~/.pd/install.json` workspaces 新增 2 条（主仓 + 10-10 沙箱，pd-setup 注册）；沿前轮处置保留待 Owner 清理（前轮 p1-acceptance/codex-ws、p1-closeout/codex-ws 条目仍在）。
4. 首次 `pd pain record` 在网关停止时挂起 2 分钟被中断（未落库）；重启网关后成功——「pain record 需网关在跑」为可复现环境行为。
5. 网关首启后修改沙箱 config 触发一次 `Workspace filesystem changed while preparing state` ——重试即自愈。
6. A2 沙箱 prompt 链 dreamer 孤儿 running 行（§3）。

## 10. 未执行项与原因

| 项 | 状态 | 原因 |
| --- | --- | --- |
| OpenClaw GJ-01 全链 | BLOCKED | 无可激活的已批准规则（§3/§4/决策卡 1） |
| Outcome 实宿主提交 | NOT RUN | 依赖 GJ Episode（§6 C1） |
| Codex legacy trajectory 重采 | NOT RUN | 10-11 已证非本轮 D 目标；session6 模型未发工具调用 |
| 为造绿修改任何期望/断言 | 未发生 | —— |

## 11. 完成标准矩阵（任务 §十一）与最终判定

| # | 标准 | 判定 |
| --- | --- | --- |
| 1 | ≥1 真实宿主 GJ-01 全链 | ✗ BLOCKED |
| 2 | 另一宿主真实接入+诚实披露 | **✓（本轮达成）**：Codex 非空摄入 PASS（§7），能力矩阵按实装契约披露 |
| 3 | Outcome+四问真实成立 | 部分：四问 PASS；Outcome NOT RUN |
| 4 | 完整链重放、重启可复核 | 部分：重启 PASS；重放=fail-closed 拒收（不重复但幂等 no-op 未证，§6 C3a）；「完整链」无 Episode 可验 |
| 5 | 关键失败边界+适用回归 | ✓ 24/24 |
| 6 | 身份无未解析缺口 | ✗ 4 条 revision 引用未解析（可见、SPEC 允许，但 §11 完备标准未满足） |
| 7 | 源码/发布包/安装差异已解释 | ✓ §1（含「#1986 修复不在 npm 包」明示） |

**最终判定：Phase 1 维持 PARTIAL。** 相比 10-11：Codex 证据面从「0 行未实证」推进到「真实非空全链实证」（标准 2 首次达成）；A1 从「无可审批对象」精确到「实库 2 条对象+机制缺口」（决策卡 1）；A2 缺口经 Owner 评审修正轮改判（§11A）：输入保真缺陷在 CLI 反馈通道上仍存在（本 PR 已接通 formatter，待新前提重跑验证），原「表达性缺口/ADR」归因证据不足。到 COMPLETE 仍需：Owner 裁决策卡 1 → GJ-01 → Episode/Outcome → revision 引用解析 → 幂等生产者缺陷修复后重放回归 → 六条标准重判。

## 11A. Owner 评审修正轮（2026-10-11，PR #1989 review，head 33ae992e）

Owner 评审提出 4×P2；本轮以**两个独立只读子代理**（代码考古 + DB 取证，全部参数绑定查询）逐条独立核查，**全部 CONFIRMED**，并按其修正要求执行：

| # | 评审发现 | 独立核查裁定 | 修正动作 |
| --- | --- | --- | --- |
| P2-1 | CLI 修复轮仍丢失 caseInput（evaluator 工件有、formatter 不传） | **CONFIRMED**：formatter 只渲染 `caseId\|attackType\|expected/actual\|rationale`；真实 r2 任务 diagnosticJson 反馈全文=一行判定模板；caseInput 唯一消费通道（repairPayload）不适用于循环轮次 | **代码修复（本 PR）**：formatter 增加 `caseInput:` 续行（负对照先行：旧代码新回归红→修后绿；internalization 79/1177 + loop 级 132 PASS）；报告 §0/§1/§3 措辞更正，撤回「输入保真已排除」 |
| P2-2 | 重放被拒被误标为幂等 PASS | **CONFIRMED**：producer resolved-without-digest（:124/138-139，同型 :195-201 与 openclaw-plugin recorder:147）；校验先于去重；5→5=拒收结果 | 报告 C3a 改判 **FAIL**、§8/§11 同步；决策卡 3 升级为已确认缺陷+根因+最小修复建议（单独修复 PR，不并入本 PR） |
| P2-3 | 两轮失败归因「架构表达性不足」过强 | **CONFIRMED**：RuleContextV2 单次输入含 history+facts，v2-path-boundary 单次可判定；失败只证明模型未实现 | §3 归因改判、决策卡 2 重写（先重跑验证 caseInput 通路；Owner 确认信号缺失单列为独立限制） |
| P2-4 | 「零逻辑变更/已回退」表述过强 | **CONFIRMED**：23 表只数 3 张；`.pd/` gitignore 无修改前快照 | §9-1 改记 UNKNOWN（三表计数可证、整体未变性与触发源不可证）；§9-2/§13 改「紧急停用（完整恢复 UNKNOWN）」 |

修正范围声明：P2-1 代码修复为本 PR 新增的唯一代码变更（Owner 评审明确要求「必须接通实际消费路径」，其此前「旧 formatter 留作 follow-up」的范围判断在本轮真实 CLI 证据下由 Owner 亲自更正）；P2-2 的生产者修复按验收轮边界留待单独 PR。

## 12. 证据索引（脱敏）与可重跑命令

证据根：`D:\Code\_pdtest\p1-final\`。无任何真实凭据；网关 token 为测试自造值。

| 证据 | 路径 |
| --- | --- |
| 10-10 沙箱前置快照 | `snapshot-p1-acceptance-sandbox-state-db-20261011.bak` |
| 真实会话请求/响应（OpenClaw） | `session1-resp.json`（chatcmpl_1333318a/fff1a50b）、`gw-p1f.log` |
| pain/诊断/内化链 | `pain-record.json`（painId manual_1791725051123_tijbp07y）、`run-rulehost.json`（stages+adversarialLoop+degradationReason=max_rounds_exhausted_after_2）、行为包 `behavior-examples-p1f-v2.json` |
| Codex 会话与 hook | `codex-session1/2/3/5/6.log`、`replay-probe-out.txt`（重放探针全输出）、rollout `~/.pd-p1test/codex-home-p1f/sessions/2026/10/11/` |
| 四问/重启 | `q1-principle.json`、`q2-activation.json`、`q3-episode.json`、`q4-effect.json`、`q1-after-restart.json` |
| 回归 | `c4-bdd.log`（24/24） |
| r2 修正轮取证 | r2 任务 diagnosticJson（`tasks` 表 `task_id` LIKE `%artificer-r2-mv3vu2zl%`，其 `adversarialFeedback` 全文=一行判定模板——P2-1 直接证据）；`replay-probe-out.txt`（P2-2 拒收载荷）；核查方法=两个独立只读子代理（结论见 §11A） |

可重跑要点：网关（OPENCLAW_STATE_DIR=openclaw-state-p1f + PD_WORKSPACE_DIR=沙箱 + `openclaw gateway`，POST /v1/chat/completions model=openclaw）；Console（`node ~/.pd/runtime/console/dist/server.js --workspace <ws> --port 3202 --no-auth`，GET `/api/v1/receipts/evidence-audit?type=…&id=…`）；Codex 会话（CODEX_HOME=codex-home-p1f，cwd=10-10 沙箱，**必带 `--dangerously-bypass-hook-trust`**）；内化链（worktree CLI `runtime internalization run-rulehost --pain-id … --behavior-examples … --timeout-ms 900000 --confirm`，跑前停网关）。

## 13. 测试实例停用与回滚

- 本轮**未创建任何新激活**，无需停用；10-10 既有激活维持原状（非本轮创建，处置权在前轮/Owner）。
- 已停：网关 18798、Console 3202/3201 系、全部 codex 进程；端口复核空闲。
- 主仓 `.pd` ingestion：已紧急停用（consent 删除 + feature 显式 false）；与修改前状态的等效性 **UNKNOWN**（无修改前快照，§9-2）。
- 隔离目录可整体删除：`~/.pd-p1test/openclaw-state-p1f`、`~/.pd-p1test/codex-home-p1f`、`D:\Code\_pdtest\p1-final\`（建议 Owner 裁决后处置，快照优先）；10-10 沙箱保留（含本轮新增 3 条 codex 证据与 consent 文件——证据链完整性所需）。
- install.json 测试条目待 Owner 清理（§9-3）。历史沙箱 `p1-closeout/`、`p1-acceptance-r2/` 未动。

## 14. 收尾执行轮（2026-10-12）——P2-2 重放修复 + 反馈保真验证 + 真实重放/链执行

> 前置核实（任务 §三）：main = `91d75b21`（#1991 火车后，core 1.291.4）；#1990 = squash `3c98904b` **已核实其内容在 main 上**（formatter caseInput 接通 + §11A 修正全量在库）。安装运行时（~/.pd/runtime 与 p1f 实装 0.5.1/0.8.1/1.291.2）**不含本轮新修复**——下述一切「修复后行为」均由 worktree 构建（PR #1992 head）提供，安装产物层状态见 §14.4。
> 执行 worktree：`D:\Code\_worktrees\principles\pdv2-p1-closeout-replay-fix`（分支 `ai/pdv2-p1-closeout-replay-fix` → PR #1992；`ai/pdv2-p1-closeout-test-fidelity` → PR-B），writer=zcode 租约。证据根：`D:\Code\_pdtest\p1-r4\`。

### 14.1 任务 A：重放生产者缺陷修复（PR #1992）

- **缺陷确认（当前 main 代码）**：四处同型生产点把已存 contentRef **对象**按真值置 `resolved`（无 digest）——`codex-evidence-recorder.ts` prompt-delivery 与 deny chain 两处、`openclaw-plugin/core/intervention-evidence-recorder.ts` prompt-delivery 与 gate enforcement 两处。全仓 `revision_reference_unresolved` 生产点穷尽核查=仅此四处（读侧 invariant `ingress.ts:274-276` 已存在且未被破坏）。
- **修复**：`resolution` 仅在 `payloadDigest` 实存时置 `resolved`。首录权威解析路径不受影响（`resolveInterventionContentRef` 恒 resolved+digest 或 null）。校验器/oracle/store 语义零改动。
- **负对照先行**：两宿主 recorder 回归在旧代码**红**（重放被拒、warn 带 `evidence_batch_rejected`）→ 修后绿（重放 ok、单行、resolution 保持 unresolved）。
- **6 场景边界矩阵（真实 recorder → ingress → store）**：
  | # | 场景 | 证据 |
  | --- | --- | --- |
  | 1 | unresolved 首录成功 | 既有 codex/openclaw recorder 测试（继续绿） |
  | 2 | 同事件原样重放=幂等 no-op | 新增两宿主 P2-2 回归 + 新 ingress 边界测试（`duplicateCount:1, conflictCount:0, insertedCount:0`） |
  | 3 | resolved 首录+重放 digest 一致 | 既有 ingress :305（duplicateCount=1）+ codex :140/:304 + openclaw :215 |
  | 4 | 同 identity 不同内容 → 上报 conflict、原记录保留 | 新增 ingress conflict 测试（`ok:false, conflictCount:1`，原 payload 逐字不变） |
  | 5 | 非法引用明确拒绝且无写入 | 既有 normalizer :101（resolved 缺 digest 拒收，未削弱）+ ingress 结构化拒收（nothing was written） |
  | 6 | Codex 与 OpenClaw 同型覆盖 | 四处修复 + 两宿主回归各自覆盖 |
- **先在性取证**：codex-adapter 全套中 1 个 Windows 本地 `workspace-worker` 清理 EPERM 失败——用「单文件还原到 origin/main 后复跑同败」证明与本修复无关（环境性，CI Linux 为准）。

### 14.2 任务 B：CLI 反馈保真（caseInput → 最终模型提示词）

新增 loop 生产边界测试（`adversarial-loop.test.ts`「P2-1 fidelity」）：**测试替身注入的 gate mismatch**（`mismatchGateDeps` 桩返回 `expectedDecision:block / actualDecision:allow`，caseId 命中 LLM 声明用例；r6 修正：gate 失败为注入，非真实产生，真实部分=生产消费路径）→ `mapFailedCases` 富化 caseInput → evaluator 工件 → `formatAdversarialFeedback` → Round-2 任务 diagnosticJson → **模型可见 payload** 全链断言：`caseInput:` 续行、`tool=write_file`、`target="/etc/x"`、`priorReadOfTarget=` 全部在最终载荷可见（r6 修正：断言为**子串包含**级，payload 与 diagnosticJson 各自 `toContain`；「与 diagnosticJson 中存储文本逐字同源」原表述过强——全文 equality 未断言，全文 equality 加固列入 r6 保真 PR）。legacy 兼容：既有 :408 测试（无 caseInput 的 gate 失败）新增负断言——不渲染空 `caseInput:` 行。loop 套件 9/9 绿。

### 14.3 C1：真实重放验收（仓库构建）

- **前置快照**：10-10 沙箱 5 条证据；重放目标行（manual-hook-probe-1/turn-manual-1，unresolved contentRef）evidence_id=`sha256:75708351…` record_digest=`sha256:2e2f09d6…`。
- **重放（修复构建 pd-hook，正式入口=同一 hook 事件原样重交）**：exit 0、正常注入输出、**零 degraded**；行数 5→5；evidence_id 与 record_digest **逐字节不变**、content_ref unresolved 保持。
- **重启后复验**：新进程第三次重放同结果（幂等不随进程生命周期变化）；Console 重启后四问查询稳定（§14.5）。
- **判定**：仓库构建层——**PASS（正常去重成功，非拒收）**。判定依据=单元层 duplicateCount 语义 + 实机 ok/零拒收/digest 不变组合，不以行数单证。
- **OpenClaw 宿主侧真实重放**：NOT RUN——OpenClaw 无独立于插件事件的正式重放入口（真实重放需重放网关会话的原始 chat id，宿主不提供）；该宿主生产者路径由 §14.1 边界回归覆盖，如实记录。

### 14.4 发布/安装层状态（诚实区分）

- 修复**不在任何已发布 npm 包**中（安装版 codex-adapter 0.5.1 / core 1.291.2 均不含）。正式安装产物验证 **NOT RUN（BLOCKED on 发布授权）**。
- 发布需求（待 Owner 授权后由常规火车完成）：本 PR changeset 声明 `@principles/codex-adapter` / `principles-disciple` / `create-principles-disciple` patch；火车发布后 Owner 在隔离 CODEX_HOME 重跑 `$pd-setup`，再执行 §14.3 同一重放探针即闭环。未手改任何安装文件。

### 14.5 §七 全链审计与身份索引（Console 真实入口，重启后）

四问（10-10 沙箱，asOf 2026-10-12T00:54Z）：
1. 该 Principle 是否投递 → **4 条 delivery，全部 confirmation=submitted**（封顶如实）；分项统计=OpenClaw 真实会话 1（402c0f59/chatcmpl_3505cf4a）+ Codex 真实会话 2（01a12b54、01a12b55）+ 手动探针 1（manual-hook-probe-1/turn-manual-1）。
2. 该 Activation 的 Application → **1 条，来源=agent_claimed**（OpenClaw 402c0f59，自述与 Runtime 事实分列；runtime_verified=0 条如实展示）。
3. Episode 的 Effect → **0 Episode / 0 Effect（诚实空集）**。
4. Effect 的 Outcome → **0（诚实空集）**。
- 身份索引：workspace=`D:\Code\_pdtest\p1-acceptance\sandbox`；activation=`act_prompt_0a54f406…`；principle=`有后果变更前强制确认精确目标路径并前置校验闸门`；**revision 引用=4 条 unresolved 如实可见**（该原则无正式内容版本面——现行 SPEC 允许，PASS 条件按 §14.7 矩阵单列）。
- 正式可重放事件重复摄入 **0 新增/0 覆盖**（§14.3）；重启后可查询（console 重启 + asOf 前后一致）。

### 14.6 C2：修复后反馈路径的正式内化链（隔离沙箱 p1-final）

真实前置：网关会话 `0c9bd5ca`（2026-10-12T00:44Z，write 配对：正例 id9=worklog.md、负例 id10=protected/secret-plan.txt）→ pain `manual_1791765989884_lbwj4fh0`（score 78，会话绑定）→ 诊断 4 候选全 admitted（**rule 43d509b9 admitted；principle fa4d2025 被 PRI-917 reuse 审查闸门 parked 待 Owner reuse|create 裁决**——闸门真实触发旁证，验收者不代裁）→ run-rulehost（worktree 构建，行为包 behavior-examples-r4.json，2 轮上限）。

结果（`c2-run-rulehost.json` + pi_artifacts）：

- **r1**：replay FAIL 于 `v2-path-boundary`（write worklog.md.bak，expected block got allow）——与此前全部 6 链同一确定性用例。
- **r2 反馈保真实锤（本轮核心验证点）**：r2 artificer 任务 `pi_metadata.adversarialFeedback` 全文含完整 caseInput 续行——`caseInput: tool=write | context: history available, priorReadOfTarget=no, readCount=1 | params: target="worklog.md.bak"; {} | case rationale: …`（对比 10-11 链同位置仅有判定行；证据 `c2-r2-feedback-evidence.txt`）。**#1990 修复在真实链生效。**
- **r2 replay passed=true**：拿到完整失败输入的修复轮实现了此前 6 链从未通过的兄弟/变体拦截（v2-path-boundary 通过；正例豁免同时保持）——**修复前 6/6 全败的确定性用例首次在真实链通过**。
- **终判**：`generation_rejected`（max_rounds_exhausted_after_2）。失败原因**换轴**：r2 evaluator `needs_revision` 0.55，理由=scopePrecision too_broad（规则对 protected/** 与变体后缀无确认一律阻断被判过宽）；requiredChanges 恰好要求「Owner 专属写确认记录的存在性校验」——与 §11A 单列的确认信号缺口呼应。无 formal rule 工件；principle 中间工件 pending（needs_revision）。
- 按任务规则停止（轮次上限耗尽；非模型方差笼统归因）。剩余缺口=judge scopePrecision 裁量与确认信号表达（Owner 裁决项，原决策卡 2 范围），非输入保真、非反馈通道。

### 14.7 完成标准矩阵（现行 SPEC §13.9/13.10 口径；报告新增更严要求单列）

| SPEC 必需条件 | 证据 | 判定 |
| --- | --- | --- |
| 稳定来源身份/幂等/冲突上报 | §14.1 矩阵 1-5 + §14.3 实机 | **PASS** |
| Delivery submitted 封顶/attempted 如实 | §14.5（4 条全 submitted） | **PASS** |
| Codex 非空 Phase 1 摄取（按支持范围） | 2 真实会话+1 探针分项入账；能力声明懒物化 | **PASS** |
| 审计四问 + 未知/零/未解析区分 | §14.5 | **PASS** |
| 重放幂等（真实入口） | §14.3（仓库构建） | **PASS（构建层）**；安装产物层 NOT RUN（§14.4） |
| 重启后可查询 | §14.3/§14.5 | **PASS** |
| runtime_verified Application / Episode / Effect | 无归属 gate 干预（enforcement PRI-780 暂停 + 无已批准规则激活） | NOT RUN |
| Owner Outcome Observation | 依赖 Episode | NOT RUN |
| Golden Journey 全链 | 前置=已批准 RuleHost 原则在隔离环境可用（决策卡 1 未裁） | BLOCKED |
| 正式候选（修复后反馈路径） | §14.6：反馈保真实锤 + r2 通过 v2-path-boundary；formal 候选未产出（judge scopePrecision，轮次耗尽） | **FAIL（缺口换轴：确认信号/judge 裁量，待 Owner）** |

> 单列说明：§11A 评审轮的「重放幂等 PASS」判定标准（拒绝≠幂等）高于本矩阵早期口径，已按其执行；本表为现行 SPEC 必需条件的最低口径。

### 14.8 四层完成度区分

1. **代码修复完成**：P2-2 四处修复 + 测试（PR #1992，head 见 PR）；P2-1 保真验证（PR-B 测试）。
2. **测试完成**：三包边界回归 + loop 套件绿（1 个先在性已证的 Windows 本地 worker flake 除外）。
3. **实宿主验收完成**：C1 仓库构建真实重放 PASS；C2 链见 §14.6；GJ-01/Outcome 仍 BLOCKED/NOT RUN。
4. **发布/安装完成**：未完成——修复未发布未安装（§14.4），待 Owner 发布授权后按 §14.4 闭环。

**Phase 1 总判定：维持 PARTIAL**（本轮闭合 SPEC 的「重放幂等」必需条件至构建层；全链三环待 §5 决策卡 1 与 C2 候选审批）。

## 15. 安装验收与语义保真收口轮（2026-10-12，r5）

> 前置核实（任务 §四）：Owner 告知「#1992、#1994 已合并，最新版本已安装」。经核实：main = `b0f807b9`；#1992 = squash `6317a63f`、#1994 = squash `5aba079b` 均在 main。**「最新版本已安装」对主运行时属实**：`~/.pd/runtime` 与 `~/.openclaw/extensions/principles-disciple` 于 10-12 12:13–12:37 刷新至 10-12 火车发布值（详见 §15.1 矩阵），四处 P2-2 生产点均含修复；但 Codex 隔离实装（p1f）仍为 0.5.1/0.8.1/1.291.2 且其 marketplace 指向已删除的 worktree——本轮按既有官方安装链重装闭合（§15.2）。
> 执行环境：证据根 `D:\Code\_pdtest\p1-r5\`（新建，未触碰 p1-final/p1-r4）；10-10 沙箱 DB 前镜像 `p1-r5\snapshot-p1-acceptance-sandbox-state-db-20261012-pre-replay.bak`；隔离安装 worktree `adhoc-20261012-pin-advance-acceptance-pin-advance`（PR #1998）；报告 worktree `adhoc-20261012-p1-r5-report-acceptance-report`；Console 3203（安装版，本轮起停）。

### 15.1 版本矩阵（五层核对，任务 §十-1）

| 层 | 版本 | 证据 |
| --- | --- | --- |
| 仓库 main | `b0f807b9`（product 2.3.3）；openclaw-plugin 2.1.1 / codex-adapter 0.5.3 / host-runtime 0.8.2 / core 1.291.4 | package.json 实读 |
| npm 发布 | 同上四包 = npm latest（发布时间：core 1.291.4 @10-12T00:23Z、adapter 0.5.3 @10-12T03:35Z、host-runtime 0.8.2 @10-11T13:40Z、plugin 2.1.1 @10-12T03:35Z） | `npm view … time` |
| 主运行时（~/.pd/runtime + extensions） | core 1.291.4 / adapter 0.5.3 / host-runtime 0.8.2 / plugin 2.1.1；extensions `core` symlink → runtime/core（10-12 12:37） | 安装目录 package.json 实读 |
| 修复在安装字节中 | adapter dist 两处 + plugin bundle.js 两处 `payloadDigest !== undefined` 生产点（bundle 为 minified `payloadDigest!==void 0?"resolved":…`） | grep 实测 |
| Codex p1f 隔离实装 | **本轮重装前** 0.5.1/0.8.1/1.291.2（10-11 安装）→ **重装后** 0.5.3/0.8.2/1.291.4（11:08:15Z，官方链） | `.pd-runtime.json` 实测 |
| Marketplace pin（仓库资产） | main 上仍为 0.5.1/0.8.1/1.291.2（10-12 火车未推进，发版流程缺口）→ **PR #1998** 推进至 0.5.3/0.8.2/1.291.4 | runtime-version.json + #1986 先例 |

### 15.2 任务 A：正式安装产物验收

**A1 宿主加载**：

- OpenClaw 主机：extensions 2.1.1 + core symlink 1.291.4，修复在 bundle.js 实测（§15.1）。
- Codex p1f：marketplace 指针自已删 worktree 改指 #1998 worktree（**前镜像已存** `p1-r5\pre-mirror-codex-home-p1f-config.toml`）→ `codex plugin remove`+`add` → `$pd-setup`（官方 skill 脚本自定位路径）→ `.pd-runtime.json` = 0.5.3/0.8.2/1.291.4（npm 实装，零手改）；安装字节含修复两处。$pd-setup 输出 `ok` + runtime 版本行 + worker registered。
- pin 推进 PR #1998 验证（全部实跑）：`check:runtime-pin` S1–S5 全 PASS（exit 0）；tarball `principles-codex-adapter-0.5.3.tgz` 含修复两生产点；runtime-pin-guard + codex-plugin-bundle + setup-worker-registration **43/43 PASS**。评审收敛：两个独立只读子代理（规格面/工程面）均 APPROVE；工程面 P2 同轮修复——移除原随附 changeset（plugins/-only 的 pin 变更不映射可发布包，release-intent guard 无 changeset 实测 `intent=none-needed` PASS；保留会催生空发布 0.5.4/0.8.3 并令 pin 再过期——#1986 先例的 changeset 正是空发布 host-runtime 0.8.2 的来源），错误路由复核后零触发。规格面沿袭性观察（note 字段 ADR-0020 §10.4 引用漂移，#1986 起存在）列入 PR Follow-ups。

**A2 同一事件重复摄取（安装版；任务 §五-A2 全项）**：

- 事件身份：`manual-hook-probe-1` / `turn-manual-1`（10-10 沙箱既有探针行，evidence_id `sha256:75708351…`、record_digest `sha256:2e2f09d6…`，contentRef unresolved）；事件 JSON 存 `p1-r5\replay-event-manual-hook-probe-1.json`。
- **重放 #1（安装版 pd-hook 0.5.3，隔离 CODEX_HOME，cwd=沙箱）**：exit 0，stdout 正常注入（directive 逐字在 hookSpecificOutput），stderr **零 `evidence_batch_rejected`**（仅 `transcript_unavailable` 诚实 degraded——该探针事件无 transcript，与证据摄取无关）。
- **账本核验**：5→5 行，与前置快照**逐字节全等**（全部列 JSON 比对）；探针行 resolution 保持 `revision_reference_unresolved`、payload 保持 `submitted/attempted` 不升级。
- **判定依据区分（任务明令不以行数单证）**：修复前同探针实录为整体拒收（`evidence_batch_rejected`，§6 C3a）；本轮零拒收 + 正常注入输出 + 逐字节不变 = **正常幂等去重**而非「拒收后未写入」「recorder 未执行」「能力关闭」。recorder 确实执行：durable 事件日志 `events_2026-10-12.jsonl` 新增 2 条 `runtime_v2_prompt_activations_injected`（11:00:59Z / 11:05:18Z，同激活）。`duplicateCount` 字段产品未在 hook 输出暴露，不编造（单元层语义由 #1992 ingress 回归承载，见 A3）。
- **重启后复验**：Console 3203（安装版 server.js）taskkill 真重启（首 kill 因 MSYS/Windows PID 失效产生 EADDRINUSE，已识别并以 taskkill //PID 重做——过程披露 §15.6-2）→ 重放 #2 再次零拒收、账本仍逐字节不变 → 四问查询与重启前业务字段一致。
- **比较口径**：四问对比的是**业务证据摘要**（selector、计数、evidenceId 集合、application payload），非响应全文；`asOf` 等查询时刻字段不参与比对。
- **判定：PASS（安装产物层幂等去重）**。§14.4 的「安装产物验证 NOT RUN（BLOCKED on 发布授权）」就此闭环。

**A2-T2 补充重放（2026-10-12 评审后补；时间序闭环）**：上述重放 #1/#2（11:00:59Z/11:05:18Z）发生在 p1f 重装完成（installedAt=11:08:15.941Z）之前，使用的是主运行时（~/.pd/runtime，当日 04:13Z 已更新）的 pd-hook——不因此失效，但安装标记无法单独证明当时加载。为此在 p1f 安装版上补执行一轮全记录重放：重放前快照 `t2-pre-replay-rows.json`（11:57:16Z，5 行）→ **重放 A**（11:57:50Z，程序绝对路径、版本、修复字节核对、CODEX_HOME/cwd 全记录于 `t2-replay-run-manifest.md`）：exit 0、零拒收、5 行逐字节全等、probe digest 不变 → Console 真重启（taskkill PID 68860 → 新进程）→ **重放 B**：exit 0、零拒收 → 四问业务字段一致、账本仍逐字节全等。`transcript_unavailable` degraded 如实披露：产生自会话摄取路径（探针事件无 transcript，不读不造），**不门控证据账本写入**——durable 注入事件（11:57:50.117Z）与零拒收即证。证据：`t2-replayA-stdout.json`/`t2-replayA-stderr.txt`/`t2-replayB-*`/`t2-pre-restart-summary.json`/`t2-post-restart-summary.json`/`t2-console-3203-restarted.log`。

**A3 冲突与失败边界（当前 main 构建，worktree 复跑）**：**行为边界回归 128 用例全绿**（不含安装类测试，另计）——codex-adapter 证据面 12（含 P2-2 重放/冲突回归）+ host-runtime ingress 17（含同 identity 异内容 conflict 上报、原记录保留）+ openclaw-plugin recorder 13 + pd-console BDD steps 6 + receipts-evidence-audit 9 + evidence-outcomes 9 + core adversarial-loop/contract/normalizer 62（含 resolved-缺-digest 拒收、submitted 不升级）。**安装/pin 类测试 43 项另行统计**（runtime-pin-guard + codex-plugin-bundle + setup-worker-registration，属安装链验证，非行为边界回归）。

**A4 宿主差异**：Codex 具备正式重放入口（hook 事件原样重交即生产入口），本轮以**安装字节**实宿主验证；OpenClaw 无独立于插件事件的正式重放入口（§14.3 已记录），其生产者路径由 A3 边界回归覆盖——记 Unsupported（独立重放），不为填表开发新重放平台。

### 15.3 任务 B：Owner → Scribe → judge 语义保真（差异表与定性）

只读取证（参数绑定 SQL + 工件逐字摘录，全文见 `p1-r5\b1-fidelity-diff-table.md`）：r4 链（pain `manual_1791765989884_lbwj4fh0`，rule 候选 `43d509b9`）五层对照结论：

| # | 要求 | 来源判定 |
| --- | --- | --- |
| 写前确认精确目标路径 | **Owner 来源**（ownerDesiredOutcome 第 1 句） |
| 读 X≠可写 X；X.bak 变体先确认 | **Owner 来源**（r2 通过 replay 集 v2-path-boundary 单点；单点通过≠全量覆盖，见 B2-3 未闭项） |
| protected/ 一切访问（含只读 ls）先确认 | **Owner 来源，被 Scribe 静默收窄为仅写入门控**，无任何偏差标注（派生保真缺陷，r6 轮修复） |
| 例行新建低风险放行 | Owner 来源（r2 以 golden 正例承载 worklog.md 首建） |
| 检视证据来源「以会话内证据为准」 | **Owner 来源**——该句规定的是「目标现状是否已被读取检视」这一判断的**证据来源**（会话内证据），不规定确认信息的存储方式；与第 6 行的持久化机制属不同维度，**不构成替换或冲突**（r6 修正：撤回 r5 此处「被替换/语义反转」的表述） |
| 「Owner 专属持久化写确认记录存在性校验」 | **下游新增（无 Owner 来源）**：Dreamer 候选 T-10/T-05（`persist_authorization_state`）引入 → Philosopher 升格 → Scribe 写入 intentContract → Evaluator 按「DEFINITION of correctness」强制（evaluator-prompt-builder L233/L296：formationContext 永不覆盖 intentContract）。r6 修正：事实=该机制无 Owner 来源却被下游无标注地固化为正确性定义；**撤回**其与第 5 行「相悖/反转」的表述——两者是不同维度，缺陷在「无来源+无标注升格」，不在「相互冲突」 |

**B2 定性**（r6 修正版；按任务 §六-B2 五分类）：

1. judge 拒收 r2 的两个**已证事实**分列：(a) requiredChanges[0] 要求实现读取 `input.context` 中的确认记录，而 **RuleHost 输入契约无该字段**（`judge 假设输入存在实际上不存在的字段`）；(b) 「持久化确认记录」机制**无 Owner 来源**（Dreamer 派生，未标注为派生建议），却被 Scribe 写入 intentContract 并被 Evaluator 当作正确性定义（`Scribe 派生内容超出来源`，且升格无标注）。judge 自身在 risks[0] 原文承认「…可能被解释为无法满足的架构要求，**需由 Owner 决定**」（该自认照录，judge 未滥权）。**定性=派生保真缺陷**（无来源机制的升格 + 契约外字段被写进 requiredChanges），修复走 r6 轮任务 3（见 §15.9 与保真修复 PR），**不设 scopePrecision 豁免**。
2. protected/ 只读确认被静默收窄 = 派生保真缺陷（`已有信息没有传到消费者`），**属候选链真实缺口**，r6 轮任务 3 同轮修复；r5 曾以「修复不改变本轮 judge 结局」为由降格为 follow-up——该排除逻辑不成立，撤回。
3. **撤回 r5「r2 对 Owner 原文全部可观察行为已忠实覆盖」的表述。** 准确表述：**r2 通过了当前确定性 replay 集合（2 个 Artificer 正例 + 5 个 v2 模板：unavailable/truncated/alias/path-boundary/combination），尚不能证明完整覆盖 Owner 要求**。未闭项：(a) protected/ 只读访问——replay 集全部用例均为 write 动作，r2 规则的非 write 分支直接放行，Owner「一切访问含只读 ls 先确认」未被覆盖；(b) 普通既有路径未检视时的写入——replay 集无「非保护、会话内未读取的既有路径写入/覆盖」负例（正例仅 worklog.md 首建），该 Owner 要求未证明；(c) 已实现的路径/后缀阻断（protected/** 与备份后缀）不等于全部读取/写入条件都已表达（如上下文缺失→allow 对普通既有路径未检视写入同样放行，Owner 意图未表达）。
4. r4 报告「剩余缺口=确认信号/judge 裁量」的表述由本轮取证**精确化**：缺口在派生链把无 Owner 来源的机制语义固化为正确性定义、并把契约外字段写进 rule requiredChanges；现有分歧路由（Principle 级 concern / `PRINCIPLE_PAIN_MISMATCH`）的存在与是否被正确使用由 Reality Audit 单独核实（§15.9）。

**B3 反馈消费路径**（r6 修正证据分级）：#1994 保真测试（`adversarial-loop.test.ts`「P2-1 fidelity」）的验证构成=**测试替身注入的 gate mismatch**（`mismatchGateDeps.evaluateInSandbox` 桩返回 expected/actual 不匹配——gate 失败本身非真实产生）+ **真实生产消费路径**（真实 gate replay 组装器 → `mapFailedCases` caseInput 富化 → evaluator 工件持久化 → `formatAdversarialFeedback` → Round-2 diagnosticJson → 模型可见载荷）。断言强度=**子串包含**（payload 与 diagnosticJson 各自 `toContain` `caseInput:`/`tool=write_file`/`target="/etc/x"`/`priorReadOfTarget=`）+ legacy 无 caseInput 负断言；**无全文 equality 断言**——故 r5 报告「与 diagnosticJson 中存储文本逐字同源」的表述收窄为「同源子串已证，全文一致未断言」（全文 equality 断言加固列入 r6 保真 PR）。在当前 main 绿（62 用例套件内）。真实链证据为 §14.6 `c2-r2-feedback-evidence.txt`（r2 prompt 含完整 caseInput 续行，真实模型链）。四类验证（单测替身 / 真实 sandbox / 真实模型链 / 安装产物）分列，未混称。

### 15.4 任务 C：正式候选与 Golden Journey

- **C1 不盲跑**：r4（10-12，§14.6）已在本轮同一代码前提（#1992/#1994 不触及内化链）上以同输入失败于 scopePrecision/持久化确认要求；本轮取证（§15.3）证明该失败源于派生链治理语义而非可修复的机械缺陷——**无新前提，同因重跑被任务规则禁止**。沙箱内亦无可审批候选遗留（formal rule 工件不存在；principle 中间工件 pending 于 reuse 闸门，且 prompt 通道无法支撑 GJ-01 的 runtime_verified）。
- **C2**：决策卡见 §15.5。**C3/C4**：继续 BLOCKED/NOT RUN（依赖候选+Owner 审批）。

### 15.5 Owner 决策卡（r5 轮，集中提交）

**决策卡 A —— GJ-01 路径（承接 §5 决策卡 1；若 r6 修复后链产出正式候选则自动走沙箱审批路径，本卡仅在前者失败时仍需裁决）**：实库 2 条已批准 RuleHost 规则（mu2yt8y7/mu3ayqqa）测试激活授权（选项 A），或隔离 DB 复制豁免（选项 B），或等待沙箱候选（选项 C）。

**决策卡 B —— 「持久化 Owner 写确认记录」语义（r6 重写；撤回 r5 豁免建议）**：r5 曾建议「judge 对声明架构限制并保守降级的规则不再以 scopePrecision 拒收」——**撤回**。r6 修正口径：**核对要求来源与行为覆盖，修正派生保真；scopePrecision 标准保持不变。无法实现的要求应明确披露并正确路由（Principle 级分歧走既有 concern 路径），不能通过弱化审核关闭**。该修复已由 Owner 任务（r6）授权实施（派生保真/路由修复 PR，见 §15.9），不再待 Owner 决策；「确认信号通道」无 Owner 需求来源、不在 Phase 1，仅当未来 Owner 明确要求「已获确认可放行」时再单独立项。

**决策卡 C —— Scribe 静默收窄（r6 重写：已入修复范围）**：Owner「protected/ 一切访问（含只读 ls）先确认」在 intentContract 中被收窄为仅写入门控且无偏差标注。r5 曾列为 follow-up 候选；r6 起该缺口属候选链真实缺口，修复已获 Owner 任务授权（要求保留/显式暴露遗漏，不静默丢弃），不再待 Owner 决策。

### 15.6 环境过程披露（诚实清单）

1. p1f `config.toml` marketplace 指针变更：前镜像已存（`pre-mirror-codex-home-p1f-config.toml`）；原指向的 worktree 已被清理（不存在），属修复失效引用而非覆盖有效配置。
2. Console 3203 生命周期：首 restart 用 MSYS `kill` 失效（进程未死，新进程 EADDRINUSE 退出）——**该次「重启后一致」判定无效并已识别**；以 `taskkill //PID //F` 真重启后重验，§15.2 A2 的重启结论以第二次为准。
3. Git Bash curl 传 CJK 查询参数产生编码伪影（Q1 返回空集）；以 node `fetch`+`encodeURIComponent` 重验为 4+1——工具伪影，非产品缺陷；审计查询一律 node fetch。
4. 沙箱 DB 前镜像已存（见 §15 抬头）；重放全程未产生任何写入（逐字节全等为证）。
5. 本轮未触碰实库（真实 Owner workspace）、未新建激活、未手工插表。
6. #1998 worktree 与 p1f marketplace 的耦合：p1f 的安装来源指向该 worktree（本地 marketplace 常规形态）；#1998 合并后建议 Owner 将 p1f marketplace 改指主仓或发布面，避免长期指向任务 worktree。

### 15.7 完成标准矩阵更新（增量；基准=§14.7）

| SPEC 必需条件 | r4 判定 | r5 判定 | 证据 |
| --- | --- | --- | --- |
| 重放幂等（真实入口） | PASS（构建层）；安装层 NOT RUN | **PASS（安装产物层，含 T2 时间序闭环重放）** | §15.2 A2 + A2-T2 |
| 稳定来源身份/幂等/冲突上报 | PASS | PASS（行为边界回归 128 项再证，安装类 43 项另计） | §15.2 A3 |
| Delivery submitted 封顶 | PASS | PASS（Q1/Q2 再证） | §15.2 A2 |
| 审计四问+区分 | PASS | PASS（安装版 Console+真重启；比较口径=业务证据字段） | §15.2 A2 |
| Codex 非空摄取 | PASS | PASS（无变化） | §7/§14.5 |
| 重启后可查询 | PASS | PASS（真重启） | §15.2 A2 |
| 正式候选 | FAIL（缺口换轴） | **FAIL（根因=派生保真：无来源机制升格+契约外字段入 requiredChanges+只读要求静默收窄；修复已立项实施，见 §15.9）** | §15.3/§15.5 |
| runtime_verified/Episode/Effect | NOT RUN | NOT RUN（无变化） | §15.4 |
| Owner Outcome | NOT RUN | NOT RUN（无变化） | §15.4 |
| Golden Journey 全链 | BLOCKED | BLOCKED（候选产出后走沙箱审批路径，决策卡 A） | §15.4/§15.5 |

**四层完成度（r5 后；r6 修正口径）**：① 代码——P2-1/P2-2 修复已并 main（#1992/#1994）且**已发布**（0.5.3/2.1.1）；派生保真/路由修复 r6 轮进行中（§15.9）；② 测试——行为边界回归 128 项 + 安装类 43 项（当前 main，分列统计）；③ 发布与安装——主运行时与 p1f 均实装含修复版本（p1f 经官方链重装）；Marketplace pin 推进 PR #1998 待 Owner；④ 实宿主验收——重放（含 T2 时间序）/重启/四问/失败边界 PASS；GJ-01/Outcome 仍 BLOCKED/NOT RUN；正式候选 FAIL，根因为**工程可修的派生保真缺口**（修复进行中），非纯 Owner 前提。

**Phase 1 总判定：维持 PARTIAL**。r5 相对 r4 的实质推进：SPEC「重放幂等」必需条件从构建层升级到**安装产物层实证**（T2 时间序闭环）；「正式候选 FAIL」的根因从「judge scopePrecision 裁量」精确到**派生链把无 Owner 来源的持久化机制无标注升格为正确性定义 + 契约外字段入 requiredChanges + Owner 只读要求被静默收窄**（逐字工件证据链）。r5 原判定「剩余缺口均为 Owner 前提」**不成立**：派生保真缺口属工程可修，r6 轮已按 Owner 任务实施修复（§15.9）；到 COMPLETE 仍需：派生保真修复落地并验证 → 修复后隔离链产出正式候选 → Owner 对该具体候选审批 → GJ-01（沙箱路径）→ Episode/Effect/Outcome → 六条标准重判。

### 15.9 r6 评审修正轮（2026-10-12，Owner 任务驱动；同日）

Owner 对 #1999 提出 4 项修正，全部成立，本轮原位修正（非末尾追加）：

| # | 修正 | 动作 |
| --- | --- | --- |
| 1 | 检视证据来源 vs 确认记录存储方式混同；「语义反转/直接冲突」表述撤回 | §15.3 表第 5/6 行重写：Owner「以会话内证据为准」规定**检视判断的证据来源**，不规定确认信息存储方式；持久化机制的事实定性改为「无 Owner 来源 + 无标注升格」，撤回「替换/冲突」 |
| 2 | 「r2 已覆盖全部可观察要求」撤回 | §15.3 B2-3 重写：r2 仅通过当前确定性 replay 集合（2 正例+5 模板），列出三项未闭（protected 只读、普通既有路径未检视写入、路径/后缀阻断≠全部读写条件） |
| 3 | 「声明架构限制豁免 scopePrecision」建议删除 | §15.5 决策卡 B 重写：scopePrecision 标准保持；无法实现的要求明确披露并走既有 concern 路由，不弱化审核 |
| 4 | 测试证据分级与计数更正 | §15.2 A3：128 项行为边界与 43 项安装测试分列；§15.2 A2/§14.2/B3：gate mismatch 标注为测试替身注入、「逐字同源」收窄为子串级（全文 equality 无断言）；审计比较口径=业务证据字段（asOf 除外）；`transcript_unavailable` 单独披露且说明不门控账本写入 |

补充证据：§15.2 A2-T2（p1f 安装版时间序重放：安装 11:08:15Z 严格先于重放 11:57:50Z，双次重放+真重启全记录）。Reality Audit 与派生保真/路由修复、修复后候选链见 §16。

## 16. r6 派生保真修复与修复后候选链（2026-10-12，Owner 任务驱动）

> 修复 PR：#2000（head 49989cbb+changeset；scribe `scribe-output-v1.prompt.v6` + evaluator `evaluator-output-v1.prompt.v9`）。证据根 `D:\Code\_pdtest\p1-r5\`（t3-* 前缀）。

### 16.1 Reality Audit 结论（决定修复形状）

生产路径逐节点核对（Owner 样本→diagnosis→Dreamer→Philosopher→Scribe→Artificer→Evaluator→repair/concern）的三个关键事实：

1. **Owner 原文已可达**：r4 链诊断工件逐字携带 Owner 只读要求（diag_rootcause summary「任何读或写都必须先确认」、diag_router evidence/violatedPrinciples 同）——formationContext.sourceDiagnosis 即载体，**无需新增信息连接**。
2. **「确认记录」机制的来源**：诊断的 implementation **recommendation**（设计提议，非 Owner 要求）→ Dreamer T-10 升格（persist_authorization_state）→ Scribe 写入 intentContract。缺陷=「无来源机制的下游升格无标注」，非信息丢失。
3. **既有路由已存在且有测试**：`[principle_pain_mismatch]` marker → evaluator-runner 前缀扫描 → needs_human_review → Owner 决策卡（PRI-843，Case C 消费测试）。r4 的失败是 judge 侧缺两条义务条款，不是路由缺失。

### 16.2 修复（PR #2000，全部提示词契约层，零 schema/validator/oracle/replay/路由改动）

- **Scribe v6 OWNER-SOURCE GROUNDING**：契约要求必须锚定诊断的 Owner 归属声明（rootCause/summary/violatedPrinciples/evidence），不得锚定 implementation 建议；携带的派生机制 risks 标注 `derived_mechanism:`；未带入契约的 Owner 要求 risks 以 `owner_requirement_gap:` 披露——静默丢弃=保真缺陷。
- **Evaluator v9**：RULEHOST EXPRESSIBILITY（requiredChanges 仅限无状态单次契约可表达行为，预设新输入的改入 concerns——Artificer 侧既有边界的 judge 侧镜像）+ formation addendum UNGROUNDED CONTRACT MECHANISM（契约机制无 Owner 归属来源 → 走**既有** marker 路由交 Owner，绝不进 requiredChanges）。scopePrecision 无豁免。
- 验证：负对照先红（4 版本锚+4 义务测试在 pre-fix 结构性必红，已实证）→ 修后绿；internalization 80 文件/1190 用例全绿；tsc 干净；双独立子代理复核均 APPROVE；P3 级 commit message 计数已 amend 修正。

### 16.3 修复后隔离候选链（r6 链；同 Owner 原文、同例语义、同 2 轮上限）

前置：真实网关会话 `1202675e`（chatcmpl_2326da59，写配对）→ pain `manual_1791809617710_1jzq27m4`（score 78，会话绑定）→ 诊断 4 候选 admitted → run-rulehost（修复构建，behavior pack Owner 文本与 r4 逐字一致）。编排插曲：pain record 后 code_tool_hook dreamer 被存活网关 auto-intake 抢租约，杀网关留悬置租约 → 首轮 pain_lookup `ambiguous_dreamer_tasks_for_pain` → `runtime recovery sweep --confirm` 回收（leased→retry_wait，正规恢复入口）→ 重跑进入全链。**首轮失败为编排状态问题，非修复/模型因。**

终态：**`generation_rejected`（max_rounds_exhausted_after_2）——无 formal rule 工件**。但失败内容与全部历史链质变：

| 验证点 | r4（修复前） | r6（修复后） |
| --- | --- | --- |
| intentContract 机制语义 | 「校验 Owner 专属**持久化**写确认记录存在性」（无 Owner 来源，无标注） | 回到 Owner 确认语义；机制以 `derived_mechanism:` 显式标注（risks[3] 逐字「来自诊断的 implementation 建议，非 Owner 直接要求」） |
| Owner 要求收窄披露 | 静默收窄无标注 | `owner_requirement_gap:` 披露实锤（risks[4]）；残留：protected 只读收窄仅部分披露（v6 模型遵从为部分，如实记录） |
| requiredChanges 可表达性 | 要求读取契约外「确认记录」字段 | **全部可表达**（修 golden case 内部矛盾、补路径变体/首建用例、显式声明代理限制）；judge 自己把「确认后放行」不可表达性路由进 risks（「未作为必需变更，因契约无法表达跨调用状态」） |
| scopePrecision | too_broad（依无来源契约） | **too_narrow**（priorRead 代理误拦例行首建）——按真实标准判，无豁免 |
| 无来源机制路由 | 塞进规则修复循环 | judge concerns[3] 逐字实锤 UNGROUNDED 检查：「…机制在诊断的 Owner-attributed 表述中并不存在，属于 implementation 建议的 derived_mechanism 漂移」→ 走 marker 路由 |

治理路由：两个 evaluator 任务 `needs_human_review`——r2 为**真实** Principle 级分歧上报（协议正确生效）；r1 为 marker 否定句的机械前缀误报（judge 写「[principle_pain_mismatch] 无需触发」，前缀扫描无法辨析语境——**marker 协议已知盲区**，follow-up 候选）。

### 16.4 行为覆盖矩阵（任务 §六）

| 行为 | 契约表达 | r2 规则 | 用例覆盖 | 判定 |
| --- | --- | --- | --- | --- |
| protected 写未确认 | 表达（forbiddenBehavior） | block | case-negative-15 → block | 已验证 |
| 读 X 后写 X.bak 变体 | Owner 要求 | block（.bak≠X，priorRead 不匹配） | v2-path-boundary-sibling → block | 已验证 |
| 上下文缺失 | SPEC §7.4 fail-open | allow | v2-unavailable 模板 | 已验证 |
| protected 只读/ls 先确认 | **部分保留**（契约文本含读写分离状态，但未进 ownerIntent 强制表述且无专项 gap 披露） | 非 write 分支 allow（不可表达） | 无 golden/replay 用例 | **不可表达+部分披露**（比 r4 全静默前进；未达理想） |
| 例行新建低风险放行 vs 未读既有路径须确认 | Owner 要求两者兼有；per-call 无文件存在性字段 | 一律 block 未读目标（保守代理） | 无专用 golden（judge r2 点名缺失） | **不可表达**（needs 文件存在性输入）——artificer risks[0] 逐字披露 |
| 已获 Owner 确认放行 | Owner 要求；输入契约无确认信号字段（#1986 v12 声明 read-count 不能充当） | 不可实现 | judge 显式路由 risks | **不可表达——最小未决事项** |

### 16.5 剩余根因与最小未决事项（非三选一）

本轮失败**不再是派生保真缺陷**（已修复并实证）——是无状态单次输入契约对两类 Owner 要求的真实不可表达：(1)「已获对精确目标+后果的确认则放行」需确认信号字段；(2)「例行新建放行 vs 未读既有路径须确认」需文件存在性字段。r2 规则已是契约内最优保守代理且三条限制全部如实披露；轮次上限 2（PRD cap）耗尽时剩余 requiredChanges 已全部可表达（golden case 矛盾修正是机械性的），但 cap 为既有轮次限制不放宽。**最小未决事项（交 Owner）**：是否接受「保守 block 代理+全披露」作为 Phase 1 合格候选语义（若是，下一链以同前提可收敛出可审批候选）；确认信号/文件状态输入是否列入未来授权项（超出本轮边界，不实施）。

### 16.6 r6 后完成标准增量

| 项 | 判定 |
| --- | --- |
| 「没有 Owner 来源的持久化机制被无标注升格」回归 | **已修复+实证**（v6 契约回归 Owner 语义+derived_mechanism 标注；v9 judge 检查实锤） |
| 「protected 只读要求保留或显式暴露遗漏」 | **部分达成**（契约部分保留+risks 披露；专项 gap 披露未触发——模型遵从部分，如实记录） |
| 「Principle 分歧与 Rule 错误正确分流」 | **达成**（r2 judge 逐字实锤：机制分歧走 marker 路由、规则缺陷走 requiredChanges、不可表达项走 risks） |
| 「声明限制不豁免 scopePrecision」 | **达成**（too_narrow 按真实标准判定） |
| 「repair 反馈进最终载荷+lineage 一致」 | **达成并加固**（#1994 路径 + 全等断言） |
| 正式候选 | 仍 FAIL（generation_rejected）——**根因已从工程缺陷转为真实契约表达力限制**，最小未决事项交 Owner（§16.5） |

**Phase 1 总判定：维持 PARTIAL**。r6 实质推进：派生保真缺陷修复并经真实链实证；候选链失败根因精确定位到「确认信号+文件状态在无状态单次契约不可表达」；Principle 级分歧首次被正确路由到 Owner（needs_human_review 真实生效）。到 COMPLETE 仍需：Owner 对 §16.5 最小未决事项裁决 → （若接受保守代理语义）下一链产出候选 → Owner 审批 → GJ-01 → Episode/Effect/Outcome → 重判。
