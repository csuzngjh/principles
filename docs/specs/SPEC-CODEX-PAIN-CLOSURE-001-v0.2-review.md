# SPEC-CODEX-PAIN-CLOSURE-001 v0.2 — 独立复核与自评

日期：2026-10-14；源码基线 `b0f807b95d8c86e88fe46b7f2a63eec1923af24a`。

结论：**v0.1 不足以保证自动处理闭环。v0.2 已将发现的入口、续接和活性缺口纳入必修与验收，但尚未实施或通过真实宿主验收，不能宣称当前运行问题已解决。**

范围：主代理核对现有源码、已安装只读状态与数据库；两个 Luna 子代理分别调查后台续接及实际入口，再复核修订。仅修改 SPEC 和本文；没有执行任务、推进候选、修改配置、安装更新或批准/激活。

## 发现及修订

| 编号 | 级别 | v0.1 缺口 / 当前实现证据 | v0.2 的必修及验收 |
| --- | --- | --- | --- |
| R01 | P1 | 诊断先 committed/succeeded，后执行收编；worker只选pending/retry_wait，succeeded路径返回结果而非恢复后处理 | §9.1真实worker续接；A09逐断点中断及重启，不重复诊断LLM |
| R02 | P1 | intake异常仅telemetry/continue；seed异常后候选仍可能consumed，没有任务可供下游消费 | §9.1扫描pending与consumed orphan；A18临时故障后自动到审阅，不能用手动backfill补考 |
| R03 | P1 | 只定义--owner-statement参数，未定义实际Codex触发、宿主lineage和安装交付 | §6.4明确当前用户消息前缀→UserPromptSubmit Hook→真实共享入队；A03/A17已安装入口及幂等 |
| R04 | P2 | --status ready只看注册/配置，不证明Companion已spawn且正在消费；周期stdout未被Companion读取 | §9.3 readiness/liveness分离，真实周期、阶段deadline和重启预算；A20/A22 |
| R05 | P1 | 重评单字段可能覆盖旧准入；与历史恢复保留处置要求矛盾 | §7.1单一candidate-store内不可变evaluations历史/当前指针/独立processing；A15 |
| R06 | P2 | 固定小预算不等于公平，持续pending可饿死到期retry/续接；无限错误返回可能一直pending | §9.1每eligible类别最多3完整周期获得机会；§9.2有限尝试与确定坏材料终态；A19/A21 |
| R07 | P1（验收漏洞） | 正常正向样例允许到blocked也算通过，可能只改善显示却依然不能工作 | §2与§11正向必须到真实审阅入口；A03/A11/A18及发布硬条件 |

相关生产定位：

- `packages/principles-core/src/runtime-v2/internalization/diag-router-runner.ts:366-377`：诊断提交/成功。
- `packages/codex-adapter/src/worker/workspace-worker.ts:117-127`：诊断候选选择。
- `packages/principles-core/src/runtime-v2/pain-signal-bridge.ts:738-740,785-791,859-871,980-992`：成功读取、后处理、intake/seed异常。
- `packages/pd-cli/src/commands/codex-worker.ts:34-80`：只读状态计算。
- `packages/pd-companion/src/main/main.ts:270-308`：manifest筛选及worker启动、stdout处理。
- `packages/pd-companion/src/lib/workspace-workers.ts:143-159`：重启预算及degraded。
- `packages/codex-adapter/src/codec/input-decoder.ts:63-91`：当前Hook身份与prompt字段。
- `packages/codex-adapter/src/ingestion/ingestion.ts:267-278`：当前transcript_path校验得到rollout identity，不得猜或扫描最近文件。

## 对子代理意见的再核对

一份复核意见称submitPainSignal不存在。主代理重新搜索确认该方法确实存在于 `PainSignalBridge`，`PainToPrincipleService` 异步分支也调用它，因此不采纳“方法不存在”的结论。SPEC改写为完整真实调用链，并强调尚缺Hook入口连接，不把已存在方法视为功能已经接通。

登记和task位于不同数据库；修订明确复用现有唯一观察键登记与ensure/reconcile，不假设跨库原子事务。即使任一写入点中断也须完成可重放续接，否则入口仍可能丢失。

## 本次实际执行的只读检查

- `pd codex worker --status --workspace <Codex治理工作区> --json` 返回 `mode=ready, registeredInInstallManifest=true`。命令不执行worker周期；此结果**不是活性或成功流证明**。
- SQLite `mode=ro` 查询：原问题诊断任务仍 succeeded；当前查询未发现pending/retry_wait/leased任务。没有待执行任务不等于无未完成候选，不能替代后处理审计。
- 文档结构检查及SPEC条款/验收编号完整性检查通过；检查仅覆盖文档交付，非实现正确性。

## 自评与发布判断

1. **问题覆盖：有条件通过。** 入口、输入依据、完整准入、后处理、真实worker、重启、有限重试、历史恢复、审阅边界均有明确要求。
2. **可实施性：保留硬门。** 当前宿主Hook样本、结果格式、支持渠道和存储迁移须在实现前验证；不借本SPEC扩展整段对话授权，不引入新后台调度器。
3. **验收力度：提高。** 正向到真实审阅、原型/模块测试与真实安装分层、逐故障点重启、跨入口重复提交、持续backlog公平性均是硬条件。
4. **运行成功：Not Run。** 没有执行新入口、故障注入或新worker续接，因为它们尚未实现。当前结论仅为修订后的设计和验收要求，不是“保证永不失败”。

发布完整修复结论必须通过SPEC列出的真实安装验收，并记录pain/candidate/run/admission/task/review关联及时间。永久外部故障、机器关机或Owner暂停不能保证自动成功，但不能被无限pending或假进度掩盖。

未完成时报告PARTIAL及具体缺项；不得以“所有阻碍都能显示”代替正常反馈实际处理成功。
