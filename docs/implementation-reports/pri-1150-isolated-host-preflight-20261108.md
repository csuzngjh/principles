# PRI-1152 Path A 隔离宿主验证：离线预检报告（随运行卡，工具 v3.1）

- 文档 ID：`pri-1150-isolated-host-preflight-20261108`。文件名沿用旧名，以保护既有指针；本文已按 B2/B3 收口后的工具全文改写。
- **结论**：
  - 目前**没有可申请真实运行的执行包**：v3.1 尚未生成。
  - 三项阻断的修复都已推送，但都未合并：B1 在 #2427，B2 在 #2431，B3 在 #2424。
  - 用当前工具（#2424 `18bd45487`）对 **B1+B2 合并构建**做离线预演：exit 0，READY。这只是离线证据，不是 v3.1，不得批准或执行。
  - v3 包已丢失（LOST / UNAVAILABLE），只剩转录记录。
  - 真实宿主和模型**均未启动**，运行预算零消耗。
- 说明：本文不声称「全部预检通过」。每一项都写明对象、命令、退出码和结果。

## 1. 预检口径（现行工具）

`--verify` 与 `--execute` 共用 `preflightPack`。判定规则：

- `summarizePreflight` 是唯一的 READY 判定点。`PREFLIGHT_REQUIRED_CHECKS` 中的每一项都必须已产生且为 PASS；缺少的项按 NOT_RUN 计，NOT_RUN 不算通过。
- 测试逐项比对「实际产生的检查集合」和「必需集合」，两者必须完全一致。**项数只是结果，不是完整性的证明。**
- 退出码只取决于 READY。只有同时带 `--full --selftest` 才可能 READY。

| 检查 | 内容 |
|---|---|
| manifest | 清单 schema 为 `pd-presence-exec-pack/v2`，卡版本为 `pri1152-run-card-v3.1` |
| node-identity | 执行复核的 node 与冻结记录的路径、版本、sha256 一致 |
| host-identity | 宿主版本、build commit、CLI 哈希一致，没有 lifecycle 标记 |
| host-tree | 宿主全树重算哈希（需 `--full`） |
| host-registry-tarball | prepare 时与 npm 缓存 tarball 的逐文件对照结果 |
| candidate-payload | 候选树、bundle 和外部依赖都在包内；**B3 新增入口检查**：`package.json` 的 `openclaw.extensions` 必须正好是冻结的入口，并解析到候选根内的冻结 bundle |
| presence-durability | bundle 中 `recordPromptPresenceObserved` 记录后立即写盘（B1） |
| presence-surface | 包内 bundle 的 `PLUGIN_SURFACE_REGISTRY` 默认启用 `hook:llm_input_presence`，否则 `guardHook` 注册空操作（B2） |
| execution-code | 启动器闭包和启动器加载的工作区 dist 与冻结哈希一致 |
| budget-consistency | 冻结预算、代码常量、每回合预算三者一致 |
| host-config | 只加载候选、工具全拒、MCP 关闭、两个回环 provider；**B3 新增**：宿主日志用 `logging.file` 固定在包内，`level` 为 info |
| pd-config-and-retry | 用真实加载器解析 PD 配置；宿主重试已关闭 |
| fixture-assembly | 夹具经正式存储写入，shared 路由冻结结果完整、只转义一次 |
| round-inputs | 两个回合的输入与金标数据集哈希一致 |
| environment-isolation | 用当前父进程环境重建允许列表环境，全部路径在包内 |
| production-plugin-exclusion | 包内没有发现根，宿主不含 PD，生产插件位于包外。**B3：生产插件是否含 presence 代码不再是必要条件**，只记录为环境事实 |
| pollution-baseline | 每个生产审计目标都可读、可哈希（只读） |
| endpoint-port | 冻结端口此刻可绑定、可连接；**这不是预留** |
| termination-tool | 进程树终止工具可用 |
| process-sweep | 进程查询可用，且除启动器及其祖先外，没有进程引用该包 |
| protocol-selftest | 用包内官方 transports 自测（需 `--selftest`，且 host-tree 已 PASS） |

每个回合的判定（不属于预检，只在获批的 `--execute` 中运行）：

- `log-evidence-complete`：宿主日志与 presence 日志增量的完整性审计（`logEvidenceIntegrity`）。截断（超出读取上限）、缩短（低于回合基线，重读会暴露基线前字节）、读取失败（打开或读取出错，记录平台错误码）各自的步骤、原因、错误码都会写入证据；任何一项不完整，该回合判失败。
- `candidate-registration-source`：首项验收，见运行卡 §0.4。日志来源不完整时判 `incomplete`，不用可见前缀确认。
- `candidate-code-unchanged`：回合后候选代码文件未被改动。
- `presence-event`：只计本回合追加的、与宿主报告的 `sessionId` 一致、时间戳在回合窗口内的事件。

## 2. 实测记录

**修复后（工具 #2424 `18bd45487`，B3 已包含）**：

| 预演包（不可批准） | 候选来源 | 命令 | 退出码（prepare / verify） | 结果 |
|---|---|---|---|---|
| `rehearsal3-b1b2-candidate`（清单 `7531fe16e75dc1b2f1eba03701b1c7c1f0c6fb3b3f7b64a53e99a5e85fc4f572`） | B2 分支（含 B1）`build:bundle` 产物：registry 有条目，并调用 `flushEvents()` | `--prepare` 后 `--verify --full --selftest` | 0 / 0 | **READY**，必需检查全部 PASS，实际产生的检查集合与必需集合一致。生产 PD 3.0.2 存在，但不再阻断 |
| `rehearsal3-b1-candidate`（清单 `f1db0324428938e4e21232d85b709e2a5d5a72495ff88701d241a4dbc35818b7`） | B1 分支 `build:bundle` 产物 | 同上 | 0 / 1 | 只有 `presence-surface` FAIL（B2 未修） |
| `rehearsal3-main-candidate`（清单 `bf8b19c7e022caa7a7c96c1dd7643dcff3d39dfa0980b39e7d2a2a91cd48e980`） | main 源码 `build:bundle` 产物 | 同上 | 0 / 1 | `presence-durability`（B1）和 `presence-surface`（B2）FAIL |

预演包的完整目录位于会话临时目录 `D:\Code\.pd-tmp\principles\20261108\task-pri1152-rehearsal-211918-7ffe9a\`。清单和预检报告已复制到池外 `D:\Code\principles\artifacts\pri-1152-isolated-host-evidence\`，并逐文件校验了 sha256。**这些都不是 v3.1**：候选取自未合并的分支，工具也取自未合并的分支。

**修复前的历史记录**：

| 对象 | 工具 | 退出码 | 结果 |
|---|---|---|---|
| v3 包 `pp-20261108T095217Z`（清单 `b16e8128…b895`）〔转录，包已丢失〕 | 旧工具 `aabbd4550` | 1 | 12 PASS / 1 FAIL（`presence-durability`）。旧工具不统计端口、终止工具、清扫和自测 |
| 同一 v3 包〔转录，包已丢失〕 | `8860abcea` | 1 | 17 PASS / 3 FAIL：`manifest`、`presence-durability`、`execution-code` |
| `rehearsal-not-approvable`（`463d694f…d310`），B1 构建 | `641b2c5cb` | 0 | 20/20，**假通过**：当时没有 `presence-surface` 检查，漏检了 B2 |
| `rehearsal2-b1-candidate`（`6ed87629…abf4`） | `dfe661a11` | 1 | 19 PASS / 2 FAIL：`presence-surface`（B2）和 `production-plugin-exclusion`（B3 的旧判据） |
| `rehearsal2-main-candidate`（`b4b1c1cb…e191`） | `dfe661a11` | 1 | 18 PASS / 3 FAIL：B1、B2、B3 的旧判据 |

## 3. 测试与守卫

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npx vitest run __tests__/aa-presence-run.test.mjs __tests__/aa-controlled-admission.test.mjs`（scripts，B3 后，连续 3 轮） | 0 | 125/125 ×3（其中 aa-presence-run 91 项） |
| 插件 `tests/hooks/{isolated-host-presence-fixture,llm-input-presence,prompt-presence-registry}.test.ts`（#2424 分支） | 0 | 27/27 |
| `check:runtime-contract / repo-hygiene / security-baseline / workspace-tools / runtime-writers / naming-policy` | 均为 0 | PASS |
| eslint（改动的 5 个文件） | 0 | PASS |
| B2 分支：经注册链的回归 + 守卫 | 修复前 1，修复后 0 | 修复前 SKIP、0 事件；守卫有 3 项失败（未分类、9≠8）。修复后 46/46 |
| B2 分支：core feature-flags | 0 | 204/204 |
| B2 分支：插件全量 | 1 | 2331 通过，2 失败，13 跳过。2 项失败是本机环境问题（MSYS tar、EPERM 清理临时目录），在不含 B2 的 #2427 worktree 上同样失败 |

CI 结果以各 PR 页面为准。跳过项不算通过。本地未跑完整 `verify:merge`。

## 4. 反例覆盖（均为离线：假宿主、临时目录）

**B3 候选身份与日志证据完整性**：

- 生产插件含有相同事件代码时，`production-plugin-exclusion` 为 PASS，版本作为环境事实记录。
- 注册来源指向生产路径或其他候选：判为 `outside`，R1 失败，R2 不启动。
- 注册来源缺失：判为失败，即使 presence 事件完全正确也不能替代；`(unknown)` 和多个来源互相冲突同样判失败。
- 回合开始前就已存在于宿主日志中的注册行，不计入本回合。
- 回合开始前的旧事件行，以及 `sessionId` 与宿主报告不一致的事件，都不计入。宿主没有报告 `sessionId` 时 `presence-event` 判失败。
- **反例一（截断）**：宿主日志增量的可见前缀包含正确候选注册行，但截断点之后还有冲突来源。单元级：`candidateRegistrationVerdict` 判 `incomplete`（码 `HOST_LOG_TRUNCATED`），带冲突行与不带都不得确认；回合门 `log-evidence-complete` 失败。端到端（假宿主 `log-truncated` 模式：正确行 + 33 MiB 填充越过 32 MiB 读取上限 + 冲突行在截断点之后）：R1 失败、失败项恰为 `log-evidence-complete` + `candidate-registration-source`，R2 未启动。
- **反例二（缩短）**：文件缩短到低于回合基线后，重读从字节 0 开始，重新暴露出基线前既有的注册行。单元级：`readAppended` 判 `shrunk`、文本含旧行，判定 `incomplete`（码 `HOST_LOG_SHRUNK`），不得确认。端到端（假宿主 `log-shrink` 模式，回合前预写正确行）：R1 失败、失败项同上，R2 未启动。
- 读取失败：打开目录（平台错误码 EISDIR/EPERM）时 `readAppended` 返回 `readError`，审计步骤码 `HOST_LOG_READ_FAILED`，回合失败；带基线的文件缺失判 `shrunk`。
- presence 事件日志文件的截断、缩短、读取失败分别映射到 `EVENTS_LOG_TRUNCATED`/`EVENTS_LOG_SHRUNK`/`EVENTS_LOG_READ_FAILED`。
- 注册行只出现在包内宿主日志（JSON 记录）中也能确认；路径里自带的括号（如 `(x86)`）会保留。
- 入口检查：`openclaw.extensions` 有两个条目、指向包外、或指向非冻结文件，都判失败。
- 宿主配置：`logging.file` 不在包内，或 `level` 不是 info，判失败。

**此前已有的反例**（统一 READY、端口、清扫、执行代码绑定、预算绑定、污染审计）继续通过，明细见上一版报告和修复卡。

## 5. NOT RUN（只有获批的真实运行才能产生）

1. 官方宿主运行时能否取得注册来源，以及它出现在 stdout、stderr 还是宿主日志中（R1 首项验收）。
2. 真实的 `llm_input` 派发与 presence 事件落盘。
3. 宿主 `--json` 输出中的 `sessionId` 与事件 `sessionId` 是否一致。
4. 宿主实际的请求形状，以及可能的额外调用。
5. 宿主退出时序、实际工具面。
6. 生产污染的真实前后对照。
7. Mimosa 完整安全审计：提交和推送时均为 `scanner_enobufs`，未得出结论，不作安全声明。

## 6. 生产污染边界（本轮）

本轮对生产路径只做读取：全局宿主安装、生产插件、`~\.openclaw\openclaw.json`、生产 workspace 的 state.db 与日志目录、npm 缓存。预演包的 prepare 和 verify 只写会话临时目录；证据副本只写 `D:\Code\principles\artifacts\pri-1152-isolated-host-evidence\`。不能用 mtime 或「未检索到标记」来证明零写入，规则见运行卡 §11。
