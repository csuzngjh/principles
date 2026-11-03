# PD_MCP_GATE4A_REALITY_CHECK

# Gate 4-A 现实核验报告（SDK 冻结 · 接入方案冻结 · 工作区绑定冻结）

| 字段 | 内容 |
|---|---|
| 文档性质 | Gate 4-A 退出交付物（SPEC-PD-MCP-GATE4-001 v1.2 §12 Gate 4-A） |
| 基线 | origin/main `457bbf0fc`；实施分支 `ai/PRI-1071-mcp-gate4`；工单 PRI-1071 |
| 授权 | OG-3 AUTHORIZED（2026-11-02）；D-06 OWNER_CONFIRMED（方案 A）——见 PD-MCP-GATE3-OWNER-DECISION-CARD §〇 r4 |
| 核验日期 | 2026-11-02 |
| 证据等级 | 源码级 CONFIRMED / 真实运行 CONFIRMED（已注明）/ 待宿主实测 NOT_VERIFIED（已注明） |

> **同步说明（2026-11-03 Gate 4 整改轮；历史正文保留，不追改快照）**
>
> 本文件是 2026-11-02 Gate 4-A 的冻结快照。整改轮把基线同步到 origin/main `9ef8d607d`，全部工作仍在 PR #2304（`ai/PRI-1071-mcp-gate4`），整改最终 head 为 `db33190b8`（2026-11-03）；PR 状态与 CI 结果以 `PD_MCP_GATE4_IMPLEMENTATION_REPORT.md` §1.3/§1.4 为准。以下两处实现已由后续 Gate 推进，正文按历史记录保留：
>
> 1. §4 接入方式表把 OpenClaw 的 binding 写入者记为 "PD installer（物化 extensions 副本时写入）"。实际实现为 OpenClaw 插件启动健康检查（`packages/openclaw-plugin/src/core/mcp-binding.ts`，与 hooks 同源解析 workspace），installer 物化 extensions 副本时不写 binding；整改轮又补上"workspace 无法解析时使旧 binding 失效"的 fail-closed 行为。
> 2. §6 绑定策略的 fail-closed 现在由三份字节一致的 launcher 执行（canonical entry、realpath 逃逸、Host/Schema/版本 pin 交叉校验），并由 `launcher-binding.test.ts` 机械钉住；WorkBuddy 的 binding 仍由 installer 在物化 marketplace 时写入，Codex 仍由 pd-setup 写入。
>
> SDK 冻结（`@modelcontextprotocol/server@2.4.0`）、插件内嵌 MCP 架构、binding 唯一业务工作区来源三项冻结结论未变。

---

## 1. 当前真实环境快照

| 组件 | 版本 | 证据 |
|---|---|---|
| Windows | 11 (10.0.26200 x64) | winver / OS report |
| Node.js | v26.7.0 | `node --version` |
| npm | 11.19.0 | `npm --version` |
| pnpm | 12.16.1 | `pnpm --version` |
| Codex CLI | 0.166.0（codex-cli 0.166.0） | `codex --version`；本机源码 D:/Code/codex HEAD=3026a8e54e（0.166.0 之后 124 commits，仅作检索参考，行为以安装二进制实测为准） |
| OpenClaw | 2026.10.5 (1b58cb9) | `openclaw --version`；源码 D:/Code/openclaw tag v2026.10.5 == 1b58cb9（`git show -s 1b58cb9` 确认） |
| WorkBuddy Desktop | **5.9.2**（app 版；exe ProductVersion 5.9.2.0） | `D:\Program Files\WorkBuddy\WorkBuddy.exe` VersionInfo；`~/.workbuddy/last-launch.json` `{"version":"5.9.2"}` |
| （澄清）37.10.3-43 | **Electron/Chromium 运行时版本，不是 app 版本** | `D:\Program Files\WorkBuddy\version` 文件内容 `37.10.3-43`；exe 内嵌 `Electron 37.10.3`；历史报告混用两字段，本报告起统一以 5.9.2 为 Desktop 版本 |
| 内嵌 agent-cli | @genie/agent-cli 2.165.0 | `resources/app.asar.unpacked/cli/package.json` |
| PD | 2.8.0（产品）；Core 1.298.2 | 根 package.json；packages/principles-core/package.json |

Gate 3 基线复核：worktree `PRI-1071-mcp-gate4` 上 `vitest run pain-recall` = **93/93 绿**（capability + architecture guards + readonly + service）——Gate 3 Capability 完整可用。

---

## 2. 三宿主支持证据

### 2.1 Codex 0.166.0 — CONFIRMED（源码 + 隔离环境真实运行）

| 核验项 | 结果 | 证据 |
|---|---|---|
| Plugin manifest `mcpServers` | 支持 Path（`.mcp.json` 路径）与内联 Object 两种形态 | codex-rs `core-plugins/src/manifest.rs:142-148`（RawPluginManifestMcpServers）；解析 `:440-466` |
| `.mcp.json` 默认回落 | manifest 未声明 mcpServers 时读插件根 `.mcp.json` | `core-plugins/loader.rs:76` DEFAULT_MCP_CONFIG_FILE、`:1144-1165` |
| stdio 字段 | command/args/env/env_vars/cwd | `config/src/mcp_types.rs:650-684` McpServerTransportConfig::Stdio |
| cwd 相对路径 | **相对 cwd 拼接已安装插件根** | `codex-mcp/src/plugin_config.rs:323-331`；**真实运行证实**：隔离 CODEX_HOME 探针，server 进程 `process.cwd()` = `~/.codex(隔离)/plugins/cache/<mkt>/<plugin>/<version>` |
| 真实 spawn + initialize | **真实运行证实** | 隔离环境 `codex exec` 会话在模型 API 调用前完成 MCP runtime 发布与 initialize（探针 evidence 落盘）；spawn 为直接 CreateProcess（无 cmd /c），Windows JobObject 管理进程树 |
| PLUGIN_ROOT/PLUGIN_DATA env | **不注入 legacy MCP server 进程**（hasPluginRoot/hasPluginData=false，真实运行） | 探针 evidence.json；源码中 env 注入仅见于 agent-plugin 格式（`agent_plugin_config.rs:229-230`） |
| `.mcp.json` env 字段透传 | 真实运行证实 | 探针经 env 收到 PROBE_EVIDENCE_FILE |
| 审批 | `readOnlyHint:true` + Auto/Writes 模式免审；无头 exec 下需审调用被取消，readOnlyHint=true 可执行 | `core/src/mcp_tool_call.rs:2595-2626`；`exec/src/lib.rs:2153-2168`（elicitation 取消）；Phase C 将以真实调用复验 |
| 安装/更新 | `codex plugin add principles-disciple@principles`；marketplace=本地目录（本机 source=`\\?\D:\Code\principles`，清单 `.agents/plugins/marketplace.json`）；**无 `plugin update` 子命令**，更新=marketplace 内容更新后重新 add；版本=cache 目录最大 semver | `cli/src/plugin_cmd.rs:52-79`；`~/.codex/config.toml:264-266`；探针实测 add 流程 |
| 同名冲突 | 用户 config 层(tier 2)覆盖插件层(tier 0) | `codex-mcp/src/catalog.rs:118-137` RegistrationPrecedence |
| marketplace 清单位置 | local 源根 `.agents/plugins/marketplace.json` | `core-plugins/src/loader.rs:505`；探针实测（先误放根目录被拒） |

### 2.2 OpenClaw 2026.10.5 — CONFIRMED（tag 精确源码 + 安装 dist 交叉验证）

| 核验项 | 结果 | 证据 |
|---|---|---|
| Plugin manifest `mcpServers` | 支持：`mcpServers?: Record<string, PluginManifestMcpServer>`（宽松 manifest 层 + transport 层校验） | `src/plugins/manifest-types.ts:510-511`；normalizers `:132-135`；文档 `docs/plugins/manifest.md:256` |
| stdio 启动 | command/args/env/cwd；**相对 command/args/cwd 相对插件根解析；有 command 无 cwd 时默认 cwd=插件根**；`${PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_ROOT}` 占位符展开（args/env/cwd） | `src/plugins/bundle-mcp.ts:125-198` absolutizeBundleMcpServer |
| MCP client | 标准官方 SDK（`@modelcontextprotocol/sdk` 1.32.0），stdio 自研 transport（SIGTERM/SIGKILL 终止） | `package.json`；`src/agents/mcp-stdio-transport.ts:39,224-233` |
| 生命周期 | 插件 activated 即纳入（PD 插件 `onStartup:true` 恒激活，**加 mcpServers 字段即生效，无需改 activation**）；懒连接（每 run 首次用时连接）；插件 reload/update 时 pluginOwned server 一律 retire+dispose | `src/plugins/bundle-config-shared.ts:113-119`；`src/agents/agent-bundle-mcp-runtime.ts:323-365` |
| declared surface | **新增 server 名构成能力面加宽 → 更新后需操作员 consent**（acceptedSurfaceHash 机制） | `packages/gateway-protocol/src/schema/plugin-declared-surface-groups.ts:1-12`；`src/plugins/capability-consent.ts:193-215` |
| contracts.tools | 与 mcpServers 无耦合（两套命名空间） | 文档 capabilities.md:93；bundle-mcp.ts:541-549 |
| 审批 | 内嵌 runtime 无 MCP 逐次人工审批门；工具策略/toolFilter 生效 | NOT_FOUND（源码全检索）；`src/agents/mcp-tool-filter.ts` |
| 安装布局 | `~/.openclaw/extensions/<plugin>`（**PD installer 物化部署**，非宿主自取） | `src/plugins/install-root-context.ts:23-28`；PD `installer.ts pluginInstallDirs` |

### 2.3 WorkBuddy Desktop 5.9.2 — CONFIRMED（安装产物 asar/cli bundle 反查 + 内置插件实例）

| 核验项 | 结果 | 证据 |
|---|---|---|
| 插件根 `.mcp.json` | 支持；`{"mcpServers":{...}}` 包装与顶层两种形态；**command/args/cwd/env 全支持**；`type:"stdio"` | cli bundle `codebuddy-lite-wb.mjs` readMcpJson/normalize 代码窗口；内置插件实例（下） |
| 占位符 | `${CODEBUDDY_PLUGIN_ROOT}`/`${CODEBUDDY_PLUGIN_DATA}`（command/args/cwd/env 均可） | miora 实例（下）；bundle McpConfigEnvExpandService |
| 内置 stdio 实例 | **mcp-miora**：`command:"node", args:["${CODEBUDDY_PLUGIN_ROOT}/dist/cli.cjs"], cwd:"${CODEBUDDY_PLUGIN_ROOT}", env:{...}, defer_loading:false`；**weixinpay**：`command:"${CODEBUDDY_PLUGIN_ROOT}/bin/run-node"` | `D:\Program Files\WorkBuddy\resources\app.asar.unpacked\resources\plugins\workbuddy-builtin\mcps\miora-mcp\.mcp.json`（全文已取证） |
| 插件安装 | 引擎命令（`node <engine> plugin marketplace add` / `plugin install`）从 marketplace 目录**复制**到 `~/.workbuddy/plugins/cache/<mkt>/<plugin>/<version>/`；引擎不可达时 direct-write fallback | PD `WorkBuddyHostInstaller`（安装器源码）；installed_plugins.json 实测 |
| 启用 | `~/.workbuddy/settings.json` `enabledPlugins`（user 全局）；`defaultEnabled:false` → 安装即 Disabled，需显式启用 | 实测 settings.json（PD 插件无条目=未启用）；PD plugin.json `defaultEnabled:false` |
| server 级信任审批 | 首次连接前 PENDING_APPROVAL（`~/.workbuddy/mcp-approvals.json`，键 `<server>::<sha256(config)>`）；Trust/Reject UI；`mcp:approve` IPC | asar McpTrustStore/McpManager 字符串取证；实测 approvals 文件 |
| readOnlyHint | 存入工具身份，用于并发安全判定；**不构成审批绕过** | bundle createMcpToolIdentity/isConcurrencySafe |
| 配置监听 | ConfigWatchService 监听 `.mcp.json` 变更 → 重载重连 | bundle 字符串取证 |
| MCP server 归属 | `plugin.json workbuddy.runtimeOwner: "daemon"|"agent-cli"` | miora 声明 `agent-cli` |

### 2.4 三宿主共同结论

**插件内置 MCP（plugin manifest mcpServers / 插件根 .mcp.json）在三个宿主全部为真实支持能力** —— SPEC §3.3 首选架构方向成立，无需 Native Tool Bridge，无需用户级 MCP 注册，无需独立常驻 Launcher 进程。

---

## 3. SDK 冻结决策

### 3.1 候选对比（npm registry + 本机真实握手矩阵）

| 维度 | v1：`@modelcontextprotocol/sdk` 1.32.2 | v2：`@modelcontextprotocol/server` 2.4.0（+core 2.4.0） |
|---|---|---|
| 定位 | 单包（server+client+全部 transport） | 官方**稳定线**（README："v2 … the stable release line"，实现 2026-07-28 spec） |
| 运行时依赖 | 18 个（express/hono/cors/ajv/jose/rate-limit… 对 stdio-only server 是纯负担） | **2 个**：zod ^4.2.0 + @modelcontextprotocol/core 2.4.0 |
| Node 引擎 | >=18 | >=20（Node 26.7.0 满足） |
| 协议版本 | latest 2025-11-25（支持回溯至 2024-10-07） | 与 v1 相同 latest 2025-11-25（协商实测） |
| registerTool 输入 | zod raw shape / Standard Schema（不接受裸 JSON Schema） | 同左 |
| 安装体积 | ~5.9MB | server+core ~8.5MB（含 sourcemap；我们仅 esbuild/tsc 产物分发，体积由构建决定） |

### 3.2 真实握手矩阵（本机 Node 26.7.0，2026-11-02，`.tmp/sdk-eval/`）

| client → server | initialize | tools/list | tools/call | annotations 透传 | 协商版本 |
|---|---|---|---|---|---|
| v1 client → **v2 server** | ✅ | ✅ | ✅ | readOnlyHint ✅ | 2025-11-25 |
| v2 client → v2 server | ✅ | ✅ | ✅ | ✅ | 2025-11-25 |
| v1 client → v1 server | ✅ | ✅ | ✅ | ✅ | — |
| v2 client → v1 server | ✅ | ✅ | ✅ | ✅ | 2025-11-25 |

（v1 client = OpenClaw 2026.10.5 / WorkBuddy 内嵌同族；Codex 为 Rust rmcp client——其协议实现以 2025-11-25 前后 spec 为准，Phase C 真实握手复验。）

### 3.3 冻结决定

- **SDK 包族：`@modelcontextprotocol/server`（v2 线）**
- **精确版本：2.4.0（锁死，禁止 latest/范围）**；传递依赖 `@modelcontextprotocol/core@2.4.0`、`zod`（以 lockfile 锁定）
- 理由：官方稳定线；依赖面最小（P3 最小变更面 + §9.2 依赖边界）；与全部现有 v1 系宿主 client 实测互操作；Node 26 兼容。
- SDK 只进入 MCP Server 包；Core 零依赖（新增架构守卫机械保证，Gate 4-B 交付）。

---

## 4. 插件接入方式（冻结）

统一模式：**一个共享 Server 实现 + 三个宿主插件各自内置 MCP 配置 + 每宿主一个零依赖 launcher.cjs + PD 拥有的 mcp-binding.json（机器级）**。

```text
宿主进程 ──spawn──> node <插件载荷>/mcp/launcher.cjs     （零依赖，随插件载荷分发，静态无机器路径）
                        │  读 <插件根>/mcp-binding.json   （PD installer/setup 写入，机器级，PD 拥有）
                        │  取 workspaceDir + serverEntry（~/.pd/runtime/pd-mcp-server/dist/…）
                        └─require(serverEntry)，注入 PD_MCP_WORKSPACE_DIR / PD_MCP_HOST
                                    │
                          pd-mcp-server（SDK 2.4.0，Gate 3 Capability 唯一业务入口）
```

| 宿主 | MCP 配置形态 | launcher 定位方式 | binding 写入者 |
|---|---|---|---|
| Codex | 插件载荷 `.mcp.json`（仓库静态）：`command:"node", args:["./mcp/launcher.cjs"], cwd:"."` | `cwd:"."` → 已安装插件 cache 根（真实运行证实）+ `__dirname` | `pd-setup`（安装后机器级接线步骤；插件 add 重装后需重跑，pd-status/health 检测 CONFIG_MISSING） |
| OpenClaw | manifest `mcpServers`（PD installer 物化部署副本）：`transport:"stdio", command:"node", args:["./mcp/launcher.cjs"]`（默认 cwd=插件根） | 相对路径按插件根解析（源码证实） | PD installer（物化 extensions 副本时写入） |
| WorkBuddy | 插件载荷 `.mcp.json`：`command:"node", args:["${CODEBUDDY_PLUGIN_ROOT}/mcp/launcher.cjs"], cwd:"${CODEBUDDY_PLUGIN_ROOT}"` | 占位符展开（miora 同模式） | PD installer（物化 marketplace 载荷时写入；引擎复制进 cache） |

**不采用**：Native Tool Bridge（无必要）；用户级 `codex mcp add` 默认化（SPEC §6.2 禁止）；常驻 daemon（§5.2 禁止）； PLUGIN_ROOT/PLUGIN_DATA env 依赖（Codex legacy 实测不注入）。

## 5. 版本与更新策略（冻结）

- MCP Server 随 **PD 正式发布**走 changeset → version-packages → publish 流程（包 `@principles/pd-mcp-server`，workspace 内部包）。
- 安装态：server 作为 `~/.pd/runtime` 组件部署（单槽 + 备份，release manager 原子更新，回滚复用既有机制）→ **MCP Server 版本与 Core 版本由同一 release 绑定，兼容性由发布列车保证**（SPEC §7.6 版本绑定要求）。
- 三宿主插件内的 launcher.cjs 为零依赖纯 JS，**接口面极小且稳定**（读 binding → require entry），随各插件 payload 正常版本化更新；binding 文件记录 serverEntry 与版本 echo，供 drift 检测。
- 发布清单每版记录：PD release / Core / pd-mcp-server / SDK 2.4.0 / Node 运行时 / pd.capability.v1 / od-a-v1 / 各插件版本 / 已验收宿主版本（SPEC §9.3）。

## 6. 工作区绑定策略（冻结）

1. workspaceDir **唯一来源**：`mcp-binding.json`（PD installer/setup 写入；含 schemaVersion/host/workspaceDir/serverEntry/version echo）。
2. Server 启动后 workspaceDir **不可变**；不存在任何回退：无 env → fail-closed；binding 缺失/损坏 → launcher fail-closed（stderr 结构化原因 + exit 1）。
3. **禁止** Agent 经 Tool 参数传递任何路径（输入合同仅 principleId/limit，多余属性拒绝——Capability 层已实现）。
4. **禁止** process.cwd()/HOME 隐式解析业务工作区（launcher 自身定位用 `__dirname`/宿主占位符，属载荷定位非业务回退）。
5. 启动期只读安装元数据（binding 文件）——SPEC §3.5 允许的严格受限解析器；**业务数据读取唯一入口 = Gate 3 Capability**（`@principles/core/runtime-v2/pain-recall-capability`）。

## 7. 主要技术风险

| 风险 | 等级 | 缓解 |
|---|---|---|
| Codex 插件重装（plugin add）清掉 pd-setup 写入的 binding（cache 目录被重建） | 高 | pd-status/health 检测 CONFIG_MISSING + nextAction 指向 pd-setup 重跑；文档明示"plugin add 后需 setup" |
| Codex 无头工具调用审批（0.166 实验曾受阻） | 中 | readOnlyHint:true + Auto 模式免审（源码证实）；Phase C 真实调用复验；如仍受阻如实标记并升级（不使用危险 bypass） |
| OpenClaw declared-surface consent（新增 mcpServers 触发） | 中 | 首装/更新流程中呈现 consent；E2E 验证；文档说明 |
| WorkBuddy 引擎命令不可达时的 direct-write 路径与 cache 复制时序 | 中 | Phase E 分别验证引擎路径与 fallback；binding 在物化 marketplace 时写入 |
| SDK v2 生态较新 | 低 | 稳定线 + 互操作矩阵 4/4 + 锁版分发（bundle 内置依赖，宿主不解析 SDK） |
| `node` 不在宿主 PATH | 低 | PD 安装前置检查已含 node；WorkBuddy 有 run-node 模式可后备 |
| 32KiB 边界/10s deadline 实现 | 低 | Gate 4-B 契约测试（32768 通过/32769 拒绝；计时/迟到抑制/资源释放） |

## 8. Gate 4-B 实施设计（摘要）

1. 新包 `packages/pd-mcp-server`（npm 名 `@principles/pd-mcp-server`）：tsc 构建，依赖 `@principles/core`（workspace）+ `@modelcontextprotocol/server@2.4.0`（精确锁版）；入口 `dist/index.js`（由 launcher require）。
2. 唯一 Tool `pd_recall_principle_pains`：zod raw shape 输入（principleId 1..200 必填 / limit 1..10 默认 3 / 拒绝未知属性），`readOnlyHint:true` 诚实声明。
3. 输出：单 text content block（`pd.capability.v1` JSON）；32768 bytes 通过 / 32769 拒绝（`unavailable`+`response_budget_exceeded`，isError=true，错误信封自身 <32KiB）；不启用 structuredContent；不静默截断。
4. 错误映射按 SPEC §4.8 表（isError 仅 disclosure_assertion_failed / Adapter 执行失败两类）。
5. Deadline 10s：handler 起算（校验+Capability+投影+序列化）；Promise.race 停止等待 + 迟到结果抑制 + 在途超时任务上限 + 资源释放验证；不宣称底层可取消。
6. stdout 纯协议 / 日志 stderr 脱敏（无堆栈/路径/环境值/Pain 文本）。
7. 架构守卫（新增 vitest）：Core 不依赖 MCP SDK（依赖面检查）；pd-mcp-server 仅经 `@principles/core/runtime-v2/pain-recall-capability` 访问业务；pd-cli 不引用 pd-mcp-server。
8. 打包：workspace 构建 + release 载荷加入 pd-mcp-server 组件（Phase F 接线 installer）。

## 9. Gate 4-A 退出判定

- 三宿主插件级 MCP 支持：全部 CONFIRMED（含 Codex 真实运行探针）。
- SDK 冻结：`@modelcontextprotocol/server@2.4.0`，互操作矩阵 4/4。
- 接入方式/版本更新/工作区绑定：如上冻结，无影响实施的重大架构歧义。
- 未验证项均已标注且全部落在 Gate 4-C/D/E 执行项内（宿主真实 E2E）。

**Gate 4-A：PASS。按 OG-3 授权直接进入 Gate 4-B。**
