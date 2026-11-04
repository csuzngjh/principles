# PD 模型感知注入预算测量报告（SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 Phase 4）

生成时间：2026-11-03T13:19:43.161Z　测量入口：`packages/pd-cli/scripts/prompt-capacity-measurement.mjs`（真实生产构建器 + 受控临时工作区）。

政策：`budgetChars = min(32000, max(1250, floor(4000 * W / 128000)))`（下限 1250 / 目标上限 32000 / 未知回退 4000 字符，UTF-16 字符，**不是 token**）。下限为实测锚定：共享路由单条最小有效原则完整渲染 849 字符（自报关）/ 1204 字符（自报开），任何更低下限都会复现 32K 零注入缺陷；上限为目标值，1M 档位按公式精确得出 31250，不假装恰好等于上限。

## 容量档位 × 两路由对照

| 容量档位 | 自报 | 预算(字符) | 来源 | 状态 | 列表:平均注入 | 列表:平均字符 | 列表:截断轮次 | 共享:注入 | 共享:字符 | 共享:截断 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 32K | 关 | 1250 | host_effective_window | confirmed | 12.7 | 1111 | 40/40 | 2 | 1056 | true |
| 32K | 开 | 1250 | host_effective_window | confirmed | 12.7 | 1111 | 40/40 | 1 | 1180 | true |
| 64K | 关 | 2000 | host_effective_window | confirmed | 11.5 | 1618 | 40/40 | 6 | 1980 | true |
| 64K | 开 | 2000 | host_effective_window | confirmed | 11.5 | 1618 | 40/40 | 4 | 1873 | true |
| 128K | 关 | 4000 | host_effective_window | confirmed | 16 | 3526 | 0/40 | 14 | 3828 | true |
| 128K | 开 | 4000 | host_effective_window | confirmed | 16 | 3526 | 0/40 | 13 | 3952 | true |
| 256K | 关 | 8000 | host_effective_window | confirmed | 16 | 3526 | 0/40 | 16 | 6568 | false |
| 256K | 开 | 8000 | host_effective_window | confirmed | 16 | 3526 | 0/40 | 16 | 6923 | false |
| 1000K | 关 | 31250 | host_effective_window | confirmed | 16 | 3526 | 0/40 | 16 | 6568 | false |
| 1000K | 开 | 31250 | host_effective_window | confirmed | 16 | 3526 | 0/40 | 16 | 6923 | false |
| unknown | 关 | 4000 | legacy_fallback | unknown | 16 | 3526 | 0/40 | 14 | 3828 | true |
| unknown | 开 | 4000 | legacy_fallback | unknown | 16 | 3526 | 0/40 | 13 | 3952 | true |

要点：
- 未知容量档位如实回退 4000 字符（`legacy_fallback` / `unknown` + 有界原因码），与既有生产行为一致；无任何伪造的动态支持。
- 1M 档位预算按公式精确为 31250 字符（≥1024000 token 才触顶 32000）——上限是目标边界，不是必须达到的固定值。
- 32K 档位（=下限 1250）经真实生产构建器验证：共享路由在自报开/关两种状态下均至少完整注入一条最小有效原则（v0.1 的 500 下限在该档位注入 0 条，已修复并以回归测试钉住）。
- 超长排除/截断语义在各档位下与既有选择器一致（同一 `trimToBudget` 与共享渲染路径，只是预算数值变化）。

## 改动前后对比（同一批候选，真实生产序列化器实测）

同一批 16 条候选（14 × 60 字符 + 2 × 1200 字符）、40 个受控 round key，分别以旧预算 2000 与新预算 4000 跑真实选择器/渲染器：

| 路由 | 旧预算注入条数 | 新预算注入条数 | 旧预算占用字符 | 新预算占用字符 |
| --- | --- | --- | --- | --- |
| 列表路由（轮转均值） | 11.5 | 16 | 1618 | 3526 |
| 共享路由（FIFO 单次构建） | 6 | 14 | 1980 | 3828 |

共享路由 FIFO 注入：旧 6 条 → 新 14 条；旧预算截断=true，新预算截断=true。

## 共享路径真实 dispatch 预算来源证据（生产 createProductionHostRuntime）

```json
[
  {
    "dispatch": "trusted host window 256K",
    "budget": 8000,
    "budgetCapacitySource": "host_effective_window",
    "budgetCapacityStatus": "confirmed",
    "budgetContextWindowTokens": 256000,
    "budgetFallbackReason": null,
    "injectedCount": 9
  },
  {
    "dispatch": "untrusted source default",
    "budget": 4000,
    "budgetCapacitySource": "legacy_fallback",
    "budgetCapacityStatus": "unknown",
    "budgetContextWindowTokens": null,
    "budgetFallbackReason": "host_capacity_source_untrusted",
    "injectedCount": 7
  },
  {
    "dispatch": "ambiguous bare model id",
    "budget": 4000,
    "budgetCapacitySource": "legacy_fallback",
    "budgetCapacityStatus": "unknown",
    "budgetContextWindowTokens": null,
    "budgetFallbackReason": "catalog_ambiguous_model_id",
    "injectedCount": 7
  },
  {
    "dispatch": "no model facts (WorkBuddy contract)",
    "budget": 4000,
    "budgetCapacitySource": "legacy_fallback",
    "budgetCapacityStatus": "unknown",
    "budgetContextWindowTokens": null,
    "budgetFallbackReason": "host_capacity_absent",
    "injectedCount": 7
  }
]
```

## 完整数据

```json
[
  {
    "selfReport": false,
    "label": "32K",
    "windowTokens": 32000,
    "budgetChars": 1250,
    "capacitySource": "host_effective_window",
    "capacityStatus": "confirmed",
    "fallbackReason": null,
    "policyVersion": "model_aware_v2",
    "list": {
      "candidates": 16,
      "avgInjected": 12.7,
      "avgUsedChars": 1111,
      "truncatedRounds": 40,
      "avgOversizedPerRound": 0
    },
    "shared": {
      "injected": 2,
      "usedChars": 1056,
      "truncated": true,
      "oversized": 0,
      "dropped": 1,
      "selectionPolicy": "legacy_fifo_prefix_v1"
    }
  },
  {
    "selfReport": true,
    "label": "32K",
    "windowTokens": 32000,
    "budgetChars": 1250,
    "capacitySource": "host_effective_window",
    "capacityStatus": "confirmed",
    "fallbackReason": null,
    "policyVersion": "model_aware_v2",
    "list": {
      "candidates": 16,
      "avgInjected": 12.7,
      "avgUsedChars": 1111,
      "truncatedRounds": 40,
      "avgOversizedPerRound": 0
    },
    "shared": {
      "injected": 1,
      "usedChars": 1180,
      "truncated": true,
      "oversized": 0,
      "dropped": 1,
      "selectionPolicy": "legacy_fifo_prefix_v1"
    }
  },
  {
    "selfReport": false,
    "label": "64K",
    "windowTokens": 64000,
    "budgetChars": 2000,
    "capacitySource": "host_effective_window",
    "capacityStatus": "confirmed",
    "fallbackReason": null,
    "policyVersion": "model_aware_v2",
    "list": {
      "candidates": 16,
      "avgInjected": 11.5,
      "avgUsedChars": 1618,
      "truncatedRounds": 40,
      "avgOversizedPerRound": 0
    },
    "shared": {
      "injected": 6,
      "usedChars": 1980,
      "truncated": true,
      "oversized": 0,
      "dropped": 1,
      "selectionPolicy": "legacy_fifo_prefix_v1"
    }
  },
  {
    "selfReport": true,
    "label": "64K",
    "windowTokens": 64000,
    "budgetChars": 2000,
    "capacitySource": "host_effective_window",
    "capacityStatus": "confirmed",
    "fallbackReason": null,
    "policyVersion": "model_aware_v2",
    "list": {
      "candidates": 16,
      "avgInjected": 11.5,
      "avgUsedChars": 1618,
      "truncatedRounds": 40,
      "avgOversizedPerRound": 0
    },
    "shared": {
      "injected": 4,
      "usedChars": 1873,
      "truncated": true,
      "oversized": 0,
      "dropped": 1,
      "selectionPolicy": "legacy_fifo_prefix_v1"
    }
  },
  {
    "selfReport": false,
    "label": "128K",
    "windowTokens": 128000,
    "budgetChars": 4000,
    "capacitySource": "host_effective_window",
    "capacityStatus": "confirmed",
    "fallbackReason": null,
    "policyVersion": "model_aware_v2",
    "list": {
      "candidates": 16,
      "avgInjected": 16,
      "avgUsedChars": 3526,
      "truncatedRounds": 0,
      "avgOversizedPerRound": 0
    },
    "shared": {
      "injected": 14,
      "usedChars": 3828,
      "truncated": true,
      "oversized": 0,
      "dropped": 1,
      "selectionPolicy": "legacy_fifo_prefix_v1"
    }
  },
  {
    "selfReport": true,
    "label": "128K",
    "windowTokens": 128000,
    "budgetChars": 4000,
    "capacitySource": "host_effective_window",
    "capacityStatus": "confirmed",
    "fallbackReason": null,
    "policyVersion": "model_aware_v2",
    "list": {
      "candidates": 16,
      "avgInjected": 16,
      "avgUsedChars": 3526,
      "truncatedRounds": 0,
      "avgOversizedPerRound": 0
    },
    "shared": {
      "injected": 13,
      "usedChars": 3952,
      "truncated": true,
      "oversized": 0,
      "dropped": 1,
      "selectionPolicy": "legacy_fifo_prefix_v1"
    }
  },
  {
    "selfReport": false,
    "label": "256K",
    "windowTokens": 256000,
    "budgetChars": 8000,
    "capacitySource": "host_effective_window",
    "capacityStatus": "confirmed",
    "fallbackReason": null,
    "policyVersion": "model_aware_v2",
    "list": {
      "candidates": 16,
      "avgInjected": 16,
      "avgUsedChars": 3526,
      "truncatedRounds": 0,
      "avgOversizedPerRound": 0
    },
    "shared": {
      "injected": 16,
      "usedChars": 6568,
      "truncated": false,
      "oversized": 0,
      "dropped": 0,
      "selectionPolicy": "legacy_fifo_prefix_v1"
    }
  },
  {
    "selfReport": true,
    "label": "256K",
    "windowTokens": 256000,
    "budgetChars": 8000,
    "capacitySource": "host_effective_window",
    "capacityStatus": "confirmed",
    "fallbackReason": null,
    "policyVersion": "model_aware_v2",
    "list": {
      "candidates": 16,
      "avgInjected": 16,
      "avgUsedChars": 3526,
      "truncatedRounds": 0,
      "avgOversizedPerRound": 0
    },
    "shared": {
      "injected": 16,
      "usedChars": 6923,
      "truncated": false,
      "oversized": 0,
      "dropped": 0,
      "selectionPolicy": "legacy_fifo_prefix_v1"
    }
  },
  {
    "selfReport": false,
    "label": "1000K",
    "windowTokens": 1000000,
    "budgetChars": 31250,
    "capacitySource": "host_effective_window",
    "capacityStatus": "confirmed",
    "fallbackReason": null,
    "policyVersion": "model_aware_v2",
    "list": {
      "candidates": 16,
      "avgInjected": 16,
      "avgUsedChars": 3526,
      "truncatedRounds": 0,
      "avgOversizedPerRound": 0
    },
    "shared": {
      "injected": 16,
      "usedChars": 6568,
      "truncated": false,
      "oversized": 0,
      "dropped": 0,
      "selectionPolicy": "legacy_fifo_prefix_v1"
    }
  },
  {
    "selfReport": true,
    "label": "1000K",
    "windowTokens": 1000000,
    "budgetChars": 31250,
    "capacitySource": "host_effective_window",
    "capacityStatus": "confirmed",
    "fallbackReason": null,
    "policyVersion": "model_aware_v2",
    "list": {
      "candidates": 16,
      "avgInjected": 16,
      "avgUsedChars": 3526,
      "truncatedRounds": 0,
      "avgOversizedPerRound": 0
    },
    "shared": {
      "injected": 16,
      "usedChars": 6923,
      "truncated": false,
      "oversized": 0,
      "dropped": 0,
      "selectionPolicy": "legacy_fifo_prefix_v1"
    }
  },
  {
    "selfReport": false,
    "label": "unknown",
    "windowTokens": null,
    "budgetChars": 4000,
    "capacitySource": "legacy_fallback",
    "capacityStatus": "unknown",
    "fallbackReason": "host_capacity_absent",
    "policyVersion": "model_aware_v2",
    "list": {
      "candidates": 16,
      "avgInjected": 16,
      "avgUsedChars": 3526,
      "truncatedRounds": 0,
      "avgOversizedPerRound": 0
    },
    "shared": {
      "injected": 14,
      "usedChars": 3828,
      "truncated": true,
      "oversized": 0,
      "dropped": 1,
      "selectionPolicy": "legacy_fifo_prefix_v1"
    }
  },
  {
    "selfReport": true,
    "label": "unknown",
    "windowTokens": null,
    "budgetChars": 4000,
    "capacitySource": "legacy_fallback",
    "capacityStatus": "unknown",
    "fallbackReason": "host_capacity_absent",
    "policyVersion": "model_aware_v2",
    "list": {
      "candidates": 16,
      "avgInjected": 16,
      "avgUsedChars": 3526,
      "truncatedRounds": 0,
      "avgOversizedPerRound": 0
    },
    "shared": {
      "injected": 13,
      "usedChars": 3952,
      "truncated": true,
      "oversized": 0,
      "dropped": 1,
      "selectionPolicy": "legacy_fifo_prefix_v1"
    }
  }
]
```
