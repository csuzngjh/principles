# 检查点 20261110T0230Z-zcode-pri1162-investigated · PRI-1162

**决定：调查完成，实施卡 v0.1 待 Owner 书面批准（批准前零生产代码改动）。** 机器可读版本见同名 `.json`；`LATEST.json` 未改动。

## 核心结论（与任务书预期不同，需 Owner 注意）

**"当前共享生产路径缺少 roundKey"在仓库 main 上已不成立**：PRI-1137（PR #2398，2026-11-07 合并）已交付完整接线，逐项满足任务书条件。本票第一步的"实施"不存在生产代码改动——缺口不在源码，在发布物。

## 关键事实链

- 生产调用链（main 698de3fb4）：`openclaw-plugin/src/index.ts:475`（无条件接线 `roundKeyProvider: prepareOpenClawPromptRound`）→ `openclaw-host-runtime.ts:143` → `host-runtime/src/index.ts:324`（build context 前运行）→ `buildActivePrinciplePromptContext(roundKey)` → `fair_rotation_v1`（undefined → `legacy_fifo_prefix_v1`）。
- 轮次事实：`trajectory.db user_turns.turn_index`；`nextSessionTurnOrdinal` = `MAX(turn_index)+1` per session（`packages/principles-core/src/trajectory-store.ts:152`）；预选择半先写本轮再读（绑定当前轮）；`claimSignalRun`/`claimedSignalRunOrdinal`（`sessionKey\0runId`）使同 run 重试重放自己的序数；`isUserInteractionTrigger`（user/api/undefined）+ agent-to-agent/boot-check 拦截保证非用户轮不推进。
- FIFO 反例（同快照 830fbd24、18 候选、无 oversized、12 用户轮、宿主/模型/生产写入全 0）：
  - 4000 预算：FIFO 恒选同一前缀 10 条（3727 字符），**8/18 永不出现**；轮转臂（roundKey 2..13）17/18 入选。
  - 2500 预算：FIFO 恒选 6 条（2444 字符），**12/18 永久饿死**；轮转臂 17/18 入选。
  - 唯一轮转未入选 = index 1（12 轮窗口内从未领先；N=18 需 N 连续轮全覆盖，与策略无关）。
- **已安装生产（3.1.3）恒 FIFO 的根因**：npm `principles-disciple@3.1.3` 运行时入口 `dist/bundle.js`（sha256 前 16 = `7301253d09d3c4a9`，OpenClaw `openclaw.extensions` 唯一入口）不含插件半（`prepareOpenClawPromptRound`/`nextSessionTurnOrdinal` 0 命中）；v3.1.3 git tag 源码含完整实现；本工作树现构建 esbuild bundle 含全部符号。**发布物为早于 #2398 的过期构建**——修复归发版管线（独立授权），本票不改。
- 测试覆盖现状：PRI-1137 遗产已覆盖一轮单写/同 run 重试/写入失败降级/heartbeat/空消息/解析失败/缺 sessionId/缺 DB 可观察/空候选集；缺口=序列级覆盖断言、短 Session 重开、双 Session/工作区隔离、agent-to-agent 分支、连续轮端到端变体。

## 交付

- 实施卡：`docs/specs/PD-AA-PRI-1162-ROUND-KEY-IMPLEMENTATION-CARD-v0.1.md`（唯一接线点/改动文件/轮次来源/同轮稳定性/隔离范围/失败回退/成本/回滚/通过线）
- 分支 `ai/PRI-1162-fifo-round-key`，base `origin/main 698de3fb4`，head `144670238`
- 复现脚本与数据（会话临时件，不入库）：`.tmp/pri-1162/repro-fifo-starvation.mjs`、`repro-result.json`、沙箱 WAL-0 副本 `ws-sandbox/`（源快照 830fbd24 与 PRI-1160/PRI-1161 材料同源）
- 复现脚本与沙箱未入库：证明材料以检查点+卡内数据为准；沙箱含脱敏前原始正文，保持本地

## 通过线（已在卡 §5 冻结，先于批准后的正式比较）

紧预算 4000×12 轮：轮转入选 ≥ FIFO+4（下限 14）；每个 FIFO 饿死候选 18 连续轮内至少入选一次；FIFO 输出与 #2455 基线逐字节一致；同轮重试稳定；非用户轮/写入失败/隔离不产生键；预算加法恒等式保持；新增测试全绿+CI 必需门禁绿。结论限定单 Session 持续推进条件。

## 边界

宿主启动 0、真实模型调用 0、生产治理写入 0；生产工作区只读（WAL-0 副本）；`LATEST.json`、PRI-1160/PRI-1161 冻结件未动。
