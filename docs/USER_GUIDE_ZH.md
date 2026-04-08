# Principles Disciple 用户操作手册

这份手册只写当前 `v1.9.0` 里真正需要用到的操作，不讲过时设计。

## 这个系统现在负责什么

当前系统主要做两件事：

1. 在智能体执行任务时保护工作区。
2. 把反复出现的错误沉淀成原则、实现和回放评估结果，逐步内化成更稳定的行为。

你不需要理解全部架构，日常只要掌握下面这些命令。

## 日常命令

### `/pd-status`

当 AI 明显卡住、误解你、或者一直重复同样错误时，用这个命令先看状态。

- `/pd-status`：查看当前疲劳/摩擦状态
- `/pd-status reset`：清空当前会话摩擦值，让 AI 重新判断
- `/pd-status empathy`：查看情绪事件统计
- `/pd-status empathy --week`：查看周趋势
- `/pd-status empathy --session`：只看当前会话

如果 AI 在同一个错误上打转，优先用 `reset`。

### `/pd-rollback last`

当情绪系统误判了你的语气或意图时，用它撤销最近一次惩罚。

- `/pd-rollback last`：回滚当前会话最近一次情绪惩罚
- `/pd-rollback <eventId>`：回滚指定事件

它只影响 empathy 相关的 GFI，不会把整段会话状态全部清空。

### `/pd-evolution-status`

这是当前原则内化系统最重要的观察命令。

它会显示：

- 当前和峰值 GFI
- 最近 pain 信号
- 最近 gate block / bypass
- evolution 队列状态
- 原则数量统计
- 当前的内化路线建议，例如 `skill`、`code`、`defer`

如果你不确定现在是被疲劳状态卡住、被 pain 卡住，还是被 code implementation 策略卡住，先看这个命令。

## 代码实现运维流程

这部分是给需要操作 code implementation 的人看的，不是每次都要用。

### 什么时候需要用

在下面这些场景里使用：

- 系统产生了新的 candidate implementation
- 你想先跑 replay，再决定要不要 promote
- 当前 active implementation 出现回归，要禁用或回滚
- 老实现已经废弃，需要归档

### 第一步：列出候选实现

```text
/pd-promote-impl list
```

它会列出当前 candidate implementation，并标记哪些已经有通过的 replay report。

### 第二步：执行 replay 评估

```text
/pd-promote-impl eval <implId>
```

它会针对目标 implementation 运行 replay evaluation，并写出 replay report。

以下情况建议先跑一次：

- 新 candidate 刚生成
- 之前没有 replay report
- replay 数据集已经变化，你想重新评估

### 第三步：查看 replay 报告

```text
/pd-promote-impl show <implId>
```

重点看：

- 样本总数
- pass / fail 结论
- 覆盖了哪些 classification
- 是否因为没有 replay 样本导致报告为空

### 第四步：正式 promote

```text
/pd-promote-impl <implId>
```

promote 的前提：

- implementation 当前必须是 `candidate` 或 `disabled`
- 必须已经有通过的 replay report
- 如果同一个 rule 已经有 active implementation，旧的 active 会自动变成 disabled

这是 candidate 进入 active 的标准路径。

### 第五步：禁用异常实现

```text
/pd-disable-impl list
/pd-disable-impl <implId> --reason "原因"
```

当某个实现在线上表现不好、需要立刻停用时，用这个命令。

disable 会保留账本记录，但停止它继续参与运行。

### 第六步：回滚到上一个 active 实现

```text
/pd-rollback-impl list
/pd-rollback-impl <implId> --reason "原因"
```

当当前 active implementation 需要撤回，并恢复到上一个 active 版本时，用这个命令。

如果没有 previous active implementation，系统会退回到宿主硬边界继续保护：

- GFI
- Progressive Gate
- 其他已有硬约束

### 第七步：归档实现

```text
/pd-archive-impl list
/pd-archive-impl <implId>
```

当某个 implementation 已经过时、不应该再参与后续 promote 时，用归档。

archive 比 disable 更彻底，适合做永久清理。

## 推荐操作顺序

当系统出现新的 code candidate 时，推荐按这个顺序操作：

1. `/pd-evolution-status`
2. `/pd-promote-impl list`
3. `/pd-promote-impl eval <implId>`
4. `/pd-promote-impl show <implId>`
5. `/pd-promote-impl <implId>`

如果 promote 后发现它有回归：

1. `/pd-disable-impl <implId> --reason "原因"`
2. 如果要恢复旧版本，再执行 `/pd-rollback-impl <implId> --reason "原因"`
3. 如果这个实现已经彻底废弃，再执行 `/pd-archive-impl <implId>`

## 如何理解内化路线建议

`/pd-evolution-status` 可能会显示：

- `skill`
- `code`
- `defer`

它们的含义是：

- `skill`：这个原则更适合先通过提示词 / SOP / 工作流来内化
- `code`：这个原则更确定、风险更高，适合变成 code implementation
- `defer`：当前证据还不够，先不要强行内化

这些只是建议，不会自动执行。

## 常见问题

### “Promotion rejected: no passing replay report”

先执行：

```text
/pd-promote-impl eval <implId>
```

再查看：

```text
/pd-promote-impl show <implId>
```

### “Replay report 是空的”

说明当前没有找到已分类的 replay 样本。

检查：

- 工作区里是否已经产生 nocturnal / replay 数据
- implementation 是否挂到了正确的 rule 上
- 最近会话里是否产出了可用样本

### “明明 disable 了，实现为什么还像被限制住？”

这是正常现象。disable code implementation 以后，系统的宿主硬边界仍然存在，例如：

- Thinking checkpoint
- GFI
- Progressive Gate
- Edit verification

### “我只是想知道系统健不健康”

直接用：

```text
/pd-status
/pd-evolution-status
```

这对大多数日常使用已经够了。

## 可视化控制台

如果你的部署暴露了插件 UI，可以打开：

```text
http://localhost:18789/plugins/principles/
```

控制台适合做：

- 看趋势和队列
- 看 evolution 事件
- 看 correction samples
- 看 principle / implementation 的整体活动情况

## 最后只记住这四件事

1. AI 卡住了，用 `/pd-status`
2. empathy 误判了，用 `/pd-rollback last`
3. 想看原则内化系统状态，用 `/pd-evolution-status`
4. 只有在你要操作 code implementation 时，才去用 `/pd-promote-impl`、`/pd-disable-impl`、`/pd-rollback-impl`、`/pd-archive-impl`
