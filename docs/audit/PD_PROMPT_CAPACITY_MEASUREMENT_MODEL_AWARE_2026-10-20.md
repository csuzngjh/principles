# PD 模型感知注入预算测量报告（SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 Phase 4）

生成时间：2026-10-20T13:07:23.926Z　测量入口：`packages/pd-cli/scripts/prompt-capacity-measurement.mjs`（真实生产构建器 + 受控临时工作区）。

政策：`budgetChars = min(4000, max(500, floor(2000 * W / 128000)))`（下限 500 / 硬上限 4000 / 未知回退 2000 字符，UTF-16 字符，**不是 token**）。

## 容量档位 × 两路由对照

| 容量档位 | 预算(字符) | 来源 | 状态 | 列表:平均注入 | 列表:平均字符 | 列表:截断轮次 | 共享:注入 | 共享:字符 | 共享:截断 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 32K | 500 | host_effective_window | confirmed | 6 | 488 | 40/40 | 0 | 0 | false |
| 64K | 1000 | host_effective_window | confirmed | 12 | 944 | 40/40 | 1 | 825 | true |
| 128K | 2000 | host_effective_window | confirmed | 11.5 | 1618 | 40/40 | 6 | 1980 | true |
| 256K | 4000 | host_effective_window | confirmed | 16 | 3526 | 0/40 | 14 | 3828 | true |
| 1000K | 4000 | host_effective_window | confirmed | 16 | 3526 | 0/40 | 14 | 3828 | true |
| unknown | 2000 | legacy_fallback | unknown | 11.5 | 1618 | 40/40 | 6 | 1980 | true |

要点：
- 未知容量档位如实回退 2000 字符（`legacy_fallback` / `unknown`），与既有生产行为一致；无任何伪造的动态支持。
- 1M 档位预算被硬上限压回 4000 字符——预算不会随窗口无限增长。
- 超长排除/截断语义在各档位下与既有选择器一致（同一 `trimToBudget` 与共享渲染路径，只是预算数值变化）。

## 共享路径真实 dispatch 预算来源证据（生产 createProductionHostRuntime）

```json
[
  {
    "dispatch": "trusted host window 256K",
    "budget": 4000,
    "budgetCapacitySource": "host_effective_window",
    "budgetCapacityStatus": "confirmed",
    "budgetContextWindowTokens": 256000,
    "injectedCount": 7
  },
  {
    "dispatch": "untrusted source default",
    "budget": 2000,
    "budgetCapacitySource": "legacy_fallback",
    "budgetCapacityStatus": "unknown",
    "budgetContextWindowTokens": null,
    "injectedCount": 6
  },
  {
    "dispatch": "ambiguous bare model id",
    "budget": 2000,
    "budgetCapacitySource": "legacy_fallback",
    "budgetCapacityStatus": "unknown",
    "budgetContextWindowTokens": null,
    "injectedCount": 6
  },
  {
    "dispatch": "no model facts (WorkBuddy contract)",
    "budget": 2000,
    "budgetCapacitySource": "legacy_fallback",
    "budgetCapacityStatus": "unknown",
    "budgetContextWindowTokens": null,
    "injectedCount": 6
  }
]
```

## 完整数据

```json
[
  {
    "label": "32K",
    "windowTokens": 32000,
    "budgetChars": 500,
    "capacitySource": "host_effective_window",
    "capacityStatus": "confirmed",
    "policyVersion": "model_aware_v1",
    "list": {
      "candidates": 16,
      "avgInjected": 6,
      "avgUsedChars": 488,
      "truncatedRounds": 40,
      "avgOversizedPerRound": 2
    },
    "shared": {
      "injected": 0,
      "usedChars": 0,
      "truncated": false,
      "oversized": 1,
      "dropped": 0,
      "selectionPolicy": "legacy_fifo_prefix_v1"
    }
  },
  {
    "label": "64K",
    "windowTokens": 64000,
    "budgetChars": 1000,
    "capacitySource": "host_effective_window",
    "capacityStatus": "confirmed",
    "policyVersion": "model_aware_v1",
    "list": {
      "candidates": 16,
      "avgInjected": 12,
      "avgUsedChars": 944,
      "truncatedRounds": 40,
      "avgOversizedPerRound": 2
    },
    "shared": {
      "injected": 1,
      "usedChars": 825,
      "truncated": true,
      "oversized": 0,
      "dropped": 1,
      "selectionPolicy": "legacy_fifo_prefix_v1"
    }
  },
  {
    "label": "128K",
    "windowTokens": 128000,
    "budgetChars": 2000,
    "capacitySource": "host_effective_window",
    "capacityStatus": "confirmed",
    "policyVersion": "model_aware_v1",
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
    "label": "256K",
    "windowTokens": 256000,
    "budgetChars": 4000,
    "capacitySource": "host_effective_window",
    "capacityStatus": "confirmed",
    "policyVersion": "model_aware_v1",
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
    "label": "1000K",
    "windowTokens": 1000000,
    "budgetChars": 4000,
    "capacitySource": "host_effective_window",
    "capacityStatus": "confirmed",
    "policyVersion": "model_aware_v1",
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
    "label": "unknown",
    "windowTokens": null,
    "budgetChars": 2000,
    "capacitySource": "legacy_fallback",
    "capacityStatus": "unknown",
    "policyVersion": "model_aware_v1",
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
  }
]
```
