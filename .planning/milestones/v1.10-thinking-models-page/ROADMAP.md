# Roadmap: Principles Disciple

## Milestones

- ✅ **v1.9.3** — 剩余 Lint 修复 (Phase 03, shipped 2026-04-09)
- 📋 **v1.10** — Thinking Models 页面优化 (8 phases, started 2026-04-09)
- 📋 **Next** — TBD (see `.planning/milestones/` for archive)

## Phases

<details>
<summary>✅ v1.9.3 剩余 Lint 修复 (Phase 03) — SHIPPED 2026-04-09</summary>

- [x] Phase 03: Manual Remediation (1/1 plans) — completed 2026-04-09

**Details:** Gap closure continuation from v1.9.2. Achieved CI green through mechanical fixes (~149) and documented suppressions (~291). All lint errors resolved, npm run lint exits 0.

</details>

### 📋 v1.10 Thinking Models 页面优化

**Milestone:** v1.10
**Goal:** 将 Thinking Models 页面从简单的列表/详情视图重构为功能完整的思维模型分析面板
**Phases:** 8
**Coverage:** 22/22 requirements mapped

- [ ] **Phase 1: 基础可视化** - 覆盖率趋势图、场景热力图、空状态优化 (VIZ-01, VIZ-03, VIZ-04)
- [ ] **Phase 2: 模型详情可视化** - 使用趋势图、事件上下文展开 (VIZ-02)
- [ ] **Phase 3: 休眠模型与推荐标签** - 休眠模型列表、推荐标签色彩编码、过滤 (DORM-01, DORM-02, REC-01, REC-02, REC-03)
- [ ] **Phase 4: 事件上下文详情** - toolContext、painContext、principleContext、matchedPattern (EVT-01, EVT-02, EVT-03, EVT-04)
- [ ] **Phase 5: THINKING_OS.md 内容展示** - trigger、antiPattern、workspace 路径 (TOS-01, TOS-02, TOS-03)
- [ ] **Phase 6: 模型对比模式** - 多模型选择、并排比较、趋势叠加 (CMP-01, CMP-02, CMP-03)
- [ ] **Phase 7: 搜索与过滤** - 文本搜索、排序切换 (SRCH-01, SRCH-02)
- [ ] **Phase 8: THINKING_OS.md 一致性** - 模板补齐 10 个 directive (SYNC-01)

### Phase 1: 基础可视化

**Goal:** 添加覆盖率趋势图、场景热力图、优化空状态

**Requirements:** VIZ-01, VIZ-03, VIZ-04

**Depends on:** 后端数据已就绪（coverageTrend、scenarioMatrix 已有）

**UAT:**
- 覆盖率趋势图正确显示每日数据
- 场景热力图显示模型×场景交叉数据
- 空数据时显示友好提示

---

### Phase 2: 模型详情可视化

**Goal:** 为选中的模型添加使用趋势图

**Requirements:** VIZ-02

**Depends on:** Phase 1（图表组件复用）

**UAT:**
- 切换模型时显示对应模型的使用趋势
- 趋势图有适当的加载状态

---

### Phase 3: 休眠模型与推荐标签

**Goal:** 展示从未触发的模型，优化推荐标签视觉

**Requirements:** DORM-01, DORM-02, REC-01, REC-02, REC-03

**Depends on:** 无

**UAT:**
- 休眠模型列表可折叠显示
- 推荐标签有颜色区分（reinforce 绿、rework 黄、archive 灰）
- 可按推荐类型过滤模型列表

---

### Phase 4: 事件上下文详情

**Goal:** 在最近事件中展示 toolContext、painContext、principleContext

**Requirements:** EVT-01, EVT-02, EVT-03, EVT-04

**Depends on:** 无（后端已返回这些数据）

**UAT:**
- 每个事件卡片显示工具名称、结果、错误类型
- painContext 和 principleContext 在存在时展示
- matchedPattern 显示触发的正则模式

---

### Phase 5: THINKING_OS.md 内容展示

**Goal:** 在详情页展示 trigger、antiPattern、workspace 路径

**Requirements:** TOS-01, TOS-02, TOS-03

**Depends on:** Phase 4（详情页布局优化）

**UAT:**
- 详情页显示该模型的触发条件
- 详情页显示禁止行为（anti-pattern）
- 页面头部显示 THINKING_OS.md 来源路径

---

### Phase 6: 模型对比模式

**Goal:** 支持选择 2+ 模型进行并排比较

**Requirements:** CMP-01, CMP-02, CMP-03

**Depends on:** Phase 3（推荐标签可视化完成）

**UAT:**
- 可选择多个模型进入对比模式
- 对比视图显示关键指标并排对比
- 使用趋势叠加显示

---

### Phase 7: 搜索与过滤

**Goal:** 模型列表支持搜索和排序

**Requirements:** SRCH-01, SRCH-02

**Depends on:** Phase 3（过滤基础）

**UAT:**
- 搜索框可按名称或场景过滤模型
- 排序切换按钮支持按 hits/成功率/名称排序

---

### Phase 8: THINKING_OS.md 一致性

**Goal:** 确保 THINKING_OS.md 模板包含全部 10 个 directive

**Requirements:** SYNC-01

**Depends on:** 无（独立任务）

**UAT:**
- 模板文件包含 T-01 到 T-10 全部 directive
- builtin patterns 与 THINKING_OS.md 内容一致

---

### 📋 Next Milestone

- [ ] Phase TBD: TBD (0/0 plans)

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 03 | v1.9.3 | 1/1 | Complete | 2026-04-09 |
| 01-08 | v1.10 | 0/8 | Not started | - |

---

**For full milestone history, see:** `.planning/milestones/`

*Roadmap created: 2026-04-09*
*Last updated: 2026-04-09 after v1.10 milestone started*
