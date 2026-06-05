# PRI-CR10：i18n 文案治理化 + 整体验收

**Type**: AFK
**Priority**: P2（收尾）
**Blocked by**: PRI-CR3, PRI-CR4, PRI-CR5, PRI-CR6, PRI-CR7, PRI-CR8, PRI-CR9
**必读**: `../01-shared-constraints.md`（E 文案、F 诚实约束、I DoD）、`PD_BRAND_CONSTITUTION.md` §9、§13 品牌审查清单

## 背景

各页落地后，统一治理化文案、清理 i18n、并对整套控制台做一次品牌+诚实验收，确保
零风格漂移、零功能错乱、零造假。

## What to build

1. **i18n 治理化**（`src/ui/i18n/en.json`、`zh-CN.json`）：
   - 删除所有废弃页面遗留的文案键（overview/evolution/gates/feedback(GFI)/agents/
     tasks/samples/thinking-models/central/eventLog 等）。
   - 全库扫描并替换 E 节禁止词（"燃烧痛苦/驱动进化/自动优化/一键进化/Burn pain/
     Evolve"等）。登录页 `slogan: "燃烧痛苦，驱动进化"` 必须替换。
   - 统一状态标签词表（草稿/待审查/已批准/已激活/已观察/需调整/已回滚/已归档）。
   - 中英文键完全对齐，无缺漏。
2. **api.ts 类型安全清理**（A.5）：替换所有 `as` 类型断言为运行时校验，
   新增 `src/ui/utils/validators.ts` 提供复用的类型守卫函数。这是 H 节的最终落地。
3. **整体验收**：对照 `PD_BRAND_CONSTITUTION.md` §13 品牌审查清单和本方案 F 节，
   逐页核对并在 PR 记录结论。

## Acceptance criteria

- [ ] `en.json` / `zh-CN.json` 无废弃页面文案键，无 E 节禁止词（含登录页 slogan）。
- [ ] 中英文键一一对应，无缺失；切换语言无 raw key 泄漏。
- [ ] `api.ts` 无 `as` 类型断言（A.5），所有后端数据解析使用 `validators.ts` 中的
      类型守卫函数（H 节）。
- [ ] 五个治理页 + 工具页逐页通过品牌审查清单（§13.1–§13.6）：单一核心信息、信息
      层级克制、信任机制（证据/审查/回滚/行为）、视觉克制、文案冷静、注意力保护。
- [ ] 逐页通过诚实约束 F：无假行为变化、无假聚合、无假健康面板、通道如实、有边界声明。
- [ ] 无残留 `fetchSystemHealth` 全局红点、无 DNA logo、无旧 SaaS 蓝、无硬编码色值。
- [ ] 全量构建测试：`cd packages/pd-console && npm run build && npm run test` 通过；
      `cd packages/principles-core && npm run build && npm run test` 通过；`npm run lint` 通过。
- [ ] 导航走查：5 治理页 + 工具页可达，废弃路由返回 404，钻取链路正确。
- [ ] 启动页 `/splash` 和登录页 `/login` 走查：认证 flow 正常、暗色模式正常、
      登录页 slogan 已替换禁止词。
- [ ] `/design-system` 预览路由仅在开发环境可访问（`import.meta.env.DEV`），
      生产构建不包含此路由。
- [ ] 暗色模式对比度审计：至少检查正文（`--ink` on `--paper`）、弱化文本
      （`--ink-4` on `--paper`）、按钮（`--gov` on `--surface`）、标签
      （`--ink-4` on `--surface`）在 light/dark 两个模式下的对比度 ≥ 4.5:1。

## 验收清单（PR 中逐条勾选并附证据）

```text
[ ] §13.1 核心判断：每页服务一个 Owner 判断
[ ] §13.2 信息层级：只暴露核心信息，默认封装复杂
[ ] §13.3 信任机制：证据来源/审查/回滚/行为变化可见，无"AI 替你决定"暗示
[ ] §13.4 视觉风格：克制、低噪音、留白、无霓虹/赛博/AI 大脑/机器人
[ ] §13.5 文案风格：冷静准确、无神化表达、用治理核心词
[ ] §13.6 注意力保护：减少理解负担、隐藏低价值信息、下一步清晰
[ ] F.1 无假行为变化指标
[ ] F.2 无假"反复/相似"聚合
[ ] F.3 无独立健康面板/全局红点
[ ] F.4 通道如实、无假选择控件
[ ] F.5 能力边界均有诚实声明
```

## MVP 三问

- **不做会怎样**：残留旧文案/禁止词/造假点，前功尽弃，品牌与诚实破防。
- **怎么观察**：i18n 文件 diff + 逐页验收清单。
- **怎么关闭**：文案层可回退；验收为只读检查。

## DoD

见 `../01-shared-constraints.md` I 节。
