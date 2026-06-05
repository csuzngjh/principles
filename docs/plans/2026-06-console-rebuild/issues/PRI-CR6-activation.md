# PRI-CR6：生效情况页（Activation）

**Type**: AFK
**Priority**: P2
**Blocked by**: PRI-CR1, PRI-CR2, PRI-CR8
**必读**: `../01-shared-constraints.md`（全节，**尤其 F 诚实约束 + G.1 数据契约**）、`packages/pd-console/design-prototype/activation.html`（视觉参考）

## 背景

这是原 "Behavior Change" 的**重定义**（决策 C）。后端**没有**"行为是否改变"的可信
数据（语义匹配/触发计数属 MVP5，不存在），所以本页**不假装**显示行为变化，而是
诚实回答："我批准的原则，现在哪些真的在生效？" 数据源 = `activations` 表（经 CR8
的 `artifactId→principleId` join）。

## What to build

实现 `ActivationPage`（路由 `/activation`）：

1. **第一层（主信息）= 激活事实**：已批准原则列表，每条显示：已激活/未激活、
   通道（当前实际为 prompt）、动作/目标、`activatedAt`。数据来自 CR8 激活 route。
2. **诚实边界声明**（固定可见）："PD 暂无法统计原则在后续任务中被触发的次数，也
   无法自动判断行为是否改变（需要语义匹配/反馈闭环，post-MVP）。"（F.1/F.5）
3. **停滞信号联动**："已批准但从未激活"的原则在此高亮，并同步供首页停滞信号使用。
4. **第三层（可展开证据，仅当原则有 rule）**：lifecycle 指标（来自 CR8 的
   lifecycle-metrics route），**标注"规则质量信号，不等于行为变化"**，无 rule 时
   显示 `insufficientData` 的诚实文案，**绝不**作为主指标（F.1）。

## Acceptance criteria

- [ ] 页面主信息是激活事实（激活/未激活、通道、动作、时间），来自 CR8 激活 route。
- [ ] **无任何**触发/命中计数、无行为变化曲线、无合成分当主指标（F.1）。
- [ ] 固定展示能力边界声明（F.5）。
- [ ] "已批准但从未激活"可识别并高亮（接停滞信号）。
- [ ] lifecycle 指标仅作可展开第三层证据，且仅在原则有 rule 时显示并带"非行为变化"
      标注；无 rule 时 `insufficientData` 诚实文案。
- [ ] 视觉用 CR1 token，与原型一致，无硬编码色值。
- [ ] 解析遵循 H 节；空/错误态诚实文案。
- [ ] 中英文 i18n 完整。
- [ ] `cd packages/pd-console && npm run build && npm run test` 通过；`npm run lint` 通过。

## 实施提示（这是诚实红线最密集的页，务必克制）

- 页面命名/文案用"生效情况 / Activation"，**不要**叫"行为变化 / Behavior Change"，
  避免暗示后端有它没有的能力。
- 任何让这页"看起来行为变了"的冲动都要压住：宁可朴素诚实，不可漂亮造假。
- 等 MVP5 落地后，本页会自然进化为真正的 Behavior Change——但那是另一个工单。

## MVP 三问

- **不做会怎样**：Owner 无法看到"我批准的原则到底有没有在生效"（Reader Companion
  Q1/Q3 的核心诉求）。
- **怎么观察**：打开页面见已激活原则列表 + 边界声明。
- **怎么关闭**：页面级，路由摘除即回退。

## DoD

见 `../01-shared-constraints.md` I 节。
