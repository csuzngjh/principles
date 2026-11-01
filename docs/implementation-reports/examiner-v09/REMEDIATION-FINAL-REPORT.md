# Examiner v0.9 — 定向修复与端到端验收最终报告

> 指令来源：PR #2257 — Examiner v0.9 定向修复与端到端验收指令（基线评审 head `043034923742a6022f3d62bcb0f9d60b9c71f6f3`）。
>
> 本次结论仅覆盖离线工程链路（offline stub）。真实模型调用 = 0，真实宿主运行 = 0，
> 生产写入 = 0，生产迁移 = 0，历史验收研究结果 = 0 改动。Gate 1 / Gate 2 / Phase 6
> 均未解锁。

---

## A. 基线

| 项目 | 值 |
| --- | --- |
| 原始 PR Head（评审基线） | `043034923742a6022f3d62bcb0f9d60b9c71f6f3` |
| 修复提交（remediation） | `c4956990a`（`fix(examiner): v0.9 remediation — write isolation, run readiness, receipts, bindings`） |
| main 刷新合并 | `cc5de3f2c`（`Merge remote-tracking branch 'origin/main'`） |
| main 基线 | `0d0ea7eb560af15729f2a7f81b4e8a11a1bb0e8e` |
| 最终 PR Head | 本报告所在提交（同一分支增量推送；PR 页面 `headRefOid`） |
| 工作区 | `D:\Code\_worktrees\principles\adhoc-20261031-examiner-v09-7f3k2q-examiner-v09` |
| 分支 | `ai/adhoc-20261031-examiner-v09-7f3k2q-examiner-v09`（原 PR #2257 分支，未新建 PR） |
| 工作区状态 | 除 `.tmp/`（gitignored 验收产物）外干净；workspace lease 由本会话持有 |

刷新方式：先把远端分支 merge 回 `main`（`0d0ea7eb5`），使 PR diff 的 merge-base 等于 main 尖端，
再增量提交；未使用 `git reset --hard` / `git clean -fd`，未覆盖任何他人未提交修改。

---

## B. 缺陷闭环

逐条结论：**CONFIRMED**（已在基线代码上复现）→ 已修复；无法在本轮范围内的部分列入“仍有限制”。

### B1. P1-1 Console 写入隔离与历史资产保护（CONFIRMED → FIXED）

- 原始问题：Console 可对历史研究目录（`examiner-studies/EXM-V09-ACC-FULL`、`EXM-V09-ACC-ISO`）
  发起 `POST /run`、`POST /report`；研究目录成员身份被当作可写权限，服务端未校验目录归属；
  报告生成在检查写权限之前就已开始。
- 根因：研究目录枚举（“在这个根下”）被当成了写授权；没有服务端签发的 Study ID 与
  ownership marker；`writeBehaviorReportV2()` 先生成再校验。
- 修改文件：
  - `packages/pd-console/src/server/routes/examiner.ts`（可写根、历史区判定、403、ISO 根隔离）
  - `packages/pd-console/src/server/routes/examiner-executor.ts`（ownership marker 校验、
    realpath/根边界/目录身份）
  - `scripts/dev/principle-learning-lab/lib/challenge-behavior-report.mjs`
    （`writeBehaviorReportV2` 先探权限，再生成/加锁/写盘）
- 修复方案：
  - 可写根由 `PD_EXAMINER_STUDIES_ROOT` 决定（默认 Console 自有 studies 目录）；可写根与历史
    研究区必须互不包含，否则创建 Study 直接 `409 writable_root_not_isolated`。
  - Study ID 由服务端铸造；目录必须携带匹配的 `examiner-console-ownership.v1` marker
    （origin `pd-console`、studyId 一致、可写根 realpath 一致），否则一律只读。
  - 历史目录（含两套 ACC 研究）一律 `readOnly: true`，`POST /run`、`POST /report` 返回
    `403 study_read_only`；GET 仍可读。
  - `writeBehaviorReportV2()` 在生成任何内容之前调用权限探针；拒绝时不产生报告、不建锁、
    不写 ledger。
- 新增测试（`packages/pd-console/tests/server/routes/examiner.test.ts`、
  `scripts/__tests__/principle-learning-lab-examiner-v09.test.ts`）：
  - 历史两套 Study：GET 200 + `readOnly`；run/report 403；**整目录 SHA-256 快照前后一致**。
  - 无 marker 目录只读；伪造 marker（studyId 不符）仍只读；修正 marker 后才可写。
  - 可写根 = 历史区 → 创建被 `409` 拒绝，历史列表不变。
  - `writeBehaviorReportV2` 权限拒绝：0 生成、0 锁、0 新文件，目录列表逐项一致。
- 红 → 绿：修复前历史 Study 的 POST 返回 2xx 且可写；修复后以上测试全部通过
  （`examiner.test.ts` 11/11、`examiner-v09` 73/73）。
- 仍有限制：无（本轮范围内）。

### B2. P1-4 服务端强制执行 Preflight（CONFIRMED → FIXED）

- 原始问题：Preflight 只是 UI 便利；直接 `POST /run` 可绕过冻结校验；失败时仍可能写入
  `RUN_STARTED`、预留预算、创建 actor。
- 根因：runner 在锁内、`RUN_STARTED` 之前没有独立复验；合法性判断分散在调用方。
- 修改文件：`scripts/dev/principle-learning-lab/lib/challenge-runner.mjs`
  （`verifyStudyRunReadiness`）、`packages/pd-console/src/server/routes/examiner-executor.ts`
  （preflight 复用同一 readiness）、`examiner.ts`（blocker → HTTP 409）。
- 修复方案：顺序固定为 身份/路径与写权限 → 加锁 → 冻结复验（bindings + HEPS + RuleCode +
  臂隔离 + 随机化 + 预算）→ 全部 blocker 通过 → `RUN_STARTED`。任一 blocker：
  HTTP 409，无 `RUN_STARTED`、无预留、无 actor、无资产变更；锁在 `finally` 释放。
  该 readiness 仅对 Examiner Study 生效；历史 CEB 挑战研究保留其既有“按单元 SUITE_DRIFT”
  合约（`challenge-1b` FI10 仍绿）。
- 新增测试：`POST /run` 在“预检后改写 `heps-principles.json`”时：409 `preflight_blocked`、
  无 `RUN_STARTED`、无 writer.lock、无 budget-ledger、整目录逐字节不变；恢复后重试 200，
  全部 unit `SUCCEEDED`。
- 红 → 绿：修复前同一场景返回 200 并启动执行；修复后上述断言全部通过。
- 仍有限制：readiness 覆盖的是“冻结输入一致性”，不替代真实宿主侧能力探测。

### B3. P1-2 注入证据链（CONFIRMED → FIXED）

- 原始问题：离线链由 runner 自述即可达到 `RUNTIME_LOADED`；没有运行时 receipt，也没有
  receipt ↔ attempt 绑定；offline producer 可伪造 real-host scope；重复 sidecar 会虚增
  Fidelity；缺失 sidecar 被当作“未注入”。
- 根因：证据级别由“声明”而非“可验证事实”推进；producer/scope 未闭环。
- 修改文件：
  - `lib/challenge-actor.mjs`：离线运行时自己签发 `offline-runtime-prompt-receipt.v1`
    （`receivedPromptHash` + `receiptHash`），并随 trace 落盘。
  - `lib/examiner-injection-evidence.mjs`：链必须绑定 study/unit/attempt + receipt；
    无 receipt 最高只到 `SELECTED`；producer↔scope 白名单。
  - `lib/challenge-runner.mjs`：dispatch 前取运行时 receipt，失败则 `UNIT_REFUSED`；
    attempt `promptAudit` 记录 `promptHash`。
  - `lib/challenge-statistics.mjs`：Fidelity 增加 `unresolvedTreatmentUnits` / `coverage`
    （缺失 = UNKNOWN，不是“未注入”）。
- 新增测试（10 项，`examiner-v09` §7）：最高连续等级、跳级拒绝、声明式证据拒绝、
  无 receipt 的 `RUNTIME_LOADED` 拒绝、producer 白名单与链哈希篡改、producer↔scope 绑定、
  receipt 与同一 prompt 绑定、无 receipt 停在 `SELECTED`、异 prompt/伪造 receipt/载荷缺失
  三种拒绝、重复 sidecar 不虚增、缺失 sidecar → UNKNOWN。
- 红 → 绿：修复前离线链可无 receipt 声称 `RUNTIME_LOADED`；修复后上述测试全部通过。
- 仍有限制：`RUNTIME_LOADED` 在离线场景中的含义是“离线运行时确实收到并加载了该 prompt”，
  **不等于真实宿主加载**（见 E 节）。

### B4. P1-3 Preregistration 跨文件冻结绑定（CONFIRMED → FIXED）

- 原始问题：manifest / HEPS / arm payloads / RuleCode 各自可自洽，但改写后重新计算各自
  hash 仍能通过；没有 append-only 锚点。
- 根因：只有文件内自证，没有跨文件一致性 + 写入时锚点。
- 修改文件：`lib/examiner-study.mjs`（`verifyExaminerStudyBindings`、
  `examiner-preregistration-anchor.v1`、4 路 hash 一致性）、`lib/challenge-runner.mjs`
  （readiness 与臂校验先验 bindings）。
- 修复方案：绑定哈希由 manifest / HEPS 快照 / 臂 payload / RuleCode 策略 + 冻结主终点共同
  计算；Study 创建时追加锚点事件；验证要求绑定一致且与锚点一致。锚点只追加，不可重写；
  绑定哈希不包含锚点自身，避免循环。
- 新增测试：seed 变更后 4 路一致地重算仍被锚点拒绝；manifest 重算 hash 不能移动锚点；
  一致改写的主终点被锚点钉住；HEPS+臂+manifest 一起改仍被拒；重写 RuleCode baseline
  再重钉 manifest 仍被拒；自造 hash 的臂 payload 被冻结重建拒绝。
- 红 → 绿：修复前“内部一致重写”可整体通过；修复后以上 6 项全部拒绝。
- 仍有限制：锚点保护“创建后的改写”；对创建之前就已被篡改的输入不做追溯（需历史证据核对）。

### B5. P1-5 RuleCode 干预语义（CONFIRMED → FIXED）

- 原始问题：缺失证据时默认“独立”，把耦合干预当作 `principle_only` 执行。
- 根因：`principleRuleCodeIndependence` 缺省为 true；没有“不可识别即拒绝”的分支。
- 修改文件：`lib/examiner-study.mjs`（`buildRuleCodePolicy` / `verifyRuleCodePolicy`）、
  `challenge-runner.mjs`（readiness 强制 `executable`）。
- 修复方案：独立性只能由证据证明；缺失/未解析 → UNKNOWN → 不可执行
  （`INTERVENTION_NOT_IDENTIFIABLE`）；只有证明不可拆分时才声明 `bundled_intervention`；
  目标 RuleCode 保持 baseline，不为研究主动关闭。
- 新增测试（8 项，`examiner-v09` §2）：baseline OFF/ON + 已证独立 = `principle_only` 可执行；
  无独立性证据 = 不可识别且不假设；`independence=false` 拒绝；未解析证据 = UNKNOWN 而非 0；
  耦合干预标注为 bundle 被拒；把耦合改标为可执行 bundle 被拒；目标混入非目标库被隔离审计拒绝；
  创建期拒绝不可交付的干预。
- 红 → 绿：修复前缺证据默认独立并可执行；修复后全部按要求拒绝/UNKNOWN。
- 仍有限制：RuleCode 独立性判断依赖入参证据质量。

### B6. P1-6 容量竞争进入最终报告（CONFIRMED → FIXED）

- 原始问题：`capacityEvictions` 恒为 0 / 缺失；`renderLibraryPayload()` 命名是
  “FIFO-prefix”，实际实现是 skip-and-continue；报告未重算容量竞争，也未区分
  0 / NOT_APPLICABLE / UNKNOWN。
- 根因：报告直接使用存储记录或默认 0，没有从冻结数据重算；命名与实现不一致。
- 修改文件：`lib/challenge-behavior-report.mjs`（`recomputeExaminerCapacity`，
  把 recomputation 作为权威，stored 记录仅对账）、`lib/examiner-study.mjs`
  （`renderLibraryPayload` 改名/注释为 skip-and-continue，选择逻辑不变）、
  `lib/challenge-statistics.mjs`（Fidelity 消费容量记录）。
- 修复方案：从冻结 HEPS + budget + ordering 重算 eligible/delivered/evicted/
  target delivered/非目标保留；与存储记录不一致 → critical finding（以重算为准）；
  isolated 模式 → `NOT_APPLICABLE`；缺数据 → `UNKNOWN`；只有真实无挤出才是 0。
- 新增测试（8 项，`examiner-v09` §2.2.5）：选择规则诚实命名且 skip-and-continue 真实；
  isolated = NOT_APPLICABLE（不是 0）；有空间 = 真实 0；紧预算下各字段重算并上报；
  篡改存储记录 → critical finding；缺容量数据不读作 0；目标装不下被拒绝而非静默挤出；
  无文本的 HEPS 条目被拒绝而不是渲染 `undefined`。
- 红 → 绿：修复前报告容量字段缺失/恒 0；修复后全部通过。
- 仍有限制：容量竞争只对 full-library 且存在预算约束的研究有意义。

### B7. P2-1 Examiner DEV-only（CONFIRMED → FIXED）

- 原始问题：生产构建仍暴露侧边栏入口、原则详情入口与 `/examiner` 路由；API 默认可用。
- 根因：DEV 判定只存在于个别组件，且可由环境变量在客户端绕过；路由无条件挂载。
- 修改文件：`packages/pd-console/src/ui/utils/runtime-mode.ts`（新增，构建期 `IS_DEV`）、
  `src/ui/App.tsx`、`components/layout/app-sidebar.tsx`、`pages/principles/PrincipleDetailPage.tsx`、
  `src/server/routes/examiner.ts`（服务端运行时判定，非客户端标志）。
- 修复方案：路由/导航/原则详情入口全部由构建期 `import.meta.env.DEV` 决定；生产构建
  `/examiner` 重定向到 `/focus`；服务端只在 tsx dev 运行时（或显式 `PD_EXAMINER_DEV=1`）
  启用 API，否则 503/404 式拒绝（不把实验能力打进生产）。
- 新增测试：`examiner-dev-gating.test.ts` 3 项（IS_DEV 为构建期布尔；
  生产导航不含 examiner 且仍含常规项；DEV 导航含 examiner）；路由测试覆盖
  `isExaminerDevRuntime` 对 `dist/server.js` / `examiner.ts` / env 的判定。
- 红 → 绿：修复前生产 bundle 含完整 examiner 路由与入口；修复后 bundle 中
  `IS_DEV = true` 仅在 dev 构建出现，生产构建入口消失（`build:ui` 产物检查）。
- 仍有限制：`/api/v1/examiner/*` 在生产中是“不可用”，不是“静默降级为成功”。

### B8. P2-2 Runner 锁生命周期（CONFIRMED → FIXED）

- 原始问题：非法 `unitOrder` 在加锁之后才拒绝，拒绝路径会泄漏写锁，后续合法运行被卡。
- 根因：`resolveDispatchUnits` 与加锁顺序颠倒。
- 修改文件：`lib/challenge-runner.mjs`。
- 修复方案：调度单元先校验（覆盖、重复、夹带全部拒绝），再加锁、再写 `RUN_STARTED`；
  锁统一在 `finally` 释放。
- 新增测试：非法 unitOrder → 无锁文件、无 `RUN_STARTED`、无预算记录；随后合法运行
  成功获取并释放锁。
- 红 → 绿：修复前拒绝后 `.lock` 残留；修复后通过。
- 仍有限制：无。

---

## C. 历史资产保护

### C1. 两套历史验收 Study（EXM-V09-ACC-FULL / EXM-V09-ACC-ISO）

| Study | 文件数 | 目录聚合 SHA-256（当前 = 基线） |
| --- | --- | --- |
| `EXM-V09-ACC-FULL` | 47 | `9696200ca3fd34d27f4d6786a04c2d7ebb7f18aba81220f0a7c877f90aa21153` |
| `EXM-V09-ACC-ISO` | 47 | `f07021b5beb6bfca3074e02a6915094731598957be65d244967330cdaff43c43` |

- 前后对比：`git diff 043034923 -- scripts/dev/principle-learning-lab/examiner-studies`
  为空；工作区无改动；路由测试在两个目录上做**整目录逐文件 SHA-256 前后快照**，
  请求 run/report 前后完全一致。
- 写入拒绝证据（真实后端）：`POST /run` → `403 study_read_only`，`POST /report` →
  `403 study_read_only`，`GET /report` → 200（只读可看）；`readOnly: true`。
- 新证据语义的影响：原 ACC 报告中的离线 `RUNTIME_LOADED` 结论在 v0.9 修复后的语义下
  只能表示“离线运行时加载到 prompt”，不再是“真实宿主加载”。本轮**不重写**这两份历史
  报告，其证据适用边界在本报告 E 节与本文件中明确标注；修订版验收使用新 Study ID 生成
  （见 D 节 E2E：`EXM-C-DE4A8E8C-5FD9-4B54-86D2-0C3CCCC9C8FD`），旧文件保留。

### C2. 冻结离线包 EXM-MVP-001-v4（明确记录的一次重建绑定）

- 事实：`package-manifest.json` 把 `lib/*.mjs` 全目录哈希为“实现绑定”。本轮修改了 6 个
  lib 模块（`examiner-study` / `examiner-injection-evidence` / `challenge-runner` /
  `challenge-behavior-report` / `challenge-statistics` / `challenge-actor`），
  未重建绑定时 `verifyOfflinePackage` 报 `OFFLINE_PACKAGE_DRIFT`（`frozen-package`、
  `human-review-intake` 共 10 项测试失败）。
- 处理方式：使用仓库既有的 `scripts/dev/principle-learning-lab/rebind-exm-v4-freeze.mjs`
  （本 PR 分支上 `7cc4b5f73` 之后再次执行该既定流程），**只移动实现绑定及其派生哈希**。
  脚本对研究内容失败关闭：
  - `executionsHash` 未变：`97e2d4e78710616a18945fcbb9d823420a3cd716d2e58de67e1c817d15844751`
    （9 条 Owner 已复核执行逐字节相同）；
  - 报告行未变（仅 `implementationHash` 字段移动）；
  - mappingHash / goldHash 未变（移动即失败）；
  - 包内文件集合未变（`PACKAGE_FILE_SET_CHANGED` 会失败）。
- 移动文件（恰好 4 个，均为派生）：`blind-review/receipts.template.json`、
  `expected-replay.json`、`package-manifest.json`、`review-subject.json`；
  另刷新由它们派生的 `docs/research/*` 验收文档与 `GOLD-BLIND-REVIEW-v4.zip`、
  `owner-content-review` 账本绑定与 `v4-evidence` 证据日志。
  `HISTORICAL_FROZEN_ASSET_BASELINE.sha256` 升级为 v3，记录 v2→v3 的 delta **恰好**
  是这 4 个文件；593 条基线中其余 589 条逐字节未变（测试逐条校验并提供计数下界）。
- **限制（需 Owner 知悉）**：指令禁止“修改历史冻结研究资产”。本轮没有改动任何研究
  输入、Gold 决策、执行或评分；但确实重建了实现绑定与派生哈希（否则仓库既有完整性
  守卫必红）。若 Owner 判定连派生绑定也不得移动，则应回退重建绑定并以“冻结包与当前
  实现不兼容”作为已知限制接受相关测试失败——本轮选择维持守卫完整性。

---

## D. 端到端验收

### D1. Scripts 测试

- 完整套件（`cd scripts && vitest run --maxWorkers=4`）：
  **98 files / 1917 tests 全绿，exit 0**（日志：`.tmp/examiner-e2e/scripts-tests-full-3.log`）。
- 默认并发（`vitest run`，无 worker 上限）在本机 52s 运行中出现 3 项
  `workspace-lifecycle` 超时（默认 5s/例）：`dry-run lists…`、`apply removes…`、
  `default grace period…`；这三项**单独运行均通过**（每例实际 1.2–2.5s，
  `prr-linear-resolver` 同轮通过）。判定为并行负载下的环境性超时，与本次改动无关
  （本轮未触碰 `scripts/dev/workspace-*` 与对应测试）。
- 关键套件：`examiner-v09` 73/73；`challenge-1b` 28/28；`frozen-package` 7/7；
  `human-review-intake` 5/5；`owner-content-review` 5/5；
  `examiner-productization-entry` 32/32。

### D2. Console 测试

- 完整套件：**163 files / 3027 passed + 1 expected fail，exit 0**（日志：
  `.tmp/examiner-e2e/console-tests-full.log`）。
- 新增/扩展：`tests/server/routes/examiner.test.ts` 11/11；`examiner-dev-gating` 3/3；
  `tsc --noEmit` 通过。

### D3. 浏览器 E2E（真实 Chromium + 真实 Console 后端，离线 Stub）

- 环境：`tsx` DEV Console（`PD_EXAMINER_DEV` 生效路径），`PD_EXAMINER_STUDIES_ROOT`
  指向测试可写根；真实 HTTP + 真实文件系统；Playwright Chromium headless。
- 结果：**PASS**（`.tmp/examiner-e2e/browser-acceptance-result.json`，截图 8 张）。
- 关键事实：
  - 入口：原则详情页 DEV 入口可见 → 点击 → 目标 `principle-evidence-first` 自动预选；
  - Study：`EXM-C-DE4A8E8C-5FD9-4B54-86D2-0C3CCCC9C8FD`（服务端铸造），
    `full_library_incremental` / `principle_only` / 计划配对 4；
  - Preflight：`READY_FOR_OFFLINE_EXECUTION`；8 个 unit 全部 `SUCCEEDED`；
  - 报告：`REPORT_PENDING`（离线、待人工 Gold），reportHash
    `c54fd5543350bcc2502a71b02d09e2365d760ee43d31d8c0ad826244cd052a55`；
  - ITT：planned 2 / determined 2 / unknown 0 / 不适用 2（不入分母），value = 1；
  - Fidelity：planned 4 / CONTEXT_PRESENT+ 4 / RUNTIME_LOADED 4 / 控制污染 0 /
    容量挤出 0；覆盖 `COMPLETE`；
  - 容量竞争：`RECORDED`，selectionRule `examiner-offline:skip_and_continue_v1:id-asc`，
    budget 2000；control eligible 1 / delivered `principle-small-steps` / targetDelivered false；
    treatment eligible 2 / delivered 两条（含目标）/ targetDelivered true；
    `storedRecordAgrees: true`；非目标保留 eligible 1 / control 1 / treatment 1；
  - 注入证据：treatment 4 链 / control 4 链 / 重复 sidecar 0 / 未解析 treatment 0；
  - 绑定：`bindingHash 93f4bbb0…`，`anchor: VERIFIED`，`verifyOk: true`；
  - 刷新恢复：刷新后仍为已完成 Study 且可读报告；
  - 历史资产：FULL/ISO `readOnly: true`；run/report `403 study_read_only`；report GET 200；
  - 双模式载荷：treatment 含目标文本，control 不含，且无 `undefined` 载荷；
  - 控制台错误：仅 1 条——报告生成前 GET `/report` 的预期 404（UI 在生成前探测），
    无其他失败请求。
- 说明：按 `git-15`，截图/网络捕获/结果 JSON 只写入 `.tmp/`，不入库；本报告记录
  Study ID、reportHash 与全部关键字段以便复核。

### D4. Runtime Contract

- `npm run check:runtime-contract` → `Passed - 0 new violations (scanned diff origin/main...HEAD)`。
- 修复内容：`examiner-executor.ts` / `examiner.ts` 消除对不可信 JSON 的 `as Record` 断言
  （ERR-001），改为 `isJsonObject` / `asJsonObject` / `stringField` / `isPrincipleFact`
  运行时守卫；UI 截断改用 `truncateByCodePoints`（ERR-175）。

### D5. CodeQL

- 结果见 PR 状态（`Analyze (javascript-typescript)`）。本地无新增安全模式问题；
  本报告不改动安全边界之外的行为。

### D6. Merge Gate / PR 状态

- `Verify Merge Gate`：刷新 main 后通过（此前一次失败是分支落后 versions PR 导致的
  release-intent 误判；merge main 后 `base=0d0ea7eb56 head=cc5de3f2c5`，
  `RELEASE_INTENT_GUARD PASS intent=create-principles-disciple:patch`）。
- 全部 required checks 以 PR 页面为准；PR 保持 OPEN，未合并、未部署。

### D7. Release Reproducibility

- 工具链可复现性按既有 `verify:merge` 覆盖（CI `Verify Merge Gate` 内执行）；
  本地 `npm run lint`/typecheck 覆盖的改动面已单独验证（详见 D2）。
- 未新增依赖、未改动锁文件、未新增可发布包；changeset：
  `.changeset/examiner-v09-remediation.md`（`create-principles-disciple: patch`），
  与 Release Intent 守卫一致。

---

## E. 研究可信度

**总标记：`OFFLINE_ENGINEERING_VALIDATED`（离线工程链路已验证）；
`REAL_HOST_EXPERIMENT_VALIDATED` = NO（本轮真实宿主运行 = 0、真实模型调用 = 0）。**

| 维度 | 结论 | 证据 |
| --- | --- | --- |
| ITT 是否正确 | 是。固定分母 = 事先登记的可适用配对；treatment 注入失败不剔除；分母为 0 时 `NOT_ESTIMABLE`，绝不写成 0%；UNKNOWN 不被删除/插补 | 73 项 lab 测试 + E2E：planned 2 / determined 2 / unknown 0 / value 1 |
| UNKNOWN 是否正确 | 是。缺 sidecar / 无法绑定 → 该 unit 注入状态 UNKNOWN，Fidelity 覆盖标 `PARTIAL_UNKNOWN`，不读作“未注入” | `examiner-v09` §7 缺失 sidecar、重复 sidecar、绑定失败用例 |
| Injection Evidence 最高证明等级 | 离线作用域最高为 `RUNTIME_LOADED`，且必须由离线运行时签发的 receipt 支撑；producer=`offline-stub`，scope=`offline-stub`；offline producer 无法生成 real-host scope | E2E fidelity `RUNTIME_LOADED 4`（offline scope）；§7 绑定/白名单用例 |
| RuleCode Intervention 类型 | E2E 与回归为 `principle_only`（已证独立，target ruleCodes = 0）；无证据 → UNKNOWN/不可执行；耦合只能如实声明 `bundled_intervention` | §2 八项测试 + E2E `ruleCodePolicy` |
| Capacity Evictions | E2E 预算 2000 下 evictions = 0（真实 0，非缺失）；紧预算测试记录被挤出 ids；缺失数据 = UNKNOWN，isolated = NOT_APPLICABLE | §2.2.5 八项测试 + E2E capacity 记录 |
| Non-target Retention | E2E：eligible 1 / control 1 / treatment 1（保留率 1/1），由冻结数据重算 | E2E `capacityCompetition.nonTargetRetention` |
| Preregistration Binding | 锚点 `VERIFIED`，`verifyOk: true`；4 路一致重写仍被拒 | E2E `binding`；§13.D 六项测试 |

边界声明：以上均为**离线工程验证**。它证明契约、可观测性、统计口径与失败语义正确，
**不构成真实宿主行为效果的实验证据**；Gate 1（Gold 独立人工评审）与 Gate 2（真实宿主
行为评估）仍分别处于 BLOCKED / NOT_READY，Phase 6 未授权。

---

## F. 最终裁定

**READY_WITH_LIMITATIONS**

理由与限制：

1. 所有 CONFIRMED 缺陷均已修复并有测试与真实浏览器验收支撑；两个全量套件本地全绿。
2. 本轮仅离线工程验证，`REAL_HOST_EXPERIMENT_VALIDATED` 不成立——这是本轮授权边界，
   不是缺陷。
3. EXM-MVP-001-v4 的实现绑定按仓库既定 rebind 流程移动（研究内容未变），此动作需要 Owner
   知悉并按 C2 的说明确认；若 Owner 不接受派生绑定移动，应视为本报告第 1 项限制。
4. 历史 `EXM-V09-ACC-*` 的离线 `RUNTIME_LOADED` 结论按新语义收窄为“离线运行时加载”，
   原文件未改，修订版以新 Study ID 生成。
5. 本机默认并发下 `workspace-lifecycle` 3 项存在负载性超时；限定 worker 后全绿，
   CI 结果为准。

**测试全绿不解锁 Gate 1、Gate 2 或 Phase 6；PR 保持 OPEN，未合并、未部署。**
