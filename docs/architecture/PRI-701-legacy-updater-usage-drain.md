# PRI-701 — Legacy Updater Usage Drain Instrumentation

| Field | Value |
| --- | --- |
| Status | Implemented（reality-verified against current `main`） |
| Date | 2026-09-12 |
| Baseline | `fbdc563326fbf660274503bb7c8df19b1f85807f` (= `origin/main`) |
| Governing | ADR-0024（D-1 / D-2 / D-7）、ADR-0023 |
| Companion | `PRI-729-release-manager-adoption-audit.md`（§4 B1–B4、§7）、`PRI-729-convergence-result.md`（§3、§4）、`PRI-709-migration-readiness-report.md`（P0-3） |
| Delivered by | `scripts/check-legacy-updater-usage.mjs` + `scripts/__tests__/check-legacy-updater-usage.test.ts` + `.cnb.yml` 确定性检查一行 + 本章程一行 |

---

## 1. 问题（为什么需要观察）

`PRI-738`（Gate C）要物理删除 `packages/pd-console/src/server/routes/update.ts` 里的全部 mutation 实现。删除的**前置 Gate B = legacy updater usage drain**：必须能证明它**已经没人在用**，而不是"看起来应该没人用"。

PRI-729 Phase 1 审计的结论是：legacy 仍是**事实上的执行权威**（4/4 kind，见该文 §2），删除的阻塞点是 B1–B5。**结论本身没有问题，问题是它当时没有可复用的观测手段**：审计靠读代码推导"应该只有 legacy 能服务"，但没有一个命令可以回答"过去 30 天 legacy 到底被调用了没有"。

所以本任务的产出物是**观测能力**，不是功能：

> 让"legacy updater 是否还在被使用"这句话可以被一条命令、在 Owner 自己的机器上、用可复现的输出回答。

**明确不在本任务范围**：删除 legacy 代码、修改 update 行为、引入新状态源、自动迁移用户、修 B1–B5（那 5 条各自有其归属任务）。

---

## 2. 复用了什么（不新建第二套数据系统）

ADR-0024 D-2 已规定"每一次 runtime mutation 必须是一次可审计的事务"；D-7 已规定 Owner 可见的 history 与机器恢复用的 journal 分离。`PRI-709 P0-3` 把 legacy console updater 也纳入了**同一个** journal（`packages/pd-console/src/server/update/legacy-mutation-journal.ts`）。

因此判断"legacy 是否被使用"所需的事实**已经存在于磁盘上**：

```
~/.pd/transactions/<transactionId>.jsonl      ← 一次事务一个文件，append + fsync
  {"at":…, "from":null, "to":"planned",  … "detail":"actor=console-updater kind=apply-full"}
  {"at":…, "from":"planned","to":"confirmed", … "detail":"actor=console-updater kind=apply-full apply-full: Update applied successfully"}
```

`detail` 里的 `actor=` 由写入方自己写死（`legacy-mutation-journal.ts` 写 `actor=console-updater`，`installer.ts` 写 `actor=installer`），所以 **actor 是直接读取，不是推断**。census 只做一件事：读这个目录、按 actor 与终态归类、数数。

对比被否决的方案：

| 候选机制 | 结论 |
| --- | --- |
| 新增 invocation counter / 事件类型 | ❌ 第二个真值源（P4）。journal 已经记了同一件事 |
| Owner 可见 history（`<ws>/.pd/update-history.json`） | ❌ 作用域不符：journal 是机器级（`~/.pd`），history 是 workspace 级；且 PRI-702 起 history 已带 `authority` 字段，但它的完整性与生命周期（保留 50 条）不适合做计数 |
| 异步匿名 telemetry（ADR-0021） | ❌ 门控是"flag ∧ 显式同意 ∧ 非抑制环境"，需要用户同意，且聚合面在云端；治理证据不能建立在可选的用户同意之上 |
| console 日志 / `console.log` 路由行（PRI-729 加的 fail-loud 行） | ❌ 只在 authority 变更时打印、无持久化、不可回算历史 |

**连接优先于创建**（AGENTS.md P2.1）：本任务只加了一个**只读消费者**。

---

## 3. 设计四问

### 3.1 数据产生位置在哪里？

**没有新的产生位置。** 产生位置是既有写入方：

- `packages/pd-console/src/server/update/legacy-mutation-journal.ts:238`（legacy 的三 kind）；
- `packages/create-principles-disciple/src/installer.ts`（installer / ReleaseManager 路径）。

`planned` 写在 mutation 之前、`confirmed|failed` 写在之后（legacy 侧由 `runLegacyJournaledMutation` 包裹）。

### 3.2 谁消费？

| 消费者 | 怎么消费 | 频率 |
| --- | --- | --- |
| Owner（主消费者） | `node scripts/check-legacy-updater-usage.mjs` | 决策时按需 |
| `--json` | 机器可读（含 `assessment`），供未来任何门禁/报告引用 | 按需 |
| `--check` | 退出码即结论：`0` 无使用 / `1` 观察到使用 / `2` census 不完整 | 可作为门禁 |
| CNB 周审计确定性阶段 | `.cnb.yml:257`（`run scripts/check-legacy-updater-usage.mjs`） | 每周 |

### 3.3 生命周期多久？

**由既有 journal 的生命周期决定，本任务不引入新的保留策略。** journal 位于 `~/.pd/`，随 runtime 备份一起轮换（ADR-0024 D-6）。census 默认窗口 30 天（`--window-days` 可调）；超过窗口的记录仍在磁盘上，只是不计入窗口计数。

### 3.4 如何判断 God C / Gate B 可以执行？

判定规则**写死在代码里**（`assessDrain()`），三种结论：

| verdict | 条件 | 对 Gate B 的含义 |
| --- | --- | --- |
| `IN_USE` | 窗口内 ≥1 笔 legacy 终态尝试 | **Gate B 不满足**，不得删除 |
| `NO_USAGE_OBSERVED` | journal **完整可读** 且窗口内 0 笔 | drain 观测成立——**Gate B 的必要条件之一** |
| `UNDETERMINED` | 目录未创建 / 无 journal 文件 / 有文件读不动 | **不是证据**，必须补齐后重跑 |

三条关键语义（都有测试锁定）：

1. **"无法观察" ≠ "零使用"。** 目录不存在（该机器从未用过 updater）与目录为空都返回 `UNDETERMINED`。一个把读不到当成 0 的门禁不是门禁（AGENTS.md rc-9、ERR-088）。
2. **`planned` 未终态的尝试不计入，单独报 `unfinished`。** 记录可能因进程被杀而丢失终态——这会**低估**使用量。这是本设计唯一已知偏差，方向是安全的（Gate B 要证明的是"零使用"）。
3. **`refused` 不计入。** 被拒绝的事务里没有任何 mutation 跑过，计入会虚高。

`NO_USAGE_OBSERVED` 明确**只是必要条件**：B1–B5（签名元数据发布管线、dual-slot 迁移接线、rollback Phase 2、`/apply` 增量裁决、bundled releaseId 映射）全部关闭后，Gate B 才算满足（PRI-729 §4）。

---

## 4. 行为变化（改了什么 / 没改什么）

**改了什么**

| 文件 | 改动 |
| --- | --- |
| `scripts/check-legacy-updater-usage.mjs` | 新增只读 census（本任务唯一的实现） |
| `scripts/__tests__/check-legacy-updater-usage.test.ts` | 新增 27 个测试 |
| `.cnb.yml` | 周审计确定性阶段 +1 行调用（同时把 0/1/2 退出码的语义写进注释） |
| `.cnb/agents/pd-auditor.md` | §5 确定性检查清单 +1 行 |
| `docs/architecture/PRI-701-legacy-updater-usage-drain.md` | 本文 |

**没有改什么**（逐一确认）

- `packages/**` **零改动**——没有新字段、没有新事件、没有新计数器、没有新 flag；
- update 行为零变化（不新增 journal 写入、不改 `detail` 格式、不动 `appendUpdateHistory`）；
- 不新增状态源/数据库/配置文件；
- 不删除、不迁移、不修改任何用户数据（脚本只 `readFileSync`／`readdirSync`／`statSync`）；
- 不执行 journal 恢复（`recoverUnfinishedTransaction` 明确不调用）。

---

## 5. 验证

```
# 单元 + 边界测试（27 passed）
cd scripts && npx vitest run __tests__/check-legacy-updater-usage.test.ts

# 真实机器上的 census（Owner 的 ~/.pd）
node scripts/check-legacy-updater-usage.mjs
node scripts/check-legacy-updater-usage.mjs --check ; echo "exit=$?"
node scripts/check-legacy-updater-usage.mjs --json | node -e "..."
```

覆盖：legacy 三 kind 的终态尝试被计入；非 legacy（installer / 未知 actor）**不会**被误计；`planned` 未终态与 `refused` 不计入；窗口外不计入；三类 `UNDETERMINED` 障碍；`--check` 的 0/1/2 退出码；`--json` 契约；**只读副作用**（跑完目录内容不变、缺目录不被创建）。

**负向对照已执行**（ERR-088）：把 `assessDrain` 的障碍分支改成恒假、并关掉窗口过滤后重跑，**6 个测试失败**（三类 `UNDETERMINED`、窗口排除、`--check` 退出码 2、缺目录不创建）；恢复后 27 个全绿。

---

## 6. 风险与回滚

| 项 | 结论 |
| --- | --- |
| 影响更新行为 | **否**。update 路径零改动；脚本不在任何更新代码路径上 |
| 影响用户 | **否**。只读；不上报；不新增文件 |
| 只是观察能力 | **是**。唯一新增能力是"读 journal 并计数" |
| 回滚 | `git revert` 本 PR；或直接删 `scripts/check-legacy-updater-usage.mjs` 并从 `.cnb.yml` / 章程移除那一行。无持久化状态需要清理，无 migration 需要回退 |

---

## 7. Follow-up（本任务未包含）

1. **Gate B 仍需 B1–B5 全闭**（PRI-729 §4），drain 只是其中一条。
2. census 的已知低估偏差（终态写入失败的事务不可见）。若要收紧，可在写入侧把终态写入失败升级为可观测的告警——属写入面改动，需要独立任务与独立评审。
3. 本 census 只覆盖 console 侧的 legacy updater；`create-principles-disciple/src/update/legacy-migration.ts` 目前零生产接线，不在观察面内（删除它需要的是**接线**决策，不是 drain 证据）。
