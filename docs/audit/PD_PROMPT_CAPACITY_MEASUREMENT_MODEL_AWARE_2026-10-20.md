# PD 模型感知注入预算测量报告（SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 Phase 4）

生成时间：2026-10-20T23:49:01.976Z　测量入口：`packages/pd-cli/scripts/prompt-capacity-measurement.mjs`（真实生产构建器 + 受控临时工作区）。

政策：`budgetChars = min(4000, max(500, floor(2000 * W / 128000)))`（下限 1250 / 目标上限 16000 / 未知回退 2000 字符，UTF-16 字符，**不是 token**）。下限为实测锚定：共享路由单条最小有效原则完整渲染 849 字符（自报关）/ 1204 字符（自报开），任何更低下限都会复现 32K 零注入缺陷；上限为目标值，1M 档位按公式精确得出 15625，不假装恰好等于上限。

## 容量档位 × 两路由对照

| 容量档位 | 预算(字符) | 来源 | 状态 | 列表:平均注入 | 列表:平均字符 | 列表:截断轮次 | 共享:注入 | 共享:字符 | 共享:截断 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 32K | 1250 | host_effective_window | confirmed | 12.7 | 1111 | 40/40 | 2 | 1056 | true |
| 64K | 1250 | host_effective_window | confirmed | 12.7 | 1111 | 40/40 | 2 | 1056 | true |
| 128K | 2000 | host_effective_window | confirmed | 11.5 | 1618 | 40/40 | 6 | 1980 | true |
| 256K | 4000 | host_effective_window | confirmed | 16 | 3526 | 0/40 | 14 | 3828 | true |
| 1000K | 15625 | host_effective_window | confirmed | 16 | 3526 | 0/40 | 16 | 6568 | false |
| unknown | 2000 | legacy_fallback | unknown | 11.5 | 1618 | 40/40 | 6 | 1980 | true |

要点：
- 未知容量档位如实回退 2000 字符（`legacy_fallback` / `unknown` + 有界原因码），与既有生产行为一致；无任何伪造的动态支持。
- 1M 档位预算按公式精确为 15625 字符（≥1.024M 才触顶 16000）——上限是目标边界，不是必须达到的固定值。
- 32K 档位（=下限 1250）经真实生产构建器验证：共享路由在自报开/关两种状态下均至少完整注入一条最小有效原则（v0.1 的 500 下限在该档位注入 0 条，已修复并以回归测试钉住）。
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
    "budgetChars": 1250,
    "capacitySource": "host_effective_window",
    "capacityStatus": "confirmed",
    "fallbackReason": null,
    "policyVersion": "model_aware_v1",
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
    "label": "64K",
    "windowTokens": 64000,
    "budgetChars": 1250,
    "capacitySource": "host_effective_window",
    "capacityStatus": "confirmed",
    "fallbackReason": null,
    "policyVersion": "model_aware_v1",
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
    "label": "128K",
    "windowTokens": 128000,
    "budgetChars": 2000,
    "capacitySource": "host_effective_window",
    "capacityStatus": "confirmed",
    "fallbackReason": null,
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
    "fallbackReason": null,
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
    "budgetChars": 15625,
    "capacitySource": "host_effective_window",
    "capacityStatus": "confirmed",
    "fallbackReason": null,
    "policyVersion": "model_aware_v1",
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
    "label": "unknown",
    "windowTokens": null,
    "budgetChars": 2000,
    "capacitySource": "legacy_fallback",
    "capacityStatus": "unknown",
    "fallbackReason": "host_capacity_absent",
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
