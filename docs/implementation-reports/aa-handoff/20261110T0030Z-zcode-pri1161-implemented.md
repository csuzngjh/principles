# 检查点 20261110T0030Z-zcode-pri1161-implemented · PRI-1161

**决定：保留（KEEP）。** 实施卡 v0.1 按 Owner 2026-11-10 批准（附四项条件）实施完成；两层离线比较全部通过。机器可读版本见同名 `.json`；`LATEST.json` 未改动。

## 交付

- 分支 `ai/PRI-1161-directive-boilerplate`，base `origin/main e7c7e6bba`。提交：`a7dd7c1af`（批准+调用者审计）→ `7e5b467bd`（实施+测试+changeset）→ `1159cd32a`（两层比较+决定）→ 检查点。
- 改动：`prompt-activation-reader-contract.ts` 两个 builder（块 5→4 行；header 行 125→178）；golden/特征化、packing 属性、fair-rotation 与 projection 夹具（+86 缩放保持原边界）、deliverability 成本模型（单条 −33）及钉值更新；新增 6 例覆盖测试。
- 定向回归全绿：core 534、host-runtime 71 文件 802、plugin 定向 79 + 全量 2354（BDD EPERM 与 tar 为本机环境问题，CI 为权威）、pd-cli capacity 3；eslint 0 错误。

## 两层比较（报告：pri-1161-two-layer-comparison-20261110.md/.json）

- **层 1（同集合同顺序 20 轮）**：`new = old − 86×N + 53` 逐字节精确 20/20；删除=N 样板行+旧行，新增=仅新行；开标签与 MANDATORY 行逐字节不变；样板行 0 次、约束恰 1 次；旧行不再出现。
- **层 2（共享入口 20 轮）**：每轮净变化与会计恒等式精确吻合（20/20，含 k9/k13 轮转移位轮）；**15625 轮 9208→7713，净 −1495 = −16.2% ≥ 15% 线**；FIFO 4000 三列分报：样板 −602 / header +53 / 补位 +881 → 净 +332（正文变大属合法补位）。轮转移位归因：旧 packer + 新成本精确复现新集合。
- **常数更正（对 Owner）**：卡面 −87 实为 **−86**（句子 85 字符），单条净 −33；收益 −1495/−16.2% 略低于卡面估计，仍过线。

## 边界与未动

零模型调用、零宿主启动、零治理写入。PRI-1160 旧基线、原始哈希、`LATEST.json` 未动。按条件 4：新渲染器下做治理后复测时须另冻同渲染器版本基线。FIFO 缺轮次键维持现状。

## CI

28 SUCCESS + 3 SKIPPED，0 失败（2026-11-10T01:05Z 核对）；mergeable=MERGEABLE。
