# PRI-1163 受控宿主验收运行卡 v1（`pri1163-round-key-run-card-v1`）— 待 Owner 批准

状态：**离线准备完成、预检 READY，等待 Owner 批准执行**。本卡不执行；`--execute` 需要批准文件绑定卡版本 + 清单 sha256 + 预算三者（缺一拒绝）。宿主启动 0、provider 请求 0、工具 0、付费 0（截至本卡交付）。

## 1. 目标与结论上限

在**未修改**的官方 OpenClaw 2026.11.1 上，用**已验证的发布产物**（3.1.3 `dist/bundle.js` sha256 `7301253d…6546d`，与 npm/安装/重建三处逐字节一致），经**官方普通聊天嵌入式入口**对**同一显式 Session** 连续提交两条真实用户输入，证明：`selectionPolicy=fair_rotation_v1` 且 `selectionRoundOrdinal` 逐轮推进（历史 `ord=72` 是旧心跳行为的证据，**不能代替本次普通用户轮验证**）。

结论上限：不证明原则送达、遵循或行为改善；不改变 PRI-1119（A 线）身份阻断——轮次序数是调度序数，**不得充当请求身份**；心跳/缺键回 FIFO 是设计行为，非缺陷。

## 2. 冻结身份（批准对象 = 下面两项绑定）

| 项 | 值 |
| --- | --- |
| 卡版本 | `pri1163-round-key-run-card-v1` |
| 执行清单 sha256 | `1cb7ed0b5a1dff057179f8e57eb1ad6311271f6fbc0cf0bd656baa0d52472ba6` |
| 执行包 | `D:\Code\_worktrees\principles\PRI-1163-release-round-key-audit\artifacts\pri-1163-round-key-host\pp-20261110T0452Z`（packId `rk-20261110T044944Z`；artifacts/ 整体 gitignored，永不入库） |
| 池外归档 | `D:\Code\principles\artifacts\pri-1163-round-key-host-evidence\pp-20261110T0452Z\`（manifest/approval 模板/运行卡/预检报告，逐文件 sha256 见其 README） |

## 3. 三份对照物（复用已验证结果）

| 对照物 | 冻结值 |
| --- | --- |
| 候选插件 | 安装目录逐字节复制（先验 `7301253d…`），包内再验同一哈希；入口 `openclaw.extensions=["./dist/bundle.js"]`；版本 3.1.3；外部依赖 better-sqlite3 随包携带 |
| 官方宿主 | openclaw 2026.11.1（build `4ffdd2047d1…`，buildId `2026.11.1-release-4ffdd2047d19-2026-11-05T01-26-26.075Z`），从全局安装复制 44,592 文件 / 530,686,533 B，treeSha256 `d0d151c1…`；registry tarball SRI 对照本轮 NOT_RUN（沿用 PRI-1152 已做过的同版本 tarball 逐文件对照结论） |
| Node | v26.12.1 |

宿主入口（与 PRI-1152 的关键差异，及其理由）：

```
node <pack>\host\node_modules\openclaw\openclaw.mjs agent --local --session-id 6e1f2a3b-4c5d-4e8f-9a0b-1c2d3e4f5a6b --message-file <input> --model pdroundkey-completions/isolated-roundkey-model --json
```

`agent exec` 是一次一会话（每调用独立 sessionId），无法验证序数推进；`agent --local` 是官方普通聊天嵌入式入口且支持 `--session-id`——两轮共用 `state\session` 目录与显式会话 id，第二轮恢复同一会话。

## 4. 隔离（沿 PRI-1152 已批准的机制）

- 环境按允许列表构造（`buildAllowlistedHostEnv`）：凭证/`NODE_OPTIONS`/`PD_*`/`OPENCLAW_*` 全部丢弃后显式重设；`HOME`/`USERPROFILE`/`OPENCLAW_HOME`/`APPDATA`/`LOCALAPPDATA`=`<pack>\home`；`OPENCLAW_STATE_DIR`=`<pack>\state\session`；`OPENCLAW_CONFIG_PATH`=冻结配置；`PD_WORKSPACE_DIR`/`OPENCLAW_WORKSPACE_DIR`=`<pack>\workspace`。
- 冻结宿主配置：只加载候选路径（`plugins.load.paths`）；`tools.deny=["*"]`；MCP pd-recall 关闭；唯一 provider `pdroundkey-completions` → `http://127.0.0.1:10493/v1`（假 key `pdroundkey-local-<32hex>`，随配置哈希冻结）；宿主日志固定 `<pack>\logs\openclaw-host.log`（info）。
- PD 配置：core 默认全量 + `signal_collector.enabled=true`（轮次提供方的预选择写入依赖它），`internalization_auto_consumer`/`correction_observer`/`anonymous_product_telemetry` 关，`prompt` 开；宿主会话设置 `retry.provider.maxRetries=0`。
- 原则夹具：**6 条合成夹具原则**（`pri1163-roundkey-fixture-01..06`）经正式存储入口写入（SqliteTaskStore→SqlitePIArtifactStore→SqliteActivationStateStore；approvals 零行，路由诚实派生 `system_policy`）；state.db sha256 冻结于清单。
- 隔离根证明（prepare 时记录）：探针解析结果 `…\pp-20261110T0452Z\tmp\probe-ws`（探针工作区，仍在包内）；运行工作区 `…\workspace`、trajectory `…\workspace\.state\trajectory.db` 全部在包内。

## 5. 启动前硬检查（事故转化的门，发布 bundle 实测）

事故（2026-11-10）：插件把显式声明工作区**优先于** hook ctx，夹具写入生产 3 行。本卡把它转成启动前硬门：

- **正例**（运行环境逐项复刻，子进程加载**发布 bundle** 并注册假宿主，以 heartbeat+空消息的零写入路径探钩子）：插件自报 `PD explicit workspace (pd_env: <path>)` → `<pack>\tmp\probe-ws` ✅ 在包内；trajectory 推导路径在包内 ✅；生产根（`D:\.openclaw\workspace`、真实 `~/.openclaw`、真实 `~/.pd`）零命中 ✅；日志确认走了「心跳轮记录不了轮次」的设计内不写路径 ✅。
- **负例自测**（剥掉隔离钉子 = 精确重演事故环境）：插件解析到 `pd_config: D:\.openclaw\workspace` → **以「生产根命中 + trajectory 越界」拒绝** ✅（预检报告 `verify-20261110T045112Z-0258fef7.json`）。
- 拒绝规则：任一解析出的工作区/trajectory 路径越出包根或命中生产根 → **spawn 之前拒绝**。每轮判定再读插件当轮日志行（注册来源指向候选根、`pd_env` 行指向包工作区、`trigger=` 必须是 user/undefined——心跳/cron 分类出现即失败，这是真信号不是夹具故障）。

## 6. 预算（fail-closed 账本，到顶不罚、下一次尝试发出前拒绝）

| 预算 | 上限 |
| --- | --- |
| 宿主启动 | 2（每轮 1；失败也计账） |
| provider HTTP | 2（每轮 1；端点在读请求体前预留；永不 429） |
| 工具 | 0（deny-all；端点见工具活动即 403 记账） |
| 付费 | 0（只有回环假 provider，无真实凭证） |

同一执行包只执行一次（`run\result-*` 已存在即拒绝）；账本取自冻结清单，不重置。

## 7. 冻结输入（同一显式会话 `6e1f2a3b-4c5d-4e8f-9a0b-1c2d3e4f5a6b`）

| 轮 | 文本 | sha256 |
| --- | --- | --- |
| R1 | PRI-1163 受控验收用户轮一：请确认本轮注入的原则集合与选择策略。 | `12a3c391b1e8bdc37cf0ec15062104528dac7a2a437204f23f79884c27b44157` |
| R2 | PRI-1163 受控验收用户轮二：继续同一会话，请确认轮次序数已推进。 | `cb1dd81afe4999476bd23afb5db7dc7ab12749c9a8040889f6616a2a973b808b` |

## 8. 两轮验收条件（冻结于执行前）

每轮全部满足才通过；R1 不过则 R2 不启动。

1. `host-exit`：退出码 0，未超时（外层 180s 强杀）。
2. `host-envelope`：`--json` ok=true；如报 sessionId 必须等于冻结会话 id。
3. `endpoint-one-request`：该轮恰好 1 次 served、0 次 refused，路径 `/v1/chat/completions`。
4. `candidate-registration-source`：当轮宿主日志 `Plugin registered. (Path: …)` 指向冻结候选根。
5. `explicit-workspace-line`：当轮 `PD explicit workspace (pd_env: …)` 指向包工作区。
6. `trigger-user-round`：当轮 `handleBeforePromptBuild called: … trigger=` ∈ {user, undefined}；出现 heartbeat/cron/subagent → 判失败（真实信号）。
7. `policy+ordinal`：R1 注入事件 `selectionPolicy=fair_rotation_v1` 且 `selectionRoundOrdinal=k1`（整数）；R2 同策略且 **ordinal == k1+1**、`rotationStartIndex` 相对 R1 前进 +1（mod 6）；选中集合 ⊆ 6 条夹具 id。
8. `user_turns`：隔离工作区 trajectory 中该会话 R1 后 1 行、R2 后 2 行，turn_index 连续。
9. `candidate-code-unchanged`：每轮后 bundle 哈希仍为 `7301253d…`。
10. **生产围栏**：生产 `user_turns` 总数相对基线 **1213 只增不减**且**永不出现运行会话 id**；每轮后与结束时审计，失败即 `contained_pollution_detected` 并停止后续轮。

## 9. 授权判定

- PRI-1152 的批准（`pri1152-run-card-v3.1` + 清单 `0e2dc6e3…`）已执行一次、绑定彼卡彼清单，**不覆盖**本运行。
- PRI-1163 工单范围明文「真实宿主启动 0」。
- 结论：**既有授权不覆盖本次执行 → 只交运行审批**。批准文件模板随包交付（`approval.template.json`）：Owner 填 `approvedBy`/`approvedAt` 后，由任意会话执行 `--execute --pack <dir> --approval <file>`（工具先重跑全部预检，再按预算账本执行两轮）。批准只对「卡版本 + 清单 sha256 + 预算」这一组取值有效；重新 prepare 即失效。
- 批准即代表同意：宿主启动 ≤2、回环 provider 请求 ≤2、零工具、零付费、零生产写入（围栏审计强制）。

## 10. 结束清理

端点关闭 + 进程清扫 + 生产围栏终审 + 预算账本落盘；隔离根整体保留为证据（含宿主日志、events JSONL、trajectory、envelope 输出）；生产目录零触碰（除围栏只读审计）。

## 11. 交付与复现

- 工具：`scripts/dev/aa-controlled-admission/round-key-run.mjs`（`--prepare`/`--verify`/`--execute` 三段式；复用 PRI-1152 的 `stageHost`/账本/环境允许列表/回环端点库）。
- 本包预检：`--verify --pack <dir> --full --probe-selftest` → **12 PASS / 0 FAIL，exit 0**（报告 `preflight/verify-20261110T045112Z-0258fef7.json`）。
- 过程披露：第一次 prepare 的探针正例向夹具 state.db 写入 presence receipt 行导致冻结哈希漂移——探针工作区改为一次性 `tmp/probe-ws` 后重新 prepare（早期包与清单 `77c207bc…` 作废，从未批准也从未执行）；负例探针初版只匹配 `pd_env` 来源标签、漏掉 `pd_config`（声明文件）标签——已放宽为任意来源标签，负例现以真实生产命中理由拒绝。
