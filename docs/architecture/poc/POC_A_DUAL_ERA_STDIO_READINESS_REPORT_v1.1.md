# POC A — Dual-era STDIO MCP Readiness Report (v1.1)

- **Run**: `artifacts/poc/modern-mcp/dual-era-stdio/20261128T1447-r1/`
- **最终判定：PASS**（限 POC harness 语义；见 §18 边界声明）
- **执行日期**：2026-11-28，本地 22:47–22:57（UTC+8，Asia/Shanghai；UTC 14:47–14:57Z）
- **Branch / HEAD**：`main` / `e30202366f53df60ccaf7589f7988cf445a52fba`（与审计基线一致，无 drift）
- **Node / npm**：v26.12.1 / 11.20.0（win32，Git Bash）
- **SDK**：`@modelcontextprotocol/server@2.4.0`（lockfile = 运行时解析 = 审计基线；client/core 亦为 2.4.0）
- **对应 SPEC**：`docs/architecture/POC_A_DUAL_ERA_STDIO_READINESS_SPEC_v1.1.md`

------------------------------------------------------------------------

## 1. Executive Summary

四项前置问题全部获得证据支持，最小真实 STDIO 测试矩阵 21/21 全部 PASS：

1. **协议适用性**：官方 `2026-07-28` 规范修订真实存在，STDIO 是其 normative transport；
   modern 交互 = 无握手 + per-request `_meta`（`io.modelcontextprotocol/protocolVersion` 与
   `io.modelcontextprotocol/clientCapabilities` 必填）；`server/discover` 为规范定义的发现方法
   （"Servers MUST implement"）；规范明确使用 **Modern / Legacy / Dual-era** 术语，并允许
   dual-era server 以同一 endpoint/process 服务两个时代。
2. **SDK 能力**：当前锁定的 SDK 2.4.0 提供 `serveStdio(factory, options)`（`@modelcontextprotocol/server/stdio`），
   同一 factory 按 connection 开场自动选择 era；`legacy:'serve'`（默认）将 2025-era `initialize`
   开场 pin 到同 factory 的 legacy 实例——正是本 POC 验证的双时代机制。
3. **PD 可复用性**：`createPdMcpServer`（`packages/pd-mcp-server/src/server.ts:300`）是纯构造
   factory（不连 transport、不开 DB、不读 env）；`callCapability` 为既有 fake seam；
   `resolveWorkspaceBinding` 显式支持 **无 `PD_MCP_HOST` → host:null → recall-only**，
   无需伪装任何真实宿主。生产入口 `main()` 未被复用（它硬编码 legacy-only transport）。
4. **Wire-level 实证**：legacy 与 modern 各自以独立真实 STDIO 子进程（同一 child entry、同一
   serving API、同一 PD tool registration）完成规范流程；recall fake 调用两时代返回
   字节相同的 `pd.capability.v1` envelope；未注册的 `pd_submit_pain` 两时代均被 `-32602`
   拒绝且零副作用；stdout 全程纯协议帧；无孤儿进程；Git 基线 971/971 哈希不变。

**本 PASS 不代表 OpenClaw / Codex / WorkBuddy 任一真实宿主已支持 modern MCP，不构成生产迁移授权，POC B 未执行。**

## 2. SOURCE_AUDIT_DATE_ANOMALY

架构审计报告 `docs/architecture/PD_MODERN_MCP_ARCHITECTURE_ASSESSMENT_v1.0.md` 记载日期为
2026-11-29，本 SPEC 与实际执行日期为 2026-11-28。已按 SPEC §2.1 记录为来源日期疑点；
未修改原报告，其日期未被当作已核实事实。该异常不影响任何技术结论：所有审计基线陈述
（SDK 2.4.0、legacy-only transport、Server 版本 0.5.2 等）均已在当前 HEAD 重新核实为真。

## 3. 目标规范修订与 STDIO 适用性（Gate 1 · 协议层）

官方 normative text（全部为抓取的正式页面，非搜索摘要）：

| 结论 | 来源 |
|---|---|
| STDIO 为规范定义 transport（newline-delimited JSON-RPC；stdout MUST 仅协议帧；stdin 关闭 SHOULD 立即退出） | modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md |
| 无握手；每请求携带 `_meta.protocolVersion`（必填）与 `_meta.clientCapabilities`（必填），缺失 → `-32602` | …/2026-07-28/basic.md（§_meta） |
| Modern = `2026-07-28`+（per-request metadata）；Legacy = `initialize` 握手（`2025-11-25` 及更早）；Dual-era = 两者；"A dual-era server MAY serve both eras concurrently on the same endpoint or process" | …/2026-07-28/basic/versioning.md（Terminology + 兼容矩阵） |
| 版本不支持 → `UnsupportedProtocolVersionError` `-32022`，`data:{supported,requested}` | versioning.md |
| `server/discover`：Servers MUST implement；请求仅携带 `_meta`；结果含 `resultType:"complete"`、`supportedVersions`、`capabilities`、`_meta[serverInfo]` | …/2026-07-28/server/discover.md |
| stdio 双时代探测：先 `server/discover`（`_meta` 带偏好版本）；DiscoverResult → modern；可识别 modern 错误 → modern 换版本重试；其他错误/超时 → legacy 回退 `initialize` | stdio.md §Backward Compatibility |
| `tools/list`/`tools/call` 在 modern 流程中继续适用（请求 MUST 带必填 `_meta`；结果带 `resultType`） | …/2026-07-28/server/tools.md |

**wire protocol version 与修订日期的关系**：本修订的 wire version 值恰好就是 `"2026-07-28"`
（规范以 ISO 日期作版本串），但这不是"把审计日期当版本号"——该值经三重独立确认后才上线：
(a) 官方规范正文；(b) SDK 常量 `MODERN_WIRE_REVISION = "2026-07-28"`、
`SUPPORTED_MODERN_PROTOCOL_VERSIONS = ["2026-07-28"]`；(c) **wire 实证**——向真实子进程发送
`protocolVersion:"2030-01-01"` 的请求，收到 `-32022 {supported:["2026-07-28"], requested:"2030-01-01"}`
（测试 `POC-02.wire-unsupported-revision-neg`）。

## 4. SDK API 证据（Gate 1 · SDK 层）

- 版本一致性：package.json 精确 pin `2.4.0` = package-lock.json `2.4.0` = Node 实际解析 `2.4.0`
  （`POC-01` 三方一致断言 PASS），与审计基线无 drift。
- `serveStdio` 存在且契约明确（`node_modules/@modelcontextprotocol/server/dist/stdio.d.mts`）：
  `serveStdio(factory: McpServerFactory, options?: ServeStdioOptions): StdioServerHandle`；
  `legacy?: 'serve'|'reject'`（默认 `'serve'`）；文档明确 "the opening exchange selects the era,
  ONE instance from the factory is pinned for the connection lifetime" 与 "the same factory
  serves both eras"。
- 开场判定（`dist/stdio.mjs:236-269` `classifyOpeningMessage`）：`initialize`（无有效 modern
  claim）→ legacy；无 claim 消息 → legacy；claim 非法 → `-32602`；claim 版本不在
  `SUPPORTED_MODERN_PROTOCOL_VERSIONS` → `-32022`；否则 modern。
- `server/discover` 处理器由 serving entry 自动安装（`installModernOnlyHandlers`，
  `mcp-oHn3ureC.mjs:796-798`），PD factory 无需任何 modern 专用注册。
- 现代 envelope 必填键：`REQUIRED_ENVELOPE_KEYS = [protocolVersion, clientCapabilities]`
  （`src-DdvbAHrR.mjs:4013`）——实证：缺 `clientCapabilities` 的 modern 请求被 `-32602` 拒绝
  （`POC-06` 负例）。
- 发布包不含随包测试/示例（仅 LICENSE/README/dist）；双时代行为证据 = dist 源码 + 本 POC
  wire 实测。

## 5. PD Server factory 复用证据（Gate 2）

- `createPdMcpServer` 纯构造：无 DB、无 fs、无 transport、无 worker（构造不 stat workspace；
  既有测试用不存在的路径构造成功——`server-contract.test.ts:48-50`）。
- 复用的是**生产工具注册本身**（未复制任何 schema/handler）：`pd_recall_principle_pains`
  （server.ts:353-507）；`pd_submit_pain` 仅在 `enableSubmitTool===true && callSubmitCapability`
  时注册（server.ts:510-511；默认 false 且 fail-closed，无任何 env/flag 可开启）。
- fake recall seam：`callCapability`（server.ts:231-235,241）——既有、受测试约束的注入点
  （同型用法见 `server-contract.test.ts:46-62`）。POC 注入确定性 synthetic fixture，
  真实 read model（唯一触碰 store 的代码路径）从不执行。
- binding 契约：`PD_MCP_WORKSPACE_DIR`（绝对、存在）+ **不设** `PD_MCP_HOST` → `host:null` →
  recall-only。无 cwd/HOME/USERPROFILE 回退（workspace.ts:8-11,59-113）。POC 用现有契约原样
  通过，未伪装任何宿主；缺 env 时 fail-closed exit 1（`workspace_env_missing` 实证）。
- 生产入口 `main()`（index.ts）**未复用**：其 `ObservingStdioTransport + connect` 路径是
  legacy-only，永远无法服务 modern era。child entry 直接调 `serveStdio(createPdMcpServer-factory)`。
- import 副作用：`src/server.ts` 模块顶层零副作用（Agent B 全扫 + 6 个子进程在剥离全部 PD
  指针的 env 下实证运行）。

## 6. Harness 拓扑

```
runner.mjs (parent, full env, orchestrates + captures)
   │ spawn(node --import tsx pd-poc-child.mts, cwd=runDir, env=allowlist)
   ├─ legacy-raw child        ← raw legacy frames (initialize 2025-11-25 / initialized / tools/list / tools/call)
   ├─ modern-raw child        ← raw modern frames (server/discover + tools/list + tools/call, per-request _meta envelope)
   ├─ unsupported-revision    ← -32022 负例（2030-01-01 claim）
   ├─ disconnect child        ← binding 后 stdin.destroy()
   ├─ startup-failure child   ← 缺 PD_MCP_WORKSPACE_DIR → exit 1
   └─ sdk-legacy child        ← @modelcontextprotocol/client@2.4.0 Client + StdioClientTransport（SDK 官方 legacy 客户端栈）
              每个 child：同一 pd-poc-child.mts → serveStdio(factory)
              factory = createPdMcpServer({ workspaceDir: POC workspace, host: null, callCapability: deterministicFake })
```

- 全部证据经真实 STDIO 管道（无 InMemoryTransport）；每帧记录时间戳、字节数、raw sha256。
- 子进程 env 为最小 allowlist（14 个键，记录于 run-metadata.json；HOME/USERPROFILE/PATH/
  全部 `PD_*`/宿主指针/token 均不继承）；`TEMP/TMP` 指向 run 内 tmp；`PD_MCP_LOG=0` 关闭
  真实 `~/.pd/logs/mcp` 文件日志通道（该 sink 默认开启，属真实状态通道）。
- 持久化前全部经 redactor（repo/home/run 路径、用户名、凭据形状 → `[REPO]/[HOME]/[POC]/[USER]/[REDACTED]`）；
  raw stdout/stderr 仅存内存。

## 7. Legacy / Modern transcript 摘要（sanitized）

| 步骤 | Legacy（2025-11-25 握手） | Modern（2026-07-28 per-request） |
|---|---|---|
| 开场 | `initialize` → echo `2025-11-25` + `serverInfo pd-mcp-server@0.5.2` + `capabilities.tools` | `server/discover` → `resultType:complete` + `supportedVersions:["2026-07-28"]` + `capabilities.tools` + `_meta[serverInfo]` |
| en 负例 | — | 缺 `clientCapabilities` → `-32602`（开场态不变，随后正常 discover） |
| tools/list | 恰一个工具 `pd_recall_principle_pains`，`readOnlyHint:true` | 同一工具条目 + `resultType:complete` + `ttlMs:0` + `cacheScope:"private"` |
| recall fake call | `content[0].text` = fixture envelope（712 字节）逐字节一致；`isError` 缺省 | `content[0].text` 与 legacy **完全相同**；`resultType:complete` |
| submit 负例 | `pd_submit_pain` 不在 tools/list；调用 → `-32602 "Tool pd_submit_pain not found"` | 同左（错误类别一致） |
| 关闭 | `stdin.end()` → exit 0 | `stdin.end()` → exit 0 |

full transcripts：`evidence/legacy-transcript.sanitized.jsonl`、`evidence/modern-transcript.sanitized.jsonl`；
全部子进程 stderr：`evidence/stderr-sanitized.log`（PD 生产 sanitized JSON 日志 + POC 标记，
含 `poc_factory_called` 的 era 证据：legacy 子进程 era=legacy、modern 子进程 era=modern）。

## 8. Tool contract parity（POC-09）

按可比较字段集（tool 条目 `{name,description,inputSchema,annotations}` + `tools/call
content[0].text`/`isError` + fake handler 调用记录 + 错误类别）：**两时代完全一致**。
按设计排除的 era-envelope 字段（`resultType`/`ttlMs`/`cacheScope`/`_meta.serverInfo`）与
握手 payload（initialize vs DiscoverResult 结构性不可比）已如实记录，未做人为映射。

## 9. Submit negative test（POC-10）

- 诚实形态（经独立评审修正）：默认构造（recall-only）下 `pd_submit_pain` **未注册**；
  两时代 `tools/call` 均被协议层 `-32602` 拒绝，零 capability 存在、零写入。
- OG-4 授权门本身：SOURCE_REVIEWED（server.ts:237-256/300-322/509-511，默认 false、fail-closed、
  无 env/flag 可开启）+ EXISTING_TEST_REFERENCED（`submit-tool.test.ts:135-198`）。
  未执行成功路径，未伪造 Owner consent，未创建 receipt/task（SPEC §6.3）。
- 重要源码事实（Agent B 发现，主代理复核确认）：Owner consent 是工具描述内的**行为协议**，
  不是服务端技术门；真实 capability 在无 consent 时仍会执行 "legal unbound save"。
  因此真实 submit 路径在本 POC 中被结构性排除（工具未注册）。

## 10. stdout/stderr、env 与 workspace 隔离（POC-11/12）

- stdout：6 个子进程全部 10 条 stdout 行 100% 解析为 JSON-RPC 帧，零非协议输出（FAIL 判据未触发）。
- stderr：PD 生产 sanitized JSON 行（tool_call 事件含 status/durationMs/responseBytes，无路径）
  + POC 路径无关标记；持久化前再过 redactor。
- env：child 仅 14 键（SystemRoot/SystemDrive/WINDIR/COMSPEC/PATHEXT/PROCESSOR_*/
  NUMBER_OF_PROCESSORS/TEMP/TMP/PD_MCP_WORKSPACE_DIR/PD_MCP_LOG/POC_REPO_ROOT）；
  HOME/USERPROFILE/APPDATA/LOCALAPPDATA/USERNAME/USERDOMAIN/PATH/NODE_OPTIONS/NODE_ENV/CI/
  VITEST/全部 `PD_*`·`OPENCLAW_*`·`CODEX_*`·`WORKBUDDY_*`·token 类变量不继承。
- workspace：仅 run 内合成目录；缺 env → fail-closed exit 1（`workspace_env_missing`），
  证明无 cwd/HOME 回退；未伪装宿主身份。

## 11. 子进程生命周期（POC-13）

启动失败（exit 1，1 行 sanitized stderr）✓；legacy/modern stdin.end() 优雅退出（exit 0）✓；
client disconnect（stdin.destroy()）→ exit 0 ✓；SDK client close（SDK 托管终止，记录在案，
优雅关闭证据来自 raw 子进程）✓；运行后 PowerShell 进程探测 `pd-poc-child` 幸存者 = 0 ✓。

## 12. 内部保护分类（POC-15）

见 `evidence/test-results.md` §分类表。摘要：workspace binding（SOURCE_REVIEWED +
POC_BLACK_BOX_TESTED）、stdout/stderr discipline（SOURCE_REVIEWED + POC_BLACK_BOX_TESTED）、
deadline/admission/orphan limiter（SOURCE_REVIEWED + EXISTING_TEST_REFERENCED `deadline.test.ts`，
NOT_RETESTED）、32 KiB budget（SOURCE_REVIEWED + EXISTING_TEST_REFERENCED
`budget-boundary.test.ts`，NOT_RETESTED）、bounded shutdown drain（SOURCE_REVIEWED，NOT_RETESTED）、
submit OG-4 gate（三层证据齐）、submit receipt/reconciliation（SOURCE_REVIEWED +
EXISTING_TEST_REFERENCED，NOT_EXECUTED_FOR_SAFETY）、真实 recall store 路径（SOURCE_REVIEWED，
构造性绕过）、durable file log sink（SOURCE_REVIEWED + POC_BLACK_BOX_TESTED `PD_MCP_LOG=0` +
真实 PD home 零新增/零改动实证）。未把任何源码阅读冒充为 POC 运行测试。

## 13. 完整测试矩阵（POC-00..16）

21 项断言全 PASS（`evidence/test-results.json` / `test-results.md`）。矩阵外的压测类
（并发压力/orphan limiter 压测/deadline 压测/32 KiB 压测/submit timeout-reconciliation 全流程）
按 SPEC 未新增，仅源码审查与既有测试引用。

## 14. Side-effect audit（POC-14）

`evidence/side-effect-audit.md`（全文）+ `side-effect-snapshot.json`（前后快照）：
真实 PD 日志目录 0 新增 0 改动（811 个既有文件前后一致）；POC tmp 0 新增；
repo 根 `trajectory.db` 字节不变。**"未读取真实 DB/Workspace"的结论由四条独立证据支撑**
（import graph + fake seam 构造性绕过 + env 隔离 + 文件级前后快照），不是仅凭哈希不变。

## 15. Git baseline 完整性（POC-16）

- status-before.txt 与 status-after.txt **逐字节一致**（971 条目：34 stat-noise tracked + 937 untracked）。
- `git diff` / `git diff --cached` 前后均为空（同一空串 SHA-256）→ tracked 内容与 index 完全一致。
- 971 个既有 modified/untracked 文件 SHA-256 逐一复验：**971/971 一致，0 差异，0 缺失**。
- 本 POC 新增路径全部 gitignored：`/artifacts/`（.gitignore:274）、`.tmp/`（:224）、
  `packages/principles-core/dist`（:47 `dist/`）；唯一 git 可见新增 = 本报告文件
  （`docs/architecture/poc/`，SPEC §4.3 明确授权的新增）。
- 未执行任何 git commit/push/merge/reset/rebase/checkout/stash/clean；未改任何 Git 引用。
- 证据：`evidence/git-after-status.txt`、`evidence/git-after-hash-compare.json`。

## 16. 子代理发现与主代理复核

4 个只读子代理（A 协议/SDK、B PD 复用、C 隔离/证据、D 测试评审）报告全文存于 run 目录
（`agent-a-protocol-sdk.md` 等 4 件）。主代理逐项复核关键结论：规范正文（亲自抓取 6 个官方
页面）、SDK exports/types/实现（亲自读 4 个 dist 文件）、PD 三源文件（亲自全文读）、
`PD_MCP_LOG` 默认开启的写通道（Agent C 发现 → 采纳 `PD_MCP_LOG=0`，并在 POC-14 用 mtime 级
前后对比加固）、POC-10 诚实形态与 parity 范围修正（Agent D 发现 → 全部采纳）。
**子代理与主代理结论零冲突**；Agent B 关于 dist 新鲜度的建议以更强路径处理（直接 import
HEAD 源码而非依赖 dist）。

## 17. NOT VERIFIED / 未验证事项

1. **真实宿主**：OpenClaw / Codex / WorkBuddy 二进制对 dual-era server 的互操作完全未测试。
2. **POC B**（Skills over MCP）：未执行。
3. **生产 wiring**：生产入口仍是 legacy-only（`main()` + `StdioServerTransport.connect`）；
   本 POC 证明的是 SDK+PD factory 层的 readiness，不是生产路径已切换。
4. **Owner consent 的技术面**： consent 为行为协议而非技术门（§9），其"技术不可测"事实如实记录。
5. 规范探测超时的 normative 时长：规范未定义（"reasonable timeout"），harness 未依赖它。
6. 官方 GitHub `schema/2026-07-28/schema.ts` 原文件未直接抓取（字段级权威来自规范页面 +
   安装 SDK 类型；两处零冲突）。
7. 观察窗：`ObservingStdioTransport`（PD 侧 initialize/tools_list 观测日志）未导出、POC 未
   复用——PD 侧该两项观测在 POC 运行中缺席（`tool_call` 日志在场），已记录为证据缺口。

## 18. 最终判定与边界声明

**PASS** —— SPEC v1.1 全部必需 Gate（0/1/2）与必需测试通过，无未解决安全/证据缺口。
按 SPEC §1.4/§9.3，该 PASS 仅表示：**当前锁定 SDK 2.4.0 + PD isolated harness 的双时代 STDIO
readiness 得到 wire-level 验证**。

本报告明确声明：
- 未测试任何真实宿主；
- 未执行 POC B；
- **不授权生产迁移**（生产入口未改动，仍为 legacy-only）；
- 不授权新增生产服务/重构；后续动作（如 POC B、宿主适配、生产切换）需 Owner 另行授权。

## 19. 环境准备披露（非源码/依赖变更）

`packages/principles-core/dist/` 在执行时不存在（标准构建产物，gitignored）。为使 PD server
的生产 import（`@principles/core/runtime/pain-recall-capability`）可解析，执行了该包自身的
标准构建（`npm run build`，clean+tsc+hygiene）。该步骤仅产生 gitignored 构建产物：971 个
tracked/基线文件哈希前后一致、`git diff` 为空（§15 实证）。无依赖安装/升级/降级，无任何
既有文件被修改或删除。

## 20. 交付物清单

```
artifacts/poc/modern-mcp/dual-era-stdio/20261128T1447-r1/
├── agent-a-protocol-sdk.md / agent-b-server-reuse.md /
│   agent-c-isolation-evidence.md / agent-d-test-review.md   （只读子代理报告）
├── harness/
│   ├── pd-poc-child.mts        （唯一 child entry：serveStdio + createPdMcpServer + fake seam）
│   ├── runner.mjs              （矩阵编排 + 断言 + 证据落盘）
│   ├── fixtures.mjs            （确定性 synthetic fixture）
│   ├── env-allowlist.mjs       （最小 env allowlist）
│   ├── redact.mjs              （证据脱敏）
│   └── smoke.mjs               （冒烟脚本）
├── workspace/ tmp/             （合成 POC workspace 与 TEMP/TMP 覆盖目标）
└── evidence/
    ├── run-metadata.json  baseline-status.txt  baseline-hash-manifest.json
    ├── sdk-protocol-inspection.md  server-factory-inspection.md  side-effect-audit.md
    ├── legacy-transcript.sanitized.jsonl  modern-transcript.sanitized.jsonl
    ├── stderr-sanitized.log  side-effect-snapshot.json
    ├── test-results.json  test-results.md
    └── git-after-status.txt  git-after-hash-compare.json
```

原始 stdout/stderr 未持久化；仅存脱敏 transcript + 字节计数 + raw SHA-256。
