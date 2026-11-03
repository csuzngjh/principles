# PD_MCP_GATE4_IMPLEMENTATION_REPORT

# Gate 4 实施报告（SPEC-PD-MCP-GATE4-001 v1.2 → 代码/测试/宿主证据）

| 字段 | 内容 |
|---|---|
| 实施工单 | PRI-1071（In Progress） |
| 授权 | OG-3 AUTHORIZED（2026-11-02，隔离环境 4-A～4-F）；D-06 方案 A OWNER_CONFIRMED（Decision Card §〇 r4） |
| 基线 | origin/main `457bbf0fc` → 整改后同步至 origin/main `9ef8d607d`（2026-11-03）；分支 `ai/PRI-1071-mcp-gate4`（worktree `D:\Code\_worktrees\principles\PRI-1071-mcp-gate4`） |
| 交付形态 | PR #2304（OPEN，未合并）；整改提交已推送到分支，等待 Owner 审阅。**未合并/未发布/未部署** |
| 状态 | **Gate 4 主体完成并完成整改轮；两宿主 RUNTIME_VERIFIED，一宿主 IMPLEMENTED_NOT_RUNTIME_VERIFIED（外部条件阻断，补验路径明确）** |

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
| P1-2 Release Lock | 新增 `release-locks/pd-mcp-server/package-lock.json`（lockfileVersion 3；`@modelcontextprotocol/server@2.4.0` exact、`zod@4.6.7` exact），由仓库既有 `generate:release-locks` 生成 | `check:release-locks` 以 `npm ci --omit=dev --ignore-scripts --legacy-peer-deps --install-links` 验证 9 个组件通过；生成前后 sha256 对比见 §1.2 |
| P1-3 干净环境构建 | 统一构建顺序 pd-mcp-server → installer → plugin bundle → release asset；`mcp-server-build.mjs` 为共享构建入口；bundle 缺组件时删除陈旧载荷，禁止携带本地残留 dist | 干净临时 HOME + 无 npm 的 self-contained 安装 smoke 15/15（532s）；release asset smoke 5/5（656s，含 "installs from pipeline output without invoking npm" 与 canonical MCP entry 断言） |
| P1-4 守卫/发布列车/交付 | Runtime Writer 精确 allowlist；核心架构守卫精确登记（不删守卫）；`runtime-version.json` 四包 pin；发布列车 9 腿（pd-mcp-server 为第 5 腿）；Codex 插件交付 CI 使用 PR 构建的本地 tarball + 隔离安装验证，不访问 npm | `check:runtime-writers` PASS（10 条均带理由）；architecture-regression 493；`codex-runtime-delivery` / `publish-recovery` 契约测试；CI `codex-plugin-delivery` job |
| P1-5 MCP 测试入 CI 与 verify:merge | 新增 CI job `test-pd-mcp-server`（node 22）；`verify:merge` 显式运行 `npm test --workspace=@principles/pd-mcp-server`；覆盖 initialize/tools-list/tools-call/Schema/32KiB/deadline/并发准入与孤儿释放/stdout 纯协议/stderr 脱敏/isError 映射/workspace fail-closed/子进程关闭/安装包运行验证 | `.github/workflows/ci.yml`；根 `package.json` verify:merge；MCP 84/84 |
| P2 Binding 安全 | 三宿主 launcher 统一 canonical entry、realpath 逃逸、Host/Schema/版本 pin 交叉校验；非法/伪造/跨宿主 fail-closed；workspace 无法解析时 `invalidateMcpBinding` 使旧 binding 失效 | launcher-binding 27 测试、workspace-binding 9 测试；三份 launcher 字节同源守卫 |
| P2 pd health | 复用 `pd health` 增 MCP 只读诊断（安装/入口/版本 pin/binding schema/host/workspace/canonical/宿主配置/restart）；不可判定输出 `unverified`；不启动 server、不执行业务 Tool | `health-mcp.ts`；health 套件 54/54（含 health-mcp 16） |
| P2 CodeQL | `workspace-binding.test.ts` 改用 `mkdtemp` + 独占创建 + `finally` 清理 | `workspace-binding.test.ts`；CodeQL 状态见 PR 检查 |

## 1.2 Release Lock 可复现性

`npm run generate:release-locks` 连续生成，9 个 `release-locks/**/package-lock.json` 的 sha256 前后一致；`check:release-locks` 逐组件 `npm ci` 通过（0 失败）。

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

- 量化门槛：20/20 握手 ×3 形态、20/20 发现 ×3、20/20 真实调用 ×3（门槛 10）、≤1.05s/轮、32768/32769 包级钉住、关停 20×3 + 包级 10 循环、重复安装 ×3 幂等、**更新成功/卸载/配置保护已验证**；**更新失败回滚未验证**（binding 损坏 fail-closed 与 pd-setup 手动恢复只证明检测与恢复动作，不证明"恢复上一可用版本且可调用"；installer 回滚为继承的既有机制，本 PR 未对 MCP 更新失败做故障注入）。
- 非回归（2026-11-03 实跑）：pd-mcp-server 84/84；pd-cli MCP health 54/54；core pain-recall 93/93（core 全套 586 通过）；codex-adapter 362 passed / 1 skipped；installer WB 58/58；openclaw-plugin 2314 passed / 4 failed（3 文件 4 测试与 main 基线逐字一致，Windows tar/EPERM/宿主路径环境性）；发布列车契约 36/36；scripts 套件 3 处真实回归已修，其余失败项隔离复跑全绿（90/90、26/26）。
- **同名冲突检测未实现**：宿主优先级行为已验证，但 PD 侧不检测、不报告、不停止安装（SPEC §7.5/§11.3），生命周期表标记未通过。
- **多 agent 单绑定限制**：OpenClaw 健康检查以 `main` 解析 workspace 写入唯一 binding；未配置 PD 显式工作区时，其他 agent 的 MCP 调用会读到 `main` 工作区数据（既有单绑定架构限制，重新设计三宿主插件架构不在本轮范围）。
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

1. 同名冲突检测与"明确报告并停止安装"（SPEC §7.5/§11.3）——当前未实现，生命周期验收标记未通过。
2. MCP 更新失败注入 + 上一可用版本自动恢复（当前仅 pd-status 检出 + 手动 `$pd-control setup`）。
3. Codex 模型级 10/10 补验（配额恢复后，夹具就绪）——Owner 补验项，不在本轮 CI 模拟。
4. WB 模型级 10/10 补验（需一次交互式登录）——Owner 补验项，不在本轮 CI 模拟。
5. 多 agent 单 binding 限制（OpenClaw 以 `main` 解析 workspace）——属既有架构，重新设计不在本轮范围。
6. OpenClaw declared-surface consent 文案的产品化润色（现走宿主通用 consent 流）。
7. install-layout 兼容孪生退役：`packages/create-principles-disciple/src/mcp-server-layout-compat.ts` 仅为规避"已安装版本尚无 `getMcpServerEntry`/`mcpServerDir`"的 PRI-669 缺陷类；待下一个含 `.changeset/mcp-install-layout-entry.md` 的 install-layout 版本发布并进入 runtime pin 后，删除孪生并直接使用发布的导出。
