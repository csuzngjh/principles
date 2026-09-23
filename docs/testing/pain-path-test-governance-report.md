# PD Pain 路径测试治理报告（Test Diet Phase 2-A Governance Report）

> 日期：2026-09-21 · 基线 commit：`e91ad97a` · 性质：**只读调查，未修改任何测试/源码/fixture/CI，未创建 PR**
> 配套清单：`docs/testing/pain-path-test-inventory.md`（逐文件 inventory）
> 目标回顾：**不是减少测试数量，而是找出真正保护 PD 学习闭环的测试资产。**

---

# Owner Review Card（简版）

1. **Problem**：Test Diet Phase 2 启动前，不知道 ~1,045 个测试文件中哪些真正保护 Pain→Principle→Behavior Change 闭环、哪些是重复/实现细节/已死资产。
2. **Before**：只有 Phase 1 的总量考古（规模/Temp 污染/时间分布），没有按业务闭环的分段保护图。
3. **After**（本调查产出）：闭环八段保护强度图 + ≈520 个 Pain 路径相关文件的逐文件分类 + 4 组 Keep 名单 / 3 组 Cleanup 候选 / Mock 风险表 / Phase 2.1–2.3 实施建议。**未改任何代码。**
4. **Existing mechanism reused**：无（纯调查；报告文件落在 `docs/testing/` 与 Phase 1 同目录）。
5. **Complexity Delta**：全部 NO——仅新增两个未跟踪的 markdown 报告。
6. **Design reason**：调查先行，防止 Phase 2 实施误删保护性资产。
7. **Verification**：所有关键断言（Gate A 零生产引用、decideAutoPromotion 零调用、CI 无 LLM_E2E_ENABLED、skip/todo 清单、git 考古）均经主会话二次核验，证据在正文。
8. **Risk**：分类基于静态阅读与用例名抽样精读，个别文件的 Stage/价值判断可能有偏差——Cleanup 候选在实施前仍需逐文件复核。
9. **Rollback**：无变更，无需回滚。
10. **Follow-ups**：见 §8 Phase 2.1–2.3。

---

# 1. Executive Summary

**1) Pain 测试规模**：全仓 ~1,045 个测试文件中，**≈520 个（约 50%）与 Pain 闭环相关**，估计 ≈9,000+ 用例。分布：principles-core ≈330（其中 internalization 一个目录 74 文件/≈1,149 用例为最厚段）、openclaw-plugin ≈75、pd-console ≈60、pd-cli ≈55、host-runtime ≈9。文件名直接含 `pain` 的 51 文件/≈773 用例。

**2) 覆盖哪些闭环**：**闭环的每一段都有测试，但没有一个测试走完整条闭环。**
- **保护最强段：Approval→Activation**。"无 Owner 批准不得激活"这一核心不变量由 **8 个互相独立的测试家族**守住（activation-dispatcher〔PRI-811 权威〕、approval-completion-service 安全边界、story-a-acceptance、mvp-core-loop-journeys J7/J8、restart-safety、owner-override-resume、internalization-transition-decision、verdict-drift），且 core activation 测试区**零 vi.mock、真实 SQLite**——这是全仓测试健康度最高的区域。
- **保护良好段：Pain-Ingress / Pain-Gate / Diagnosis**。单一语义权威 `evaluatePainIngress` 有"函数身份级"防漂移断言（host-runtime 测试断言 `toBe(core fn)`）；真实 SQLite 往返（golden-path-diagnostician-e2e、pain-diagnosis-persistence、pain-ingress-persistence）与 fail-closed 准入门（admission-gate、trigger-controller）齐备。
- **保护最弱段：Observation（行为变化观察）与"全链缝合"**。shadow→promote→observation 的后半链没有任何无 mock 测试；Owner 批准后的行为变化观察只在 story-a 的 observe-list 一笔带过。最接近全链的三个测试各缺一环：cross-package-acceptance（pain 直接种子注入+脚本化 LLM+绕过 Owner 决策服务走底层晋阶）、story-a-acceptance（无 shadow→promote 段）、console e2e（全部从种子 fixture 起步，从未在 UI 里走过 pain 创建）。**真实 LLM 层（4 个 real-llm 套件）因 CI 从不设置 `LLM_E2E_ENABLED` 而整体死亡。**

**3) 最大重复区域**：
- **Gate A 遗骸三重测试**：已废弃模块（`pain-diagnostic-gate.ts`，模块头自述零生产引用）仍被 615 行主测试 + auto-entry-gate 副本 + core policy 正主测试三面覆盖，另有两个 static-guard 盯着它的退休状态；
- **Internalization 模板族**：3 个 diag runner 测试近同构、6+ 个 prompt-builder 测试互抄样板断言、3 个 peer-runner vslice 重复同一脚手架套件、job-graph 拓扑三处钉、retry_wait 状态机规则三文件钉；
- **跨包拷贝**：pd-cli 与 pd-console 的 shadow-telemetry 双目录测试为逐字近拷贝；evidence-sanitizer 与 feedback/redact-sensitive 两模块各自实现并各自测试同一批脱敏模式；
- **命名失真**：activation-dispatcher 内有两个字节级相同的测试体；plugin 有两个同名 `internalization-auto-consumer-service.test.ts` 分居两目录。

**4) 最大风险区域**：
- **CLI 层"无审批激活"不可见**：pd-cli `runtime-activation.test.ts` 把审批队列/激活存储全部 mock 成预置 `approved`——该层若出现绕审批回归，测试全绿（仅靠 core 层测试兜底）；
- **诊断 runner 测试连验证器一起 stub**：core 三个 `diag-*-runner.test.ts` 把 `_validator.validate` stub 成恒 valid，"畸形 LLM 输出被 schema 拒绝"这条真实防线在 runner 层是假的（schema 本体在 diagnostician-output-schema 有真实 TypeBox 测试）；
- **名实不符**：`sqlite-connection-readonly.test.ts`（只读零副作用）全靠 mock better-sqlite3+fs；`internalization-consumer-product-path.test.ts` 全 mock 却自称 product-path；`pain-pipeline-roundtrip.test.ts` 名为 roundtrip 实为源码 grep；
- **BDD 空转**：21 个 `.feature` 只有 1 个有可执行 step 绑定；codex-governance 三个 feature 完全无绑定；
- **旗舰缺口**：mainline-product-path（产品路径旗舰测试）含 3 个 `it.todo`（真实 pain 行过诊断器、候选血缘、配置 parity），注释自述等收敛工作落地。

---

# 2. Current Coverage Map（闭环分段保护图）

```
Pain 创建/Ingress        ████████░░  强    ≈40 文件
  hook 采集/CLI 手动/Owner 修正 → evaluatePainIngress 单一权威（submit/degrade/refuse/observation_only）
  真实路径：pain-ingress-persistence(真 SQLite) · host-runtime pain-evidence-ingress(身份断言)
  弱点：pd-cli pain-record mock 掉 recordPain 本体；plugin hooks 层 fs/服务 mock 密集
        │
Pain Gate / Admission    ████████░░  强    ≈16 文件
  Gate B(trigger-controller)为唯一现役门；admission-gate fail-closed 矩阵；冷却/洪峰
  弱点：Gate A 尸体仍被三重测试；冷却逻辑四处分散测试
        │
Diagnosis                ███████░░░  中强  ≈50 文件
  真实路径：golden-path-diagnostician-e2e · pain-diagnosis-persistence · pri638 能力禁用 characterization
  schema：diagnostician-output-schema(真实 TypeBox) · 三段 validator 各自单测
  弱点：runner 层验证器被 stub 恒 valid；store/pain-diagnosis 无专属测试；停启/重试语义散落
        │
Candidate (pain→principle) ██████░░░  中    ≈15 文件
  intake 幂等/试用期账本/机械证据降级/committer 原子事务；strip-fabricated-ids 防伪造
  弱点：candidate-intake-service 6 个 vi.fn；bridge 家族 fake-SM 与真实库版本部分重叠
        │
Internalization          █████████░  极厚(重复多)  ≈105 文件
  状态机/租约/工件链/修复环/对抗重放/中文反馈全有；真实 SQLite 集成测试成体系
  弱点：模板族重复严重；evaluator v1/v2 双版本并存；consumer-product-path 命名失真
        │
Owner Approval           ████████░░  强    ≈35 文件
  PRI-811 后审批为唯一入口；owner-decision 单一架构有静态守卫；console 审批 API 1520 行套件
  弱点：approval-queue.test 保护死路径 decideAutoPromotion；SQLite 审批 edit 错误分支无覆盖
        │
Activation / Promotion   ████████░░  强    ≈60 文件
  shadow-first/原子晋阶(触发器注入回滚)/晋阶就绪硬检查/Owner 决策服务拒绝矩阵/沙箱门
  弱点：CLI 层 mock 失明(见 Mock Risk)；rule-host-writer gateDeps 多数 stub
        │
Observation / Correction ██████░░░░  中    ≈55 文件
  回执/账本对账/轨迹定位/GFI/治理观察存储/修正学习(TP≥3/0FP)齐备
  弱点：shadow→promote 之后的"行为变化"观察极薄；pain-chain-read-model 靠 mock SQL
        │
        ▼ （闭环回到 Pain）
全链缝合                ███░░░░░░░  弱
  无任何单测试走完 Pain→…→Observation；真实 LLM 层 CI 死；console e2e 从种子起步
```

各段"测试类型构成"：Pain/Gate/Diagnosis 以 unit+integration 为主；Internalization unit 占绝对多数（integration 12 个、real-llm 4 个 env 门控）；Approval/Activation 在 core 层 integration 密度高；E2E 仅 console 10 个 + plugin 若干 + pd-cli cross-package 1 个；BDD 可执行绑定 1 个。

---

# 3. Keep Candidates（A 类：Core Contract，必须保留）

**闭环不变量守卫（最高优先级，删任何一个都是安全边界倒退）：**

| 测试 | 保护的不变量 |
|---|---|
| core activation/`activation-dispatcher.test.ts` | PRI-811：任何 rollout 推荐只入队；激活必须 Owner approve + verified approvalId |
| core activation/`approval-completion-service.test.ts` | pending/rejected 永不激活；假/错配 approvalId 拒绝（安全边界） |
| core activation/`story-a-acceptance.test.ts` | PRI-408 生产闭环 approve→activate→observe→rollback；reject/畸形零激活 |
| core internalization/`mvp-core-loop-journeys.test.ts` | J7/J8：approve_rollout ⇒ 1 pending、0 activation；needs_revision 不可绕过 |
| core internalization/`restart-safety.e2e.test.ts` | worker 崩溃重启后审批/激活零重复 |
| core internalization/`owner-override-resume.test.ts` | Owner accept 高危路径也只入队（INV-08） |
| core internalization/`verdict-drift-regressions.test.ts` | 终态后 LLM verdict 不可漂移（含激活后） |
| core activation/`rulecode-owner-decision-service.test.ts` | Owner 晋阶权威全拒绝矩阵（flag/safety/break-glass/无备注/readiness） |
| core activation/`sqlite-activation-safety-store.test.ts` | shadow→live 原子晋阶+回滚（触发器注入证明） |
| core activation/writers/`rule-host-writer.test.ts` | shadow-first：writer 永不直接返回 live |
| core internalization/`rule-activation-contract.test.ts` | evaluator 工件契约 ↔ RuleHostWriter.canActivate 反漂移 parity |
| core internalization/`owner-decision-review.test.ts` | 对抗硬门失败时 Owner 不可 accept |
| core internalization/`evaluator-gate-authority.test.ts` | code-bearing+approved 必过确定性沙箱门 |

**Pain 入口/门/诊断真实路径：**

| 测试 | 保护的行为 |
|---|---|
| host-runtime/`pain-evidence-ingress.test.ts` | SPEC §8.2 全矩阵 + 单权威身份断言 |
| core `pain-ingress-persistence` / `pain-ingress-shared-semantics` / `pain-evidence-contract` | 入口语义唯一权威 + 持久化不变量 T1–T7 |
| core `admission-gate.test.ts` | 置信/证据/provenance fail-closed（0.49/0.50/0.51 边界） |
| core `golden-path-diagnostician-e2e.test.ts` | onPainDetected→assemble 真实 SQLite 往返（PRI-357） |
| core `pain-diagnosis-persistence.test.ts` | 诊断落库幂等/降级可观测 |
| core `diagnostician-output-schema.test.ts` | 诊断输出 schema 真实 TypeBox 校验（本报告认定的 schema 真防线） |
| core `evidence-triage/trigger-controller.test.ts` | Gate B 现役准入（Owner 手动绕过冷却等） |
| core `attack-e2e-pipeline-smoke.test.ts` | ATTACK-1..15 畸形 LLM 输出全管线 fail-loud |
| core `pri638-diagnostician-capability-characterization.test.ts` | 诊断器禁用/恢复不丢任务 |

**链路与观察：**

| 测试 | 保护的行为 |
|---|---|
| plugin `pain-id-chain-e2e.test.ts` | 包内全链：pain→principle→compile→拦截（源 #338 bug） |
| pd-cli `cross-package-acceptance.test.ts` | 跨包链（当前最接近全链的测试） |
| core `chain-integrity-real-path` + `internalization-integrity-remediation` | 工件断链检测+修复（真实 SQLite） |
| core `pain-signal-observability.test.ts` | 跨包 DDL 同步唯一守卫（PRI-788 G2） |
| plugin `runtime-v2-prompt-activation` + `runtime-v2-prompt-triple-proof` | Owner 批准→prompt 注入/回滚/三重证明 |
| plugin `service/earned-high-demotion-roundtrip` + `governance-signal-admission`（host-runtime） | 修正学习 TP 晋升/FP 降级真实往返；STRONG 修正高精度准入 |
| core `evidence-chain-contract.test.ts` | task-id 归一/CJK 去重（PRI-385 P1 回归） |
| core `task-three-strikes` / `dreamer-source-pain-provenance`(PRI-862) / `pain-correction-evidence`(PRI-844) | 内化纪律与 Pain 血缘诚实性 |
| core `tests/bdd/story-a.steps.ts` | 唯一可执行 BDD 绑定 |

**B 类（Behavior Regression，保留，bug 来源已考据）**：activation-dispatcher（PRI-144→PRI-811，12 commits）、pain-id-chain-e2e（#338，2026-04-16）、verdict-drift（P0，2026-08-19）、evidence-chain-contract（PRI-385 CJK）、chain-integrity（PRI-209）、evaluator-gate-authority/repair-replay（PRI-634）、restart-safety、evaluator-chinese-feedback（PRI-714）、receipt-runid-binding（PRI-750）、rulecode-replay-live-parity（PRI-809）、task CAS（PRI-629）、activation-re-dispatch（Bug-Q）、pd-cli nextaction（bug #1367）、console focus-approve-flow（静默通过 bug，已修复并注释在案）、approvals-nextaction（PRI-438）、runtime-v2-activations-injected-pairing（PRI-537）等 —— **这些测试的名字里携带工单号/bug 号，是活着的机构记忆，全部保留。**

---

# 4. Cleanup Candidates（候选优化，不直接实施）

## 4.1 D 类：Duplicate Coverage（合并/收敛候选）

| Tests | Same Behavior | Recommendation |
|---|---|---|
| plugin `tests/core/pain-diagnostic-gate.test.ts`(615行) + `tests/integration/auto-entry-gate.test.ts` + core `pain-gate/__tests__/pain-diagnostic-gate-policy.test.ts` | Gate A 准入阈值/冷却/episodeKey——被测模块**零生产引用**（模块头自述，PRI-454/763 废弃） | **首选清理**：随 Gate A 模块本体退休（模块头注明这是独立 Owner 决策）一并删除插件侧两文件；core policy 正主测试保留 |
| core `pain-signal-runtime-factory-edge-cases` ↔ `runtime-config-boundary` | validateRuntimeConfig 接受/拒绝矩阵近逐字重复 | 合并为一处（保留 runtime-config-boundary，factory 文件只留能力缺失用例） |
| core `evidence-triage/source-descriptors` ↔ `triage-policy` | 13 描述符注册表两处全量断言 | triage-policy 保留行为面；source-descriptors 收缩为"注册表完整性"单测 |
| core `task-state-semantics` ↔ `pain-signal-bridge-execute-pending` ↔ `production-canary-fixture-gate`(retry_wait 段) | retry_wait 就绪规则三文件两层钉 | 保留 task-state-semantics（纯语义层）+ canary（真实库层）；bridge 文件删 retry_wait 重复段 |
| core `chain-integrity-attack` ↔ `chain-integrity-real-path` | 同一断链分类学，场景标题逐字相同 | 保留 real-path；attack 版收缩为仅攻击向量（prototype pollution 等）独有用例 |
| core `dreamer-output-validator` ↔ `dreamer-runner-vslice`(validator describe) | 候选边界校验两层重复 | 保留 validator 单测；runner 里只留"validator 拒绝→output_invalid 路径"一例 |
| core `evidence-sanitizer` ↔ `feedback/redact-sensitive` | 同批 token/路径脱敏模式两个模块各自测试 | **先并实现再并测试**（实现层重复是真问题）；短期标注互引 |
| core `build-golden-trace-from-artificer` ↔ `golden-trace` | 正负例必备+结构合法重复 | golden-trace 保 schema；builder 只留组装逻辑 |
| core `operator-health-gfi-degraded` ↔ `production-canary-fixture-gate`(GFI 段) | 陈旧低 GFI 不降级 | 保留 canary（真实库）；read-model 版收缩 |
| core `story-a-demo` ↔ `proven-channel-baseline` | 3 MVP 通道集两处钉 | 合并到 proven-channel-baseline |
| pd-cli `runtime-activation-shadow-telemetry` ↔ pd-console `activations-shadow-telemetry` | 双目录遥测合并（标题近拷贝跨包） | 提炼共享逻辑后各留一层薄断言，或一处为主另一处标注引用 |
| plugin `hooks/triage-adapter` ↔ `raw-observation-adapter` ↔ `hooks/pain`(源分类块) | resolveSourceKind 三处测 | pain.test 中的迁移遗留块删除（自带注释承认）；两 adapter 合一 |
| plugin 两处 `internalization-auto-consumer-service.test.ts` + `internalization-auto-consumer-gate.test.ts` | 同一服务/flag 三文件 | 合并为 tests/service 单处 |
| plugin `hooks/pain.test.ts` ↔ `integration/auto-entry-gate.test.ts` | mockWctx 脚手架+同场景 | auto-entry-gate 删除（见 4.1 首行） |
| core internalization 3×`diag-*-runner` 模板族 / 6×prompt-builder 样板 / 3×peer-runner 脚手架 | 同构断言复制 | 参数化共享测试收编（一次重构，~80 用例缩为 ~25） |
| core activation-dispatcher 内两个字节级相同测试体 | intra-file 拷贝 | 删其一（最安全的单项清理） |
| pd-console e2e `focus-approve-flow` ↔ integration `governance-approve-activation` | e2e 复验 integration 已覆盖行为 | e2e 只保留"页面无 5xx/渲染"增量价值，API 断言交回 integration |
| `principle-tree-ledger.atomic-write` ↔ `.atomic-write-security` | 无残留临时文件/锁 | 合并（PRI-459 与 PRI-1179 两代同题） |
| feature-flags 12 文件模板 | 每 flag 注册/分类/默认值重复 | 收编进 registry 级 contract 测试 + 单 flag 差异行 |

## 4.2 C 类：Implementation Detail（REVIEW 标记）

| 文件 | 问题 | 建议 |
|---|---|---|
| core `schema-version.test.ts` | 钉死字面量 "1.0.0" | REVIEW：改为类型/schema parity 断言 |
| core `pain-evidence-contract.test.ts:344-351` | 钉死 MAX_EVIDENCE_ENTRIES=8 等常量 | REVIEW：常量变更即红，属脆断言 |
| core `v2-adversarial-cases` | "恰好 5 个"数量钉死 | REVIEW：改为 ≥5+canonical 校验 |
| pd-cli 5×`runtime-activation-*-flag-wiring` | 断言 Commander 选项注册 | REVIEW：并为一个 CLI 注册契约测试 |
| pd-console `ui/principle-review.test.ts` | "文件存在且非空/调用了某 API"源码扫描 | REVIEW：改为渲染行为测试或删除 |
| core activation `sqlite-activation-state-store` | 断言 SQL 字符串含 `deactivated_at IS NULL` | REVIEW：改行为断言（停用过滤） |
| core internalization `c2-live-runner-chain`/`queue-actionability` | 常量内容回声 | REVIEW |
| host-runtime `evaluator-gate-wiring-guard` | 断言参数在源码中的位置 | REVIEW（静态守卫意图明确，可保留但标注脆弱） |
| core `pain-to-principle-service` parity 段 | `expect(x).toBe(MAP[cat])` 同义反复 | REVIEW：改对照真实 bridge 输出 |
| plugin `correction-cue-learner` | 断言 renameSync 被调用（mock fs） | REVIEW：原子性未被真实测试（真实文件测试在 earned-high-demotion-roundtrip，可参照） |

## 4.3 死资产（删除候选，风险极低）

| 资产 | 证据 | 建议 |
|---|---|---|
| plugin `tests/core/pain-score.property.test.ts` | describe.skip 出生即死（2026-04-15，fast-check 从未安装） | 删除或补装 fast-check 复活（见 Phase 2.1） |
| plugin `tests/hooks/prompt-size-guard.test.ts` 两个 describe.skip | M8 移除行为的"守卫"，永不运行 | 删除死块 |
| plugin `tests/hooks/gate-rule-host-pipeline.test.ts:86` it.skip | 顺序依赖腐烂，注释自认从未修 | 修复或删除该块 |
| plugin `tests/fixtures/legacy-queue-v1.json` | 全仓零引用 | 删除 |
| plugin `tests/fixtures/production-mock-generator.ts` + `production-compatibility.test.ts` | 仅互引；无生产数据机器上永不跑 | 移入 archive 或删除 |
| core `activation/approval-queue.test.ts` 的 decideAutoPromotion 段 | **零生产调用方**（已核验：ApprovalQueue 类与 dispatcher 均不调用） | 随生产函数退休（需工单化，PRI-811 收尾性质） |
| core `evaluator-runner-vslice.test.ts`(V1, 64KB) | 与 v2 并存的旧代 vslice | REVIEW：确认 v1 路径是否仍有生产行为，无则并入 v2 |
| 根 `tests/final-okr-test.sh` / `tests/e2e-loop-fixed.sh` | 一次性脚本命名污染 | 归档 |
| 根 `tests/feature-testing/framework/`（场景 JSON + 手动 harness） | 无 CI/脚本引用，报告停在 2026-03 | dormant，Owner 决策去留 |
| core `utils/cli-process-runner.test.ts` Windows skip | 在开发 OS 上跳过 | 修复（win32 是本仓主开发平台） |

---

# 5. Mock Risk（高风险 mock 清单）

> 原则：**unit 允许 mock，但被 mock 的行为必须在别处有真实测试**。下表"兜底"列为空者即真实缺口。

| 文件 | 被 mock 的东西 | 静默失败模式 | 兜底 | 严重度 |
|---|---|---|---|---|
| pd-cli `runtime-activation.test.ts` | SqliteApprovalQueueStore/ApprovalQueue/ActivationDispatcher 全部，审批记录预置 approved | **CLI 层"无审批激活"回归不可见**；FK/状态迁移未过真实库 | core activation 区（零 mock） | 高（分层失明，非全局缺口） |
| pd-cli `diagnose.test.ts`（34 mock） | 整个 runtime-v2 桶：准入门默认 admitted、run() 恒合法、store 全 `{}` | CLI 诊断路由过测而真实准入拒绝/能力门/桥接 wiring 漂移不可见 | golden-path/pain-diagnosis-persistence | 高（同上） |
| pd-cli `pain-record.test.ts`（16 mock，含 **fs 本体**与 recordPain 返回罐头） | pain→task→candidate 真实创建路径 | `pd pain record` 后续链路该套件从未执行 | session-parser（真库）+ core ingress 测试 | 中高 |
| core `diag-{rootcause,router,distiller}-runner.test.ts` | LLM fetchOutput **+ `_validator.validate` 恒 valid** | runner 层"畸形输出被 schema 拒绝→重试/修复环"是假的 | diagnostician-output-schema（真实 TypeBox） | 高（防线错位） |
| core `sqlite-connection-readonly.test.ts` | better-sqlite3 + fs 双 mock | 名为只读契约，真实驱动行为零覆盖 | 无（真实缺口） | 中高 |
| pd-cli `runtime-internalization-run-once.test.ts`（23 mock） | 整个 `@principles/host-runtime` | CLI run-once 与真实共享 consumer cycle 漂移 | host-runtime consumer-cycle 测试 + parity 测试 | 中 |
| plugin 15 个 hooks 文件 mock `workspace-context.js` | 真实 store 构造/迁移/lazy ledger | hook→store 方法改名/SQL 列漂移全绿 | pain-id-chain-e2e、triple-proof、gate-real-io 等（仅覆盖同名方法） | 中 |
| plugin 10 文件 mock `event-log.js` | EventLogService 真实 SQLite 写 | 门/回执观测行漂移 | gate-real-io.e2e（子集） | 中 |
| core `candidate-audit` / `internalization-chain-integrity-read-model` / `schema-conformance-read-model` / `pruning-read-model`（各 3 mock） | better-sqlite3 prepare stub + fs | 读模型 SQL 与真实 schema 漂移 | canary（部分） | 中 |
| core `pain-to-principle-service`（2 mock） | 工厂+observability 整体 | 桥契约漂移仅靠 service 侧映射测试 | bridge 家族（fake-SM）+ persistence | 中 |
| plugin `commands/pain.test.ts` / `pain-funnel-ingress` / `pain-dead-letter` | PainToPrincipleService | 跨包契约漂移（plugin 输入 vs core 语义） | core ingress 测试（单向） | 中 |
| core `trajectory-store.test.ts`（2 mock） | db 打开/查询 | 真实 schema 列默认值 | plugin trajectory 真库测试 | 中 |
| 4 个 `*-real-llm` 套件 | 仅 env 门（非 mock） | **不运行即零信息**：真实 LLM 输出漂移（模型升级/提示词回退）只能人工发现 | 无（CI 缺口） | 高（覆盖率假象） |
| console/pd-cli e2e 全部 | LLM 全部脚本化/种子化 | 同上（设计上以 ERR-001 脚本输出当不可信输入，属可接受设计） | ai-user 手动 QA | 低（已文档化设计） |

**正面发现（对照组）**：core `activation/` 与 `internalization/` 主力测试**零 vi.mock**（全 DI）；console integration/route 测试真实 handler+真实 SQLite 零 mock；host-runtime `pain-evidence-ingress` 用身份断言防漂移。这些是全仓 mock 纪律的标杆。

---

# 6. Unit / Integration / E2E 边界分析

**目标模型**：Unit=规则正确性 · Integration=模块协作 · E2E=Owner 真实流程。

**现状判定：三分层在 core 内部基本成立，但存在四类越界/失明：**

1. **Unit 假装闭环**（本任务重点问题）：`internalization-consumer-product-path`（全 mock 自称 full cycle）、`pain-pipeline-roundtrip`（源码 grep 自称 roundtrip）、`auto-entry-gate`（置于 integration 目录的全 mock unit）。**"测试通过但生产链路可能失败"的真实风险点** = §5 表中"兜底为空/仅单向"的行：sqlite-connection-readonly、真实 LLM 层、CLI 审批存储。
2. **E2E 复验 unit 已覆盖行为**：console `focus-approve-flow` 的 API 批准断言与 integration `governance-approve-activation` 重合（e2e 净增量仅"页面无 5xx"）；`rule-host-writer-golden-trace` 回滚断言与 `approvals-nextaction` 重合。低害但拖慢 e2e。
3. **E2E 从不触发真实 Pain**：console e2e 全部从 `e2e-seed.ts` 种子起步（审批/原则/pain_event 预插）；`rulecode-owner-governance`（认证 Owner 晋阶）只走 Activation 段且**不在默认 e2e 套件**（需手动 `test:e2e:owner`）。→"Owner 在 UI 里从一条真实 Pain 走到批准"这条旅程零覆盖。
4. **分层正确的范例**（应作为 Phase 2.3 的靶子形状）：host-runtime `pain-evidence-ingress`（contract 层钉身份）→ core `pain-ingress-shared-semantics`（unit 层钉语义）→ `pain-ingress-persistence`（integration 层钉落库）→ plugin `pain-funnel-ingress`（adapter 层钉输入契约）——同一行为四层各司其职。

**建议的目标边界**（供 Phase 2.3 参照，不在本轮实施）：
- Unit：纯决策函数/校验器/状态机（已有大量，重复族收编）；
- Integration：每个 store 一次真实 SQLite 往返、每个跨模块 seam 一次真实 wiring（补 pain-diagnosis store 专属测试）；
- E2E：三条 Owner 旅程——①真实 pain 入口→诊断→审批→激活→观察（当前缺失，建议以 cross-package-acceptance 为骨架接 console 审批 UI）；②shadow→promote→行为观察（当前缺失）；③reject/edit 回退旅程（已有，保持）。

---

# 7. Fixture 审计与历史考古结论（摘要）

**Fixture**（全表见 inventory §4）：canonical 资产质量高（split-pipeline-mock-outputs 带"防手改"纪律、g1-contract 冻结捕获、golden prompt 自再生）；死/休眠 4 项（legacy-queue-v1.json、production-mock-generator、feature-testing 场景集、prompt-size-guard 死块）；**命名污染几乎为零**（仅根目录两个一次性 .sh）；唯一结构性风险 = `golden-dogfood-fixtures.ts` 经公共桶导出成为 API 面 + `trajectory-store`/`evolution-store`/`chain-integrity-real-path` 三处**手工复刻 DDL**（真实 schema 漂移时静默失真）。

**Git 考古**（关键测试来源，均经 `git log --follow` 核验）：

| 测试 | 出生 | 性质 |
|---|---|---|
| activation-dispatcher | PRI-144（2026-05-17 #614）→ PRI-811 改写（2026-09-19） | 产品需求驱动，12 commits 活跃演化 |
| story-a-acceptance / cross-package-acceptance / tests/bdd/story-a.steps.ts | PRI-408（2026-06-19 #972）/ BDD #1131（2026-07-01） | 产品需求（Story A 闭环），steps.ts 出生后零改动 |
| golden-path-diagnostician-e2e | PRI-357（2026-06-10 #879） | 产品需求 |
| mainline-product-path | PRI-A 收敛（2026-06-14 #924） | 架构收敛驱动，todo 为债务标记 |
| pain-id-chain-e2e | **bug 修复**（2026-04-16 #338 pain ID 链传播断裂） | B 类回归 |
| verdict-drift-regressions | **P0 bug**（2026-08-19 verdict 漂移） | B 类回归 |
| pain-diagnostic-gate.test（plugin） | #413（2026-04-30 Gate A 时代） | **架构迁移遗留**——Gate A 退休未被跟踪清理的尾巴 |
| pain-score.property.test | #323（2026-04-15） | **临时验证遗留**（fast-check 从未装） |
| runtime-v2-prompt-activation | PRI-261（2026-05-27），17 commits | 产品需求，活跃 |
| 4×real-llm | #556（2026-05-12），最后实质改动 2026-06-21 | 产品需求 + env 门控演化为 CI 盲区 |

**方法论确认**：本轮再次验证 Phase 1 结论——按文件名/目录判断测试性质不可靠（"e2e"命名的单测、"product-path"命名的全 mock、"roundtrip"命名的 grep）；必须读断言与 git 历史。

---

# 8. Recommended Phase 2 Implementation Plan（建议，不实施）

## Phase 2.1 —— 低风险删除（建议首批，单 PR，可逆性最高）

1. 删 plugin `pain-score.property.test.ts`（死）、`prompt-size-guard.test.ts` 两个死 describe.skip 块、`gate-rule-host-pipeline.test.ts` 的 it.skip 块（或修复其顺序依赖）。
2. 删 plugin `tests/fixtures/legacy-queue-v1.json`（零引用）；production-mock-generator + production-compatibility 移 archive。
3. 删 core activation-dispatcher 内字节级重复的第二个测试体。
4. 删 plugin `auto-entry-gate.test.ts`（全 mock 且与 hooks/pain 同场景；**与 Gate A 决策解耦**——它测的是 hook 路径）。
5. 归档根 `tests/final-okr-test.sh`、`tests/e2e-loop-fixed.sh`。
6. **前置工单**：Gate A 模块退休（Owner 决策，模块头已注明）→ 随之删 `pain-diagnostic-gate.test.ts`（615 行）并保留 core policy 正主；`decideAutoPromotion` 生产函数退休 → 随之收缩 `approval-queue.test.ts`。
- 验证口径：`npm run verify:merge` + 受影响包 targeted vitest；预期净删 ~800+ 行测试、零行为损失。

## Phase 2.2 —— fixture 收敛（第二批）

1. 以真实 `RuntimeStateManager`/规范 DDL 替换 `trajectory-store`/`evolution-store`/`chain-integrity-real-path` 三处手工 schema 复刻（消除静默漂移源）。
2. 合并 `principle-tree-ledger.atomic-write` 两文件；统一内联工厂命名（makePainEvent/fakeDiagnosis 等 ~20 个）至各包 tests/helpers。
3. 审视 `golden-dogfood-fixtures.ts` 的公共桶导出（fixture-as-API 是否仍需对外）。
4. dormant 资产 Owner 决策：feature-testing 场景集去留。

## Phase 2.3 —— mock realism 提升 + 闭环缝合（第三批，价值最高）

1. **修复三处防线错位**：`diag-*-runner` 三文件改用真实 validator（split-pipeline fixtures 本就能过真 schema）；`sqlite-connection-readonly` 改真实只读 SQLite；pd-cli `runtime-activation` 审批存储改真实 tmpdir SQLite（或明示依赖 core 层兜底的注释契约）。
2. **补全链 E2E**（本调查最重要缺口）：以 cross-package-acceptance 为骨架，前置真实 pain ingress + 接 Owner 审批 UI（console），补 shadow→promote→行为观察段；把 `test:e2e:owner` 纳入周期性（非每 PR）门。
3. **真实 LLM 层复活决策**：或设周期性（ nightly/手动）`LLM_E2E_ENABLED` 作业，或在 README 明示其人工触发定位——现状"存在但永不运行"是最差的假覆盖率。
4. **模板族参数化**：diag runner 三连 / prompt-builder 六连 / peer-runner 脚手架收编为共享表驱动测试（一次重构约 -80 用例等价保义）。
5. **mainline-product-path 三个 it.todo** 转工单跟踪（依赖收敛工作，非测试侧可独立完成）。
6. BDD 决策：为 codex-governance 三个无绑定 feature 补 step 或移除 feature（避免规格腐化）。

---

# 9. 完成标准回执

- 报告路径：`docs/testing/pain-path-test-inventory.md` + `docs/testing/pain-path-test-governance-report.md`
- 未删除/未修改任何测试、生产代码、fixture、CI；未创建 PR；未更新 Linear（纯调查，无对应工单要求）。
- 一句话结论：**PD 测试体系对"无 Owner 批准不得激活"这一核心安全不变量的保护是充分且高质量的；真正的债不在数量，而在①全链缝合缺口（尤其 shadow→promote→观察段与 Owner UI 旅程）、②真实 LLM 层的 CI 死区、③Gate A 时代遗留与 internalization 模板族的重复投资。**
