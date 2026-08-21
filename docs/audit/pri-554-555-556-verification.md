# PRI-554 / PRI-555 / PRI-556 独立验证报告

- **日期**: 2026-08-21
- **代码基线**: `D:\Code\principles` @ `10432224`（分支 `fix/codex-e2e-onboarding-artificer-retry`）
- **运行数据**: `D:\.openclaw\workspace\.pd\state.db`（全部只读查询，`readonly: true`）
- **性质**: 只读审计。未修改任何源码、数据库、配置、测试。复现实验在 OS 临时目录的临时 workspace 中进行，已清理。
- **前置审计**: 本报告与既有四篇 `docs/audit-artificer-*.md`（未跟踪文件）互补；其中 `docs/audit-artificer-dependency-resolution.md` 的关键结论本次全部独立重验通过。

---

## 0. 结论总表

| Bug | Result | Confidence | Evidence |
|---|---|---|---|
| PRI-554 死租约无自动回收 | **Confirmed** | 高 | 代码：recovery sweep 完整实现但唯一调用方是手动 CLI；运行数据：2026-08-13 有 6 个孤儿 `running` run（历史死租约实锤）；复现：临时 workspace 中 3 个 consumer cycle 均无法看到过期租约任务 |
| PRI-555 Artifact Identity Contract Drift | **Confirmed** | 高 | 代码：resolver 精确匹配 + `input_invalid` 永久无重试；运行数据：63 个 `input_invalid` 失败任务的依赖全部是 6 月创建、`succeeded`、有 output_payload、但自身 id 下 **0 条** pi_artifacts；2 条链的 artifact 存在于旧命名 key 下；8 月对照组 23/39 正常解析 |
| PRI-556 Console 历史失败污染治理状态 | **Confirmed**（机制确认 + 当前即处于 degraded；nuance 见 §4.4） | 高 | 代码：Console 聚合查询无时间窗/无 supersession 判断，`failed` 为终态且无任何清除路径；运行数据：当前 66 个 failed → `governanceState=degraded`（0 pending approvals），其中 3 个已 ≥7 天且无补救路径，63 个为 8-20 的 PRI-555 级联 |

三个 Bug 均属实。均建议修复，优先级与最小修复方案见 §5–§8。

---

## 1. 验证方法与 ERR 基线

按 AGENTS.md Handbook Gate，本次审计对照的 pattern card：

- **EP-02 Production Path Wiring**（ERR-011 / ERR-024 / ERR-083）——"组件存在、有单测，但真实用户/运行路径从不调用它"。PRI-554 是该 pattern 的教科书案例：`DefaultRecoverySweep` 完整实现 + 完整测试，唯一生产调用方是手动 operator 命令。
- **EP-07 Runtime State Source Alignment**（ERR-031 / ERR-034 / ERR-036 / ERR-042）——lineage / artifact source ID 一致性。PRI-555 的 `source_task_id` 漂移属于此类。
- **EP-03 Fail Loud and Observable Degradation**（ERR-002 / ERR-009）——degradation 必须结构化、可归因。PRI-556 是 degradation 语义错误（把"曾经失败"当"当前降级"），且 reason 只有 category 无 runtime 细节。

数据来源优先级：源码 > state.db 实际数据 > 复现实验 > Linear issue 描述。Linear 描述仅作线索。

---

## 2. PRI-554 — 死租约无自动回收，auto-consumer 不调用 recovery sweep

### 结论: **Confirmed**（判定标准 3 条全部满足）

### 2.1 证据 1 — Code evidence：recovery 存在，但无 runtime 调用方

**Recovery implementation:**

```
file:     packages/principles-core/src/runtime-v2/store/lifecycle/recovery-sweep.ts
function: DefaultRecoverySweep.detectExpiredLeases() / recoverTask() / recoverAll()
          （过期租约 → retry_wait(带退避) / failed(max_attempts 用尽) / needs_human_review(workspace_dirty)；
            事务内原子 read-check-write，幂等，含遥测事件）
封装:     packages/principles-core/src/runtime-v2/store/runtime-state-manager.ts:437-444
          runRecoverySweep() / detectExpiredLeases()
          packages/principles-core/src/runtime-v2/recovery-sweep-service.ts (createRecoverySweepService)
```

**Call graph（全仓搜索 `runRecoverySweep(`/`recoverAll(`/`detectExpiredLeases(`，排除测试与 dist）:**

```
DefaultRecoverySweep.recoverAll()
  ↑ RuntimeStateManager.runRecoverySweep()            [core 内部封装]
  ↑ createRecoverySweepService()                      [core 导出]
  ↑ handleRuntimeRecoverySweep()                      [pd-cli/src/commands/runtime-recovery.ts:42]
  ↑ pd runtime recovery-sweep                          [pd-cli/src/index.ts:710 — 手动 operator 命令]

openclaw-plugin（auto-consumer 所在包）: 0 处引用 recovery sweep —— 全文搜索
  "recovery" 在 plugin 源码中仅命中 trajectory 的 recovery_tool_span 字段（无关）。
```

**auto-consumer 主循环**（`packages/openclaw-plugin/src/service/internalization-auto-consumer-service.ts:95-419`）生命周期：

```
fetch ready task (orchestrator.wakeOnce, 每 120s 一周期)
  → acquireLease (lease-manager.ts:122-184: 仅接受 status ∈ {pending, retry_wait})
  → runner.run()
  → 成功: commitNextTaskProposal / 失败: runner 内部 markTaskFailed/markTaskRetryWait
  → catch 未捕获异常: markTaskRetryWait / markTaskFailed (in-process 兜底, :360-378)
  → finally: runReconciliationBudget —— 只做 succeeded-transition 对账
             (reconcileSucceededTransitions, 修"markTaskSucceeded 后 crash"窗口)
```

**关键缺口**: `finally` 块的 reconciliation 只覆盖 `succeeded-but-uncommitted` 窗口；`leased-but-crashed` 窗口（进程死亡 / kill -9 / 断电，in-process catch 无法触达）没有任何周期性回收。`findCandidates`（internalization-orchestrator.ts:920-944）只查 `pending + retry_wait` 两个列表，过期 `leased` 任务对 consumer **永久不可见**。代码注释自己也承认这一点（orchestrator.ts:707 "wakeOnce only scans pending/retry_wait"；pain-signal-bridge.ts:173 描述 pending 任务将由 "wakeOnce/recovery-sweep" 处理——后者实际从未被接线）。

备选回收路径同样只有手动接线：`InternalizationIntegrityRemediation`（含 forceExpireAndMarkRunFailed）仅被 `pd-cli runtime-internalization-integrity-repair` 调用。

### 2.2 证据 2 — Runtime evidence：死租约在生产中真实发生过

对 `state.db` 的只读查询（2026-08-21 00:31 UTC）：

- 当前任务分布：succeeded 358 / failed 88 / retry_wait 10 / pending 5 / needs_human_review 3 / leased 1。
- 当前 **0 个过期租约**（唯一 leased 任务是几分钟前 auto-consumer 正常获取的 evaluator 活跃任务）——即当前时刻系统恰好健康。
- **历史死租约实锤**: `runs` 表中 6 个 `execution_status='running'` 的孤儿 run（3 条 diagnosis_pain 链 × 2 任务），`started_at` 全部停在 2026-08-13 04:46–04:49，至今未关闭——这是"进程在 run 中途死亡"的直接签名。对应任务最终在数小时后以 attempt 2–4 重试成功，且 `tasks` 表中存在 `last_error='lease_expired'` 的记录（diag_router，2026-06-16）——该字符串**只有** recovery-sweep.ts:118 会写入，证明当时是人工跑过 `pd runtime recovery-sweep` 补救的，而非任何自动机制。

### 2.3 证据 3 — Reproduction evidence：临时 workspace 复现卡死

在 OS 临时目录构造 workspace（`RuntimeStateManager` + `InternalizationOrchestrator`，dreamer 任务，`durationMs=1` 模拟 worker 死亡）：

```
after worker death: status=leased expired=true
consumer cycle 1/2/3: wakeOnce decision=no_ready_tasks reason=no_candidates   ← 永久不可见
detectExpiredLeases: ["dreamer-repro-1"]                                       ← sweep 能发现
runRecoverySweep (manual): {"recovered":1}                                     ← 手动才恢复
after sweep: status=retry_wait lastError=lease_expired                         ← 退避后可再被租
```

结论：不跑 sweep，consumer 无限周期输出 `no_ready_tasks`，任务永久卡在 `leased`。

### Root cause

**EP-02 生产路径接线缺失**：lease 生命周期设计了完整的过期回收原语（SPEC v1 §12），实现与单测齐全，但唯一的调用方是手动 CLI。auto-consumer 的 `finally` 只修了两个 crash 窗口中的一个（succeeded-uncommitted），漏掉 leased-crashed。

### Impact

- 任何进程级死亡（崩溃 / kill / 断电 / OpenClaw 网关重启）发生在 lease 期间 → 任务无限期卡 `leased`，链路后续任务全部无法 seed，且**无任何信号**（Console 对 `leased` 状态不产生 degraded 信号——静默停滞）。
- 当前生产靠人工跑 `pd runtime recovery-sweep` 兜底（历史上确实这么救过），违背 MVP 的无人值守 internalization 目标。
- 附带发现（相邻但不属于本 Bug）：10 个 6 月的 `retry_wait` diag 任务因 auto-consumer 不扫描 diag kind 而永久滞留——sweep 恢复的 `retry_wait` 只有被对应 kind 的 runner 扫描才会续命。

### Recommended action: **Fix now**（方案见 §5）

---

## 3. PRI-555 — Artifact Identity Contract Drift 导致历史 Scribe artifact 无法被解析

### 结论: **Confirmed**

### 3.1 证据 1 — Code evidence

**Artifact schema / identity:**

```
table:  pi_artifacts
fields: artifact_id ('pi-art-<taskId>-<runId>'), artifact_kind, source_task_id, content_json,
        lineage_artifact_ids, validation_status, created_at/updated_at
identity field: source_task_id（= producer task id）+ artifact_kind，构成 upsert 幂等键
                （sqlite-pi-artifact-store.ts: ON CONFLICT(source_task_id, artifact_kind)）
缺失:  无 version / contract_version 列，无法表达或检测命名契约代差
```

**Resolver logic**（`artificer-runner.ts:491-584` buildContext）：

```
for depId of piTask.dependencyTaskIds:
    depTask = getTask(depId); 非 scribe / 非 succeeded → skip
    artifacts = artifactStore.listBySourceTaskId(depId)   ← 精确匹配，无任何 fallback
    if artifacts.length > 0 → 取 artifacts[0]，返回 scribeArtifact + sourceScribeArtifactId
miss → invokeRuntime 直接 throw PDRuntimeError('input_invalid',
        'Scribe dependency artifact not resolved')          ← artificer-runner.ts:583
input_invalid ∈ permanentErrorCategories（:465-476，恒为永久——artificer_output_retry
flag 只豁免 output_invalid）→ 0 次重试，直接 failed
```

**Task identity ↔ artifact identity 耦合**: artifact 唯一可解析的 key 是 producer 的 task_id 字符串，而 task_id 采用 `<role>-<前置链>-<uuid>-<channel>` 拼接命名。命名约定一旦变化（历史上发生过），历史 artifact 即对新的 resolver 不可见。确认为架构风险（Drift 无检测面）。

### 3.2 证据 2 — Runtime evidence（state.db 只读重验，与既有审计文档结论一致）

对全部 `task_kind='artificer' AND status='failed' AND last_error='input_invalid'` 的任务（18 个），逐一验证其 `diagnostic_json → pi_metadata.dependencyTaskIds[0]`：

| 检查项 | 结果 |
|---|---|
| scribe 依赖任务存在且 kind=scribe | 18/18 |
| 依赖任务 status='succeeded' | 18/18 |
| 依赖有 succeeded run 且 output_payload 非空（LLM 确实产出过） | 18/18 |
| 依赖 task id 下的 pi_artifacts 行数 | **18/18 = 0** |
| 依赖任务创建时间 | **18/18 在 2026-06**（失败方创建于 2026-08-20，跨约 2 个月） |

同一漂移的**级联范围**远超 artificer（本次新发现，既有审计只统计了 artificer）：

| 失败任务 kind | input_invalid 数 | 依赖创建于 6 月 | 依赖 0 artifacts |
|---|---|---|---|
| philosopher | 25 | 25 | 25 |
| artificer | 18 | 18 | 18 |
| scribe | 16 | 16 | 16 |
| evaluator | 4 | 4 | 4 |
| **合计** | **63** | **63** | **63** |

**旧 key 证据**: 6 月的 pi_artifacts 中存在 `source_task_id = artificer-scribe-philosopher-dreamer-9e9081a2-…-code_tool_hook×4`（2026-06-17）与 `…d650b0c7-…-prompt×4`（2026-06-19）——UUID 与两条失败链完全匹配，但旧 key 是 `artificer-` 前缀 + channel 后缀重复 4 次；当前 scribe task id 是 `scribe-` 前缀 + channel 后缀 3 次。精确匹配必然 miss。

**对照组**: 2026-08 创建的 39 个 scribe 中 23 个在自身 id 下有 artifact，其下游 Artificer 正常解析——证明现行 write/read 契约在"同代"数据上自洽，故障隔离在 6→8 月命名漂移边界。

### 3.3 证据 3 — 判定标准核对

`artifact exists AND producer succeeded AND consumer cannot resolve`：
- producer succeeded：18/18（且 output_payload 在 runs 表可取回）；
- artifact exists：至少 2 条链以旧 key 存在；其余 16 条链的原始输出存在于 runs.output_payload（artifact 未按当前 key 落盘）；
- consumer cannot resolve：63/63 `input_invalid`，永久失败零重试。

→ **Confirmed**。

### Root cause

双层：
1. **结构层（使能条件）**: artifact identity = 易变的 task-id 命名串，无版本戳、无 fallback、无漂移检测面（EP-07）。
2. **触发层**: 2026-08-20 重新 seed 的任务链引用了 6 月的 scribe 任务 id；期间命名约定已变更（`artificer-scribe-…-chan×4` → `scribe-…-chan×3`），历史产出对当前 resolver 不可达。
3. **放大器**: `input_invalid` 永久分类使一切近失匹配（UUID 相同）也无法通过重试自愈——重试本来也无效，因为 resolution 必须先成功。

### Impact

63 条任务永久 failed（占 console 可见 failed 的 95%），4 个 runner kind 的链路死端；实际数据（scribe 输出 payload / 旧 key artifact）都在，只是不可寻址。

### Recommended action: **Fix now**（数据回填优先；方案见 §6）

---

## 4. PRI-556 — Console internalization failure signal 展示历史失败，污染当前治理状态

### 结论: **Confirmed**（机制确认；当前 degraded 是真实失败驱动，但信号一旦产生即永不消退——"历史污染"是结构性保证，且已开始发生）

### 4.1 证据 1 — Code evidence

`packages/pd-console/src/server/models/GovernanceConsoleModel.ts:198-215`（治理首页 signal 来源）：

```sql
SELECT task_kind, status, last_error FROM tasks
WHERE task_kind IN ('dreamer','philosopher','scribe','artificer','evaluator')
```

- **无时间窗、无 supersession/回收判断**：任何历史时刻进入过 `retry_wait` 或 `failed` 的行，永远计入 `hasFailedTasks`/`hasRetryWaitTasks` → 永远产生 `task_failed`/`task_retry_wait` degraded signal → （无 pending approvals 时）`governanceState='degraded'`（:249-257, :287-292）。
- **`failed` 是终态且无清除路径**：全仓唯一任务删除是按 id 的 `deleteTask`（sqlite-task-store.ts:188），无归档/过期作业；`pd runtime internalization retry` 命令只接受 `needs_human_review`（runtime-internalization-retry.ts:85），failed 无 operator 补救入口。
- 例外：evaluator 驱动的 repair-reopen 会把 failed 前驱转回 pending（本次在 4 条 rulehost 修复链上验证：修复成功后链内无残留 failed）——但手动重试 / 换链 re-seed / 人工修复 DB 不走此路径。

### 4.2 证据 2 — Runtime evidence

按 Console 同一 SQL 对 live 库模拟（2026-08-21）：

- console 可见 internalization 任务 261；**failed 66**（retry_wait 0）；
- `approvals status='pending'` = 0 → `hasOwnerReadyItems=false` → **当前 governanceState='degraded'**；
- 66 个 failed 构成：63 个 `input_invalid`（全部 2026-08-20，即 PRI-555 级联）+ 2 个 artificer `output_invalid`（08-14/08-17）+ 1 个 evaluator `output_invalid`（08-14）——后 3 个已 ≥7 天陈旧，且无任何补救/清除路径，仍在持续贡献 degraded 信号。

### 4.3 证据 3 — 诊断来源核对（任务书 Step 4）

Console 只读 `tasks.last_error`（裸 category，如 `input_invalid`）；`runs.reason` 携带的真实 runtime 诊断（如 `[input_invalid] Artificer dependency artifact not found`）未被使用。degraded reason 字符串是 N 个 `kind: category` 的拼接（当前 66 项 ≈ 1.7KB），既不可归因到具体任务，也不含可行动细节。

### 4.4 Nuance（避免过度指控）

当前这一刻的 degraded **不是误报**——63 个 8-20 的失败是真实的 PRI-555 级联。PRI-556 的缺陷在于：**(a)** 信号与失败同龄永久存活（修复底层问题后信号不清零，08-14 的 3 个已经在演示这一点）；**(b)** 聚合把"曾经失败"与"当前需要 Owner 关注"混为一谈，无 supersession（链路已由新任务成功）与时效语义。按任务书判定标准（historical failed record causes current degraded signal without active remediation needed）：08-14 的 3 条 + 全部 63 条在底层修复后即满足；机制上成立，运行数据开始呈现。

### Root cause

Console 聚合层用**无状态全量扫描**表达**当前健康度**：终态 `failed` 无 TTL、无 supersession 判定、无清除作业（EP-03：degradation 语义错位——不是不响，而是永不消音）。

### Impact

狼来了效应：degraded 常驻 → Owner 学会忽略 → 真正的降级（含 PRI-554 那种静默停滞的对偶面）失去信号价值。直接违背 emotional-value.md 的安心感/掌控感承诺（信息过载 + 失控感）。

### Recommended action: **Fix now**（方案见 §7）

---

## 5. 修复设计方案 — PRI-554（最小修复）

| 项 | 内容 |
|---|---|
| Problem | 进程死亡留下的过期 `leased` 任务对 auto-consumer 永久不可见，无自动回收 |
| Root cause | recovery sweep 未接线进任何运行时路径（EP-02） |
| Minimal fix | 在 `runConsumerCycle` 的 `finally`（reconciliation 之前、`handle.close()` 之前）调用 `stateManager.runRecoverySweep()`，并像 `runReconciliationBudget` 一样：try/catch 包裹（失败留痕 `INTERNALIZATION_CONSUMER_RECOVER_FAILED`，不阻塞周期，rc-9）、有恢复/错误时打 `INTERNALIZATION_CONSUMER_RECOVERED` 结构化日志。过期租约常态为 0，成本可忽略；无需新 flag——该行为随 `internalization_auto_consumer` flag 自然启停，回滚 = PR revert（满足 mvp-q-3） |
| Files affected | `packages/openclaw-plugin/src/service/internalization-auto-consumer-service.ts`（1 处 finally + 1 个小函数）；测试：新增 consumer 周期测试断言 sweep 被调 + 失败不阻塞 |
| Risk | 低。sweep 本身幂等、事务化、已有单测；接线点与既有 reconciliation 预算同构 |
| Regression tests | (1) 过期租约任务在 N 个周期后不再 `leased`；(2) sweep 抛错时周期仍完成且留痕；(3) 活跃（未过期）租约不被误收 |
| Migration requirement | 无 |

mvp-q 快查：不修则死租约再现即需人工救（q1 ✔ 有观测：结构化日志 + 任务状态，q2 ✔）；关闭路径 = 关 auto-consumer flag 或 revert（q3 ✔）；消除的是"无人值守链路静默断裂"的失控感（q4 ✔）。

## 6. 修复设计方案 — PRI-555（数据回填优先，代码最小化）

| 项 | 内容 |
|---|---|
| Problem | 63 个任务因 6→8 月 artifact key 命名漂移永久 `input_invalid` |
| Root cause | artifact identity 锚定易变 task-id 命名 + 精确匹配 resolver + input_invalid 永久化 |
| Minimal fix | **一次性数据回填脚本**（operator script，非 runtime 代码）：备份 state.db → 对 63 个失败任务的 6 月依赖：优先把旧 key artifact（UUID 匹配的 2 条链）重 key 为 `source_task_id=<当前 scribe id>`；其余从依赖 succeeded run 的 `output_payload` 按 scribe-runner 的 contentJson 构造回填 `pi_artifacts(kind='principle', validation_status='pending')` → 将 63 个 failed 任务置回 `pending`（attempt 归零）。随后让 auto-consumer 自然重跑 |
| Files affected | 新增 `scripts/`（或 pd-cli 一次性命令）回填脚本 + state.db 备份；不改 core 代码 |
| Risk | 中——写生产 DB，必须先备份、dry-run 模式输出将变更清单（cli-4/cli-5）；回填后需人工抽验 1-2 条链走通到 evaluator |
| Regression tests | 脚本 dry-run 断言（63 命中、幂等重跑 0 变更）；回填后 E2E：任一 artificer 任务成功解析依赖 |
| Migration requirement | 即本回填；无 schema 变更 |
| 明确不做（MVP 边界） | resolver UUID-fallback、`contract_version` 列、content-addressed key——均为契约加固，登记为 post-MVP 候选（antipattern-prep-next-phase 规避）。重试改造无意义（input_invalid 重试前 resolution 必须先成功） |

## 7. 修复设计方案 — PRI-556（时效窗最小修复）

| 项 | 内容 |
|---|---|
| Problem | 治理首页把全部历史 failed/retry_wait 当作当前 degraded 信号，永不消退 |
| Root cause | 无状态全量聚合表达当前健康度，终态无 TTL/supersession |
| Minimal fix | Console 查询加时间窗（建议 `updated_at >= now-7d` 参与 degraded 判定；7 天外的失败仍可在明细页查看，只是不再驱动首页 state）。同时 degraded reason 改为结构化 top-N（如前 3 条 `kind+task_id 短码+last_error`）而非全量拼接。备选（更大改动，暂不做）：排除已有同链成功后继的 failed |
| Files affected | `packages/pd-console/src/server/models/GovernanceConsoleModel.ts`（SQL + reason 组装）；对应 model 测试 |
| Risk | 低——纯展示层；注意 stale 案例的单测要用注入时钟而非真实 sleep |
| Regression tests | (1) 8 天前的 failed 不再触发 degraded；(2) 2 天前的 failed 仍触发；(3) 有 pending approvals 时 state 仍优先 `owner_review_ready` |
| Migration requirement | 无 |

---

## 8. 因果关系分析（任务书"额外检查"）

```
PRI-554 (死租约，独立缺口)      PRI-555 (artifact key 漂移)
   │  静默停滞                     │  63 个 input_invalid 永久失败
   │  ( leased 不产生任何信号 )     │
   └──────────┐                   └──────────► PRI-556 (Console degraded)
              │                                    ▲   当前由 555 级联真实驱动；
              └── 手动 recovery sweep 后落 retry_wait ┘   修复 555 后若无 556 修复，
                  若该 kind 无 runner 扫描 →            信号永不清零 → 变成历史污染
                  永久 task_retry_wait 信号
```

- **不是同一条因果链**：本次 63 失败与死租约无关（555 是 resolution 层，554 是 lease 层），当前 0 过期租约。
- **是同一个 meta-pattern**：三层各自把某种"终态/既成事实"当作永久权威且无对账面——lease 过期无对账（554）、artifact key 无版本对账（555）、failed 展示无时效对账（556）。修复时各自最小化，不合并为"runtime reliability 大改"（antipattern 规避）。
- 555 → 556 是当前真实因果：修 555（回填）后必须同时修 556（时效窗），否则回填清不掉 failed 行（置回 pending 会清掉——注意：§6 回填会把 63 个任务置回 pending，因此这批失败信号会自然消失；08-14 的 3 条 output_invalid 则只能靠 556 的时效窗消退）。

## 9. 建议的下一步（等待 Owner 确认，本次不执行）

1. **授权 PRI-554 修复**（§5，~1 个小 PR + 测试）。
2. **授权 PRI-555 回填**（§6，先 dry-run 清单人工过目，再备份执行；可先只回填 2 条旧 key 链验证解析恢复，再全量 63）。
3. **授权 PRI-556 修复**（§7，小 PR）。
4. 顺序建议：554 与 556 可并行；555 回填放在两者之后（让重跑的任务进入一个信号正确、租约自愈的消费循环）。
5. post-MVP 登记项（不在本次范围）：artifact `contract_version`、resolver fallback、diag-kind retry_wait 滞留、`needs_human_review` 未入 Console 信号。

## 附：证据可复现命令

- 过期租约检测：`SELECT task_id,status,lease_expires_at FROM tasks WHERE status='leased' AND lease_expires_at < <now ISO>`
- 孤儿 run：`SELECT * FROM runs WHERE execution_status='running' AND started_at < datetime('now','-1 hour')`
- 555 核验：对每个 `task_kind IN (philosopher,scribe,artificer,evaluator) AND status='failed' AND last_error='input_invalid'` 任务，取 `JSON_extract(diagnostic_json,'$.pi_metadata.dependencyTaskIds[0]')`，联查 `tasks.status`、`runs.output_payload`、`COUNT(pi_artifacts WHERE source_task_id=dep)`。
- 556 核验：Console 同款 SQL + `SELECT COUNT(*) FROM approvals WHERE status='pending'`。
- 554 复现脚本：见 §2.3（RuntimeStateManager + Orchestrator + durationMs=1 租约；已验证后清理）。
