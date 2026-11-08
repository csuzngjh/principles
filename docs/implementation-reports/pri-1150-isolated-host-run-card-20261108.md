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
| PD 候选 | 本仓构建 dist（`npm run build`，含 llm_input 注册）；构建 sha256 记录入证据 | 构建后 dist 哈希清单 |
| 插件加载（官方机制，已核实） | 独立 **`OPENCLAW_HOME`**（隔离 home root：config/extensions/state 全部随之隔离，`src/plugins/discovery.ts` env home 字段）+ 隔离配置内 **`plugins.load.paths`** 指向候选插件目录（官方文档：`docs/plugins/architecture.md:993` "For intentional local overrides, use `plugins.load.paths` to select the plugin path"） | release/2026.11.1 源码/文档 |
| 排除生产 PD 插件 | 独立 OPENCLAW_HOME 下已安装 `extensions/principles-disciple` 不被发现；重复 id 仅在多源同现时去重（`discovery.ts` dedupe：bundled retained / config 传播），因此**必须**断言：启动后已加载插件清单含候选且**不含**生产安装路径 | 加载后断言（执行时步骤 E2） |
| 隔离 workspace | `OPENCLAW_HOME` 下新建 workspace 目录；最小 config.yaml：`features.prompt.enabled=true` + `plugins.entries.principles-disciple.hooks.allowConversationAccess=true` + `plugins.load.paths=[候选目录]` | — |
| 环境隔离（全量覆盖清单） | `OPENCLAW_HOME`、`PD_WORKSPACE_DIR`、`OPENCLAW_WORKSPACE`、`OPENCLAW_WORKSPACE_DIR`、`PD_STATE_DIR`、`OPENCLAW_STATE_DIR`、`OPENCLAW_CONFIG_PATH`、`OPENCLAW_PROFILE`、`OPENCLAW_DEV_SOURCE_ROOT`、`OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS`：全部显式指向隔离路径或 unset（不许继承生产值） | resolver/config 源码核实 |
| provider 密钥 | 假 provider 不需要密钥；**不继承**真实 provider 密钥（env 清单外显式 unset `ZAI_API_KEY` 等），防外发 | §4 |

## 3. 本地假 provider（固定，127.0.0.1）

| 项 | 值 |
|---|---|
| 端点 | `http://127.0.0.1:<固定端口>/v1`（隔离配置 `models.providers` 声明，host 本地回环） |
| API/协议 | R1=`openai-responses`（`POST /v1/responses`，SSE 终止响应）；R2=`openai-completions`（`POST /v1/chat/completions`，SSE `[DONE]`） |
| 模型标识 | `isolated-presence-model`（两协议同名固定 id） |
| 凭证 | 假凭证 `isolated-test-key`（配置内显式写入，非环境继承；不继承真实 provider 密钥） |
| 响应 | 固定终止 chunk：R1 responses SSE `response.completed`；R2 completions SSE `[DONE]`（复用 #2407 线已验证的 SSE 形状） |
| 转发 | 无——假 provider 不向上游转发任何请求（离线已验证形状） |

## 4. 两个回合（responses + completions 各一）

| 回合 | API | 输入（冻结样本 A1 原文） | 期望观察 | 不应出现 |
|---|---|---|---|---|
| R1 | `openai-responses` | A1.text（correction 样本） | presence 事件：binding=unique、full_hit（夹具 activationId）、reason 缺省 | binding=ambiguous/none；empty_snapshot |
| R2 | `openai-completions` | 同 A1.text | 同上（egress=completions） | 同上 |

（夹具 activationId/原则正文见 §2b 原则夹具；A1.text 为冻结样本原文，仅作为用户输入，与夹具原则正文不同。）

## 5. 四个独立预算（任一触达即停，不自动重试）

| 预算 | 上限 |
|---|---|
| 宿主启动 | 2 次尝试（启动失败即记账失败、停止） |
| provider HTTP | 2（每回合 1 次；失败即记账停止） |
| 工具调用 | 0 |
| 付费调用 | 0（假 provider 本地回环，零外发零付费；不继承真实 provider 密钥） |

**失败即停**：R1 失败不执行 R2。无自动重试（宿主内部对瞬时错误的单次重试属宿主行为，记账不掩蔽）。宿主启动失败也计入启动预算（2 次含失败）。

## 5a. 原则夹具（真实治理入口，非伪造授权）

通过 PD 正式存储 API 在隔离 workspace 的 `.pd/state.db` 准备（与既有测试同一入口，`@principles/core/runtime`）：

| 步骤 | API | 内容 |
|---|---|---|
| F1 | `SqlitePIArtifactStore`（insert pi_artifacts 行） | artifactId=`art-presence-fixture`，principleId=`presence-fixture`，text=固定夹具正文（含 XML 特殊字符，验证单次转义），validation_status=validated |
| F2 | `SqliteActivationStateStore.recordActivation` | activationId=`act_prompt_presence-fixture`，channel=prompt，action=prompt_activate |
| F3 | approvals 授权行 | 按 HostRuntime 授权联表要求写入（authority=owner 路径），或运行卡内明确该隔离 workspace 的授权来源 |

冻结事实（写入运行卡，执行后核对）：
- 原则正文：`PRI-1150 隔离验证夹具：交付前必须核对 <presence> 标记与 & 符号。`（含 `<` `>` `&` 验证单次转义）
- 正文 sha256：执行时计算并记录
- artifactId=`art-presence-fixture`；activationId=`act_prompt_presence-fixture`；revision：该层不可得 → unknown

**离线已验证**：夹具 → shared 装配（host-runtime 冻结同源）→ 最终快照 → 正式 handler → presence 事件（`runtime-prompt-activation.test.ts` PRI-1150 端到端用例）；期望正文与实际渲染形式（转义后 directive 切片）一致由断言保证。

**不复制生产数据库、不伪造生产授权**：夹具只存在于隔离 workspace 的自有 DB。

## 5b. 超时与停止条件

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
