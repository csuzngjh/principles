---
name: ai-sprint-orchestration
description: 使用打包好的 AI 冲刺编排器推进多阶段开发任务，内置基线检查、工作流验证、失败分类和 workflow-only 迭代纪律。
---

# AI 冲刺编排

当任务较大、需要多阶段推进，或者大概率会经历多轮 review / continuation 时，使用这个 skill。
这个 skill 自带一份可直接运行的编排器打包副本，代理可以直接从当前 skill 目录启动，而不需要去仓库里寻找内部脚本入口。

## 适用场景

- 需要调研、实现、评审三段推进的复杂缺陷修复
- 需要显式 producer / reviewer 决策门控的功能开发
- 使用内置 validation spec 做 workflow 自检
- 需要产物持久化和可恢复能力的长时任务

## 不适用场景

- 很小的单文件修改或简单文档修补
- `packages/openclaw-plugin` 里的 product-side / sample-side 问题
- 需要修改 `D:/Code/openclaw` 的任务
- dashboard、stageGraph、自优化 sprint 或并行编排扩展

## 快速开始

在当前 skill 包根目录执行：

1. 先做 package 烟雾检查：
   `node scripts/run.mjs --self-check`
   `node scripts/run.mjs --help`
2. 再跑 package-local validation：
   `node scripts/run.mjs --task workflow-validation-minimal`
   `node scripts/run.mjs --task workflow-validation-minimal-verify`
3. 产物默认落在：
   `runtime/`

内部 smoke 标准：

- `node scripts/run.mjs --self-check` 通过
- `workflow-validation-minimal` 至少推进到 producer 完成，并产出结构化 decision 或明确分类的 halt
- `workflow-validation-minimal-verify` 至少推进到 producer 完成，任何 reviewer 失败都必须被分类，不能保持不透明

如果你同时持有源码仓库，也可以额外运行仓库里 `scripts/ai-sprint-orchestrator/test/` 的 source baseline tests。

## 执行规则

- 当源码仓库可用时，以仓库中的 `scripts/ai-sprint-orchestrator` 为事实来源，但执行入口仍然走当前 packaged copy。
- 如果一次运行失败，只能归类成以下四类之一：
  - `workflow bug`
  - `agent behavior issue`
  - `environment issue`
  - `sample-spec issue`
- 如果失败属于 product-side 或 sample-side，完成分类后立刻停止，不继续推进产品闭环修复。
- 每轮只修一个 workflow-only 问题，然后重跑 baseline 和 validation。
- 在新环境里第一次跑 validation 前，必须先执行 `node scripts/run.mjs --self-check`。
- 对复杂 bugfix / feature 任务，必须先复制模板 spec，填好最小 task contract，再启动 sprint。

## 输出要求

每轮只汇报：

- 改了什么
- 跑了什么
- 什么失败了
- 失败归类是什么
- 下一轮唯一推荐动作
