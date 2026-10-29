# SPEC-PD-AGENT-CAPABILITY-API-001 v0.3 后端第一轮交付报告

- 日期：2026-10-28
- 任务工作区：`D:\Code\_worktrees\principles\adhoc-20261028-capability-backend-8e9371`（分支 `ai/adhoc-20261028-capability-backend-8e9371`，基点 origin/main `30ea308766e4917ef0e632f1bca5e86a3eda1c14`）
- SPEC 依据：`SPEC-PD-AGENT-CAPABILITY-API-001-v0.3-draft`（SHA256 `16f827f60610c2387f70cf3d5c4adec03d2679ef36804f6ecbef4f29f79f94f5`，来源另一任务工作区只读快照，见 `.tmp/spec-basis/PROVENANCE.md`）
- 交付性质：**Gate 0 素材 + 已批准 CLI 契约（SPEC-PD-PAIN-RECALL-CLI-001 §9.2）的违约修复**。不含任何 MCP/能力层产品编码——7 项实施就绪核查全部未决（§3）。

---

## 1. Owner Review Card

1. **Problem**：SPEC v0.3 §10.3.1 指控"只读连接在 WAL 数据库上创建 WAL/SHM sidecar"。独立复现证实并加重：**两个生产数据库（state.db、trajectory.db）的写方都持久设置 `journal_mode = WAL`**（sqlite-connection.ts:130、openclaw-plugin/core/trajectory.ts:206/323），WAL 是写入库头的持久属性——安静工作区（无 sidecar，生产常态，尤其 Codex per-invocation hook 模型）上的**每次 `pd pain recall` 都会在两个库旁创建 4 个 sidecar 文件**，违反已批准的 SPEC-PD-PAIN-RECALL-CLI-001 §6.1（"禁止 WAL 初始化"）与 §9.2（"没有 WAL/SHM 副作用"）。既有只读契约测试从未发现，因为夹具用默认 journal 模式建库（ERR-172）。
2. **Before**：`pd pain recall` 在安静 WAL 工作区创建 `-wal`/`-shm`（R1 复现：4 文件；主库哈希不变）。
3. **After**：三分法读取——journal 模式→直接只读打开（无副作用，R8）；WAL 且 sidecar 存在（活跃 writer/崩溃残留）→直接 attach（零创建、读到未 checkpoint 提交帧，R5/R6）；WAL 安静→**先复制主文件到私有临时区再读副本**（打开发生在副本旁），复制前后双重 `-wal` 静默校验，writer 中途活动则该源按 `unreadable` 拒绝（fail-closed，不返回陈旧数据）。工作区零文件副作用，结果新鲜度有断言。
4. **Existing mechanism reused**：`openTrajectoryDbReadonly`、`RuntimeStateManager({readonly:true, bootstrapIfMissing:false})`、`readLedgerFileState` 全部原样复用（staging 通过既有入口指向临时根实现）；CLI 命令层、JSON 契约、退出码零改动。
5. **Complexity Delta**：新持久权威 NO；新持久 schema/state NO；新子系统/后台进程 NO；新公共抽象 NO（服务内私有函数）；新 feature flag NO；新跨包依赖 NO；新宿主行为 NO；新网络能力 NO。新增：os.tmpdir() 私有临时目录（用后即删，失败 best-effort 清理）。
6. **Design reason**：better-sqlite3 13.0.3 不支持 `file:` URI（实证 R4/URI 矩阵：无参数 URI 亦失败，未传 SQLITE_OPEN_URI），SQLite `immutable=1` 零副作用模式不可用；全面 fail-closed 会使 Codex 静默常态下 recall 不可用；改 core 连接层爆炸半径覆盖 console/host-runtime 全部只读消费方（超出已批准范围）。staged copy 是当前驱动下唯一可证明"新鲜或拒绝"二择的零副作用路径，且只改 recall 服务自身。
7. **Verification**：新增 WAL 矩阵测试 ro-5..ro-9（安静/活跃 writer/空 -wal/崩溃三件套/混合模式，含新鲜度断言）+ 既有 ro-1..ro-4 无回归（9/9）；pain-recall 套件 57/57；CLI 树+帮助快照 53/53；typecheck 干净；eslint 干净；真实 CLI 子进程冒烟（重建后 dist）安静 WAL 工作区 `ok`/returned 1/零 sidecar/主库字节不变；pd-cli 全量 2113 用例中每次各有 1-2 个负载 flake（三次全量失败用例互不相同、隔离均绿，与本 diff 无关，证据在案）。
8. **Risk**：staged copy 存在残留竞态——writer 在"stat(-wal 不存在)→复制→stat"窗口内完整起落（创建 WAL→提交→checkpoint→删除 WAL）时，副本可能撕裂（→SQLite malformed→按 unreadable 干净失败）或读到较旧一致状态（无检测）。该窗口为毫秒级且仅当无会话活动时存在；recall 是建议性只读查询，边界已披露。次要：崩溃三件套场景 attach 时 SQLite 可能对既有 `-shm` 做 wal-index 恢复写入（修改既有临时协调文件，非创建）——与修复前行为一致，无回归。
9. **Rollback / recovery**：revert 单一提交即可（无数据迁移、无 schema 变化、无配置）；writer 干净关闭本就会 checkpoint 并清理 sidecar（R9），历史遗留 sidecar 无需清理即无害。
10. **Follow-ups（刻意不做）**：(a) `openTrajectoryDbReadonly`/`SqliteConnection` 只读层的同类 sidecar 创建（evolution-store、console GET 路由、readPromptActivationCandidates 等）——各自的契约与运行时机不同（会话内 sidecar 常在），需单独裁定是否统一收口到 core 层；(b) better-sqlite3 URI/immutable 支持升级评估；(c) Gate 0 宿主能力矩阵更新（属 SPEC Gate 0 正式交付物）；(d) staged copy 残留竞态的检测强化。

## 2. 实施就绪核查（7 项 Owner 设计批准状态）

| # | 事项 | 状态 | 出处 |
|---|---|---|---|
| 1 | 首个真实工作流及目标宿主 | **未决** | SPEC §17.2/17.3/17.7 为 Owner 决策项；PRR A-05 仅为提案（Codex 首选/OpenClaw 次选/WorkBuddy 暂缓）；Gate B D-05 PENDING |
| 2 | Agent 原则资格集合/宿主禁用/撤回语义 | **未决** | PRR v1.3 §3.3 D-02 冻结为 OWNER_DECISION_REQUIRED，"未经 Owner 明确裁决前一律视为无资格"；v0.3 §8.4.1 要求 Gate 1 冻结并继承 D-02 |
| 3 | 可披露字段/摘要来源/可信授权上下文 | **未决** | v0.3 §8.4.2"授权状态均须在 Gate 1 逐项裁决；没有默认真实数据披露许可"；PRR §3.1 read-back NOT_COVERED；D-01/D-03/D-04 PENDING |
| 4 | WAL 安全读取方案 | **recall 侧已履行（本次）；能力层未决** | 已批准契约 = SPEC-PD-PAIN-RECALL-CLI-001 §6.1/§9.2（本 PR 修复其违约）；能力层策略 v0.3 §10.3.1 要求 Gate 1 冻结 |
| 5 | 协议/SDK/宿主兼容范围 | **未决**（技术核查已就绪） | v0.3 §22.3"Gate 1 冻结兼容矩阵"；2026-10-28 复核：协议 2026-07-28 权威在线（schema.ts 钉版）；TS SDK v2 稳定线实现 2026-07-28（分包 `@modelcontextprotocol/server`/`client`，`serveStdio` 为现代 stdio 入口），npm latest = **2.4.0** |
| 6 | 价值实验判据及允许成本 | **未决** | v0.3 §12.1 预注册实验卡需 Owner 审阅；PRR Gate B 执行 `GATE_B_EXECUTION_BLOCKED`（D-01~D-05 全 PENDING）；Recall 生产 MCP 另承 §12.2 PRR B/C/D 前置 |
| 7 | 当前允许进入的 Gate | **未决** | SPEC 状态 `DRAFT — OWNER REVIEW REQUIRED`、§21 `IMPLEMENTATION=NOT_STARTED`、§18 验收清单全部未勾选；本任务交接明示不代表批准 |

结论：除第 4 项 recall 侧外全部缺项 → 本轮只做了无需裁决的工作（源码调查、独立复现、已批准契约的违约修复、技术方案与决策卡），未开始任何依赖未批准设计的产品编码（无 MCP Server、无能力层、无 `pd-application`、无 SDK 依赖、未动 Hook/RuleHost）。

## 3. Reality Audit 摘要（相对 SPEC 基线 c547570e9 → 当前 main 30ea30876）

- 关键文件漂移：仅 `active-principle-prompt.ts` 变化（-28/+10）——`readPromptActivationCandidates` **移除了 `excludePrincipleIds` 参数与排除分区**（Host Overlap Exclusion 已退役）；FIFO activations→artifact resolve→identity 主链不变。SPEC v0.3 对该函数的描述略滞后。
- `recallPains()`：两权威边（reuseEvidence 显式 painId + derivedFromPainIds 存 candidateId 经 task→input_ref 解析）；ledger 精确键匹配；CLI 注册 `index.ts:192 → handlePainRecall`。
- 消费者面：`openTrajectoryDbReadonly` 生产消费方仅 3 个（trajectory-store 自身、evolution-store、pain-recall）；`SqliteConnection readonly:true` 消费面巨大（console 全部 model、host-runtime 读者、十余个 pd-cli 命令）→ 修复只落在 recall 服务层（P3 最小爆炸半径）。
- 缺口判定：**已有能力未连接 vs 缺能力**——WAL 副作用不是缺失能力，是既有只读入口在未被夹具覆盖的生产状态下违约；连接既有入口（临时根重定向）即可修复，无需新抽象。
- `resolveLedgerActivationId`（ledger-identity.ts:126）：direct validated→candidate lineage→receipt 校验→`conflicting_authorities` 拒绝；身份权威完整可复用，符合 v0.3 §8.4.1 预期。

## 4. WAL 独立复现证据（本工作区构建，better-sqlite3 13.0.3）

| 编号 | 场景 | 结果 |
|---|---|---|
| R1 | recallPains 安静 WAL 工作区 | **创建 4 个 sidecar**（trajectory/state 各 -wal+-shm）；主库哈希/大小不变；status ok |
| R2/R3 | 两只读入口单独打开 | 各自创建 sidecar（违约位于入口层） |
| R4 | `immutable=1` URI | **失败**："unable to open database file"；URI 矩阵证实连无参数 `file:` URI 都不支持（未传 SQLITE_OPEN_URI）→ immutable 路线在锁定驱动下不可用 |
| R5 | 崩溃三件套（非空 -wal 无活跃 writer） | 直接 attach：读到未 checkpoint 提交帧（新鲜），零新文件 |
| R6 | 活跃 writer | attach：读到同会话未 checkpoint 提交（新鲜），reader 零文件创建 |
| R7 | 文件头 18/19 字节检测 | WAL=2/2、journal=1/1；纯 fs 读取零副作用 |
| R8 | 非 WAL 基线 | 直接只读打开零副作用（既有测试为何全绿的原因） |
| R9 | writer 清理 | reader 留下的 sidecar 被后续 writer 干净关闭清除（恢复路径） |

复现脚本与日志：`.tmp/wal-repro/repro.mjs`、`repro-log.txt`、`uri-matrix.mjs`、`cli-smoke.mjs`（git-15：会话产物，不入提交）。

## 5. 最小决策卡（一次性提交，每项含推荐/替代/代价/验收）

**D-A 首个工作流与宿主**：推荐 Codex + `pd pain recall` 按需查询场景（A-05 提案依据 + Codex per-invocation hook 模型使静默 WAL 成为常态，本次修复使其可用性成立）；替代 OpenClaw（会话内 sidecar 常在，Skill+CLI 已可用，MCP 增量更难证明）或暂不指定；代价：需 Owner 给出具体任务、使用者、失败代价五要素场景卡；验收：Gate 0 场景卡被 Owner 接受。
**D-B Agent 原则资格**：推荐采 D-02 保守候选——"宿主有权披露的有效激活集合"，停用/撤回/从未激活一律无资格，逐请求校验、无长期缓存、撤回负例必测；替代"本轮实际注入集合"（需宿主回执，绑定更深）；代价：D-02 裁决 + 资格投影与宿主启停联动规则冻结；验收：两次调用之间撤回→下次 `denied` 的负例。
**D-C 字段披露**：推荐首版仅 `principleId/painId/association/occurredAt/来源状态` 元数据 + 经批准的摘要白名单（§8.4.2 逐项裁决），正文/`reason`/`rootCause`/证据 note 全部默认不披露；替代维持纯 Operator CLI（无 Agent 投影）；代价：逐字段披露裁决表；验收：四处植入敏感标记的泄露负例（结构化响应+文本+错误+日志）。
**D-D WAL 读取策略（能力层）**：推荐冻结本次三分法（journal→直读；WAL+sidecar→attach；WAL 安静→验证新鲜性的 staged copy）；替代 A 全面 fail-closed（Codex 常态不可用，不推荐）；替代 B 升级驱动求 URI/immutable（依赖面大，单独立项评估）；代价：staged copy 残留竞态已披露（见 §1.8）；验收：ro-5..ro-9 矩阵并入能力层用例 + §13.2 全清单。
**D-E 协议/SDK/宿主矩阵**：推荐 Gate 1 冻结"现代 2026-07-28 + SDK v2 线（实施时钉 npm 精确版本并锁 lockfile）+ 不支持版本显式失败"，legacy 仅凭目标宿主真实证据加入；代价：需目标宿主 MCP client 版本/安装/卸载证据；验收：§13.4 真实 wire 测试（官方 Client + stdio 子进程 + Inspector 固定版本）。
**D-F 价值实验**：推荐复用 PRR B0 预注册框架：一次性合成夹具技术验证与行为价值实验分开，预注册卡（任务集/判据/成本上限/GO-STOP-UNPROVEN）运行前冻结，完整失败分母；代价：Owner 审阅一页实验卡；验收：预注册卡批准后实验方可运行。
**D-G Gate 准入**：推荐 Owner 裁决 SPEC 是否进入 `APPROVED_FOR_DISCOVERY`（仅授权 Gate 0/1）；替代维持 NOT_STARTED（本次零代码依赖，随时可停）；代价：无；验收：§18 前置清单逐项勾选记录。

## 6. 测试与验证记录

| 命令 | 结果 |
|---|---|
| `npx vitest run tests/commands/pain-recall-readonly.test.ts`（pd-cli 包内） | **9/9 PASS**（ro-1..ro-9） |
| `npx vitest run tests/commands/pain-recall.test.ts` | 57/57 PASS |
| `npx vitest run tests/commands/cli-command-tree.test.ts tests/commands/cli-help-snapshot.test.ts` | 53/53 PASS（CLI 契约面不变） |
| `npm run typecheck`（pd-cli） | PASS |
| `npx eslint packages/pd-cli/src/services/pain-recall.ts` | PASS |
| `node .tmp/wal-repro/cli-smoke.mjs`（重建 dist 后真实 CLI 子进程） | **CLI-SMOKE-PASS**（ok/returned 1/零 sidecar/主库不变） |
| `npx vitest run`（pd-cli 全量，3 次） | 2112/2113、2112/2113、2111/2113——每次失败的用例互不相同（scribe dispatch / candidate-intake e2e 超时），**隔离重跑均 100% 绿**（53/53、6/6）→ 负载 flake，与本 diff 无关（本 diff 不触及这些路径） |
| `npm run check:error-handbook` | OK（131 active patterns / 331 occurrences，含新增 ERR-172） |
| error:context Pass 2（diff 模式） | EP-03/EP-04/EP-02 HIGH、EP-09 MEDIUM——逐项处理：EP-03 staging 失败全部映射既有 unreadable 分类（无空 catch、无静默降级）；EP-04/cli-1 冒烟单 JSON 可解析、cli-7 由命令树测试覆盖；EP-02 生产路径由 CLI 冒烟证实、无跨包契约变更；EP-09 全部真实临时文件夹具零 mock |
| 未运行 | `verify:merge` 全门禁（按 §25 仅在合并候选/CI 不可用时跑）；真实宿主验证（无授权）；MCP 协议测试（无 Gate，不存在 MCP 代码） |

## 7. 回滚与卸载

- 回滚 = revert 单一提交（服务+测试+changeset+ERR 记录一起还原）；无数据迁移、无用户状态、无安装运行时改动（未触碰 `~/.pd/runtime`、`~/.openclaw`、任何 workspace）。
- 修复本身不引入开关（mvp-q-3：既有 `pd pain recall` 命令即控制面，无该命令处行为不变）。

## 8. Linear 对账

- 搜索"pain recall WAL sidecar readonly"等：**无既有工单描述本违约**（不适用规则 9 的链接义务；本次为 adhoc 修复）。
- 相关未决工单：PRI-1004（[PRR/C1] 最小共享只读查询，Backlog——Gate C 语义，本修复是其只读前提之一）、PRI-1007（[PRR/D0] 三宿主及 Raw/MCP 扩展 Owner 裁决，Backlog——即决策卡 D-A/D-C 的正式裁决位）。
- 本 SPEC 无对应 Linear 工单（SPEC 文档本身在另一任务工作区在途）。

---

## 9. Round 2：PR #2214 评审修复（P1-1/P1-2/P2-1/P2-2）

Owner 评审对 round-1 修复指出 4 项缺陷；本节记录根因、修复与验证。评审发现全部是**对未合并修复 PR 的评审发现（caughtBy=pr-review），无生产逃逸**，根因分类：P1-1/P1-2 = 副作用契约爆炸半径不完整（ERR-172 教训的延伸——sidecar 契约不只"不创建"，还包括"不重写既有 -shm"与"复制窗口竞态"）；P2-1 = 错误吞并（EP-03：无条件 catch 把不可判定当安全）；P2-2 = 错误处理边界错位（EP-03）。均为既有模式实例，不另立新 ERR 记录。

### P1-1 非空 WAL 路径仍有工作区副作用

**根因**：round-1 对"非空 `-wal`（活跃 writer/崩溃残留）"保留直接 attach，依据是 R5/R6 实证"不创建新文件"。遗漏：① `-wal` 存在但 `-shm` 缺失时只读打开可能在工作区物化 `-shm`；② 既有 `-shm` 可能被 WAL-index 恢复重写。两者都是契约违约。
**修复**：`pain-recall.ts` `planReadonlyOpen()` 重构（:351）——任何 WAL 模式头（bytes 18/19=2）一律返回 `'stage'`；工作区原库只在 rollback-journal 模式被直接打开。`stageWalSnapshot()`（:406）按四态分类（`classifyWalSidecar` :333）：absent/quiet → 只复制主库；active → **复制 (main, -wal) 配对**到临时区（`-shm` 刻意不复制——它只是索引缓存，暂存打开时由 SQLite 在副本旁重建）。配对副本经既有只读入口读取，SQLite 校验和链式 WAL 恢复给出帧级一致的未 checkpoint 提交。
**测试**：ro-6 扩展（活跃 writer 的 -wal/-shm 哈希前后不变）；ro-8 扩展（崩溃残留 main+wal+shm 全部哈希不变）；新增 ro-10（非空 wal 无 shm：新鲜读取 + 工作区零新文件）；新增 ro-11（state.db 活跃 writer：未 checkpoint 诊断经配对快照新鲜可见 + 三文件哈希不变）。

### P1-2 临时副本一致性/新鲜度竞态

**根因**：round-1 `stageQuietWalCopy()` 的"复制→再查 wal 静默"两步无法证明副本与源在任一时间点一致，也无法探测复制期间主库变化。
**修复**：`stageWalSnapshot()` 四段指纹协议（:410-439）：① T0 对 (main, wal) 指纹化（存在性+大小+SHA-256 流式哈希 `hashFileStreaming` :284，128KiB 分块）；② 复制（main + 非空 wal）；③ 暂存副本必须与 T0 指纹逐字节吻合（撕裂/篡改副本被拒）；④ T1 对源配对重新指纹化——任何漂移（文件变化/wal 出现或消失/大小移动）拒绝该副本。已验证配对 = 两端点一致的源配对；SQLite 校验和链对 quiescent-or-crashed 状态做帧级恢复。**未证明边界（如实陈述）**：若 writer 的完整写入周期（改 main → checkpoint → 删 wal）在指纹窗口内完成且净效果为"字节回到窗口起点状态"（ABA），指纹无法区分——本地单 Owner 工作线下此形态需要一次故意构造的往返重写，不在威胁模型内；此外配对在两端点间一致由"期间零字节变化"保证，这依赖 fs 级观察，不构成对所有并发交错的形式化证明。
**确定性测试**（经 `painRecallSnapshotTestHooks.afterCopyFile` 注入，零时序依赖）：race-1（复制后改源主库 → 拒绝）、race-2（安静快照期间出现 wal → 拒绝）、race-3（快照中 wal 被删+主库重写：**endpoint wal 消失不等于接受旧副本**，拒绝而非返回含已删帧的 ok）、race-4（暂存副本被篡改 → 拒绝且工作区零变化）。

### P2-1 WAL 状态检查错误吞并

**根因**：`walSidecarIsQuiet()` 用无条件 `catch { return true }` 把 EACCES/EIO 等"无法判定"当"安静"——把未知当安全。
**修复**：三态+失败关闭结构 `FileFingerprint`（absent/present(size,hash)/unverifiable，:277-317）与 `classifyWalSidecar()` 四值（absent/quiet/active/unverifiable，:333）；`fingerprintFile` 用 `isEnoent()`（Object.hasOwn 判定，符合 rc-5）区分 ENOENT 与其他错误；unverifiable 一律 `{ok:false}` → 来源 `unreadable`，不得返回 ok/no_matches。
**测试**：四个状态各有行为级覆盖——absent（ro-5 安静路径）、size 0（ro-7）、非零（ro-6/ro-8/ro-10 配对路径）、stat 非 ENOENT（inj-stat：EACCES 注入 → source_unreadable + 工作区零变化）。

### P2-2 mkdtempSync 在错误边界外

**根因**：`stageQuietWalCopy()` 的 `mkdtempSync` 位于 try 外，临时目录不可创建时未处理异常直接逃逸（违反 rc-3/9 的分类失败语义）。
**修复**：`stageWalSnapshot()` 中 mkdtemp 在 try 内（:418-419），任何失败走既有 `{ok:false}` 路径；state.db 按契约降级 `unreadable` 并保留仍可验证的 reuse-evidence 结果，trajectory.db 按权威源语义报 `source_unreadable`；`finally` 中失败路径清理已创建 root（:446），清理失败不掩盖主结果。
**测试**：inj-mkdtemp-throw（注入失败：不抛、stateDb=unreadable、trajectoryDb=unreadable、工作区不变）；inj-mkdtemp-cleanup（mkdtemp 成功后复制失败：记录每个已创建 root，断言全部被清理）。

### Round-2 验证记录

| 命令 | 结果 |
|---|---|
| `npx vitest run tests/commands/pain-recall-readonly.test.ts` | **18/18 PASS**（ro-1..ro-11 + race-1..4 + inj-stat/inj-mkdtemp-throw/inj-mkdtemp-cleanup） |
| `npx vitest run tests/commands/pain-recall.test.ts tests/commands/cli-command-tree.test.ts tests/commands/cli-help-snapshot.test.ts` | 110/110 PASS |
| `npx tsc --noEmit`（pd-cli） | PASS |
| `npx eslint packages/pd-cli/src/services/pain-recall.ts` | PASS（rc-5 警告已通过 Object.hasOwn 消除） |
| `node .tmp/wal-repro/cli-smoke.mjs`（重建 dist 后真实 CLI 子进程，双场景） | **S1 quiet-WAL PASS**（ok/returned 1/零 sidecar/主库指纹不变）；**S2 active-WAL PASS**（ok/未 checkpoint 行新鲜可见/wal+shm+main 指纹全部不变/exit 0） |
| pd-cli 全量 sanity | 见 round-2 提交信息与 CI；本机负载 flake 类与 round-1 相同（失败用例互不相同、隔离全绿） |

**工作区 sidecar 前后指纹对比**：S1（安静）sidecar 数 0→0、主库哈希不变；S2（活跃）-wal/-shm/main 三者 SHA-256 前后一致；ro-6/ro-8/ro-10/ro-11/race-4 在测试级断言同一性质。

### 修复前后调用路径

- 修复前（round-1）：`planReadonlyOpen`（journal→direct；WAL 安静→stage-copy 单文件；WAL 非空→**direct attach 工作区原库**）。
- 修复后（round-2）：`planReadonlyOpen`（header 不可读→unverifiable；非 SQLite→direct；**journal→direct；任何 WAL→stage**）→ `stageWalSnapshot`（指纹 main+wal → 复制 main[+非空 wal] → 副本指纹校验 → 源配对复检 → 失败即拒绝并清理）→ 既有只读入口指向暂存根。CLI 参数/JSON/退出码/关联逻辑零变化。

---

## 10. Round 3：ABA 竞态的机制裁决与契约闭合（最终指令轮）

Owner 指令要求机制性处理"字节还原式 ABA"（§三.3：主库/sidecar 最终字节可能恢复到初始指纹）。本轮先做严格推理与方案比较，再实施——结论是**契约表述错误修正 + 测试证明闭合**，而非叠加检查（伪修复禁令）。

### 10.1 根因：round-2 报告把一个已闭合的洞表述为未闭合

round-1 报告 §1.8"可能读到较旧一致状态（无检测）"是 **round-1 copy-then-check**（无终点复检）的真实性质；round-2 加入 T1 复检后，该洞已在机制上闭合，但表述被原样继承进 round-2 的"未证明边界"，造成"协议可能接受陈旧副本"的错误信号。严格重述 round-2 协议的接受条件：

1. 副本校验通过 ⇒ 暂存字节 == T0 采样时刻的源字节；
2. T1 复检通过 ⇒ **T1 采样时刻**的源字节 == T0 字节（复检读的就是终点时刻的字节）；
3. ⇒ **接受 ⇔ 暂存副本 == 终点（T1）采样时刻的源**。

推论：**"接受比终点陈旧的副本"在逻辑上不可能**——这正是"新鲜度契约"的正确形式化（线性化点 = T1 复检完成）。绝对最新语义（含 T1 之后、返回之前的写入）在无协调机制下对任何文件快照方案都不可满足，属机制下界而非本协议缺陷。

### 10.2 ABA 三分支的机制归宿（每支都有测试证明）

| 分支 | 终点字节 | 机制结果 | 测试 |
|---|---|---|---|
| 真实提交存活到终点（insert→commit→checkpoint→wal 删） | main 必变：file change counter（头部 offset 24，SQLite 写路径下单调）+ checkpoint 写回的数据页 | T1 复检失败 → **拒绝** | aba-1（真实 better-sqlite3 全周期注入 → source_unreadable） |
| 未提交回滚（BEGIN→INSERT→close） | main 从未变；wal 随 close 消失 | (M0,∅)==T0 → **接受**；回滚行从未进入数据库状态，返回不含它 | aba-2（ok/returned 2/无回滚行/零副作用） |
| 旁路字节还原（非 SQLite 写回 T0 镜像） | 终点状态就是 M0 | 副本 == 当前状态 → **接受是新鲜且正确**，被还原的行不在状态中 | aba-3（ok/returned 2/无还原行/终点==T0 镜像） |

三分支均无"错误接受"。"counter 单调"不是概率论证：它是 SQLite 内核写路径的确定性协议（每次成功写事务递增 change counter），其失效形态（uint32 回绕、旁路覆写）分别属于 2^32 次事务量级与"任意文件破坏"威胁模型，与任何方案共同。

### 10.3 方案比较（指令 §三 要求）

| 方案 | 能保证 | 不能保证 | 触碰工作区 | 未 checkpoint 帧 | 与全部 writer 协调 | 失败语义 | 裁决 |
|---|---|---|---|---|---|---|---|
| **A 协调式快照**（writer 侧锁） | 参与者间绝对互斥 | **无法核实全覆盖**：旧版本进程、外部 sqlite3 CLI、任何旁路工具不参与；PD writer 唯一入口（core SqliteConnection 写模式）改造属跨包生产行为变更，console/plugin/hook 路径延迟敏感（keep-alive 事故前科）；锁超时/崩溃恢复需新契约 | 锁文件本身即新副作用 | 可 | 名义上，实际不可验证 | 锁失败需新增拒绝分类 | **不选**：指令明示"不能仅凭增加一个锁文件就宣称安全" |
| **B SQLite 原生**（backup API / VACUUM INTO；better-sqlite3 13.0.3 均具 API） | 连接视角的一致视图（含 WAL 帧） | **必须先在源库建立连接**——只读打开 WAL 库本身即产生本轮要消除的 -wal/-shm 副作用，机制上循环依赖 | **是（打开即副作用）** | 可 | 不需要 | SQLite 错误路径 | **不可用**：与零副作用前提自相矛盾 |
| **C OS 级快照**（VSS / 硬链接 / 普通锁） | VSS：卷级时点（前提成立时） | VSS 需管理员+卷影服务（本机/CI 部署前提不成立）；NTFS 硬链接非 CoW——writer 经句柄写 main 直达"副本"数据；普通文件锁无原子性 | VSS 否；硬链接是 | VSS 可；硬链接跟随写入 | 无关 | 平台特定 | **不可用** |
| **D 现行指纹协议 + 终点等价契约（本轮裁决）** | 接受⇔副本==终点采样源（§10.1 证明）；真实提交必拒（§10.2） | 杂交窗口（配对两次非原子采样，见 10.4）；T1 后写入 | 否（全部在暂存区） | 可（配对恢复，ro-8/ro-10/ro-11 实证） | 不需要（写入方无感知） | 既有 unreadable/missing 分类，零新增 | **选**：唯一同时满足契约六不变量且可证明的方案 |

### 10.4 残余边界（机制下界，如实披露，非本协议可消除）

1. **配对非原子采样（杂交窗口）**：T0 与 T1 的 (main, wal) 各为两次独立读取。构造"源从未处于的接受配对"需要源状态段在这两轮共四次采样上呈现交错（例如 T0 读 main 在 checkpoint 前、读 wal 在 checkpoint 后，且 T1 复检同样交错）——由于存活提交必移 main 字节（change counter），该交错必须在两轮间重复出现。消除它需要 A（协调层，10.3 已裁不可用）或单文件存储格式——SQLite 官方对多文件一致读的答案（经由打开的连接）恰被零副作用契约禁止。
2. **线性化点后写入**：T1 复检之后、结果返回之前的提交不反映。同属"绝对最新需协调"的下界。
3. **架构前置条件（若 Owner 要求更强语义）**：绝对最新/绝对原子读取需要 writer 参与的协调层——应另立写入侧 SPEC（改 core SqliteConnection 写路径 + 全部 writer 升级 + 共存策略），不由本只读 PR 承载。

### 10.5 Round-3 变更与测试

**代码**：逻辑零变更（伪修复禁令禁止叠加冗余检查制造"已修复"假象）；修正模块注释与 `stageWalSnapshot` docstring 中的契约表述（终点等价语义 + ABA 两分支论证 + 残余边界），替换 round-2 的错误"未证明"段落。

**新增测试**（全走 `recallPains()` 真实路径、真实 SQLite 写、注入缝确定性触发）：

| 测试 | 场景 → 断言 |
|---|---|
| aba-1 | 真实全周期 ABA（insert→commit→checkpoint(TRUNCATE)→close，wal 删除）→ `source_unreadable` + wal 确已消失（证明存活提交必被拒） |
| aba-2 | 未提交回滚（BEGIN→INSERT→close 回滚）→ `ok`/returned 2/**无回滚行**/main 哈希不变（未提交数据不污染接受） |
| aba-3 | 字节还原式 ABA（真实提交后旁路写回 T0 镜像）→ `ok`/returned 2/**无还原行**/终点==T0 镜像（接受==当前状态，非陈旧） |
| aba-4 | 复制后源 main 消失 → 拒绝（按"missing stays missing"契约分类 `source_missing`）+ 全部暂存 root 清理 |
| aba-5 | state.db 复制期间被改 → `stateDb=unreadable`、`trajectoryDb=ok`、`partial`、2 行保留（state 侧可选源降级契约，与 trajectory 权威源拒绝语义分开验证） |

### 10.6 Round-3 验证

| 命令 | 结果 |
|---|---|
| `npx vitest run tests/commands/pain-recall-readonly.test.ts` | **23/23 PASS**（ro-1..11 + race-1..4 + inj-* + aba-1..5） |
| `npx vitest run tests/commands/pain-recall.test.ts tests/commands/cli-command-tree.test.ts tests/commands/cli-help-snapshot.test.ts` | 110/110 PASS |
| `npx tsc --noEmit` / `npx eslint src/services/pain-recall.ts` | PASS / PASS |
| pd-cli 全量 | 见提交记录（round-3 全量结果随 CI 与提交附注） |
| `npm run verify:merge`（本地，指令要求） | 结果见提交附注与最终交付报告（Windows 已知环境项以 CI Verify Merge Gate 为准绳并附对照证据） |
| CI（新 head） | 以 GitHub Actions 实际收敛结果为准（最终报告引用） |

---

## 11. Round 4：T1 非原子配对采样的机制闭合（最终指令轮 2）

Owner 指令指出 round-3 披露的"配对非原子采样"边界的具体可击穿形态：T1 复检的两条读（先 main 后 wal）之间可容纳一个完整 writer 周期（commit→checkpoint→close，wal 删除），使 main 读到周期前的 M0（陈旧）、wal 读到周期后的 ∅（与 T0 相同）——两项均"匹配"，旧序**接受陈旧快照**。round-3 注释声称"接受⇔副本==T1 终点采样"中"终点采样"对非原子配对无定义，该表述错误。

### 11.1 红色证据（先击穿，后修复）

先在旧两读序上仅加入注入点 `afterT1MainFingerprint`（使窗口可注入、逻辑不变），新增 interleave-1/interleave-2：

- interleave-1（trajectory）：`expected 'source_unreadable' received 'ok'` —— 旧序接受陈旧快照，返回 2 行（数据库已提交 3 行）；
- interleave-2（state.db）：`expected 'partial' received 'ok'` —— 旧序同样未察觉 state.db 的中途周期。

两份断言输出即击穿证据（指令 §三"先在旧实现上运行该测试，记录失败证据"）。

### 11.2 修复机制：三读复检 + 单一线性化点

T1 复检改为 **main → wal → main**：

```text
r1 main（须==T0.main）
   └─ 注入点（测试在此注入完整 writer 周期）
r2 wal（须==T0.wal）★线性化点
r3 main（须==T0.main）＝尾部 checkpoint 探测器
```

**证明**（接受 ⇒ 副本==r2 时刻的真实数据库状态）：
- r2 直接观察 wal；r1、r3 以相等字节夹住 r2，且 SQLite 自身写路径下 main 字节像不可回到先前值（change counter 单调）⇒ r2 时刻 main==T0.main；
- 故接受时副本==(T0.main, T0.wal)==r2 时刻真实状态；
- **线性化点之前完成的写入必被捕获**：commit → wal 变（r2 可见）；checkpoint → main 变（r1 或 r3 可见，含指令场景的 (r1,r2) 与 (r2,r3) 两个窗口）；
- 线性化点之后的 commit（如 (r2,r3] 落入 WAL 的未 checkpoint 提交）属后线性化事件——正确的时点语义而非陈旧；(r2,r3] 的 checkpoint 被 r3 保守拒绝（fail-closed 合法）。

代价：每次 WAL 快照多一次 main 流式哈希（与既有两次同级，on-demand CLI 查询可承受）。

### 11.3 方案比较（指令 §四，全部实证/枚举）

| 方案 | 结论 | 证据 |
|---|---|---|
| A SQLite 原生（backup/VACUUM INTO） | **实证否决** | 实验（`.tmp/wal-repro/option-experiments.mjs`）：对安静 WAL 库 readonly 打开 + `backup()` 成功但 **workspace sidecars 0→2**——打开源库本身即产生本契约要消除的副作用，机制循环依赖；VACUUM INTO 在 readonly 连接上不可用 |
| B Writer 协调 | **枚举否决** | 写入口分布：state.db 写模式 `SqliteConnection` 消费方横跨 host-runtime 8+ 文件、openclaw-plugin hooks、console models、pd-cli 命令；trajectory 写方在 host-runtime stores + plugin core；另有不可枚举的外部 sqlite3 CLI/进程——参与覆盖不可证明；core 写路径协调=跨包生产改造，违反本轮不变量 6 |
| C OS/存储层快照 | **实证否决** | 硬链接实验：链接读到 1 行而原库已提交 2 行——WAL 按文件名寻址（链接永远看不到原库 `-wal`）且共享 inode 不隔离 main 写，"快照"不连贯；VSS 需管理员+卷影服务，部署前提不成立 |
| D 全面失败关闭 | **影响否决** | 生产两库恒为 WAL ⇒ recall 在三宿主永久 `source_unreadable`（Codex per-hook、OpenClaw on-demand 全灭）；保留为单快照级失败行为（现行做法） |
| **E 三读复检（选定）** | 接受⇔副本==线性化点（r2）真实状态；11.2 证明；零新依赖、零工作区触碰、CLI 契约零变化 | interleave-1/2 红→绿 + 全套回归 |

"返回时绝对最新"语义在无协调机制下不可满足（任何有限读序列均存在最后读盲区——w 尾漏 checkpoint-in-quiet、m 尾漏 commit-only），该语义需方案 B 的架构前置（另立写入侧 SPEC），本 PR 交付的是**可证明的时点一致性**。

### 11.4 Round-4 变更与测试

- `pain-recall.ts`：T1 复检加尾部 main 复读 + 新注入点 `afterT1MainFingerprint`；模块头/docstring 契约改写（线性化点=r2、尾部探测器=r3、round-3 错误表述纠正）。逻辑增量一行读。
- 测试：interleave-1（trajectory：中途完整周期→拒绝 + 前置条件自证[wal 已删/main≠M0/行已提交] + 读取方零副作用断言在探针前执行并自清探针产物）；interleave-2（state.db：可选源降级 `unreadable`+`partial`+2 行存活——与 interleave-1 的权威源拒绝语义分开验证）。
- 回归：ro-1..11、race-1..4、inj-*、aba-1..5 全保留全绿（**25/25**）。

### 11.5 Round-4 验证

| 项 | 结果 |
|---|---|
| `pain-recall-readonly.test.ts` | **25/25 PASS** |
| `pain-recall` + `cli-command-tree` + `cli-help-snapshot` | 110/110 PASS |
| `tsc --noEmit` / `eslint` | PASS / PASS |
| pd-cli 全量×2 | 首跑 3 失败（candidate-intake e2e / scribe dispatch / demo help 快照，全部 `timed out in 5000ms`，隔离全绿 59/59+37/37，三用例均不触及 pain-recall 路径）；**复跑 2129/2129 全绿**——负载 flake，失败集未复现 |
| `npm run verify:merge`（串行单独跑） | 见提交附注与最终报告（website 字幕测试=main 既有失败已在 round-3 记录基线复现证据） |
| CLI 子进程冒烟（重建 dist） | 双场景（quiet/active WAL）见最终报告 |
| CI（新 head） | 以 GitHub Actions 收敛结果为准 |
