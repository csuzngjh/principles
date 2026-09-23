# PD Counterfactual Reasoning Audit

> 只读调查。未修改生产代码/schema/配置/flag；未创建 PR/Linear 工单。唯一产物：本文档。
> 基线：main @ e5e2b16b（2026-09-22）。证据：生产代码+prompt+schema/validator+runner+真实 artifact（pri-815-quality-first/data/runs 18组）+PRI-865/866。

## Executive Summary

**一句话：PD currently generates alternatives, not counterfactuals.**

- 全仓 `counterfactual` 仅命中 PRI-865/866 两处讨论（post-MVP 候选），零生产代码命中。无 `do(X)/intervention/heldConstant/preventedPain/counterfactualOutcome` 字段、指令、校验、接线、测试。
- 最接近的两个机制：(1) Diagnostician 5-Whys causalChain（回溯因果解释）；(2) Evaluator boundary/omission/inversion 对抗重放（对 Rule 的变异测试，非对历史行为的反事实模拟）。
- Dreamer 自定位就是 alternative candidates（dreamer-prompt-builder.ts:80），输出 badDecision/betterDecision/rationale/confidence/riskLevel/strategicPerspective——满足 Alternative Generation，不满足 Counterfactual Reasoning（无 same-world+different-action+different-outcome），更不满足 Evaluation。
- 是否值得增强：值得作为 Level 1 假设层进 post-MVP 路线，不是当前 MVP 缺口。PRI-865/866 已证最大缺口是激活后行为结果度量（effect activation_id 全NULL、task_outcomes=0）。

## 1. Capability Matrix

| 模块 | 反事实 | 强度 | 证据 |
|---|---|---|---|
| Diagnostician | 因果解释有，反事实无 | Partial(causal)/None(cf) | diag-rootcause-output.ts:42-46 CausalChainEntry{why,statement,evidenceRefs}；rootcause-prompt-builder.ts:273-282 PHASE2 5-Whys（Why1现象→Why5系统缺陷）；无 do/intervention/what-if 指令；回答"为什么发生" |
| Dreamer | Alternative Generator | None(cf)/Strong(alt) | buildDreamerProtocolInstruction (dreamer-prompt-builder.ts:80-87): "generate alternative decision candidates…should have been done instead"；schema dreamer-output.ts:23-38 六字段，无 counterfactualOutcome/intervention/heldConstant/causalEffect/preventedPain/residualRisk；validator 仅验个数/非空/区间 |
| Philosopher | 无反事实利用 | None | 输入仅 dreamerArtifact 全文+sourceDreamerArtifactId；输出 thesis/principleCandidate{title,rationale,scope,confidence}/risks；指令是 synthesize 成 single thesis；rationale 是总结性理由，非因果链切断证明 |
| Scribe | lineage 有，反事实链无 | None | 输出 principleDraft{statement,applicability,antiPatterns,confidence}+intentContract+sourceTrace；PRI-838 formationContext 恢复 proposals+diagnosis+provenance 三块但只是原样投影，无新增因果语义 |
| Evaluator | 变异测试≈反事实风味，但对象是 Rule | Partial | evaluator-output.ts:7-12 AdversarialAttackType=boundary/omission/inversion；沙箱确定性重放；语义是"换输入规则仍对吗"，不是"同世界换动作 Pain 消失吗"；shadow 只测触发不测复现（PRI-865） |
| Repair Loop | 迭代收敛环 | None(cf) | evaluator-prompt-builder.ts:88-136 deriveRequirementLedger+previousEvaluation+PRI-630 收敛契约（validator :580-632 硬校验 verbatim echo）；回答"上轮要求修好没"，不回答"重选动作结果改善没"；无跨世界比较 |

Q1: Diagnostician 回答"为什么发生"，5-Whys 每个 Why 只要求 evidenceRefs>=1，无"固定 Context 只换 Action"思想实验。Q2: 不存在 do(X)/intervention/counterfactual outcome；全仓 intervention 仅命中 T-06 中文"干预方式"散文，无算子语义。
Dreamer Classification: Alternative Generator。关键词取证：生产 prompt 中 what-if/simulation/scenario/hypothesis/ablation/negative-control 零命中；instead 仅一次修辞性 should-have-been-done-instead。

## 2. Current Architecture

Pain(pain_events) -> Diagnostician(A:5-Whys causalChain/B:abstractedPrinciple/C:recommendation)[因果回溯] -> Dreamer(1-5x bad->better+rationale)[alternative] -> Philosopher(multi->single thesis)[抽象总结，多转单、被否候选不落盘DC-2] -> Scribe(+formationContext:proposals+diagnosis+provenance PRI-838)[lineage恢复、无因果语义] -> Artificer(RuleCode+goldenTraceCases) -> Evaluator(boundary/omission/inversion沙箱重放+requirementLedger收敛)[测Rule非测历史世界] -> Owner决策 -> Activation(shadow/live) -> receipts(presence 737/effect 70; effect.activation_id全NULL、task_outcomes=0故无before/after)。

Pearl对照：无do(X)思想。5-Whys问"为什么X发生"，Dreamer问"什么是更好的Y"，Evaluator问"规则在变异输入下成立吗"——都不问"同世界do(A->B)后P是否消失"。

## 3. Real Examples（5组，runs/目录）

系统性结论：5组dreamer输出全是 bad->better+rationale结构，0组含"若执行B则P减少/消失（C不变）"显式反事实陈述，无held-constant声明、无outcome验证。

Case1 G-pain_host_cffdcb9f5d0257（视频迭代漂移）: bad="认可mooncake-mv-final-v3k22.mp4后未固化基线、主观叠加优化"；better="固化不可变基线（副本+哈希+路径），后续以此为锚"；rationale="认可版本是最强意图信号"；CF陈述:无。见 runs/G-pain_host_cffdcb9f5d0257.json:18-27。

Case2 G-manual_1788417947835_e99（PS中文乱码）: bad="未探测5.1 vs pwsh7直接执行无BOM脚本"；better="先$PSVersionTable预检再选编码"；rationale="5.1无BOM按ANSI解析是确定性行为"；最接近因果断言但仍是领域知识陈述，非同世界反事实推断；5候选无"谁切断因果链"比较。见同名文件:18-27。

Case3 G-manual_1788424714466_wmn（Gate B人工门）: bad="毕业验证纯人工、无可执行门禁"；better="每步编码为结构化pass/fail规则检查"；未答"若当时有自动门本次遗漏是否必被拦"。见同名文件:18-27；scribe intentContract.evidenceSource只是诊断引文。

Case4 G-manual_1788526359876_r5x（90.8%误诊）: 单统计量断言预算截断，与实测5686/9000矛盾，阻塞证据被静默跳过并污染PRI-646工单；scribe落点"Gate causal conclusions on event evidence"正确但只给正向规则，未构造"同证据集+换gate检查→工单不产生"反事实。见该文件:183-186。

Case5 G-pain_host_85731899e27e6d+G-manual_1788609453041_dtm（同构对照）: "执行即成功、无证据验收"家族，与前例逐字同构；5/5一致缺失证明是schema/prompt系统性缺口，非单次LLM失误。

## 4. Gap Analysis

1.No intervention变量（schema无{changedVar,from,to}；prompt未要求只换A->B）。2.No held-constant假设（无heldConstant[]，分不清因果与相关）。3.No counterfactual confidence（现有confidence是"方案好"的置信，非"P(B)<P(A)"置信）。4.No outcome验证（Evaluator测规则/shadow测触发/repair测收敛；outcome空、effect未连、无复犯签名，PRI-866）。5.No 竞争解释排除（Philosopher risks[]是散文风险）。6.No negative control（除变异用例无"换相似变量结果不变→归因可疑"对照）。

## 5. Strategic Evaluation

值得作为post-MVP Level1，不值得作当前MVP缺口。价值：缓解Philosopher单thesis压缩点误归因放大（PRI-843 D-2）、把People-vs-Design从证据充分性提至因果必要性、复用PRI-815"信息连接+85.7pp"经验。风险：反事实世界不可观测→LLM幻觉（须配Level2验证）；formation block已+24.9% tokens；与outcome度量（PRI-866 Option B）抢优先级——mvp-q-1：跳过反事实PD仍可跑，跳过outcome则PD无法自证有效。

## 6. Recommended Evolution（方向，非代码设计）

Level0当前 Alternative generation（bad->better+rationale，保留）。Level1 Counterfactual hypothesis（Dreamer候选加可选自然语言三元组：事实A->P；假设B、C不变；预期P消失+置信；纯prompt+可选字段，降级回L0）。Level2 Counterfactual validation（复用Evaluator重放+shadow wouldBlock作对照臂：历史Pain复现输入vs中性输入行为差；并入Effectiveness SPEC）。Level3 Causal Learning Loop（activation_id连通后用同类Pain复犯率填valueScore/adherence/painPreventedCount）。最小路径：Dreamer prompt加1条"写一句话反事实假设"指令+1个可选字符串字段+Philosopher引用+Scribe投影；不碰runner/Evaluator/存储/flag。

## 验收回答

1.有没有反事实推理？没有。有因果解释+替代生成+变异测试，三者皆不满足Pearl定义。2.哪个Agent用？无；Dreamer最常被误认但原文写alternative。3.哪一级？A级Alternative（强：多候选+置信+风险+战略视角），B/C级零字段零指令零验证。4.5案例？见§3。5.值得成核心能力？post-MVP值得，当前MVP不值得；先补outcome（PRI-866 Option B）。6.最小路径？见§6 Level1三件套。

## Follow-ups

未跑error:context路由（留待SPEC补跑）；未全量比对18组全文（抽样5组已证系统性）；RuleHost在线行为差引用PRI-866结论未重复取证。

