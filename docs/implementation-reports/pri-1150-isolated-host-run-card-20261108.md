# PRI-1152 Path A 隔离宿主验证运行卡 v3.1（`pri1152-run-card-v3.1`）

- 文档 ID：`pri-1150-isolated-host-run-card-20261108`（文件名沿用，保护既有指针）。v3.1 取代 v1/v2/v3 的全部可执行内容；v3 的数值只保留为历史记录。
- 状态：**🟢 已获 Owner 书面批准，并已执行一次（2026-11-09T02:07:44Z–02:09:11Z），运行结果为 `completed`**。R1、R2 的全部判定都通过；预算用量为宿主启动 2 次、provider HTTP 2 次、工具 0 次、付费 0 次。结果见 `pri-1152-isolated-host-run-result-20261109.md`。同一执行包不能再次执行（`run\` 已存在）。本卡以下各节保持批准时的内容；批准时的原文副本存放在池外归档目录的 `repo\` 下（sha256 `1194559c…5b6a`）。
- 批准前状态：离线准备完成，B1、B2、B3 的修复都已进入 main（§0）。v3.1 执行包从 main `9353cec35` 构建生成，离线预检结果为 READY（§0.5）。
- **批准对象（两项必须同时绑定）**：
  - 卡版本：`pri1152-run-card-v3.1`
  - 执行清单 sha256：`0e2dc6e332f02c315082487f7cf2c6caca73cd26209ad7b774d8fdfe157e6c2c`
  - 批准只对这一组取值有效。重新 prepare 会产生新的清单 sha256，必须重新批准；不沿用任何旧批准。v3 的取值（`pri1152-run-card-v3` + `b16e8128…b895`）已作废。
- 执行包 v3.1（下文简称 PACK）：`D:\Code\_worktrees\principles\PRI-1152-v31-pack\artifacts\pri-1152-isolated-host\pp-20261109T010443Z`。packId 为 `pp-20261109T010443Z`，生成于 2026-11-09T01:06:46Z。
- 机器可读文件：清单 `PACK\manifest.json`、离线预检报告 `PACK\preflight\verify-20261109T010931Z-5c8729bc.json`、空白批准模板 `PACK\approval.template.json`。这三份文件和本卡的副本都存放在 worktree 池外：`D:\Code\principles\artifacts\pri-1152-isolated-host-evidence\pp-20261109T010443Z\`，已逐文件校验 sha256（§12 第 6 步）。
- 执行包 v3（`pp-20261108T095217Z`，清单 `b16e8128…b895`）：**LOST / UNAVAILABLE**。2026-11-08 21:03（+08:00），一个外部进程对整个 worktree 执行了 `robocopy <空目录> <worktree> /MIR`，该包随之被删除（§15，事故调查见 `pri-1152-incident-20261108-worktree-wipe.md`）。它从未获批，也从未执行。下文的 v3 数值都是删除前抄录的转录记录，以「〔转录〕」标注。v3.1 不沿用 v3 的身份、哈希或批准，也不会重新制造同名包。

### 审批摘要（供 Owner 审核）

| 项 | 值 |
|---|---|
| main 基线 | `9353cec358733f64d73b755ad5e54aa3e01bd106`（#2424 的合并提交）。B1、B2 由 #2431 带入（`30ccf33f1`） |
| 工作树 / 分支 | `D:\Code\_worktrees\principles\PRI-1152-v31-pack` / `ai/PRI-1152-v31-pack`。prepare 时 HEAD 等于 main 基线，tracked tree clean |
| 官方宿主 | openclaw 2026.11.1；build commit `4ffdd2047d192dd65554de3c8c46c0e0197c6e2a`；buildId `2026.11.1-release-4ffdd2047d19-2026-11-05T01-26-26.075Z`（builtAt 2026-11-05T01:26:26.075Z） |
| 候选 bundle | sha256 `dfdf4c98d8ba10709e947a7f5a070fe2501e0b27bc3c54dc5501027ab3c4f3b0`，39230713 B。由 `build:bundle` 生成（非压缩），两次构建哈希相同。插件版本 3.1.0 |
| 卡版本 | `pri1152-run-card-v3.1` |
| 执行清单 sha256 | `0e2dc6e332f02c315082487f7cf2c6caca73cd26209ad7b774d8fdfe157e6c2c` |
| 离线预检 | `--verify --full --selftest`：exit 0，READY，21 PASS / 0 FAIL / 0 NOT_RUN。另用独立脚本把实际产生的检查集合与 `PREFLIGHT_REQUIRED_CHECKS` 逐项比对：缺失 0、多余 0、重复 0 |
| 预算上限 | 宿主启动 2 次、provider HTTP 2 次、工具调用 0 次、付费调用 0 次（§9） |
| 回环端口 | 127.0.0.1:10448。prepare 时分配；预检只证明当时空闲，不是预留 |
| 结论上限 | 只验证宿主装配观察连通。D 保持 unknown；G1/C04/G2 仍待验收（§1） |

## 0. 阻断项 B1：presence 事件在一次性宿主退出时丢失（已修复，已进入 main）

| 项 | 事实 |
|---|---|
| 机制 | 插件 `EventLog` 把事件放在内存缓冲区，满 20 条或每 30s（unref 定时器）才写盘；`recordPromptPresenceObserved` 只缓冲不写盘（`packages/openclaw-plugin/src/core/event-log.ts`）。插件与宿主都没有退出时写盘：`EventLogService.flushAll/disposeAll` 在生产代码中无调用方，PD 服务的 stop 也不写盘 |
| 宿主行为 | `openclaw agent exec` 是一次性命令，输出结果后让 Node 自然退出，不等插件定时器（OpenClaw `4ffdd2047d1`：`src/cli/one-shot-exit.ts`、`src/runtime.ts`） |
| 离线复现 | `node .tmp/pri1152-flush-probe/probe.mjs <worktree>\packages\openclaw-plugin\dist\core\event-log.js <dir> natural`（exit 0）：`logs\` 下**没有** `events_*.jsonl`；同一命令换成 `flush` 参数（exit 0）：写入 1 行 presence 事件 |
| 后果 | 即使 R1 中观察真实发生，E1 证据也不会落盘，R1 会因"事件缺失"失败，白白消耗已批预算 |
| 构建产物检查 | `presence-pack.presenceDurability()` 对候选 bundle 的判定为 `buffered_lost_on_one_shot_exit`，复核项 `presence-durability FAIL` |

**修复（PR #2427；它的提交随叠在其上的 #2431 一起进入 main，合并提交 `30ccf33f1`）**：按上述机制实施，只增加一行调用，并有真实子进程自然退出的回归测试。#2427 本身仍为 OPEN，内容已全部在 main 中，等待 Owner 对账关闭。v3.1 候选 bundle 的 `presence-durability` 判定为 `flushed_on_record`（§0.5）。

```ts
recordPromptPresenceObserved(data: PromptPresenceObservedEventData): void {
  this.record('runtime_v2_prompt_presence_observed', 'injected', data.sessionId, data);
  this.flushEvents(); // 一次性宿主退出时不写盘；与 recordAdaptiveDelivery 的既有先例一致
}
```

回归测试让真实 `EventLog`（esbuild 打包源码）在子进程中记录一条事件后自然退出，不调用 flush、dispose、`process.exit`，也不等待 30 秒：修复前磁盘 0 条，修复后恰好 1 条。对照组中普通缓冲事件仍不落盘，证明写盘策略没有被全局改变。写盘失败语义不变（不抛异常、记错误、事件留在缓冲区），调用 flush 不等于绝对持久化。没有采用在 `EventLogService` 注册 `process.on('exit')` 的方案，因为它影响所有事件和所有宿主。

### 0.1 现行工具对 v3 包的判定〔转录，原始报告已丢失〕（`--verify --full --selftest`，exit 1）

v3 包不覆盖、不重新批准，只读复核：17 项 PASS，3 项 FAIL。

| FAIL | 原因 |
|---|---|
| `manifest` | 清单是旧 schema（v1）和旧卡版本（v3），现行工具要求 v2 和 `pri1152-run-card-v3.1` |
| `presence-durability` | 候选 bundle 仍是 B1 修复前的构建，事件只缓冲 |
| `execution-code` | 清单没有执行代码绑定，属于旧包，必须重新 prepare |

报告：v3 包内的 `preflight\verify-20261108T124850Z-5a8054fd.json`（已随包删除，结论抄录如上）。当时核对了 manifest、host-files、candidate-files、approval.template、config、state.db 六个冻结文件的 sha256，复核前后一致；没有产生 `run\`。预检只新增了报告和自测账本两个带时间戳的文件。

### 0.2 v3 包删除后的替代证据（预演包，不可批准）

预演包都位于会话临时目录 `D:\Code\.pd-tmp\principles\20261108\task-pri1152-rehearsal-211918-7ffe9a\`。它们的清单、批准模板和预检报告已在池外留档：`D:\Code\principles\artifacts\pri-1152-isolated-host-evidence\`（52 个文件，逐文件 sha256 校验一致，索引见该目录 README）。它们**不是 v3.1**：候选取自未合并分支或旧构建，只用于检验工具对不同候选的判定，**不得批准、不得执行**。

| 预演包 | 工具 | 候选来源 | `--verify --full --selftest` |
|---|---|---|---|
| `rehearsal-not-approvable`（清单 `463d694f…d310`） | `641b2c5cb`（尚无 `presence-surface` 检查） | B1 分支的 `build:bundle` 产物 | exit 0，20/20。**这个 READY 是假通过**：当时的工具漏检了 B2（§0.3），已被下一行取代 |
| `rehearsal-pre-b1-main-candidate`（清单 `40dfc6d8…8d8c`） | `641b2c5cb` | main 源码（不含 B1）的 `build:bundle` 产物 | exit 1，19 PASS / 1 FAIL：`presence-durability` |
| `rehearsal2-b1-candidate`（清单 `6ed87629…abf4`） | `dfe661a11`（21 项） | B1 分支的 `build:bundle` 产物 | **exit 1，19 PASS / 2 FAIL：`presence-surface`（B2）、`production-plugin-exclusion`（B3）** |
| `rehearsal2-main-candidate`（清单 `b4b1c1cb…e191`） | `dfe661a11` | main 源码的 `build:bundle` 产物 | **exit 1，18 PASS / 3 FAIL：`presence-durability`（B1）、`presence-surface`（B2）、`production-plugin-exclusion`（B3）** |

结论：rehearsal2 时没有任何候选能达到 READY。B1 由 #2427 修复，B2 由 #2431 修复（§0.3），B3 由 #2424 修复（§0.4）。修复后的离线复核见 §0.5。

### 0.3 阻断项 B2：presence hook surface 未分类，guardHook 注册空操作（已修复：#2431，已合并 `30ccf33f1`）

| 项 | 事实 |
|---|---|
| 机制 | 插件经 `guardHook('hook:llm_input_presence', …)` 注册 `llm_input` 处理器。`PLUGIN_SURFACE_REGISTRY` 里没有这个 surface，或者有但没有默认开启时，`guardHook` 都会注册空操作（PRI-289），而且它不接受 overrides |
| 实测（修复前） | 经正式 `plugin.register` 捕获的 `llm_input` 回调输出 `[PD:surface-guard] SKIP hook:llm_input_presence: surface … not found in registry`，磁盘上 0 条事件 |
| 后果（修复前） | presence 观察在生产环境和隔离宿主中**从未运行** |
| 漏检原因 | 测试绕过了正式注册层：处理器测试和夹具链测试都直接调用 `makeLlmInputPresenceRegistration` / `handleLlmInputPresence`。registry 守卫的正则只识别字面量形式的注册 |
| 修复（Owner 批准方案 A） | registry 登记为 `core`、`enabledByDefault: true`。不新增开关，不绕过 `guardHook`，不扩展正文采集；工作区解析、会话访问授权、事件字段和资源上限都不变 |
| 回归 | 新增注册链测试：`plugin.register` → 捕获 `before_prompt_build` 与 `llm_input` → 真实 `guardHook` → 快照关联 → presence 检查 → 真实 EventLog 落盘。修复前 exit 1（SKIP、0 事件），修复后 exit 0（恰好 1 条 unique full_hit）。守卫改为同时识别字面量和表达式两种参数形式，新增调用点计数断言，并用生产工厂解析变量形式参数的运行时取值 |
| ERR | 作为 ERR-025 的复现记录（invariant `presence-tests-must-cross-the-real-registration-layer`，P1） |
| 依赖 | #2431 叠在 #2427 之上：事件能落盘依赖 B1 的即时写盘 |
| 预检 | #2424 的必需检查 `presence-surface` 读取包内 bundle 的 registry，未启用时在启动宿主前拒绝 |

### 0.4 阻断项 B3：生产 PD 已升级，候选身份判据改为联合证据（已修复：#2424，已合并 `9353cec35`）

- **旧判据**：「生产插件不能产生 presence 事件，因此隔离日志中出现该事件就证明候选执行了」。
  - 生产 PD 于 2026-11-08 21:58（+08:00）升级为 3.0.2，新版本含有同样的事件代码，这条论据不再成立。
  - 即使在升级前，它也只是间接推论，不能证明候选被加载。
  - 现已取消这个必要条件。生产版本和是否含有事件代码只作为环境事实记录（`production-plugin-exclusion.evidence.environmentFact`）。
- **新判据**：候选身份由以下四项联合证据确定，缺一项即判失败。

| # | 证据 | 实现 |
|---|---|---|
| 1 | 冻结配置只加载包内候选，其他插件发现路径保持隔离 | `host-config`、`production-plugin-exclusion`、`environment-isolation`（沿用） |
| 2 | 候选入口、bundle 和外部依赖解析与冻结清单一致 | `candidate-payload`：新增入口检查，`package.json` 的 `openclaw.extensions` 必须正好是冻结的入口，并且解析到候选根内的冻结 bundle。每个回合结束后再做一次代码文件重算（`candidate-code-unchanged`） |
| 3 | 运行时注册来源明确落在冻结候选根内 | 回合判定 `candidate-registration-source`。依据：插件在 `register()` 中输出的 `Principles Disciple Plugin registered. (Path: <api.rootDir>)`。已核对官方宿主 4ffdd2047d1，`api.rootDir` 是发现到的候选目录 realpath（`registry-api.ts:105` `rootDir: record.rootDir`，`discovery.ts addCandidate`，`loader-runtime-candidate.ts:152`），因此它指向**实际执行注册的那一份插件**的根，而不只是配置里写的路径。只读取本回合进程的 stdout/stderr，以及本回合追加到宿主日志的字节；宿主日志由冻结配置的 `logging.file` 固定在包内（`PACK\logs\openclaw-host.log`，`level: info`）。缺失、`(unknown)`、指向根外、或出现互相冲突的来源，都判失败，**不能用 presence 事件代替** |
| 4 | 本轮 presence 事件对应宿主运行身份、隔离工作区和本轮 provider/model | `presence-event` 只计入同时满足以下条件的事件：本回合追加到包内工作区事件日志的新行；provider/model 与本回合一致；`sessionId` 与宿主 `--json` 输出里报告的 `sessionId` 一致；时间戳落在回合窗口内。旧日志和其他 run/session 的事件不计入 |

- **NOT RUN**：官方宿主实际运行时能否拿到注册来源、它出现在 stdout、stderr 还是宿主日志里，都只有获批的真实回合才能证明。这一项是 R1 的首项验收，**目前不声称已验证**。

### 0.5 v3.1 离线预检（可提交审批的执行包）

命令（在 v3.1 工作树中执行）：

```
node scripts/dev/aa-controlled-admission/presence-run.mjs --verify --pack D:\Code\_worktrees\principles\PRI-1152-v31-pack\artifacts\pri-1152-isolated-host\pp-20261109T010443Z --full --selftest
```

| 项 | 结果 |
|---|---|
| 退出码 | 0 |
| 结论 | `ready: true`，21 PASS / 0 FAIL / 0 NOT_RUN（`summarizePreflight`） |
| 检查集合 | 用独立脚本从被绑定的模块导入 `PREFLIGHT_REQUIRED_CHECKS`（21 项），与报告中实际产生的检查逐项比对：缺失 0、多余 0、重复 0，全部 PASS。READY 的依据是集合相等，不是项数 |
| B1 / B2 | `presence-durability` = `flushed_on_record`；`presence-surface` = `enabled_by_default` |
| B3 | `candidate-payload` 的入口检查通过：`openclaw.extensions = ["./dist/bundle.js"]`，解析到冻结 bundle；`host-config` 确认宿主日志固定为 `PACK\logs\openclaw-host.log`、`level: info`；`production-plugin-exclusion` 只把生产 PD 3.0.2 记为环境事实 |
| 协议自测 | 5 个用例全部符合预期（§6），独立账本 `PACK\preflight\selftest-ledger-20261109T010931Z-b50ad023.json` 记 5 次回环请求，不计入运行预算 |
| 报告 | `PACK\preflight\verify-20261109T010931Z-5c8729bc.json`（2026-11-09T01:09:30Z） |
| 复核前后 | 清单 sha256 仍为 `0e2dc6e3…6c2c`。宿主配置、PD 配置、会话设置、`state.db`、两个回合输入的 sha256 都与清单记录一致。没有产生 `run\`。预检新增了报告和自测账本两个带时间戳的文件；打开夹具库时，SQLite 更新了共享内存索引 `workspace\.pd\state.db-shm` 的修改时间（该文件不在冻结范围内，`state.db` 本身的字节没有变化） |

修复前后的预演包对照（都不可批准）见预检报告第 2 节。

## 1. 目标与结论上限

在**未修改**的官方 OpenClaw 2026.11.1 上，确认候选 PD 的正式 `llm_input` 注册、shared 装配快照、关联裁决与自有 presence 事件端到端连通。**只验证宿主装配观察连通**。结论上限：D 保持 `unknown`；不签收 G1/C04/G2；不证明请求送达、原则遵循或行为改善。

## 2. 冻结身份

| 项 | 值 | 依据 |
|---|---|---|
| 工具源码 SHA | `9353cec358733f64d73b755ad5e54aa3e01bd106`（main，#2424 的合并提交）。工作树分支为 `ai/PRI-1152-v31-pack`，HEAD 等于该提交，tracked tree clean | prepare 记录的 `source` |
| 候选源码 | 同一提交的 `packages/openclaw-plugin`，在同一工作树内构建。其中包含 B1（`recordPromptPresenceObserved` 记录后立即 `flushEvents()`）和 B2（registry 条目 `hook:llm_input_presence`：core，默认开启） | `source` |
| 候选 bundle | `PACK\candidate\principles-disciple\dist\bundle.js`，sha256 `dfdf4c98d8ba10709e947a7f5a070fe2501e0b27bc3c54dc5501027ab3c4f3b0`，39230713 B。用 `npm run build:bundle`（`minify: false`）连续构建两次，产物哈希相同；构建后 tracked tree 仍然 clean | manifest.candidate |
| 候选入口 | `package.json` 中 `openclaw.extensions = ["./dist/bundle.js"]`；插件 id `principles-disciple`；版本 3.1.0。预检的入口检查 PASS | manifest.candidate、`candidate-payload` |
| 依赖解析 | 唯一外部依赖 `better-sqlite3@13.0.3` 已复制到 `PACK\candidate\principles-disciple\node_modules\better-sqlite3`，从包内解析。`bufferutil`、`utf-8-validate` 不存在：它们是 ws 用 try/catch 加载的可选加速模块，包外也没有能被解析到的副本 | `auditBundleExternals` |
| 候选树 | 193 个文件，81797509 B，treeSha256 `cb11f967c7cb51e77bd4671d59d46ed6639d956b188f73a01fd12d2dd3917597`（`PACK\candidate-files.json`） | manifest |
| 官方宿主 | openclaw 2026.11.1；build commit `4ffdd2047d192dd65554de3c8c46c0e0197c6e2a`（即 tag v2026.11.1）；buildId `2026.11.1-release-4ffdd2047d19-2026-11-05T01-26-26.075Z`；builtAt 2026-11-05T01:26:26.075Z | `dist/build-info.json` |
| 宿主产物 | 从全局安装 `C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw` 逐字节复制到 `PACK\host\node_modules\openclaw`：44592 个文件，530686533 B，treeSha256 `d0d151c116919ed6f2411611e0baae79c804fe7e96855cf7b653a00b5dc27495`，不含链接。全局安装只读，未改动。预检 `host-tree`（`--full`）全树重算一致 | `PACK\host-files.json` |
| 官方产物依据 | npm 缓存中的 registry tarball `openclaw-2026.11.1.tgz`，SRI 为 `sha512-2pSbt/taBKM/ofPXsiOEmVefgUdVHYRZOmcWNDyx67WUfeGFXqtfqLvtwYOiH4NcLolDSLMUgsno2oYhTVXptw==`（112927779 B，内容按 SRI 复算一致）。逐文件对照了 **15180** 个打包文件：0 处不一致，0 个多余。唯一缺失的是 `.openclaw-lifecycle-pending`，它会在官方 lifecycle 完成后被删除 | manifest.host.tarballVerification |
| 宿主入口 | `PACK\host\node_modules\openclaw\openclaw.mjs`，sha256 `469e60c9f60b615ff71c985a54238ee532a8f949866d76aebe7d6e4bc7219902` | host-profile |
| Node | `D:\Program Files\nodejs\node.exe`，v26.12.1，sha256 `1c63f1417e2e26d83ca9a9ec1d548524ab1305bc7209d90ebca56257ff0d84ed` | manifest.node |

## 3. 插件加载机制与生产插件排除（官方依据：OpenClaw `4ffdd2047d1`）

- **加载方式**：冻结配置 `plugins.load.paths = [PACK\candidate\principles-disciple]`，并设 `plugins.allow = ["principles-disciple"]`。同一 id 被多处发现时，`config` 来源优先级为 0，高于 bundled（3）、workspace（4）和普通 global（5）（`src/plugins/manifest-registry-build.ts:168-196`、`src/plugins/discovery.ts:917-928`）。
- **所有发现根都在 PACK 内，或已核实不含 PD**：
  - global 扩展目录 = `<OPENCLAW_STATE_DIR>\extensions` = `PACK\state\R1|R2\extensions`，不存在；
  - workspace 扩展目录 `PACK\workspace\.openclaw\extensions`，不存在；
  - bundled 根 `PACK\host\...\dist\extensions` 共 69 个 id，不含 `principles-disciple`；
  - 配置中没有 install records；
  - `OPENCLAW_HOME`、`HOME`、`USERPROFILE` 均为 `PACK\home`。
- **候选身份判据（v3.1 起，B3）**：采用 §0.4 中的四项联合证据，核心是每个回合中插件自己输出的注册来源 `Principles Disciple Plugin registered. (Path: <api.rootDir>)` 必须指向冻结候选根。
  - 〔已作废的 v3 判据，转录〕生产 PD（当时为 2.6.4，bundle sha256 `f599cd89…3d09`）的 bundle 不含 `runtime_v2_prompt_presence_observed`，所以把「出现该事件」当作候选执行的证明。生产版本升级到 3.0.2 后，这个前提已不成立；而且即使在升级前，它也只是间接推论。
  - v3.1 prepare 时记录的环境事实：生产 PD 为 3.0.2（`C:\Users\Administrator\.openclaw\extensions\principles-disciple`，bundle sha256 `dc1ceb1ffc92911a6637cef09126be83df2f3106f2989a6b5e7fec1f0dd9f247`），含有同样的事件代码。它位于 PACK 外，不在任何发现根中。这一项只记为环境事实，不作为候选证据。
- **NOT RUN**：宿主是否「确实加载了候选」无法离线证明。`plugins inspect --runtime` 本身会启动宿主并初始化插件，属于待批运行。这一项作为 R1 的首项判定（§7 `candidate-registration-source`）。

## 4. 宿主配置、PD 配置与宿主会话设置（分开冻结）

| 文件 | sha256 | 要点 |
|---|---|---|
| 宿主配置 `PACK\config\openclaw.json` | `4f8e043906bafcfbb55989b8cce016decd8c715d34bf597097a22ccd20b5489e` | 只加载候选路径；`allowConversationAccess`、`allowPromptInjection` 为 true；不设 `adaptiveActivation`；`tools.deny=["*"]`（宿主把空 allow 解释为全部允许，所以不用空 allow）；`mcp.servers.pd-recall.enabled=false`；两个回环 provider，baseUrl 都是 `http://127.0.0.1:10448/v1`；primary 为 `pdpresence-responses/isolated-presence-model`；宿主日志固定在包内：`logging.file = PACK\logs\openclaw-host.log`，`logging.level = info`（B3 注册来源的读取位置） |
| PD 配置 `PACK\workspace\.pd\config.yaml` | `994969763b88938dfc1b5513b21b7dbf595dc86c76edf214865fe2a8dac92e3b` | 内容为 core 默认配置，只关闭 `signal_collector` 和 `internalization_auto_consumer`；`correction_observer`、`anonymous_product_telemetry` 默认已关；`prompt` 开启。经真实 `loadPdConfigForPlugin` 解析，来源为 `user_config`。默认 runtime profile 的 provider/model/apiKeyEnv 都为空 |
| 宿主会话设置 `PACK\workspace\.openclaw\settings.json` | `562490ff2868b555cfda9d7db07ec8daf9f0acb6753f655bde057cc46a7d9766` | `retry.provider.maxRetries=0`，关闭默认最多 8 次的瞬时恢复重试。项目设置在默认 `sanitize` 策略下保留（该策略只剥离 shellPath/shellCommandPrefix） |

## 5. 原则夹具（经正式存储入口写入）

- **写入路径**：`SqliteTaskStore.createTask` → `SqlitePIArtifactStore.createArtifact`（validated principle）→ `SqliteActivationStateStore.recordActivation`（prompt）。**不写 approvals 行**（approvals 计数为 0），shared 路由据此派生 `authority="system_policy"`。这如实反映了隔离测试夹具的授权来源，不声称有 Owner 批准。
- **身份**：principleId `pri1152-presence-fixture`；artifactId `art-pri1152-presence-fixture`；activationId `act_prompt_pri1152-presence-fixture`；`revision_epoch=0`。
- **正文**：`PRI-1152 隔离验证夹具：交付前必须核对 <presence> 标记、& 符号与 "引号"。`
  - raw sha256 `6b90ac20…dec9a`；转义后 sha256 `d7be82f7…5bdc`。
  - 在冻结的 directive 片段中：转义正文出现 1 次，raw 正文 0 次，二次转义 0 次。
  - 冻结 directive 片段 sha256 `f69e1373adce8456f268d361aa46d6095049dea8f13cce38ca1900d50bf4bb45`，278 字符，`bodyComplete=true`。
- `PACK\workspace\.pd\state.db` sha256：`8144a3760f78b74254872b273ae76529cbff0b48f841ad0ce8069e20fff6d9fe`。夹具以 WAL 模式写入；预检打开这个库时只会更新 `state.db-shm` 的修改时间，`state.db` 的字节保持不变（§0.5）。
- **装配条件**：普通 shared 路由（非 adaptive），`legacy_fifo_prefix_v1`，预算 4000，未截断。
- **用户输入**：A1 取自冻结金标数据集 `scripts/dev/pain-real-llm-bdd/golden-dataset.json`（sha256 `2043116826d8…a8e`），正文 sha256 `d9bad085…8298`，前面加一行回合标记。**A1 只是用户输入，不是 activation**。

## 6. 本地假 provider（127.0.0.1:10448）

| 项 | R1 | R2 |
|---|---|---|
| provider / API | `pdpresence-responses` / `openai-responses` | `pdpresence-completions` / `openai-completions` |
| 路径 | `POST /v1/responses` | `POST /v1/chat/completions` |
| 模型 | `isolated-presence-model` | 同左 |
| 终止响应 | SSE，以 `response.completed` 结束 | SSE 内容块 → `finish_reason:"stop"` → `data: [DONE]` |

- **凭证**：每个执行包生成一个假 key，格式为 `pdpresence-local-<32 hex>`。key 写在冻结配置里，由配置文件 sha256 `4f8e0439…489e` 锁定，不来自环境变量。两个 provider 必须使用同一个生成的占位 key。工具不为 key 单独计算指纹（CodeQL js/insufficient-password-hash），v3.1 清单只记录 key 的格式（`hostConfig.fakeApiKeyFormat`）。端点只记录请求是否携带该 key（`authMatchesFakeKey`）。
- **端点规则**：不向任何地方转发，只服务两个固定路径。拒绝在读取请求体之前判定，拒绝原因包括 `no_active_round`、`api_mismatch`、`over_budget`、`tool_budget`、`off_protocol`。**从不返回 429**，因为宿主会把 429 当作可重试错误。端点只记录传输事实：方法、路径、API、模型、stream 标志、请求体大小与 sha256、工具定义名；不保存正文。
- **协议自测**：这是记账的本地回环自测，**不是宿主启动，也不计入运行预算**（独立账本 `PACK\preflight\selftest-ledger-20261109T010931Z-b50ad023.json`，共 5 次请求，宿主启动 0 次）。用包内官方 `@openclaw/ai` 传输层实测：
  - responses 完整流：accepted（stop，`PRESENCE-ACK`）；
  - 只有 `[DONE]` 的 responses 流：**rejected**（"OpenAI Responses stream ended before a terminal response event"）；
  - completions 完整流：accepted；
  - 既无 `finish_reason` 也无 `[DONE]` 的 completions 流：**rejected**（"Stream ended without finish_reason"）；
  - 只有 `[DONE]` 的 completions 流（仅作记录，`expected: documented`，不参与判定）：v3.1 自测中官方传输层没有报错（`errorMessage` 为空），但没有得到 `PRESENCE-ACK`，按接受规则（stop + 文本恰为 `PRESENCE-ACK` + 无错误）记为 `rejected`。〔v3 转录〕当时记录为"接受为空文本 stop"，两者一致：传输层本身不拒绝，只是文本不合格。因此回合判定要求最终文本必须是 `PRESENCE-ACK`，不会把这种片段当作有效响应。

## 7. 两个回合

宿主命令（spawn，不经 shell；工作目录 `PACK\workspace`；环境按 §8 的允许列表构造）：

```
"D:\Program Files\nodejs\node.exe" D:\Code\_worktrees\principles\PRI-1152-v31-pack\artifacts\pri-1152-isolated-host\pp-20261109T010443Z\host\node_modules\openclaw\openclaw.mjs agent exec --config D:\Code\_worktrees\principles\PRI-1152-v31-pack\artifacts\pri-1152-isolated-host\pp-20261109T010443Z\config\openclaw.json --state-dir D:\Code\_worktrees\principles\PRI-1152-v31-pack\artifacts\pri-1152-isolated-host\pp-20261109T010443Z\state\R1 --model pdpresence-responses/isolated-presence-model --cwd D:\Code\_worktrees\principles\PRI-1152-v31-pack\artifacts\pri-1152-isolated-host\pp-20261109T010443Z\workspace --timeout 120 --code-mode direct --json --message-file D:\Code\_worktrees\principles\PRI-1152-v31-pack\artifacts\pri-1152-isolated-host\pp-20261109T010443Z\inputs\R1.txt
```

上面是启动器 `roundArgv` 对冻结清单生成的实际命令。R2 只改三处：`state\R1`→`state\R2`，`--model pdpresence-completions/isolated-presence-model`，`inputs\R1.txt`→`inputs\R2.txt`。输入 sha256：R1 `5179f955cec2ae586e8568ea53a3006aee2139272897c128a76fbde354b14ff8`，R2 `228375ee2d6e44f219b04fa0494d3e6c46f006818e3c60f987c28c5d6ee73341`（A1 正文前各加一行回合标记）。

| 期望（每回合全部满足才通过） | 禁止 |
|---|---|
| `host-exit`：退出码 0，未超时 | 超时、spawn 失败 |
| `host-envelope`：`--json` 输出 ok=true、status=ok，final 含 `PRESENCE-ACK`；输出中的 `sessionId` 作为本回合的宿主运行身份 | 空文本（例如只有 `[DONE]` 的片段） |
| `log-evidence-complete`：本回合宿主日志与 presence 事件日志的增量读取无截断、无缩短、无读取失败；任何一项失败都记录失败步骤、原因与错误码（`HOST_LOG_TRUNCATED`/`HOST_LOG_SHRUNK`/`HOST_LOG_READ_FAILED`/`EVENTS_LOG_*`） | 截断的增量（可见前缀之后还有未读字节）、缩短后重读出基线前的旧行、读取报错 |
| `candidate-registration-source`（首项验收）：本回合进程输出或追加到包内宿主日志的注册行恰好指向冻结候选根（可以有多行，但必须完全一致）；日志证据不完整时该来源判 `incomplete`，同样失败 | 缺失、`(unknown)`、指向生产路径或其他候选、多个来源互相冲突、来源所在日志不完整；用 presence 事件代替 |
| `candidate-code-unchanged`：回合结束后，候选的代码文件（入口、bundle、清单、外部依赖）仍是冻结字节 | 任何代码文件被改动、缺失或新增 |
| `endpoint-one-request`：本回合恰好 1 次 served，0 次 refused | 第 2 次请求（宿主内部重试）、任何 refused |
| `endpoint-api-path`：R1 为 `/v1/responses`，R2 为 `/v1/chat/completions` | 另一种 API 的路径 |
| `endpoint-fake-key`、`endpoint-model` | 继承来的凭证、其他模型 |
| `presence-event`：本回合追加的事件行中，provider/model 与本回合一致、`sessionId` 与宿主报告一致、时间戳在回合窗口内的 presence 事件恰好 1 条 | 0 条或多条；回合开始前的旧行；其他 run/session 的事件；宿主没有报告 `sessionId` |
| `presence-boundary=post_assembly_system_prompt_via_llm_input`；`binding=unique`、`checked=true`、无降级 reason | ambiguous/none、`empty_snapshot`、`missing_expectations`、`history_incomplete`、`check_failed` 等 |
| `presence-fixture-full-hit`：夹具 activationId 的结果为 `full_hit` | `checked_missing`、`unknown` |
| `presence-no-body`：事件行不含 raw 正文，也不含转义正文 | 正文进入事件 |

**不断言**：presence 事件没有 `egress`/API 字段，API 路径只由端点请求记录证明。也不检查请求正文中是否含有原则——送达不在本卡范围内。

## 8. 环境隔离

- **继承范围**：子进程环境按允许列表构造，只继承 `COMSPEC LANG NUMBER_OF_PROCESSORS OS PATH PATHEXT PROCESSOR_* SYSTEMDRIVE SYSTEMROOT WINDIR`，其余全部丢弃，包括所有 `*_API_KEY`/`*TOKEN*`、`NODE_OPTIONS`、`NODE_PATH`、`PD_*`、`OPENCLAW_*`、`XDG_*`。
- **显式设置**：
  - `HOME`/`USERPROFILE`/`OPENCLAW_HOME`=`PACK\home`
  - `APPDATA`=`PACK\home\AppData\Roaming`，`LOCALAPPDATA`=`PACK\home\AppData\Local`
  - `TEMP`/`TMP`/`TMPDIR`=`PACK\tmp`，`XDG_*`=`PACK\home\...`
  - `OPENCLAW_STATE_DIR`=`PACK\state\R1|R2`，`OPENCLAW_CONFIG_PATH`=冻结配置
  - `OPENCLAW_WORKSPACE_DIR`/`PD_WORKSPACE_DIR`=`PACK\workspace`
  - `PD_TELEMETRY_DISABLED=1`，`PD_MCP_LOG=0`
  
  `OPENCLAW_PROFILE`、`PD_STATE_DIR`、`OPENCLAW_WORKSPACE` 不设置，取默认值，默认值也在 PACK 内。
- **最终路径**（全部已证明位于 PACK 内）：
  - 插件发现：见 §3；
  - PD 数据库：`PACK\workspace\.pd\state.db`；PD 日志：`PACK\workspace\.state\logs`；
  - 宿主状态与会话：`PACK\state\Rn`、`PACK\state\Rn\agents`；
  - 插件经 `os.homedir()` 写入的位置：`PACK\home\.openclaw\openclaw.json`、`PACK\home\.openclaw\cron\jobs.json`、`PACK\home\.pd\**`；
  - 编译缓存：`PACK\tmp\node-compile-cache`；
  - MCP：已按官方开关关闭（没有 binding 文件不足以证明 MCP 安全）；
  - 子进程：每回合结束后清扫（§9）。
- **离线反例**（`scripts/__tests__/aa-presence-run.test.mjs`）：
  - 父进程环境中，workspace/home/state/config/bundled/dev-source 都指向生产路径，另带 `NODE_OPTIONS` 和 4 个凭证：全部被重定向或丢弃；
  - 路径越出 PACK，或 extra 中出现类凭证键：在返回环境之前拒绝；
  - 假宿主在子进程中实测：`os.homedir()` 位于 PACK 内，无凭证键，`NODE_OPTIONS` 为空。

## 9. 预算、超时、停止、清理（待批范围，本轮未消耗）

| 预算 | 上限 | 拒绝点 |
|---|---|---|
| 宿主启动 | 2（每回合 1） | spawn 前在账本预留；启动失败也计账 |
| provider HTTP | 2（每回合 1） | 端点读请求体之前预留；超出返回 403 `over_budget` |
| 工具 | 0 | 宿主配置 deny-all；端点一旦看到工具活动，返回 403 `tool_budget` 并记账 |
| 付费 | 0 | 只用回环 provider，没有可用的真实凭证 |

- **预算语义**：额度用满不算超预算；**下一次**尝试在发出前被拒绝。账本 `PACK\run\budget-ledger.json` 永不重置。同一执行包只执行一次：`run\` 目录已存在就拒绝。账本取自冻结清单的 `budget`，不取当前代码常量；`budget-consistency` 校验冻结值、代码常量和每回合预算三者一致，批准文件的 `budgets` 也必须等于冻结值。
- **超时**：宿主 `--timeout 120`（秒）；外层 180000 ms 后执行 `taskkill /PID <pid> /T /F`，结束整个进程树。
- **执行前复核**：`--execute` 在建 `run\`、建账本之前重新跑全部 21 项必需检查，不读历史预检文件。端口检查只说明当时空闲，不是预留；真实绑定失败时 `stoppedAt=endpoint-bind`，不启动宿主，不计预算，保留证据。
- **执行代码绑定**：清单 `executionCode` 记录启动器及其相对导入闭包（11 个脚本，相对路径 + SHA-256）和启动器加载的 3 个工作区包 `dist`（只算 `.js`，相对路径 + 文件数 + 聚合 SHA-256）。`execution-code` 按运行中模块的位置重算，不符即在启动宿主前拒绝。信任边界：这是防漂移校验，由被校验的代码自己执行，不能抵御校验器或 Node 被恶意替换，第三方 `node_modules` 不在列表内。
  - v3.1 的取值：`packages/principles-core/dist` 401 个文件（`931933fc65609659869c12a484db9570eeeaf711e53b654a97c9c63a272d2e8e`），`packages/host-runtime/dist` 51 个文件（`a11328b7cb0915bd67c4b60ee88c214d7a237ead4d93a25c4fec503a2ce63651`），`packages/install-layout/dist` 1 个文件（`cae44818fe9eb369b1c8a692b95603a06becf4a475eaa3bd40b2acef0b4e2e12`）。
  - 因此在执行之前，v3.1 工作树不能重新构建、切换分支，也不能改动这 11 个脚本。只改文档不会使这项检查失效（离线反例：改动无关文档后，旧批准仍然有效）。
- **停止**：R1 任何一项判定失败，**不启动 R2**。污染审计结果也决定是否继续（§11）。不自动重试，不切换 provider，不用 fallback。
- **清理**：
  - 每回合结束后，用 PowerShell CIM 查找命令行中引用 PACK 的残留进程，全部结束；发现任何残留即判该回合失败。启动器自身及其祖先进程不在清扫范围内，否则从 shell 启动时会杀掉启动器；
  - 最后关闭端点，并确认端口拒绝连接；
  - **保留全部证据，不删除执行包**。
- **离线反例**（假宿主）：
  - 正常两回合：用量 2/2/0/0，第二次 execute 被拒绝；
  - 多发 1 次请求：被拒绝，R1 失败，R2 不启动；
  - 宿主崩溃：启动已计账，运行停止；
  - 宿主挂起：4s 外层超时后结束进程树，孙进程已不存在；
  - 遗留孤儿进程：被清扫并判定停止；
  - 未批准、哈希不符或批准缺字段：在任何启动之前拒绝，不创建 `run\`。

## 10. 证据（`PACK\run\`，只有获批执行才会生成）

- `verification-before-run.json`、`approval-used.json`、`pollution-before.json`
- `evidence\Rn.environment.json`、`Rn.host.stdout.txt`、`Rn.host.stderr.txt`、`Rn.endpoint.json`、`Rn.presence-events.json`、`Rn.gate.json`、`Rn.pollution.json`
- `budget-ledger.json`
- `run-record.json`：含账本快照、端点关闭结果、最终清扫结果、污染对照和 `pollutionAudit` 结论，以及 `stopReasons`

## 11. 生产污染审计（范围与限制）

- **对象**：
  - 全局宿主的 package.json/openclaw.mjs/build-info；
  - 生产 PD 插件的 package.json/bundle/mcp-binding.json；
  - `~\.openclaw\openclaw.json`、`~\.openclaw\cron\jobs.json`（当前不存在）、`~\.pd\product-telemetry.json`；
  - 两个生产 workspace（`D:\.openclaw\workspace`、`C:\Users\Administrator\.openclaw\workspace`）下的 `.pd\state.db` 和 `.state\logs`。
- **判定规则**：
  - 哈希不变：`unchanged`；
  - 静态安装文件变化：`changed-static-install-review`，需人工复核；
  - 活动库变化：`changed-independent-writer-possible`。**不按哈希归因**，因为可能有其他合法写入方；
  - 配置或日志出现本次运行的唯一标记（v3.1 冻结了 9 个：packId `pp-20261109T010443Z`、夹具的三个 id、provider/model id、`127.0.0.1:10448`、PACK 路径）：`changed-attributed`；
  - 有变化但未命中标记：`changed-no-run-marker-found`；
  - 目标无法读取、无法哈希或无法扫描标记：`audit-incomplete`，不算未变化，也不算已归因。
- **对运行的影响**：每回合结束、下一回合启动前，按上述目标对比启动前基线，并在最终审计再做一次：

  | 汇总结论 | 动作 |
  |---|---|
  | `attributed`（找到运行标记） | 停止，不启动下一回合，最终不得 `completed` |
  | `review-required`（静态安装文件变化） | 停止，标明待人工复核，不断言由实验造成 |
  | `incomplete`（审计无法完成） | 停止，写明原因，不声称审计通过 |
  | `unattributed-changes-noted`（活动库或日志变化且无标记） | 继续，记录"不能归因"的事实，不判污染 |
  | `clean` | 继续，不等于证明零写入 |

  基线本身取不到时（`pollution-baseline` FAIL）在任何写入和计账之前拒绝。审计只读，不删除、不回写、不回滚生产数据。
- **限制**：哈希不变或未检索到标记，**都不能证明零写入**；mtime 变化也不直接归因。

## 12. 生成 v3.1 的准确顺序（只有 Owner 批准新卡版本和新清单 sha256 后才能执行真实回合）

第 1–7 步已于 2026-11-09 完成，结果如下。第 8–10 步等待 Owner。

1. ✅ **合并**：#2431（B2，连同叠在其下的 #2427 的 B1 提交）合并为 `30ccf33f1`；#2424（执行包工具，含 B3 和日志证据完整性）合并为 `9353cec35`。#2427 本身仍为 OPEN，内容已在 main 中。
2. ✅ **新工作树**：`npm run dev:worktree -- PRI-1152 v31-pack` 从 origin/main `9353cec35` 创建 `D:\Code\_worktrees\principles\PRI-1152-v31-pack`（分支 `ai/PRI-1152-v31-pack`），由 `dev:worktree:claim --writer zcode` 认领（写入租约和 `git worktree lock`）。`npm run dev:worktree:ready` 的结论为 READY（exit 0，L1/L2/L3 全部 ok）。bootstrap 的健康检查报告了一项失败：它要求存在 `CLAUDE.md`，而该文件已由 #2423 从仓库删除。这是工具缺陷，不影响就绪判定，记为后续事项（§13）。没有复用旧 worktree，也没有用强制操作绕过互斥流程。
3. ✅ **构建**：在 `packages/openclaw-plugin` 运行 `npm run build:bundle`（`minify: false`），连续两次，bundle sha256 都是 `dfdf4c98…f3b0`。构建后 tracked tree 仍然 clean。
4. ✅ **prepare**：`node scripts/dev/aa-controlled-admission/presence-run.mjs --prepare --repo D:\Code\_worktrees\principles\PRI-1152-v31-pack`，exit 0，输出 packId `pp-20261109T010443Z`、清单 sha256 `0e2dc6e332f02c315082487f7cf2c6caca73cd26209ad7b774d8fdfe157e6c2c`、端口 10448。另用 `sha256sum` 独立复算清单，结果一致。此后不要重新构建、切换分支，也不要改动被绑定的脚本，否则 `execution-code` 会拒绝。
5. ✅ **预检**：`--verify --pack <PACK> --full --selftest`，exit 0，READY（§0.5）。READY 的含义是：`PREFLIGHT_REQUIRED_CHECKS` 中的每一项都已产生并全部 PASS，而且实际产生的检查集合与必需集合完全一致（另用独立脚本逐项比对）。**项数只是结果，不是完整性的证明。**
6. ✅ **池外副本**：按仓库归档约定（AGENTS.md git-16），把清单、`approval.template.json`、`candidate-files.json`、预检报告、自测账本和本卡复制到 `D:\Code\principles\artifacts\pri-1152-isolated-host-evidence\pp-20261109T010443Z\`，逐文件校验 sha256，并写入索引 README。
7. ✅ **本卡**：用新清单的实际取值更新为 `pri1152-run-card-v3.1`（本次修订）。
8. ⏳ 由 Owner 书面批准卡版本 `pri1152-run-card-v3.1` 和清单 sha256 `0e2dc6e332f02c315082487f7cf2c6caca73cd26209ad7b774d8fdfe157e6c2c`。Agent 不得代填批准，也不得沿用旧批准。
9. ⏳ 按 `PACK\approval.template.json` 填写 `approvedBy`、`approvedAt`、`approvalEvidence`（批准记录所在位置），另存为 `PACK\approval.json`。模板中的 `cardVersion`、`manifestSha256`、`rounds`、`budgets` 不得改动。
10. ⏳ 运行 `node scripts/dev/aa-controlled-admission/presence-run.mjs --execute --pack <PACK> --approval <PACK>\approval.json`。启动器会再次跑完全部必需检查。R1 的首项验收是 `candidate-registration-source`；R1 任何一项失败都不启动 R2。

## 13. 尚缺事项

1. **Owner 书面批准**（§12 第 8 步）：批准对象是本卡版本 `pri1152-run-card-v3.1` 和清单 sha256 `0e2dc6e3…6c2c`。批准之前，不启动真实宿主，不调用模型，也不运行 `--execute`。
1a. **#2427 对账**：B1 已随 #2431 进入 main（`30ccf33f1`），但 #2427 仍为 OPEN，关闭方式由 Owner 决定。
1b. B1、B2、B3 已全部进入 main，v3.1 预检中 `presence-durability`、`presence-surface`、`candidate-payload` 都是 PASS。不再是阻断项。
2. **只能由获批真实运行给出的事实（NOT RUN）**：
   - 官方宿主运行时能否取得注册来源，以及它出现在 stdout、stderr 还是宿主日志中（R1 首项）；
   - 真实的 `llm_input` 派发与事件落盘；
   - 宿主 `--json` 输出中的 `sessionId` 是否与事件的 `sessionId` 一致；
   - 宿主的真实请求形状，以及有无额外调用（标题、压缩等）；
   - 宿主退出时序；
   - `tools.deny` 下实际暴露的工具面；
   - 污染前后对照。
3. **端口**：prepare 时分配并冻结（10448）。执行时如果端口被占用，预检或真实绑定会失败关闭，需要重新 prepare，并重新批准新的清单 sha256。
4. **证据保存**：
   - v3 包已丢失（LOST / UNAVAILABLE，§15）。当时 worktree 锁和写入租约都没能阻止那次删除。
   - v3.1 的清单、批准模板、预检报告、自测账本和本卡已在池外另存（§12 第 6 步）。PACK 本身（含约 530 MB 的宿主副本）仍在 worktree 池内，没有复制到池外。
   - 如果 PACK 再次被外部删除，它无法逐字节重建（占位 key 和时间戳都是生成时的取值），只能重新 prepare 并重新批准。工作树 `PRI-1152-v31-pack` 在执行完成之前必须保留，不得清理。
5. **事故调查**：外部删除的发起方未查明。Linear 免费额度已满，无法另建事故单，调查内容先记录在 `pri-1152-incident-20261108-worktree-wipe.md`，由 Owner 在有额度后另建。
6. **安全审计**：Mimosa 完整审计未得出结论（scanner_enobufs），本卡不作安全性声明。
7. **工具缺陷（后续事项，本卡不修复）**：`scripts/setup-worktree.mjs:356` 的健康检查仍要求存在 `CLAUDE.md`，而 #2423 已删除该文件。因此每个新工作树的 bootstrap 都会报告 NOT READY，而实际的 `dev:worktree:ready` 结论是 READY。

## 14. 变更记录

- **v1/v2**（PRI-1150 期间）：只有说明性运行卡，端口、key、路径留了占位；v2 中的 "egress=completions" 是不存在的事件字段；没有覆盖 HOME/USERPROFILE/APPDATA 等回落来源。
- **v3**：
  - 所有数值来自生成的执行清单；
  - 加载机制和产物来源均可核验；
  - 夹具经正式存储入口写入；
  - 两种协议都用官方传输层自测；
  - 环境改为允许列表；
  - 预算、停止、清理都有离线反例；
  - 新增阻断项 B1。
- **v3 复核修复（工具卡版本升为 `pri1152-run-card-v3.1`，v3.1 包尚未生成）**：
  - B1 独立修复（#2427）；
  - 端口、终止工具、进程清扫、协议自测、污染基线纳入统一 READY；
  - 批准绑定实际执行代码和冻结预算；
  - 污染审计决定是否继续以及能否 `completed`；
  - 清扫不再误杀启动器的祖先进程；读取失败的污染目标不再被判为已归因。
- **B2/B3 收口（2026-11-08）**：
  - B2：presence surface 登记为 core，并新增经正式注册链的回归和守卫修正（#2431）；
  - B3：候选身份改为四项联合证据（注册来源、入口与代码完整性、事件与宿主身份绑定），宿主日志固定在包内，生产版本只作环境事实（#2424）；
  - v3 包标记为 LOST / UNAVAILABLE，抄录的数值标注为转录记录。
- **日志证据完整性（2026-11-09，#2424）**：新增回合判定 `log-evidence-complete`。宿主日志或 presence 日志增量出现截断、缩短或读取失败时，对应证据标为不完整，记录失败步骤、原因与错误码；回合判失败，R1 失败即不启动 R2。`candidate-registration-source` 对不完整的日志来源一律判 `incomplete`，不得用可见前缀或重读出的旧行确认候选（两条指定反例覆盖）。
- **v3.1 执行包（2026-11-09，本次）**：
  - 从 main `9353cec35`（含 B1、B2、B3 和日志证据完整性）新建工作树；`build:bundle` 连续两次构建，哈希相同；
  - prepare 生成 `pp-20261109T010443Z`：清单 sha256 `0e2dc6e332f02c315082487f7cf2c6caca73cd26209ad7b774d8fdfe157e6c2c`，卡版本 `pri1152-run-card-v3.1`，端口 10448；
  - `--verify --full --selftest`：READY，21/21，实际检查集合与必需集合逐项一致；
  - 本卡中的 v3 取值全部换成 v3.1 的实际取值，v3 数值只作为〔转录〕历史保留；
  - 证据在池外另存于 `D:\Code\principles\artifacts\pri-1152-isolated-host-evidence\pp-20261109T010443Z\`；
  - 真实运行仍未批准、未执行。
- **执行（2026-11-09，Owner 书面批准后）**：
  - 按 §12 第 9–10 步，由空白模板生成 `approval.json`（离线校验违规 0 项），`--execute` 运行一次，结果 `completed`；
  - R1、R2 的全部判定都通过，预算用量 2/2/0/0；
  - 注册来源只出现在 stderr，`agent exec` 没有生成宿主日志文件；`tools.deny=["*"]` 下请求仍带 3 个 bridge 工具定义，工具调用为 0；
  - 详见 `pri-1152-isolated-host-run-result-20261109.md`。

## 15. 事件：v3 执行包被外部清理删除（2026-11-08 21:03，+08:00）

| 项 | 事实 |
|---|---|
| 删除动作 | 进程 `C:\Windows\System32\robocopy.exe D:/pd-empty D:/Code/_worktrees/principles/PRI-1152-isolated-host-exec-pack /MIR /R:0 /W:0 /NFL /NDL /NJH /NJS`（pid 39692，父 pid 64420，21:03:29 启动）。以空目录为源的 `/MIR` 会删除目标中的全部内容 |
| 发起方 | 未查明。查询时父进程已退出；在可读的会话记录中，限时检索没有找到该命令。不是本任务发起：本任务没有运行 robocopy，也不删除临时目录之外的内容 |
| 当时的保护 | 该 worktree 由本任务持有 `git worktree lock`，写入租约有效至 15:32Z，PR #2424 未合并。两者都没能阻止删除 |
| 同期范围 | worktree 池中另有多个 worktree 在 18:02–21:15 间被移除（从目录列表观察到，具体操作者不明）。本任务没有触碰它们，也没有动 `D:\pd-empty` |
| 损失 | `artifacts\pri-1152-isolated-host\pp-20261108T095217Z`（v3 包、清单 `b16e8128…`、宿主副本、候选、配置、夹具库、预检报告与自测账本）；`.tmp\` 中的旧实现反例脚本及其结果文件。结果已在删除前输出，抄录于复核修复卡 §6/§7 |
| 未受影响 | 所有提交都在删除前推送到 origin（`641b2c5cb`），代码零丢失。全局宿主安装、npm 缓存、主检出未受影响：21:25 生成的预演包对 npm 缓存 tarball 的逐文件对照通过 |
| 恢复动作 | 在原路径对本任务分支执行 `git worktree add -f -f`（未经 PD 的 `dev:worktree` 互斥流程；当时互斥 arena 为空，无持有者），随后 `dev:worktree:claim`、`bootstrap`，`dev:worktree:ready` 判定 READY |
| 无法恢复 | v3 包不能逐字节重建：占位 key 和时间戳是随机或当时生成的。卷影副本需要管理员权限，本任务未使用 |

替代证据见 §0.2。v3.1 包的池外副本见 §12 第 6 步；PACK 本身仍在 worktree 池内，风险见 §13 第 4 项。
