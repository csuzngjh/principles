---
name: reflection
description: Perform a deep metacognitive reflection on the current task status, user sentiment, and systemic issues. Use this before context compaction or when stuck.
disable-model-invocation: false
allowed-tools: Read, Grep, Bash, Write
---

# 痛定思痛 (Metacognitive Reflection)

**触发场景**: 上下文即将压缩 (Memory Loss Imminent) 或 任务长期停滞。
**目标**: 在遗忘详细过程之前，提取“痛苦教训”并固化为原则。

请执行以下反思步骤：

## 1. 现状扫描 (Status Scan)
- **Goal**: 我们最初的目标是什么？(Check `docs/PLAN.md` or early conversation)
- **Status**: 现在完成了多少？卡在哪里？
- **Cost**: 我们消耗了大量 Token，产出是否匹配？

## 2. 痛苦感知 (Pain Detection)
请诚实回答以下问题（Yes/No）：
- [ ] **任务停滞**: 是否连续 3 轮以上没有实质性代码进展？
- [ ] **重复犯错**: 是否有 Bug 被修复后又重现，或同样的错误报了两次？
- [ ] **用户挫败**: 用户是否使用了“不对”、“不是”、“停下”等否定词，或语气变得急躁？
- [ ] **盲目行动**: 是否在没有 PLAN 或 AUDIT 的情况下直接修改了代码？
- [ ] **架构劣化**: 现在的代码是否比开始时更乱了？

## 3. 根因分析 (If Pain Detected)
如果上述任一为 Yes，必须进行深层归因：
- **Direct Cause**: 我们做了什么（或没做什么）导致了现在的局面？
- **Root Cause**: 思维模型哪里出了问题？（是太急于求成？还是忽视了已有文件？还是轻视了测试？）

## 4. 进化落盘 (Evolution)
如果检测到痛苦，必须执行：
1. **记录**: 将分析结果写入 `docs/ISSUE_LOG.md`。
2. **提炼**: 如果这是第二次发生，提炼一条 **禁止性原则 (Must NOT)**。
3. **加固**: 建议一个具体的 Hook 或 Test 来防止未来重犯。

## 5. 恢复计划 (Recovery)
- 既然要压缩上下文，我们下一步该如何以“最干净”的状态继续？
- 更新 `docs/PLAN.md`，标记当前进度，确保压缩后能无缝衔接。
