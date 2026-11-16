# EXPERIMENT_REPRODUCIBILITY_REPORT — PD-SPEC-001（整改后）

> 每一项均可由仓库内已提交脚本重放。所有产出（除本地全保真数据）均在 gitignored `.tmp`，且由内容哈希钉定。

## 1. 版本与指纹

| 组件 | 锚定方式 | 验证 |
|---|---|---|
| V1 prompt 代码 | worktree `adhoc-20261115-prompt-v2-v1arm-v1-base` HEAD = `0485046e71d2aeba4769725adb4f2aac35a5dd9b` | preflight `v1-arm-frozen-base`（40 位全等） |
| V2 prompt 代码 | **19 变体指纹**：从臂 dist 现场重算 19 个 systemPrompt 的 SHA-256，与 `prompts/prompt-hashes-v2.json` 逐项全等 | preflight `v2-prompt-fingerprint-matches-manifest`（内容锚定，非 HEAD 猜测） |
| 冻结文件（16） | `git rev-parse <base>:<file>` vs `HEAD:<file>` blob SHA 全等 | `check-frozen-files.mjs` → 16/16, 0 failures |
| 数据集 | 本地全保真副本 SHA-256 vs `.tmp/prompt-v2-inventory/dataset-manifest.local.json`；快照 SHA vs 数据集内嵌哈希 | preflight `full-dataset-integrity` |
| 两臂代码差 | `git diff --name-only v1base..HEAD -- src/runtime` ⊆ {6 builders + adapter} | preflight `arm-runtime-delta-scope` |
| 实验子环境 | childEnv 零工作区指针 + 工作区 realpath 包含于实验根 | preflight + Gate 0 NC5/NC6 |

## 2. Phase 0 管线从空白重放（Gate 1/G3）

1. `snapshot-and-discover.mjs --out .tmp/prompt-v2-inventory-gate1` — 独立目录完整重跑（不覆盖冻结批）：integrity ok、pain 计数与原快照一致（106；生产库在冻结时点后无新增）。
2. `freeze-dataset.mjs` 重跑 — **16/16 inputDigests 逐字节一致**（快照确定性重建，零漂移）；同时双写 full（本地）+redacted（公开）副本。
3. `dump-v1-prompts.mjs --worktree <V1 臂>` — 18 个既有变体哈希**逐字节复现** + 新增第 19 变体（production-default），V1↔V2 严格 19↔19 配对。
4. `dump-v2-prompts.mjs` — 19 变体 + V1↔V2 delta manifest（全部按预期变更）。

## 3. Gate 0 负控制（fail-closed 证明，零模型调用）

`node experiment/prompt-v2/scripts/gate0-failclosed.mjs` → **6/6 PASS**：
NC1 缺失全保真数据拒绝 · NC2 脱敏副本拒绝 · NC3 指纹漂移检出 · NC4 grid 失败传播（模拟 shard 失败 → launcher 非零） · NC5 生产指针注入被 childEnv 剥离 · NC6 工作区包含。

## 4. 执行与隔离（Gate 2/3/4）

- Gate 2/8：真实单样本 S05×两臂（zai）**PASS**（诊断三阶段+dreamer×2+philosopher×2+scribe 全链 done，严格验证全 true）。
- Gate 3 异常恢复：租约收割为单条条件 UPDATE（仅过期租约，CAS）；grid-2 运行中经历 2 次子进程超时重试与 1 次租约过期回收，无重复执行/虚假成功；S03.v1/S11.v1 的 intake 未运行由生产 nextAction（`pd candidate internalize`）按原 gate 补种入（gate 二次拒绝=合法终态）。
- Gate 4/5：盲评包 109 个（候选全集+逐 attempt 标注+证据全文仅本地），scrub+自检 fail-loud；指标按 (sample, stage, rep, arm) 主键配对，missing/invalid 结构化列出（不静默丢弃）。
- Gate 6：`ab-metrics` 已知输入 fixture 测试（32/32 子代理套件）+ 真实 grid-2 重算（completion 16/16、schema 0.981/0.990）。

## 5. 已知限制

- 生产快照是**时点语义**：重跑 snapshot 在生产库演进后会产生新批次（本机生产库在冻结时点后无新增，本批计数一致）。
- AMD 档位每日限额、intern-ai token 过期 → 实验档位为 zai glm-5.3（Owner 指令链披露于 `model-config.json`）；两臂同档，配对公平性不受影响。
- 评估器为 glm-5.3 独立会话（§7.4 同模型回退，披露）；建议 Owner 抽查 ≥20%。
