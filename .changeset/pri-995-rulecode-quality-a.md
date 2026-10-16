---
'@principles/core': patch
'@principles/host-runtime': patch
---

SPEC-RULECODE-QUALITY-001 A（PRI-995）：RuleCode 可信生成与运行时保护。① 共享门禁对 requiresContextVersion:2 规则强制暂停——provider 缺席/返回 undefined/坏对象/抛异常/schema 合法 unavailable/整体超时时，跳过该 V2 规则（带故障种类警告，evaluatedLiveRules=0），不再把 truthy 不可用上下文当可执行；健康 V1 规则照常执行，shadow 不影响 live。② 新增 artificer 意图依据前置门（消费循环内、构造 runner 之前、零生成调用）：scribe 工件必须带 intentContract 与机器可读 executionConditions，声明的外部可信事实须经宿主 trustedFacts 口可解析；缺失/损坏/冲突映射到 needs_human_review 可审阅停点（intent_unverified/intent_conflict/trusted_fact_provider_absent 等稳定 reasonCode），runner 内置防御镜像杜绝直调绕过；通过时写入带版本与材料摘要的派生核查记录（证据而非通行证，每次重derive）。③ 源 I/O 瞬时故障与 Owner 缺样例分离：重启持久的 1-then-2 周期退避、连续 3 次进 source_fault_persistent 终态（非 Owner 标签）。④ 生成提示删除"最近似代理/params 前置条件当证据"指导（原自填批准产物根源），新增 INTENT EXECUTION CONDITIONS 块；scribe 契约 v8 增加 executionConditions 输出。⑤ 样例包校验新增同输入相反标签冲突检测；deadline 早退补 evaluatedLiveRules=0 观测。
