# Principles Disciple 用户指南

> 当前版本重点不是"继续堆机制"，而是让控制面更少、更清楚、更可观察。  
> 现在系统处于 `Phase 1 + Phase 2a + Phase 2b` 完成后的生产观察窗口。

---

## 可视化控制台 (Principles Console)

### 如何访问？

1. 确保 OpenClaw Gateway 正在运行
2. 在浏览器打开：`http://localhost:18789/plugins/principles/`
3. 输入 Gateway Token 登录

### 如何获取 Token？

**方法一：查看配置文件**
```bash
# SSH 登录到运行 OpenClaw Gateway 的服务器
cat ~/.openclaw/openclaw.json
# 复制 gateway.auth.token 的值
```

**方法二：使用命令行**
```bash
openclaw config get gateway.auth.token
```

**方法三：通过 URL 参数传递**
```
http://localhost:18789/plugins/principles/?token=your_token_here
```

### 控制台功能

#### 📊 概览 (Overview)
- **健康指标**：重复错误率、用户纠正率、待处理样本数
- **每日趋势**：工具调用、失败次数、用户纠正的 7 天图表
- **回归告警**：发现最常失败的工具和错误类型
- **思维覆盖**：显示 AI 使用思维模型的频率

#### 🔄 进化追踪 (Evolution) ✨ 新功能
- **时间线视图**：查看完整的进化流程，从痛点检测到原则生成
- **任务状态**：待处理、处理中、已完成、失败的进化任务
- **详细事件**：每个进化阶段的中文摘要和技术日志
- **统计概览**：进化成功率和效率指标

#### 📋 样本审核 (Samples)
- **样本队列**：查看所有自动收集的用户纠正场景
- **审核操作**：批准或拒绝样本（决定是否用于训练）
- **详情查看**：展开查看完整的"错误尝试 → 用户纠正"对比
- **筛选器**：按状态、质量分数、日期、失败模式筛选

#### 🧠 思维模型 (Thinking Models)
- **模型列表**：查看 10 个核心思维模型及其使用频率
- **场景分析**：了解每个模型的触发条件
- **健康审计**：发现被忽略或过度触发的模型

### 为什么使用控制台？

- **可视化**：一目了然地查看系统状态，比 CLI 更直观
- **批量审核**：一次处理多个纠正样本
- **趋势分析**：观察 AI 的进化轨迹，发现改进机会
- **进化追踪**：实时了解 AI 是否在真正进化，从痛点到原则的完整链路

---

## 你现在最需要知道的 4 件事

1. `legacy trust` 还在，但已经冻结。
   现在它主要用于兼容旧逻辑，不再因为普通成功自动上涨。

2. `GFI` 代表短期摩擦和风险。
   当系统不断失败、误解、卡住时，GFI 会升高，Gate 会更谨慎。

3. `rollback` 只回滚情绪误判那一部分。
   现在撤销的是 `user_empathy` 对应的 GFI slice，不会再把整段会话 GFI 一起清掉。

4. `Evolution` 仍然存在，但它是学习面，不是当前唯一控制权来源。

---

## 常用命令

### `/pd-evolution-status`

看当前控制面和进化面的综合状态，包括：

- frozen 的 legacy trust
- 当前 session GFI 和峰值
- 已知 GFI 来源
- pain flag
- gate block / bypass
- evolution queue / directive

如果某些数据还不完全可靠，它会明确显示 `partial` 或 warning，不会假装是 0。

### `/pd-trust`

看 frozen 的 legacy trust 兼容视图。

请注意：

- 这不是未来的 capability 模型
- `tool_success` 和 `subagent_success` 不再自动加 trust
- 它主要用于兼容和解释旧控制面

### `/pd-status empathy`

看情绪/共情事件统计，用来检查：

- `user_empathy` 是否被记录
- `system_infer` 是否被记录
- 当前观察窗口里 empathy 事件是否稳定落日志

### `/pd-rollback last`

撤销最近一次情绪惩罚。

当前行为：

- 只回滚 `user_empathy` 对应的那部分 GFI
- 不再清空整段 session GFI

---

## 什么时候该用这些命令

### AI 明显误解你、让你很烦

先正常指出问题，必要时再看：

- `/pd-status empathy`
- `/pd-rollback last`

### AI 连续失败、像在原地打转

先看：

- `/pd-evolution-status`

重点看：

- GFI 是否升高
- Gate 是否在拦
- 最近 pain signal 是什么

### 你想知道系统现在到底信不信任它

用：

- `/pd-trust`

但要记住：

- 这是 frozen 的 legacy trust，不是未来能力模型

---

## 当前阶段不要误解的地方

### 不是所有旧文档里的 Trust 描述都还有效

如果你看到某些历史文档还写着：

- "成功会持续涨 trust"
- "trust score 决定未来一切"

请以当前命令输出和观察窗口文档为准。

### 现在不该直接进入 Phase 3 主切换

正确顺序是：

1. 先观察生产数据 3 到 7 天
2. 确认 trust freeze、empathy eventing、rollback 行为、summary 可解释性都稳定
3. 再考虑进入 `Capability shadow`
4. 不是立刻切 Gate 主权

---

## 生产观察期重点

每天优先看这几件事：

1. trust 有没有继续偷偷上涨
2. `user_empathy` / `system_infer` 有没有进入 `events.jsonl`
3. rollback 后有没有误伤无关 GFI
4. `evolution_queue.json`、`evolution_directive.json` 和 status 是否一致
5. status 的 warning 是否能真实解释当前数据质量

---

## 一句话总结

现在的 Principles Disciple，更像一个"先把仪表盘修好、再决定怎么换引擎"的系统。  
先看清，再切换；先观察，再进第三阶段。