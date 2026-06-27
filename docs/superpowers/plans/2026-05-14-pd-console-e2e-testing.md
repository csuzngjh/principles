# PD Console - 端到端验收测试计划

## 概述

本计划包含 PD Console 所有主要功能的端到端验收测试，旨在发现 UI 展示、数据接入、功能完整性等方面的问题。

## 功能模块测试用例

### 1. Overview 页面

| 测试用例 ID | 描述 | 优先级 | 预期结果 |
|---|---|---|---|
| T-OVER-001 | 页面加载和基本布局 | 高 | 页面正常显示，包含标题、刷新按钮、统计卡片等元素 |
| T-OVER-002 | 健康状态卡片显示 | 高 | 显示健康状态标签、GFI 数值、阶段信息 |
| T-OVER-003 | 概览统计卡片显示 | 高 | 6 个统计卡片显示正确的数值和标签 |
| T-OVER-004 | Principles 统计显示 | 中 | 显示 Active、Candidate、Probation、Deprecated 数量 |
| T-OVER-005 | 队列统计显示 | 中 | 显示 Pending、In Progress、Completed 数量 |
| T-OVER-006 | 自动刷新功能 | 中 | 页面每 30 秒自动刷新或手动点击刷新按钮正常工作 |
| T-OVER-007 | 错误状态处理 | 低 | 当 API 出错时，显示友好的错误信息 |

### 2. Tasks 页面

| 测试用例 ID | 描述 | 优先级 | 预期结果 |
|---|---|---|---|
| T-TASK-001 | 任务列表显示 | 高 | 页面显示任务标签页和任务列表 |
| T-TASK-002 | 需要确认的任务显示 | 高 | 显示 candidate 任务列表 |
| T-TASK-003 | 建议关注的任务显示 | 中 | 显示 pruning 建议关注任务 |
| T-TASK-004 | 最近活动显示 | 中 | 显示最近完成的任务 |
| T-TASK-005 | 任务详情查看 | 高 | 点击任务项可查看详细内容 |

### 3. Feedback 页面

| 测试用例 ID | 描述 | 优先级 | 预期结果 |
|---|---|---|---|
| T-FEED-001 | GFI 仪表盘显示 | 高 | 显示当前 GFI、峰值、阈值、来源分布 |
| T-FEED-002 | Empathy Events 列表 | 中 | 显示 empathy 事件列表（如果有数据） |
| T-FEED-003 | Gate Blocks 列表 | 中 | 显示 gate blocks 列表（如果有数据） |

### 4. Gates 页面

| 测试用例 ID | 描述 | 优先级 | 预期结果 |
|---|---|---|---|
| T-GATE-001 | 统计信息显示 | 高 | 显示今日统计、Trust、Evolution、GFI 信息 |
| T-GATE-002 | Gate Blocks 列表 | 中 | 显示 block 历史列表（如果有数据） |

### 5. Samples 页面

| 测试用例 ID | 描述 | 优先级 | 预期结果 |
|---|---|---|---|
| T-SAMP-001 | 样本列表显示 | 高 | 显示样本列表和筛选器 |
| T-SAMP-002 | 状态筛选功能 | 中 | 可以按 Pending/Approved/Rejected 筛选 |
| T-SAMP-003 | 样本详情查看 | 高 | 点击样本可以查看详情 |
| T-SAMP-004 | 审核批准功能 | 高 | 可以批准 pending 样本 |
| T-SAMP-005 | 审核拒绝功能 | 高 | 可以拒绝 pending 样本 |

### 6. Evolution 页面

| 测试用例 ID | 描述 | 优先级 | 预期结果 |
|---|---|---|---|
| T-EVOL-001 | 统计信息显示 | 高 | 显示总体统计和阶段分布 |
| T-EVOL-002 | 任务列表显示 | 高 | 显示进化任务列表 |
| T-EVOL-003 | 任务筛选功能 | 中 | 可以按状态和类型筛选 |
| T-EVOL-004 | Principles 生命周期显示 | 中 | 显示各个阶段的 principles 统计和最近更新 |
| T-EVOL-005 | 队列健康显示 | 中 | 显示队列健康状态 |

### 7. Thinking Models 页面

| 测试用例 ID | 描述 | 优先级 | 预期结果 |
|---|---|---|---|
| T-TMOD-001 | Thinking OS 模型列表 | 高 | 显示可用的 thinking models |
| T-TMOD-002 | 模型详情显示 | 中 | 每个模型显示 ID、名称、触发条件等信息 |

### 8. Central 页面

| 测试用例 ID | 描述 | 优先级 | 预期结果 |
|---|---|---|---|
| T-CENT-001 | 工作区列表显示 | 中 | 显示所有配置的工作区及其状态 |

### 9. Settings 页面

| 测试用例 ID | 描述 | 优先级 | 预期结果 |
|---|---|---|---|
| T-SETT-001 | 设置页面加载 | 高 | 页面正常显示设置选项 |
| T-SETT-002 | 工作区管理 | 中 | 可以添加、删除、更新工作区配置 |
| T-SETT-003 | 认证设置 | 低 | 可以配置认证信息 |

### 10. 通用功能

| 测试用例 ID | 描述 | 优先级 | 预期结果 |
|---|---|---|---|
| T-GEN-001 | 侧边栏导航 | 高 | 侧边栏可以展开/收起，各导航项可以跳转 |
| T-GEN-002 | 深色/浅色主题切换 | 高 | 主题切换功能正常工作 |
| T-GEN-003 | 中英文语言切换 | 高 | 语言切换功能正常，所有文本正确翻译 |
| T-GEN-004 | 响应式布局 | 中 | 在各种屏幕尺寸下布局正常 |
| T-GEN-005 | 登录页面显示 | 低 | 在需要认证时显示登录页面 |

## 已知功能不完整（根据代码分析）

根据代码分析，以下功能目前是返回空数据或 stub 实现：

1. Overview 页面的 `dailyTrend`、`topRegressions`、`sampleQueue.preview` - 返回空数组
2. Overview 页面的 `summary.repeatErrorRate`、`userCorrectionRate` - 返回 0
3. GateConsoleModel 的 `getGateBlocks` - 返回空数组
4. FeedbackConsoleModel 的 `getEmpathyEvents` - 返回空数组
5. GateStats 的 `today.gfiBlocks`、`stageBlocks`、`bypassAttempts` - 返回 0
6. GateStats 的 `trust.stage`、`trust.score` - 返回 0
7. GateStats 的 `evolution` - 返回空数据
8. GateStats 的 `gfi.trend` - 返回空数组
9. Overview 页面的 `trust` 数据 - 返回 0
10. Overview 页面的 `queue.inProgress` - 返回 0

## 测试执行记录

### 测试日期

2026-05-14

### 测试环境

- 服务地址: http://localhost:3100
- 浏览器: Chrome Headless (agent-browser)
- 工作区: d:\Code\principles

### 发现的问题

（测试执行后填充）

### 截图记录

所有截图保存在: packages/pd-console/screenshots/

