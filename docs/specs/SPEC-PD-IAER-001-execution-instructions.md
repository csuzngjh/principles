# SPEC-PD-IAER-001 — 后端开发代理一次性实施指令

> **目标：** 端到端实现 `docs/specs/SPEC-PD-IAER-001-v1.0.md`，包含 Phase A（P0 前置止血）、Phase B（P0 Owner 补证恢复）、Phase C（P1 遥测与历史只读审计）。  
> **任务类型：** 工程实施、测试、独立复核及交付；不是设计讨论，也不是让 AI 自动补写 Owner 治理证据。  
> **根目录：** `D:\Code\principles`  
> **必须完成的结果：** 隔离分支上的可评审代码 + 自动/CLI 真实 SQLite E2E + 测试/实施报告 + 安全回滚说明。  
> **基线：** 编写本指令时 PD `39ebac3f5`；本地 `D:\Code\pi-mono` 为 Pi 1.2.0，但**此任务不升级 Pi**，PD 当前依赖及安装运行时为 0.85.1。

## 一、对开发代理的执行授权与硬边界

你是已获授权开展本次 SPEC 工程实现的后端 AI 开发代理。**不要为常规读代码、创建隔离 worktree、编译、单测、临时数据库 E2E、修复、提交自己分支等操作反复请求审批或暂停等待 Owner。** 先做可验证的工作，在遇到一般技术分支时根据规范、当前源码和最小变更原则自行取舍并记录原因。

但是此工程授权**不等于**产品中的 Owner 授权；以下事项严禁自行越界：

- 禁止伪造 `ownerDesiredOutcome`、负面案例、正面案例、Owner 回执、审批或原则效果。
- 禁止对 `D:\.openclaw\workspace\.pd\state.db`、`.state\trajectory.db` 直接执行修复 SQL、批量恢复、删除历史或启用新生产 Agent 模式。
- 禁止无授权在当前真实 OpenClaw、Codex、Companion 工作区中生成或激活 RuleCode。
- 禁止将旧 L2 输入错误绕过为 V1 规则；禁止通过关闭 `code_rule_capability` 来冒充代码修复。
- 禁止自动合并 PR、推送 main、发布 NPM 或绕过签名/安装信任链。
- 禁止全库 `git clean`、`git reset --hard`、`git stash`；现有主工作树包含大量无关修改和未跟踪文件，必须完整保留。
- 禁止将明文 token、API key、私人轨迹与真实 Owner 证据粘贴到 PR、日志或公开报告。
- 不做 `pi-mono` 本地源码改动，也不升级 Pi SDK；Pi 1.2.0 另起 SPEC。

无法获得合法 Owner 证据时，交付应呈现**可用的阻断与恢复机制**，而不是自行伪造真实 Owner 授权；此种缺证不应阻塞其他工程工作。

## 二、启动与基线

1. 阅读根目录 `AGENTS.md`、SPEC 主文档、相关当前 ADR/错误架构，再只读检查 Git HEAD、主工作树状态和现有测试脚本。
2. 从当前主线创建唯一的隔离 worktree，例如 `D:\Code\_worktrees\principles\iaer-001`，分支 `fix/iaer-001-evidence-readiness`（如已占用则使用不冲突名称）。**不要在已有脏 main 上做业务代码改动。**
3. 注意 SPEC 和执行指令刚落盘，可能还是主工作树的 untracked 文件；创建 worktree 后必须把**这两份指定 Markdown**安全地复制到新 worktree 的对应路径，并比较 SHA-256。不要假定新 worktree 自动包含未提交文件。
4. 记录版本、现有 Feature Flags 解析流程、全部 Artificer V2 入口、现有 `RuntimeStateManager`、任务 Lease/Retry/Recovery 语义、`BehaviorExamplePackAssembler`、Owner 身份/授权接口。
5. 输出一次简短的 requirement → actual producer/consumer → authority → test 表，标明本次只修改哪些生产代码路径。
6. 用现有仓库的初始化脚本和文档准备隔离 worktree 环境。测试命令先查 `package.json` 或脚本帮助；不自行杜撰 npm script。必要时安装锁定依赖，不改变主仓库锁文件或依赖版本。

### 基线核验任务

先复核以下源码事实；如果发现它们已被新提交修复，按事实收窄实施，不应机械重演旧代码：

- `packages/host-runtime/src/internalization-consumer-cycle.ts`：自动 consumer 是否仍然不给 Artificer 传 `behaviorExamplePack`。
- `packages/principles-core/src/runtime-v2/internalization/artificer-runner.ts`：缺 Pack 是否仍抛出普通 `Error`。
- `packages/pd-cli/src/services/rulehost-pipeline-runner.ts`：CLI 已有的 Pack 传递/阻断是否被复用。
- `packages/openclaw-plugin/src/core/behavior-example-pack-assembler.ts`：Owner 标注、Pain/ToolCall/session 检查的权威实现。
- `packages/principles-core/src/runtime-v2/task-status.ts`：`needs_human_review` 合同。
- `packages/principles-core/src/runtime-v2/runner/base-peer-runner.ts`：Lease 获取早于 `invokeRuntime`，错误分类与持久重试机制。
- `packages/principles-core/src/runtime-v2/store/task/sqlite-task-store.ts`：当前状态更新接口与并发 CAS 能力。

历史依据：审计时生产中存在 **385 条** Artificer L2 缺 Pack 失败运行（251 execution_failed、134 max_attempts_exceeded；这些不是 385 个任务），而且 9 月 23 日以后出现了 51 次相同失败；这必须作为修复对照基线，不得移植生产数据到测试库或外发原始轨迹。

## 三、分阶段实施要求

### Phase A — P0：把无效重试在模型前阻断

A1. 确认 Code Rule V2 的权威任务通道，不能仅凭 `taskKind` 认定所有 Artificer 都应该执行代码生成。对非代码任务维持合法旧路径；对通道缺失/歧义拒绝模型猜测。

A2. 实现共享、无副作用的 Evidence Readiness Contract，区分 `ready`、`owner_evidence_required`、`invalid_evidence`、`not_applicable`，并把存储不可用作为独立基础设施错误。优先复用既有数据和验证器，禁止添加第二套互不一致的 Pack 格式。

A3. 在自动消费者进入模型执行和消耗 retry budget 之前完成 preflight。缺证/证据不合法时，**原子**将指定任务写为 `needs_human_review` 并存储稳定原因码与下一步动作；连触发十次不能增加 attemptCount 或模型调用数。注意 `BasePeerRunner` 先 Lease 后构建上下文；不能简单在 `invokeRuntime` 抛错实现 A3。

A4. 将 ArtificerRunner 原有普通 `Error` 改为结构化输入合同错误，作为防止旁路执行的最后防线；正确释放/处理 Lease，不能把输入合同拒绝归类为一般模型重试。

A5. 为 A1–A4 编写红灯先行测试，使用真实临时 SQLite + Fake Pi Adapter 验证：0 LLM、0 Artificer 工具、0 规则产物、0 无意义重试。必须同时覆盖成功有 Pack 的旧路径，避免修成所有 Artificer 都不可用。

**Phase A 完成条件：** 无 Pack / 非 Owner Pack / 通道不明的代码任务严格 fail-closed、状态可查、模型不触发；有效 Pack 进入原有 L2。

### Phase B — P0：Owner 证据补充与安全恢复

B1. 设计最小的版本化 Owner 证据选择记录（pain ID、负例 Tool Call、1–3 正例 Tool Call、ownerDesiredOutcome、授权来源、workspace、revision/hash），以权威轨迹恢复 Pack。保存引用和必要审计摘要，禁止将整段私人轨迹复制到 `diagnosticJson`。

B2. 在 Host/Core 边界通过能力接口接入现有 `BehaviorExamplePackAssembler` / 验证器。避免让 `principles-core` 直接依赖 OpenClaw Plugin。检验跨 Pain、Session、Workspace、Owner 权限、空字段、重复 ID、已清理证据和内容篡改。Codex/其他宿主需要有能力证明，不得假设专用 OpenClaw 证据可以跨宿主读取。

B3. 提供最小可实际调用的 Owner CLI/服务端入口：查询等待证据任务 → 查看缺口/nextAction → 明确提交 Owner 案例 → 校验并持久化 → 对单一任务进行 CAS 恢复。参数语义与已有 CLI 保持一致，不要求本次开发新 Console 页面。

B4. 恢复必须验证任务当前状态、Owner authority、revision、Lease 与 completion intent。重复提交幂等、并发只有一个成功、用户未授权时拒绝。任务 attempts 已耗尽时不得静默重置，应展示显式受控恢复路径和完整审计。

B5. 将 CLI RuleHost 路径和自动 consumer 的 Pack 判定行为对齐；建立真实 SQLite 重启恢复、并发竞争、Pack 变更、跨宿主缺能力降级（安全拒绝）等 E2E。

**Phase B 完成条件：** 在隔离数据中，通过合法 Owner fixture 提供真实可溯源的 Tool Call 后，任务从 `needs_human_review` 恢复、进入 Artificer L2，原有验证/重放/审批门有效。Fixture 只能在临时库中人工标注，不得称为生产 Owner 已标注。

### Phase C — P1：遥测、历史可审计与回滚

C1. 对齐持久化 `runs.run_id` 和 Adapter 内部运行标识，记录 taskId、attempt、mode、reasonCode、evidence hash 和最终提交状态；仍区分 Adapter 成功、Runner 提交成功、后续原则效果。不能简单用 `traceId` 冒充 DB Run ID。

C2. 提供**只读**历史审计命令/脚本，按 distinct task_id 归并缺 Pack 失败、重试次数、现任务状态、关联制品和审批/激活副作用。默认 dry-run，不修改生产库。报告显式区分 385 次运行与独立任务数。

C3. 为新分支准备回滚说明；回滚不得将旧无 Pack 重试风暴重新打开。实现时若需隔离 Feature Flag，确保其“关”也维持保守输入门而不是弱化证据要求。

C4. 补齐关键场景的单元、集成、E2E、迁移/兼容与旧 CLI 回归。对照 SPEC AC-01～AC-18 逐条报告结果与命令证据。

**Phase C 完成条件：** 运行和任务结果可对账、失败原因准确、生产历史零自动改写。

## 四、必须证明的工程安全不变量

- 缺有效 Owner Pack ⇒ 不调用 LLM、不跑工具、不写可执行 RuleCode、不自动 retry。
- Pack 不是空字段/成功工具调用的别名；必须有显式 Owner 标注。
- Code Rule 不得退回 V1、不得通过关闭 flag 获得虚假的绿灯。
- 工具成功 / Adapter `succeeded` ≠ Evaluator pass ≠ Owner approved ≠ 行为有效。
- 无 Owner 权限 ⇒ 不能附加证据，不能将 review 任务恢复为 pending。
- Crash/restart/concurrency ⇒ 不双写、不跳过 Lease/Intent、历史 attempts 可追溯。
- 所有读取真实轨迹的实现必须遵从原有脱敏、scope 和引用边界。
- 不在本任务混入 Pi 1.2.0 迁移或 L1/L2 全量模式调整。

## 五、验证步骤与结果交付

完成每个切片都运行影响范围内的 typecheck、lint、Vitest / SQLite integration、自动消费者入口 E2E、CLI 现有 `--behavior-examples` 回归。具体命令以仓库当前 scripts 为准并记录实际结果与 Exit Code。若某项因环境缺能力未运行，标记 `NOT RUN`，不得假报 PASS。

需要展示的两组实证：

1. **修复前复现（使用临时库）**：无 Owner Pack 导致可重复的错误输入路径。勿在生产库制造旧故障。
2. **修复后对照（使用临时库）**：无 Pack → Owner 待办零模型；Owner fixture 附加 → CAS 恢复 → L2 实际 Fake 工具循环 → Validator/Evaluator 既有治理门 → 正确最终状态。

针对 P0/P1 做独立的对抗式审查：特权混淆、引用伪造、跨 workspace、重放篡改、TOCTOU、未释放 Lease、误恢复已成功任务、循环重复唤醒、失败类别混淆。

完成后生成 `docs/implementation-reports/SPEC-PD-IAER-001-implementation-2026-10-15.md`（若日期晚于当天则用实际日），包含：

- Git HEAD、修改文件、PR/commit 状态；
- FR→AC→代码→测试→Verdict 矩阵；
- 代码层问题清单和决策理由；
- Typecheck/lint/unit/integration/E2E 实际命令及结果；
- 不调用真实付费 LLM 的验收证据；
- 历史运行数据只读统计、独立任务计数和遥测对账；
- 安全/治理边界自查；
- Known Issues、残余风险和回滚流程；
- GO / CONDITIONAL GO / NO-GO 的明确理由。

## 六、提交和最终行动边界

先完成整个工程实现，不停留在“我已规划”“我要开始测试”或只加几个 Mock 测试上。根据可用 Git/PR 工作流，允许在**自己的隔离分支**提交经验证的实现，并在代码协作权限允许时 push 分支、创建可审查 PR；**禁止**自动 merge、直推 main、自动更新当前已安装 PD Runtime、直接写生产数据库、发布包或自动执行产品 Owner 审批。

如遇到真正需要 Owner 提供业务标注或特权材料的操作，不向模型索取虚假授权：保留显式待办，继续完成独立的代码、测试和报告工作。不要为常规工程步骤反复打断任务。

输出最终总结时按「已验证完成 / 部分完成 / 未完成」严格区分，给出文件与测试证据及下一动作。SPEC 与指令文件如果在主工作树未被 Git 跟踪，记得在隔离 PR 中带上这两份经 SHA-256 核对的文件。

**完成标准：SPEC AC-01～AC-18 全部有可复核证据；生产自动 consumer 的真实入口已正确接线，Owner 权限与安全门无旁路；未证明的事实不宣称完成。**
