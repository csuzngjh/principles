# PRI-1278 Phase 5 — P0 Deferred Provisioning Safety Fix Report

日期：2026-11-27
分支：`ai/PRI-1278-phase5-p0-deferred-provisioning-guard`
基线：`a7a3479c64a7aae0840ba639a74c6468ff8c1369`（实施前已确认与最新 `origin/main` 无差异）

## 1. 修复前实际调用路径

源码核实结果：

1. installer 对每个 provisioning target 顺序执行；`host=all` 不是一个原子 provisioning 操作。入口循环位于 `packages/create-principles-disciple/src/installer.ts:7165-7203`。
2. 首次安装或满足 pending resume 条件后调用 `provisionFreshInstallWorkspace()`。
3. `provisionFreshInstallWorkspace()` 的旧顺序为：ownership record refusal → binding verification → scheduler enabled guard → OpenClaw Gateway running guard → readiness probe → `transitionWorkspaceBackgroundExecution({ kind: 'provision_fresh_install' })`。
4. 旧实现只有 OpenClaw Gateway running guard；Codex / WorkBuddy deferred resume 没有任何旧消费者 quiesce 门禁。
5. 因此修复前：fresh install 留下 pending marker、workspace 无 ownership record、scheduler enabled 后 resume 时，Codex / WorkBuddy target 可以继续 readiness 并执行 `provision_fresh_install` CAS。
6. `host=all` 当前语义核实：
   - `resolveProvisioningTargets()` 将本轮 `all` 展开为 OpenClaw/Codex target；WorkBuddy 不是本轮 `all` provisioning target。
   - `resolveResumeProvisioningHost()` 在同一 workspace 同时验证到 OpenClaw+Codex binding 时可返回 `all`。
   - pending registry 中的 WorkBuddy target 会作为独立 per-workspace target resume。
   本 PR 没有改变这些语义。

## 2. 最小修复设计

修改文件：

- `packages/create-principles-disciple/src/service-host-provisioning.ts`
- `packages/create-principles-disciple/tests/service-host-provisioning.test.ts`

实现位置：`service-host-provisioning.ts:610-622`；pending entry lookup 复用同一模块内的单一 helper。

行为：

- 仅在 `resume === true` 且当前 host 或 pending marker host 为 `codex` / `workbuddy` / `all` 时触发。
- 触发后 fail-closed：
  - 不执行 readiness；
  - 不调用 `transitionWorkspaceBackgroundExecution`；
  - 不执行 ownership CAS；
  - 不修改 owner marker / manifest；
  - 写入既有 pending registry/evidence；
  - pending reason 为 `legacy_consumer_unproven`；
  - `nextAction` 以 `controlled_handover:` 开头；
  - 保持 pending provisioning 可重复 resume。
- guard 位于 OpenClaw Gateway guard 之后、readiness 之前；OpenClaw-only 现有路径未改变。
- guard 位于 scheduler-enabled guard 之后、ownership-record refusal 之后；这两项既有语义未改变。
- pending registry 的 `reason` 本来就是开放 string 字段，因此无需 schema/version 迁移，也没有建立第二套 pending 状态系统。
- guard 同时读取 pending marker host，防止“原 pending 是 Codex，但本轮 binding resolution 得到 `none`”绕过门禁。pending marker 在这里不是 ownership authority，只作为安全风险归因输入；它永远不能授权 CAS。

本 PR 明确未实现：Companion Quiesce Ack、`consumer_absent`、Codex/WorkBuddy ownership gate、新 Scheduler/Adapter/Lease/Handover 状态机。

## 3. 回归测试证红证据

测试先行，先只新增测试，未改实现。

命令：

```bash
npm test --workspace=create-principles-disciple -- --run tests/service-host-provisioning.test.ts
```

修复前结果：`18 tests / 6 failed / 12 passed`。失败覆盖：

- deferred codex + potentially active legacy consumer；
- deferred workbuddy + potentially active legacy consumer；
- deferred codex + unknown consumer status；
- deferred workbuddy + unknown consumer status；
- deferred `host=all`；
- repeated blocked resume。

关键证红事实：

- active 场景旧实现返回 `service_host_owned`，证明它执行了 provisioning；
- unknown 场景旧实现先执行 readiness，返回 readiness `failed` 而不是在 readiness 前阻断；
- `host=all` 旧实现返回 `service_host_owned`，证明可绕过 Codex/WorkBuddy 安全检查。

第二轮对抗性回归：新增“pending marker 是 Codex，但本轮 binding resolution 为 `none`”测试后，初版 guard 仍返回 `service_host_owned`（`19 tests / 1 failed`）。随后把 pending marker host 纳入 guard 输入，测试转绿。原始输出保存在工作区 `audit-artifacts/p0-red-service-host-provisioning.txt` 与 `audit-artifacts/p0-red-pending-host-bypass.txt`。

## 4. 证绿证据

最终命令：

```bash
npm test --workspace=create-principles-disciple -- --run tests/service-host-provisioning.test.ts
```

结果：`20 passed / 0 failed`。

覆盖矩阵：

| 要求 | 测试证据 | 结果 |
|---|---|---|
| Codex deferred resume + active legacy consumer 阻断 | `deferred codex resume with a potentially active legacy consumer...` | PASS |
| Codex deferred resume + unknown status 阻断 | `deferred codex resume with unknown legacy consumer status...` | PASS |
| WorkBuddy deferred resume + active legacy consumer 阻断 | `deferred workbuddy resume with a potentially active legacy consumer...` | PASS |
| WorkBuddy deferred resume + unknown status 阻断 | `deferred workbuddy resume with unknown legacy consumer status...` | PASS |
| `host=all` 不能绕过 | `deferred host=all resume cannot bypass...` | PASS |
| pending Codex 经 `none` resolution 绕过 | `a deferred Codex pending marker cannot be bypassed...` | PASS |
| OpenClaw Gateway running guard 不回归 | 既有 `resume refuses to flip while a legacy OpenClaw Gateway may still consume...` | PASS |
| OpenClaw gateway stopped 后原路径不回归 | 既有 `resume probes the VERIFIED host...` | PASS |
| Scheduler disabled 不 provision | 既有 `never hands over ownership when the scheduler is not verified enabled...` | PASS |
| 已有 ownership record 仍拒绝 | 既有 `refuses an upgrade workspace...` | PASS |
| 非 deferred fresh install 行为不变 | `a non-deferred Codex fresh install keeps...` | PASS |
| pending reason / nextAction / JSON contract | 各阻断测试断言 `legacy_consumer_unproven` + `controlled_handover` | PASS |
| repeated resume 不翻转 ownership | `repeating a blocked deferred resume is idempotent...` | PASS |
| 阻断路径无 CAS / owner-marker mutation | 阻断测试断言 manifest bytes before/after 完全相等，且 ownership projection 保持 `legacy_owned/no_record/generation 0` | PASS |

相关 installer/host-binding 回归：

```bash
npm test --workspace=create-principles-disciple -- --run tests/host-refresh-workspace.test.ts tests/index.test.ts
```

结果：`37 passed / 0 failed`。

## 5. Build / typecheck / lint

已执行：

```bash
npm run build --workspace=create-principles-disciple
npm run typecheck:tests --workspace=create-principles-disciple
npx eslint packages/create-principles-disciple/src/service-host-provisioning.ts
```

结果：均 PASS（eslint 无输出）。测试文件按仓库现有 eslint ignore 规则不属于 eslint 检查范围，但已显式执行 `typecheck:tests`。

未运行完整 `npm run verify:merge`：该门禁包含全仓构建、网站、release、artifact 等多项长耗时检查；本 PR 范围是 installer provisioning 的窄安全修复，已运行直接受影响包 build/typecheck/targeted tests。CI 结果需以 PR checks 为准。

## 6. ownership CAS 未发生的验证证据

测试不是只断言“没有 success”：

1. 每个阻断场景在调用前读取 `install.json` 原始 bytes；
2. 调用后再次读取并断言字符串完全相等；
3. 同时通过 `readWorkspaceBackgroundOwnership()` 断言投影仍为 `{ status: 'legacy_owned', source: 'no_record', generation: 0 }`；
4. fake CLI calls 断言没有任何 worker readiness 或 `service run-once` 调用；
5. `firstCycle` 结构化结果为 `{ attempted: false, reason: 'legacy_consumer_unproven' }`；
6. 因 guard 在 `transitionWorkspaceBackgroundExecution()` 之前直接返回，阻断路径不存在 CAS 调用点。

## 7. 并发 resume 复核

- 本 PR 在 readiness/CAS 前 fail-closed，因此 Codex/WorkBuddy/all deferred resume 的并发调用不会到达 ownership CAS。
- 既有 ownership CAS 原语仍有 generation fencing；本 PR 未改变该机制。
- pending registry/evidence 沿用既有 atomic temp-file/rename 写入；重复 resume 测试证明语义幂等且不会意外翻转 ownership。
- 新增 `concurrent blocked deferred resumes never race into an ownership write`：两个并发 resume 均阻断，manifest bytes 不变，ownership 仍为 no-record。
- 未新增跨进程锁；这是有意排除，因为本 PR 不建立新 pending/lease 基础设施。

## 8. Error Context 路由

实施前路由命中 EP-06/EP-12/EP-14 HIGH 与 EP-09 MEDIUM；diff 路由命中 EP-09/EP-12/EP-14/EP-06 HIGH、EP-03/EP-05 MEDIUM、EP-11 LOW。

适用处置：

- EP-09：已包含 pre-fix negative control；测试断言生产模块的真实导出函数、真实 manifest/pending registry，不做 source-string scan。
- EP-03：拒绝路径带结构化 `reason` 与 actionable `nextAction`。
- EP-06：只编辑源文件，未补丁生成物；`create-principles-disciple` 已重新 build。
- EP-12/EP-14：未新增 host-managed path 写入、child process、dependency、entrypoint 或跨包 contract；不适用项未当作通过证据。

## 9. OpenClaw 回归验证

既有 OpenClaw 测试全部保持绿色：

- Gateway running 时仍记录 `legacy_consumer_running`，不 readiness、不 CAS；
- Gateway not running 时仍执行 readiness 并可完成 provisioning；
- `--readiness` probe 不传 `--pd-home`、使用 trusted HOME 的契约未改变。

`host=all` 仍会先执行 OpenClaw Gateway probe；Gateway not running 后再因 Codex/WorkBuddy strict quiesce evidence 不存在而 fail-closed。这是本 PR 有意改变的安全行为。

## 10. 未解决风险 / 排除项

1. Codex/WorkBuddy controlled handover 本身仍未实现；`nextAction` 指向方向，不表示当前 `pd service handover` 已支持这两个 host。
2. Companion persisted Quiesce Ack 不存在，因此 deferred Codex/WorkBuddy resume 目前必须一直阻断。
3. `consumer_absent` 例外未获 Owner 批准，本 PR 未实现。
4. Codex/WorkBuddy worker ownership gate / per-workspace mutex 仍缺失；首次 fresh install 语义未改变。
5. rollback 后 legacy consumer 是否真正恢复仍无证明机制。
6. 本报告不声称真实生产 handover/scheduler/companion 已验收；未执行任何生产操作。

## 11. 下一阶段建议

建议下一个小 PR：设计并实现 Companion persisted strict Quiesce Ack 的最小证据协议，先补 Codex/WorkBuddy worker ownership gate / per-workspace mutex 的事实核查与测试矩阵，再由 Owner 决定是否允许任何 narrow `consumer_absent` 例外。不要在未验证 Ack 前放宽本 PR 的 fail-closed guard。
