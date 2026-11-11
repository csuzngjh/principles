---
'@principles/workbuddy-adapter': minor
'@principles/core': patch
'@principles/pd-cli': patch
'@principles/host-runtime': patch
'@principles/codex-adapter': patch
---

WorkBuddy 对话采集端到端接通（PRI-1171 P2 工单④–⑥，本 PR 同时包含编码/解码、Owner 原话投影与运行时接线）。新增 `ingestion/` 模块：`encodeWorkbuddyCwd`（按盘上取证样本锁定的目录编码契约）、确定性转录定位/校验（hint 优先 + `<projects>/<encodeCwd(cwd)>/<sessionId>.jsonl` 推导，含穿越/包含/主会话形状/会话身份一致性校验）、六记录类型宽容解码（message/function_call/function_call_result/reasoning/file-history-snapshot/ai-title，另容忍 session-meta/fork/未知类型——跳过全部计数告警，不静默）、callId 工具配对（配对缺失侧 partial）、reasoning parentId 链归属（失败=partial+unattributed，不猜）、压缩标记只告警不传墓碑、checkpoint 种子合成序数、50MB 单会话告警。host-runtime：`GovernanceObservationKind` 联合增 `reasoning`；工具调用与结果共用 `call:<callId>` logical key，跨窗口完成时可合并工具事实（不再产生两条永不修复的 partial）；写入事务改用 `BEGIN IMMEDIATE`，并容忍并发 hook 争抢 journal_mode 切换。变体基线固化 fixtures + 契约/集成/E2E 测试。

真实载荷保护（PR #2534 评审批次 A P0 修复）：WorkBuddy 的 `message/user` 记录在真实盘上是约 15KB 宿主 `<system-reminder>` 上下文 + 尾部 `<user_query>` 中的 Owner 原话。解码器改为 **fail-closed**：只从 `<user_query>` 结构化边界投影 Owner 原话，并过滤落在 `<system-reminder>` 区间内的伪造标签；无法确认边界时落 `partial` + `wb_user_context_unconfirmed` 告警且不写 `visibleText`——绝不把 AGENTS/身份文件/工具说明当 Owner 证据入库，也不存在"换个标签就整段放行"的 fail-open 通道。新增标签变体、上下文内伪造 `<user_query>`、纯上下文、未闭合等回归；裸明文被显式测试钉为 partial（契约变更，见测试内注释）。

工单⑤⑥接线：新增 `workbuddy_conversation_ingestion`（quiet，默认关）与 lifecycle census 条目；`pd workbuddy setup` 是该开关 + v3 同意记录的**受支持入口**（约定，非强制边界：consent API 公开导出、ledger/config 均为普通文件）。`--accept` 在执行前展示披露（`--json` 时写 stderr 以保持 cli-1 严格 JSON）；先开 flag、成功后写 granted，失败时用**写入前捕获的原始字节**经 tmp+rename **原子回滚**（undo 路径同样原子）。运行时**真实读取** v3 consent ledger（Codex 路径仍硬编码 granted），撤销即时生效。WorkBuddy 插件注册 `Stop`（30s）→ decoder 映射 `turn_complete`（Stop 无 cwd，不伪造）→ `ingestWorkbuddyConversation` 把 snake_case `transcript_path` / `agent_transcript_path` 桥接到 `HookHints`；Stop 解码接受二者至少其一（官方 hooks reference 只列 `transcript_path`，仓库 capability matrix 写 `agent_transcript_path`，两者冲突且**尚无真实 Stop payload 取证（NOT_RUN）**，因此在拿到真实载荷前接受并集）。worker 增加按 durable checkpoint 精确 sessionId 定位的有界 catch-up，并打印 catch-up 行；reconcile 的 promotion recovery 参数按宿主绑定为 `codexConversationIngestionEnabled`，WorkBuddy worker 固定传 `false`——WorkBuddy 的同意绝不释放 Codex 证据。三层门（host.workbuddy + ingestion flag + consent=granted）任一关闭均零转录读取。

真实回滚面：本 PR 不是"单 PR revert 即恢复原状"。仓库代码回退后，已安装插件清单里的 `Stop` 注册仍会存在，直到用户更新/卸载插件；workspace 中已写入的 `workbuddy_conversation_ingestion` flag 与 consent ledger 也是持久事实（回退后无读取方，属安全残留）。运行期关闭应按顺序使用 `pd workbuddy setup --decline`（撤销同意 + 关 flag）；恢复默认态需同时更新已安装插件。
