# PRI-659 — Update Surface Contract Map

> **Status**: Living document（随迁移阶段更新）
> **Date**: 2026-09-04
> **Baseline**: `origin/main` @ `3bed0856`（PR #1496，ADR-0023 已合并）
> **Governed by**: ADR-0023（PD Installation Architecture Decisions）、ADR-0024（PD Runtime Mutation Governance，D-1：console updater 收敛为 ReleaseManager 触发器/呈现层）
> **Task**: PRI-659 Console updater migration toward Runtime Mutation Governance

---

## 1. 方法与证据口径

本地图的全部结论来自**源码实读**（2026-09-04，基于 `3bed0856`），不以文件名、Linear 描述或旧审计推断。关键证据点：

- Console 路由挂载：`packages/pd-console/src/server/index.ts:441-457`
- Console updater 实现：`packages/pd-console/src/server/routes/update.ts`（1318 行）
- Console 私有 history：`packages/pd-console/src/server/routes/update-history.ts`
- Companion 启动/轮询：`packages/pd-companion/src/main/main.ts:8`（spawn `pd console open`）、`main.ts:675`（`updateCheckTick`）
- CLI 命令注册：`packages/pd-cli/src/index.ts`（全部 `.command()` 逐一核对）
- Installer 命令：`packages/create-principles-disciple/src/index.ts:454-503`
- ReleaseManager：`packages/create-principles-disciple/src/update/release-manager.ts`

---

## 2. Contract Map（Surface × Authority）

| Surface | Current Authority | Mutation（对 runtime 的写操作） | Future Authority（ADR-0023/0024 目标） |
| --- | --- | --- | --- |
| Desktop Console（pd-companion） | **无**（零 mutation；只做 check 轮询 + 系统通知，跳转 Web UI 更新页） | 无。electron-updater 未接线（`build:{}`、src 零引用） | ReleaseManager（触发器/呈现层，同 Web Console） |
| Web Console（UI + server routes） | **legacy console updater**（`routes/update.ts` 内联实现） | **直接写**：npm registry tarball → 解包 → staged `.update` → backup-rename swap → `rmSync` dist。**零 digest 校验、零 journal** | ReleaseManager（D-1：console 收敛为触发器与进度呈现层） |
| CLI（pd-cli） | **无 update/install/rollback 命令**（逐一核对注册，见 §4）。`pd console open` 只 spawn server；`runtime artifact-repair` 为 dry-run 计划器（写 CWD 的 migration-plan.json，不触 runtime/state.db） | 无直接 mutation | ReleaseManager（CLI 侧触发器，远期） |
| Installer（create-principles-disciple） | **installer 本体**（`install`[默认,hidden] / `uninstall` / `status`；更新=重装 install） | 直接写：backup-rename-swap + digest 校验（trust-metadata / release-asset-manifest），**不写 journal** | ReleaseManager 调度 + installer 执行（ADR-0024 §2.1 "only direct artifact deployment authority"） |

**结论**：今天**唯一未经 digest 校验即可改写 runtime 的活跃路径**是 Web Console 的 legacy updater（apply / apply-full / rollback）。这是 ADR-0024 D-1 的直接治理对象，也是本任务迁移的起点。

---

## 3. 调用链（实测）

### 3.1 Desktop Companion（只读消费）

```
Companion 启动
  → spawn `pd console open --json --no-browser --no-auth`（main.ts:8）
  → ConsoleSupervisor 监护子进程
  → 定时 updateCheckTick()（main.ts:675）
      → GET http://127.0.0.1:<port>/api/update/check
      → parseUpdateCheckResponse() 校验响应体
      → 有新版本 → 系统通知「点击前往更新页」→ showWindow('#/update')
  → 【不调用 apply / rollback / apply-full】
```

**依赖关系**：Companion 依赖 console 的 `/api/update/check` **响应契约**（`hasUpdate/currentVersion/latestVersion/codexInstalled`），不依赖 updater 实现。本任务保证该契约零变化。

### 3.2 Web Console（唯一活跃 mutation 路径）

```
UpdatePage.tsx（#/update 页）
  → ui/api.ts: fetchUpdateStatus()      → GET  /api/update/check
            fetchApplyUpdate()          → POST /api/update/apply      {targetDir?, mergeStrategy, createBackup}
            fetchApplyFullUpdate()      → POST /api/update/apply-full
            fetchRollbackUpdate()       → POST /api/update/rollback   {targetDir?, backupDir}
  → server/index.ts:441-457 挂载
      GET  /api/update/history  → handleUpdateHistoryRoute（update-history.ts，workspace .pd/update-history.json）
      /api/update/*             → handleUpdateRoute（routes/update.ts:1173）
  → handleUpdateRoute 按 subPath 内联分发：
      /check      → doCheckForUpdates()（npm registry metadata，fetchWithRetry）
      /apply      → runLegacyRuleContractPreflight()（ActivationCompatibilityReadModel）
                    → doApplyUpdate()：registry → tarball → staged → backup-rename swap → rmSync dist
                    → ensureRuntimeResolutionLinks() → appendUpdateHistory()
      /rollback   → doRollbackUpdate()：从 backup 覆盖恢复（不 rmSync 整个 target，保留 node_modules）
      /apply-full → doInlineFullUpdate()（inline tarball 下载 + 全量文件拷贝）
```

### 3.3 CLI / Installer / ReleaseManager

```
pd-cli（无 update/install/rollback 命令——已逐一核对 .command() 注册）：
  pd console …            → spawn console server（无 runtime mutation）
  pd runtime artifact-repair → PRI-555 phase 1，DRY-RUN ONLY（--confirm 显式拒绝）
  pd version              → ReleaseManager.inspect() 只读消费（version-report.ts）

create-principles-disciple CLI：
  install（默认）/ uninstall / status —— 更新 = 再次 install（reinstall 路径）

ReleaseManager（create-principles-disciple/src/update/release-manager.ts）：
  inspect() / check(channel) / apply() / rollback()
  - apply()/rollback() 显式抛 ReleaseManagerError('shadow_mode_read_only') —— Phase 4 dual-slot 前 refuse
  - check() 内含 compareWithLegacyUpdater() 阴影对照
  - 当前唯一消费方：pd version（只读）
```

---

## 4. 逐项核查记录

### 4.1 CLI 命令注册（实际核对，非文件名推断）

`pd-cli/src/index.ts` 全部注册命令中与 update 相关的核查结果：

| 候选命令 | 是否注册 | 实际身份 |
| --- | --- | --- |
| `update` | ❌ 不存在 | — |
| `install` | ❌ 不存在（在 installer 包） | — |
| `rollback` | ❌ 不存在 | — |
| `runtime artifact-repair` | ✅（`index.ts:829`，PRI-555 phase 1） | dry-run 计划器，`--confirm` 显式 refused，只写 `migration-plan.json` |
| `repair`（`index.ts:1018`） | ✅ 但属于 `candidate` 组 | `pd candidate repair`——修复 workspace candidate/ledger，**与 runtime 无关** |
| `config doctor` | ✅（`index.ts:489`） | 配置诊断，只读 |
| `console` | ✅（`index.ts:1137`） | 打开/启动 console，不写 runtime |

### 4.2 Console updater 的治理属性（现状）

| 属性 | 现状 | ADR-0024 要求 |
| --- | --- | --- |
| digest / 完整性校验 | **零**（`sha256|digest|integrity|checksum` 在 update.ts 零命中） | 必须（所有 mutation） |
| transaction journal | **零**（transaction-journal.ts 唯一消费方是 legacy-migration） | 强制契约（D-2） |
| history | 有，但为**私有实现**（`routes/update-history.ts` 的 `appendUpdateHistory` → workspace `.pd/update-history.json`） | 收敛单一实现（D-7） |
| 失败语义 | backup-rename swap，apply 失败保留备份；rollback 从备份覆盖恢复（不删 node_modules） | runtime 恒处上一已验证状态（§2.4） |
| preflight | legacy rule contract（ActivationCompatibilityReadModel）；targetDir 锁定 installed pluginDir（防 workspace 误写） | 拒绝优于静默降级（已满足该项） |
| gateway 协调 | stop/restart OpenClaw gateway（`utils/gateway.ts`，有独立测试） | 保留 |

### 4.3 测试覆盖（现有基线）

| 测试文件 | 覆盖 |
| --- | --- |
| `tests/server/routes/update.test.ts`（2395 行） | GET /check（含 degraded、drift、405）、POST /apply（版本不前进拒止、workspace target 拒止、mergeStrategy、backup、405、400）、POST /rollback（成功、405、缺 backupDir、路径越界）、fetch 失败等边缘 |
| `tests/server/routes/update-gateway-coordination.test.ts` | gateway stop/restart 协调 |
| `tests/server/routes/update-history.test.ts` | history 读写契约 |
| `tests/server/routes/update-links.test.ts` | StagedComponent / dep-link |
| `packages/pd-companion/tests/lib/poller.test.ts` 等 | Companion lib；**updateCheckTick 主进程逻辑无直接测试**（本任务不改其行为，风险记入 §7） |
| **缺口** | `/apply-full` 无专测（仅经 doInlineFullUpdate 间接触达）；controller 层（新增）需 migration tests |

---

## 5. History 双源调查（D-7 前置）

| | `routes/update-history.ts`（console） | `create-principles-disciple/src/update/update-history.ts` |
| --- | --- | --- |
| 存储 | workspace `.pd/update-history.json` | 同名同格式（`appendHistoryEvent`） |
| 消费方 | console updater（apply/rollback 后追加） + `GET /api/update/history` | installer 包（legacy 路径） |
| 差异 | 面向 updater 事件的字段裁剪 | 全量事件 |

**收敛路径（本任务不执行，防止为删代码破坏功能）**：待 ReleaseManager 接管 mutation 后，journal（机器恢复面）+ 单一 history 实现（Owner 审阅面）由 ReleaseManager 统一写入；console 侧的 `appendUpdateHistory` 改为读模型。在此之前两源并存是**已知债务**，非新增。

---

## 6. 迁移边界（Phase 1 引入）

```
现状：                                    目标（本任务落地）：
Web UI / Companion                        Web UI / Companion
    ↓                                         ↓
/api/update/*                             /api/update/*
    ↓                                         ↓
handleUpdateRoute（内联分发+实现）          handleUpdateRoute（薄分发）
    ↓                                         ↓
legacy updater 实现                       MutationController（authority routing）
    ↓                                         ↓
runtime                                  登记的 authority handler（当前唯一：legacy-console-updater）
                                              ↓
                                          runtime
```

- **MutationController**（`server/update/mutation-controller.ts`）：持有 kind → authority 登记表；preferred authority（`release-manager`）未登记/未就绪时回退 `legacy-console-updater`；dispatch 时通过响应头 `X-PD-Mutation-Authority` 暴露实际裁决，响应体契约零变化。
- **不新建第三个 updater**：legacy 实现原位保留（`routes/update.ts`），仅注册进 controller；ReleaseManager 就绪后在同一登记点接入，路由层不再改动。
- **回退安全性**：controller 只做路由裁决，自身不做任何文件变更——不构成新的 mutation authority（有专项测试断言）。

---

## 7. 风险登记

| # | 风险 | 缓解 |
| --- | --- | --- |
| R1 | Companion 依赖 `/api/update/check` 响应契约 | 响应体零变化；现有 update.test.ts + Companion poller 校验器双重保护 |
| R2 | Web UI `validateUpdateStatus` 等前端校验器对响应形状敏感 | 同上；UI api.ts 不改动 |
| R3 | `updateCheckTick` 无直接测试，重构若动其契约无守卫 | 本任务明确不改 Companion 与 check 响应；行为由契约测试锚定 |
| R4 | legacy updater 零 digest 校验在迁移期继续存在 | 已知债务，ADR-0024 D-1/D-2 后续实施任务；本任务不扩大也不掩盖 |
| R5 | 并行分支对 `routes/update.ts` 的改动冲突 | controller 引入只做"提取+注册"，实现体原位保留，diff 面最小 |
