# PRI-1152 Path A 隔离宿主验证：离线预检报告（随运行卡，工具 v3.1）

- 文档 ID：`pri-1150-isolated-host-preflight-20261108`。文件名沿用旧名以保护既有指针；本文按复核修复后的工具全文改写。
- 结论：**目前没有可申请真实运行的执行包。** v3 包已作废，并已被外部清理删除（运行卡 §15）；v3.1 包尚未生成，因为 B1 修复（#2427）还没有合并。真实宿主和模型**均未启动**，运行预算零消耗。
- 说明：本文不声称「全部预检通过」。下面每一项都写明对象、命令、退出码和结果。

## 1. 预检口径（现行工具）

`--verify` 与 `--execute` 共用 `preflightPack`，必需检查共 20 项。`summarizePreflight` 是唯一的 READY 判定点：

- 20 项全部为 PASS 才 READY；
- 缺少的项按 NOT_RUN 计，NOT_RUN 不算通过；
- 退出码只取决于 READY；
- 只有同时带 `--full --selftest` 才可能 READY。

| # | 检查 | 内容 |
|---|---|---|
| 1 | manifest | 清单 schema `pd-presence-exec-pack/v2`、卡版本 `pri1152-run-card-v3.1` |
| 2 | node-identity | 运行复核的 node 与冻结的 node 路径、版本、sha256 一致 |
| 3 | host-identity | 宿主版本、build commit、CLI 哈希一致，无 lifecycle 标记 |
| 4 | host-tree | 宿主全树重算哈希（需 `--full`） |
| 5 | host-registry-tarball | prepare 时与 npm 缓存 tarball 的逐文件对照结果 |
| 6 | candidate-payload | 候选树、bundle 和外部依赖都在包内 |
| 7 | presence-durability | bundle 中 `recordPromptPresenceObserved` 记录后立即写盘（B1） |
| 8 | execution-code | 启动器闭包 11 个脚本和 3 个工作区 dist 与冻结哈希一致 |
| 9 | budget-consistency | 冻结预算、代码常量、每回合预算三者一致 |
| 10 | host-config | 只加载候选、工具全拒、MCP 关闭、两个回环 provider |
| 11 | pd-config-and-retry | 真实加载器解析 PD 配置；宿主重试关闭 |
| 12 | fixture-assembly | 夹具经正式存储写入，shared 路由冻结完整、只转义一次 |
| 13 | round-inputs | 两回合输入与金标数据集哈希 |
| 14 | environment-isolation | 用当前父进程环境重建允许列表环境，全部路径在包内 |
| 15 | production-plugin-exclusion | 包内无发现根，宿主不含 PD，生产 PD 不能产生 presence 事件 |
| 16 | pollution-baseline | 每个生产审计目标都可读、可哈希（只读） |
| 17 | endpoint-port | 冻结端口此刻可绑定、可连接；**不是预留** |
| 18 | termination-tool | 进程树终止工具可用 |
| 19 | process-sweep | 进程查询可用，且除启动器及其祖先外没有进程引用该包 |
| 20 | protocol-selftest | 包内官方 transports 自测（需 `--selftest`，且 host-tree 已 PASS） |

## 2. 实测记录

| 对象 | 工具 | 命令 | 退出码 | 结果 |
|---|---|---|---|---|
| v3 包 `pp-20261108T095217Z`（清单 `b16e8128…b895`） | 旧工具 `aabbd4550` | `--verify --full --selftest`（09:57Z） | 1 | 12 PASS / 1 FAIL（`presence-durability`）。旧工具不计端口、终止工具、清扫和自测，这正是本次复核修复的问题之一 |
| 同一 v3 包 | 现行工具 `8860abcea` | `--verify --full --selftest`（12:48Z） | 1 | 17 PASS / 3 FAIL：`manifest`（旧 schema 和卡版本）、`presence-durability`（B1）、`execution-code`（无执行代码绑定）。复核前后六个冻结文件 sha256 一致 |
| 预演包 `rehearsal-not-approvable`（清单 `463d694f…d310`），候选为 B1 分支构建 | 现行工具 `641b2c5cb` | `--prepare` 后 `--verify --full --selftest`（13:28Z） | 0 / 0 | **20/20 PASS，READY**。只证明含 B1 的构建能达到 READY，不可批准 |
| 预演包 `rehearsal-pre-b1-main-candidate`（清单 `40dfc6d8…8d8c`），候选为 main 源码构建 | 现行工具 `641b2c5cb` | 同上（13:35Z） | 0 / 1 | **19 PASS / 1 FAIL**，唯一失败项 `presence-durability`：B1 合并前的真实候选仍被阻断 |

两个预演包位于会话临时目录 `D:\Code\.pd-tmp\principles\20261108\task-pri1152-rehearsal-211918-7ffe9a\`，**不是 v3.1，不得批准或执行**。v3 包及其两份报告已在 21:03 被外部进程删除，结论按删除前的输出抄录。

## 3. 测试与守卫

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npx vitest run __tests__/aa-presence-run.test.mjs`（scripts） | 0 | 61/61，连续 3 轮 |
| `npx vitest run __tests__/aa-presence-run.test.mjs __tests__/aa-controlled-admission.test.mjs` | 0 | 95/95 |
| `npx vitest run tests/hooks/{isolated-host-presence-fixture,llm-input-presence,prompt-presence-registry,runtime-prompt-activation}.test.ts`（插件） | 0 | 100/100 |
| `npm run check:runtime-contract / repo-hygiene / security-baseline / workspace-tools / runtime-writers / naming-policy / docs-structure` | 均为 0 | PASS |
| `npm run error:context -- --base origin/main` | 0 | EP-10/09/08/01/14/03 HIGH，逐项处理见 PR #2424 |
| PR #2424 CI（head `641b2c5cb`） | — | 28 pass，1 skipping（CodeRabbit：仓库星数不足，自动评审不运行），0 fail |
| B1 PR #2427 CI（head `8dec1a833`） | — | 24 pass，5 skipping（按影响范围跳过的包级任务和 CodeRabbit），0 fail |

跳过项不算通过。本地未跑完整 `verify:merge`，以 CI 的 Verify Merge Gate 为准。

## 4. 反例覆盖（新增，均为离线、假宿主、临时目录）

- **READY 统一判定**：
  - 端口被占、终止工具不可用、进程查询失败、有其他进程引用包、协议自测失败：每种情况都是 `ready=false`、exit 1，且 `--execute` 在启动任何宿主之前拒绝（宿主启动 0）；
  - 历史预检文件写着通过，`--execute` 不采信；
  - 只带 `--full`、只带 `--selftest` 或两者都不带：exit 1；
  - 两个预检同时写报告，文件名不冲突。
- **端口不是预留**：预检时端口空闲、执行时被占用，结果为 `stoppedAt=endpoint-bind`，宿主启动 0，预算 0，保留 `run-record.json`。
- **清扫与启动器祖先**：父进程命令行含包路径时，查询结果排除启动器及其祖先，但仍能找到同级的其他进程。
- **执行代码绑定**：prepare 之后改启动器、帮助模块、预算常量或工作区 dist，清单哈希不变，但旧批准不能运行（`execution-code` FAIL，宿主启动 0）。只改无关文档、`.d.ts` 或 `.map`，包仍然有效。没有执行代码绑定的旧清单一律拒绝。
- **预算绑定**：批准文件中的预算与冻结值不同则拒绝；改动冻结预算后旧批准失效，重新批准也会因 `budget-consistency` 被拒；账本使用冻结值。
- **污染审计**（临时模拟生产目录）：
  - 已归因：R1 后停止，R2 不启动，不得 `completed`；
  - 静态安装文件变化：停止并标明待人工复核，不断言由实验造成；
  - 活动库或日志变化但无标记：记录为不能归因，运行继续并可 `completed`；
  - 审计无法完成：停止，写明原因，写出 `run-record.json`；
  - 基线取不到：在任何写入和计账之前拒绝；
  - 审计全程只读，生产文件保持宿主写入后的原样。

## 5. NOT RUN（只有获批真实运行才能产生）

1. 官方宿主是否确实加载了候选插件（R1 首项判定）。
2. 真实 `llm_input` 派发与 presence 事件落盘。
3. 宿主实际请求形状，以及可能的额外调用。
4. 宿主退出时序、实际工具面。
5. 生产污染的真实前后对照。
6. Mimosa 完整安全审计：提交和推送时均为 `scanner_enobufs`，未得出结论，不作安全声明。

## 6. 生产污染边界（本轮）

本轮对生产路径只做读取：全局宿主安装、生产插件、`~\.openclaw\openclaw.json`、生产 workspace 的 state.db 与日志目录、npm 缓存。预演包的 prepare 和 verify 只在会话临时目录里写入。不能用 mtime 或「未检索到标记」证明零写入，规则见运行卡 §11。
