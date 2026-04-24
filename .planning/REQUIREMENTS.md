# Requirements: M5 Unified Commit + Principle Candidate Intake

**Defined:** 2026-04-24
**Core Value:** diagnostician output -> diagnosis artifact -> principle candidate -> task resultRef，全链路在 SQLite .pd/state.db 内原子完成

## v2.4 Requirements

### Artifact Registry

- [ ] **ARTF-01**: SqliteConnection 在 .pd/state.db 新增 diagnosis_artifacts 表，包含 id, task_id, run_id, idempotency_key, artifact_kind, payload_json, created_at 字段
- [ ] **ARTF-02**: SqliteConnection 新增 principle_candidates 表，包含 id, task_id, run_id, artifact_id, candidate_kind, title, description, source_recommendation, confidence, status, idempotency_key, created_at 字段
- [ ] **ARTF-03**: idempotency_key 由 taskId+runId 派生，重复 commit 不产生重复 artifact 或 candidate
- [ ] **ARTF-04**: diagnosis_artifacts 和 principle_candidates 通过 task_id/run_id 与 tasks/runs 表关联可追溯

### DiagnosticianCommitter

- [ ] **COMT-01**: 定义 DiagnosticianCommitter 接口，输入为 DiagnosticianOutputV1 + taskId + runId + contextHash，输出为 CommitResult(artifactId, candidateIds[], resultRef)
- [ ] **COMT-02**: Committer 从 recommendations 中提取 kind='principle' 的条目，为每个创建 principle candidate record
- [ ] **COMT-03**: Committer 从 violatedPrinciples 中提取关联信息，写入 candidate 的 source context
- [ ] **COMT-04**: commit 流程在同一 SQLite transaction内完成：write artifact → write candidates → update task.resultRef
- [ ] **COMT-05**: 事务失败时全部回滚，不留下"artifact 写入但 candidate 缺失"的中间状态
- [ ] **COMT-06**: commit 成功后返回 CommitResult，包含 artifactId 和所有 candidateIds

### Runner Integration

- [ ] **RUNR-01**: DiagnosticianRunner.succeedTask() 在标记 task succeeded 之前调用 DiagnosticianCommitter.commit()
- [ ] **RUNR-02**: 正确顺序：output validated → committer.commit() → task succeeded + resultRef 更新
- [ ] **RUNR-03**: commit 失败时 runner 使用 artifact_commit_failed 错误类别，不将 task 标记为 succeeded
- [ ] **RUNR-04**: Runner 不直接引用 artifact/candidate 表名、SQL、或 ledger 文件路径，只通过 Committer 接口操作
- [ ] **RUNR-05**: commit 失败可触发 retry（通过现有 RetryPolicy），不直接 fail task

### CLI / Operator Visibility

- [ ] **CLIV-01**: `pd candidate list --task-id <id>` 返回指定 task 关联的所有 principle candidates
- [ ] **CLIV-02**: `pd candidate show <candidateId>` 返回 candidate 详情（title, description, confidence, source, status）
- [ ] **CLIV-03**: `pd diagnose status --task-id <id>` 扩展显示 commitResultRef、artifactId、candidateIds
- [ ] **CLIV-04**: 所有 CLI 输出支持 --json 格式，可用于 E2E 测试断言

### Telemetry

- [ ] **TELE-01**: emit diagnostician_commit_started event（commit 开始前）
- [ ] **TELE-02**: emit diagnostician_artifact_created event（artifact 写入后）
- [ ] **TELE-03**: emit diagnostician_candidate_created event（每个 candidate 创建后）
- [ ] **TELE-04**: emit diagnostician_commit_succeeded event（commit 事务完成）
- [ ] **TELE-05**: emit diagnostician_commit_failed event（commit 失败，含 errorCategory）

### E2E Verification

- [ ] **E2EV-01**: E2E 测试证明：task → run → output → diagnosis artifact → principle candidate → resultRef 全链路可追溯
- [ ] **E2EV-02**: E2E 测试证明：重复 commit 同一 task/run 不产生重复 candidate
- [ ] **E2EV-03**: E2E 测试证明：commit 失败时 task 不显示为 succeeded
- [ ] **E2EV-04**: E2E 测试使用 TestDoubleRuntimeAdapter，不依赖真实 OpenClaw LLM

## v2 Requirements

Deferred to future milestones.

### Principle Promotion

- **PROM-01**: Principle candidate 可通过 gating 流程 promotion 为 active principle
- **PROM-02**: Active principle 自动注入到 agent context

### Ledger Bridge

- **LEDG-01**: PrincipleTreeLedger adapter/bridge 将 SQLite candidate 同步到文件系统 ledger
- **LEDG-02**: 双向兼容：openclaw-plugin 仍能读取 ledger

### Multi-Runtime

- **MULTI-01**: Production OpenClaw adapter replacing TestDoubleRuntimeAdapter

## Out of Scope

| Feature | Reason |
|---------|--------|
| Principle promotion / gating | M6+ scope; M5 只产生 candidate，不 promotion |
| Active principle injection | 下游消费 M5 产出，不是 M5 职责 |
| PrincipleTreeLedger 原子写入 | 文件系统存储不适合 SQLite 事务；只做 adapter/bridge |
| Multi-runtime adapter suite | M8 scope |
| OpenClaw plugin demotion | M6 scope |
| LLM prompt template redesign | M5 不改 prompt 内容 |
| M3/M4 finding 重开 | M3/M4 已修复合并，M5 只确认无回归 |
| Marker file removal | Legacy 兼容输出保留 |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| ARTF-01 | — | Pending |
| ARTF-02 | — | Pending |
| ARTF-03 | — | Pending |
| ARTF-04 | — | Pending |
| COMT-01 | — | Pending |
| COMT-02 | — | Pending |
| COMT-03 | — | Pending |
| COMT-04 | — | Pending |
| COMT-05 | — | Pending |
| COMT-06 | — | Pending |
| RUNR-01 | — | Pending |
| RUNR-02 | — | Pending |
| RUNR-03 | — | Pending |
| RUNR-04 | — | Pending |
| RUNR-05 | — | Pending |
| CLIV-01 | — | Pending |
| CLIV-02 | — | Pending |
| CLIV-03 | — | Pending |
| CLIV-04 | — | Pending |
| TELE-01 | — | Pending |
| TELE-02 | — | Pending |
| TELE-03 | — | Pending |
| TELE-04 | — | Pending |
| TELE-05 | — | Pending |
| E2EV-01 | — | Pending |
| E2EV-02 | — | Pending |
| E2EV-03 | — | Pending |
| E2EV-04 | — | Pending |

**Coverage:**
- v2.4 requirements: 28 total
- Mapped to phases: 0
- Unmapped: 28 ⚠️

---
*Requirements defined: 2026-04-24*
*Last updated: 2026-04-24 after initial definition*
