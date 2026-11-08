# PRI-1150 Path A — 隔离宿主验证 隔离预检报告（第二部分 §二）

- 文档 ID：`pri-1150-isolated-host-preflight-20261108`
- 状态：离线预检完成（只读核实 + 离线夹具验证）；**运行卡已就绪待批**（§五）
- 范围：仅装配观察验证；不证明最终请求、送达、原则遵循或行为改善

## 1. 官方宿主与 PD 候选构建核实（§二.1）

| 项 | 值 | 核实方式 |
|---|---|---|
| 官方宿主 | OpenClaw **2026.11.1** | 已安装产物 `C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\package.json` version 字段；`openclaw --version` 构建戳 4ffdd2047d1（release/2026.11.1 分支祖先，已前轮核实） |
| PD 候选构建 | 本工作树 `principles-disciple@2.7.1+presence`（`npm run build` exit 0，dist 已含 llm_input 注册） | 本地构建产物（**未安装**——候选通过 §3 隔离加载方式使用，不覆盖已安装 2.6.4） |
| 已安装 PD（生产） | 2.6.4（`C:\Users\Administrator\.openclaw\extensions\principles-disciple\package.json`） | 只读；候选**不覆盖**它 |
| 冻结数据集 | `scripts/dev/pain-real-llm-bdd/golden-dataset.json`（45 样本） | 与运行卡共用（只读引用） |

**未修改宿主证明**：安装目录文件 mtime/内容未变（本轮零写入）；隔离验证将走 §3 的独立加载路径，不触碰已安装宿主。

## 2. 隔离加载与授权核实（§二.2）

| 项 | 已核实事实 | 结论 |
|---|---|---|
| PD 插件加载方式 | OpenClaw 从 `extensions/principles-disciple` 目录加载已安装插件；候选构建可通过 **`OPENCLAW_WORKSPACE`/插件路径环境变量或独立 gateway 工作目录**隔离加载（workspace-resolver 支持 PD canonical env 优先级：`PD_WORKSPACE_DIR` env → OPENCLAW_WORKSPACE env → config） | 可行——workspace resolver 的 PD canonical 源即环境变量（`workspace-resolver.ts`），测试/隔离场景已有既定支持 |
| llm_input 授权 | `plugins.entries.principles-disciple.hooks.allowConversationAccess` 生产已为 true（2026-11-07 只读核查） | 已授权环境无需重复配置；若运行卡使用独立 OPENCLAW_CONFIG，需在该配置中显式置位 |
| 回落面 | `PD_WORKSPACE_DIR` env 若泄漏到隔离宿主进程，会把 PD 带回生产工作区 | 运行卡必须显式 unset/override 该 env；已列入 §5 隔离检查 |
| MCP/子进程 | PD 插件会启动 pd-recall MCP server（`mcp-binding.json`）；隔离工作区无 binding → 不会连接生产 MCP | 隔离目录=无 binding=安全 |
| 数据库回落 | 插件数据库路径从 workspaceDir 派生（`.pd/state.db`、`.state/`） | 隔离 workspaceDir → 隔离 DB，无生产回落 |
| features 门禁 | 生产 config.yaml `features.prompt.enabled=true`；候选同构 | 隔离 workspace 的 config.yaml 需按运行卡最小集启用 prompt |

## 3. 从 PD 仓库可交付的路径（§二.3——不等上游发版）

**可行，且不需要修改宿主**：观察链全部在 PD 候选构建内（llm_input 注册 + 冻结登记 + 有界检查器 + 事件发射）。OpenClaw 官方宿主只提供 llm_input 派发（2026.11.1 已核实具备）。隔离宿主验证 = 用候选构建 + 独立 workspace/config 启动官方宿主。

**候选加载的具体官方机制（已核实，取代原占位）**：
- `OPENCLAW_HOME` env → 隔离 home root（config/extensions/state 全部随根隔离；`src/plugins/discovery.ts` env.home 字段核实）。
- 隔离配置内 `plugins.load.paths` 指向候选插件目录——官方文档明文支持本地覆盖加载（`docs/plugins/architecture.md:993`："For intentional local overrides, use `plugins.load.paths` to select the plugin path"）。
- 重复 id 去重规则（`discovery.ts` dedupe）：bundled origin 优先保留——因此**必须**用独立 OPENCLAW_HOME 使已安装生产 PD 插件根本不被发现，而不是依赖 load.paths 胜出（执行时以已加载插件清单断言复核）。

## 4. 离线夹具验证已完成（§三：先离线，不启动宿主）

以下已在 PR #2412 的测试套件中验证（全部离线，不启动宿主）：
- 预检逻辑（identity/workspace 检查）：registry/handler 单测 20+11+4 用例。
- 假 provider 不需要：Path A 观察不依赖 provider——llm_input 事件由宿主派发，离线用模拟宿主事件 + 正式 handler 验证（已覆盖）。
- 计数器/清理逻辑：registry 容量周转/TTL/淘汰用例（D2c 组合序列）。

## 5. 运行卡占位（详见独立运行卡文档，此处仅列骨架）

1. 构建：PD 候选 dist（本仓 build）。
2. 隔离 workspace：临时目录 + 最小 config.yaml。
3. 启动官方 OpenClaw 2026.11.1（未修改）+ 候选插件路径。
4. 两回合（responses + completions 各一）：断言 presence 事件存在、binding=unique、full_hit。
5. 污染检查：生产库/配置/安装目录 mtime 前后对照。
6. 停止条件：任一断言失败即停；预算：宿主启动 ≤2 次尝试、回合 ≤2、无付费调用。

**本预检不启动宿主。**
