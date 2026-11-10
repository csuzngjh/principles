# PD-AA PRI-1162 实施卡 v0.1 — OpenClaw 共享装配轮次键（单 Session FIFO 覆盖偏差）

状态：**Owner 已书面批准 §4/§5 离线测试范围（2026-11-10，附四条验收说明，见 §6）；实施已完成**。调查基于 `origin/main 698de3fb4`（含 #2455 新渲染器），分支 `ai/PRI-1162-fifo-round-key`。

## 1. 问题与复现（反例）

紧预算下 `legacy_fifo_prefix_v1`（FIFO 前缀，遇非适配即停）恒选 base（activated_at ASC）前缀，尾部候选被永久饿死。同一快照（830fbd24，18 条候选、块 231–1219 字符、无 oversized）、同一共享入口 `buildActivePrinciplePromptContext`、同 Session 连续 12 个用户轮（数据：`.tmp/pri-1162/repro-result.json`，脚本 `repro-fifo-starvation.mjs`）：

| 预算 | FIFO 臂（现状） | 轮转臂（roundKey=2..13） |
|---|---|---|
| 4000 | 每轮恒同 10 条（3727 字符）；**8/18 永不出现** | 12 轮 17/18 入选；唯一未入选是 index 1（窗口内从未领先，N=18 需 N 轮全覆盖） |
| 2500 | 每轮恒同 6 条（2444 字符）；**12/18 永不出现** | 12 轮 17/18 入选 |

与 #1878（PRI-904，core 路径 16 条只装 9 条）同型。

## 2. 调查核心结论：接线已存在，无需新生产代码

Owner 任务书里"当前共享生产路径缺少 roundKey 时走 FIFO"在**仓库 main 上已不成立**——PRI-1137（PR #2398，2026-11-07 合并）已交付完整链路，且逐项满足任务书条件：

| 任务书条件 | main 现状（引用） |
|---|---|
| 唯一接线点 | `packages/openclaw-plugin/src/index.ts:475`：`roundKeyProvider: prepareOpenClawPromptRound`（无条件接线）→ `openclaw-host-runtime.ts:143` → `host-runtime/index.ts:324`（build context 前运行） |
| 轮次来源 | 既有 `trajectory.db user_turns.turn_index`（`packages/principles-core/src/trajectory-store.ts:152` `nextSessionTurnOrdinal` = `MAX(turn_index)+1` per session；不引入新列/表/游标/时钟） |
| 绑定当前轮 | 预选择半先由 `SignalCollectorHost.detectSync` 持久化**本轮** user_turn（`prompt.ts:490-510`），**随后**读序数——序数来自本次写入，不是"某 session 的最新序数" |
| 区分轮型 | 用户轮：`isUserInteractionTrigger`（user/api/undefined；heartbeat/cron/subagent 不算，`signal-collector-host.ts:71`）；agent-to-agent 与 boot check 由 `extractUserMessageFromPrompt` 拦；重试：`claimSignalRun`/`claimedSignalRunOrdinal`（`sessionKey\0runId`）重放**自己的**序数，绝不读全局计数 |
| 失败回退 | 空消息/解析失败/非交互触发/写入未持久化/DB 不可读/非正整数 → `undefined` → FIFO，且逐条 `logger.warn` 可观察（selectionPolicy 外显） |
| 隔离范围 | SQL `WHERE session_id = ?`（Session 级）；workspace 各自 DB（工作区级）；同轮多回调经 event WeakSet + run claim 幂等 |
| 同轮稳定性 | 同 run 重试重放同一序数（测试：`prompt-production-chain.test.ts` P1-3 并发推进用例）；同 roundKey 选中稳定（`active-principle-prompt-fair-rotation.test.ts` round5again） |
| packer 复用 | 零改动：`fair_rotation_v1`（轮转起点 + continue-on-non-fit）与 FIFO 同一 `packSharedDirectives`，PRI-1161 后新渲染器下字符计量同源 |

定向回归现状（PRI-1137 遗产已覆盖大部分）：一轮单写、同 run 重试、写入失败降级、heartbeat/空消息/解析失败/缺 sessionId、缺 DB 可观察、事件与选择一致、空候选集+roundKey 不 NaN。

## 3. 独立待核查项（按 Owner 验收说明 3 措辞：疑似发布物与源码不一致）

**已安装生产（`~/.openclaw/extensions/principles-disciple` 3.1.3）恒 FIFO 的现象，疑似发布物与源码不一致**。确认差异前的判定依据（哈希、版本、构建参数已保留）：

| 证据 | 值 |
|---|---|
| npm `principles-disciple@3.1.3` `dist/bundle.js` sha256 | `7301253d09d3c4a900bc3a44b4b3430b835b71d47161e6fdc94d8ff725f6546d` |
| 已安装 `~/.openclaw/extensions/principles-disciple/dist/bundle.js` sha256 | 同上（逐字节一致，mtime 2026-11-09 22:53:48 +0800） |
| 对应源码版本 | git tag `v3.1.3` = `e7c7e6bba`（其 `packages/openclaw-plugin/src/hooks/prompt.ts` 含 `prepareOpenClawPromptRound` 2 处） |
| 现构建对照 | 本工作树 `node esbuild.config.js` 产出 sha256 `b19f0ec18f29598a1ff4462156caac8b7f56611e9a46d8b646c49b75dfaa8d66`，含全部轮次键符号 |
| 发布物构建参数（既定流程） | 插件 `prepack` = `npm run build:production`（`esbuild.config.js --production`）+ `build:types`；bundle 是 OpenClaw 唯一运行时入口（`openclaw.extensions: ["./dist/bundle.js"]`） |
| 行为对照判定 | 发布 bundle 不含 `prepareOpenClawPromptRound`/`nextSessionTurnOrdinal`（0 命中），但含 host-runtime 半的 `roundKeyProvider` 消费逻辑 → 提供方缺失 → 恒 `legacy_fifo_prefix_v1`；源码与现构建均含完整链路 |

结论措辞：**疑似**发布管线将早于 #2398 的构建发布为 3.1.3。核查与修复归发版/安装管线（独立工单），本票不改、不等待；装上含 #2398 的构建后轮转即生效，无需配置变更。

## 4. 提议（Owner 批准后执行）

**零生产代码改动。** 交付 = 验收矩阵缺口补测试 + 一次同输入离线比较 + PR + 检查点：

1. **补测试**（仅补缺口，不改既有断言）：
   - 序列级覆盖断言：同 Session N 连续轮（roundKey=2..N+1）每条候选至少入选一次（N=候选数，INV-F02 数学）；
   - 短 Session 重开：新 sessionId 从序数 1 重新开始，选中从轮转起点重置，无跨 Session 计数残留；
   - 双 Session/双工作区隔离：各自轮次互不影响对方选中；
   - agent-to-agent 消息不推进（isAgentToAgent 分支）；
   - 真实调用链端到端：`prepareOpenClawPromptRound` → shared entry → 事件 `selectionPolicy/selectionRoundOrdinal` 与实际选中一致（已有部分，补连续轮变体）。
2. **同输入离线比较**（一轮裁决）：基线=合并 #2455 后的 Native FIFO（本卡 §1 复现即基线），对照=roundKey 序列轮转；固定候选与预算；报告逐条入选次数、最长未现间隔、最终字符数与额外开销。**先冻结通过线再看结果**（§5）。
3. 保留既有授权、必需约束、#2436 映射与 `would_displace_native_assembly` 回退语义（不动 adaptive 路径）。

## 5. 验收通过线（冻结于看结果之前）

- 紧预算（4000）12 轮窗口：轮转臂入选原则数 ≥ FIFO 臂 + 4（复现值 17 vs 10；下限 14 仍显著改善）；每个 FIFO 饿死候选在 18 连续轮内至少入选一次；
- FIFO 行为不变式：roundKey 缺失时输出与 #2455 基线逐字节一致（回滚安全）；同轮重试选中集不变；非用户轮/写入失败/隔离场景不产生轮次键（观察 selectionPolicy=legacy_fifo_prefix_v1）;
- 预算算术：继续满足严格加法恒等式（PRI-1161 同源计量）；新增测试全部绿，既有套件无回归；CI 必需门禁绿。
- 结论限定：仅单 Session 持续推进条件；跨宿主/跨 Session 归 PRI-930。

## 6. 成本与回滚

- 成本：预选择半新增一次 `nextSessionTurnOrdinal` 读（`idx_user_turns_session_id` 覆盖的 O(matches) 聚合）+ 一次本轮 user_turns 写（该写本来就是信号收集的一部分，PRI-1137 只是把它的时机从选择后移到选择前）；无新表/列/文件/进程。
- 回滚：`revert #2398` 即回 FIFO；运行时降级路径（provider 缺失/返回 undefined）本就恒 FIFO，两态并存无互斥风险。

## 7. 边界

本轮及批准后执行均为离线：宿主启动 0、真实模型调用 0、安装与生产写入 0；生产工作区只读（沙箱为 WAL-0 一致性副本）。已安装运行时目录不动。

## 8. Owner 批准与执行记录（2026-11-10）

Owner 批准实施卡 §4/§5 的离线测试范围，附四条验收说明：

1. 复用 #2398 已有接线，生产代码零改动；补最能发现接线退化的测试（连续轮推进、同轮重试稳定、非用户轮/缺键回 FIFO）；短 Session 重开、双 Session、工作区隔离若已有等价覆盖可引用现有测试。
2. 冻结输入比较 FIFO 与轮转，报告覆盖、最长未入选间隔及实际装配；18 轮通过线仅适用于已冻结的候选/预算/轮次推进条件；单列本身放不下的候选并保留原始失败结果。
3. 3.1.3 发布问题写成独立待核查项，保留 npm 与安装产物哈希、对应源码版本和构建参数，以实际接线或离线行为对照判定；确认前用「疑似发布物与源码不一致」。
4. 交回 PR、最终 head、覆盖数据、测试与 CI；结论分「仓库共享入口已验证」与「发布版本尚待验证」；宿主启动、模型调用、安装和生产写入均为 0。

执行结果（详见 `docs/implementation-reports/pri-1162-round-key-comparison-20261110.{md,json}` 与检查点）：

- 生产代码改动 0；新增 `tests/hooks/pri1162-round-key-coverage.test.ts` 5 例（T1 连续轮推进含"离开 FIFO 前缀"断言、T2 同轮重试字节稳定、T3 subagent 触发回 FIFO、T4 重开无计数残留、T5 双 Session 交替隔离）；等价覆盖引用：heartbeat/空消息/解析失败/缺 sessionId/写失败（`prompt-production-chain.test.ts` P1-3）、查询层 session 隔离（`trajectory.test.ts` 'isolates by sessionId'）、16 轮连续覆盖窗口（`prompt-production-chain.test.ts` T-PROD-01）。
- 冻结输入一轮比较全过通过线：4000 预算 FIFO 12 轮恒 10/18（8 饿死、恒 3727 字符、逐轮字节一致）；轮转 12 轮窗口 17/18 ≥ 14 ✅、18 连续轮 **18/18 全覆盖** ✅（2500 辅口径同型）；oversized 单列 = 0 条（本快照无此类候选，逐轮原始 oversized/dropped 记录保留于报告 JSON）；开销无增益（轮转均 2.95ms/轮 vs FIFO 3.14ms/轮）。
