# PRI-1152 复核修复卡（#2424 三项 + 独立 B1）

- 基线：#2424 head `d916daad8`；B1 基线 origin/main `d34b7c012`。
- 授权：只做代码修复和离线验证。不启动真实宿主或模型，不动生产配置或数据库，不安装、不发布、不合并。
- 交付：B1 走独立分支和独立 PR；另外三项推到 #2424。现有 v3 包只读，不覆盖任何冻结文件。

## 0. 已核实的调用链（旧实现）

| 环节 | 事实 | 位置 |
|---|---|---|
| presence 事件写盘 | `recordPromptPresenceObserved` 只调 `record()`。缓冲 20 条或 30 秒 unref 定时器才写，进程自然退出不写 | `packages/openclaw-plugin/src/core/event-log.ts` |
| READY 计算 | `verifyPack` 只算 13 项静态检查。CLI 事后追加 `portProbe`、`termination`、`processSweepAvailable`、`protocolSelftest`，不参与 `ready` 和退出码 | `presence-run.mjs` main |
| execute 前复核 | `execute` 只调 `verifyPack({full:true})`，没有端口、终止工具、清扫能力和协议自测 | `presence-run.mjs` execute |
| 代码绑定 | 清单只有 `source.headSha`。脚本和 dist 从工作树加载，改动后清单哈希不变 | `presence-pack.mjs` preparePack |
| 预算 | `execute` 用当前常量 `PRESENCE_RUN_BUDGET`，不读冻结清单；`validateApproval` 不校验 `budgets` | `presence-run.mjs` execute |
| 污染审计 | `finally` 里计算一次，不进入 `status` | `presence-run.mjs` finally |

旧实现反例由 `.tmp/pri1152-red/red.mjs` 用假宿主实测，结果见 §6。

## 1. B1（独立 PR）

- 在 `recordPromptPresenceObserved` 记录后调用既有 `flushEvents()`，与 `recordAdaptiveDelivery` 相同。不加全局 exit 钩子，其他事件的写盘策略不变。
- 回归测试用真实 `EventLog`（esbuild 打包源码）放在子进程里自然退出：测试和子进程都不调用 flush、dispose、`process.exit`，也不等 30 秒。修复前磁盘 0 条，修复后恰好 1 条。
- 对照组：同样条件下普通缓冲事件仍不落盘，证明写盘策略没有被全局改变。
- 写盘异常语义不变：写失败时不抛出、记 `logger.error`、事件留在缓冲区。flush 不等于绝对持久化。

## 2. #2424：READY 统一计算

- `PREFLIGHT_REQUIRED_CHECKS` 是唯一必需项清单，`summarizePreflight` 是唯一的 ready、summary、failing 计算点，退出码只看 `ready`。
- 端口、终止工具、进程清扫、协议自测、污染审计基线都进入同一检查集合。NOT_RUN 不算通过，所以只有 `--full --selftest` 才可能 READY。
- `--execute` 在建 `run/`、创建账本之前重新跑全部必需检查，不读历史预检文件。
- 端口检查只说明"当时空闲"，不是预留。真实绑定失败时，`stoppedAt=endpoint-bind`，不启动宿主，不计预算，证据保留。
- 协议自测只在 `host-tree` PASS 后才导入包内 transports，否则记 NOT_RUN。
- 清扫能力一并修正：`process-sweep` 要求查询可用且没有进程引用该包；启动器自身及其祖先进程不在清扫范围内。

## 3. #2424：批准绑定实际执行代码

- 清单新增 `executionCode`：
  - `scripts`：启动器及其相对导入闭包，共 11 个文件，记录相对路径和 SHA-256；
  - `workspaceBuilds`：启动器加载的 3 个工作区包的 `dist`，只算 `.js`，记录相对路径、文件数和聚合 SHA-256；
  - `trustBoundary`：信任边界说明。
- 不做依赖扫描。列表是固定常量，由测试走真实 import 图防止漂移。
- `execution-code` 检查按**运行中模块的位置**重算，不信任清单里的路径，不符就在启动宿主前拒绝。
- 清单不把自身或任何包内文件列入，因此没有哈希循环依赖。无关文档变化不影响结果。
- 预算：账本改用 `manifest.budget`；`budget-consistency` 检查冻结值与当前常量、每臂预算的内部一致性；`validateApproval` 校验 `budgets`。
- 信任边界：这是防漂移校验，由被校验的代码自己执行，**不能抵御校验器或 Node 被恶意替换**；第三方 `node_modules` 不在列表内。

## 4. #2424：污染审计影响停止和最终结论

- 复用 `comparePollution`，新增 `classifyPollution` 汇总，不新建审计系统。
- 每个回合结束、下一回合启动前，用既定目标对比启动前基线。

| 汇总结果 | 含义 | 动作 |
|---|---|---|
| `attributed` | 找到运行标记 | 停止，不启动下一回合，最终不得 `completed` |
| `review-required` | 静态安装文件变化，原因未定 | 停止，标明待人工复核，不断言由实验造成 |
| `incomplete` | 审计无法完成 | 停止，写明原因，不声称审计通过 |
| `unattributed-changes-noted` | 活动库或日志变化且无标记 | 不停止，保留"不能归因"的事实，不判污染 |
| `clean` | 目标内未见变化 | 继续；不等于证明零写入 |

- 读取失败改记 `audit-incomplete`，不再计入 `changed-attributed`；快照按目标捕获异常，不再让 `finally` 中断。
- 目标超过哈希或扫描上限时不再声称 unchanged；日志文件被删除算变化。
- `finally` 保留清理和最终审计，一定写出 `run-record.json`。审计全程只读，不删除、不回写、不回滚生产数据。
- 反例全部用临时模拟生产目录，不碰真实生产库。

## 5. 不做的事

- 不改 OpenClaw，不做通用依赖扫描，不冻结整个仓库，不重写其他观察功能。
- 不生成 v3.1 包：只有实际包含 B1 修复的构建才能重新 prepare，新包必须有新清单哈希，且需要 Owner 重新批准。

## 6. 旧实现反例实测（修复前）

| 反例 | 结果 |
|---|---|
| 端口被占；自测失败；`where.exe` 不可用；PowerShell 不可用 | 四种情况都是 `ready=true`、exit 0 |
| 自测失败时 `--execute` | R1、R2 都启动，`completed` |
| 端口被占时 `--execute` | `stopped`，未启动宿主，`run/` 已建 |
| 命令行含包路径的父进程 | 清扫杀掉启动器所在进程树，R1 已启动，无 `run-record.json` |
| 批准后改启动器 | 被改的代码运行，清单哈希不变，`completed` |
| 批准后改预算常量 | 账本用 9，冻结值 2，`completed` |
| 污染已归因 | `attributed` 非空，R2 仍启动，`completed` |
| 静态安装文件变化 | `reviewRequired` 非空，R2 仍启动，`completed` |
| 污染目标读取失败 | `finally` 抛 EISDIR，`run-record.json` 未写出 |
| 标记扫描失败 | 判为 `changed-attributed`（错误归因） |

工具版本 `d916daad8`。方法：复制工具到临时目录，用假宿主和临时模拟生产目录驱动；CLI 场景经子进程运行并读取真实退出码。

## 7. 修复后实测（同一批场景，工具 `8860abcea`）

| 反例 | 结果 |
|---|---|
| 端口被占 | `ready=false`，exit 1，失败项 `endpoint-port` |
| 自测失败 | `ready=false`，exit 1，失败项 `protocol-selftest` |
| `where.exe` 不可用 | `ready=false`，exit 1，失败项 `termination-tool` |
| PowerShell 不可用 | `ready=false`，exit 1，失败项 `process-sweep` |
| 自测失败时 `--execute` | `refused-before-any-start`，宿主启动 0，无 `run/` |
| 端口被占时 `--execute` | `refused-before-any-start`，宿主启动 0，无 `run/` |
| 命令行含包路径的父进程 | 启动器存活，R1、R2 正常完成，写出 `run-record.json` |
| 批准后改启动器 | `refused-before-any-start`，失败项 `execution-code`，宿主启动 0 |
| 批准后改预算常量 | `refused-before-any-start`，失败项 `execution-code`，宿主启动 0 |
| 污染已归因 | `stopped`，`stoppedAt=R1`，`pollution_attributed`，R2 未启动 |
| 静态安装文件变化 | `stopped`，`pollution_review_required`，待人工复核，R2 未启动 |
| 污染目标读取失败 | `stopped`，`pollution_audit_incomplete`，写出 `run-record.json` |
| 标记扫描失败 | `audit-incomplete`，`attributed` 为空 |

这些场景都已固化为 `scripts/__tests__/aa-presence-run.test.mjs` 中的测试（61 条，连续 3 轮全绿）。

## 8. 证据保存说明

§6、§7 的结果由会话临时脚本 `.tmp/pri1152-red/red.mjs` 产生。该脚本、旧工具副本和结果 JSON 都在 worktree 的 `.tmp/` 下，21:03 被外部进程连同整个 worktree 一起删除（运行卡 §15）。上表是删除前的原始输出抄录。如需复核，可将 `d916daad8` 的 `scripts/dev/aa-controlled-admission` 导出到临时目录，用同一假宿主重跑。
