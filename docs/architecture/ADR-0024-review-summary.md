# ADR-0024 Review Summary — PD Runtime Mutation Governance

> **Subject**: [ADR-0024: PD Runtime Mutation Governance](../adr/0024-pd-runtime-mutation-governance.md)（Status: **Accepted**，Owner 2026-09-04 裁决 D-1–D-7，决议记录见 ADR §5）
> **Date**: 2026-09-04 · **Mode**: 只读调查 + 架构决策文档，零生产代码修改
> **Input**: ADR-0023（Accepted，PR #1496 已合并）+ 全仓写入入口扫描

---

## 1. Runtime Mutation Entry List（Step 1 调查产物）

对 `packages/` 全量扫描 `writeFile / copyFile / cpSync / rmSync / rename / extract / install` 后，所有能触及 `~/.pd/runtime` 或安装布局的写入入口：

| # | Caller | Target path | Purpose | 事务日志 | 可回滚 |
| --- | --- | --- | --- | --- | --- |
| E1 | `create-principles-disciple/src/installer.ts` | `~/.pd/runtime/**`、`~/.openclaw/extensions/principles-disciple`、全局 bin shim、install manifest | 安装 / 重装 / 更新 | **否**（ad-hoc backup rename） | **是**（失败恢复备份，`installer.ts:567-590`）；digest 校验 ✓（trust-metadata + release-asset-manifest） |
| E2 | `pd-console/src/server/routes/update.ts` `POST /apply` | 扩展目录、console、plugin 副本、备份目录 | Web UI 触发更新 | **否** | 部分（备份目录 best-effort；`pd-backups.ts:124` rename） |
| E3 | 同上 `POST /rollback` | 同 E2 | 回滚 | **否** | — |
| E4 | `create-principles-disciple/src/uninstaller.ts`（471 行，交互式 confirm） | 全部安装位置 | 卸载 | 否 | 不可逆（破坏性，Owner 交互确认） |
| E5 | `update/legacy-migration.ts` | 安装布局（legacy → canonical） | 迁移 | **是**（唯一 journal 消费方） | 经 journal 恢复语义 |
| E6 | `pd-cli/commands/runtime-artifact-repair.ts`（PRI-555 phase 1） | **仅** `CWD/migration-plan.json`（计划文件，默认 CWD，不进 runtime） | 修复计划生成 | 不适用（dry-run，`--confirm` 显式拒绝） | 不适用 |
| E7 | `pd-cli/commands/runtime-init.ts:161` | workspace `.pd/config.yaml`（`wx` flag，不覆盖） | 初始化 workspace 配置 | 否 | 不适用（**workspace 状态，非 runtime**，列作边界对照） |
| E8 | `pd-companion/src/main/main.ts:100` | Companion 自身 state 文件 | 外壳状态 | 否 | 不适用（**证实 Companion 不是 runtime 写入者**，09-03 事件中是受害者） |
| （影子） | `update/release-manager.ts` `apply()/rollback()` | （设计目标：runtime 整体 release） | 事务化激活 | 设计即 journal | **shadow mode**：显式抛 `shadow_mode_read_only`，等 Phase 4 dual-slot |
| （未接线） | `update/bootstrap-protocol.ts`、`update/rollback-policy.ts` | — | 启动协议 / 宿主协调回滚决策 | — | **零外部消费方** |

## 2. 当前事实（关键项）

- **F1** installer 是唯一做 digest 校验的写入者（`trust-metadata.ts`、`release-asset-manifest.ts` 均只被 installer 消费），但不写 journal。
- **F2** console Web updater **零 digest/完整性校验**（源码 sha256/digest/verify 零命中），信任基础 = npm registry + semver；有自己的 `appendUpdateHistory`（`routes/update-history.ts`），与 `update/update-history.ts` 并存。
- **F3** `transaction-journal.ts`：11 态状态机（planned/downloaded/verified/staged/probed/activated/host_verified/confirmed/rolled_back/refused/failed）+ 6 种 kind（update/reinstall/explicit_downgrade/rollback/legacy_migration/recovery），原子写、恢复感知读取——**基建完备，但唯一消费方是 legacy-migration**。
- **F4** ReleaseManager `apply()/rollback()` 抛 `shadow_mode_read_only`，注释明确等 "dual-slot transaction rollout"（Phase 4）；`pd version` 的 version-report 是其唯一只读消费方。
- **F5** `runtime-artifact-repair`（PRI-555 phase 1）：只读连接（`bootstrapIfMissing=false`，ERR-023）、歧义一律 `needs_human_review`、plan 默认写 CWD、**不写 runtime**；执行器不存在。
- **F6** console updater 有 legacy rule contract preflight（`ActivationCompatibilityReadModel.scan()`），拒绝会静默破坏 rule 语义的更新——这是目前唯一与 workspace 语义联动的 preflight。
- **F7** `update-history` 事件已实际落盘（workspace `.pd/update-history.json`，审计期间观察到）。
- **F8** 09-03 污染事件：三个占位文件由外部写入（见拓扑审计报告），其中 `core/dist/index.js`、`plugin/dist/bundle.js` 至今未恢复——本 ADR 的修复面纪律生效前，任何"顺手修复"都是被禁止的。
- **F9** ADR-0023 Decision 1 将 repair tool 列为合法写入者，但其审查报告 Q-A 明确边界未定义——本 ADR 即对该开放问题的回应。

## 3. 风险（只列事实与推论，不含修复动作）

1. **双更新器并存**（E1 vs E2）：同一 runtime 有两条更新路径，校验强度不同（digest ✓ vs ✗），审计源不同（无 vs 私有 history）。Web Console 一个按钮（可能 `--no-auth` 模式）即可触发无 digest 校验的覆盖写。
2. **repair executor 落地即风险敞口**：PRI-555 phase 2 一旦实现执行器而不接 journal/digest 纪律，它将成为比 console updater 更特权的写入者（直接面向 runtime artifact）。
3. **shadow mode 的窗口期**：ReleaseManager 的规范化路径要等 Phase 4，期间所有 mutation 走 E1/E2 的"弱纪律"路径——治理规则不能等 Phase 4 才生效，必须先约束现有写入者。
4. **journal 无消费方 ≠ 无用**：transaction-journal 的存在使"接入成本"极低（追加 kind `repair` 即可），真正的成本在于约束 E1/E2 改造——这是政治/流程成本，不是技术成本。
5. **`migration-plan.json` 默认落 CWD**：计划文件含 artifact 路径与 digest，落点不受控（可能进 git 或被误当作 runtime 内容），属次要卫生问题。

## 4. 推荐方案（对应 ADR-0024 §2，非决策）

一句话版：**"一个授权集、一份事务契约、一条修复流水线、单一审计源"**。

1. 合法写入者收敛为：installer（唯一执行者）+ ReleaseManager 触发器（console 降级为触发与呈现）+ repair executor（plan → Owner approval → execute）。
2. 所有写入必须进 11 态 journal（追加 `repair` kind），记录 actor/reason/timestamp/before-after digest/rollback point。
3. repair 沿 PRI-555 已有的 plan/execute 分离：plan 已就绪且质量好，执行器必须只消费 plan、走 installer 同款 swap+digest、Owner 批准后执行。
4. 失败语义：runtime 恒处于上一个已验证状态；恢复本身也是 mutation。
5. 审计：journal（机器恢复）+ history（Owner 审阅）双流，但各只留一份实现。

**实施顺序建议**（供后续排期，非本 ADR 执行项）：先 D-1（止住无 digest 校验的写入路径）→ D-2（installer 接 journal，改动最小收益最大）→ D-3/D-4（repair executor 设计前提）→ 其余。

## 5. 未决问题

- **Q-A**：console updater 的收敛时点——立即冻结 Web UI 更新按钮，还是等 ReleaseManager Phase 4 一步到位？（冻结有用户体验成本，等待有风险敞口存续期）
- **Q-B**：journal 的存放位置与轮换——放 `~/.pd/` 是否会被 install/backup 流程误清理？
- **Q-C**：repair executor 的 Owner 批准载体——CLI 交互式 confirm、批准文件、还是经 Console 的审批 UI（与 PD 的 Owner decision evidence 体系打通）？
- **Q-D**：`migration-plan.json` 的落点规范（`~/.pd/plans/`？临时目录？）。
- **Q-E**：受限自动修复（幂等单文件、digest 精确匹配）将来是否值得引入——本 ADR 仅预留开关位，不决策。
- **Q-F**：卸载（E4）是否纳入 mutation governance（破坏性最强但为 Owner 主动行为，交互确认可能已足够）。

## 6. 与既有文档的一致性核对

- [x] 与 ADR-0023 Decision 1（写入者工集）不冲突——本 ADR 收窄其方法学
- [x] 与 ADR-0023 Decision 9（warn-only → enforce 分阶段）互补——检测面/修复面衔接
- [x] 不与 `update/` 子系统的 Phase 4 计划冲突——shadow mode 期间的约束先行的过渡规则在 §2.1.2
- [x] Non-goals 与 ADR-0023 Non-goals 对齐，未新增任何实施授权
- [x] 生产代码零修改；runtime 零触碰；无迁移执行
