# Roadmap: v1.1 WebUI 回路流程增强

## Overview

将 WebUI 从"功能视角"重构为"流程视角"。后端 API 先行，再构建按回路组织的 UI 页面，覆盖增强回路、反馈回路和 Gate 系统的完整流程。

**Milestone:** v1.1
**Started:** 2026-04-02
**Granularity:** Standard

---

## Milestones

- ✅ **v1.0-alpha** — Control plane cleanup (Phases 3A-3C, shipped 2026-03-26)
- 🔵 **v1.1** — WebUI 回路流程增强 (Phases 4-6, in progress)

---

## Phases

- [x] **Phase 4: Backend API Layer** — 7 个 API 端点，为所有 UI 页面提供数据基础 ✅
- [x] **Phase 5: Overview + Enhancement Loop UI** — 系统概览健康度卡片 + 增强回路完整页面 ✅
- [x] **Phase 6: Feedback Loop + Gate Monitor UI** — 反馈回路仪表盘 + Gate 监控页面 ✅

---

## Phase Details

### Phase 4: Backend API Layer
**Goal**: 所有 WebUI 页面可通过标准 HTTP API 获取完整数据，无需前端直接查询数据库或计算聚合指标
**Depends on**: Phase 3C (v1.0-alpha 已完成)
**Requirements**: API-01, API-02, API-03, API-04, API-05, API-06, API-07
**Success Criteria** (what must be TRUE):
  1. 调用 `GET /api/overview/health` 可获取 GFI、PainFlag、Trust、EP、原则分布、队列积压的聚合 JSON 数据
  2. 调用 `GET /api/evolution/principles` 可获取原则生命周期分布（candidate/probation/active/deprecated）和最近晋升/废弃记录
  3. 调用 `GET /api/feedback/gfi` 和 `GET /api/feedback/empathy-events` 可分别获取 GFI 实时趋势数据和同理心事件流
  4. 调用 `GET /api/gate/stats` 和 `GET /api/gate/blocks` 可获取 Gate 拦截分类统计和带时间戳的拦截历史记录
  5. 所有 7 个端点返回标准 JSON 格式，正确使用 HTTP 状态码（200/400/404/500），并在数据为空时返回合理的空结构而非 404
**Plans**: TBD

### Phase 5: Overview + Enhancement Loop UI
**Goal**: 用户在概览页一眼掌握系统全貌，在增强回路页理解从痛点到原则内化的完整链路（含夜间训练延伸）
**Depends on**: Phase 4
**Requirements**: OVERVIEW-01, OVERVIEW-02, OVERVIEW-03, OVERVIEW-04, OVERVIEW-05, OVERVIEW-06, OVERVIEW-07, LOOP-01, LOOP-02, LOOP-03, LOOP-04
**Success Criteria** (what must be TRUE):
  1. 概览页显示 6 张健康度卡片（GFI 值+阈值、PainFlag 状态、Trust Stage、EP Tier、原则分布、队列积压），每张卡片实时反映后端数据
  2. 概览页包含 Mini 流程图，可视化 痛点→GFI→Gate→队列→原则 链路，点击任意节点跳转到对应详情页
  3. 增强回路页展示 8 步流程指示器（痛点检测→诊断→原则生成→晋升→活跃→夜间反思→训练→内化），当前步骤高亮
  4. 增强回路页包含原则生命周期面板和夜间训练状态区（训练队列、Trinity 记录、Arbiter 通过率、ORPO 样本数、部署状态）
  5. 增强回路页展示痛点来源分布图，按 tool_failure/user_manual/subagent_error/user_empathy/session_reset 分类显示比例
**Plans**: TBD
**UI hint**: yes

### Phase 6: Feedback Loop + Gate Monitor UI
**Goal**: 用户通过反馈回路页监控 GFI 波动和同理心检测事件，通过 Gate 监控页掌握拦截情况和 Trust/EP 双轨进展
**Depends on**: Phase 4
**Requirements**: FEEDBACK-01, FEEDBACK-02, FEEDBACK-03, GATE-01, GATE-02, GATE-03
**Success Criteria** (what must be TRUE):
  1. 反馈页显示 GFI 实时仪表盘，包含当前值、动态阈值、今日峰值和小时级趋势折线图
  2. 反馈页显示同理心检测事件流（severity/score/reason/origin/gfiAfter）和 GFI→Gate 拦截关联记录
  3. Gate 监控页显示今日拦截统计面板，按 5 种类型（GFI拦截/Stage限制/P-03不匹配/绕过尝试/P-16豁免）分类计数
  4. Gate 监控页显示拦截历史列表（工具名+文件路径+拦截原因+GFI/Stage+时间戳）和 Trust & EP 双轨仪表盘
**Plans**: TBD
**UI hint**: yes

---

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 4. Backend API Layer | - | ✅ Complete | 2026-04-02 |
| 5. Overview + Enhancement Loop UI | - | ✅ Complete | 2026-04-02 |
| 6. Feedback Loop + Gate Monitor UI | - | ✅ Complete | 2026-04-02 |

---

## Coverage

| Requirement | Phase | Status |
|-------------|-------|--------|
| API-01 | Phase 4 | ✅ Done |
| API-02 | Phase 4 | ✅ Done |
| API-03 | Phase 4 | ✅ Done |
| API-04 | Phase 4 | ✅ Done |
| API-05 | Phase 4 | ✅ Done |
| API-06 | Phase 4 | ✅ Done |
| API-07 | Phase 4 | ✅ Done |
| OVERVIEW-01 | Phase 5 | ✅ Done |
| OVERVIEW-02 | Phase 5 | ✅ Done |
| OVERVIEW-03 | Phase 5 | ✅ Done |
| OVERVIEW-04 | Phase 5 | ✅ Done |
| OVERVIEW-05 | Phase 5 | ✅ Done |
| OVERVIEW-06 | Phase 5 | ✅ Done |
| OVERVIEW-07 | Phase 5 | ✅ Done |
| LOOP-01 | Phase 5 | ✅ Done |
| LOOP-02 | Phase 5 | ✅ Done |
| LOOP-03 | Phase 5 | ✅ Done |
| LOOP-04 | Phase 5 | ✅ Done |
| FEEDBACK-01 | Phase 6 | ✅ Done |
| FEEDBACK-02 | Phase 6 | ✅ Done |
| FEEDBACK-03 | Phase 6 | ✅ Done |
| GATE-01 | Phase 6 | ✅ Done |
| GATE-02 | Phase 6 | ✅ Done |
| GATE-03 | Phase 6 | ✅ Done |

**Mapped:** 24/24 ✓ | **Orphaned:** 0

---

*Last updated: 2026-04-02 (v1.1 milestone complete)*
