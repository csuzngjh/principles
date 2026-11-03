# PD_MCP_GATE4_IMPLEMENTATION_REPORT

# Gate 4 实施报告（SPEC-PD-MCP-GATE4-001 v1.2 → 代码/测试/宿主证据）

| 字段 | 内容 |
|---|---|
| 实施工单 | PRI-1071（In Progress） |
| 授权 | OG-3 AUTHORIZED（2026-11-02，隔离环境 4-A～4-F）；D-06 方案 A OWNER_CONFIRMED（Decision Card §〇 r4） |
| 基线 | origin/main `9ef8d607d`（2026-11-03）；上一轮整改 head `2fa6c54ed`；第三轮整改提交见 PR #2304 时间线（本报告不预判最终 head）；分支 `ai/PRI-1071-mcp-gate4`（worktree `D:\Code\_worktrees\principles\PRI-1071-mcp-gate4`） |
| 交付形态 | PR #2304（OPEN，未合并）；第三轮整改提交已推送到分支，等待 Owner 审阅。**未合并/未发布/未部署** |
| 状态 | **Gate 4 主体完成；三项阻断项（OpenClaw 多工作区隔离 / WorkBuddy 更新失败回滚 / 三宿主同名冲突）已闭环；两宿主 RUNTIME_VERIFIED，一宿主 IMPLEMENTED_NOT_RUNTIME_VERIFIED（外部条件阻断，补验路径明确）** |

---

## 1. 提交序列（Gate 4 主体 + 整改轮）

| 提交 | 内容 |
|---|---|
| `64385e2e3` | 治理记录 r4（OG-3/D-06）+ SPEC v1.2 入库（头改 ACCEPTED，正文合同未动） |
| `f3f99959f` | Gate 4-A REALITY_CHECK（三宿主核验 + SDK 冻结 + 绑定冻结；含 Codex 真实运行探针） |
| `e8a5f7ba7` | Gate 4-B：`packages/pd-mcp-server`（整改后 7 文件 / 84 测试：协议契约/预算边界/deadline 并发准入/绑定/真实进程 stdio/G4-1..G4-7 守卫） |
| `0b690008e` | Gate 4-C：Codex 插件内置 MCP（.mcp.json + launcher + 四包 pin 列车 + pd-setup binding + pd-status 检测） |
| `382b635ff` | Codex 测试卫生（repo 载荷保护 + repair 路径 stub source） |
| `add5476dc` | Gate 4-D：OpenClaw manifest mcpServers |
| `59229d44a` | Gate 4-E：WorkBuddy 插件 .mcp.json（v0.2.2，defaultEnabled:false 保持） |
| `ca05f1fbc` | Gate 4-F：installer 组件打包 + 三宿主 binding 写入 + 卸载语义 + 测试 |

## 1.1 整改轮（2026-11-03，Owner 整改指令 v1.0）

| 项 | 整改内容 | 证据 |
|---|---|---|
| P1-1 Deadline 并发准入 | `AdmissionLimiter.tryAcquire()` 在 Capability 调用前同步预留；超时只停止等待、不释放容量；容量仅在底层真实结算（完成/异常/孤儿结算）后释放；保留 10s deadline 与迟到结果抑制 | `deadline.ts` / `server.ts`；`deadline.test.ts` 真实并发：6 并发仅 4 启动、超限请求未启动即拒绝、超时后 active 仍为 4、结算 2 个后恰好再准入 2 个、全路径释放后 active/orphan=0；MCP 套件 84/84 |
| P1-2 Release Lock | 新增 `release-locks/pd-mcp-server/package-lock.json`（lockfileVersion 3；`@modelcontextprotocol/server@2.4.0` exact、`zod@4.6.7` exact），由仓库既有 `generate:release-locks` 生成 | `check:release-locks` 以 `npm ci --omit=dev --ignore-scripts --legacy-peer-deps --install-links` 验证 10 个组件通过；生成前后 sha256 对比见 §1.2 |
| P1-3 干净环境构建 | 统一构建顺序 pd-mcp-server → installer → plugin bundle → release asset；`mcp-server-build.mjs` 为共享构建入口；bundle 缺组件时删除陈旧载荷，禁止携带本地残留 dist | 干净临时 HOME + 无 npm 的 self-contained 安装 smoke 15/15（532s）；release asset smoke 5/5（656s，含 "installs from pipeline output without invoking npm" 与 canonical MCP entry 断言） |
| P1-4 守卫/发布列车/交付 | Runtime Writer 精确 allowlist；核心架构守卫精确登记（不删守卫）；`runtime-version.json` 四包 pin；发布列车 9 腿（pd-mcp-server 为第 5 腿）；Codex 插件交付 CI 使用 PR 构建的本地 tarball + 隔离安装验证，不访问 npm | `check:runtime-writers` PASS（10 条均带理由）；architecture-regression 493；`codex-runtime-delivery` / `publish-recovery` 契约测试；CI `codex-plugin-delivery` job |
| P1-5 MCP 测试入 CI 与 verify:merge | 新增 CI job `test-pd-mcp-server`（node 22）；`verify:merge` 显式运行 `npm test --workspace=@principles/pd-mcp-server`；覆盖 initialize/tools-list/tools-call/Schema/32KiB/deadline/并发准入与孤儿释放/stdout 纯协议/stderr 脱敏/isError 映射/workspace fail-closed/子进程关闭/安装包运行验证 | `.github/workflows/ci.yml`；根 `package.json` verify:merge；MCP 84/84 |
| P2 Binding 安全 | 三宿主 launcher 统一 canonical entry、realpath 逃逸、Host/Schema/版本 pin 交叉校验；非法/伪造/跨宿主 fail-closed；workspace 无法解析时 `invalidateMcpBinding` 使旧 binding 失效 | launcher-binding 27 测试、workspace-binding 9 测试；三份 launcher 字节同源守卫 |
| P2 pd health | 复用 `pd health` 增 MCP 只读诊断（安装/入口/版本 pin/binding schema/host/workspace/canonical/宿主配置/restart）；不可判定输出 `unverified`；不启动 server、不执行业务 Tool | `health-mcp.ts`；health 套件 54/54（含 health-mcp 16） |
| P2 CodeQL | `workspace-binding.test.ts` 改用 `mkdtemp` + 独占创建 + `finally` 清理 | `workspace-binding.test.ts`；CodeQL 状态见 PR 检查 |

## 1.1a 第三轮整改（2026-11-03，Owner 最终阻断项）

| 阻断项 | 根因 | 修复 | 测试 / 真实运行证据 |
|---|---|---|---|
| P0-1 OpenClaw 多工作区 Binding 错配 | 健康检查用 `{ agentId: 'main' }` 解析 workspace 并写唯一 binding；多 Agent 时 MCP 绑定 main 的工作区，造成跨工作区原则经验召回泄漏 | `resolveExplicitPdWorkspaceDir()` 只接受 Owner 显式声明（`PD_WORKSPACE_DIR`/`OPENCLAW_WORKSPACE`/`principles-disciple.json`）；`syncMcpBindingFromExplicitWorkspace()` 无显式声明时删除旧 binding（fail-closed）；`pd-mcp-server` startup 日志增加 workspace fingerprint（哈希，非路径）供进程级取证 | `mcp-binding-isolation.test.ts` 6/6；`mcp-launcher-workspace-isolation.test.ts` 3/3（真实 launcher 子进程 + 真实 MCP client；X/Y 指纹与数据互不交叉；无 binding → 连接拒绝） |
| P0-2 WorkBuddy 更新失败回滚 | 既有验收只有 corrupt-binding / pd-setup 恢复，不证明「真实故障后旧版本恢复并可继续提供 MCP」 | 复用既有 staging/backup/rollback 事务；测试以**真实只读 `installed_plugins.json`** 在 cache swap 后注入提交失败 | `workbuddy-update-rollback-fault-injection.test.ts`：`workbuddy_registration_commit_failed` + 旧 cache 逐文件 sha256 一致 + settings/registry sha256 不变 + staging 清理 + 真实 launcher initialize/tools/list/tools/call 返回旧工作区数据 |
| P0-3 三宿主同名注册冲突 | SPEC §7.5/§11.3 要求同名冲突明确报告并停止，PD 侧无检测 | 新增只读分类器 `mcp-registration-conflict.ts`（A 同名 PD → 幂等；B 同名他方 → 安装前停止；C 不同名 → 共存；D 损坏/归属不明 → fail-closed）；接入 OpenClaw/WorkBuddy installer、Codex `$pd-control setup`、`pd health` | `mcp-registration-conflict.test.ts` 14/14（三宿主配置 sha256/mtime 前后不变、marketplace/settings/cache/plugin-data 零创建）；`health-mcp.test.ts` 19/19（`CONFIG_DRIFT` + reason/nextAction） |

本轮未新增 daemon / 数据库 / Feature Flag / 持久化状态 / 第二套注册管理系统；未改动 Gate 3 Capability、三宿主插件架构与 Hook/CLI 合同。

## 1.2 Release Lock 可复现性

`npm run generate:release-locks` 连续生成，10 个 `release-locks/**/package-lock.json` 的 sha256 前后一致；`check:release-locks` 逐组件 `npm ci` 通过（0 失败）。`pd-mcp-server` lock 的 sha256 = `28be450bfafbe0fda7d13a20abd0b5d09906729c379e784d12706b1f112234bf`；解析结果：`@modelcontextprotocol/client@2.4.0`、`@modelcontextprotocol/core@2.4.0`、`@modelcontextprotocol/server@2.4.0`、`zod@4.6.7`。

## 1.3 整改轮评审处置（CodeRabbit 21 条 + CodeQL 1 条，逐条在当前 head 复核）

| 评审项（路径） | 判定 | 处置与证据 |
|---|---|---|
| `deadline.ts:56` 截止后成功判定 | 属实（历史） | 已加 `startedAt` 耗时复检（`deadline.ts` `runWithDeadline` `Date.now() - startedAt < deadlineMs`）；`deadline.test.ts` 覆盖 |
| `bundle-plugin.mjs` 缺组件时陈旧输出 | 属实 | `else` 分支 `rmSync(MCP_SERVER_DEST)`（423–430 行） |
| launcher `schemaVersion` 未脱敏 | 属实 | `schemaKind` 白名单字符 + 60 字符上限；三份 launcher 字节同源 |
| OpenClaw workspace 无法解析时旧 binding 残留 | 属实 | `invalidateMcpBinding()` fail-closed（`index.ts:183`） |
| OpenClaw 多 agent 固定绑定 `main` | 属实（第三轮已修复） | 不再从 `main` 推断：`syncMcpBindingFromExplicitWorkspace()` 仅接受显式 PD 工作区，无显式声明即删除旧 binding；真实双 workspace 进程证据见 §1.1a / LIFECYCLE §4.1 |
| OpenClaw 缺组件无结构化 warning | 属实 | `ensureMcpBinding` 返回 `mcp_server_component_missing`，健康检查日志输出 |
| `pd-setup` marker 未记录 MCP 来源 | 属实 | marker 增 `mcpServerSource`；来源标志存在即禁用短路 |
| `pd-setup` 先写 binding 后注册 worker | 属实 | binding 写入移到 `registerWorkspaceWorker` 成功之后（352–354 行） |
| `pd-status` 缺 `mcpServer` pin 仍报 ok | 属实 | 缺失/非字符串 → `degraded` |
| `pd-status` 未检查 binding 目标存在 | 属实 | `targetsPresent`（workspaceDir + serverEntry） |
| `pd-status` 未校验 `--workspace` 一致 | 属实 | `boundWorkspace`（samePath 比较） |
| `verify-pinned-runtime-capability` 未装 MCP pin | 属实 | 四 pin 校验 + 安装 `@principles/pd-mcp-server@${pins.mcpServer}` |
| 生命周期表“同名冲突 ✅” | 属实（历史）；第三轮已补齐实现 | 第三轮新增安装前冲突门 + 测试后恢复 ✅（见 §1.1a P0-3；历史结论保留于 LIFECYCLE §5） |
| 生命周期表“更新失败恢复上一版本 ✅” | 属实（历史）；第三轮已补齐验收 | 第三轮真实故障注入验证 WorkBuddy 回滚（见 §1.1a P0-2；历史结论保留于 LIFECYCLE §5） |
| 宿主矩阵“更新失败回滚” | 属实（历史）；第三轮已补齐验收 | 更新为 PASS（真实注入 + 恢复后 MCP 调用） |
| 实施报告“更新/恢复/卸载全过” | 属实（历史）；第三轮已补齐验收 | 更新为“更新失败回滚 PASS（WorkBuddy 安装器级）”，Codex 宿主清 payload 的手动恢复边界仍保留 |
| SPEC §17 OG-3 状态 | 属实 | 增加“当前状态/历史状态”分段，NOT_AUTHORIZED 标为历史 |
| 决策卡 r3 记录 | 属实 | r3 的 NOT_AUTHORIZED 标注“已被 r4 取代，仅作历史” |
| `installer.ts` 忽略 `installBundledMcpServer` 返回值 | 属实 | `if (mcpServerInstalled)` 后才链接/装依赖 |
| npm 分发路径缺 MCP 运行依赖 | 属实 | `installMcpServerDependencies()` + `ensureComponentFileDependencyLinks()` |
| WorkBuddy 同版本重装未同步 cache binding | 属实 | `pluginCacheMatchesPayload` 纳入 `mcpBindingMatches`（忽略 `writtenAt`），不一致即刷新 cache |
| CodeQL 810 测试临时文件 | 属实 | `workspace-binding.test.ts` 改用 `withTempDir`/`mkdtemp`；新 CodeQL 分析复核（PR merge ref 0 open alerts） |
| 测试夹具未随 `pd-mcp-server` 必需组件更新 | 属实（CI 实跑发现） | 10 个安装/资产夹具补 `pd-mcp-server/package.json` + `dist/index.js`，WorkBuddy skeleton 补 `mcp/launcher.cjs`；**未放宽任何生产校验**（提交 `db33190b8`） |

本轮 CI 额外发现并修复两项：
- `mcpBindingMatches` 的 `as Record<string, unknown>` 触发 `check:runtime-contract` ERR-001；已改为文件内 `isRecord` 守卫（提交 `f342709cf`）。
- 生产代码把 `pd-mcp-server` 纳入安装器/发布资产必需组件后，10 个测试夹具仍按旧组件清单构造载荷，导致 `Test create-principles-disciple` 59 个用例在同一根因失败；夹具已镜像生产载荷契约（提交 `db33190b8`）。修复后本地 10 个套件 112 用例全绿，CI 该 job 转绿。

## 1.4 整改轮最终 CI 实跑（head `db33190b8`，2026-11-03）

| Workflow run | 结果 |
|---|---|
| CI `41583148953` | **success** — 17/17 jobs |
| CodeQL `41583148899` | **success**（`Analyze (javascript-typescript)` PASS；PR merge ref 0 open alerts） |
| PR Checks `41583148898` | success |
| Release Reproducibility `41583148992` | success |
| pd-console E2E `41583148999` | success |
| Repo Health Check `41583148952` | success |

17 个 CI job 全部 PASS：Verify Merge Gate（212s）、Lint、Test pd-mcp-server（41s）、Test principles-core（97s）、Test create-principles-disciple（364s，含本轮夹具修复）、Test OpenClaw Plugin、Build OpenClaw Plugin、Test shared runtime & adapters、Test release asset smoke、Test packaged install smoke、Codex plugin delivery contract、Release Build Parity、Test pd-cli、Test pd-console、TypeScript Check (pd-console)、CI Impact Gate、Telemetry Union Guard。

**唯一红项（advisory，非合并必需）**：`codecov/patch` 83.82% < target 84.42%；11 行未覆盖，其中 `packages/openclaw-plugin/src/index.ts` 10 行（37.50%）、`src/core/mcp-binding.ts` 1 行（98.07%），均属启动健康检查接线分支。分支保护仅要求 `Verify Merge Gate`（已 PASS），故该项不阻塞合并；未为凑覆盖率制造测试。

## 2. 架构落点（与 SPEC §3 逐条对应）

```text
宿主进程 ──spawn──> node <插件载荷>/mcp/launcher.cjs   （零依赖 canonical launcher，三宿主字节同源，G4-7 钉住）
                        │ 读 <载荷根>/mcp-binding.json  （PD 自有，机器级；三宿主各有唯一写入者）
                        │   Codex: pd-setup（安装后接线，插件 add 后重跑）
                        │   OpenClaw: 插件启动健康检查（与 hooks 同源运行时 workspace 解析）
                        │   WorkBuddy: installer 物化 marketplace 时（frozen workspace SSoT）
                        └ require(serverEntry=~/.pd/runtime/pd-mcp-server/dist/index.js)（in-process）
                                    │
                          pd-mcp-server（SDK @modelcontextprotocol/server@2.4.0 exact）
                                    │ 唯一 Tool pd_recall_principle_pains（readOnlyHint:true 诚实）
                                    └ @principles/core/runtime-v2/pain-recall-capability（Gate 3 Facade，OD-A v1）
```

- **32 KiB / 10s 归 Adapter**（budget.ts/deadline.ts）；**10 条/OD-A 归 Core**（未复制）；isError 两类映射严格服从 Gate 3 v0.5 §10.1。
- **fail-closed**：binding 缺失/损坏/相对路径/目录不存在 → exit 1 前置；无 cwd/HOME 业务回退。
- **守卫 G4-1..G4-7**（机械）：Core 零 MCP SDK；Capability 子路径唯一业务入口；无 CLI 子进程查询；pd-cli 独立；exact pin；版本一致；launcher 三载荷字节同源。

## 3. 验收结论（细节见 HOST_ACCEPTANCE_MATRIX / LIFECYCLE_ACCEPTANCE）

- 量化门槛：20/20 握手 ×3 形态、20/20 发现 ×3、20/20 真实调用 ×3（门槛 10）、≤1.05s/轮、32768/32769 包级钉住、关停 20×3 + 包级 10 循环、重复安装 ×3 幂等、**更新成功/卸载/配置保护已验证**；**更新失败回滚已由第三轮真实故障注入验证 PASS**（§1.1a；历史“未验证”结论保留于 LIFECYCLE §5 历史快照）。
- 非回归（2026-11-03 实跑）：pd-mcp-server 84/84；pd-cli MCP health 54/54；core pain-recall 93/93（core 全套 586 通过）；codex-adapter 362 passed / 1 skipped；installer WB 58/58；openclaw-plugin 2314 passed / 4 failed（3 文件 4 测试与 main 基线逐字一致，Windows tar/EPERM/宿主路径环境性）；发布列车契约 36/36；scripts 套件 3 处真实回归已修，其余失败项隔离复跑全绿（90/90、26/26）。
- **同名冲突检测已闭环（第三轮）**：三宿主安装前统一分类（A 幂等 / B 冲突停止 / C 共存 / D fail-closed），冲突时配置 sha256/mtime 不变；`pd health` 同步报告。历史“未实现”结论保留于 LIFECYCLE §5。
- **多 agent 单 binding 已闭环（第三轮）**：binding 仅由显式 PD 工作区写入；无显式声明时删除旧 binding，launcher fail-closed；hooks 仍按 agent 各自 workspace。真实双 workspace 进程证据见 LIFECYCLE §4.1。
- 宿主判定：**Codex RUNTIME_VERIFIED（集成面；模型级调用被 Owner OpenAI 配额阻断至 11-06）；OpenClaw RUNTIME_VERIFIED（含真实模型级调用——三宿主唯一）；WorkBuddy IMPLEMENTED_NOT_RUNTIME_VERIFIED（Desktop 令牌不可文件移植，需一次交互式登录）**。
- 按 SPEC §13：**尚未宣布"完整交付"**——剩余为两项纯执行验证（无实现工作）。

## 4. 复杂度增量（§13 Constitution gate）

```text
New durable source of truth: NO（binding 是派生接线文件，写入者唯一/宿主各一）
New persisted schema/state:  NO（binding 为 JSON 文件，无新库/迁移）
New subsystem/service/background process: NO（无 daemon；server 为宿主子进程）
New public abstraction/interface: YES — @principles/pd-mcp-server 包 + pd.mcp-binding.v1 契约
New runtime feature flag: NO
New cross-package dependency: YES — pd-mcp-server→core（经既有公共子路径）+ SDK（仅此包）
New host/platform-specific behavior: YES — 三宿主插件内嵌 MCP 配置（SPEC 产品目标本身）
New external/network capability: NO（stdio only，无联网）
```

YES 项论证：public 包是 SPEC G4-01 的直接交付物（零实现替代不存在）；跨包依赖方向被 G4-1/G4-2 机械守卫；宿主行为是产品合同本身。回滚：整分支单 revert；运行态回滚 = 卸载插件/binding 删除即 fail-closed 停服，不影响 PD 其他能力。

## 5. 授权边界遵守声明

- 未修改 Owner 日常宿主配置（全部隔离环境：CODEX_HOME / openclaw --profile / CODEBUDDY_CONFIG_DIR）。
- 已创建 PR #2304 并推送整改提交；**未合并、未发布 npm、未发布正式 PD Release、未部署生产、未修改 Linear 状态**。
- 未扩大 Tool 范围（仍唯一只读）、未改 Hook/CLI/RuleHost/RuleCode 合同。
- 一次事故自纠：commit 0b690008e 曾误含 repo 载荷下的机器级 mcp-binding.json（fixture 副作用）——amend 移除 + fixture 清理 + 文件内顺序卫生测试防再犯。

## 6. 遗留（follow-up 候选，未自动实施）

1. ~~同名冲突检测与"明确报告并停止安装"（SPEC §7.5/§11.3）~~——第三轮已实现（§1.1a P0-3）。
2. ~~MCP 更新失败注入 + 上一可用版本恢复~~——WorkBuddy 安装器级回滚已由第三轮真实注入验证（§1.1a P0-2）；Codex 宿主更新清 payload 后的 binding 手动恢复仍保留（属宿主插件机制，非 PD installer 事务）。
3. Codex 模型级 10/10 补验（配额恢复后，夹具就绪）——Owner 补验项，不在本轮 CI 模拟。
4. WB 模型级 10/10 补验（需一次交互式登录）——Owner 补验项，不在本轮 CI 模拟。
5. ~~多 agent 单 binding 限制（OpenClaw 以 `main` 解析 workspace）~~——第三轮已改为显式工作区 + fail-closed（§1.1a P0-1）。
6. `deadline.ts` 同步组装跨截止的复检、launcher schema 脱敏、pd-status mcpServer pin 早前整改已包含；CodeRabbit 仍显示未解决的历史线程以代码/测试复核为准。
7. OpenClaw declared-surface consent 文案的产品化润色（现走宿主通用 consent 流）。
8. install-layout 兼容孪生退役：`packages/create-principles-disciple/src/mcp-server-layout-compat.ts` 仅为规避"已安装版本尚无 `getMcpServerEntry`/`mcpServerDir`"的 PRI-669 缺陷类；待下一个含 `.changeset/mcp-install-layout-entry.md` 的 install-layout 版本发布并进入 runtime pin 后，删除孪生并直接使用发布的导出。
