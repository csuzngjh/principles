# Console 重做执行方案：总览（2026-06）

> **状态**: Draft for owner review / 待发布到 Linear
> **日期**: 2026-06-04
> **主决策**: ADR-0017 Console 表现层重建（背景参考，未提交；关键决策已纳入本文档）
> **上位约束**: [ADR-0014](../../adr/0014-mvp-first-strategy-and-product-pivot.md)、[PRODUCT_IDENTITY.md](../../../PRODUCT_IDENTITY.md)
> **品牌/UX 权威**: [PD_BRAND_CONSTITUTION.md](../../brand/PD_BRAND_CONSTITUTION.md)、[PD_UX_PRINCIPLES.md](../../brand/PD_UX_PRINCIPLES.md)
> **领域语言**: packages/pd-console/CONTEXT.md（背景参考，未提交；关键术语见 01-shared-constraints.md E 节）
> **重做规格**: packages/pd-console/REDESIGN.md（背景参考，未提交；关键规格已纳入 01-shared-constraints.md）
> **视觉原型**: packages/pd-console/design-prototype/（本地参考，未提交；token 基准见 01-shared-constraints.md B 节）
> **设计方向**: Blueprint — 技术蓝图风格，冷调中性、锐角几何、等宽字体点缀、默认无阴影
> **共享实施约束（每个工单必读）**: [01-shared-constraints.md](./01-shared-constraints.md)

## 1. 这是什么

把 PD Web 控制台从"运营/进化仪表盘"心智，重建为"治理工作台"（Governance
Workspace）。这是一次**表现层重建**：重写 `packages/pd-console/src/ui`，按需调整
后端 route/model 的返回结构，**不重写后端数据访问层**。

决策来源是一次 grill-with-docs 评审，完整决策日志见 `REDESIGN.md §7`。

### 1.1 工程实施方式

- **技术栈**：沿用现有 React 19 + react-router-dom 7 + Tailwind 4 + shadcn/ui +
  react-i18next + sonner，唯一新增 `@fontsource/jetbrains-mono`。详见
  [01-shared-constraints.md §A.1](./01-shared-constraints.md)。
- **分支策略**：单分支 `feature/console-rebuild`，CR1→CR10 依次完成，Owner 手动
  合并到 main。详见 [§A.9](./01-shared-constraints.md)。
- **旧代码处理**：CR2 统一删除废弃页面/路由/组件/Model，不保留双套实现。
  详见 [§A.8](./01-shared-constraints.md)。
- **目录结构**：页面按 IA 分目录（`pages/focus/`、`pages/pain/` 等），新增
  `components/layout/`、`components/governance/`、`components/auth/` 目录。
  详见 [§A.3–A.4](./01-shared-constraints.md)。

## 2. 为什么（一句话）

当前控制台用 `Burn pain, drive evolution` 标语、DNA logo、Diagnostics 区、
GFI/Trust 监控等编码了一个错误心智，违反品牌宪章 §1.2/§14.3，让 Owner 无法
进入"慢思考、做高质量治理判断"的状态。

## 3. 范围边界（必须严守）

**本方案做（表现层 + 必要数据契约调整）**：
- 重建 `src/ui`：5 个治理页 + 工具页 + 全新 IA/视觉/文案/i18n。
- 删除编码错误心智的页面及其后端 route。
- MVP6：新增一条 route 暴露已计算但未暴露的 lifecycle 指标。
- 必要时调整被复用 Model 的**返回结构**（数据契约微调），如 activation 的
  `artifactId → principleId` join。

**本方案不做（独立 core/plugin 工单，已在 REDESIGN §2 列明）**：
- MVP2（abstractedPrinciple 非强制）、MVP3（modify / RejectionFeedback / 审批
  粒度）、MVP4 + 通道治理（版本链回滚、shadow mode、Owner 选通道/强度）、
  MVP5（语义匹配 / 触发计数 / 反馈闭环）。
- **再漂亮的 UI 也修不了这些**；把它们塞进本方案 = 违反 ADR-0014。

**允许的范围蔓延**：仅限"后端能诚实产出数据、且直接提升种子客户体验"处
（Owner 已批准）。危险蔓延（触发计数、语义匹配）一律挡在 post-MVP。

## 4. 工单总图与依赖

```text
PRI-CR1 (视觉基线/design tokens + 组件库)  ──┐  无依赖，最先做
PRI-CR2 (导航骨架 + 删除废弃页/路由)      ──┤  依赖 CR1
                                            │
   ┌────────────────────────────────────────┘
   ▼
PRI-CR3 治理焦点（首页判断队列）   依赖 CR1,CR2,CR8(审批聚合)
PRI-CR4 原则审查（吸收 Approvals） 依赖 CR1,CR2,CR8(审批聚合)
PRI-CR5 行为证据                   依赖 CR1,CR2
PRI-CR6 生效情况（Activation）     依赖 CR1,CR2 + CR8(数据契约)
PRI-CR7 原则债务                   依赖 CR1,CR2,CR8(激活join)
PRI-CR8 后端数据契约调整(MVP6+join) 依赖 CR2，被 CR3/CR4/CR6/CR7 消费
PRI-CR9 工具页对齐(控制中心/设置/反馈/更新) 依赖 CR1,CR2
PRI-CR10 i18n 文案治理化 + 收尾验收  依赖 CR3-CR9
```

## 5. 工单清单

| 工单 | Linear | 标题 | 类型 | 优先级 | 依赖 |
|------|--------|------|------|--------|------|
| [PRI-CR1](./issues/PRI-CR1-design-system.md) | — | 视觉基线：design tokens + 基础组件 | AFK | P0 | 无 |
| [PRI-CR2](./issues/PRI-CR2-nav-and-deletion.md) | — | 导航骨架 + 删除废弃页与路由 | AFK | P0 | CR1 |
| [PRI-CR3](./issues/PRI-CR3-governance-focus.md) | PRI-319 | 治理焦点页（首页判断队列） | AFK | P1 | CR1,CR2,CR8 |
| [PRI-CR4](./issues/PRI-CR4-principle-review.md) | PRI-315 | 原则审查页（吸收 Approvals） | AFK | P1 | CR1,CR2,CR8 |
| [PRI-CR5](./issues/PRI-CR5-pain-evidence.md) | PRI-316 | 行为证据页 | AFK | P2 | CR1,CR2 |
| [PRI-CR6](./issues/PRI-CR6-activation.md) | PRI-320 | 生效情况页（Activation） | AFK | P2 | CR1,CR2,CR8 |
| [PRI-CR7](./issues/PRI-CR7-principle-debt.md) | PRI-317 | 原则债务页 | AFK | P2 | CR1,CR2,CR8 |
| [PRI-CR8](./issues/PRI-CR8-backend-data-contract.md) | PRI-314 | 后端数据契约调整（MVP6 指标 + 激活 join） | AFK | P1 | CR2 |
| [PRI-CR9](./issues/PRI-CR9-tool-pages.md) | PRI-318 | 工具页对齐（控制中心/设置/反馈/更新） | AFK | P2 | CR1,CR2 |
| [PRI-CR10](./issues/PRI-CR10-i18n-and-acceptance.md) | PRI-321 | i18n 文案治理化 + 整体验收 | AFK | P2 | CR3–CR9 |

## 6. 执行纪律（每个工单开工前）

1. 读 `AGENTS.md`、`docs/ERROR_PATTERN_INDEX.md`，并按 Handbook Gate 选读相关
   ERR 条目（前端数据解析重点：ERR-001/005/009 的 `as` 绕过校验类）。
2. 读本方案 `01-shared-constraints.md` **全部 A 节**（技术栈、目录结构、旧代码
   删除清单、api.ts 清理计划、主题系统切换方式、分支策略）和 B–K 节（设计 token、
   组件契约、文案规则、诚实约束、交互模式、可访问性）。
3. 读对应工单的 What/Acceptance/三问。
4. 任何工单若发现需要碰 MVP2–MVP5 的后端回路，**停止并回报**，不要顺手扩范围。
5. CR2 开工前，确认 pd-cli 是否依赖任何将被删除的路由（见 §A.11）。

## 7. 完成定义（整体）

- 5 个治理页 + 工具页全部按原型视觉基线落地，零风格漂移。
- 废弃页面与对应 route 删除干净，无死引用、构建通过。
- 所有"能力边界"如实声明（无假数据、无假聚合、无假指标）。
- `cd packages/pd-console && npm run build && npm run test` 通过；`npm run lint` 通过。
- 中英文 i18n 完整、措辞符合治理化文案规则。
