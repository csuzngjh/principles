# IAER Single-Task Recovery P1 实施报告（2026-10-16）

> 关联：SPEC-PD-IAER-001 / PR #2041（已并）/ PR #2045（Pilot 报告，CONDITIONAL PASS）
> Linear：PRI-991（本工程工单）；PRI-980～985 维持 Done；PRI-988/989（P2）不受本报告影响
> 执行者：ZCode（任务书《IAER Production Pilot P1 收口》+《一次性修复指令：PR #2046》）

---

## 0. 评审修复轮（2026-10-16，NO-GO → 修复）

首轮实现的评审结论为 NO-GO（4 项 P1 + 1 项 CI 阻断）。逐项核实结论、根因与修复：

| 缺陷 | 核实结论 | 根因（精确位置） | 修复 | 红灯→绿灯 |
| --- | --- | --- | --- | --- |
| **P1-01 dry-run 非真只读** | 属实 | `runtime-recovery-failed-task.ts` 无条件 `readonly:false` 打开连接；底层 `SqliteConnection` 的 readonly 模式默认会 bootstrap 缺失的 DB（`sqlite-connection.ts:107`） | ① `createRuntimeStateHandle`/`RuntimeStateManagerOptions` 透传既有 `bootstrapIfMissing` 选项（默认 true 向后兼容）；② dry-run 以 `readonly:true + bootstrapIfMissing:false` 打开（零 mkdir/零 PRAGMA/零 schema 初始化）；③ 两模式先做 `state.db` 存在性前置检查 → 结构化 `storage_unavailable`；④ `SqliteError`（SQLITE_*）归类 storage_unavailable | T01-A（缺 DB 不创建任何文件/目录）、T01-B（state.db sha256 逐字节不变 + 无审计文件）、T01-C（schema-less 文件不被迁移，字节不变）、T01-F（confirm 仍可用）——修复前红、修复后绿 |
| **P1-02 损坏 metadata 被当作"无 intent"** | 属实 | `recoverSingleFailedTask` 对 `hydrate===null` 不区分"无 pi_metadata"与"pi_metadata 损坏" | 结构化恢复资格合同（单一权威 `hydratePITaskRecord`，无第二解析器）：payload 缺失/无 `pi_metadata` 键 = 合法 legacy 形状（生产实证：6 条 failed diagnostician 均无 pi_metadata——completionIntent 不可能存在，放行保持与批量一致，T02-F）；`pi_metadata` 存在但 JSON 损坏/水合失败 = `invalid_task_metadata` 拒绝（fail-closed，含"损坏本应携带 pending intent"的攻击面测试）。畸形 JSON 由 SQLite 列级 `json_valid` CHECK 在存储层拦截（防御纵深，测试实证 store 拒绝写入）。dry-run 与 confirm 复用同一 `assessRecoveryMetadataGuard` | T02-A/B/C'/E/G 七用例 |
| **P1-03 恢复成功但审计可能丢失且不可发现** | 属实 | CAS 提交与 `appendRecoveryAction` 跨存储无原子性；JSONL 失败时 CLI 误报 `recovery_error`；进程在两步之间崩溃则审计缺口不可检测 | 采用现有架构支持的最小可靠方案（无新表、无第二审计系统）：**恢复事实（`lastFailedTaskRecovery`：actionId/previousAttemptCount/previousMaxAttempts/newMaxAttempts/budgetResetApplied/operator 标签）随同一条 CAS UPDATE 写入任务自身 metadata**（PRI-982 `ownerEvidenceSelection` 同款可选字段扩展模式，形状校验 fail-closed）；JSONL 降级为该事实的**投影**；投影失败 → `recovered_but_audit_failed`（明确区分，exit 0，含全部状态事实，禁止 re-confirm）；新增 `--repair-audit` 幂等补偿（按 actionId 去重重投影，零任务变更）。**诚实边界**：metadata 可水合任务（全部 83 条候选群体）具备崩溃可恢复的持久事实；legacy 无 metadata 任务（diagnostician）其 JSONL 投影无行事实兜底——已在 --repair-audit 的 `no_durable_recovery_record` 拒绝与报告中如实声明 | T03-B（不可写审计 → recovered_but_audit_failed + 行事实在）、T03-E/F（删 JSONL 模拟崩溃窗口 → repair 重投影 actionId 一致 + 幂等无重复）、T03-C/D（refusal 路径零审计）、T03-G/H（previousAttemptCount 留存 + legacy 行兼容） |
| **P1-04 CAS 未覆盖决策依赖的全部字段** | 属实 | 前置条件仅 status+diagnosticJson；并发写者改预算/lease（status 不变）可被覆盖 | 增强既有 CAS 原语（非新原语）：`updateTaskIfDiagnosticJsonUnchanged` options 增加 `expectedAttemptCount/expectedMaxAttempts/expectedLeaseOwner/expectedLeaseExpiresAt`（全部可选、AND、`IS` NULL 安全、向后兼容；sqlite 与 memory store 同款 parity）；两条恢复路径共享 `failedRecoveryPreconditions(task,'failed')` 全快照；重置预算的新值经同一 WHERE 保护，不覆盖他者新预算。**竞争窗口清单**（写入路径盘点）：runner 的 markTask*/updateTask、lease manager acquire/release、orchestrator reconcile、owner-retry/attach/resume（均 CAS）——报告 §3 | T04-A~F/H：真实竞争注入（包装 getTask 在守卫读后、CAS 前经真实 SQLite 改 attempt/max/lease/leaseExpiry/metadata）→ 全部 conflict 且字段保持他者写入值；T04-G 正常合同 3/3→0/6 不变；store 级 4 用例逐前置条件验证 |
| **CI ERR-001** | 属实 | `readAuthoredChannel` 的 `as Record` cast（JSON.parse 不可信值） | 换 `isRecord` type guard（checker 官方 next-action 认可模式）；新增 core `isValidFailedTaskRecoveryAuditRecord` 同款守卫；不使用豁免注释、不禁用 checker | `check:runtime-contract` 通过（提交重写后） |
| P2-A decidedBy 身份语义 | 属实 | 标签被可误读为已认证身份 | CLI help 与输出明确 "Operator-provided label … NOT an authenticated identity"；报告授权卡同步措辞 | 文案层 |
| P2-B nextAction 分 kind | 属实 | 单一 generic 文案 | 导出并复用批量命令的 `buildExecutionNextAction`（单一 guidance 权威）；code_tool_hook Artificer 保留 IAER 证据门专用文案；diagnostician/diag_*/prompt Artificer 各得正确入口 | 文案层 |
| P3-A 工单号 | 属实 | 首提交误引 PRI-990（他人紧急工单） | 注释/报告/changeset 全部更正为 PRI-991；PR 标题/正文/置顶评论已更正 | 已在案 |
| P3-B 模型预算表述 | 属实 | "上限 12 次"是 Pilot 计划约定非运行时硬限制 | 授权卡改注：运行时既有约束为 maxAttempts=6 与 profile timeoutMs=300s；无 per-run 调用次数硬闸，Pilot 依赖 Owner 中止条件 | 报告层 |

**测试规模（本轮）**：core single-task 26（+11）、store CAS 9（+5）、CLI 18（+7）、host-runtime 集成 11、既有恢复回归全绿（含 T16 批量行为与 83-任务隔离 T05）。

---

## 1. 真实根因与已有机制（Reality Audit 结论）

- **core 层早已有按 taskId 的恢复权威**：`recoverFailedTask(stateManager, taskId, force)`（`packages/principles-core/src/runtime-v2/recovery-sweep-service.ts`，PRI-674 引入）。缺口**只在 CLI 层**：唯一触达它的入口是批量命令 `pd runtime recovery failed-tasks`（无 `--task-id` 参数），且 `--force` 语义是「对所有 exhausted failed 任务批量重置预算」。
- 初稿 Pilot 报告（PR #2045 §F）建议的 `recovery failed-tasks --confirm` 对 3/3 任务**不会恢复**（不加 `--force` 时 exhausted 任务被跳过）；加 `--force` 则是 85 条全量批量操作——已在 PR #2045 报告中撤回更正。
- 现有基础设施全部复用，零新真相源：
  - **CAS 原语** `updateTaskIfDiagnosticJsonUnchanged(taskId, expectedDiagnosticJson, patch, {expectedStatus})`（PRI-983 引入，单条件 UPDATE）；
  - **审计通道** `<workspace>/.state/recovery_actions.jsonl`（`appendRecoveryAction`，`forceApplied` 字段已有）；
  - **恢复语义权威**：预算耗尽 + force → `maxAttempts = max(max, attempt) + 3`、attemptCount=0、清 lastError/lease/resultRef；runs/artifacts/metadata 载荷不动。

## 2. 实际改动

| 文件 | 变更 |
| --- | --- |
| `packages/principles-core/src/runtime-v2/recovery-sweep-service.ts` | ① legacy `recoverFailedTask` 升级为 CAS（`expectedStatus:'failed'` + 调用方读时 diagnosticJson 快照；并发输家 → `null`，批量命令现有 "skipped" 语义原样吸收）；② 新增 `inspectFailedTaskRecovery`（只读结构化预检）；③ 新增 `recoverSingleFailedTask`（严格单任务路径：kind 合法性 + 活跃 lease 拒绝 + pending completion intent 拒绝 + 预算重置显式 opt-in）；④ 两条路径共享同一 `buildFailedRecoveryPatch`（单一变更内容权威）；⑤ 结果类型追加 `previousAttemptCount/previousMaxAttempts`（可选，向后兼容） |
| `packages/principles-core/src/runtime-v2/recovery-actions-log.ts` | `RecoveryActionRecord` 追加可选 `previousAttemptCount`（写入 + rc-3 形状校验，legacy 记录不受影响） |
| `packages/principles-core/src/runtime-v2/index.ts` + barrel fixture | 导出 2 函数 + 2 类型（PRI-775 fixture 同步，count 1904→1908） |
| `packages/pd-cli/src/commands/runtime-recovery-failed-task.ts` | 新命令处理器 + Commander 注册函数 |
| `packages/pd-cli/src/index.ts` | `pd runtime recovery failed-task`（单数）注册，与批量 `failed-tasks` 并存 |
| 测试 | core `single-task-recovery.test.ts`（15 用例，真实 SQLite）、CLI `runtime-recovery-failed-task.test.ts`（11 用例）、host-runtime `single-task-recovery-evidence-gate.test.ts`（3 集成用例）；legacy `recovery-sweep-service.test.ts` 断言随 CAS 升级更新（契约不变，写路径断言跟新） |
| `.changeset/pri-990-single-task-recovery.md` | core/pd-cli minor |

### 接口

```bash
# 只读预检（默认；FR-05 零写入）
pd runtime recovery failed-task --task-id "<exact-task-id>" [--workspace <path>] [--json]

# 显式授权执行（FR-02/03）
pd runtime recovery failed-task --task-id "<exact-task-id>" --confirm [--reset-budget] [--decidedBy <label>] [--json]
```

## 3. 事务与 CAS 合同

1. 预检（dry-run 与 confirm 共用）：`getTask` → kind 合法（runner kinds + diagnostician，同批量发现口径）→ `status==='failed'` → 活跃 lease（未过期 leaseOwner/leaseExpiresAt）→ `pi_metadata.completionIntent.status==='pending'` → 预算耗尽判定。任一不过 → 稳定 reasonCode（`task_not_found`/`kind_not_recoverable`/`not_failed`/`lease_conflict`/`completion_intent_pending`/`budget_exhausted`）+ nextAction，零写入。
2. 变更：**单条条件 UPDATE**——`UPDATE ... SET status='pending', attempt_count=0, ... WHERE task_id=? AND diagnostic_json=<read-snapshot> AND status='failed'`。并发双 confirm 恰一成功（status 前置条件仲裁，与 owner-retry CAS 同机制）；metadata 在读后被动过 → 前置失败 → `conflict`。
3. 预算：默认不重置；exhausted 必须显式 `--reset-budget`（core 严格路径结构化拒绝，非异常）；成功后审计行含 `previousAttemptCount`（T04 断言 3 → 0，maxAttempts 3 → 6）。
4. 历史：runs 表、pi_artifacts、diagnosticJson 载荷**逐字节不动**（测试断言）；失败原因在任务行的 `lastError` 按既有权威语义清空（runs 历史保留完整失败原因），与批量恢复一致。
5. 审计：仅 confirm 成功后追加一行（dry-run 零写入，T01 断言审计文件不存在）。
6. 恢复后行为（FR-04，集成测试证明）：pending 任务回到**既有**消费周期 → 权威 channel 读取 → 证据预检 → 无 Owner pack → 原子 NHR（零 LLM、零 run、零 attempt 消耗）；attach/resume 仍走 PRI-983 原授权路径；`code_rule_capability` OFF 时不执行且无 V1 回退。

## 4. 自动化测试与 CI

| 套件 | 结果 |
| --- | --- |
| core `single-task-recovery.test.ts`（T02–T10 core 级 + CAS 并发 + 历史/预算保护） | 15/15 绿 |
| core 既有 `recovery-sweep-service` / `owner-retry` / `recovery-ledger-authority` / `architecture-regression`（T16 + 桶冻结） | 534/534 绿 |
| pd-cli `runtime-recovery-failed-task.test.ts`（T01–T05/T09/T10/T16，真实临时 SQLite；T05 用 83 条 failed artificer 逐行比对） | 11/11 绿 |
| host-runtime `single-task-recovery-evidence-gate.test.ts`（T11–T15 全链集成） | 3/3 绿 |
| pd-cli 既有 `run-rulehost-handler` / `runtime-internalization-evidence` | 53/53 绿 |
| host-runtime 既有消费周期证据套件 | 8/8 绿 |
| `npm run typecheck --workspace=@principles/core` / `@principles/pd-cli` | 通过 |
| `lint-by-package` | 11/11 通过（pd-cli 无新增警告） |
| `npm run verify:merge`（canonical merge gate） | **exit 0**（2026-10-16；前两轮失败均为我方可归因问题：①根目录杂散日志文件被 repo-hygiene 正确拒绝；②新文件 TS2783 重复键——均已修复，非环境故障） |

过程记录（诚实披露）：首轮 gate 因我方在 worktree 根目录留了重定向日志文件被 `check:repo-hygiene` 正确拒绝（该闸门工作正常）；移入 `.tmp/` 后重跑。首轮 lint 报出我新文件 4 个 error（dot-notation/prefer-destructuring/consistent-type-imports），已全部修复。**注意**：管道后 `echo $?` 捕获的是 `tail` 的退出码（在案 ERR 类「管道吞退出码」），本轮已改为日志文件 + 直接 `$?`。

## 5. 其他 82 条任务未被修改的证据

CLI 测试 T05：同一真实 SQLite 库中播种 **83 条** terminal-failed artificer（attempt 3/3），恢复其中指定的 1 条后，**其余 82 条逐条 `getTask` 与恢复前快照 `toEqual` 逐字节一致**（含 status/attemptCount/maxAttempts/lastError/diagnosticJson）。批量命令行为回归（T16）：批量 dry-run/confirm 对 exhausted 任务依旧跳过、非 exhausted 依旧恢复。

## 6. 生产候选只读预检（2026-10-16 00:33Z，全部 mode=ro）

| 检查 | 结果 |
| --- | --- |
| 精确 taskId | `artificer-605ba208-f9e9-42e4-9eb3-7730cd1031cd-code_tool_hook`（前缀扫描确认唯一，无同名/近名行） |
| 状态/预算 | `failed`，3/3，无活跃 lease |
| 上游链 | dreamer/philosopher/scribe 全 succeeded |
| canonical Pain 谱系 | dreamer seed `sourcePainId = manual_1791288844898_srw1yzhs`，与候选精确一致 |
| metadata | channel=`code_tool_hook`，无 completionIntent，可水合 |
| scribe 工件 | `pi-art-scribe-605ba208-…-code_tool_hook-run_…_1`（validation_status=pending，原则草案《全局引用先行》在） |
| 运行历史 | 3 条 failed runs（恢复后必须原样保留） |
| 恢复审计 | `recovery_actions.jsonl` 无该任务先例 |
| 轨迹可读性 | session `pri768v5-s1`：21 条 tool call（3 失败）+ 1 条 correction sample 可读 |
| 竞争窗口 | 预检时刻近 5 分钟零新 run |

### Staging Dry-run（隔离副本，非生产 dry-run）

**标注：Staging Dry-run**——生产库只读副本（`D:/Code/principles/.tmp/iaer-pilot/staging-ws/.pd/state.db`）+ 本次工程构建的新 CLI，非正式安装运行时（新命令尚未部署）。实测输出：`ok:true, mode:dry_run, reasonCode:eligible_budget_reset_required, plannedChange:{status:'failed → pending', attemptBudget:'3/3 → 0/6 (with --reset-budget)'}, wouldWriteAudit:false`；dry-run 后只读复查副本：任务行仍 `failed 3/3`、无 `recovery_actions.jsonl` 生成——**零写入证实**。

## 7. Owner 授权卡（单任务精确恢复，不执行 confirm）

- **完整 taskId**：`artificer-605ba208-f9e9-42e4-9eb3-7730cd1031cd-code_tool_hook`
- **状态变化**：`failed` → `pending`（单条 CAS UPDATE；maxAttempts 3→6、attemptCount 3→0；lastError/lease/resultRef 清空——均与既有批量权威一致）
- **预算重置影响**：仅此一条任务；`previousAttemptCount=3` 持久化于 `D:/.openclaw/workspace/.state/recovery_actions.jsonl` 审计行
- **数据审计**：一条 `reconcile` action 审计记录（operator=`--decidedBy` 标签、forceApplied=true、previousAttemptCount=3）；3 条历史 failed runs 与全部工件不动
- **消费者竞争**：gateway 在跑 2 分钟周期；恢复为 pending 后下一周期即触发证据预检（预期直接 NHR，等待 attach——不产生模型调用）；若周期恰在恢复瞬间租用该任务（概率极低），CAS 使恢复失败并报 conflict，零副作用
- **回滚/补偿**：恢复本身不删任何数据；如需回退，任务可重新 `pd runtime internalization retry --confirm`（NHR→pending 方向不适用——回退路径为：任其留在 NHR 即无任何模型消耗；或将任务行手工置回 failed 需 Owner 明确指令，不自动执行）
- **后续链路**：恢复 → 消费者 NHR → Owner `evidence attach --confirm`（选定负例 Tool Call 1 条 + 正例 1~3 条 + ownerDesiredOutcome）→ `evidence resume --confirm` → Artificer L2 真实执行
- **模型预算**：Artificer L2 全链（生成→校验→确定性重放→提交）预计 3–8 次调用；**「上限 12 次」是本 Pilot 计划的 Owner 侧约定，不是运行时已实现的硬限制**（风险声明：运行时既有约束仅为 maxAttempts=6 与 profile timeoutMs=300s，不存在 per-run 模型调用次数硬闸；调用次数控制依赖 Owner 按下述中止条件人工介入）。Provider=当前 zai glm-5.3 通道，单次 Pilot 预计量级为人民币个位数；**超额/连续失败中止条件**：同一任务 attempt 消耗达 6（新预算上限）或单次 L2 预算超时（profile timeoutMs=300s）即停，不自动重试
- **执行命令**（部署 PRI-991 PR 后）：
  1. `pd runtime recovery failed-task --task-id "artificer-605ba208-f9e9-42e4-9eb3-7730cd1031cd-code_tool_hook" --dry-run`（复核）
  2. `pd runtime recovery failed-task --task-id "artificer-605ba208-f9e9-42e4-9eb3-7730cd1031cd-code_tool_hook" --confirm --reset-budget --decidedBy owner/console`
  3. 约 2 分钟后：`pd runtime internalization evidence list --workspace "D:\.openclaw\workspace" --json`（应出现该任务于 NHR 等待清单）

## 8. PR 与 Linear

- 工程 PR：见本报告关联 PR（PRI-991，独立分支 `ai/adhoc-20261016-iaer-single-recovery-x8k2m4-single-task-recovery`，不自动合并）
- Linear：PRI-991（本工单，创建即关联 PR）；PRI-980～985 维持 Done；PRI-988/989（P2）不受本报告影响
- PR #2045 报告更正：随本次会话提交推送至 #2045 分支（撤回批量恢复建议、僵尸 12+25 分类、hasGovernanceSideEffects 限定语、gateway 状态区分、CONDITIONAL PASS 维持）

## 9. 剩余风险与回滚

1. 新命令未部署前，生产侧对 3/3 任务**仍无安全单任务恢复路径**（现状不变，风险为零——什么都不做就不会误恢复）；
2. 批量 `failed-tasks --force` 的批量重置风险依旧存在于既有命令（未改动，Owner 使用时需知情）；
3. completion intent 守卫只在严格路径生效（批量路径保持既有行为，FR-16）；批量路径如需同等守卫应另立单评估；
4. 回滚：revert 本 PR 即完全移除新入口（无持久化 schema、无迁移、审计行向后兼容）。

## 10. 裁决

- **ENGINEERING GO** —— 单任务恢复代码、三层测试（真实 SQLite/并发/证据门集成）、typecheck、lint、merge gate 全部通过；
- **PRODUCTION PILOT NOT_RUN** —— Owner 尚未授权恢复目标任务、附加证据与真实模型调用；新命令尚未经官方发布链部署到安装运行时。不以 Engineering GO 冒充 Production PASS。

---

## 11. 独立对抗性复审（修复轮后，2026-10-16）

| # | 问题 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | dry-run 是否真的从文件系统到 SQLite 都没有写入？ | **是**（除 SQLite 读 WAL 库的固有 -shm/-wal 读机制 sidecar，无任何内容写入） | T01-A（缺 DB：零文件/目录创建）；T01-B（state.db sha256 逐字节不变 + .pd 目录除固有 sidecar 外零新增 + 无审计文件）；T01-C（schema-less 文件不被迁移）；journal 模式对照实验：readonly 打开零 sidecar |
| 2 | 恶意/损坏 metadata 能否让 completion intent 守卫失效？ | **否** | `assessRecoveryMetadataGuard`：pi_metadata 存在即必须过唯一权威 hydratePITaskRecord，失败 = `invalid_task_metadata` 拒绝（T02-A/B/E 含"损坏本应携带 pending intent"攻击面）；畸形 JSON 由列级 json_valid CHECK 拦截（store 拒绝写入实证）；无第二解析器 |
| 3 | CAS 是否涵盖恢复所依赖的所有可变状态？ | **是** | 全快照前置（status+metadata+attempt+maxAttempts+leaseOwner+leaseExpiry）进同一条 UPDATE；store 级逐字段测试 + 真实竞争注入 T04-A~E 全部 conflict |
| 4 | 并发写者能否绕过 Lease 检查？ | **否** | 守卫读（hasActiveLease）+ CAS WHERE lease_owner/lease_expires_at IS 快照双重覆盖；T04-C/D：读后 acquire/expiry 变更 → conflict |
| 5 | 审计落盘失败是否存在无记录的成功恢复？ | **状态变更必有持久事实；JSONL 可能缺投影行**——按设计声明：行内 `lastFailedTaskRecovery` 即审计权威，JSONL 为投影；投影失败显式 `recovered_but_audit_failed` + `--repair-audit` 重投影 | T03-B/E/F |
| 6 | 进程崩溃后能否可靠对账？ | **可水合任务：是**（行事实 actionId 对账 JSONL）；**legacy 无 metadata 任务：投影不可恢复**（已如实标注边界，无行事实兜底，属 rare legacy 形状） | repair-audit 实现 + `no_durable_recovery_record` 拒绝 |
| 7 | 失败后再次 confirm 是否导致额外预算重置？ | **否** | 首次成功后 status=pending → 再 confirm = `not_failed` 拒绝（T09/T03-D）；CAS 输家不写任何字段（T04-H） |
| 8 | 是否可能错误恢复其他历史任务？ | **否** | 精确 taskId（无前缀/通配）；T05：83 条中仅目标 1 条变更，其余 82 条逐字节比对一致 |
| 9 | 是否可能绕过 IAER Evidence Gate？ | **否** | 恢复仅到 pending，不构造 runner/adapter；集成测试证明下一周期必经证据预检 → NHR（零 LLM/零 run）；capability OFF 不执行、无 V1 回退（T11–T15） |
| 10 | 是否引入新持久化权威/子系统/不必要复杂度？ | **否** | 复用既有 CAS 原语（选项扩展）、既有审计通道（投影）、既有 metadata 序列化（可选字段）；无新表/无新 flag/无第二恢复系统；Complexity Delta 全 NO（1 个新增可选 metadata 字段） |

**复审结论：P0/P1 未解决项 = 0。** 有一项诚实边界（见 #6 与 §0 P1-03）已显式声明而非隐藏。

### 与既有写入路径的竞争窗口清单（P1-04 要求的盘点）

能够更新 attempt/maxAttempts/lease/diagnosticJson 的写入路径：① runner 的 markTaskRetryWait/markTaskFailed/markTaskSucceeded（updateTask）；② LeaseManager acquire/release/renew；③ RecoverySweep（过期 lease 清理）；④ owner-retry / evidence attach/resume（自有 CAS，与恢复互斥由 status 门保证）；⑤ succeeded-transition reconciliation（仅 touched succeeded 任务）；⑥ 消费者预检 NHR 迁移（仅 pending/retry_wait 唤醒态，failed 不在其列）。除 ①②③ 外全部被 status 门天然隔离；①②③ 由本 PR 的全快照 CAS 覆盖。

---

## 12. 第二轮独立复审修复（2026-10-16，r2）

| 缺陷 | 核实 | 根因 | 修复 | 测试 |
| --- | --- | --- | --- | --- |
| **r2-P1-01 操作人标签未随 CAS 持久** | 属实 | `recoverSingleFailedTask` 硬编码 `operator: null`，`--decidedBy` 只进 JSONL 投影——崩溃后 `--repair-audit` 只能恢复出 null | `recoverSingleFailedTask` opts 增加 `operator`，随同一条 CAS 写入行事实（语义不变：operator-provided label，非认证身份） | CLI：recover(crash)→repair 后 JSONL 行 `operator='owner/console-session-42'` |
| **r2-P1-02 第二次恢复覆盖唯一持久事实** | 属实 | 单字段 `lastFailedTaskRecovery` 第二次 CAS 直接覆盖；未投影的旧 actionId 永久丢失 | 字段改为**追加式数组** `failedTaskRecoveries`（保留最近 `FAILED_TASK_RECOVERY_RETENTION=5` 条，逐元素 rc-3/rc-4 校验，超限 fail-closed）；且 CLI confirm 在 CAS **之前**先把既有未投影事实投影落盘（预投影失败 = 结构化拒绝、零状态变更，cli-5）——未投影事实在被覆盖前必先落 JSONL，数组为纵深保留 | 真实序列测试：recover#1 → JSONL 丢失 → 任务再失败 → recover#2 → 两条事实均存活且均投影（operator r1/r2 各自保留）；纯 core 双恢复（无 CLI 预投影）数组双记录 + repair 双投影 |
| **r2-P1-03 绕过统一 Workspace 校验** | 属实 | 命令内 `path.resolve(opts.workspace)` 绕过 `resolveWorkspaceDir` 的 `assertSafeDirectoryRoot`（空/穿越/文件系统根）与配置差异警告——本命令可变更任务状态，不得例外 | 无条件走 `resolveWorkspaceDir(opts.workspace)` 单一权威；其抛错映射为结构化 `workspace_invalid` | 前导 `..` 遍历拒绝；文件系统根拒绝；显式合法 workspace 正常（既有 T01–T05 全绿） |
| **r2-P2 repair-audit 并发可重复投影** | 属实 | check-then-append（TOCTOU）：两个并发 repair 同时发现缺失、各写一次 | 引入投影锁（`.state/recovery_actions.jsonl.lock`，O_EXCL 创建，git-12 先例：既存锁永不覆盖/自动删除，崩溃持有者需人工清理）；confirm 与 repair 的所有投影统一走 `projectRecoveryRecordsOnce`（锁内同步 check+append，原子）；持锁冲突 → 结构化 `audit_projection_locked` | 并发双 repair → 每 actionId 恰一行；持锁注入 → 拒绝且锁文件内容不被覆写 |

**诚实边界（更新）**：r2-P1-02 修复后，原「legacy 无 metadata 任务投影不可恢复」边界不变；新增说明——数组保留最近 5 条，若同一任务连续 5 次恢复且全部未投影（极端磁盘故障持续 5 轮），最早事实按保留策略淘汰；CLI 预投影使该场景在实际操作序列中不可达（每轮 confirm 先清空未投影积压）。

**测试规模（r2）**：CLI 25（+7，含双恢复双投影、并发 repair、持锁注入、traversal/根拒绝、operator 可恢复性）、core 577 全量相关回归（含新字段 parse/serialize/merge 与 hydration 兼容）、host-runtime 11、批量命令 18。lint 11/11、typecheck ×3、runtime-contract 0 新违规。

### r2 CI 收尾（head c334b0581）

首轮 r2 提交（4fe13987d）的 CI 暴露两项收尾：① CodeQL `js/file-system-race`（high）——投影锁 `openSync('wx')` 后按路径名重开写 holder 信息构成 TOCTOU；改为经已持有 fd 写入（同 inode，构造性免竞态）。② 盘根拒绝测试硬编码 `D:/` 在 Linux CI 是合法相对目录（表现为 storage_unavailable 而非 workspace_invalid）——改为 `path.parse(process.cwd()).root` 平台中立推导。最终 head **c334b0581**：GitHub CI **32 项 pass**（Verify Merge Gate / CodeQL / Test×3 / Lint 等全部 required 绿；唯一非 pass 为 codecov/patch 补丁覆盖率 advisory，非 required）。本地 verify:merge r2 head REAL_EXIT=0（.tmp/verify-merge-r2.log）。
