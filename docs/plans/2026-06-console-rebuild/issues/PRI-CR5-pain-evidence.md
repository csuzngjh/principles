# PRI-CR5：行为证据页

**Type**: AFK
**Priority**: P2
**Blocked by**: PRI-CR1, PRI-CR2
**必读**: `../01-shared-constraints.md`（全节）、`design-prototype`（视觉 token 与卡片/inset 参考）

## 背景

重做原 `PainPage`，去掉 Flame/burn 心智，呈现"值得治理的行为证据"。对应品牌宪章
对 Pain 的定义（"Pain 不是每一次错误，而是值得治理的行为证据"）与 UX 规范 Page 2。

## What to build

实现 `PainEvidencePage`（路由 `/pain`），复用 `principles.ts` 现有 pain 相关数据
（**不新增后端回路**，沿用现有 route；若现有 route 不足，只做 G 节允许的返回结构
微调，并在 PR 说明）：

1. 每条 pain 证据卡（复用 CR1 卡片）：简短描述、发生场景、相关 Agent 行为、来源、
   是否建议生成原则。
2. **按单条呈现**；"是否反复出现/同类"如需展示，必须标注"自动同类识别为 post-MVP"
   （F.2），不做假聚合。
3. 证据详情走三层结构（D 节）：摘要 → 场景/行为 → 完整 trajectory 折叠。
4. 空/加载/错误态按 E 节文案。

> 注：`/report-problem`（产品反馈）是**另一个入口**，不在本页合并；本页是"系统捕获
> 的行为证据"，产品反馈是"Owner 对 PD 产品提意见"，两者语义不同（见 CONTEXT.md）。

## Acceptance criteria

- [ ] 视觉用 CR1 token，与 `design-prototype` 风格一致，无 Flame/burn 元素、无硬编码色值。
- [ ] pain 证据按单条呈现；无"第 N 次/相似任务"假聚合，必要处有诚实声明（F.2）。
- [ ] 详情遵循三层结构，完整 trajectory 默认折叠（D 节）。
- [ ] 数据沿用现有后端 route；若调返回结构，限于 G 节允许范围并在 PR 说明，不碰回路。
- [ ] 解析遵循 H 节；空/错误态有诚实文案。
- [ ] 中英文 i18n 完整。
- [ ] `cd packages/pd-console && npm run build && npm run test` 通过；`npm run lint` 通过。

## 实施提示

- 文案禁用"燃烧痛苦/驱动进化"等词（E 节）。标题用"行为证据"，不用"痛苦信号"的运营味。
- 若发现要做"反复识别"才像样——停止，那是 MVP5，按 F.2 诚实呈现单条即可。

## MVP 三问

- **不做会怎样**：Owner 看不到系统捕获了哪些值得治理的行为证据。
- **怎么观察**：打开页面见证据列表，可钻入查看 trajectory。
- **怎么关闭**：页面级，路由摘除即回退。

## DoD

见 `../01-shared-constraints.md` I 节。
