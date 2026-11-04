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
5. **有没有任何一处能力被悄悄削弱？** 没有发现能力削弱：8 组 568/568 与基线逐组相等；host-runtime 652/652；全包仅环境性失败。**但有两处交付限制**：① `packages/website` 用户文档仍宣传已移除的 GFI/`/pd-status`；② `empathy_engine` 配置面残留无消费者。

## 6. 门禁

- `verify:merge`：**整链 `exit=0`**（27 个顶层命令，末项 `check:runtime-writers` PASS）。修复前的两处红因（缺 changeset、website CRLF）均已修复并复跑。
- 结论：**PASS_WITH_LIMITATIONS**（能力无退化；限制为文档滞后 + 环境性测试失败，均与本任务无关且有证据）。
