## Owner Review Card（agent 填）

### 1. Problem
Codex / WorkBuddy deferred provisioning resume 在未证明旧 Companion-managed consumer 已 quiesce 时，可能继续 readiness 并执行 `provision_fresh_install` CAS，形成双消费者。此为 PRI-1278 Phase 5 preflight audit 的 P0。

### 2. Before
`provisionFreshInstallWorkspace()` 只有 OpenClaw Gateway running guard；Codex / WorkBuddy / `host=all` 在 scheduler enabled 后可继续 readiness，再调用 `transitionWorkspaceBackgroundExecution({ kind: 'provision_fresh_install' })`。

### 3. After
`resume === true` 且当前 host 或 pending marker host 为 `codex` / `workbuddy` / `all` 时，在 readiness 和 CAS 前 fail-closed：不 readiness、不 CAS、不改 owner marker；pending reason 为 `legacy_consumer_unproven`；`nextAction` 指向 `controlled_handover`；保留既有 pending registry/evidence 幂等恢复能力。

### 4. Existing mechanism reused
复用现有 pending registry/evidence、`recordPending()`、ownership projection reader 与 install-layout CAS authority。未新增 Scheduler、Worker Adapter、Lease 或 Handover 状态机。

### 5. Complexity Delta
* New durable source of truth: NO
* New persisted schema/state: NO
* New subsystem/service/background process: NO
* New public abstraction/interface: NO
* New runtime feature flag: NO
* New cross-package dependency: NO
* New host/platform-specific behavior: NO
* New external/network capability: NO

### 6. Verification
详见 `PRI-1278-PHASE5-P0-FIX-REPORT.md`：
- pre-fix regression：`18 tests / 6 failed`，证明旧实现会 readiness/CAS；
- pending-host bypass hardening前：`19 tests / 1 failed`；
- post-fix：`20 passed`；
- installer/host binding adjacent：`37 passed`；
- package build、test typecheck、targeted eslint：PASS。

### 7. Risk
Codex/WorkBuddy controlled handover、Companion persisted Quiesce Ack、ownership gate 和 per-workspace mutex 仍未实现，因此 deferred resume 会持续 fail-closed，直到后续严格证据协议落地。

### 8. Rollback / recovery
Backward-compatible revert；无新 runtime flag/state，无迁移。

### 9. Follow-ups
有意排除：Companion Quiesce Ack、`consumer_absent`、Codex/WorkBuddy ownership gate、per-workspace mutex、controlled handover 实现、生产 handover/scheduler 操作。

---

## 产品意图（agent 填，Owner 确认）

* 对应 Linear issue: PRI-1278（只完成 P0 safety fix，不关闭整张 Phase 5 工单）
* 解决的产品问题（一句话）: 防止未证明旧消费者退出时 deferred install 直接翻转 workspace ownership。
* 工单状态对账（AGENTS.md §21 rules 9–11）: PRI-1278 未被本 PR 实质完成；本地 Linear CLI 缺少 API key，未能执行状态动作。

### 是否触及产品边界
* [x] 否

### MVP Questions

#### `mvp-q-1-what-if-skip`
不做则 deferred install 可在 legacy consumer 仍活跃或状态未知时翻转 ownership，产生双消费者。

#### `mvp-q-2-how-observed`
blocked resume 返回 `pendingProvisioning=true`、reason `legacy_consumer_unproven`、`controlled_handover` nextAction；测试证明 manifest bytes 不变。

#### `mvp-q-3-how-disabled`
* [x] backward-compatible revert

#### `mvp-q-4-emotional-value`
* [x] N/A — internal engineering change

---

## 变更概览（agent 填）

### 变更类型
* [x] 🐛 Bug 修复
* [x] 🧪 测试
* [x] 🔒 Security / safety

### 高层变更
1. 在 deferred Codex/WorkBuddy/all resume 的 readiness/CAS 前增加 fail-closed guard。
2. 将 pending marker host 纳入 guard 输入，阻断 `none` resolution bypass。
3. 增加证红/证绿回归测试与 `PRI-1278-PHASE5-P0-FIX-REPORT.md`。

### 影响范围
* [x] installer / install-layout

---

## Verification Evidence（agent 填）

### Targeted verification

| Command / scenario | Result | Why it matters |
| ------------------ | ----------- | -------------- |
| `npm test --workspace=create-principles-disciple -- --run tests/service-host-provisioning.test.ts`（pre-fix） | FAIL（6 个预期红灯） | 证明旧实现会 readiness/CAS |
| 同一命令（post-fix） | PASS（20/20） | 门禁、pending contract、无 ownership mutation、OpenClaw 不回归 |
| `npm test --workspace=create-principles-disciple -- --run tests/host-refresh-workspace.test.ts tests/index.test.ts` | PASS（37/37） | installer/host binding adjacent semantics 不回归 |
| `npm run build --workspace=create-principles-disciple` | PASS | 生产包编译 |
| `npm run typecheck:tests --workspace=create-principles-disciple` | PASS | 测试类型门禁 |
| `npx eslint packages/create-principles-disciple/src/service-host-provisioning.ts` | PASS | 修改源码 lint |

### PD-Lab Impact（条件性，AGENTS.md §25A）
* [x] NOT_REQUIRED — 不触及 Agent 行为面：installer ownership safety guard。

### Production-path evidence
* [x] 不适用

说明：未执行真实生产 handover/scheduler/companion 操作。测试使用真实 manifest/pending registry 与生产导出函数边界，CLI 子进程为受控 fake seam。

### Merge gate
* [x] `npm run verify:merge` PASS
* [ ] 未通过，但确认是 pre-existing/environmental failure，并附证据

证据：GitHub Actions `Verify Merge Gate` PASS（3m19s）；`Test create-principles-disciple` PASS（2m29s）；`Test packaged install smoke` PASS（4m37s）；`Analyze (javascript-typescript)` / CodeQL PASS（7m29s）。本地另完成 targeted tests、package build、test typecheck、release-target-matrix 与轻量 merge gates。

---

## Error Experience / Task Risk Contract（0..N）

* Router command: `npm run error:context -- --base origin/main`
* Router result: `EP-09 HIGH, EP-12 HIGH, EP-14 HIGH, EP-06 HIGH, EP-03 MEDIUM, EP-05 MEDIUM, EP-11 LOW`
* Manual additions: `无`
* Manual exclusions: `EP-12/EP-14 中 host-path/child-process/dependency/entrypoint 项不适用；未新增这些面。`

* Pattern: `EP-09` — Why relevant: 新增 fail-closed regression tests。
  * Required evidence: negative control must fail pre-fix；production boundary；positive assertions。
  * Evidence produced: pre-fix `6 failed`、bypass hardening前 `1 failed`；post-fix `20 passed`；真实 manifest/pending registry + production exported function。
  * Result: PASS
* Pattern: `EP-03` — Why relevant: refusal needs structured reason + nextAction。
  * Evidence produced: `legacy_consumer_unproven` + `controlled_handover:` asserted in tests。
  * Result: PASS
* Pattern: `EP-06` — Why relevant: source truth/build freshness。
  * Evidence produced: source-only edit；package build PASS；pending lookup helper reused by public reader。
  * Result: PASS

## Summary

- Blocks Codex/WorkBuddy/all deferred provisioning while strict legacy-consumer quiesce evidence does not exist.
- Preserves existing pending registry/evidence and OpenClaw Gateway behavior.
- Adds regression coverage proving no readiness, no CAS, no owner-marker mutation on blocked paths.

#### Test plan

- [x] pre-fix regression evidence captured red
- [x] targeted provisioning tests green
- [x] installer/host binding adjacent tests green
- [x] package build and test typecheck green
- [ ] full `verify:merge` / CI

Generated with [Devin](https://devin.ai)
