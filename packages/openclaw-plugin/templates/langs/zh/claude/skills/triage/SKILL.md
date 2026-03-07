---
name: triage
description: Initial problem definition and risk assessment. Use to collect environment info, reproduction steps, and logs.
disable-model-invocation: true
---

# Triage (问题分诊)

**目标**: 收集足够的证据来定义问题，并评估变更风险。

请按以下结构输出：

## 1. Goal (目标)
- 一句话描述本次任务的最终成功标准。

## 2. Problem (问题描述)
- 当前发生了什么？预期的行为是什么？
- **Evidence**: 列出相关的日志片段、错误代码或观察到的异常现象。

## 3. Reproduction (复现步骤)
- 提供明确的复现命令或操作序列。
- 标注当前环境的关键变量。

## 4. Scope (范围)
- 涉及的文件或模块预览。
- **Risk Level**: Low / Medium / High (基于 `docs/PROFILE.json` 定义)。

## 5. Next Step
- 建议委派哪个子智能体 (通常是 Explorer) 进一步收集证据。
