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
CI_PASS                     ⏳ PR 推送后由 GitHub Actions 权威判定（本地全量回归绿）
DOCUMENTATION_COMPLETE      ✅（SPEC/审计/验收/交付四件套）

最终交付状态：READY_FOR_OWNER_REVIEW
F2：集成完成 · Dry-run 完成 · 真实执行未授权（零真实模型调用）
```
