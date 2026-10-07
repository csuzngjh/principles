# PD 提示词容量与生效反馈修复 — 验收矩阵（2026-10-07）

任务：`adhoc-20261007-prompt-capacity-0b0891`（SPEC `PD_PROMPT_CAPACITY_V1` v1.0）。
基线 origin/main `f330acb3`。证据均为本任务 worktree 内可复现命令/测试。

| ID | 场景 | 结果 | 证据 |
| --- | --- | --- | --- |
| AC-01 | OpenClaw 开/关、Codex 开/关、未知/歧义宿主 | ✅ 已验证 | `host-runtime/tests/prompt-injection-route-and-deliverability.test.ts`（10 例路由矩阵：openclaw×flag、codex 恒共享、pain_events 证据、双宿主 flag-on 统一共享、flag-off unconfirmed+perHost、无事实 flag-off unconfirmed、显式 target 覆盖、未知宿主种类 fail-closed）；Console 侧 `?host=`/`host` 请求级参数 + 未确认横幅（FocusPage）+ `resolveLivePromptInjectionProjection` 2 例；golden 特征测试证明预测纠正不改变真实注入 |
| AC-02 | 共享路径仅一条超长且 truncated=false | ✅ 已验证 | `prompt-injection-golden-characterization.test.ts`（AC-02 root scenario：`oversized:['act-OV-S']` 且 `truncated:false` 字节级固化）；批准反馈=写入前 422 拒绝并给成本与修改入口（`governance-approve-activation.test.ts` AC-07 例）；激活列表 oversized 行带正面单条证据（`readPromptActivationInjectionStatuses` 3 例 + ActivationPage 渲染） |
| AC-03 | 可装入但未入窗口：轮转 vs FIFO | ✅ 已验证 | `prompt-injection-route-and-deliverability.test.ts`（window_excluded ≠ oversized 例）；轮转文案承诺后续轮次（queued 警告）、FIFO 文案明确"需腾出容量"（`governance-approve-activation.test.ts` AC-09 例 + shared starvation 例）；测量报告 FIFO 降级行实证（`docs/audit/PD_PROMPT_CAPACITY_MEASUREMENT_2026-10-07.md`） |
| AC-04 | 阶段 A 前后生产构建器对照 | ✅ 已验证 | `prompt-injection-golden-characterization.test.ts` 7 例：完整输出字符串精确相等（列表/共享×FIFO/轮转×自报开关），集合、顺序、预算、轮转算术逐项断言；fixture 由 pristine 代码生成（提交 747d862e 先于功能改动） |
| AC-05 | 临界长度/长标题/XML/emoji/自报开关 | ✅ 已验证 | 同上 golden + deliverability 边界例（恰满装入、超 1 拒绝并给出 overBy=1）；真实 title 派生长 id 计量例（UUID 假设移除）；路由分歧例（列表 1292 可装 / 共享 2009 超）；自报开-关翻转例（1959→2314）；XML 转义/emoji（UTF-16）在 golden 字符串中固化 |
| AC-06 | 诊断上限/缺字段/坏配置/无 DB/解析失败 | ✅ 已验证 | 投影 `oversizedActivationIds` 有界 + `oversizedDiagnosticTruncated` 标记；`readPromptActivationInjectionStatuses`：dangling activation → `resolution_failed` 带原因、无 DB/prompt flag off → `globalReason`；`loadPromptArtifactById` 失败带结构化 reason；未渲染任何"零遵守"计数（AC-12 边界） |
| AC-07 | Console 与真实 CLI parser 的预检失败 | ✅ 已验证 | Console：422 `prompt_capacity_refused`、审批仍 pending、零激活行、账本未升级（`governance-approve-activation.test.ts` AC-07 两例 + `approvals-api/nextaction` 更新例）；CLI：`runtime-activation-approve-capacity.test.ts`（真实工作区，exit 1、单一 JSON、cli-5 零 mutation）+ `--target-host` 注册/解析（flag-wiring 3 例） |
| AC-08 | 预览后工件/路由/配置变化 | ✅ 已验证 | `governance-approve-activation.test.ts` "submit-time precheck re-reads the artifact"：预览后工件加长 → 提交按新事实拒绝 |
| AC-09 | 总需求超载但单条可交付 | ✅ 已验证 | 同文件 AC-09 例：激活合同继续（200 + queued 轮转说明），无全局准入门；共享路由 starvation 文案准确 |
| AC-10 | 简短 vs 复杂候选的意义完整性 | ✅ 已验证 | Scribe prompt v5 约束（触发/动作/例外三要素 + rationale 归位 + 禁止硬上限/截断），`scribe-prompt-builder.test.ts` 2 例；B2 修订走真实 `DefaultScribeValidator`（intentContract 原样保留并在 diff 面展示）；无第二正文字段 |
| AC-11 | 替换成功/验证失败/审批拒绝/写入失败/重复请求 | ✅ 已验证 | core `prompt-replacement.test.ts`（原子替换、幂等重放、故障注入完全回滚、歧义 fail-closed、修订构建验证）；console `prompt-revision-replacement.test.ts` 7 例全矩阵（propose→diff→approve 原子替换+supersede 决策行、重放 409、验证失败零写入、拒绝保旧、重复 propose 幂等、非激活 404） |
| AC-12 | 无日志/重复日志/跨工作区同 run/旧日志缺字段 | ✅ 已验证 | `host-runtime/tests/prompt-injection-event-evidence.test.ts` 6 例（无日志=UNKNOWN 非零、重复去重计数、同 runId 跨工作区不合并、缺 runId 仍计事实但 flag、坏行 loud parseFailures、非注入事件忽略）；真实共享路径事件接线证明（测量报告 eventsEmitted=5/evidenceRows） |
| AC-13 | 阶段 C 不同预算/模板候选 | ✅ 已验证 | `packages/pd-cli/scripts/prompt-capacity-measurement.mjs`（可复现入口）+ `docs/audit/PD_PROMPT_CAPACITY_MEASUREMENT_2026-10-07.{md,json}`：双路由×自报×短/长/超长×增长×轮次丢失×重启降级；列表 13.05 vs 完整渲染口径 5.5（SPEC 快照 7.95→2.4 标注来源）；PD token=null 附理由；最终决策=默认值/计费边界/选择策略全部保持不变 |

## Error Context Router

- Pass 1（计划态）：EP-01/02/04 HIGH 命中 → 已纳入验收（结构化 reason+nextAction、生产路径集成证据、真实 parser 测试、--json 单一结果、失败零 mutation）。
- Pass 2（diff 态）：EP-03(77)/EP-02/EP-09/EP-11/EP-04 等命中 → 核对：所有拒绝/降级路径带 reason+nextAction；Console/CLI/HTTP 集成为主证据；UI 新文案全部经 t() 且 zh-CN/en 双语键齐全（评审后补齐 FocusPage 6 键）；无原始 hex 样式。无未处置 HIGH。

## 独立评审（Standards + Spec 双轨，均已收敛）

- 两个独立只读评审子代理结论 APPROVE-WITH-FIXES；全部 must-fix 已修：i18n 六键补齐、supersede 决策行 Owner 归因强化（owner_id + note 注明批准者；auth method 受 schema CHECK 约束为 system，无凭证通道）、dispatcher 格式缺陷、死代码、`?? 2000` 常量化、路由公式收敛为 `promptRouteForHost` 单一权威、api 校验器逐字段收窄、测量脚本临时目录清理、测试标题对齐新合同。
- 记录的 follow-up（不在本任务范围）：legacy 路由账本去重排除在激活页呈现为 window_excluded 而无去重专属原因（既有投影保守缺口，注释已说明）。

## 既有失败（非本任务回归，证据）

- `core/src/runtime-v2/adapter/__tests__/pi-ai-http-transport.test.ts` 1 例（google provider fetch 选择）：在 pristine main（f330acb3 主 checkout）同样失败——环境性既有失败。
- `pd-cli` 全量并行跑时 `candidate-intake-e2e` / `runtime-recovery-failed-tasks` 偶发 flake：单独重跑全绿（19/19）；本 diff 不触及 intake/recovery；`verify:merge`（串行门）见最终记录。

## Complexity Delta（按实际 diff）

- 新事实权威：NO（路由事实=现有声明+pain_events 两源复用）
- 新持久 schema/状态：NO（零 DDL；supersede 行入既有 append-only `activation_decisions`）
- 新子系统/后台进程：NO
- 新公共合同：YES——`PromptInjectionProjection` 派生字段（unit/budgetScope/oversized 等）、`PromptInjectionBudgetStatus` 扩展、`PromptArtifactDeliverability`、`readPromptActivationInjectionStatuses`、`replacePromptActivation` 可选 seam、`DispatchInput.supersedeActivationId`、`listEntryLine`、propose-revision 端点/类型（隐藏真实路由与成本差异，兼容增量）
- 新功能开关：NO
- 新跨包依赖：NO（console/cli→host-runtime 为既有方向）
- 新宿主行为：B=YES（不可交付的 prompt 激活写入前拒绝——SPEC 明确要求）；A=NO
- 新外部网络能力：NO

新公共合同（唯一 YES）的 §13 五问：
1. 既有 owner 为何不满足：投影合同原本无单位/计费范围/超长透传/路由绑定字段，Console 因此只能猜测；激活状态与可交付判定此前无任何权威实现。
2. 隐藏了什么复杂度：宿主事实两源解析、双路由 serializer 差异、UTF-16 计量、超长与截断的区分——调用方只见 deliverable/undeliverable/unconfirmed 三态。
3. 为何更小方案不够：只在 Console 内部补丁会重蹈"按 flag 猜路由"的覆辙（CLI/Console 各写一套成本判定的历史缺陷）。
4. 如何验证：AC-01..13 全部经真实 HTTP/SQLite/Commander/生产构建器边界测试 + golden 字节级特征。
5. 如何回退：全部为加性可选字段/可选 seam/新端点——回退 = 删除调用点即可，零 DDL、零数据迁移；已产生的 supersede 决策行是 append-only 治理历史，保留不删。
