# Behavioral Learning 实验声明

> PRI-836（Behavioral Learning MVP）的实验级声明资产。本目录**不是**系统组件：
> 没有数据库表、没有 runtime 对象、没有长期存储，只有一个实验一个 JSON。
>
> 权威 SPEC：`docs/specs/BEHAVIORAL_LEARNING_MVP_ACCEPTANCE_v3.md`
> 实现现实核查：`docs/audit/PRI-836_IMPLEMENTATION_REALITY_MAP.md`

## 目录约定

```
docs/experiments/<experiment-slug>/
└── behavior-signature.json     # 一次实验的目标行为声明（每实验一份）
```

## 这是什么

`behavior-signature.json` 回答一个问题：**这次实验要观察的行为，具体长什么样、什么时候算一次机会、激活前是什么样、在哪些窗口里观察。**

| 字段 | v3 对应 | 来源 |
|---|---|---|
| `behaviorSignature.intentContract.targetBehavior` | Target Behavior | 逐字复用原则 artifact 的 `intentContract` |
| `behaviorSignature.intentContract.forbiddenBehavior` | Forbidden Pattern | 同上 |
| `behaviorSignature.intentContract.evidenceSource` | Evidence Source | 同上 |
| `behaviorSignature.intentContract.validationExpectation` | Expected New Behavior | 同上 |
| `behaviorSignature.eligibleOpportunity` | Eligible Opportunity | **新增**（IntentContract 无此语义） |
| `behaviorSignature.previousBehavior` | Previous Behavior / B0 Baseline | **新增** |
| `behaviorSignature.observationWindows` | A1 / A2 观察窗口 | **新增** |

`intentContract` 必须逐字复制，不得改写、不得重新定义行为字段——`targetBehavior` /
`forbiddenBehavior` / `evidenceSource` / `validationExpectation` 的唯一 owner 是
`packages/principles-core/src/runtime-v2/internalization/intent-contract.ts`。
跨实验复用已有的 `IntentContractV1` 语义，是本设计不作新行为 schema 的前提。

## 这不是什么

- 不是数据库实体、不是 runtime 对象、不是长期存储系统；
- 不是 Behavior Engine：不判断行为是否改变、不评分、不学习、不自动归因；
- 不产生自动结论。行为裁定与结果判定由 Owner / evaluator 显式作出并记录
  （`adjudication.status` 保持 `not_evaluated` 直到人工作出裁定）。

## 校验

`packages/principles-core/tests/behavior-signature-artifact.test.ts` 会遍历本目录下
每个 `*/behavior-signature.json` 并校验其形状：

- `intentContract` 通过仓库**真实**的 `isValidIntentContractV1` 守卫（不是测试内的副本）；
- 必填字段非空、`observationWindows` 至少含 1 个 baseline + 2 个 after 窗口；
- 窗口切分轴不得使用 `session`（长生命周期主会话会让 before/after 混在一起）；
- `channel` 属于 `prompt` / `code_tool_hook`。

该校验目前是**测试**，不是 `verify:merge` 的独立门禁。若将来需要成为硬门禁，把校验函数
从测试中提到 `scripts/check-*.cjs` 并接进 `verify:merge` —— 那是独立决策，本 PR 不做。

## 新增一次实验

1. 选一条**已激活**且已批准的 Principle，取其 artifact 的 `content_json.intentContract` 逐字复制；
2. 建 `docs/experiments/<slug>/behavior-signature.json`，字段照 `pri-836/` 的形状；
3. `previousBehavior.baselineWindow` 必须早于 `activatedAt`，A1/A2 必须晚于它；
4. 跑 `packages/principles-core/tests/behavior-signature-artifact.test.ts` 确认通过。
