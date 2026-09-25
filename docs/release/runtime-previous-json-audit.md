# PRI-921 — `~/.pd/previous.json` 幽灵槽位 Reality Audit（只读）

日期：2026-09-25 ｜ 基线：origin/main `487a4c678` ｜ 性质：只读审计，零生产代码改动

---

## Owner Review Card

### 1. Problem

PRI-920 拓扑审计（R-4）发现：install-layout 声明了 `previousRecordPath = ~/.pd/previous.json`，
但从未确认它是不是一个真实的 runtime 机制。本审计回答唯一问题：

> previous.json 当前到底是不是一个真实存在的 runtime 机制？

### 2. Evidence（file:line + git commit）

**引用面（全量，`previousRecordPath` / `previous.json`）：**

| 文件 | 行 | 类型 | 行为 |
| --- | --- | --- | --- |
| `packages/create-principles-disciple/src/update/install-layout.ts` | 40, 58 | 声明 | layout 路径定义 `~/.pd/previous.json`；头部注释 §5 列出该文件 |
| `packages/pd-console/src/server/routes/update-transaction.ts` | 173 | **生产 reader（唯一）** | recovery/resolve 端点 `readActiveRecord(paths.previousRecordPath)` 喂给 `recoverUnfinishedTransaction` |
| `packages/create-principles-disciple/src/update/transaction-journal.ts` | 380-470 | 纯函数消费者 | `recoverUnfinishedTransaction` 以 `previousRecord` 为入参（非文件耦合） |
| `packages/create-principles-disciple/tests/bdd/update-system.steps.ts` | 132, 333 | test writer+reader | fixture 用 `copyFileSync(active→previous)` **手工制造**前置态，驱动 `old_confirmed` 场景 |
| `packages/create-principles-disciple/tests/helpers/shadow-release-fixture.ts` | 206 | test writer | `writeActiveRecord(paths.previousRecordPath, …)` |
| `docs/superpowers/specs/2026-08-25-commercial-grade-update-system-design.md` | 122, 130 | 文档 | layout 清单列出 previous.json；retention 政策"current + one previous" |
| `docs/release/runtime-topology-audit.md` | 55, 103, 139 | 文档 | PRI-920 已标注"有 reader 无 writer → 幽灵槽位"（R-4，本票前传） |

**Production writer: NONE FOUND。**

穷尽证据：全仓 `writeActiveRecord(` 生产调用点仅 `installer.ts:305`（写 `activeRecordPath`）；
`previousRecordPath` 无任何生产写调用；`activeRecordPath` 相关 `renameSync`/swap 全部排除
（installer.ts:528 的 rename 是 `bootstrap/executor` 目录，与本文件无关）；
`ensurePdHomeLayout` 只建目录不建文件。

**Git 考古（`git log --all -S"previous.json"` / `-S"previousRecordPath"`）：**

| commit | 日期 | 事实 |
| --- | --- | --- |
| `668c411c0` | 2026-08-25 | SPEC 硬化稿写下 layout 清单（含 previous.json）与 §5 retention "current + one previous" |
| `e26c97bdb` | 2026-08-26 | 事务式更新系统落地：**唯一的 writer 曾在此存在**——legacy 迁移码 `fs.copyFileSync(activeRecordPath, previousRecordPath)` |
| `8eefee1e1` | 2026-08-26（同日 review round 1） | **writer 被有意删除**，理由注释："No previous.json: a freshly migrated installation has exactly ONE slot. Copying the generation-1 record here would let a rollback 'succeed' as a no-op onto the same release while reporting a switch."（同代回滚=假成功） |
| `4bb835813` | 2026-09-17 | PRI-738 legacy updater 退役，连带删除含该注释的整段迁移码 |
| `d9a67f0b4` | 2026-09-19 | PRI-853 "retained-previous"：生产 reader 在此加入（console recovery/resolve 端点）；retention 实现为**备份目录套数修剪** `retainSupersededBackup`（`runtime.backup.*` / `principles-disciple.backup.*`），不写 previous.json |
| `e92848dd5` | 2026-09-19 | PRI-853 review fix：数据兼容 preflight 明确改锚 **active.json**，注释点名 "Not previous.json …absence must never silently disable the check" |

**"先前版本"的真实权威（替代机制，三件套）：**
1. `active.json.previousReleaseId` 字段（installer.ts:309/319/332；schema 校验 transaction-journal.ts:329-351）；
2. 磁盘备份套 `~/.pd/backups/…runtime.backup.*`（retainSupersededBackup 保新删旧）；
3. `logs/history.jsonl` 发布历史（update-history.ts:35/148）。

**实机取证（只读探测本机真实 `~/.pd`）：** `active.json` 存在、`previous.json` 不存在——与"无 writer"一致。
2026-09-25 补全深度扫描：`find ~/.pd -name previous.json`（含 6 个 release 树、7 个 staging 目录、全部
transactions 模板与 `transactions-superseded-*`）零命中；插件 shell `~/.openclaw/extensions/principles-disciple/`
亦无。本机无任何残留，§5"老机器残留"场景在本工作区不成立。

### 3. Current Reality

- 生产 writer 数量：**0**（历史存在 1 天，2026-08-26 当天被删，此后再未出现）
- 生产 reader 数量：**1**（console `POST /api/update/recovery/resolve`）。在**正常安装布局**（无 writer ⇒ 文件不存在）下恒读到 null（`readActiveRecord` 缺文件返回 null，transaction-journal.ts:302）；注意这是"文件不存在"的推论而非 reader 的性质——若某台机器存在残留/伪造的合法格式 previous.json，旧 reader 会读到非 null 并可能改变恢复裁决（见 §5 负风险）。本工作区真机扫描零残留（§2）。
- 缺失时行为：系统**正常继续**——`recoverUnfinishedTransaction` 的 null 分支是设计内路径：
  - 多数场景 fallback 到 `activeRecord`（`fallback = previousRecord ?? activeRecord`，:457）；
  - 仅"首次激活即中断且无 active"这一最坏场景走 `explicit_refusal`，nextAction 指回 installer——降级是响亮且正确的。
- 生命周期四场景：
  - **A 首次安装**：不创建（`ensurePdHomeLayout` 只建目录；`commitInstallerActiveRecord` 只写 active.json）。
  - **B 升级**：不参与。升级链读的是 active.json 的 `previousReleaseId` 与备份目录；`retainSupersededBackup` 实现 §5 retention。
  - **C 修复/恢复**：recovery 决策函数**接受**该入参，但生产中恒为 null；repair 流程无任何 previous.json 依赖。
  - **D 卸载**：不处理。uninstaller 设计原则是"never delete user workspace / .pd 状态"（uninstaller.ts:5-7），ghost 若存在则原样残留（惰性数据，无人读它除 recovery 端点）。
- 测试面：BDD `commercial-update-system.feature:40-41` 的 `old_confirmed` 场景由 fixture `copyFileSync` **制造生产无法产生的前置态**；纯函数单测（transaction-recovery.test.ts 等）直接传对象入参，与文件无关，合法。

### 4. Classification

## **B — Deprecated Mechanism**（附带一处 C 型文档漂移）

判据逐项核对：
- 曾经存在：✔ e26c97bdb 的迁移 writer（1 天）；
- 当前没有生产用途：✔ 0 writer；唯一 reader 恒得 null，null 分支与"文件不存在"完全等价的退化行为；
- 有替代方案：✔ previousReleaseId 字段 + backup 套 + history.jsonl 三件套承载全部"先前版本"语义，且 PRI-853 review fix 已明确弃锚 previous.json；
- 8eefee1e1 的删除是**有理由的退役**（防假回滚），不是遗忘。

不是 C 为主：代码里确有活路径（声明+reader），"文档提到而代码不存在"只命中子集——SPEC §layout/§retention 文案与 install-layout.ts:13 头注释仍把 previous.json 列为布局成员，属**次级文档漂移**。
不是 A：无 writer、无生命周期价值即不成立。不是 D：它没有任何"未来要用"的登记意图，退役理由至今有效。

### 5. Risk（错误处置的影响面）

- **保留不动**（现状）：install/upgrade/rollback/repair 均不受影响；代价是永远存在一个"永远为 null 的恢复入参"和一条 BDD 场景在模拟不存在的机制——认知税，非故障源。
- **直接删文件**（若某台老机器残留）：reader 得 null → 行为与现状逐位相同。风险≈0；残留文件本身无害。
- **真正的负风险——被写入假 previous.json**：recovery 决策会因此从 `explicit_refusal` 翻转为 `old_confirmed` 并指向伪造的 releaseId/generation（:441-450）。该文件无任何 writer 守护、无 schema 锚、不在 digest 覆盖面内——一旦有 bug 或恶意写入，它是**唯一能改变恢复裁决的未设防输入**。此风险随"保留槽位"而长期存在，是退役论的最强证据。
- **删除 reader 入参而不退役路径**：`recoverUnfinishedTransaction` 签名与 console 端点属已发布契约（update-state-contract.test.ts 钉住），牵动 pd-console，须走正式票。

### 6. Recommendation

```
Recommendation:
Deprecated. Create retirement ticket (不并入其它任务).
```

退役任务应一次做齐（均为生产代码，故本票不实施）：
1. 从 `PdHomePaths` 删除 `previousRecordPath`（install-layout.ts:40/58 + 头注释:13）；
2. `recoverUnfinishedTransaction` 去掉 `previousRecord` 入参并收敛 null 分支（保留 activeRecord fallback）；
3. console recovery/resolve 端点同步瘦身（动契约，走 changeset）；
4. BDD fixture 删除 copyFileSync 桥，`old_confirmed` 场景改由 journal + active 表达（或随决策分支删除）；
5. SPEC/文档同步：`commercial-grade-update-system-design.md` §122/§130 加"superseded: previousReleaseId + backup sets"勘注（文档漂移部分可先行，属低风险独立项）。

备选（Owner 若判定恢复裁决要留多槽余地）：反向补齐 writer + 纳入 digest/零数据守护——但这与 8eefee1e1 的假回滚理由正面冲突，不推荐。

### 7. Follow-up（只列不做）

- FU-1：退役票（上述 1-4，pd-console 契约变更 + changeset，N-3 release-intent 注意）；
- FU-2：文档勘注（第 5 点，可与 FU-1 同票或先行独立小票）；
- FU-3：若未来出现任何"真实 previous.json"的机器取证需求，先查 e26c97bdb 是否在 2026-08-26 当天被任何发布载体携带（当前判断：窗口不足一天，npm 首发 2.0.x 在此之后，基本不可能）；
- FU-4：PRI-920 §8 的 R-4 幽灵槽条目在退役票合并后回标已收口。

---

## 附：最终汇报

```
PRI-921 Audit Complete
Changed: none
Created: docs/release/runtime-previous-json-audit.md
Finding: previous.json classification: B (Deprecated Mechanism; 附一处 C 型文档漂移)
Recommended next action: 建退役票（§6 五步），Owner 决策后执行。
```
