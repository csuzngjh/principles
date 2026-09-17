# PRI-807 / PRI-828 — Safety Net v1.2 Reuse Matrix（Phase A 只读调查产物）

- 基线：`45e115363a8ac1aed30a42f0c027ca07032af791`（= SPEC handoff SHA，无漂移）
- 输入：`docs/audit/pri-807-phase0/`（Worker A–F + RED_TEAM + SYNTHESIS，Worker 基线 cdec05d4 + FINAL_MAIN 28e1de74 对账）+ 当前 main 三路只读核查（J1/J2/J4 资产、授权语义、CI/vitest 配置）
- 判定口径：`REUSE`（原样接入）/ `EXTEND`（在现有测试/生产边界上补断言）/ `NEW_MINIMAL`（真正缺失，最小新增）/ `DO_NOT_BUILD`（明确不做）

---

## 1. 不变量 → 资产映射

### C0 — Safety Net 必须真的被执行

| 资产 | 判定 | 说明 |
|---|---|---|
| `verify:merge`（root package.json:50，16 步） | **EXTEND** | 已有唯一被点名执行的测试先例：`npm test --workspace=create-principles-disciple -- --run tests/release-target-matrix.test.ts`。在其后追加 `check:pipeline-contract` 即获得 PR-time 保证（CI `verify-merge` job ci.yml:88-113 执行 `npm run verify:merge`） |
| `scripts/acceptance-gate-rulehost.mjs:1144` 的 `execFileSync(process.execPath, [root/vitest.mjs, 'run', file], { cwd: package })` | **REUSE** | 直接复用该跨包调用 vitest 的模式实现薄命令 |
| 审计 NEW-F1（6 个永不执行测试文件） | **DO_NOT_BUILD（本轮）** | 均不在本 Safety Net 选择集内；属已知独立缺口，登记为 follow-up，不顺手改 include 口径 |

**机械发现性证明（复评修正）**：薄命令以显式 filter 驱动各包 Vitest，并读取本次 runner 的临时 JSON report，逐文件检查实际执行的 assertion。文件存在并不等于执行；全组未收集、组内部分未收集、report 缺失/非法均为 C0 FAIL。普通 assertion failure 可为 C0 PASS，但对应 invariant/Journey FAIL。全量/部分漏收集与真实 writer 断言失败均经正式命令注入验证，见 FAULT_INJECTION.md 复评补验。

### INV-01 — 正式输入 → production formation → 可治理 Principle

| 资产 | 判定 | 说明 |
|---|---|---|
| `openclaw-plugin/tests/integration/rulehost-seed-mvp-e2e.test.ts` | **REUSE** | 唯一单文件全链：正式 pain 事件（`trajectory.recordPainEvent`，L508-517）→ 真实 `BehaviorExamplePackAssembler`（L520）→ 真实 5-runner formation + 真实 validator（L644-719）→ 可治理 v2 artifact（evidenceRefs 血缘保留，L741-753）→ 真实审批/dispatcher/RuleHostWriter → shadow → promote → live block → 停用。唯一 mock 是 ScriptedAdapter（LLM）。120s timeout |
| `openclaw-plugin/tests/integration/pain-id-chain-e2e.test.ts` | **REUSE** | prompt 通道：真实 pain AUTOINCREMENT id → `createPrincipleFromDiagnosis` → ledger `derivedFromPainIds` → `PrincipleCompiler.compileOne` → 激活 → RuleHost block（reason 含 principleId）+ 非匹配放行（正对照） |
| `principles-core/.../internalization/__tests__/diag-chain-e2e.test.ts` | **REUSE** | pain 信号 → split diagnostician router→rootcause→distiller + schema 校验（诊断段） |
| `.../internalization/__tests__/mvp-core-loop-journeys.test.ts` | **REUSE** | Journey 5–8：needs_revision 修复重开 / 级联 / repair 耗尽 / rollout 批准自动派发（治理修复段，从预置 task 起） |

SPEC 禁止的锁死（Dreamer/Philosopher/Scribe 数量、三 artifact 等）：以上测试断言的是 value chain，不断言 stage 数量。`c2-live-runner-chain.test.ts` 锁拓扑 → **不选入** Safety Net（属 S1 拓扑保护，v1.2 明确不冻结）。

### INV-02 — 身份/血缘不可猜测

| 资产 | 判定 | 说明 |
|---|---|---|
| rulehost-seed 的 evidenceRefs↔pack 断言（L741-753）+ pain-id-chain 的 pain id→derivedFromPainIds→ruleId 链 | **REUSE** | 覆盖 pain 命名空间→内部 UUID 的 bridge 可核验性（两命名空间不强行统一） |
| `chain-integrity-real-path.test.ts`、`peer-runner-lineage-injection.test.ts`、`candidate-lineage.*` | **REUSE（可选后补）** | 真实 store 血缘回声/完整性；本轮以 J 链为主证明，不强制全选 |

### INV-03 — 授权边界（owner vs system_policy；观察≠授权）

| 资产 | 判定 | 说明 |
|---|---|---|
| `rulecode-owner-decision-service.test.ts`（10 test） | **REUSE** | promote_live 必须 configured_owner + console_token/cli_owner_credential；dry-run 不落库；blocked/unavailable readiness 拒绝 |
| `sqlite-activation-safety-store.test.ts` | **REUSE** | store 层同权限复检（:321-325）+ break_glass 只能紧急停用不能 reject_after_shadow |
| `promotion-readiness-evaluator.test.ts` | **REUSE** | 观察不产生授权：不足 24h/20 评/3 命中/无中性对照 → evidence_insufficient；缺失检查 → unavailable；unhealthy → 不可覆盖的 blocked |
| `approval-completion-service.test.ts`（security boundary 段） | **REUSE** | 无 approvalId/不存在/仍 pending/artifact mismatch/channel mismatch 全负例 |
| `runtime-v2-prompt-activation.test.ts` 的 `deriveAuthority` 边界 | **EXTEND** | 审计确认：owner 分支从未在边界层被真实 approvals join 驱动过（现有注入用例无 approvals 行，实际推导为 system_policy，断言只查属性存在）。补：种 approvals 行 → `authority=owner`；无 approvals 行 → 断言值恰为 `system_policy`（不得冒充 owner） |
| auto-promote 通道（skill ≥0.95） | **REUSE（已覆盖于 approval-queue/dispatcher 测试）** | 低风险通道测试在 `low-risk-writers.test.ts` 等 |

### INV-04 — 治理不分叉/不重复增权/恢复不增权

| 资产 | 判定 | 说明 |
|---|---|---|
| `sqlite-activation-safety-store.test.ts` | **REUSE** | stale control version 双向回滚（:138/:202）、lineage mismatch（:150）、supersede（:217）、事务回滚（:336）、**recovery 只回到 shadow**（:325）、全局 latch 释放不复活隔离（:249） |
| `activation-dispatcher.test.ts` | **REUSE** | F9-3 idempotency_artifact_mismatch + already_activated |
| `story-a-acceptance.test.ts` | **REUSE** | 六步链×2 通道 + owner reject 负例 + 幂等 + rollback + 血缘一致 + malformed JSON |
| `rule-host-writer.test.ts` | **REUSE** | shadow-first、审批后绝不直接 live |
| `commitPromotion` 重放幂等（store :341-350 实现） | **DO_NOT_BUILD（本轮新测试）** | 已有 supersede+事务回滚保护语义主干；重放二次提交属增强，非 v1.2 必需 |

### INV-05 — 到达真实 runtime consumer 边界

| 资产 | 判定 | 说明 |
|---|---|---|
| `tests/hooks/gate-rule-host-real-pipeline.test.ts` | **REUSE** | 真实 SQLite activation → 真实 `handleBeforeToolCall`（生产 hook） |
| `tests/hooks/gate-rule-host-pipeline.test.ts` | **REUSE** | 断言 consumer 可见 `result?.blockReason`（FI-4 锚点） |
| `tests/hooks/runtime-v2-prompt-triple-proof.test.ts` | **REUSE** | prompt 生产边界三重证明（DB 记录+会话绑定注入事件+行为改变）+ 停用移除 + 进程重启恢复 |
| `tests/hooks/runtime-v2-prompt-activation.test.ts` | **REUSE+EXTEND** | 注入/未激活/非 prompt 通道/已停用/悬空 artifact/malformed 全负例 |
| `codex-adapter/tests/pd-hook.production.test.ts`（spawn 真实 dist） | **DO_NOT_BUILD（本轮不选）** | 需要构建 dist 且面向 Codex 宿主面；v1.2 merge-time 不要求多宿主 parity 全覆盖（SPEC §19） |

### INV-06 — 精确撤销

| 资产 | 判定 | 说明 |
|---|---|---|
| `tests/core/rule-host-cache-invalidation.test.ts` | **REUSE+EXTEND** | 已有：同一存活实例 deactivate 后不再拦截（ERR-079 回归）、promote 缓存失效、artifact 内容变更失效。**缺 A/B 精确性**：无任何测试断言撤销 A 时 B 仍有效 → EXTEND 补双规则 A/B 用例 |
| `runtime-v2-prompt-triple-proof.test.ts` L180-197 | **REUSE** | prompt 侧同一 reader 停用后移除 |

### C5 — Current Content Authorization（最关键负例）

生产事实（核查确认）：`sqlite-pi-artifact-store.ts:75-102` `ON CONFLICT(source_task_id, artifact_kind) DO UPDATE SET artifact_id = excluded.artifact_id, content_json = …` —— 重跑/重试轮会回收 instance id。

| 场景 | 现有保护 | 判定 |
|---|---|---|
| artifact_id 变更（新 run）→ 旧授权悬空 | prompt：`artifact_not_found` fail-safe 已测（runtime-v2-prompt-activation:376）；RuleCode：digest 钉死 + promotion evidence binding mismatch | **EXTEND**：补一条"已激活 → 真实 upsert 回收 id → 旧 activation 不得注入新内容"的端到端负例（当前两段各自有测，未链到真实 upsert） |
| 同 artifact_id 内容被替换 | 仅理论可达（同 task+run 内二次 upsert 不同内容；正常流不产生）。prompt 通道无 digest 钉死 | **DO_NOT_BUILD（修复）**：加 digest schema 属 SPEC §16 明确禁止的本轮范围；如实登记为 KNOWN_GAP 之外的 current 局限，如测试证明实际可静默生效再升级为 defect 单独处理 |

### KNOWN_EVIDENCE_GAPS（只报告）

- approved historical artifact digest / executed historical artifact digest / exact Principle historical revision digest —— 不加 schema、不回填（SPEC §16）。

---

## 2. 汇总

```text
REUSE        = 16 项现有测试资产（上文标 REUSE）
EXTEND       = 3  处（deriveAuthority 边界断言 / A/B 精确撤销 / artifact 回收 fail-safe 负例）
NEW_MINIMAL  = 1  个（scripts/check-pipeline-contract.mjs 薄命令 + verify:merge/CI 接线）
DO_NOT_BUILD = test registry / writer registry / scanner / mutation framework /
               J3 / digest schema migration / 6 个孤儿测试文件的 include 修复（follow-up）/
               Codex parity 面 / 拓扑冻结类测试（c2-live-runner-chain 不选入）
```

## 3. Phase 0 审计缺口与本轮关系（对照）

| Phase 0 Top 缺口 | 本轮处置 |
|---|---|
| #1 prompt 示例↔validator 零对拍（NEW-F3, P1） | 不在 v1.2 六不变量内（SPEC §19 非 goal）；follow-up 候选 |
| #2 血缘字段名静默丢 dreamerContext（NEW-F4, P1） | 同上，follow-up 候选 |
| #3 Stage C 缓存可 parse 非法（NEW-F2, P1） | 同上 |
| #5 verify:merge 不含 vitest（P1） | **本轮修**（C0） |
| #6 J1 端到端不存在（P1） | **本轮以既有资产组合覆盖**（rulehost-seed + pain-id-chain + triple-proof 串成 J1，formation 段真实 pain 入口） |
| #7 R-19 拼接逃逸（P1） | 已由 PRI-809 修复（DONE），不再本轮范围 |
| #10 六文件永不执行（P2） | 登记follow-up；选择集不含它们 |
