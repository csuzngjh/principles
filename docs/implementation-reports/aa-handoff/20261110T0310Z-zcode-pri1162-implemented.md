# 检查点 20261110T0310Z-zcode-pri1162-implemented · PRI-1162

**决定：KEEP（仓库共享入口已验证；发布版本尚待验证）。** Owner 2026-11-10 批准实施卡 v0.1 §4/§5（附四条验收说明）后实施完成；生产代码改动 0。机器可读版本见同名 `.json`；`LATEST.json` 未改动。

## 交付

- 分支 `ai/PRI-1162-fifo-round-key`，base `origin/main 4000adc49`（rebase 自 698de3fb4）。提交：调查+卡 → 检查点 → 批准记录+覆盖测试+比较+报告（见 git log）。
- 实施卡 `docs/specs/PD-AA-PRI-1162-ROUND-KEY-IMPLEMENTATION-CARD-v0.1.md`（§8 批准与执行记录）；比较报告 `pri-1162-round-key-comparison-20261110.{md,json}`；比较 harness `scripts/dev/aa-selector/pri1162-round-key-comparison.mjs`（入库）。
- 新增测试：`packages/openclaw-plugin/tests/hooks/pri1162-round-key-coverage.test.ts`（T1–T5，5/5 绿）：连续用户轮经真实生产链推进轮转（含"最老候选缺席于 start>0 轮"的反 FIFO 断言）、同轮重试字节稳定、subagent 触发回 FIFO、重开 Session 无计数残留、双 Session 交替隔离。
- 等价覆盖引用（验收说明 1）：heartbeat/空消息/解析失败/缺 sessionId/写失败 → `prompt-production-chain.test.ts` P1-3；查询层 session 隔离 → `trajectory.test.ts` 'isolates by sessionId'；16 轮连续覆盖窗口 → 同文件 T-PROD-01。

## 一轮同输入比较（冻结输入，通过线全过）

- 4000 预算：FIFO 恒 10/18（8 饿死、恒 3727 字符、逐轮字节一致）；轮转 12 轮窗口 **17/18 ≥ 14** ✅、18 连续轮 **18/18 全覆盖** ✅。2500 辅口径同型（FIFO 6/18 → 轮转 18/18）。
- oversized 单列（验收说明 2）：本快照 0 条（最大块 1219 < 2500）；逐轮原始 oversized/dropped 保留于报告 JSON。
- 开销：轮转 2.95ms/轮 vs FIFO 3.14ms/轮（同量级）；注入仍严格 ≤ 预算（严格加法计量不变）。

## 独立待核查项（验收说明 3）

已安装 3.1.3 恒 FIFO：**疑似发布物与源码不一致**（确认前措辞）。证据已保留：npm 与已安装 bundle sha256 逐字节一致（`7301253d09d3c4a9…`），对应源码 tag `v3.1.3=e7c7e6bba` 含完整实现，现构建含全部符号；判定方式=bundle 符号对照 + tag 源码 + 现构建行为对照。核查修复归发版管线独立工单；本票不改、不等待。

## 测试与 CI

- 定向回归：新套件 5/5；`prompt-production-chain` + `runtime-prompt-activation` 91/91；CI 以 PR 页面为准（回填检查点）。

## 边界

宿主启动 0、真实模型调用 0、安装与生产写入 0；生产工作区只读（WAL-0 副本）；`LATEST.json` 与既有冻结件未动。Mimosa `scanner_enobufs` 复发，不宣称安全结论。
