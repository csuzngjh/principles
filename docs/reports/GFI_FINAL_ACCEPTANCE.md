# GFI 移除最终验收（Stage 9，一页）

任务：GFI-COMPLETE-REMOVAL-001。基线 `35d12815bc`。所有数字均为本轮实测，非估计。

## 1. 删掉了什么（机制级）

| 机制 | 载体 | 移除 commit / SPEC |
| --- | --- | --- |
| GFI 分数内核（`applyFriction/applyDecay/applyRelief/classifyGfiStage/computePainScore`） | principles-core | 分层 L1–L6，SPEC §3 |
| 会话摩擦状态（`currentGfi/consecutiveErrors/gfiBySource/trackFriction/resetFriction`） | openclaw-plugin `session-tracker` | `31a60e1e5`，SPEC §3.2 |
| `UnifiedKeyword.category`、`correctionTermsOf`、`EMPATHY_SEED_OVERLAY` | principles-core | `13c067e2f`，SPEC §3.7 |
| `RuleHostInput.session.currentGfi` | principles-core | `2bae37491`，SPEC §3.8 |
| GFI 打分默认项（`thresholds.pain_trigger`、`severity_thresholds`、`scores.*`） | openclaw-plugin `config` | `c7ab619e9`，SPEC §5.1/§5.2 |
| `tool_calls.gfi_before/gfi_after` | 迁移 + schema | `62e2cab15` |
| `gfi_threshold` 源类型与描述符 | evidence-triage | `972664050` |
| `handleFrictionTracking*` | openclaw-plugin | `fa86f0943` |
| `/pd-status reset`、`pd runtime health gfi` | pd-cli | `8acd1027d`，SPEC §4.3 |
| Console GFI 健康项 | pd-console | `603af28d4`，SPEC §4.4 |
| Mental Mode / fatigue / WEAK/empathy 路由 | 多包 | 分层 L1–L18 |

## 2. 没删什么，为什么

| 保留项 | 理由 |
| --- | --- |
| `migrateLegacyGfiSchema` + `hasCanonicalSchema` 旧列判定 | 唯一能安全退役旧库两列并要求"旧列不存在"的机制（P1） |
| `signal_confirmations`（`status='pending' AND suggested_type='empathy'` → `abandoned/gfi_removal`） | 历史数据兼容；只终止 pending，已完成行不动 |
| 功能开关 `gfi` 墓碑（`gone`/disabled） | 防止旧配置文件中的该键复活未知行为 |
| `tool_failure` 作为工具执行事实 | 不是 GFI 分数，仍是证据链输入 |
| EventLog `empathy_rollback` 事件 + `/pd-rollback` | SPEC 未列入移除范围；需 Owner 单独裁定 |
| `empathy_engine` 配置面 | 无消费者、无行为，仅为旧配置可加载；后续清理 |
| 历史文档与历史 JSON 夹具 | 证据/历史，不重写 |

## 3. 实测数字

| 项目 | 结果 |
| --- | --- |
| 8 组累计对照（c1..c8b） | **568 / 568，0 失败**；逐组 46/25/10/17/77/10/175/48/2/18/60/80，与基线逐组相等 |
| `packages/host-runtime` 全包 | **652 / 652** |
| `packages/principles-core` 全包 | 451 passed / 7 skipped / 1 并行抖动（单测复跑 1/1 通过） |
| `packages/openclaw-plugin` 全包 | 201 文件通过 / 3 文件失败（均为环境性：BDD EPERM 清理、2 个 perf 在并行下超预算；两项单测通过） |
| `packages/website` 全套 | 通过（CRLF 归一化 + 内容负控） |
| better-sqlite3 / SQLite | 13.0.3 / **3.53.4**（≥3.35，`DROP COLUMN` 可用） |
| D1 真实库（隔离副本） | 23 表；`tool_calls` 16→14 列、**161 行不变**；`signal_confirmations` 0 行；21 表摘要一致；迁移幂等；空库不抛 |
| 冻结 barrel 面 | 1957 → 1958（仅新增 `migrateLegacyGfiSchema`） |

## 4. 自己引入又自己抓到的回归（完整交代）

### 4.1 `recordVerifiedToolOutcomes` 参数错位（host-runtime 测试抓到）

- **怎么发现**：P1 迁移实现后跑 `packages/host-runtime` 全包，`recordVerifiedToolOutcomes` 全部报 `Too many parameter values were provided`。
- **影响面**：`insertVerified` 是 verified tool outcome 的唯一写入语句。只要是走 `recordVerifiedToolOutcomes` 的路径（host-runtime 生产 verified-outcome 写入、codex-adapter 消费）**每次写入都 100% 失败**，属真实生产回归，不是测试问题。
- **怎么修**：`62e2cab15` 删掉 `gfi_before/gfi_after` 两列时漏删两个 `null` 占位参数（14 值 vs 12 列）。删掉多余两个 `null`，使 12 值与 12 列对齐，并加注释说明。
- **用什么测**：`tests/production-pain-evidence.test.ts` 24/24（含 5 条迁移/负控用例）；host-runtime 全包 652/652。

### 4.2 v1 workspace 的治理写入被拒（PR #2332 CI 抓到）

- **怎么发现**：CI `Test pd-cli` 红，`pain-explicit.test.ts` 两条 `expected 1 to be +0`；本地同红，隔离工作区直跑真实 CLI 得到 `nextAction=trajectory_schema_invalid: run the supported PD workspace migration before enabling conversation ingestion`。
- **影响面**：`hasCanonicalSchema` 新增"旧 GFI 列不存在"判定后，`governance-signal-admission.ts` 的 `openAdmissionStore` 仍只做加列、不跑迁移，于是**任何 v1 工作区**的 `pd pain explicit`、Codex 实时 hook 纠正摄取、WorkBuddy 摄入判定全部被拒。这是 Owner 手动 Pain 路径的真实回归。
- **怎么修**：`openAdmissionStore` 在 `ensureGovernanceAdmissionSchema` 后调用既有 `migrateLegacyGfiSchema`（幂等，v2 no-op），与另两条裸库 open 链统一收敛路径，不新建抽象。
- **用什么测**：新增 `governance-signal-admission.test.ts > converges a v1 workspace carrying retired GFI columns before admitting`（准入 ok、两列消失、原行保留）；该文件 51/51；host-runtime 652/652；`pain-explicit.test.ts` 7/7 由红转绿。

## 5. 五问回答

1. **旧机制是否真的不再产生自动 Pain？** 是。生产代码中已无 GFI 打分/阈值/阶段/WEAK 路由；`gfi_threshold` 源类型不存在（`resolveSourceKind` 不再产生该 kind）；8 组行为对照与基线逐组相等。
2. **Owner 手动 Pain 是否仍然正常？** 是。`owner_reported` 仍为 `admit`；`pd-cli pain-explicit`、plugin `pain` 命令与 8 组相关组均通过。**注意**：本轮曾因 4.2 的迁移缺口让 v1 工作区的手动 Pain 100% 被拒（CI 抓到），已在 `openAdmissionStore` 接入既有迁移并加回归测试，`pain-explicit.test.ts` 7/7。
3. **错误累积断路器是否仍然有效？** 是。生产路径仍调用 `evaluateTriggerController`（`packages/openclaw-plugin/src/hooks/pain.ts:450`），`gate-b-only-runtime-guard` 相关断言通过。
4. **历史数据是否仍可读？** 是。D1：旧库打开即迁移（只删两列、只终止 pending empathy），v2 库不会被误判，迁移幂等，空库不抛，失败显式 `trajectory_migration_failed:<reason>` + `nextAction`。
5. **有没有任何一处能力被悄悄削弱？** 没有发现能力削弱：8 组 568/568 与基线逐组相等；host-runtime 652/652；全包仅环境性失败。owner 裁定后已补齐两项限制：① `packages/website` 的 19×2 过时文案已按实际命令行为重写；② `empathy_engine` 配置面保留读取兼容但删除默认值与模板条目，并注明无效果。仍存限制：`docs/architecture` 仅按裁定最小修改四篇，其余历史周边文档（README 索引、PRI 历史审计、GLOSSARY 等）不在本轮范围。

## 6. 门禁

- `verify:merge`：**整链 `exit=0`**（27 个顶层命令，末项 `check:runtime-writers` PASS）。修复前的两处红因（缺 changeset、website CRLF）均已修复并复跑；裁定后追加改动再次整链复跑。
- 结论：**PASS_WITH_LIMITATIONS**（能力无退化；限制为历史文档残余 + 环境性测试失败，均与本任务无关且有证据）。

## 7. 四项裁定的处置与证据（Owner 追加裁定）

### 7.1 `/pd-rollback` 语义 — 不改回滚逻辑，写清风险

**判定：现实现不是"整包版本回滚"，两条链路互不相干。**

- 插件命令 `/pd-rollback`（`packages/openclaw-plugin/src/commands/rollback.ts`）只调用 `EventLog.rollbackEmpathyEvent`（`packages/openclaw-plugin/src/core/event-log.ts:705`），把**一条历史 empathy 事件**标记为已回滚并回显其分数；它不写评分、不触发诊断、不产生 Pain。移除后 empathy 事件已无生产方（`empathy-keyword-matcher` 仅在 `core/init.ts:10` 播种关键词库），命令退化为"回显历史/无事件"的只读清理入口。**保留，不改**——它不可能把自动 Pain 生产路径带回来。
- 版本/运行时回滚只有 installer 的**失败恢复**：`restoreBackup`（`packages/create-principles-disciple/src/installer.ts:1326-1333`）对 extension/runtime 调用 `restoreTreeAside`（`:1271`）做**整目录置换**，调用点在 `installer.ts:4891-4893`。`update/rollback-policy.ts` 的 `decideHostCoordination`（自动回滚策略）**没有生产调用方**（仅测试/BDD）。

**残余风险与处置**：安装失败恢复发生在激活前，此时新运行时尚未写过库，旧代码 + 未迁移库是自洽的。唯一的真实风险是"迁移已发生后 Owner 手动降级到含 GFI 的旧版本"——旧代码的 `insertVerified` 会带 `gfi_before/gfi_after` 字面列写 12 列表，SQLite 明确报 `no column named gfi_before`（失败可见，不静默）；旧版 `hasCanonicalSchema` 也会拒绝摄取。恢复方式：重新安装当前版本。**未新增"禁止降级"守卫**（属新能力，且无旧代码可自动迁移），仅记录限制。

### 7.2 `empathy_engine` 配置面 — 保留读取、去掉"假装有效"

- `packages/openclaw-plugin/src/core/config.ts`：类型保留（`empathy_engine?`）并注明"仅为旧配置文件可解析，无任何消费者"；**默认值整块删除**，避免新装用户看到"默认开启"的假象。
- `packages/openclaw-plugin/templates/pain_settings.json`：条目删除（新安装不再生成该块）。
- `packages/openclaw-plugin/src/hooks/prompt-types.ts`：类型保留并注明已退役。
- 兼容验证：`config.test.ts > loads a legacy pain_settings.json ...` 增加 `empathy_engine.enabled` 断言（旧文件仍可读、不报错）。

### 7.3 website 19×2 文案 — 已修（文案级 commit）

- `packages/website/docs/slash-commands.md` / `user-guide.md` 与 `packages/website/zh/docs/` 同名文件：`/pd-status` 不再显示 GFI/心智模式/`reset`，改为真实的会话计数、工具/钩子/RuleHost 活动、轨迹与词典统计；`/pd-rollback` 改为"回滚一条历史情绪事件"；工作流与 FAQ 中"疲劳/清零/GFI 降不下来"整段替换为"GFI 已移除"说明。
- 依据：`packages/openclaw-plugin/src/commands/pain.ts`（实际输出字段）与 `commands/rollback.ts`（实际行为）。改动前后对照见 PR 描述。

### 7.4 `docs/architecture` 四篇 — 最小范围

| 文件 | 过时段落 | 依据 |
| --- | --- | --- |
| `COMPONENTS.md` | §3.6 GFI 组件表（4 个已删组件）与组件总表 `GfiWorkspaceReadModel` 行 | SPEC §2；`runtime-v2/gfi/` 仅剩空 `__tests__` |
| `OBSERVABILITY_ARCHITECTURE.md` | §3.3.5 四个 `pd.gfi.*` 指标与命名清单一行 | SPEC §2 / §4.4（Console GFI 健康度删除） |
| `feature-flag-governance.md` | §3.1 `gfi` 复核结论、§1 表中 `gfi` 归入 OFF(quiet)、§3.2 "GFI/rollback 事件链"、§5 non-goal | SPEC §2 / §5.1；`feature-flag-contract.ts:235` gone 墓碑 |
| `PD_SYSTEM_ARCHITECTURE.md` | `runtime-v2/gfi/` 目录树、`session-tracker.ts ← GFI plugin 适配器`、`pd-cli/runtime-gfi-snapshot.ts` | SPEC §2 / §3.2 / §4.3 |

### 7.5 "是否还有第三处同类风险" — 所有打开 `trajectory.db` 的入口与收敛状态

口径：`new Database(` 全仓 45 个命中文件逐一分类（测试/console/seed 脚本不计入生产写入链）。**严格 schema 判定（`hasCanonicalSchema` / `hasProductionPainSchema`）只有两处消费方，两处均已在判定前迁移**，因此不存在第三个同类断点。

| 入口 | 文件:行 | 类型 | 是否迁移 | 结论 |
| --- | --- | --- | --- | --- |
| 插件主写入链 `TrajectoryDatabase` | `openclaw-plugin/src/core/trajectory.ts:204/322/1489` → `applyTrajectorySchemaBase` | 写 | ✅ `trajectory-schema.ts:242` 调 `migrateLegacyGfiSchema` | 收敛 |
| hook 富化写入 | `host-runtime/src/production-pain-evidence.ts:477` | 写 | ✅ 判定前显式迁移（失败点名 `trajectory_migration_failed:*`） | 收敛 |
| verified tool outcome 写入 | `host-runtime/src/production-pain-evidence.ts`（`recordVerifiedToolOutcomes` 打开链） | 写 | ✅ 同上 | 收敛 |
| 治理信号准入 | `host-runtime/src/governance-signal-admission.ts:430` | 写 | ✅ 本轮补入（CI 抓到的第二处回归） | 收敛 |
| 纠正样本复核 | `principles-core/src/trajectory-store.ts:243` | 写 | ❌ 不迁移 | **不受影响**：只写 `correction_samples`/`sample_reviews`，不碰 `tool_calls` 的 gfi 列 |
| 轨迹只读 | `principles-core/src/trajectory-store.ts:96`（`openTrajectoryDbReadonly`） | 读 | 不适用 | 不受影响（只读、无 schema 判定） |
| 观察证据写入 | `host-runtime/src/governance-observation-store.ts:338` | 写 | ❌ 不迁移 | **不受影响**：只写观察表，不读写 `tool_calls` gfi 列 |
| 行为证据只读 | `host-runtime/src/workspace-behavior-evidence.ts:60/113` | 读 | 不适用 | 不受影响 |
| 活跃度检查 | `host-runtime/src/host-liveness-contract.ts:152` | 读 | 不适用 | 不受影响 |
| 产品遥测里程碑 | `host-runtime/src/product-telemetry/milestone-readers.ts:211` | 读 | 不适用 | 不受影响 |
| CLI 评分卡 / 痛觉列表 / 证据构建 / 历史导入 | `pd-cli/src/services/quality-scorecard/data-extractor.ts`、`commands/pain-list.ts`、`commands/build-trajectory-evidence.ts`、`legacy/session-history-import.ts` | 读（导入写 `runs`） | 不适用 | 不受影响（均不选 gfi 列） |
| Console 三个模型 | `pd-console/src/server/models/*.ts` | 读 | 不适用 | 不受影响（只读投影） |

**结论：没有第三处同类风险。** 但有一处**主动选择不收敛**的入口（`reviewCorrectionSample` / `governance-observation-store`）：它们在不迁移的旧库上也能正确工作，强加迁移会扩大改动面且无收益，按 P3 保持现状。
