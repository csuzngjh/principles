# PRI-1152 Path A 隔离宿主验证：离线预检报告（随运行卡 v3）

- 文档 ID：`pri-1150-isolated-host-preflight-20261108`。文件名沿用旧名以保护既有指针；本文全文改写，取代此前「离线预检完成」的笼统表述。
- 对象：执行包 `D:\Code\_worktrees\principles\PRI-1152-isolated-host-exec-pack\artifacts\pri-1152-isolated-host\pp-20261108T095217Z`，清单 sha256 `b16e81284bd1975036c3560f022d28610f1c43550d245e0e4610f926e383b895`。
- 结论：离线复核 **12 项 PASS，1 项 FAIL**。FAIL 为 `presence-durability`，即阻断项 B1（见运行卡 §0）。另有 **NOT RUN** 若干项，列于第 3 节。真实宿主和模型**均未启动**。
- 说明：本文没有任何一项声称「全部预检通过」。

## 1. 已实测项（方法、命令、退出码、产物、结果）

| # | 检查 | 方法与命令 | 退出码 | 产物/证据 | 结果 |
|---|---|---|---|---|---|
| 1 | 工作树与源码 | `npm run dev:worktree -- PRI-1152 isolated-host-exec-pack`，基于 origin/main `f7cdc5a15`；prepare 时记录 `git rev-parse HEAD` 与 `git status --porcelain --untracked-files=no` | 0 | manifest.source：`aabbd4550…`，tracked clean | PASS |
| 2 | 候选源码与 main 一致 | `git diff --stat f7cdc5a15 HEAD -- packages/{openclaw-plugin,host-runtime,principles-core}/src`、`esbuild.config.js`、`package.json` | 0 | 输出为空 | PASS |
| 3 | 候选构建可复现 | `npm run build:bundle`（packages/openclaw-plugin），执行两次 | 0 / 0 | 两次 sha256 均为 `773c5965…4192` | PASS |
| 4 | B1 落盘机制复现 | `node .tmp/pri1152-flush-probe/probe.mjs <dist\core\event-log.js> <dir> natural`；同一命令改用 `flush` | 0 / 0 | natural 模式：不生成 `events_*.jsonl`；flush 模式：1 行 presence 事件 | **复现缺口** |
| 5 | 执行包冻结 | `node scripts/dev/aa-controlled-admission/presence-run.mjs --prepare --repo <worktree>` | 0 | `PACK\manifest.json`、`host-files.json`、`candidate-files.json`、`approval.template.json` | PASS |
| 5a | 首次 prepare（已作废） | 同上，生成 `pp-20261108T094128Z` | 0 | tarball 对照发现 `.openclaw-lifecycle-pending` 缺失，经核实是官方 lifecycle 消耗的标记；代码修正为只容忍该标记（`aabbd4550`，附反例测试）后重新 prepare；作废包从未复核或批准，已检查无链接后删除 | 已取代 |
| 6 | 完整离线复核 + 协议自测 | `node scripts/dev/aa-controlled-admission/presence-run.mjs --verify --pack <PACK> --full --selftest` | **1** | `PACK\preflight\verify-20261108T095712Z.json` | 12 PASS / 1 FAIL |
| 6.1 | manifest | 校验 schema 与卡版本 | — | 同上 | PASS |
| 6.2 | node-identity | 复核 node.exe 的路径、版本、sha256 | — | `1c63f141…84ed` | PASS |
| 6.3 | host-identity | 复核版本 2026.11.1、build commit `4ffdd2047d1`、CLI sha256，确认无 lifecycle 标记 | — | — | PASS |
| 6.4 | host-tree | 对 44592 个文件全量重算哈希 | — | treeSha256 `d0d151c1…7495` | PASS |
| 6.5 | host-registry-tarball | 先按 npm 缓存 index-v5 定位 tarball，并验证其 SRI，再逐文件对照 15180 个文件 | — | 0 不一致、0 多余；仅缺消耗掉的 lifecycle 标记 | PASS |
| 6.6 | candidate-payload | 候选树哈希、bundle 哈希、外部依赖解析 | — | better-sqlite3 解析在包内 | PASS |
| 6.7 | presence-durability | 静态检查 bundle：`recordPromptPresenceObserved` 是否写盘 | — | `buffered_lost_on_one_shot_exit` | **FAIL（B1）** |
| 6.8 | host-config | 结构化校验：只加载候选；tools deny-all；MCP 关闭；两个回环 provider 共用同一个生成的占位 key（只校验格式，不计算指纹） | — | sha256 `dc0fa286…0cb3` | PASS |
| 6.9 | pd-config-and-retry | 经真实 `loadPdConfigForPlugin` 解析为 user_config，开关符合冻结值；`retry.provider.maxRetries=0` | — | — | PASS |
| 6.10 | fixture-assembly | 经正式存储解析 + 真实 shared 路由冻结：bodyComplete、恰好转义一次、`authority=system_policy`、approvals 为 0 | — | directive sha256 `f69e1373…bb45` | PASS |
| 6.11 | round-inputs | R1/R2 输入与金标数据集哈希 | — | — | PASS |
| 6.12 | environment-isolation | 用**当前**父进程环境（含生产 `PD_WORKSPACE_DIR` 和真实凭证变量）重建允许列表环境，证明全部路径在包内、没有凭证键 | — | — | PASS |
| 6.13 | production-plugin-exclusion | 包内发现根不存在；bundled 中无 PD；生产 PD 2.6.4 的 bundle 不含该事件类型 | — | 生产 bundle sha256 `f599cd89…3d09` | PASS |
| 6.14 | 协议自测 | 用包内官方 `@openclaw/ai` 传输层请求一次性 127.0.0.1 端点，使用独立账本（5 次请求，不计入运行预算） | — | `PACK\preflight\selftest-ledger-20261108T095711Z.json` | PASS（2 个正例 accepted，2 个负例 rejected，1 项仅记录） |
| 6.15 | 端口 | 绑定冻结端口 8652 后用原始 TCP 连接，不发送任何 HTTP 请求 | — | `portProbe.ok=true` | PASS |
| 6.16 | 终止与清扫能力 | `where.exe taskkill`；PowerShell CIM 进程查询 | — | 两项均可用 | PASS |
| 7 | 离线反例测试（scripts） | `npx vitest run scripts/__tests__/aa-presence-run.test.mjs scripts/__tests__/aa-controlled-admission.test.mjs` | 0 | 66/66（新增 32，既有 34） | PASS |
| 8 | 插件生产链测试 | `npx vitest run tests/hooks/{isolated-host-presence-fixture,llm-input-presence,prompt-presence-registry,runtime-prompt-activation}.test.ts` | 0 | 100/100 | PASS |
| 9 | 类型与守卫 | `npx tsc --noEmit -p packages/openclaw-plugin/tsconfig.json`；`npm run check:{runtime-writers,workspace-tools,repo-hygiene,security-baseline,naming-policy,runtime-contract}` | 全部 0 | — | PASS |
| 10 | 错误模式路由 | `npm run error:context -- --base origin/main` | 0 | 触发 EP-10/09/01/08，已逐项处理，见 PR | 已处理 |

## 2. 反例覆盖（第 7 项的明细）

- **预算**：R1/R2 用满后第 3 次启动、任何工具调用、任何付费调用均被拒绝且记账；同一账本文件重开后不会重置。
- **端点**：
  - 额外请求在读取请求体之前返回 403 `over_budget`；
  - 走另一种 API、不在回合内、不符合协议的请求均被拒绝，且不计费；
  - 请求体恰好等于上限时放行，超出 1 字节返回 413；
  - 带工具活动的请求返回 403 `tool_budget`；
  - 从不返回 429。
- **环境**：父进程指向生产路径、带有 `NODE_OPTIONS` 和 4 个凭证时，全部被重定向或丢弃；路径越界或注入类凭证键时，在返回之前拒绝；PRI-1118 构建器同样剥离了新增的发现覆盖变量。
- **执行**（假宿主，使用与真实端点相同的协议）：
  - 正常两回合用量为 2/2/0/0，端点关闭，证据保留，第二次 execute 被拒绝；
  - 宿主内部多发一次请求时 R1 失败，R2 不启动；
  - 宿主崩溃时启动已计账，运行停止；
  - 宿主挂起时 4 秒超时，`taskkill` 结束进程树，孙进程不存活；
  - 孤儿进程被清扫并判为停止；
  - 批准与执行包不绑定时，在任何启动之前拒绝，且不创建 `run\`。
- **判定门**：事件缺失（B1 的表现）、ambiguous、`checked_missing`、正文泄漏、多一次请求、路径错误、继承凭证、只有 `[DONE]` 的空答复、超时，这 9 个反例各自让对应检查项失败。
- **产物来源**：tarball 中多出一个已打包文件而在执行包中缺失时，provenance 判为 FAIL，执行包不可执行。

## 3. NOT RUN（获批真实运行才能产生，不得以路径存在或离线结果冒充）

1. 宿主实际加载候选插件。`plugins inspect --runtime` 会启动宿主并初始化插件，因此算作待批运行。这一项是 R1 的首项判定。
2. 真实 `llm_input` 派发与 presence 事件落盘。即使获批，也要等 B1 修复后才可能成立。
3. 宿主实际发出的请求形状，以及可能的额外调用（标题生成、压缩等）。这些由端点拒绝机制和停止规则兜底。
4. 宿主退出时序、编译缓存的实际位置，以及 `tools.deny` 下实际暴露的工具面。
5. 生产污染的前后对照。本轮只登记了目标清单；`--verify` 每次快照基线哈希，正式的执行前基线在 execute 时生成。
6. Mimosa 完整安全审计：两次提交时均为 `scanner_enobufs`，没有得出结论，不作安全声明。

## 4. 生产污染边界（本轮）

本轮对生产路径只做读取：全局宿主安装、生产插件、`~\.openclaw\openclaw.json`、生产 workspace 的 state.db 与日志目录列表、npm 缓存。全局宿主通过复制得到，没有在原位运行。不能用 mtime 或「未检索到标记」证明零写入；正式的污染对照规则见运行卡 §11。
