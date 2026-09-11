# PRI-729 Phase 4 — Complexity Convergence Result

| Field | Value |
| --- | --- |
| Status | 已随 PR #1601 合并（merge commit `303a1cbc`，2026-09-10，CI 32 项全绿）；未删除 legacy 代码，未改安装布局，未改 ADR |
| 后续任务 | **PRI-738**（Gate C 物理删除 legacy updater）— 其 Gate B 前置为 PRI-701（usage drain） |
| Date | 2026-09-10 |
| Source of truth | 独立工作树 @ `57f0dfebb`（= `origin/main`，PR #1600 合并点） |
| Companion docs | `PRI-729-release-manager-adoption-audit.md`（Phase 1）、`PRI-709-migration-readiness-report.md` |
| Governing ADR | ADR-0023、ADR-0024（D-1 / D-2 / D-7，均未修改） |

---

## 1. 新生产路径（本 commit 之后的形态）

```
Console API  /api/update/{check,apply,apply-full,rollback}      (server/index.ts:455, update.ts:2324)
    |
    v
MutationController.dispatch                                      (mutation-controller.ts)
    |
    +-- release-manager  (PREFERRED, always consulted)  ---------- check / apply-full  when ready + flag on
    |        |
    |        v
    |   ReleaseManager.check() / apply()
    |        |
    |        v
    |   Installer.install()            <-- 唯一 direct artifact deployment authority (ADR-0024 §2.1)
    |        |
    |        v
    |   Transaction Journal  ~/.pd/transactions/<txId>.jsonl      (machine recovery)
    |        |
    |        v
    |   Update History  <ws>/.pd/update-history.json              (Owner audit, ADR-0024 D-7)
    |
    +-- legacy-console-updater  (DESIGNED COMPATIBILITY FALLBACK, explicit reason required)
             |
             v
        routes/update.ts mutation implementations (to be deleted in PRI-738)
             |
             v
        Transaction Journal (same file, actor=console-updater) + Update History (same writer)
```

与任务书目标路径的对照：

| 任务书目标 | 当前状态 |
| --- | --- |
| Console API → MutationController | ✅ 已成立（唯一入口，无第二条路径） |
| MutationController → ReleaseManager | ✅ 已成立（每请求对 4 个 kind 全部咨询 RM，preferred 优先） |
| ReleaseManager → Installer → Journal → History | ✅ 在 RM 服务时成立（`apply-full`；`check` 只读） |
| 「不再执行 legacy updater」 | ❌ **未成立**：4 个 kind 在现存安装上仍全部由 legacy 执行（阻塞点 B1–B4） |
| 「只有明确设计的兼容 fallback」 | ✅ **本次交付**：封闭 reason 词汇 + 类型级约束 + 运行时 fail-loud + 枚举完备测试 |

---

## 2. 复杂度收敛检查（Phase 4 要求的四项搜索）

| 搜索项 | 命中（非测试 / 非 dist） | 结论 |
| --- | --- | --- |
| `legacy-console-updater` | `mutation-controller.ts:35`（常量定义）、`:18`（注释）、`legacy-mutation-journal.ts:156`（未验证 digest 的标记前缀）、`update-history.ts:138`（authority 默认值注释）+ 历史文档 | 只作为**身份标识**存在，不再作为任何 authority 的解析结果之外的路径 |
| `legacy updater` | `update.ts` 内的 fallback 注释/日志、`mutation-controller.ts` 文档 | 只出现在「兼容 fallback」叙事里 |
| `update-history` | console：`routes/update-history.ts`（唯一 Owner 写入 + 读取）、`server/index.ts:442`（路由）；cpd：`update/update-history.ts`（SPEC §12，唯一消费方 = `legacy-migration.ts`，**无生产接线**） | 双流仍并存，但各自单一写入方；console 流已是唯一 Owner 可见流 |
| `appendUpdateHistory` | 定义 `routes/update-history.ts:143`；调用 15 处（全部在 `update.ts` 的 legacy 实现内）+ 1 处 RM-served 边界（`update.ts:2133` `appendGovernedUpdateHistory`） | 唯一 writer，两条 authority 共用；legacy 调用点即 PRI-738 待删代码 |

**判定**：legacy 已不再是**入口**（入口只有一个：MutationController），但仍是**执行者**。因此本任务的定位是「单一入口 + 显式设计的兼容 fallback」，而非「legacy 退出生产」。

---

## 3. 剩余 legacy 代码位置（PRI-738 的删除面）

| 位置 | 内容 | 删除前提 |
| --- | --- | --- |
| `pd-console/src/server/routes/update.ts` | 全部 mutation 实现（`doCheckForUpdates` / `doApplyUpdate` / `doRollbackUpdate` / `doInlineFullUpdate` + 15 处 `appendUpdateHistory` 调用）与 4 个 `legacy*Mutation` handler | B1–B5 全闭 |
| `update.ts:1974-1977` | legacy 的 4 个 kind 注册 | 同上 |
| `update.ts:2141-2255` | RM-served `apply-full` dispatch（含 pre-transaction fallback 分支） | 保留 —— 这是目标路径，不是 legacy |
| `update.ts:1827-1968`、`2027-2032` | `runLegacyJournaledMutation` 包装 / `fallbackToLegacyForAllKinds` | 收敛为「无 fallback」后可删 |
| `pd-console/src/server/update/legacy-mutation-journal.ts` | legacy 事务 journal 覆盖（PRI-709 P0-3） | 随 legacy handler 一起删 |
| `pd-console/src/server/update/mutation-controller.ts:35` + 词汇表 | `LEGACY_MUTATION_AUTHORITY` 与兼容 fallback 词汇 | 随 fallback 一起删 |
| `pd-console/src/server/routes/update-history.ts:151` | `authority ?? LEGACY_MUTATION_AUTHORITY` 默认值 | 改为必填后删默认 |
| `create-principles-disciple/src/update/legacy-migration.ts` | dual-slot 迁移 | **不可删**：它是 B2 的解，需先接线为生产消费方 |
| 测试：`tests/server/routes/update.test.ts`（3362 行）、`tests/server/update/apply-extension-copy-sync.test.ts`、`tests/server/update/legacy-mutation-journal.test.ts`、wiring 测试的 legacy 分支 | legacy 行为特征化 + journal 覆盖 | 随代码一起删（PRI-738 显式授权） |

---

## 4. PRI-738（删除 legacy）前置条件

与 Phase 1 审计 §7 一致，逐条可验证：

1. **B1 签名元数据发布管线**：CI 产出 `channels/<ch>.json` + 签名 release target + artifact manifest，并接通操作者供给面（`~/.pd/install.json` 的 `releaseMetadataUrl` 或 env）。**当前不存在**（`.github/workflows/` 无发布步骤）。
2. **B2 dual-slot 迁移接线**：`legacy-migration` 作为一次显式 updater 事务接入安装/更新路径，使 RM 的服务面从 0% 扩到 100%。**当前零生产消费方**。
3. **B4 Phase 2 rollback**（same-version restore）：证明并翻转 `ROLLBACK_AVAILABLE`；在此之前 `/api/update/rollback` 必须留 legacy（否则 UI 回滚入口直接失效）。
4. **B3 `/apply` 增量 kind 的裁决**：移植进 RM payload 体系，或 UI 降级为 `apply-full`。
5. **B5** installer-only `bundled-…` releaseId → 缓存元数据映射。
6. 以上全部关闭、且 RM 在真实安装上跑过完整生命周期（check → apply-full → failure → rollback）后，才可物理删除 §3 的代码。

> 关键提醒：`legacy-migration.ts` 出现在 §3 表格里但**不可删** —— 它当前无生产接线，正是 B2 未解的证据，而不是「待清理的历史代码」。PRI-738 不得顺手删它。
>
> **编号更正**：本文初稿将删除 legacy 的后续任务写作 `PRI-730`，但该编号在 Linear 上属于另一件已完成的任务（runtime-v2 公共面收敛）。正确的后续任务是 **PRI-738**（Gate C 物理删除），本文所有引用已更正。

---

## 5. 验证记录

全部在本工作树 @ `57f0dfebb` 上执行（`CODEBUDDY_SAFE_DELETE_ENABLED=0`，`npm_config_script_shell` 指向 git-bash）：

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| build | `npm run build` | ✅ EXIT=0 |
| lint | `npm run lint` | ✅ EXIT=0（仅 10 条既有 ignore warning） |
| typecheck | `npm run typecheck:pd-console` / `:pd-companion` / `:openclaw-plugin` | ✅ 三者 EXIT=0 |
| pd-console 单元 + 集成 | `vitest run`（`packages/pd-console`） | ✅ 120 文件 / 2537 passed + 1 expected-fail |
| pd-console integration 目录 | `vitest run tests/integration` | ✅ 8 文件 / 105 passed + 1 expected-fail |
| cpd 全量 | `vitest run`（`packages/create-principles-disciple`） | ⚠️ 18 failed / 608 passed / 21 skipped —— **与本次改动无关**（见下） |
| merge 门禁 | `npm run verify:merge` | ✅ EXIT=0 |

**cpd 的 18 个失败是环境性既有失败，非本次引入。** 证据：把本次改动的 2 个 cpd 文件临时还原为 `HEAD` 版本后重跑同一命令，结果**逐字相同**（18 failed / 608 passed / 21 skipped）。失败全部落在本机无法完成的 TUF 签名链验证与打包冒烟路径上（`trust-metadata*`、`release-manager*`、`release-asset-smoke`、`smoke-packaged-install`、`release-manager-install-smoke`、`bdd/update-system`），与本次触及的 `release-manager-authority.ts` 的路由/readiness 逻辑无交集。

本轮新增/修改的测试（全部通过）：

| 文件 | 覆盖 |
| --- | --- |
| `pd-console/tests/server/update/mutation-controller.test.ts`（+3） | 封闭 fallback 词汇表的声明完备性；未声明 reason 被 fail-loud 举报且仍可观测 |
| `pd-console/tests/server/update/release-manager-authority-wiring.test.ts`（+6） | check（Companion 契约字节一致）/ apply-full（RM 被调用 + 不重复 journal + history）/ failure（可追踪 + history failure + 不回退）/ rollback（显式降级 + 无第二 authority + `RM.rollback()` 未被调用）/ 降级枚举完备 / 路由变更 fail-loud |
| `create-principles-disciple/tests/release-manager-authority.test.ts` | `apply` 的阻塞原因拆分为独立的 `plugin_diff_not_supported`（不再与 rollback 混同） |

---

## 6. 与成功标准的差距（诚实结论）

任务书成功标准为「PD 更新系统已经进入单一生产 authority 状态」。以当前 commit 的代码事实衡量：

- ✅ **单一入口**：成立。
- ✅ **单一 preferred authority + 显式设计的兼容 fallback**：成立，且本任务把「设计」从文档约定升级为类型与测试约束。
- ❌ **单一执行 authority**：不成立。RM 对现存安装的 3 个 kind（check / apply-full）因 B1+B2 不可达，对 2 个 kind（apply / rollback）因 B3+B4 结构性不支持。

⇒ **本轮交付的是「收敛边界」，不是「收敛完成」。** PRI-738 的删除动作必须等 §4 的 6 条前置全部关闭；在那之前，任何删除都会把显式降级变成静默故障。
