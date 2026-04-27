# Requirements: M8 Pain Signal → Principle Single Path Cutover

**Defined:** 2026-04-27
**Core Value:** 把痛苦信号到原则账本的端到端链路切到 Runtime v2，删除旧 diagnostician 执行链路。只保留一条诊断链路（无 fallback），M8 成功终点必须是 PrincipleTreeLedger probation entry。

## v2.7 M8 Requirements

### Legacy Code Map

- [ ] **MAP-01**: 列出所有旧诊断链路文件、函数、测试、env flag、状态文件引用
- [ ] **MAP-02**: 对每个引用标记分类：DELETE / REPLACE_WITH_RUNTIME_V2 / KEEP_NON_DIAGNOSTIC
- [ ] **MAP-03**: 不误删 sleep reflection / keyword optimization 等非诊断功能（除非它们仅服务旧诊断链路）
- [ ] **MAP-04**: Legacy map 必须先完成并确认，再动手实现

### 旧链路删除

- [ ] **DEL-01**: 不再写/读 `.state/diagnostician_tasks.json`
- [ ] **DEL-02**: 不再通过 heartbeat prompt 注入 `<diagnostician_task>`
- [ ] **DEL-03**: 不再要求 LLM 写 `.evolution_complete_*` marker 文件
- [ ] **DEL-04**: 不再要求 LLM 写 `.diagnostician_report_*.json`
- [ ] **DEL-05**: 不再由 evolution-worker 轮询 marker/report 文件判断诊断完成
- [ ] **DEL-06**: 不保留 `PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED` 等旧诊断开关
- [ ] **DEL-07**: 不删除 sleep reflection / keyword optimization / 原则注入等非诊断功能

### 单一诊断链路（无 fallback）

- [ ] **PATH-01**: pain signal → PD task/run store（SqliteTaskStore/SqliteRunStore）
- [ ] **PATH-02**: task/run store → DiagnosticianRunner.startRun()
- [ ] **PATH-03**: DiagnosticianRunner → OpenClawCliRuntimeAdapter → DiagnosticianOutputV1
- [ ] **PATH-04**: DiagnosticianOutputV1 → SqliteDiagnosticianCommitter → artifact + principle_candidate
- [ ] **PATH-05**: principle_candidate → CandidateIntakeService → PrincipleTreeLedger probation entry
- [ ] **PATH-06**: Candidate intake 是 happy path 的一部分（除非明确禁用调试）

### Pain Signal Bridge（新链路入口）

- [ ] **BRIDGE-01**: pain signal 被检测到后，创建 PD task/run 记录
- [ ] **BRIDGE-02**: runner 成功后必须产生 artifact 和 pending candidate
- [ ] **BRIDGE-03**: 自动执行 intake 生成 probation ledger entry（happy path 的一部分）
- [ ] **BRIDGE-04**: 调试模式下 intake 可禁用（不阻断链路）

### CLI 可观测

- [ ] **CLI-01**: `pd diagnose run` — 验证新链路
- [ ] **CLI-02**: `pd candidate list / show` — 验证 candidate 创建
- [ ] **CLI-03**: `pd candidate intake` — 验证 ledger entry 生成
- [ ] **CLI-04**: 新增或复用 pain trigger 验证命令，能模拟 pain signal 触发完整链路

### E2E 签收（真实 workspace）

- [ ] **E2E-01**: workspace: `D:\.openclaw\workspace`，runtime: openclaw-cli，agent: main
- [ ] **E2E-02**: 验证链路：写入 pain signal → Runtime v2 自动诊断 → artifact 创建 → candidate 创建 → intake → ledger probation entry
- [ ] **E2E-03**: 不允许只用 test-double 作为最终签收

### 删除后验证

- [ ] **VERIFY-01**: `rg "diagnostician_tasks\.json|evolution_complete_|\.diagnostician_report_|PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED|<diagnostician_task>" packages` 必须没有旧诊断执行路径残留
- [ ] **VERIFY-02**: 如果有残留引用，解释为什么不是执行路径
- [ ] **VERIFY-03**: `npm run verify:merge` 必须通过

## Non-Goals

| Feature | Reason |
|---------|--------|
| 多 runtime 适配器套件 | M8 只需要 OpenClawCliRuntimeAdapter |
| Legacy fallback | 单一链路，不做 fallback |
| 新 UI/dashboard | SDK scope 外 |
| principle promotion | 下游 milestone |
| 不删除非诊断功能 | 只删旧诊断链路相关的代码 |

## Hard Gates

| ID | Description |
|----|-------------|
| HG-1 | M8 成功终点必须是 PrincipleTreeLedger probation entry（不是 pending candidate） |
| HG-2 | Candidate intake 是 happy path 的一部分 |
| HG-3 | Legacy deletion 只针对旧诊断执行路径，不误删其他功能 |
| HG-4 | Legacy code map 必须先完成并确认，再动手实现 |
| HG-5 | E2E 签收必须用真实 workspace（D:\.openclaw\workspace） |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| MAP-01~04 | m8-01 | Pending |
| DEL-01~07 | m8-01 | Pending |
| PATH-01~06 | m8-01 | Pending |
| BRIDGE-01~04 | m8-01 | Pending |
| CLI-01~04 | m8-01 | Pending |
| E2E-01~03 | m8-01 | Pending |
| VERIFY-01~03 | m8-01 | Pending |

---
*Requirements defined: 2026-04-27*
*Last updated: 2026-04-27 after M8 milestone start*