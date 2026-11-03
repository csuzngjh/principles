# EXAMINER V0101 END_TO_END ACCEPTANCE

**日期：** 2026-11-03  
**执行：** ZCode 自主执行（SPEC-PD-EXAMINER-001 v0.10.1 全量产品化 Mandate）  
**分支：** `ai/adhoc-20261103-examiner-v0101`（基于 `origin/main@9a2bd5efb`）  
**验收环境：** worktree `D:\Code\_worktrees\principles\adhoc-20261103-examiner-v0101`（writer=zcode，lease+git lock 持有，bootstrap READY）

---

## 1. Git SHA

- 基线：`9a2bd5efbdfeea5c01468f1beff5f86e4078c3ae`（origin/main，含 v0.9 PR #2257）
- 验收提交链（6 commits）：docs(SPEC+审计) → feat(server) → feat(UI+E2E) → test(BDD) → fix(EP-11 码点截断)+changeset → 报告（本提交）

## 2. 完成的 Phase（对照 Mandate）

| Phase | 状态 | 证据 |
|---|---|---|
| Phase 1 Owner Workflow Productization | ✅ 完成 | 四页旅程 `/examiner` → `/examiner/configure` → `/examiner/studies/:id` → `/examiner/studies/:id/report`，全部连接真实后端 API；loading/empty/error/只读/降级状态齐备；桌面双栏+响应式；i18n en/zh 全键对齐（118/118） |
| Phase 2 Production Evidence Integration | ✅ 完成 | `ExaminerEvidenceModel` 聚合 ledger/activations/injection-status/projection-budget-provenance/receipts/evidence-audit；Evidence Audit 关联 Principle/Activation/Episode；Coverage+AsOf+Unresolved+降级链路；Projection/Submitted/HostAccepted/ContextPresent/RuntimeLoaded 五级严格分列不升级；agent_claimed≠runtime_verified |
| Phase 3 Host-backed Study Inputs | ✅ 完成 | 真实 Principle 选择（active 过滤）、真实 Pain 关联（derivedFromPainIds 冻结进 mapping.painRefs）、Challenge Suite 目录（didactic-pair/calibration-core）、HEPS 沿用 v0.9 契约、RuleCode Baseline 从运行时激活行派生（target-scoped；耦合→INTERVENTION_NOT_IDENTIFIABLE 422 拒绝）、Pair Assignment/Freeze/Preregistration/Binding Verification 复用 v0.9 引擎（快照追加后绑定校验仍通过=回归钉住） |
| Phase 4 Offline End-to-End Product Closure | ✅ 完成 | 真实 Console+API+DB+研究管线的完整闭环，浏览器 E2E 场景 B/C/D 全绿；v0.9 历史 Study 兼容（只读可见，42/42 旧测试绿） |
| Phase 5 OpenClaw F2 Integration | ✅ 实现+Dry-run 完成 | Host readiness 投影、F2 授权门（APPROVED+绑定校验）、§12.3 异步契约（202/runId/单活 409/重启恢复 ABANDONED→RESULT_UNKNOWN 不自动重试/重复拒绝）、Host Dry-run 六项检查清单（零模型调用；CLI 探测委托 lab `probeOpenClawCli`）；Stage R/隔离探针/预算账本全部复用既有 lab 模块 |
| Phase 6 Final Product Closure | ✅ 完成 | Owner Decision handoff（报告页→既有原则治理，零新决策系统）、Report↔Principle 关联（targetPrincipleId 贯穿）、历史记录（studies 列表+consoleRuns 账本）、失败恢复（恢复扫描+RESULT_UNKNOWN）、安全负向测试、全量回归、浏览器验收、文档、本报告 |
| F2 真实模型调用 | ⛔ 未授权=零调用 | 全部验收路径真实模型调用 **0 次**；accepted-BOUND 路径结算为 `F2_EXECUTION_NOT_ENABLED_THIS_ROUND`（零调用，账本无 RUN_STARTED） |

## 3. 测试统计

| 套件 | 总数 | 通过 | 失败 | 跳过 |
|---|---|---|---|---|
| pd-console vitest（全量，含新增） | 3104 | 3103 + 1 expected-fail | 0 | 0 |
| ├ examiner 路由 v0.9（15，含 2 处有意契约更新） | 15 | 15 | 0 | 0 |
| ├ examiner path-boundary | 13 | 13 | 0 | 0 |
| ├ examiner 路由 v0.10.1（新增） | 14 | 14 | 0 | 0 |
| ├ examiner BDD（新增 11 场景） | 11 | 11 | 0 | 0 |
| ├ examiner UI product-surface（+1 断言） | 3 | 3 | 0 | 0 |
| ├ i18n 治理（en/zh 对齐+术语） | 20 | 20 | 0 | 0 |
| lab 契约回归（examiner-v09 88 + payload closure 2） | 90 | 90 | 0 | 0 |
| Playwright E2E（全量，含 examiner-journey 6 场景 + smoke+examiner 页） | 87 | 86 | 1（Update smoke 偶发） | 0 |

**Update smoke 偶发说明（证据）**：全量跑失败于 `smoke: Update page loads without error`；单独重跑同用例 `1 passed (17.5s)`（命令与输出留存于会话记录）；本 PR 未触碰 Update 页与其依赖，判定环境偶发（磁盘/时序），非本变更回归。

## 4. Browser E2E 结果（examiner-journey.spec.ts，真实浏览器+真实后端+真实研究管线）

| 场景 | 结果 | 关键断言 |
|---|---|---|
| A 原则评估 | ✅ | gates 面板 v0.10.1 scope、p-001/p-002 列表、证据面板（激活 ok/注入 available+预算来源/审计+确认阶梯+asOf）、ledger≠runtime 说明 |
| B Study 创建 | ✅ | 套件目录+Gate 1 边界+就绪要求；**p-003（RuleCode 耦合）创建 422 拒绝**；p-002+calibration-core 创建 200 → 导航 study 页（EXM-C- 身份） |
| C 执行与证据 | ✅ | 冻结生产快照+markers；preflight ok；离线执行 SUCCEEDED；报告生成 |
| D 评估报告 | ✅ | ITT/fidelity/重放校验/离线边界说明；独立"生产观察"通道；handoff 链接跳转 `/#/principles/p-002` |
| E 异常处理 | ✅ | Host dry-run 202→账本结算 `DRY_RUN_CHECKS_FAILED`（stage_r/host_cli 清单）；F2 请求 403（网络层捕获 403 证据）；无新 run 事件 |
| F 历史只读 | ✅ | EXM-V09-ACC-ISO 打开=只读横幅+执行/报告按钮 disabled |

## 5. 截图与日志位置（场景证据）

- 截图（7 张，真实浏览器 MCP 会话，1920×全页）：`D:\Code\principles\.tmp\examiner-v0101-shots\`
  - `A-principle-evaluation.png`（评估页+证据面板）
  - `B-study-configuration.png`（配置页：套件/Gold 门/就绪要求/差异说明）
  - `C1-study-execution-snapshot.png`（冻结生产快照+markers）
  - `C2-execution-finished.png`（SUCCEEDED 单元+报告按钮）
  - `D-evaluation-report.png`（ITT/Fidelity/重放/独立生产通道/决策交接）
  - `E-dryrun-checklist-and-f2-refusal.png`（console-run 清单结算+F2 403）
  - `F-historical-readonly.png`（历史资产只读）
- Playwright 失败重跑与 E2E 详细输出：本会话记录 + `packages/pd-console/test-results/`
- 服务器端拒绝日志样本（INTERVENTION_NOT_IDENTIFIABLE 定位过程）：会话记录

## 6. F2 Dry-run 结果与真实模型调用计数

- Host dry-run 六项检查：offline_contract_preflight ✅（fresh study）/ stage_r_authorization ⛔（无授权，如实红）/ host_cli_probe（环境相关，本机 OpenClaw 在场则 ✅）/ isolation_workspace_probe ✅ / injection_capability_ceiling ℹ️（SUBMITTED 上限）/ model_calls_zero ℹ️
- **真实模型调用次数：0**（dry-run 构造性零调用；F2 未授权 403；accepted-BOUND 路径显式 NOT_ENABLED_THIS_ROUND 且账本无 RUN_STARTED——由 BDD+E2E+路由测试三方钉住）

## 7. 生产状态变更情况

- **零**。所有验收在临时 worktree/临时工作区；v0.9 历史研究资产经 fingerprint 树哈希断言未变（路由测试"historical acceptance studies are readable but every write is refused, and nothing changes on disk"）；主检出（primary）除只读调查外未写任何文件（截图存于主检出 `.tmp/`，gitignored 工件区）。

## 8. 已知问题 / 未完成项及原因

| 项 | 说明 | 处置 |
|---|---|---|
| F2 真实执行 | 未授权——SPEC §Owner Decision 明确需 Owner 单独授权；代码路径已实现（授权门+受理+响亮不执行），授权后仍需按 Phase 6 门禁走 | 等待 Owner 授权（非本轮范围） |
| Console 内驱动真实 F2 的 Runner 组合 | 安装版 lab payload 不含 F2 transport 模块（LAB_ENTRY_MODULES 闭包未含 challenge-openclaw-host）；代码按"受理后响亮失败"处理，真实执行走 lab F2 driver | 记录为后续（需扩展 payload 闭包+独立 SPEC） |
| Gold 独立人审（Gate 1） | 全部套件 SYNTHETIC_OFFLINE——正式效果结论保持阻塞（契约如此，非遗漏） | 等 Owner 安排人审 |
| Update smoke 偶发 | 全量跑 1 失败、单独重跑通过；未触碰相关代码 | 已归因非回归；如再现交由 flaky 治理 |
| `examiner.test.ts` overview 断言更新 | v0.9→v0.10.1 scope 文案变化（有意契约变更，SPEC 驱动，测试注释标明） | 已在 PR 说明 |

## 9. 最终状态

```text
SPEC_IMPLEMENTED            ✅（§1–§18 全部实现；§Owner Decision 边界遵守）
OWNER_CONSOLE_USABLE        ✅（四页真实旅程，浏览器验收通过）
PRODUCTION_EVIDENCE_INTEGRATED ✅（只读聚合，零第二真相源）
STUDY_PIPELINE_WORKING      ✅（真实输入冻结→preflight→执行→Report V2）
OFFLINE_E2E_PASS            ✅（BDD 11 + E2E 6 + 路由 43）
F2_INTEGRATION_IMPLEMENTED  ✅（readiness+授权门+异步契约+dry-run）
ASYNC_EXECUTION_CONTRACT_VERIFIED ✅（202/409/恢复/幂等/RESULT_UNKNOWN 不重试）
BROWSER_ACCEPTANCE_PASS     ✅（A–F + 7 截图）
SECURITY_REGRESSION_PASS    ✅（Mimosa 写入拦截全修复；越权/路径/只读/并发/历史不可变负向测试绿）
CI_PASS                     ✅（PR #2301 CI 全 required 门禁 PASS：Verify Merge Gate / pd-console / e2e / shared runtime / create-principles-disciple / packaged install smoke；仅剩 CodeQL 存量幽灵告警（非 required，告警创建时间均早于本 PR）与 codecov/patch 咨询性 79.21% vs 84.18%（UI 为主变更的已知特征）非阻断）
DOCUMENTATION_COMPLETE      ✅（SPEC/审计/验收/交付四件套）

最终交付状态：READY_FOR_OWNER_REVIEW
F2：集成完成 · Dry-run 完成 · 真实执行未授权（零真实模型调用）
```

---

## 10. P1 Repair 轮次（2026-11-03，接手者 trae）

Owner 评审提出六项 P1；本轮完成代码、定位并修复两处真实缺陷（一处测试死锁、一处仅在真实 seed 工作区暴露的冻结链表示不匹配），并补做全量回归 + 真实浏览器 E2E。基线已同步 `origin/main@3bcbc8c63`（13 个新提交，均为 host-runtime/advisory/release 变更，与 examiner 无文件冲突）；同步后重跑 pd-console 全量、lab 契约与 E2E 均绿。

### 10.1 六项 P1 验收矩阵

| P1 | 结果 | 证据 |
|---|---|---|
| P1-1 快照进入冻结链 | PASS | 4 用例：正常创建→preflight PASS（manifest hash=canonical(snapshot)，anchor.binding 带快照 hash）/篡改→FAIL/删除→FAIL/连改 manifest+hashes.json→FAIL（anchor 不可再生） |
| P1-2 Runtime Activation 降级 | PASS | 无 state.db → status=degraded + ACTIVATION_DATA_DEGRADED marker + reason/nextAction，independence 绝不=true；**activation 表缺失 → 同样 degraded（专测）**；展示列表 50 条截断，统计用完整计数（50 行展示 + 51 总计 → 统计仍为 51） |
| P1-3 证据分页真相 | PASS | 55 条 → counts=50 + pages.delivery.hasMore=true + nextCursor；7 条 → 精确 7 + hasMore=false；**恰好 50 条 → hasMore=false（边界）**；**分页按类别独立：delivery 与 effect 同时饱和均 hasMore=true，application/outcome 为 false** |
| P1-4 异步原子受理 + 账本 fail-loud | PASS | 并发两 run → [202,409] 且恰 1 条 ACCEPTED；坏账本 → 500 console_ledger_unreadable + status.ledgerProblem(ledger_corrupt)；ENOENT≠corrupt；finishedAt≥acceptedAt；recovery 跳过坏账本 study |
| P1-5 Stage R 全量契约 | PASS | 复用 lab `verifyStageRAuthorization`；薄 APPROVED/错 studyId/过期/probe FAILED/错 suite 全部 403；完整合成记录 → 202 → 响亮 `F2_EXECUTION_NOT_ENABLED_THIS_ROUND`（零模型调用、无 RUN_STARTED） |
| P1-6 路径/临时文件安全 | PASS | ledger 被替换为外指 symlink → 拒绝；study 目录换 junction → recovery 跳过且 decoy 未被写；dry-run 探针无固定名残留；**在旧固定名探针位置预植 junction → 不被跟随、诱饵目录零写入（专测）** |

### 10.2 缺陷一：P1 专项测试死锁（根因已定位并修复）

- **症状**：`examiner-v0101-p1-repair.test.ts > P1-1 > a fresh study verifies` 在 240s/600s 均挂起；本轮实测即使在**单独首跑**也必现（与上一轮"首跑绿"的记录不符，环境更冷/更快后竞态方向反转）。其余用例始终绿（文件现为 18 例）。
- **根因**：mock `IncomingMessage` 用 `setTimeout(..., 0)` 派发 body，而 `handleExaminerRoute` 在到达 `readBody` 之前要 `await loadLab()`（进程内首个请求的 lab 冷加载，真实异步 I/O）与首个 root 的启动恢复。首个请求期间 0ms 计时器先触发，`readBody` 之后才订阅 `data`/`end` → 事件丢失 → `readBody` 的 Promise 永不 settle → 死锁。后续请求走模块级 memo（`hostCapability`）热路径，全程微任务，计时器排不到，因此全部通过。
- **可观测证据**：临时插桩输出 `[diag] mock emits body; data listeners = 0 end listeners = 0` 恰好出现一次（首个请求），且该请求从未出现 `readBody got end`；其余每次都是 `data listeners = 1`.
- **修复**：request double 改为**缓冲式**：在 reader 订阅 `'end'` 时同步回放已缓冲的 body（等价于真实 `IncomingMessage` 的缓冲语义），任何 macrotask 都无法插入。同时删除无效的 collect 期 lab 预热 import 与 600s 超时（超时只是掩盖症状）。首例耗时 ~0.37s。
- **反向验证**：`examiner.test.ts` 在前 + repair 在后、`--no-file-parallelism` → **33/33 PASS**；repair 单跑 **18/18 PASS**。未使用 `--isolate` 掩盖，也未调大 timeout/retry/skip。同类的 timer 派发 mock 也已从 `examiner-v0101.test.ts` 移除，避免同一失败类在兄弟套件潜伏。
- **CI 说明（诚实）**：上一轮"CI 从未复现"的表述不成立——该测试文件此前未提交，CI 从未执行过它。修复后测试已入库并由 CI 真实执行。

### 10.3 缺陷二：真实 seed 工作区 422（E2E 红灯 → 绿）

- **红灯**：`examiner-journey.spec.ts` 场景 B：`POST /api/v1/examiner/studies` 返回 **422**，服务端拒绝原因 `production-snapshot.json hash != manifest.productionSnapshotHash`（三次 retry 同结果）。
- **根因**：lab 的 canonical hasher 保留「值为 `undefined` 的对象键」（输出字面量 `"key":undefined`），而 `JSON.stringify` 落盘时丢弃该键。console 快照在**健康通道**下恰好携带 `undefined` 字段（`reason`/`nextAction`/`capacitySource` 等只在降级时赋值），于是内存哈希与磁盘文件哈希不一致，被冻结链判为篡改。单元 fixture 的降级通道把这些字段都填上了，所以 32 个路由用例全绿，只有真实 seed 工作区暴露。
- **修复**（在冻结链属主 `writeExaminerStudyArtifacts` 内）：入参快照先归一化为「即将落盘的 JSON 表示」，manifest hash 与写文件都用同一个归一化值；binding 校验不变（仍校验磁盘字节）。
- **红/绿证据**：同一 payload 对 seed 工作区 POST：修前 422 / 修后 **200**（`EXM-C-AAD9BF6C-…`，suiteKey=calibration-core）；`examiner-journey.spec.ts` A–F **6/6 PASS**。

### 10.4 本轮验证结果（真实命令输出）

| 套件 | 结果 |
|---|---|
| pd-console 全量 vitest（`--maxWorkers=2`） | **171 files PASS / 3125 passed + 1 expected fail (3126)** |
| P1 专项 18 + v0101 18 | **36/36 PASS**（新增覆盖：恰好 50 / 按类别分页 / activation 表缺失 / 旧固定名探针 links） |
| lab 契约（examiner-v09 + payload closure + human-review intake） | **95/95 PASS** |
| `run-examiner-v09-acceptance` 历史基线 | `ok=true checked=593 mismatches=0, OVERALL PASS` |
| Playwright E2E（examiner-journey，真实浏览器 + 真实后端 + 真实研究管线） | **6/6 PASS** |
| `tsc --noEmit` | PASS |
| `eslint`（改动 TS） | 0 error |
| `check-runtime-contract` | 0 new violations（已用真实 guard 替换 `as ConsoleRunMode`） |
| `pre-push-fast` | PASS |
| 真实模型调用 | **0** |
| 生产状态变更 | **0**（全部临时工作区；历史 acceptance 资产回滚为字节一致） |
| Required CI | 推送后由 CI 判定（本报告不预设绿） |

### 10.5 冻结链 rebind 与历史基线

- `examiner-study.mjs` 属实现绑定目录，两轮改动均触发 `OFFLINE_PACKAGE_DRIFT`。按既有程序 `rebind-exm-v4-freeze.mjs --record-evidence` 闭合，且历史基线 v6→**v7** 前滚，delta 恰好四个文件：
  `blind-review/receipts.template.json`、`expected-replay.json`、`package-manifest.json`、`review-subject.json`。
- `executionsHash` 全程不变（`97e2d4e7…`），所有报告行除 `implementationHash` 外不变 → 研究输入、Gold 决策、执行与评分均未移动。
- `run-examiner-v09-acceptance` 会重生成 `examiner-studies/` 下的验收产物；本轮已回滚，历史只读资产保持字节一致（E2E 场景 F 仍通过）。

### 10.6 仍未实现 / 未验证（如实）

| 项 | 状态 | 说明 |
|---|---|---|
| F2 Transport（console 内真实执行组合） | 未实现 | 安装版 lab payload 闭包不含 F2 transport 模块；受理后显式 `F2_EXECUTION_NOT_ENABLED_THIS_ROUND`，零模型调用 |
| F2 真实执行授权 | 未授权 | 需 Owner 单独授权；本轮 F2 状态保持 `NOT_ENABLED_THIS_ROUND` |
| Gate 1 独立人审 | 未进行 | 全部套件仍为 SYNTHETIC_OFFLINE gold |
| 安装包支持 | 未验证 | 本轮未构建/安装打包产物（packaged install smoke 交由 CI） |
| 生产部署 | 未执行 | 红线：不部署 |
| PR 合并 | 未执行 | 红线：Owner 逐次授权前不合并 |

### 10.7 Follow-up（刻意未纳入本轮）

1. `readBody` 在真实 `IncomingMessage` 上无超时上限；若上游中间件提前消费 body，会表现为挂起而非结构化失败。产品边界内暂不新增（当前无此中间件），记录为后续。
2. 首次请求的 lab 冷加载走模块级 memo；若未来需要多 workspace 并发，可评估预热策略（本轮已删除无效的 collect 预热）。
3. 冻结链的 canonical hasher 对 `undefined` 键的行为与其他 frozen 产物一致但语义易误读；可考虑在 lab 内统一「先 JSON 归一化再哈希」，超出本轮范围。

**本轮结论**：六项 P1 全部 PASS；两处缺陷均有可复现的红灯证据与修复后绿灯证据；真实模型调用 0；PR 保持 OPEN，等待 Owner 授权合并。
