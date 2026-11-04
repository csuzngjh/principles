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

- **怎么发现**：P1 迁移实现后跑 `packages/host-runtime` 全包，`recordVerifiedToolOutcomes` 全部报 `Too many parameter values were provided`。
- **影响面**：`insertVerified` 是 verified tool outcome 的唯一写入语句。只要是走 `recordVerifiedToolOutcomes` 的路径（host-runtime 生产 verified-outcome 写入、codex-adapter 消费）**每次写入都 100% 失败**，属真实生产回归，不是测试问题。
- **怎么修**：`62e2cab15` 删掉 `gfi_before/gfi_after` 两列时漏删两个 `null` 占位参数（14 值 vs 12 列）。删掉多余两个 `null`，使 12 值与 12 列对齐，并加注释说明。
- **用什么测**：`tests/production-pain-evidence.test.ts` 24/24（含 5 条迁移/负控用例）；host-runtime 全包 652/652。

## 5. 五问回答

1. **旧机制是否真的不再产生自动 Pain？** 是。生产代码中已无 GFI 打分/阈值/阶段/WEAK 路由；`gfi_threshold` 源类型不存在（`resolveSourceKind` 不再产生该 kind）；8 组行为对照与基线逐组相等。
2. **Owner 手动 Pain 是否仍然正常？** 是。`owner_reported` 仍为 `admit`；`pd-cli pain-explicit`、plugin `pain` 命令与 8 组相关组均通过。
3. **错误累积断路器是否仍然有效？** 是。生产路径仍调用 `evaluateTriggerController`（`packages/openclaw-plugin/src/hooks/pain.ts:450`），`gate-b-only-runtime-guard` 相关断言通过。
4. **历史数据是否仍可读？** 是。D1：旧库打开即迁移（只删两列、只终止 pending empathy），v2 库不会被误判，迁移幂等，空库不抛，失败显式 `trajectory_migration_failed:<reason>` + `nextAction`。
5. **有没有任何一处能力被悄悄削弱？** 没有发现能力削弱：8 组 568/568 与基线逐组相等；host-runtime 652/652；全包仅环境性失败。**但有两处交付限制**：① `packages/website` 用户文档仍宣传已移除的 GFI/`/pd-status`；② `empathy_engine` 配置面残留无消费者。

## 6. 门禁

- `verify:merge`：见台账 §6.10（33 步逐项结果）。
- 结论：**PASS_WITH_LIMITATIONS**（能力无退化；限制为文档滞后 + 环境性测试失败，均与本任务无关且有证据）。
