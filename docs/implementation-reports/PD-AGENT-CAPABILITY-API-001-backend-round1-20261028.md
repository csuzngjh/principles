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
