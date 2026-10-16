# IAER Single-Task Recovery P1 实施报告（2026-10-16）

> 关联：SPEC-PD-IAER-001 / PR #2041（已并）/ PR #2045（Pilot 报告，CONDITIONAL PASS）
> Linear：PRI-991（本工程工单）；PRI-980～985 维持 Done；PRI-988/989（P2）不受本报告影响
> 执行者：ZCode（任务书《IAER Production Pilot P1 收口》）

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
- **模型预算**：Artificer L2 全链（生成→校验→确定性重放→提交）预计 3–8 次调用，**硬上限建议 12 次**；Provider=当前 zai glm-5.3 通道，单次 Pilot 预计量级为人民币个位数；**超额/连续失败中止条件**：同一任务 attempt 消耗达 6（新预算上限）或单次 L2 预算超时（profile timeoutMs=300s）即停，不自动重试
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
