# PRI-730 — runtime-v2 公共面收敛：Reality Audit（Phase 0）

> 日期：2026-09-10
> 基线：`origin/main` `f6a15c22b`（worktree `principles-PRI-730-surface-convergence`，分支 `ai/PRI-730-surface-convergence`）
> 性质：删除前的 Reality Audit。Phase 0 复杂度审计报告（`PD-complexity-reduction-audit.md`）只是调查输入，本文档所有结论均按最新 main 重新核实。
> 输入候选：① `runtime-selector.ts` ② `workspace-guidance-migration` ③ `story-a-demo` / `golden-trace` 导出面

---

## 1. Reality Audit

### Candidate A — `packages/principles-core/src/runtime-v2/runtime-selector.ts`

| 项目 | 结论 | 证据 |
| --- | --- | --- |
| 文件 | 67 行，纯接口 + 2 个 TypeBox schema，自述 "M1 ONLY: defines the interface. Implementation belongs to later milestones"（原 :11-12） | 文件本体（已删） |
| 全词消费者扫描（`rg "\bRuntimeSelector\b"`） | **0 consumer**：仅文件自身、`runtime-v2/index.ts` 桶导出（注释+schema export+type export）、根 `index.ts` re-export、`COMPONENTS.md` 一行组件表 | 全仓唯一非 core 命中是 `pd-console/.../ControlCenterPage.tsx` 的本地 UI 组件 `DefaultRuntimeSelector`——子串误报，与 core 符号无关 |
| `RuntimeSelection*` 类型/schema | 仅两处桶 re-export，无外部 import | `rg "RuntimeSelection"` 全仓 |
| 测试 / 动态加载 / package exports 子路径 | **0 test、0 dynamic import、0 子路径导出**（`packages/principles-core/package.json` exports 无此条目） | `rg -g "*.test.ts"` 零命中；`rg "import\(.*runtime-selector"` 零命中 |
| 文档依赖 | `COMPONENTS.md:215`（宣称 "🔵 Service ✅ 已建成"——与事实相反）、`PD_SYSTEM_ARCHITECTURE.md:154`（目录树行） | 两行随本次删除一并移除 |

**结论：DELETE（High confidence delete）。** 删除的假想"能力"（可插拔运行时选择器）从未存在实现；保留只会让 AI 与 Owner 误以为存在多运行时选择机制。

### Candidate B — `workspace-guidance-migration`（core 241 行 + plugin migrator 179 行）

| 项目 | 结论 | 证据 |
| --- | --- | --- |
| 调用链 | **活行为，非死码**：`plugin index.ts:354` 在 workspace 首次注册时调用 `migrateStaleWorkspaceGuidance` → `core/workspace-guidance-migrator.ts:139` → core `migrateWorkspaceGuidance`（公共桶导出） | `rg "migrateStaleWorkspaceGuidance"`：仅 index.ts 一个调用点 |
| 用途 | PRI-287（PR #768）一次性修复："post-upgrade cleanup for stale PLAN.md gate guidance"——用硬编码正则改写 workspace 内 AGENTS.md/THINKING_OS.md 里的远古文本（"PLAN.md (status: READY)"、"物理拦截" 等） | `git log --follow`：单提交起源；`runtime-v2/workspace-guidance-migration.ts:23-40` 规则表 |
| 是否启动热路径 | 是。每个 workspace 每个 plugin 进程生命周期执行一次（`startedWorkspaces` 内存守卫），OpenClaw 每次重启都会再跑 | `openclaw-plugin/src/index.ts:351-356` |
| 用户历史数据依赖 | AGENTS.md/THINKING_OS.md 是**运行时输入**（`hooks/prompt.ts` 将 THINKING_OS 内容注入 prompt），这就是当年要清洗陈旧指令的原因 | `rg "THINKING_OS"` 生产命中 |
| 当前模板是否仍产出陈旧文本 | **否**。installer/host 模板与 plugin init 模板中 "PLAN.md/物理拦截/Physical interception" 全部零命中 | `rg` 于 `create-principles-disciple/src`、`principles-core/src/host`、`openclaw-plugin/src/core/init.ts` |
| **删除后新装/存量 workspace 是否正常运行** | **是**。新用户模板干净、无感；存量 workspace 功能无影响，最坏情况是极老 workspace 文档里残留过期文本（纯外观，且停止被自动改写对用户数据更保守） | 推导自上述模板扫描 + 迁移器唯一副作用是文档文本改写 |

**结论：KEEP（本工单不动）→ Need owner decision。** 它是活行为（有运行时调用点），删除属于行为变更而非死码清理；残值极低（陈旧文本源已灭绝），可安全退役，但按任务纪律须 Owner 一句话确认。**顺带发现**：core 侧实现放在 `runtime-v2` 生产公共桶并在 plugin 启动热路径常驻，是"一次性迁移永不退役"的模式样本，退役收益约 −420 LOC + 启动路径减负。

### Candidate C — `story-a-demo` / `golden-trace` 公共导出

| 项目 | 结论 | 证据 |
| --- | --- | --- |
| story-a-demo 消费者 | **有生产消费者**：`pd-cli/src/services/demo-story-a-runner.ts` 导入 `STORY_A_CHANNELS` + 4 个类型，支撑已注册的 `pd demo-story-a` 命令 | `rg "StoryADemo\|STORY_A_CHANNELS"` 于 pd-cli src |
| golden-trace 消费者 | **深度接入内化生产路径**：`pd-cli rulehost-pipeline-runner.ts:234-243` 将 goldenTrace 传入 `evaluateInRefinerSandbox`（Artificer 评估沙箱）；`ArtificerRuleOutput` 契约含 `goldenTraceCases`；`pd-console` UI 展示；e2e spec + seed 脚本使用 | `rg "GoldenTrace"` 全仓（17 文件，跨 4 包） |
| 误报澄清 | Phase 0 报告中 installer 侧 "MvpChannel" 命中是 `create-principles-disciple/src/mvp-config.ts` **本地自有类型**，与 core story-a-demo 无关 | `create-principles-disciple/src/prompts.ts:5`（import 自 './mvp-config.js'） |
| 收窄导出可行性 | 消费者均经桶导入；收窄=强制跨包改 import 路径，行为零收益、纯 churn | 消费清单 |

**结论：KEEP（无收窄）。** Phase 0 的 "demo-only/实验资产" 假设被推翻——golden-trace 是内化链路的生产组件。这正是"审计不是事实源"的实证。

---

## 2. 风险评级

| 候选 | 删除收益 | 删除风险 | 推荐动作 |
| --- | --- | --- | --- |
| A runtime-selector | 消除"存在可插拔运行时选择器"的幽灵声明；公共桶 −4 符号；文档不再与事实矛盾 | 极低：0 消费者 0 测试 0 动态加载；删除已过全绿门禁（`verify:merge` exit 0，含 523 项 core 护栏测试） | **High confidence delete（本次执行）** |
| B guidance migration | 一次性迁移退役；启动热路径减负；−420 LOC | 低但非零：活行为变更（最老 workspace 的过期文档文本将不再被自动清洗） | **Need owner decision**（确认后可立独立小工单，非本 PR） |
| C demo/golden-trace 导出 | 无（收窄只产生跨包 churn） | 收窄本身破坏 4 包消费路径 | **KEEP** |

---

## 3. 给 Owner 的建议

建议删除：
runtime-selector

原因：
没有任何地方使用它，它承诺的"运行时选择"能力从未被实现，只是让每次读代码的人多理解一个不存在的机制。已通过全部合并门禁。

建议保留：
story-a-demo 与 golden-trace

原因：
golden-trace 不是演示资产，而是内化管线的真实生产组件（规则代码评估沙箱依赖它）；story-a-demo 支撑在册的 demo 命令。收窄导出只会带来跨包改动，没有实际收益。

待你决策：
workspace-guidance-migration

原因：
它还在每次插件启动时运行，但它要清洗的陈旧文本早已不再生成。可以退役（少一段常驻启动逻辑），但因为它是"活行为"，需要你确认后另开小工单删除；本次 PR 不动它。

---

## 4. 变更与验证记录（Phase 1）

变更（独立 commit，`refactor: remove unused runtime selector surface`）：
- 删除 `packages/principles-core/src/runtime-v2/runtime-selector.ts`
- `runtime-v2/index.ts`：移除 re-export 层级注释行、`RuntimeSelectionCriteriaSchema` export、`RuntimeSelector` 类型导出块
- 根 `index.ts`：移除 `// Runtime selector schemas` 导出块与 3 个类型 re-export
- `docs/architecture/COMPONENTS.md` / `PD_SYSTEM_ARCHITECTURE.md`：移除对应组件行/目录树行

验证：
- 删除前：全仓残留引用扫描清零（唯一命中为无关 UI 本地组件 `DefaultRuntimeSelector`）
- core 构建（tsc）exit 0
- `architecture-regression.test.ts`（520 tests，含 runtime-v2 public API barrel 套件）+ `barrel-io-cleanup.test.ts`（3 tests）全绿
- `npm run verify:merge`（生成物/手册/卫生/runtime-contract/文档结构/安全基线/目标矩阵测试/全量构建/lint/plugin+console+companion typecheck）**exit 0**

Complexity Delta：全部 NO（纯删除，无新事实源/状态/抽象/flag/依赖/外部能力）。
