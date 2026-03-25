---
name: plan-script
description: Create a step-by-step movie-script style execution plan. Includes target files, verification metrics, and rollback strategy.
disable-model-invocation: true
---

# Plan Script (计划编排)

**目标**: 产生一份“傻瓜式”可执行计划，确保执行过程受控。

请按以下结构生成计划：

## 1. Target Files (授权清单)
- 列出本次计划**唯一授权**修改的文件路径。
- 格式：`- path/to/file`

## 2. Steps (执行步骤)
1. 具体到文件名和工具调用的操作。
2. 每个步骤包含预期的中间状态。

## 3. Metrics (验证指标)
- 如何量化证明本计划成功了？(如：测试通过、命令返回 0、日志出现特定字符串)。

## 4. Active Mental Models (激活的思维模型)
- 从 `.principles/THINKING_OS.md` 中挑选 **2 个** 最适合当前任务的元认知模型。
- 格式：`- [T-0X] 模型名称：为什么在这个任务中需要它？`

## 5. Rollback (回滚方案)
- 如果步骤 2 失败，如何一键恢复到安全状态？

---
**动作**: 请将以上内容更新至 `PLAN.md`，并设置 `STATUS: READY`。
