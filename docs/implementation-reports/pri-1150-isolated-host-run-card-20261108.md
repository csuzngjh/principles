# PRI-1150 隔离宿主验证运行卡（草案 v1，待 Owner 批准——未获批准不执行）

- 文档 ID：`pri-1150-isolated-host-run-card-20261108`
- 性质：**可直接批准的运行卡**（Owner 第九轮 §三："现在就准备，不要先请求允许写运行卡"）。**未获批准前零执行**。
- 上游：#2412 合并 + 本仓 dist 构建后本卡才可执行（候选构建 = 本仓 build 产物）。

## 1. 目标

在未修改的官方 OpenClaw 2026.11.1 上，确认候选 PD 的正式 llm_input 注册、共享装配快照、关联裁决及自有事件端到端连通。**只验证装配观察**——不证明最终请求、送达、原则遵循或行为改善；**D 保持 unknown，不签收 G1/C04/G2**。

## 2. 精确构建与路径

| 项 | 值 | 来源 |
|---|---|---|
| 宿主 | OpenClaw **2026.11.1**（未修改，官方 npm 安装） | `openclaw --version` 前后对照 |
| PD 候选 | 本仓构建 dist（`npm run build`，含 llm_input 注册） | 构建后 dist sha256 记录 |
| 加载方式 | 独立 gateway 工作目录 + 显式插件路径（优先）；若 2026.11.1 要求插件必须安装，则以 `--plugin-dir`/等效机制加载候选目录（执行前用官方文档二次核实，不修补安装目录） | §3 预检 |
| 隔离 workspace | 临时目录（`os.tmpdir()` 下新建），最小 config.yaml：`features.prompt.enabled=true` + `plugins.entries.principles-disciple.hooks.allowConversationAccess=true` | 隔离加载已预检可行 |
| 环境隔离 | 进程 env 显式设置：`PD_WORKSPACE_DIR`/`OPENCLAW_WORKSPACE` 指向隔离目录（或 unset）；`ZAI_API_KEY` 等 provider key 从现有环境继承（模型密钥，非 PD 数据） | 防生产回落 |

## 3. 两个回合（responses + completions 各一）

| 回合 | API/模型 | 输入（冻结样本 A1 原文） | 期望观察 | 不应出现 |
|---|---|---|---|---|
| R1 | `openai-responses`（或宿主默认 responses 路径模型） | A1.text（correction 样本） | presence 事件：binding=unique、full_hit（A1 的 activationId）、reason 缺省 | binding=ambiguous/none；empty_snapshot |
| R2 | `openai-completions`（宿主 completions 路径模型） | 同 A1.text | 同上（egress=completions） | 同上 |

（准确 provider/model id 在执行时从宿主可用模型清单中选定并记录；不修改生产配置。）

## 4. 四个独立预算（任一触达即停，不自动重试）

| 预算 | 上限 |
|---|---|
| 宿主启动 | 2 次尝试（启动失败即记账失败、停止） |
| HTTP（宿主自身对 provider 的请求） | 2（每回合 1 次；失败即记账停止） |
| 工具调用 | 0（不调用任何工具） |
| 付费调用 | 0（本地假 provider 时为 0；若用真实 provider 则 ≤2 且必须在卡内指定 provider——默认推荐本地假 provider，故真实付费=0） |

**失败即停**：R1 失败不执行 R2。无自动重试（宿主内部对瞬时错误的单次重试属宿主行为，记账不掩蔽）。

## 5. 超时与停止条件

- 宿主启动超时 120s；每回合完成超时 180s。
- 停止条件：预算触达 / 任一断言失败 / 超时。停止后收集证据并关闭进程。

## 6. 隔离与生产污染检查（前后对照）

- 生产 `D:/.openclaw/workspace`、`~/.openclaw/openclaw.json`、安装目录、PD 安装 dist：哈希/mtime 前后对照零变化。
- 隔离 workspace 的 `.pd/state.db`、`.state/logs/events_*.jsonl` 仅在隔离目录内产生。
- 进程 env：无生产工作区回落（PD_WORKSPACE_DIR 检查）。

## 7. 证据清单

| # | 证据 | 保存位置（隔离目录内） |
|---|---|---|
| E1 | R1/R2 的 presence 事件原文（来自隔离 events jsonl） | `evidence/presence-events.jsonl` |
| E2 | 宿主启动参数/版本快照 | `evidence/host-snapshot.json` |
| E3 | 两回合模型响应摘要（无原文） | `evidence/round-summaries.json` |
| E4 | 污染检查前后对照 | `evidence/pollution-check.json` |
| E5 | 运行卡执行记录（步骤/时间/预算消耗） | `evidence/run-log.md` |

清理：验证后隔离目录整体保留 7 天供复核，之后按 Owner 指示处理；生产路径零触碰。

## 8. 回滚

关闭隔离宿主进程；删除隔离目录；已安装宿主/PD 未被触碰，无需其他回滚。

## 9. 结论上限

本卡通过 = llm_input 装配观察端到端连通（离线→真实宿主）。**不证明**：请求正文（wire）、送达、原则遵循、行为改善；**D 保持 unknown**；**不签收 G1/C04/G2**。wire 级证据仍属宿主侧范围（#194594 可选上游贡献，独立推进）。
