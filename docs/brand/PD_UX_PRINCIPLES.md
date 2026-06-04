# PD Web 控制台与 UI 组件规范

版本：v0.1
来源：从 PD_BRAND_CONSTITUTION.md 原 §7、§8、§11.4 提取
适用项目：Principles Disciple / PD / 原则门徒
文档类型：产品 UX 规范
目标读者：前端开发者、UI 设计师、AI 设计助手
维护者：PD Owner
状态：MVP 阶段

---

> **关于品牌约束**
>
> 本文档定义 PD 控制台的具体页面结构和 UI 组件规范。
> 所有 UI 设计仍需遵守 [PD_BRAND_CONSTITUTION.md](PD_BRAND_CONSTITUTION.md) 中的品牌原则，
> 包括视觉克制、注意力保护、Owner 治理中心等核心约束。

---

# 1. Web 控制台设计原则

## 1.1 控制台定位

PD Web 控制台不是传统 SaaS dashboard。

它应该是：

> Governance Workspace
> Agent 行为治理工作台

核心不是“看数据”，而是“做判断”。

---

## 1.2 首页不应该展示什么

不要把首页设计成指标大屏。

避免首页首屏展示：

* 今日 pain 数
* 原则总数
* Agent 活跃度
* 多个趋势图
* PRRR 大图
* 彩色状态卡片
* 排行榜
* 实时滚动日志
* 大量待办事项
* “效率提升 xx%”

这些会让 Owner 进入快思考和运营后台心智。

---

## 1.3 首页应该展示什么

首页优先展示：

### 1. Today’s Governance Focus

今天最值得 Owner 看的一到三个治理事项。

示例：

```text
1 个反复出现的行为偏差
2 条等待审查的原则
1 条可能产生副作用的已激活原则
```

### 2. Evidence → Principle

展示一条完整链路：

```text
过去几次相似 pain
→ 系统诊断出的行为模式
→ 建议沉淀的原则
→ Owner 可选动作
```

### 3. Long-term Behavior Change

展示长期行为变化，用自然语言表达，不要制造指标焦虑。

示例：

```text
过去 14 天，Agent 在“大范围修改前先确认”的行为上更稳定。
最近一次相似任务中，它主动给出了风险点和验证计划。
```

---

## 1.4 控制台核心页面

MVP 阶段建议控制台只保留少数核心页面。

### Page 1：Governance Focus

用途：

> 告诉 Owner 当前最值得处理的治理事项。

必须突出：

* 高价值 pain
* 高风险原则
* 待审查原则
* 可疑原则债务
* 需要 Owner 判断的事项

---

### Page 2：Pain Evidence

用途：

> 展示值得沉淀的行为证据。

每条 pain 应包含：

* 简短描述
* 发生场景
* 相关 Agent 行为
* Owner 关切
* 证据来源
* 是否反复出现
* 是否建议生成原则

---

### Page 3：Principle Review

用途：

> 让 Owner 审查原则。

每条原则必须展示：

* 原则正文
* 来源 pain
* 适用场景
* 不适用场景
* 预期行为改变
* 潜在副作用
* 推荐部署通道
* 操作按钮：Approve / Modify / Reject / Defer

---

### Page 4：Behavior Change

用途：

> 展示原则是否影响了后续行为。

不需要复杂指标，MVP 阶段优先展示：

* 后续相似任务
* Agent 是否触发原则
* 行为是否变化
* Owner 是否认可变化
* 是否需要调整原则

---

### Page 5：Principle Debt

用途：

> 管理原则债务。

展示：

* 长期未触发原则
* 频繁触发但效果不明原则
* 可能冲突原则
* Owner 标记为可疑的原则
* 建议归档或降权的原则

---

# 2. UI 组件原则

## 2.1 卡片

PD 可以使用卡片，但卡片必须服务判断，不要只是装饰。

卡片结构建议：

```text
Title：一句判断
Status：当前状态
Evidence：来源证据摘要
Impact：预期行为影响
Action：Owner 可执行动作
```

卡片不要塞太多字段。

---

## 2.2 按钮

按钮文案应清晰表达 Owner 权限。

推荐按钮：

```text
Approve Principle
Modify
Reject
Defer
Rollback
View Evidence
Compare Behavior
Archive
```

中文：

```text
批准原则
修改
拒绝
暂存
回滚
查看证据
对比行为
归档
```

避免：

```text
Optimize
Auto Fix
Evolve
Magic Improve
One-click Learn
```

中文避免：

```text
自动优化
一键进化
智能修复
立即变强
```

---

## 2.3 状态标签

推荐状态：

```text
Draft
Needs Review
Approved
Active
Observed
Needs Adjustment
Rolled Back
Archived
```

中文：

```text
草稿
待审查
已批准
已激活
已观察
需调整
已回滚
已归档
```

状态标签应低饱和，不要像警报系统。

---

## 2.4 空状态

空状态不应该只是“暂无数据”。

应该帮助 Owner 理解下一步。

示例：

```text
还没有可审查原则。
当 PD 捕获到反复出现的行为偏差时，会在这里生成原则候选，等待你审查。
```

示例：

```text
还没有观察到后续行为变化。
当相似任务再次出现时，PD 会记录原则是否被触发，以及 Agent 的行为是否发生变化。
```

---

## 2.5 错误提示

错误提示要冷静，不要制造恐慌。

推荐：

```text
无法加载这条原则的证据来源。
原则本身未受影响。你可以稍后重试，或暂时将其保留在待审查状态。
```

避免：

```text
错误！加载失败！
系统异常！
数据丢失！
```

---

# 3. 设计模板

## 3.1 控制台卡片模板

```text
[Status] Needs Review

Title:
Agent repeatedly modified broad files without confirming scope.

Evidence:
Observed in 3 similar sessions.

Suggested Principle:
Before cross-module changes, present scope, risk, and verification plan to Owner.

Expected Behavior:
Agent asks for confirmation before large-surface changes.

Actions:
Approve / Modify / Reject / Defer
```

中文：

```text
[状态] 待审查

标题：
Agent 多次在未确认范围的情况下进行大面积修改。

证据：
在 3 次相似任务中观察到。

建议原则：
当修改跨越多个模块时，先向 Owner 说明范围、风险和验证计划。

预期行为：
Agent 在大范围修改前主动请求确认。

操作：
批准 / 修改 / 拒绝 / 暂存
```
