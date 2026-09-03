# PRI-634-C Baseline — 验证前系统状态快照

采集时间：2026-09-03 13:0x–13:5x (UTC+8)

## 代码基线

| 项 | 值 |
|---|---|
| origin/main HEAD | `1ce9d8252ce0872cfaae4f5f03958f9fb68d2532` (Merge PR #1486 PRI-634 PR B shared information plane, 2026-09-03 10:52 +0800) |
| 验证 worktree | `D:\Code\principles-PRI-634C-pipeline-closure-validation` (branch `ai/PRI-634C-pipeline-closure-validation`) |
| PRI-634 PR A (#1484) | 已在 main（replay 收敛 + 修复轮按引用读 Evaluator 重放证据 + prompt v3） |
| PRI-634 PR B (#1486) | 已在 main（shared information plane tier2 wiring） |
| `npm run verify:merge` | exit 0（唯一 fail 行 = 0 errors / 16 条预存 lint 警告） |

## 安装基线（更新前 → 更新后）

| 项 | 更新前 | 更新后 |
|---|---|---|
| OpenClaw | 2026.8.2 (0965053)，gateway 18789 存活 | 同版本，gateway 重启后存活 |
| PD 插件 | 1.227.0（npm 发布版，**缺 PR B 代码**：无 `context-resolution.js`，artificer/evaluator-runner 均为旧版） | main-HEAD 自包含资产（`context-resolution.js` 等已就位；版本标签 1.76.1 = 源码组件版本，见"版本标签漂移"备注） |
| 安装方式 | 历史 npm/console 更新 | `build-self-contained-release.mjs`（SOURCE_DATE_EPOCH=main commit 时间戳）→ `PD_INSTALL_PLUGIN_DIR=<payload>` + `PD_SKIP_NPM_UPGRADE=1` 安装器 |
| pd CLI | npm 全局 1.227.0（更新后旧 shim 失效） | `~/.pd/runtime/bin/pd.cmd`（main 构建）；`~/bin/pd` 重指向 |
| PD workspace | `D:\.openclaw\workspace`（`.pd/state.db`） | 不变（安装器保留既有 `.pd/config.yaml`，PRI-308 行为验证） |

安装器报告：plugin=verified，cli=verified_local_only，features=passed，storyA=passed，manifestActivation=verified。
回滚资产：`~/.openclaw/pd-backups/principles-disciple.backup.1788412352526`（安装器自动备份）+ `D:\.openclaw\pd-reset-backups\pri634c-20260903\state.db`（手动 DB 备份，wal 为空）。

## PD 数据基线

| 项 | 值 |
|---|---|
| pain | 3 条，全部 `source: manual`（2026-09-01 历史 dogfood 补录） |
| principle ledger | 7 条 candidate；active activation 1 条：`Model-Evidence-Reversibility-Verification Loop`（prompt 渠道，2026-09-01 激活） |
| 注入统计（14 天窗口） | 100 sessions / 1265 turns / distinct principles 4 / avg distinct per session 1 |
| internalization 队列 | 50 个历史任务（多数 succeeded）；canary degraded ×2：1 个历史 dep-failed 任务 + 107 个 stale session 高 GFI（均预存，与本验证无关） |
| candidates | 11（7 consumed / 4 pending） |

## Feature flag 基线

DEFAULT_PROFILE（代码默认 + workspace 覆盖，未含本次验证改动）：
46 个 flag，29 enabled。其中：

- `internalization_full_chain` [core] = **true**（默认即开）
- `progressive_evaluator` [quiet] = false
- `context_manifest_budget` [quiet] = false

CLOSURE_PROFILE（本次验证新增，见 closure-profile.md）：
- `progressive_evaluator` [quiet] = **true**（workspace 覆盖）
- `context_manifest_budget` [quiet] = **true**（workspace 覆盖）
- 其余不变

4 条预存配置卫生 warning（与本次验证无关）：
1. `painEvidenceAdmission` 与规范 ID `pain_evidence_admission` 值冲突（canonical 生效）
2. `model_training` 未知 flag 被忽略
3. `trainer` 未知 flag 被忽略
4. 遗留配置文件 `.state/workflows.yaml` 仍存在

## 实验环境基线

- Scenario B lab：`pri634c-lab/scenario-b`（report-exporter，未等待流关闭 bug 复现：verify 失败 expected 400 rows got 0）
- Scenario C lab：`pri634c-lab/scenario-c/raw`（16 文件，aggregate sha256 `736124a1f97f63d27b20a491b85bc2d20f7dc3037d2a4aff7848bb81f0e06fed`）
- Scenario A lab：`pri634c-lab/scenario-a`（inventory-cli；audit 基线 `processed=9940 malformed=60 total=15583596986.56 avg=1567766.2964`，bench 245.1ms）

## 更新过程中修复的环境问题（非 PD 代码问题）

1. `openclaw-codex-8902d781d4` npm-project 插件目录为空（幽灵插件）→ gateway 重启后 plugin verification 拒绝报告 ready → 以官方 `@openclaw/codex` 重装修复（`openclaw plugins install @openclaw/codex --accept-capabilities`）。
2. 安装器自带的 gateway 检测未识别运行中的 schtasks gateway（`--stop-gateway` 未生效）→ 手动 `openclaw gateway stop --force` 后重跑安装器成功，`openclaw gateway start` 恢复。
3. 安装器以 `--no-auth` 起了 console（3100）替代 Owner 原 token-auth 启动方式（见 pipeline-report.md 风险节）。
