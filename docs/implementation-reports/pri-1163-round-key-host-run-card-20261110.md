# PRI-1163 受控宿主验收运行卡 v2（`pri1163-round-key-run-card-v2`）— 待 Owner 批准

状态：**离线准备完成、预检 READY（14/14，exit 0），等待 Owner 批准执行**。v2 取代 v1 的全部可执行内容（执行器按 #2424 机制加固后重新冻结；v1 包 `pp-20261110T0452Z`/清单 `1cb7ed0b…` 与更早的 `77c207bc…` 均作废，从未批准也从未执行）。本卡不执行；`--execute` 需批准文件绑定**卡版本 + 清单 sha256 + 冻结预算 + 执行代码（启动器脚本哈希）**四者。宿主启动 0、provider 请求 0、工具 0、付费 0（截至本卡交付）。

## 1. 目标与结论上限

在**未修改**的官方 OpenClaw 2026.11.1 上，用**已验证的发布产物**（3.1.3 `dist/bundle.js` sha256 `7301253d…6546d`），经**官方普通聊天嵌入式入口**（`agent --local --session-id <冻结id>`）对**同一显式 Session** 连续提交两条真实用户输入，证明 `selectionPolicy=fair_rotation_v1` 且 `selectionRoundOrdinal` 逐轮推进。结论上限：不证明送达/遵循/行为改善；不改变 PRI-1119（A 线）身份阻断——轮次序数是调度序数，**不得充当请求身份**；历史 `ord=72` 是旧心跳行为证据，不能代替本次普通用户轮验证。

## 2. 冻结身份（批准对象 = 四项绑定）

| 项 | 值 |
| --- | --- |
| 卡版本 | `pri1163-round-key-run-card-v2` |
| 执行清单 sha256 | `ca680b7d4743834d9f5a6975a9c4163e5402e28dbc17bc50a376b6109392a38a` |
| 执行代码 | 启动器 + 8 个 lib 模块的 sha256（manifest.executionCode；**任一脚本变更即失绑**，必须重新冻结） |
| 执行包 | `…\_worktrees\principles\PRI-1163-release-round-key-audit\artifacts\pri-1163-round-key-host\pp-20261110T0545Z`（packId `rk-20261110T053755Z`） |
| 池外归档 | `D:\Code\principles\artifacts\pri-1163-round-key-host-evidence\pp-20261110T0545Z\`（逐文件 sha256 索引） |
| 预算 | 宿主启动 2 / 回环 provider HTTP 2 / 工具 0 / 付费 0 |

## 3. 入口与隔离（v1 基础上不变的部分）

- 入口：`node <pack>\host\…\openclaw.mjs agent --local --session-id 6e1f2a3b-4c5d-4e8f-9a0b-1c2d3e4f5a6b --message-file <input> --model pdroundkey-completions/isolated-roundkey-model --json`（`agent exec` 一次一会话，验不了序数推进）。
- 环境：PRI-1152 允许列表（凭证/NODE_OPTIONS/PD_*/OPENCLAW_* 丢弃后显式重设；HOME/OPENCLAW_HOME/APPDATA 全部指向包内）；`OPENCLAW_STATE_DIR` 两轮共用 `state\session`；配置只加载候选、`tools.deny=["*"]`、MCP 关、宿主日志固定包内（info）；PD 配置 `signal_collector=true`（预选择写入依赖）+ 后台特性关；6 条合成夹具原则经正式存储播种（approvals 零行）。
- 候选/宿主：发布 bundle 逐字节复制并复验 `7301253d…`；官方宿主 2026.11.1（44,592 文件，treeSha `d0d151c1…`）。

## 4. v2 加固（全部复用 #2424 已有机制）

1. **启动前独占认领**：认领文件 `run/claim.json` 以 `wx` 创建（并发执行者在竞争输掉处被拒）；同包重复执行 = 认领/账本/结果任一存在即 `PACK_ALREADY_CLAIMED` 拒绝（预算永不重置，一包一次）。
2. **逐轮生产围栏**：生产 `user_turns` 以 {total, runSessionRows} 快照，**每轮后**审计——总数只增不减且永不出现运行会话 id；违反（含快照不可读 `PRODUCTION_FENCE_INCOMPLETE`）→ 记录 {step, code, message}、**R2 不启动**、`production_fence_failed` 停因；结束时终审。
3. **按字节读取本轮证据**：宿主日志与 events 文件按**字节偏移**增量读取（`readAppendedBytes`，Buffer 解码——中文等多字节 UTF-8 不会被字符串切片劈开）；截断/收缩/读失败 = `HOST_LOG_TRUNCATED|SHRUNK|READ_FAILED` / `EVENTS_LOG_*` 稳定错误码；证据不完整 → 本轮 gate 失败 → 停止。
4. **失败语义**：所有失败以 {step, code, message} 追加进 `run-record.failures`；R1 gate/围栏/证据任一失败 → 停止（R2 不启动）；**最终记录在任何失败路径下都写出**（`finally` + `wx`）。
5. **探针-spawn 环境一致性**：清单冻结 spawn 环境指纹（`envFingerprint`=排序键值 sha256）；execute 时重建 spawn 环境比对指纹，不一致 → `SPAWN_ENV_DRIFT`，spawn 前拒绝。探针（正例）与 spawn 用同一构建器同一布局输入。
6. **批准绑定执行代码**：manifest.executionCode 冻结启动器 + 8 个 lib 模块哈希；批准文件必须绑定同一 executionCode；verify/execute 前重算比对——**执行器任何变更 → `EXECUTION_CODE_DRIFT` → 拒绝，必须重新冻结卡与清单并重新批准**（本包准备过程中已实际触发一次并按流程重新冻结）。
7. **预算绑定**：批准文件的 budgets 必须逐字等于冻结清单预算（`APPROVAL_BUDGETS`），账本 fail-closed（到顶不罚、下一次尝试发出前拒绝；失败宿主启动也计账）。

## 5. 启动前硬检查（事故转化的门，v1 机制不变）

正例（运行环境逐项复刻 + 一次性探针工作区）：发布 bundle 自报 `pd_env` → 包内、trajectory 在包内、生产根零命中、零写入路径确认。负例（剥钉重演事故）：`pd_config: D:\.openclaw\workspace` → **以「生产命中 + trajectory 越界」拒绝**。任一歧义或生产命中 → spawn 前拒绝。每轮另验注册来源/显式工作区行/trigger 分类（非用户轮出现即失败——真信号）。

## 6. 冻结输入与两轮验收条件（同一显式会话 `6e1f2a3b-…`）

R1「PRI-1163 受控验收用户轮一：请确认本轮注入的原则集合与选择策略。」（`12a3c391…4157`）；R2「PRI-1163 受控验收用户轮二：继续同一会话，请确认轮次序数已推进。」（`cb1dd81a…808b`）。

每轮全部满足才通过；R1 不过则 R2 不启动：①host-exit 0 未超时；②envelope ok=true 且 sessionId 相符；③恰 1 served 0 refused；④注册行指向候选根（**逐轮判定**，R2 缺行即失败）；⑤显式工作区行指向包工作区；⑥trigger ∈ {user, undefined}；⑦R1 `fair_rotation_v1`+整数序数 k1，R2 同策略 + **ordinal==k1+1** + rotationStartIndex +1（mod 6）；⑧user_turns 会话行 R1 后 1、R2 后 2 且连续；⑨bundle 字节不变；⑩字节级证据完整性（无截断/收缩/读失败）；⑪逐轮生产围栏通过；⑫每轮恰 1 宿主启动 + 1 provider 请求。

## 7. 验证（本卡交付时的全部证据）

- 反例夹具（离线，纯门函数）：**18/18 PASS**——R1 后生产标记围栏失败、同包重复执行拒绝、R2 缺注册行失败（R1 有行）、中文日志增量字节级精确（含收缩→HOST_LOG_SHRUNK、事件基线后新行计数）、脚本变更 `EXECUTION_CODE_DRIFT`、预算失绑 `APPROVAL_BUDGETS`、未签名 `APPROVAL_UNSIGNED`、env 指纹稳定性。位置 `scripts/__tests__/aa-round-key-run.test.mjs`。
- scripts 全量回归：`vitest run --maxWorkers=2` → **119 文件 / 2431 passed / 3 skipped / 0 失败**。全并行默认档下 3 个重型文件（check-naming-policy/workspace-lifecycle/principle-learning-lab-challenge-1b）出现 6 个资源竞争失败，**单跑各自全绿**（20/20、27/27、隔离运行全过）——既有已知的并行 flaky 形态（与 PRI-1137 等记录一致），非本改动回归；本改动文件与其零交集。
- 本包预检：`--verify --full --probe-selftest` → **14/14 PASS，exit 0**（新增 execution-code 与 env-parity 两门；报告 `preflight/verify-…json`）。
- 过程披露：①v1 探针写夹具库致冻结哈希漂移 → 探针改一次性 `tmp/probe-ws`；②负例正则初版漏 `pd_config` 来源标签 → 放宽为任意来源标签；③v2 预检的 `run-dir-absent` 初版误把 prepare 预建目录判为已执行、execute 的 rerun 判定同理 → 改为认领/账本/结果三事实；④清单执行代码在认领修复后再改驱动 → `EXECUTION_CODE_DRIFT` 按设计拒绝 → 重新 prepare 本最终包（漂移门实战验证）。

## 8. 授权与执行

既有授权不覆盖（PRI-1152 批准已消费且绑定彼卡；PRI-1163 工单明文宿主启动 0）→ **只交运行审批**。批准即同意：宿主启动 ≤2、回环 provider ≤2、零工具、零付费、零生产写入（围栏强制）。批准文件模板随包（`approval.template.json`，含 executionCode 绑定）；Owner 填 approvedBy/approvedAt 后由会话执行 `--execute --pack <dir> --approval <file>`；执行前工具自动重跑全部预检（14 门），两轮输入由工具经回环假 provider 提交，**Owner 无需操作宿主或提供数据**。

## 9. 结束清理与证据

端点关闭 + 生产围栏终审 + 账本落盘；隔离根整体保留（宿主日志、events JSONL、trajectory、envelope、逐轮 evidence/ 11 类文件）；生产目录零触碰（围栏只读审计除外）。生产基线 1213（记录于清单，围栏基准）。
