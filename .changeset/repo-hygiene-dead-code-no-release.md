---
---

chore(repo): 删除无引用 UI 工具、退役实验残留与过期文档 —— 合并门禁恢复与仓库卫生（附：发布意图显式 no-release）

本 PR 触及 @principles/core 与 packages/pd-console/ 的文件路径，release-intent 守卫按路径规则保守命中（N-3 / N-5/C4）。经实质核查判定为 genuinely non-release-affecting，故按 SPEC §10.2 以官方空 changeset 显式声明 no-release，而非切 patch 版本：

- core 删除的 dimension-coverage-policy.ts 经全仓 import 图（解析相对路径、workspace 包 specifier、export * 别名链，未解析相对 specifier = 0）确认入度 0 / 出度 0，且无任何 barrel re-export（export * 链 ≤3 层全部展开核查）。其 dist 产物即使被 tsc 吐出也无任何可达 import 路径——删除不改变任何可达编译输出。
- pd-console 删除的 ui/utils/navigation.ts 0 import；被删前 pd-console typecheck 通过，删除后 typecheck 仍通过，bundle 输出无变化（app-sidebar 自内联 nav items，从不 import 它）。
- 两个 .vue 组件不在任何发布物内（theme/index.ts enhanceApp 注册了 11 个其他组件，不含它们；git grep 0 引用）。
- 2 个文档/配置改动（eslint ignores、vitest include）经 0 文件匹配验证，行为零变化。
- core build、pd-console typecheck、website 测试（24/24）与完整 verify:merge 在改动后全部 PASS——若存在真实 consumer 路径变化，这些必然先红。

先例与口径：PRI-885（Test Diet Phase 1B，PR #1817）对同属"零引用残留删除"类改动采用 archive/测试清理；pri-979-train-workbuddy-leg-no-release.md 为空 changeset 的既定写法。本次把证据写进本文件，以符合 release-intent 守卫"无豁免数据库、一切声明须可审计"的要求。
