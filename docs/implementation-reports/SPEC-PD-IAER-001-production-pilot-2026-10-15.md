# SPEC-PD-IAER-001 Production Pilot 验收报告（2026-10-15）

> 执行者：ZCode（任务书《IAER Production Pilot v1.0》）
> SPEC：`docs/specs/SPEC-PD-IAER-001-v1.0.md`（PR #2041，合并提交 `eaf52c4a39a67f8897012aaec58081a5ac7c8e9c`）
> 验收性质：生产现实核查 + 受控端到端验证 + 数据验收 + 缺陷收口
> 快照时间：2026-10-15 23:0x–23:4x 本地（UTC+8）；生产数据以各节标注时刻为准

---

## A. Owner Review Card

### 1. Problem

生产 Artificer L2 在 `code_tool_hook` 通道上因缺 Owner 标注证据（BehaviorExamplePack）产生大面积失败与无意义重试（历史基线：385+13 条失败运行、约 82 个独立任务、失败中位耗时约 0.011s）。SPEC-PD-IAER-001 定义了证据就绪门、Owner 证据恢复闭环与可靠执行语义；本任务验证这些修复在真实运行环境中能否安全完成一次受控行为内化。

### 2. Production Baseline（旧窗口，快照 2026-10-15 23:05 本地）

数据源 `D:\.openclaw\workspace\.pd\state.db`（SQLite mode=ro）：

| 指标 | 值 |
| --- | --- |
| runs 总数 | 2058 |
| tasks 总数 | 1387 |
| `pi-ai-l2` 运行 | 404（2026-09-13 → 2026-10-15T12:40:48Z） |
| `behavior_example_pack_missing` 运行 | **401**（pi-ai-l2 388 + pi-ai 13） |
| 受影响独立任务 | **85**（L2 83 + L1 2），全部 `failed`（attempts 耗尽） |
| 失败单次时长 | 0 – 1.64s |
| IAER `needs_human_review` 任务 | **0**（安装端当时为旧版；存量 21 条 NHR 全部是 rollout_reviewer 旧机制，reasonCode=NULL） |
| 待审批 approvals | 32 pending（23 approved / 2 rejected） |
| `rule` 工件 | 4 条 validated |
| pain_diagnoses | 77 |
| 工作区遥测（`.pd/telemetry/critical-events.jsonl`） | 192 条事件，最后写入 2026-10-06（旧窗口内停滞；新窗口 FR-08 关联事件待宿主重启后观测） |

新安装 CLI 的只读审计（FR-09）对同一数据给出：401 runs / 83 artificer 任务，异常计数 `repeatedRetryConsumption=83`、`succeededArtifactThenFailed=17`、**`hasGovernanceSideEffects=0`**（风暴期间没有任何治理旁路——关键安全不变量在真实历史数据上成立）。

### 3. Actual Installed Version（分两个时刻，均为只读核查）

**T1（23:0x 本地）**：`~/.pd/runtime` 为 core@1.292.1 / plugin@2.1.4 / pd-cli@1.156.0 —— **不含 IAER 修复**（四个新 dist 文件缺失）。同期 npm latest 已是 core@1.292.2 / plugin@2.1.5 / installer@1.145.3（13:22Z 发布）。

**T2（23:11 本地起）**：官方签名更新事务自动落地（`~/.pd/active.json`：generation 44，`transactionId=update-1792076561531-709e0acb`，`previousReleaseId=bundled-2.3.4-00cc70db6c20`，**`sourceCommit=f7d47ae0`（当前 origin/main HEAD，含 `eaf52c4a`）**，productVersion 2.3.5）。核验：core@1.292.2 dist 含全部四个 IAER 新文件；pd-cli 1.157.0 含 `evidence`/`audit-artificer-evidence` 命令；OpenClaw 扩展 plugin@2.1.5，其 `core` 与 `node_modules/@principles/core` 均符号链接到新 runtime core。**本会话全程未写 `~/.pd/runtime` 任何文件**（更新由安装器事务完成）。

**宿主状态**：OpenClaw gateway 在更新事务中被停止（`gateway-restart.log` 23:01:59Z `action=stop`），截至报告时刻 18789 端口无监听、无重启记录——**新插件尚未被任何宿主会话加载**。

### 4. Test Scope

- Phase 0：git/安装/调用链/生产数据只读核查（全部完成）；
- Phase 1：隔离 worktree（基于 `origin/main` f7d47ae0）真实 SQLite + 生产消费周期代码复现 Case A–E（完成）；
- Phase 2：真实 Owner 证据 Pilot（**未执行**——需 Owner 授权，样本与授权材料已备好，见 §D/§F）；
- Phase 3：正式运行时验收（安装事务已核实为官方路径；**宿主重启与最小业务验证未执行**）；
- Phase 4：修复前后数据对比（旧窗口已量化；新窗口样本数 0，见 §E）。

### 5. Before / After

- **Before**：缺证据 → runner 层普通 Error → `execution_failed` → 重试风暴 → attempts 耗尽 terminal-failed（401 runs，零治理产出）。
- **After（代码层，已在隔离环境证明）**：缺证据 → 消费者预检门原子迁移 `needs_human_review`（零 LLM、零 run、零 attempt 消耗、零重试）→ Owner `evidence attach`（CAS+digest）→ `evidence resume`（digest 复验 + 原子回 pending）→ 消费者再次预检（TOCTOU digest 复验 + canonical Pain 谱系复验）→ ArtificerL2 带证据执行。
- **After（生产层）**：运行时二进制已更新到位，但宿主未重启、无新窗口运行数据——生产行为尚未改变。

### 6. Existing mechanism reused

证据门挂在既有共享消费周期（`internalization-consumer-cycle.ts`）内部；NHR 沿用 evaluator-runner 既有 `needs_human_review` 状态与 CAS 先例；恢复走既有 `pd runtime internalization retry` 出边；遥测走既有 WorkspaceTelemetryEmitter + telemetry-event 注册表；审计复用 runs/pi_artifacts 既有表。无新子系统、无新持久化 schema（PR #2041 仅在 diagnostic_json 元数据内扩展）。

### 7. Complexity Delta（本 Pilot 任务自身）

新持久化状态/子系统/公共抽象/特性旗标/跨包依赖/外部能力：**全部 NO**（本任务零生产代码修改；唯一入库产物为本报告）。PR #2041 的 Complexity Delta 见其 PR 描述（六个 changeset）。

### 8. Design reason

本任务是验收任务：最小一致动作 = 只读核查 + 隔离复现 + 授权材料准备，不扩任何代码面。

### 9. Verification（证据索引）

- 隔离 worktree 目标套件 **182 用例全绿**（明细见 §B/§D）；
- `npm run verify:merge` 在最新 `origin/main`（f7d47ae0）**exit 0**（含全部静态闸门 + 构建 + 契约测试）；
- 新安装 CLI 对真实生产库两条只读命令实跑成功（audit-artificer-evidence / evidence list）；
- 安装事务元数据（active.json）+ dist 文件级探测 + 插件解析路径验证三重确认安装版本包含 IAER。

### 10. Risk

1. 宿主未重启：gateway 停止后若长期不拉起，生产无新数据，CONDITIONAL 状态无法解除；
2. 85 个 terminal-failed 任务不会自动进入 NHR（唤醒扫描只覆盖 pending/retry_wait）——需要 Owner 显式 `pd runtime recovery failed-tasks --confirm` 才能走新证据闭环；
3. 真实 L2 模型执行（生成/校验/重放/评估全链）尚未发生过任何一次，Phase 2 授权前不能宣称闭环；
4. 本机为 dev+prod 合体机，存在同路径混淆历史（AGENTS §1.1 事故）——本次以文件级探测 + 事务元数据双重锚定，但该结构性风险仍在。

### 11. Rollback / recovery

- 本任务无生产改动，无需回滚；
- 运行时如需回退：官方安装器支持按 `previousReleaseId`（bundled-2.3.4-00cc70db6c20）回滚（`~/.pd/backups/` 有事务备份）；
- PR #2041 的功能回退：`code_rule_capability` 旗标可整体关停 Code Rule 生成（紧急停用语义保留）。

### 12. Follow-ups（见 §F 分类）

宿主重启 + 新窗口观测；Owner 证据授权 + 单例真实 Pilot；85 个存量 failed 任务的 Owner 批量恢复决策（P2，需逐 Pain 判断是否仍值得内化）。

### Final Verdict

**CONDITIONAL PASS** —— 代码与隔离环境验收全部通过、正式运行时已经官方事务更新到含修复版本；但真实 Owner 案例授权、真实 L2 模型调用、正式环境完整闭环证据（宿主重启 + 新窗口）缺失。需要 Owner 完成的具体动作见 §F。

---

## B. SPEC 验收矩阵（AC-01～AC-12）

| AC | Requirement | Tested path | Evidence | Verdict | Remaining gap |
| --- | --- | --- | --- | --- | --- |
| AC-01 | 无有效 Pack 时模型调用数 = 0 | 消费周期级：缺证据任务在全周期内 runner 不构造、adapter 不实例化 | `internalization-consumer-cycle-artificer-evidence.test.ts` T01（runner never invoked, zero runs）；preflight 套件 13 用例 | **PASS**（隔离） | 生产新窗口 0 样本，未观测 |
| AC-02 | 缺证据不再重复 execution_failed/max_attempts | NHR 状态在唤醒扫描之外；10 连续周期稳定 | 同上 T02（10 further cycles stable）；runner 层 `input_invalid` 永久分类（artificer-runner.ts:873-888） | **PASS**（隔离） | 存量 85 任务需 Owner 恢复动作才进新语义 |
| AC-03 | 证据等待状态可持久查询 + 稳定 reasonCode | NHR + humanReviewContext 单次 CAS 写入 + 读回不变量；`evidence list` 查询面 | preflight 套件（read-back/durability/restart）；生产实跑 `evidence list`（当前 count=0，语义正确） | **PASS** | — |
| AC-04 | Owner 补证后安全幂等恢复 | attach（CAS+digest 持久化，任务保持 NHR）→ resume（digest 复验 + 原子回 pending） | `owner-evidence-recovery.test.ts` 16 用例（含并发 confirm 恰一成功、二次 resume 拒绝） | **PASS**（隔离） | 真实 Owner attach/resume 未执行（授权项） |
| AC-05 | 所有 V2 执行走同一证据合同 | 消费者预检与 run-rulehost CLI 共用 `assessEvidenceReadiness` + 同参数 Assembler | 插件装配参数与 CLI 一致（internalization-auto-consumer-service.ts:108-120）；`evidence-readiness.test.ts` 22 用例 | **PASS** | — |
| AC-06 | 无标注伪造 / 跨 Pain 污染 | canonical Pain 从持久前驱图解析（唯一性失败即闭）；装配器 session 域校验；digest TOCTOU | preflight 套件（cross-pain 拒绝、changed-pack 拒绝）；assembler session_mismatch 分类 | **PASS**（隔离） | 真实轨迹上的 Owner 标注未发生（授权项） |
| AC-07 | 无未授权 RuleCode 生成/激活/静默降级 | capability OFF → 消费者跳过（非降级 L1）；run-once 对 Code Rule 结构化拒绝；治理门不变 | consumer-cycle 测试（capability OFF 不调 Artificer）；run-once 拒绝码 `artificer_code_rule_run_once_unsupported`；**生产历史 `hasGovernanceSideEffects=0`** | **PASS** | — |
| AC-08 | CLI/Consumer/Runner 输入行为一致 | 三处共享同一 readiness 合同与 validator；runner 层防御性复验注入 pack | `artificer-runner-evidence-guard.test.ts` 6 用例；run-rulehost-handler 套件 | **PASS** | — |
| AC-09 | Adapter 运行与持久化 Run 可关联审计 | FR-08 统一 run-correlation 载荷（persistentRunId/adapterRunId/attemptNumber） | `owner-evidence-recovery.test.ts` T10（关联链 joins resumed event → runs row） | **PASS**（隔离） | 真实 L2 run 的关联未观测（授权项） |
| AC-10 | 历史扫描默认只读、按独立任务汇总 | FR-09 audit 命令 mode=read_only_audit | 生产实跑输出（401/83/异常计数/逐任务 nextAction） | **PASS**（生产实跑） | — |
| AC-11 | Lease / completion intent / 治理门回归 | 预检 CAS 对 leased 任务必输；crash-liveness 回归套件 | preflight P1-1（leased 任务 CAS 失败可观测）；`crash-liveness-regressions.test.ts` 等既有套件随 verify:merge 通过 | **PASS** | — |
| AC-12 | 与 Pi 0.85.1 兼容 | 安装端与 main 的 pi-agent-core 均 ^0.85.1；无 SDK 升级混入 | 包清单比对（本报告 §C） | **PASS** | — |

---

## C. 代码与安装一致性

| 项 | 值 |
| --- | --- |
| 远端 main | `f7d47ae0f68b3cf5576300c2c3c9e32e9f6daedd`（2.3.5） |
| PR #2041 | MERGED @ 2026-10-15T11:46:09Z，merge commit `eaf52c4a3`，is-ancestor(origin/main) ✓ |
| 本地主检出 | `39ebac3f5`（落后 26 提交，带未提交文档——控制平面，未动） |
| 验收 worktree | `D:\Code\_worktrees\principles\adhoc-20261015-iaer-pilot-q7r4n2-iaer-pilot`，base=origin/main f7d47ae0，writer=zcode |
| npm latest | core 1.292.2 / host-runtime 0.9.2 / plugin 2.1.5 / pd-cli 1.157.0 / installer 1.145.3（2026-10-15T13:22Z） |
| 实际安装 | 官方事务 `update-1792076561531-709e0acb`：2.3.4→2.3.5，sourceCommit=f7d47ae0，generation 44 |
| 实际宿主/适配器 | OpenClaw 扩展 plugin@2.1.5（core→runtime core@1.292.2 符号链接，解析验证 ✓）；gateway 停止中（18789 无监听） |
| 是否真正运行了新 IAER 逻辑 | **二进制已就位、宿主尚未加载**；新 CLI 两条只读命令已实跑；消费者级新逻辑尚无生产运行 |

---

## D. 真实测试证据（本次会话实际执行的验证）

1. **缺包阻断（隔离，Case A）**：消费周期级 T01 —— code 通道无选证 → NHR（reasonCode=`owner_behavior_examples_required`）、runner 未构造、runs 零行、attemptCount 不变、无重试；T02 连续 10 个后续周期状态稳定。
2. **Owner 标注验证（隔离，Case B 结构面）**：`owner-evidence-recovery` 套件 —— 1 负例 + 1–3 正例 + 非空 ownerDesiredOutcome + session 域校验 + digest 形状 `sha256:<64hex>` + 全链 attach/resume/list。
3. **attach/resume（隔离，Case C/D）**：digest 篡改→stale 零状态变化；轨迹清理→typed stale；跨 session→scope_mismatch；并发 confirm 恰一成功；二次 resume 拒绝；重入队击败 attach CAS。
4. **受控 L2 执行（隔离）**：T08a —— 有效选证 + 装配端口 → ArtificerL2Adapter 携带已装配 pack 构造（test-double 运行时）。**真实付费模型 L2 执行未发生**。
5. **Validator/Replay/Evaluator**：随 verify:merge 全量回归（exit 0）；生产链上尚无新工件产生。
6. **最终治理状态（生产只读）**：approvals 32 pending / 23 approved / 2 rejected；rule 工件 4 validated；`hasGovernanceSideEffects=0`。
7. **新 CLI 对生产实跑**：`audit-artificer-evidence --json`（401/83/异常计数）与 `evidence list --json`（count=0 语义正确）。
8. **关键运行 ID 关联（生产基线）**：最新失败链 correlation `605ba208`（dreamer/philosopher/scribe succeeded → artificer 3 连败 terminal-failed @ 12:36/12:38/12:40Z，Pain `manual_1791288844898_srw1yzhs`）。

**明确声明：以上 1–4 为隔离环境（Fake/装配端口替身 + 真实 SQLite）证据，不构成 Production PASS。**

### Phase 2 Pilot 样本预选（待 Owner 确认，ZCode 不代 Owner 标注）

- **候选链**：correlation `605ba208-f9e9-42e4-9eb3-7730cd1031cd`（code_tool_hook）
- **canonical Pain**：`manual_1791288844898_srw1yzhs`（09-19 真实「配对配置遗漏」纠错的 B1 重放：改 timeout 只改 config.json 漏掉 deploy.sh 配对探活值）
- **失败行为**：修改配置值前未全局搜索引用，只改单文件
- **期望行为**：修改配置值/关联常量前先全局引用搜索，覆盖全部命中并核对配对约束（scribe 已产出原则草案《全局引用先行：修改配置值前建立完整影响面理解》，工件 `pi-art-scribe-605ba208-...-code_tool_hook-run_..._1`，validation_status=pending）
- **轨迹可读性**：session `pri768v5-s1`，21 条 tool call 可读（edit/exec/read 家族齐全，含纠错后恢复 span）
- **候选负例 Tool Call**：纠错前的补丁式 edit（session 内 id≈11818 一带，最终以 Owner attach 时选定为准）
- **候选正例 Tool Call**：纠错后恢复 span 的检索+配对修改调用（以 correction sample `sample_54e5583d0931` 记录的 recovery span 为候选集）
- **安全边界**：不涉高危权限/敏感文件/外部发布；会话为历史只读数据
- **模型预算**：单次 Artificer L2 全链（生成→校验→确定性重放→提交）预计 3–8 次模型调用，上限建议 12 次；按当前 zai glm-5.3 通道计费量级约人民币个位数；不自动重试超限

---

## E. 数据对比（Phase 4）

**旧版本运行窗口**：2026-09-13T14:30:17Z → 2026-10-15T12:40:48Z（bundled ≤2.3.4 行为）。

- 输入与执行可靠性：缺证据错误进入 LLM 的运行 **401**；缺证据自动重试消耗 **83 任务全数 attempts 耗尽**（`repeatedRetryConsumption=83`）；Artificer L2 有效完成率 = 0（该通道全部失败）。
- 任务恢复质量：IAER NHR=0（机制不存在）；Owner 补证=0；Validator/Evaluator 通过率不适用。
- 运行成本：401 次无效调用，单次 0–1.64s（模型未被实际调用，为预检前快速失败后的重试空转）。

**新版本运行窗口**：2026-10-15T15:0xZ 起（官方更新事务完成；严格说应从 gateway 重启成功时刻起算——**尚未发生**）。

- 运行数：**0**；样本数：**0**。

**不能得出的结论**：新版本失败率改善、恢复成功率、成本变化均**无数据支撑**；历史失败率亦不可直接外推（运行次数≠独立任务数，85 任务贡献 401 次运行）。按任务书要求，只报告观测事实与置信度限制。

---

## F. 剩余工作分类

**P0（安全/治理权威绕过）**：无新发现。

**P1（真实工作流无法完成）**：
1. [Owner] 重启 OpenClaw gateway（更新事务 23:01Z 停止后未拉起）——新插件加载与新窗口数据的前置条件；
2. [Owner] 授权并执行单例真实 Pilot：对候选链 605ba208 执行 `recovery failed-tasks --confirm`（回 pending）→ 消费者预检自动 NHR → `evidence attach`（Owner 选定正负 Tool Call + ownerDesiredOutcome）→ `evidence resume` → 观察 Artificer L2 真实执行与 Evaluator 结果。授权材料见 §D Phase 2 小节（模型/调用上限/预算已声明）。

**P2（兼容/恢复 UX/可观测性）**：
3. [Owner 决策] 存量 85 个 terminal-failed artificer 任务的批量处置：逐 Pain 判断是否仍值得内化（attach 证据恢复）或归档；`audit-artificer-evidence` 输出已含逐任务 nextAction；
4. [观测] 新窗口启动后跟踪 §E 三层数据 ≥2 周，补齐修复前后对比。

**P3（工程维护/体验）**：
5. 本机 dev+prod 合体机的同路径混淆结构性风险（AGENTS §1.1 事故类）建议在私库 runbook 中追加「验收会话期间安装器可能并发更新运行时」注意事项；
6. `pd --version` 报 2.3.5 而 runtime 包目录版本分散（core 1.292.2 等）——属正常独立版本线，但可考虑在 doctor 输出中并列展示 sourceCommit 与关键包版本，降低人工核对成本。

**与原 SPEC 已完成内容的区分**：PRI-980～985 工程任务已随 PR #2041 完成且维持 Done 状态；本报告全部条目为 Pilot 验收新增，不回溯标记任何已完成工单。

---

## G. 结论

任务书的六问回答：

1. **实际完成了什么**：Phase 0 全量现实核查（代码/安装/调用链/生产快照）、Phase 1 隔离复现（182 用例 + verify:merge exit 0）、Phase 2 授权材料与样本预选、Phase 3 安装事务核实、Phase 4 旧窗口量化与本报告。
2. **实际验证了什么**：调用链全环在源码层接线成立；Case A–E 安全不变量在真实 SQLite + 生产周期代码上自动化证明；安装运行时经官方事务更新到含修复版本（文件级+事务元数据双重锚定）；新 CLI 对真实生产库只读实跑成功；历史风暴零治理旁路。
3. **哪些没有运行**：宿主重启后的生产消费周期（gateway 仍停止）；真实 Owner 证据 attach/resume；真实付费模型 Artificer L2 执行及后续 Evaluator；存量 85 任务恢复。
4. **发现了哪些新缺陷**：无新的代码缺陷。两项流程性发现：(a) 更新事务停止 gateway 后不自启（宿主加载新代码断链，P1-1）；(b) 存量 failed 任务与新 NHR 语义之间的恢复出边依赖 Owner 显式动作（设计如此，非缺陷，列为 P2 决策项）。
5. **是否达到 Production PASS**：**否 —— CONDITIONAL PASS**。解除条件：Owner 完成 §F P1 两项（重启宿主 + 授权单例真实 Pilot 并观测到一次完整 L2→Evaluator 闭环），且无新 P0/P1 缺陷。
6. **下一步最值得做的一件事**：Owner 重启 gateway 并批准对候选链 605ba208 的单例真实 Pilot——这是唯一能把 CONDITIONAL 变 PASS 的动作，其余一切均已就绪。
