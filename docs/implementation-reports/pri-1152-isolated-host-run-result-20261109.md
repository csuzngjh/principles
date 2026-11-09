# PRI-1152 Path A 隔离宿主验证：运行结果（`pri1152-run-card-v3.1`，执行包 `pp-20261109T010443Z`）

- 文档 ID：`pri-1152-isolated-host-run-result-20261109`。
- **结论**：已批准的运行完成（`status: completed`）。R1（responses）和 R2（completions）两个回合的 14 项判定全部通过，预算用量为宿主启动 2 次、provider HTTP 2 次、工具调用 0 次、付费调用 0 次。
- **结论上限（运行卡 §1）**：本次只证明，在未修改的官方 OpenClaw 2026.11.1 上，候选 PD 的正式 `llm_input` 注册、shared 装配快照、关联裁决和自有 presence 事件端到端连通。D 仍为 `unknown`。不签收 G1/C04/G2。不证明请求送达、原则遵循或行为改善。

## 1. 批准与命令

| 项 | 值 |
|---|---|
| 批准 | Owner 书面批准（agent 于 2026-11-09T02:05:05Z 收到）：「批准执行 pri1152-run-card-v3.1，清单 SHA-256 为 0e2dc6e3…6c2c。仅限隔离 OpenClaw 和本地假 provider，最多 2 次宿主启动、2 次 provider HTTP 请求，工具调用和付费调用均为 0。失败即停，不自动重试。」批准记录副本见 Linear PRI-1152 评论 `10164b47` |
| 批准文件 | `PACK\approval.json`（sha256 `180ee6c785b51f8a60c91549a34761fe0d8588c020c9060c966be515fe83005c`），由空白模板生成，绑定字段未改。执行前已用启动器自身的 `validateApproval` 离线校验，违规 0 项 |
| 命令 | `node scripts/dev/aa-controlled-admission/presence-run.mjs --execute --pack <PACK> --approval <PACK>\approval.json`（只运行一次） |
| 时间 | 2026-11-09T02:07:44Z 到 02:09:11Z，退出码 0 |
| 执行前复核 | `run\verification-before-run.json`：READY，21/21。独立脚本比对检查集合，缺失、多余、重复均为 0。按卡 §6/§9，复核中的协议自测记入独立账本（`selftest-ledger-20261109T020750Z-cfda0b63.json`：5 次回环请求，宿主启动 0 次），不计入运行预算 |

## 2. 预算与停止

| 项 | 结果 |
|---|---|
| 账本（`run\budget-ledger.json`） | 已用 2/2/0/0，`withinBudget: true`，违规 0 项；每回合 1/1/0/0 |
| 拒绝 | 0 次（没有 `over_budget`、`tool_budget`、`off_protocol`） |
| 回合外请求 | 0 次 |
| 停止原因 | 无（`stoppedAt: null`）。R1 全部通过后才启动 R2 |
| 重试 | 无。宿主的 provider 重试已关闭（`maxRetries=0`），启动器也不重试 |

## 3. 每回合判定（14 项全部 PASS）

| 判定 | R1 | R2 |
|---|---|---|
| `host-exit` / `host-envelope` | exit 0，未超时；`final: PRESENCE-ACK`；sessionId `e156f9d6-4f85-4a94-9adf-2315d5ee0766` | exit 0；`PRESENCE-ACK`；sessionId `79054669-46aa-46ea-a9a3-f0b093a2cc40` |
| `log-evidence-complete` | 宿主日志增量 0 字节，没有截断、缩短或读取失败；事件日志增量 1902 B | 事件日志增量 1904 B |
| `candidate-registration-source` | `confirmed`：2 行，都来自宿主 stderr，都等于冻结候选根 | 同左 |
| `candidate-code-unchanged` | 候选代码文件仍是冻结字节 | 同左 |
| `endpoint-one-request` / `api-path` / `fake-key` / `model` | 1 次 served，0 次 refused；`POST /v1/responses`；携带冻结假 key；`isolated-presence-model` | 1 次；`POST /v1/chat/completions`；同左 |
| `presence-event` | 恰好 1 条；provider/model 一致；sessionId 等于宿主报告值；在窗口内（排除：其他会话 0 条，窗口外 0 条） | 同左 |
| `presence-boundary` / `binding` | `post_assembly_system_prompt_via_llm_input`；`unique`，`checked: true`，没有降级原因 | 同左 |
| `presence-fixture-full-hit` / `presence-no-body` | `full_hit`，`actualBodyChars: 278`（与冻结 directive 的字符数相同）；事件中没有正文 | 同左 |

## 4. 原「只能由真实运行给出」事项的实测结果

1. **注册来源出现在哪里**：只出现在宿主 **stderr**，每回合 2 行（宿主调用了两次 `register()`），两行都指向冻结候选根。冻结配置把宿主日志固定在 `PACK\logs\openclaw-host.log`，但在 `agent exec` 下这个文件始终没有生成。也就是说，卡中「宿主日志」这一来源没有派上用场，判定依据是 stderr。
2. **`llm_input` 派发与事件落盘**：每回合恰好 1 条 presence 事件，写入时间早于 provider 请求约 0.75 秒（R1：事件 02:08:30.092Z，请求 02:08:30.846Z；R2：事件 02:09:07.341Z，请求 02:09:08.080Z）。事件在宿主自然退出之前已经落盘，这与 B1 的即时写盘一致：退出前约 1.4 秒才记录事件，30 秒的缓冲定时器来不及触发。
3. **sessionId 一致性**：两个回合中，事件的 `sessionId` 和 `runId` 都等于宿主 `--json` 报告的 `sessionId`。
4. **请求形状与额外调用**：每回合 1 次 `POST`，`stream: true`，请求体 14608 B / 14674 B（只记录大小和 sha256，不保存正文）。没有标题生成、压缩等额外调用，回合外请求为 0。
5. **退出时序**：

   | 回合 | 宿主启动→provider 请求 | 响应→退出 | 结束方式 |
   |---|---|---|---|
   | R1 | 39.9 s | 0.69 s | 正常退出 |
   | R2 | 35.4 s | 0.66 s | 正常退出 |

   两个回合都没有超时，也没有被强制结束。
6. **`tools.deny=["*"]` 下实际暴露的工具面**：两次请求仍然带有 3 个工具定义：`dispatch_action`、`tool_describe`、`tool_search`。宿主 `--json` 的 `bridgeCalls` 为 search/describe/call = 0/0/0，`codeModeEngaged: false`，端点也没有看到工具活动。本次工具调用为 0。但「deny-all」并不意味着请求中没有工具定义。接入真实模型时，这 3 个工具是否会被调用、是否会被策略拒绝，本次**没有验证**。
7. **生产污染前后对照**：共 13 个目标，12 个 `unchanged`。另有 1 个活动库 `D:\.openclaw\workspace\.pd\state.db` 判为 `changed-independent-writer-possible`：没有运行标记，按规则不按哈希归因。汇总结论为 `unattributed-changes-noted`，不判为污染。静态安装文件和配置都没有变化。这些结果不能证明零写入（卡 §11）。

## 5. 其他观察（不影响判定）

- surface-guard 在真实宿主中列出的 core surfaces 包含 `hook:llm_input_presence`（B2 生效）；4 个非 core surface 被禁用。
- `[PD:health] mcp-binding unavailable (mcp_server_component_missing)`：MCP 按设计关闭，`pd-recall` 保持失败关闭，这是预期结果。
- PD 在包内工作区创建了 `PROFILE.json`、`.state\pain_settings.json`；CorrectionObserver 和 InternalizationAutoConsumer 按配置没有启动。
- 宿主打印了一条 Node 警告：`Plugin source capture cleanup: retained-by-loaded-module`，指向 `PACK\state\Rn\tmp\plugin-captures\…`，位于包内。
- stderr 中没有网络错误字样。这不能证明宿主没有其他外联，本次也没有在网络层监测。

## 6. 清理与证据

- 端点已关闭，事后确认端口拒绝连接；每回合清扫和最终清扫都没有残留进程。执行包和全部证据都已保留。
- 证据：`PACK\run\`（`run-record.json`、`budget-ledger.json`、`verification-before-run.json`、`approval-used.json`、`pollution-before.json`，以及 `evidence\R1.*`、`evidence\R2.*`）。
- 池外副本：`D:\Code\principles\artifacts\pri-1152-isolated-host-evidence\pp-20261109T010443Z\run-20261109T0207Z\`，共 29 个文件，`sha256sum -c` 29/29 OK；另有 2 个文件记在 `SHA256SUMS.addendum.json` 中。

## 7. 未证明与后续

- 未证明：请求正文中是否含有原则（不在本卡范围，卡 §7）；真实模型下的行为；G1/C04/G2。D 仍为 `unknown`。
- 工具面：`tools.deny=["*"]` 下仍有 3 个 bridge 工具定义。今后任何接入真实模型的运行卡，都必须单独处理这一点。
- 宿主日志通道：`agent exec` 没有写 `logging.file`，注册来源只能从 stderr 取得。判定逻辑已经同时覆盖 stderr，所以本次不受影响。
- 安全审计：Mimosa 在提交和推送时都是 `scanner_enobufs`，不作安全声明。
