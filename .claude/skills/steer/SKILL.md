---
name: steer
description: Real-time intervention tool for human users. Use to manually trigger pain signals, refresh profiles, or inject urgent rules.
disable-model-invocation: true
allowed-tools: Write, Read
---

# Steer (驾驶干预)

你现在是执行“手动干预”的系统组件。请根据用户参数 `$ARGUMENTS` 强制修改系统状态：

## 支持的干预动作

### 1. `pain` (强制喊痛)
- **指令**: `/steer pain "具体原因"`
- **动作**: 立即在 `docs/.pain_flag` 写入用户提供的原因。
- **目的**: 即使你觉得没问题，但用户认为你走偏了，强制触发“痛定思痛”流程。

### 2. `profile` (画像修正)
- **指令**: `/steer profile "Domain: Level"` (例如: "Frontend: Expert")
- **动作**: 
  1. 伪造一个 `docs/.user_verdict.json` 包含该等级更新。
  2. 提醒用户，变更将在任务结束 (Stop) 或手动调用 `/admin repair` 后通过 Hook 自动生效。
- **目的**: 纠正系统对用户的错误认知。

### 3. `rule` (即时规则注入)
- **指令**: `/steer rule "规则描述"`
- **动作**: 将该规则作为 `Ad-hoc Rule` 写入 `docs/USER_CONTEXT.md` 的底部。
- **目的**: 在不修改 Kernel 的情况下，给本次或后续交互加一个临时补丁。

---

## 执行指南
- 只有在人类用户输入 `/steer` 时，你才会看到此指令。
- 你必须优先执行这些“注入”动作，然后再恢复主线任务。
- 完成后输出：“✅ 转向完成：已注入 [信号名称]”。
