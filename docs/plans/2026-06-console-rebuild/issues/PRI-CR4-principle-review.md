# PRI-CR4：原则审查页（吸收 Approvals）

**Type**: AFK
**Priority**: P1
**Blocked by**: PRI-CR1, PRI-CR2, PRI-CR8
**必读**: `../01-shared-constraints.md`（全节）、`packages/pd-console/design-prototype/principle-review.html`（像素级视觉参考）

## 背景

这是 Owner 做最高质量判断的页面，吸收原 `ApprovalsPage` 与 `PrinciplesPage` 的
详情。一条原则的"审查"和"批准/拒绝"是**同一个判断动作**，合并为一页。多通道审批
记录在 UI 上**收拢成对一条原则的单次治理决策**（数据来自 CR8 聚合）。视觉以
`design-prototype/principle-review.html` 为准（含三层信息结构）。

## What to build

实现 `PrincipleReviewPage`（列表，路由 `/principles`）+ `PrincipleReviewDetail`
（详情）：

1. **列表**：待审查原则列表，复用 CR1 卡片，标签/通道/置信度 meta。
2. **详情（三层结构，D 节）**：
   - **第一层 结论**：大字陈述这条原则（"跨模块修改前，先向我说明范围…"）+ 一句
     "这是面向未来相似场景的行为政策，可批准/修改/拒绝/暂存"。
   - **第二层 为什么**：适用场景 / 预期行为 / 不适用场景 / 可能副作用（来自原则元
     信息）；来自哪些行为证据（编号证据列表）。
   - **第三层 完整轨迹**：`<details>` 默认折叠，展开显示 Evidence→诊断→提案→Owner
     审查→部署通道→可观察行为 的轨迹。
3. **通道如实呈现**（F.4）：显示"将通过 提示通道 激活 · 可回滚"，**不放**选通道/
   选强度控件。
4. **决策栏**（吸底）：批准 / 修改措辞 / 暂存 / 拒绝。
   - 批准 → 调 `approvals.ts` 的 `/approve`；拒绝 → `/reject`（必填理由，新建
     拒绝理由输入组件，复用交互语义但不复用旧组件文件）。
   - **「修改措辞」是 MVP3，后端无 modify 端点**：本工单将该按钮做成**禁用占位**，
     hover/旁注明确"原则修改将在后续版本开放"（F 诚实约束：不做假开关）。

## Acceptance criteria

- [ ] 视觉与 `design-prototype/principle-review.html` 一致（三层结构、inset、轨迹
      折叠、吸底决策栏），用 CR1 token，无硬编码色值。
- [ ] 一条原则一个审查页；多通道审批记录被收拢为单次决策（数据来自 CR8 聚合），
      Owner 不需要逐通道分别批。
- [ ] 批准/拒绝走现有 `approvals.ts` 端点；拒绝必填理由。
- [ ] 「修改措辞」为禁用占位且有诚实旁注；**不**伪造 modify 功能。
- [ ] 通道区只读如实，无选通道/选强度控件。
- [ ] 第三层轨迹默认折叠，不一进页面就铺全部字段（D 节）。
- [ ] 解析后端数据遵循 H 节；批准/拒绝失败有冷静错误文案（E 节）。
- [ ] 批准/归档使用 CR1 的 `ConfirmationBar` 组件（J.1），拒绝使用内联理由输入；
      所有写操作 Toast 包含"撤销"链接（J.2，使用 CR1 的 `UndoToast` 组件）。
- [ ] 中英文 i18n 完整。
- [ ] `cd packages/pd-console && npm run build && npm run test` 通过；`npm run lint` 通过。

## 实施提示

- 拒绝理由输入框需要新建（旧 `rejection-reason-dialog.tsx` 已在 CR2 删除），
  样式对齐 CR1 token 与原型，使用内联确认条模式（J.1）而非弹窗。
- 批准成功后给出"已批准 / 将通过提示通道激活"的冷静反馈，引导去"生效情况"页查看，
  **不要**承诺"行为已改变"。
- 不要把 lifecycle 合成分放进第一/二层；如要展示，仅作第三层可展开证据并标注（F.1）。

## MVP 三问

- **不做会怎样**：Owner 无法审查/批准原则，PD 治理核心动作缺失。
- **怎么观察**：进入详情可完成 批准/拒绝；列表状态更新。
- **怎么关闭**：页面级，路由摘除即回退；后端审批端点不变。

## DoD

见 `../01-shared-constraints.md` I 节。
