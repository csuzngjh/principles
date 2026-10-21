# SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 实施报告

**日期：** 2026-10-20
**分支：** `ai/SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001-model-aware-prompt-budget`
**基线：** `origin/main` `a57cc3e07ab860e4c646d8f5fc5366d49fc88e97`
**PR：** #2093
**SPEC：** `docs/specs/SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001.md`

## A. 实际实现

**调用链（一次请求一次解析）：**

- OpenClaw plugin-local：`handleBeforePromptBuild`（prompt.ts，Runtime V2 段）→ `resolvePromptBudget({hostCapacity: ctx.contextTokenBudget/contextWindowSource, modelIdentity: ctx.modelProviderId/modelId, catalog: getPromptModelCatalog()})` → `trimToBudget(dedupedV2, budgetChars, …)` → 事件 `budget` + 来源字段。
- 共享路径：OpenClaw `dispatchBeforePromptBuild` → `openclaw-host-runtime.dispatch`（把 hook ctx 的模型事实映射进 `HostEventContext.modelContext`）/ Codex·WorkBuddy 解码器（保留已验证 `model`）→ `createProductionHostRuntime.beforePromptBuild` → `resolvePromptBudget(event.context.modelContext + 内置目录)` → `buildActivePrinciplePromptContext({promptBudget})` → 事件携带 `budget/budgetCapacitySource/budgetCapacityStatus/budgetContextWindowTokens`。
- 投影/预检/状态面：`buildLivePromptInjectionProjection(promptBudget?)`、`checkPromptArtifactDeliverability`（档位判定）、`readPromptActivationInjectionStatuses`（budget=projection.budget；oversized 仅 >16000；tier 判定先行——(1250,2000] 中带即使装入回退估算窗口也报 `model_dependent`，见文末修复轮附录）。

**算法与优先级（§4.3，单一实现 `resolvePromptBudget`）：**
1. 宿主有效窗口，来源 ∈ {model, modelsConfig, agentContextTokens}（`default`/未知/缺失不信任→下沉）；
2. 已安装 Pi AI 1.2.0 目录精确 `provider+modelId`；
3. 固定 2000 回退（`legacy_fallback`/`unknown` + 闭合 10 码原因码）。（v0.2 修复轮：原第 3 级"无 provider 同名一致"档已删除——名称一致无法排除自定义端点，永不 confirmed。）
公式 `min(16000, max(1250, floor(2000×W/128000)))`（下限 1250 实测锚定，上限 16000 为 Owner 目标边界）；拒绝 0/负/非整/非有限/越界（<1024 或 >1e8）容量值；`maxTokens` 从不参与（目录缝只暴露 contextWindow）。

**宿主接入状态：**

| 宿主 | 容量来源 | 动态支持 | 证据 |
|---|---|---|---|
| OpenClaw | Hook `contextTokenBudget`（来源门控）+ 目录回退 | ✅（可信窗口/目录） | host-runtime 集成测试（真实 dispatch）；上游枚举经上游 main 源码同步 |
| Codex | 已验证 `model` id → 目录 | ⚠️ 仅目录可解析时 | 真实 v0.162.1 夹具测试；`gpt-6-astra` 目录矛盾→回退实证 |
| WorkBuddy | observed-optional `model`（软消费） | ⚠️ 仅目录唯一匹配 | 解码测试（缺席/空串/非串不阻塞）；无容量字段，不伪造 |

## B. 证据

- 单元/集成测试：core 22/22（含真实目录契约）；host-runtime 全量 535/535（新增 10）；codex-adapter 303/303（新增 5）；workbuddy-adapter 160/161；pd-console 2867/2868（1 expected fail）；pd-cli 1974/1976；openclaw-plugin 205 文件通过 + 4 失败文件全部取证。
- 测量（真实生产构建器，可复现脚本扩展，v0.2 重生成含自报开/关两态）：`docs/audit/PD_PROMPT_CAPACITY_MEASUREMENT_MODEL_AWARE_2026-10-20.{md,json}` — 32K→1250(共享 2 条，修复前 0)/64K→1250/128K→2000(11.5=历史基线)/256K→4000/1M→15625(公式精确值，16 条不截断)/≥1.024M→16000 触顶/unknown≡128K；共享路径真实 dispatch 四情景预算来源+原因码证据。
- 预存在失败取证（均在纯基线 `a57cc3e07` 复现，与本改动无关）：
  - `workbuddy-bdd` admission 置信度场景（主 checkout 基线同败）；
  - `principle-application-ledger` 两场景 afterEach `fs.rmSync` Windows EPERM（基线 detached 复跑同败，断言本体通过）；
  - `template-anti-regression` tar 提取（MSYS tar 对反斜杠路径转义，基线同败）；
  - `auto-consumer-evidence-port`：插件 dist 重建后通过。

## C. 测试

执行命令（要点）：各包 `npx vitest run`（全量或定向）、`npx tsc --noEmit`、`npx eslint`（受影响文件零 error）、五包 `npm run build`（dist-hygiene OK）、`node packages/pd-cli/scripts/prompt-capacity-measurement.mjs`、`node scripts/release/check-pr-release-intent.mjs`（PASS）。未执行：真实宿主 E2E（本机无 OpenClaw ≥2026.4.4 装机，见 D/限制）；完整 `verify:merge` 留给 CI。

## D. 一致性审计（§6.1 覆盖清单）

| 消费点 | 同一预算政策 | 证据 |
|---|---|---|
| `trimToBudget` | ✅ 收解析值 | prompt.ts / 投影 / 测量 |
| `buildActivePrinciplePromptContext` | ✅ `promptBudget` 入参，缺省=固定回退解析 | 4 处常量全替换 |
| `buildLivePromptInjectionProjection` | ✅ 同一 resolution 两路由透传 + 来源外显 | 集成测试 |
| `checkPromptArtifactDeliverability` | ✅ 档位判定（≤1250/(1250,16000]/>16000），生产序列化器计费 | 边界测试 1250/1252/16000/16002 |
| `readPromptActivationInjectionStatuses` | ✅ budget=projection.budget；oversized 仅 >16000；`model_dependent` 新态（tier 判定先行，中带保留窗口事实） | 测试（含 (1250,2000] 带回归） |
| 注入事件（两发射点） | ✅ 记录实际执行 budget+来源（修掉共享路径事件预算硬编码漂移） | dispatch 测试 + TypeBox 校验 |
| Console/CLI 预检反馈 | ✅ 徽标区分"模型上下文解析/固定回退"；CLI notice 走 stderr（cli-1） | console/cli 测试 |

计费口径不变：list=选中行、shared=完整渲染；serializer/路由公式原样复用。

## E. 代码审查（主代理自审）

- 发现并修复：① 共享路径事件 `budget` 硬编码常量（动态化后会漂移）→ 改记实际执行值；② CLI `--json` 模式 model_dependent notice 污染 stdout（cli-1 违规）→ 改 stderr；③ `candidatePromptBudgetTierFit` unconfirmed-perHost 聚合把"全宿主 fits_all_tiers"误归 model_dependent → 三态聚合；④ lint（prefer-destructuring ×2、no-use-before-define）。
- 遗留风险：共享路由模板头 ~750c 使"全档位可装入"在 shared 路由几乎不可达（真实原则多为 model_dependent）——这是 §6.3 的诚实后果，UI 文案已适配；OpenClaw 真实 Hook 字段取值待装机环境实证。

## F. 交付状态

分支 `ai/SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001-model-aware-prompt-budget`（首报时 head `7ff90dfbc`；随后经 Owner 修复轮与 CodeRabbit 评审轮，最新 head 见 PR 页）已推送；PR #2093 已创建；changeset 声明 7 包（core/host-runtime minor，其余 patch + 安装器）；release-intent 守卫本地 PASS；CI 逐 head 收敛情况见 PR checks（AI 不合并，Owner 终审）。

**已知限制：** WorkBuddy 无权威容量字段（仅目录唯一匹配动态）；Codex 实际模型 id 当前目录矛盾→恒回退；预算=模型总窗口的政策函数，非请求剩余上下文；行为对齐效果未测（SPEC 明示）。

---

## 修复轮附录（v0.2，2026-10-20/21）

Owner 修复轮（head `2ce841d6f`）与 CodeRabbit 评审轮对上文的首报内容做了如下修订，**以本附录为准**：

1. **下限 500 → 1250（实测锚定）**：共享路由单条最小有效原则（86 字符）完整渲染 849 字符（自报关）/ 1204 字符（自报开）——500 下限使 32K 档注入 0 条（已审计缺陷），1000 在自报开启时同样零注入。32K 档现于两种自报状态下均 ≥1 条完整注入（回归测试钉住；测量表 0→2 条）。
2. **上限 4000 → 16000（Owner 目标边界）**：1M 档按公式精确为 15625（≥1.024M 触顶）；档位分类、预检、状态面、Console/CLI、测量脚本与 SPEC v0.2 全部同步。
3. **删除无 provider 同名一致档**（`pi_catalog_unambiguous`）：无 provider 查找一律回退；Codex `gpt-6-astra`（目录跨 provider 矛盾）与 WorkBuddy（无 provider 身份）恒定诚实回退并携带区分性原因码（`catalog_ambiguous_model_id` / `catalog_provider_absent`）。
4. **原因码闭合枚举入事件**：`budgetFallbackReason`（可选字段，10 码闭集）经共享路由 result/projection 传播至注入事件；宿主仅携带模型 id 无容量声明时报 `host_capacity_absent` 而非 `source_untrusted`。
5. **跨宿主聚合单调化**：仅全部适用宿主都超上限才判 `exceeds_max_tier`（列表比共享少计约 718 字符包装成本，混合判定真实可达）；15400 字符真实数字反例集成测试。
6. **状态面 tier 判定先行**（CodeRabbit 评审）：`(1250, 2000]` 中带条目即使装入回退估算窗口也报 `model_dependent`（保留 inCurrentWindow 窗口事实），与审批预检对同一工件的判定一致，不再无条件报 `injectable`。
