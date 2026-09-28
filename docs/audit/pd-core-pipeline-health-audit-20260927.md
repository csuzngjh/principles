# PD 核心数据管道健康审计 — 2026-09-27

> 多代理审计（Main Agent + 6 Subagents：A 静态 / B 运行时 / C 宿主边界 / D 实验 / E 测试缺口 / F 挑战者）。
> 只读审计：零代码修改、零提交。全部 finding 经主代理统一编号（AUD-XXX）、去重、交叉验证、挑战者复核后定级。
> 证据可复验：DB 快照 `D:/pd-labs/_audit-20260927/`（state-D.db / trajectory-D.db 等，sqlite3 .backup 于 09-27 ~23:13 本地）；
> 实验脚本与数据 `D:/pd-labs/_audit-20260927-experiments/`（node_modules 为指向仓库的 junction，仅供复验，勿递归删除）。
> 注意：活动生产工作区是 `D:\.openclaw\workspace`（B 的范围纠正；C 盘 `~/.openclaw/workspace` 已于 09-18 废弃）。

> **后续状态（2026-09-28 补记）**：本报告的 P1-latent 项 AUD-018 已处置——生产配置已改为绝对路径，
> 防复发代码见 PR #1882（Linear PRI-933，父任务 PRI-931）。P1 项 AUD-006 仍开放，
> 已在 PRI-932 进入 SPEC 阶段。本报告正文保持 09-27 审计当时的结论，未因后续修复而改写。

---

## 0. 结论速览（Owner 摘要）

系统核心管道整体**结构可靠**：14 项宿主契约 VERIFIED、诊断提交器单事务幂等、激活单权威（Owner 审批是唯一入口）、RuleHost 门语义按声明工作、运行时引用完整性 0 孤儿。

本轮发现 **2 个 P1、~10 个 P2**，没有 P0：

1. **P1 · 激活/停用生命周期史已无可信权威**（AUD-006+010+027）：再次激活会物理覆盖 `activations` 行（INSERT OR REPLACE），原始激活时间与停用记录从状态库消失；唯一兜底（events JSONL）仅保留 7 天并已自动清理过审计所需证据。生产实锤：`act_prompt_结论必须…` 的 09-22 停用记录只剩 JSONL 一条、~09-29 也会被删。
2. **P1(潜伏) · 生产配置里的损坏工作区指针**（AUD-018）：`~/.openclaw/principles-disciple.json` 的 `"workspace": "D:.openclawworkspace"`（反斜杠被吞，安装器 09-27 12:48Z 写入）。解析器静默接受且结果依赖进程 CWD。今天没有分裂的唯一原因是用户级环境变量 `PD_WORKSPACE_DIR` 优先级更高；该变量一旦丢失（新用户上下文/服务账户/清理），所有 hook 立即翻转到错误库，无任何告警。安装器已在 `D:\.openclawworkspace` 建出平行空治理树。

另有重要运维事实：**zai-flash LLM 周配额 09-26 11:30Z 起 429 耗尽**（09-28 10:03Z 重置），观察器连续失败 262 次、Stage2 分类停止——这是当天"管道安静"的直接原因，不是管道缺陷。

被推翻/重定性的假设（诚实记录）：`AUD-009 管道停止` = 按设计的三拒 + 配额停电；`AUD-010 因果序破坏` = AUD-006 的症状而非提前注入；`AUD-018 安装器更新链风险` = 不成立；`AUD-001 重复提交` = 机制在但生产零发生。

---

## 1. Canonical Pipeline（验证后）

```
Host(OpenClaw plugin 8 hooks VERIFIED / Codex adapter 0.147 契约 VERIFIED, 装机 0.157)
→ pain/evidence ingress (llm_output 同步 handler / after_tool_call)
→ 三层 triage (keyword→Stage2 LLM 确认→GFI)  ← llm_paralysis 按设计 evidence_only(canUpgrade=false)
→ trajectory.db pain_events (canonical_pain_id UNIQUE 实证有效)
→ Diagnostician split pipeline (router/rootcause/distiller; 父任务 60min 预算)
→ diagnostician-committer (单事务: artifact+commits+principle_candidates, 幂等)
→ pain-signal-bridge.onDiagnosisComplete → intake → dreamer seed
→ consumer cycle (companion/auto-consumer 并发, lease_conflict 收敛)：
   dreamer→philosopher→scribe→artificer(L1/L2)→evaluator→rollout_reviewer
   (orchestrator 确定性后继、epoch 守卫、durable-cursor 对账——A 验证可靠)
→ Owner decision (console approve 两阶段) → ActivationDispatcher
→ activations 表(单权威) → 三通道(prompt 注入 / RuleHost gate / defer_archive)
→ observer / governance projection → Owner 观察面
```

## 2. 最终 Finding Registry（挑战后定级）

路线列依审计协议 Route A(静态+运行时)/B(静态+复现)/C(运行时+复现+根因)/D(确定性代码缺陷)。

### P1

| ID | 内容 | 关键证据 | 路线 | 置信 |
|---|---|---|---|---|
| **AUD-006**(+010,+027) | 激活/停用生命周期史无权威所有者：`recordActivation` INSERT OR REPLACE 按 idempotency_key(`makeIdIdempotencyKey(artifactId,channel)`) 物理覆盖旧行（原始 activated_at 与 deactivated_at 消失）；`activation_decisions` 只记 3 条例外决策；events JSONL 是唯一兜底但 `EVENT_LOG_RETENTION_DAYS=7` 主动清理（已毁 09-19/20 审计证据，09-22 停用记录 ~09-29 也会消失）。违反 P4（durable fact 单权威）。 | sqlite-activation-state-store.ts:85-93、activation-dispatcher.ts:227、event-log.ts:39,93-107；实况签名：15 条 prompt_injected applications 早于 activated_at 50-77h（即 AUD-010，已解释）；E2 真实代码复现（T1→deactivate→T3 重激 → rowid 置换、T1/T2 消失）；F 复核强化 | A+B+C | 高 |

### P1（潜伏）

| ID | 内容 | 关键证据 | 路线 | 置信 |
|---|---|---|---|---|
| **AUD-018** | 损坏工作区指针在生产配置中：安装器 2026-09-27T12:48:47Z 把 `"D:.openclawworkspace"`（反斜杠丢失）写入 `~/.openclaw/principles-disciple.json`；`validateWorkspaceDir` 只拒 home/root/drive-root，静默接受；`path.resolve` 结果依赖 CWD。当前无分裂**唯一**原因是用户级 `PD_WORKSPACE_DIR=D:\.openclaw\workspace` 在 `resolveExplicitPdSources` 中优先于 pd_config（workspace-resolver.ts:233-259）；hook 每次调用重读配置——环境变量丢失即瞬时静默翻转。安装器已建平行空树 `D:\.openclawworkspace\.pd\`（0 行）。gateway 重启本身安全（用户环境继承）。安装器更新链不迭代 workspaces 列表（F1c 不成立）。 | installer.ts:3136-3142（原样写入）、workspace-dir-validation.ts:16-52、workspace-resolver.ts:168-199,233-333；E1 真实代码沙箱复现接受行为；F 修正护盾归因（env var，非 ctx.workspaceDir）；生产写入持续到 09-27T14:42Z+ 证明未翻转 | A+B | 高 |

### P2

| ID | 内容 | 证据 | 路线 |
|---|---|---|---|
| AUD-001 | 僵尸租约窗口：父任务 5min 默认租约 vs 60min split 预算，`renewLease` 零生产调用者；过期→sweep 翻 retry_wait→二次租约成功。**挑战者发现分层围栏**（stage C 子任务独立 5min 租约+成功短路+pi_artifacts UNIQUE(source_task_id,kind) upsert）；生产 stage C 最长 3.3min<5min，零双提交。机制成立、未发生。实际物化伤害=AUD-028 | lease-manager.ts:123,226、pain-signal-runtime-factory.ts:92、recovery-sweep.ts:111-120；E3 真实 store/sweep/committer 复现双提交；F 校正 | B（弱化） |
| AUD-028 | manual 诊断任务永久 retry_wait 悬置：3 个 `diagnosis_manual_*`（09-21 起）lease_expired 后 sweep 翻转，但无消费者再驱动 manual 任务；run_1 永远 execution_status='running' | state-D.db 实况 + F 定位 | C |
| AUD-005 | console approve 两阶段非原子：审批提交与激活派发分事务，crash 窗口留 approved-无-activation，仅手动 reopen；拒绝回滚 best-effort 吞 catch。静态代码窗口，运行时 0 发生 | ApprovalsConsoleModel.ts:137-168,393-533；B 验证 0 行 approved-无-activation | 静态（结构性风险） |
| AUD-012 | 三本 pain 账不一致：principle_events pain_detected 101(91 distinct, 止于 09-01) vs pain_recorded 66(止于 09-22) vs pain_events 70(止于 09-25)；10 个 painId 双 detected；167 行 principle_id 全 NULL | trajectory-D.db 聚合 | A(静态隐含) |
| AUD-013 | 41/70 pains 未诊断（其中 13 个 llm_paralysis 属按设计 evidence-only，余 28 未解释）+1 孤儿诊断（`diagnosis_manual_1789918356795_se6850ch` 无对应 pain_event——manual 通道 producer/consumer 失配） | DB 聚合 + source-descriptors.ts:113-119 | A |
| AUD-014 | 44 卡死任务（39 pending，31 个>7天，最老 09-01 26 天；多为 artificer-repair 链 attempt_count=0）+2 陈旧租约 | state-D.db | A |
| AUD-015 | PRI-876 stall-cleanup(09-20) 删除 ~90 失败/卡滞任务行，live 库不可证（仅 .bak-20260920 可证）；失败史未保留 | 备份对比 143/22/3/31 → 72/4/1/39 | A |
| AUD-017 | 安装/更新链：70 事务 22 失败 7 回滚；EPERM rename extensions 目录 ×14 持续至 09-27 12:37Z（12:41Z 更新仍成功，gen33/2.2.0） | ~/.pd/transactions/ 全解析 | A |
| AUD-019 | 双通道 core 版本斜差：codex 市场通道 pin 1.284.13/adapter 0.4.3 vs canonical 1.287.6，两通道可写同一工作区库 | ~/.codex/plugins/.../runtime-version.json vs ~/.pd/runtime | A |
| AUD-020 | approve→activation_control_states('eligible')→gate 是静默 fail-open 支点：控制行缺失/损坏→规则静默停执（仅 warn+skip 列表）；无三段 join 测试 | sqlite-activation-state-store.ts:94-100、rule-host.ts:365-445（转写）；E4 部分复现 | B(部分) |
| AUD-021 | activation store 回归测试钉在 mockDb（SQL 从未执行）——恰是 AUD-006 家族最需要真实 SQL 的地方 | sqlite-activation-state-store.test.ts:9-33 | 静态 |
| AUD-022 | 两调度器 exactly-once 声明无 cycle 级并发测试（仅 store 级） | internalization-consumer-cycle.ts:15-18；E 测试审计 | 静态 |
| AUD-024 | 6 个 runner 中 5 个（philosopher/scribe/artificer/evaluator/rollout_reviewer）的 vslice 测试全 mock SM+Memory store，真 SQLite 只覆盖 dreamer | E 测试审计（test-double-runtime-adapter 已具备但未用于兄弟） | 静态 |
| AUD-004 | task 状态机纯约定：`updateTask` 无转移守卫；bridge re-trigger 可把 failed/needs_human_review 重置 pending+attemptCount=0（当前唯一到达路径是 `pd pain retry` 属合法，但无调用方区分） | sqlite-task-store.ts:100-126、pain-signal-bridge.ts:525-551 | 静态 |

### P3（择要）

- AUD-002/003（bridge intake 在 try 外 / seed 失败仍 consumed）：代码确认、生产零发生（16 个 pending 全部来自 `pd diagnose` CLI 路径且当时已非零退出报告；79 个 bridge 产出候选全 consumed；16 个 consumed-无-dreamer 全是 implementation 类=MVP 通道外，按设计）。防御性修复级。
- AUD-007（已决审批 re-enqueue 报 queued 假成功，边缘路径）、AUD-008（dead-letter 复合失败仅剩日志，dead_letter_pains=0）、AUD-010（已并入 AUD-006）、AUD-011（10 无审批 activation：9 个先于 09-19T01:44Z 门合并、1 个不可判（日志已被 7 天保留清掉）→ 历史）、AUD-016（artificer 65/72 max_attempts_exceeded=已知 LLM 代码生成弱环）、AUD-023（三处手抄 trajectory DDL 无列 parity 守卫）、AUD-025（vitest 沙箱污染 ~/.pd/enforcement-health ×81 + install.json workspaces 含 vitest 路径）、AUD-026（llm_output 同步 handler 使 10s timeoutMs 无法抢占同步 SQLite 写）、AUD-029（Stage2 discovery 模式对零命中消息也 needsLlmConfirmation——每条用户消息都烧配额，是 429 的放大器）、F5 残余（配额停电无主动告警、被丢分类无重放工具；但丢弃主体是 discovery 流量而非纠正信号，原始 user_turns 保留）。

### 被推翻/重定性（协议要求的诚实闭环）

| 原假设 | 结局 |
|---|---|
| AUD-009「09-22 后任务创建停止=管道缺陷」 | **推翻**。根因链：09-22 13:11 最后一条确认纠正（链 13:11-13:22 全成功）→ 09-24/25 的 13 个 llm_paralysis 属 evidence_only(by design) → 09-26 11:30Z zai 429 配额尽 → 09-27 43 个 Stage2 候选被丢（多为 discovery 流量）。消费者活着（当日 CONSUMER_STARTED×7/SKIP×394）。真缺陷=F5 残余告警缺口(P3) |
| AUD-010「applications 早于激活=因果破坏/提前注入」 | **解释闭环**：AUD-006 的 REPLACE 抹史所致，无提前注入、无假激活 |
| AUD-018 附带「安装器更新链会写错树」「gateway 重启致翻转」 | 前者**推翻**(F1c)；后者**归因修正**(护盾是 env var；重启本身安全) |
| AUD-001「生产可能已双提交」 | **弱化**：分层围栏+3.3min 最长 stage C+零重复对；伤害改记 AUD-028 |
| F6(a)「16 pending=bridge intake 悬浅」 | **推翻**：全部来自 pd diagnose CLI 路径（创建时已报错） |

## 3. 已验证可靠面（跨源一致）

- 宿主边界：8 hooks 注册/语义、prepend 真达模型、void-hook 错误不破回合、Codex 0.147 契约字段、pi-ai completeSimple/runAgentLoop 7 参签名——全部 VERIFIED（C）。
- diagnostician-committer 单事务+幂等恢复；recovery-sweep TOCTOU 安全幂等；orchestrator 确定性后继+epoch 守卫+durable-cursor 对账（A）。
- 激活单权威：三 ChannelWriter activate() 纯函数、activations 表唯一写权威、RuleHost shadow→promote BEGIN IMMEDIATE、LLM 建议永不自激活（PRI-811 Phase B 代码验证）。
- 运行时引用完整性：candidates/runs/artifacts/activations/approvals 0 孤儿、0 approved-无-activation、0 未来时间戳、canonical_pain_id 唯一索引有效（B）。
- 消费周期真路径测试三件套+崩溃注入+a2 积压重试；gate 内核真 vm 对抗测试（E positives）。

## 4. 证据不足/未覆盖段

- events JSONL ~10MB（09-20→09-27）只抽查未全解析；09-27 23:13 之后的新事件未含。
- OpenClaw 装机版 2026.9.6 vs 源码 2026.9.2 的 hook 常量逐字节等价（minified）未证。
- pi-ai 0.84.4 源码 vs 0.85.1 装机行为差未证；Codex 0.147→0.157 wire 逐字节等价未证（解码器 fail-loud 未见报错为间接证据）。
- 28 个未诊断 pains（非 evidence-only 类）的具体拒绝原因未逐一回放。
- C 盘废弃工作区 09-18 部分子系统停摆（user_turns/signal-health 停在 05:15、sessions 停在 12:13）未深挖——历史问题，建议归档不追。

## 5. 修复优先级建议（未实施，全部待 Owner 授权）

1. **AUD-018**（一行配置纠偏 + 一处校验）：重写 `~/.openclaw/principles-disciple.json` 的 workspace 为绝对路径 `D:\.openclaw\workspace`；代码侧在读取时拒绝非绝对路径（fail-loud）。低风险高杠杆。→ **已于 09-28 完成，见 PR #1882。**
2. **AUD-006**：激活生命周期史落权威——最小方案=activations 表停止 REPLACE（追加行+读侧取 latest），或把生命周期事件升格为 durable（延长/豁免该类事件 7 天保留）。涉及 schema 语义，需 SPEC。→ **已立单 PRI-932，SPEC 阶段。**
3. **AUD-028/AUD-014**：`pd pain retry` 批量修复 3 个 manual 悬置任务（现有 CLI 即可，人工触发）；artificer-repair 39 pending 需裁决清理或续跑。
4. **AUD-020/AUD-021/AUD-022/AUD-024**：四个测试缺口各补一个最小真路径回归（E 已给出最小方案）。
5. 运维：09-28 10:03Z 配额重置后观察 Stage2/observer 自愈；EPERM rename 安装缺陷立单跟踪。

## 6. 审计方法与预算

Wave 0 主代理侦察 → Wave 1（A/B/C/E 并行）→ Wave 2（D 隔离实验 4 项+根因 1 项）→ Wave 3（F 挑战 6 项）→ Wave 4 综合。
六代理全部只读；live DB 仅经 mode=ro/.backup 副本查询；实验全部落在 D:/pd-labs/ 隔离目录。
跨代理重复发现已合并（如 A1+B6→AUD-001；C-M1+B-A10→AUD-018；A7+B-A2→AUD-006/010）。
