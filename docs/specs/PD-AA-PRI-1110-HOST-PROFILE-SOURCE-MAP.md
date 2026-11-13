# PRI-1110 — host/profile 配置来源只读核对表

- 基线：`origin/main` = `46cbdabc3f46d3a5994ea527b66bd9ab03111f02`
- 工作区：`D:/Code/_worktrees/principles/PRI-1110-adaptive-prep`（分支 `ai/PRI-1110-adaptive-prep`）
- 性质：**只读核对**。未修改任何生产代码；未新增 getter/抽象；主工作区未改动。
- 关联：SPEC v0.6 §5（profile 必须精确）、G0 设计 §2（`config_identity` 字段）。字段定义与示例值均以 SPEC v0.6 为准。

---

## 0. 结论（先说）

**当前没有现成的六字段统一画像，但已有字段来源可以复用。** 本表审计的是所列仓库代码，不能据此断言宿主 API 不具备相关能力。每份运行证据的 host 应来自当前执行它的适配器；工作区支持多个宿主不妨碍单条事件具有明确归属。其余字段须按各自语义连接现有来源，缺失保留 partial/unknown。

| 字段 | 来源是否单一 | 歧义点 |
| --- | --- | --- |
| `host` | 否 | 安装清单 `hosts[]`（可多宿主）／workspace 声明文件／各适配器硬编码字面量／DB 事件列；仅凭多宿主 workspace 清单无法选出单值；当前执行适配器的 hostKind 可提供本次事件归属，liveness 的歧义规则不外推到事件画像 |
| `hostVersion` | 否 | Codex 转录 `cli_version`（真实值）／安装期 `openclaw --version` 探测（不持久化）／`package.json` 声明兼容版本／liveness 契约的 `hostRuntimeVersion`（**不是宿主版本**，易误用） |
| `runtimeMode` | **代码中不存在该符号** | 3 个候选语义：注入 route（`legacy_trim`/`shared_render`）／共享宿主运行时 gate（on/off）／安装布局 mode（`canonical`/`legacy`）。SPEC §7 的“嵌入 vs Gateway / headless vs TUI / Desktop”**在代码里没有任何表示** |
| `pluginVersion` | 否 | 已安装根 `package.json.version`（运行期）／安装状态 `installStatus.productVersion`／更新流 registry `latestVersion`。前者读取失败静默变 `'unknown'` |
| `effectiveHookSetFingerprint` | 否 | 至少 5 个候选产生点；OpenClaw 有 registry↔`api.on` 一致性守卫，**跨宿主 hooks.json 模板与部署文件没有守卫**，会发散 |
| `evidenceCoverage` | 否（且不可完整计算） | 只能由 5 个 loader 的 ok/warnings 拼装；其中插件 `package.json` 读取**静默吞错**，无法区分“缺失”与“不可读”，因此不能仅凭该旧 getter 对配置来源宣称 complete；其他受控观测来源仍可另行核实 |

**实施口径（详见 §4）**：host 指本次执行宿主，hostVersion 指实际宿主版本；兼容声明、PD 契约号和产品版本不能代用。尚未接入的来源继续记未知。

---

## 1. 对照表（字段 × producer × consumer × getter × 单一权威源）

| 字段 | 主要 producer（`文件:行`） | 主要 consumer | 已有 getter | 单一权威源 |
| --- | --- | --- | --- | --- |
| `host` | ①`install-layout/src/index.ts:9-37`（`InstallManifest.hosts[]`）；②各适配器写 `.pd/host-tool-semantics/<hostKind>.json`（`host-tool-declaration.ts:97`，调用点 `codex-adapter/src/worker/workspace-worker.ts:476`、`workbuddy-adapter/src/worker/workspace-worker.ts:238`、`openclaw-plugin/src/service/internalization-auto-consumer-service.ts:68`）；③硬编码字面量（`openclaw-plugin/src/core/intervention-evidence-recorder.ts:55`、`codex-adapter/src/pd-hook.ts:407`、`workbuddy-adapter/src/pd-hook.ts:406`）；④`host-runtime/src/production-pain-evidence.ts:302-304,555`（建/写 `tool_calls.host_kind`） | `host-tool-semantic-resolver.ts:50`；`host-liveness-contract.ts:214`；`prompt-injection-projection.ts:95`；`pd-console/.../ActivationsConsoleModel.ts:665,669,695` | 有（**复数**）：`resolveWorkspaceHostToolSemantics(...).hostKinds`、`readWorkspaceHostKindFacts(...).hostKinds` | 否 |
| `hostVersion` | ①Codex 转录 `session_meta.payload.cli_version` → `codex-adapter/src/ingestion/transcript-decoder.ts:199` → 持久化 `host-runtime/src/governance-observation-store.ts:616-623`；②安装期探测 `create-principles-disciple/src/utils/env.ts:87-91`（只用于日志 `create-principles-disciple/src/index.ts:152`，**不落盘**）；③声明兼容版本 `openclaw-plugin/package.json:56`（`openclawVersion: "2026.4.4"`）、`codex-adapter/src/ingestion/codex-version.ts:22-23`；④命名陷阱 `host-liveness-contract.ts:8-9,51-52,81-82`（`version: 'openclaw-legacy@1'` 等，经 `hostRuntimeVersion` 字段暴露，`host-liveness-contract.ts:122,311,354`） | Codex 版本分类 `codex-version.ts`；Promotion liveness `resolvePromotionHostLiveness` 返回值字段 | 部分：`readGovernanceCheckpoint(...).cliVersion`（`governance-observation-store.ts:681,694`）；OpenClaw/WorkBuddy **无 getter** | 否 |
| `runtimeMode` | **无同名符号**。候选 A：`openclaw-plugin/src/index.ts:142` `shouldUseSharedHostRuntime`（shared vs `openclaw_legacy`）；候选 B：`host-runtime/src/prompt-injection-projection.ts:82,95`（`PromptInjectionRouteName = 'legacy_trim' \| 'shared_render'`，行 29）；候选 C：`install-layout/src/index.ts:4-5,271`（`canonical`/`legacy`/`missing`） | A：`openclaw-plugin/src/index.ts:320-323`（`runtimeGateFor`，用于 464/509/567）；B：`host-runtime/src/prompt-injection-projection.ts:95`、pd-console 激活页；C：`host-runtime/src/product-telemetry/service.ts:295`（`installMode`） | A/B/C 各自有 getter，但**都不是 `runtimeMode` 语义** | 否（3 个候选互不等价） |
| `pluginVersion` | ①`host-runtime/src/product-telemetry/service.ts:288-294`（读 `<pluginDir>/package.json.version`，截断 32 字符，失败 → `'unknown'`）；②`pd-console/src/server/routes/update.ts:50`（`installStatus?.productVersion`）；③同文件 `:51`（registry `latestVersion`） | 遥测 payload `product-telemetry/service.ts:406,533`；Console 更新页 | 无统一入口；`pd --version` 走 `create-principles-disciple/src/update/product-identity.ts:129` | 否（“当前已装”与“可升级到”混名） |
| `effectiveHookSetFingerprint` | **无同名符号**。候选：①`principles-core/src/runtime-v2/feature-flags/plugin-surface-registry.ts:25-88`（8 个 hook 面，5 个 `enabledByDefault`）；②`openclaw-plugin/src/index.ts:387,488,546,609,650,666,682,702`（8 次 `api.on`，其中 3 个 quiet 面被 `guardHook` 包成 no-op，`surface-guard-policy.ts:156`）；③`plugins/principles-disciple/hooks/hooks.json`（Codex 模板，5 个事件）；④`packages/workbuddy-adapter/plugin/hooks/hooks.json`（WorkBuddy 模板，5 事件，含 `PostToolUseFailure`）；⑤部署后合并文件：`codex-host-installer.ts` 写 `~/.codex/hooks.json`、`workbuddy-host-installer.ts:473` 写插件根 `hooks/hooks.json`；⑥遗留注册探测 `host-runtime/src/codex-legacy-registration.ts:27`（不可读时静默 `detected:false`） | ①→`checkSurfaceGuard()`/`isSurfaceEnabled()`（`surface-guard-policy.ts:75,120`）；②→实际 hook 执行；③④⑤→宿主派发 | 部分：`checkSurfaceGuard(...)` 与 `isSurfaceEnabled(...)`；**无跨宿主文件级 getter** | 否 |
| `evidenceCoverage` | **无同名符号**。可拼装来源：`host-runtime/src/pd-config.ts:15-22,75-109`（`source:'defaults'\|'user_config'\|'malformed'` + `warnings` + `errors`）；`install-layout/src/index.ts:164`（manifest `warnings`/`error`）；`host-tool-declaration.ts:140`（声明读取结果）；`host-liveness-contract.ts:214`；`product-telemetry/service.ts:267-273`（**静默 `undefined`**） | 无（概念不存在） | **无** | 否（不可完整计算） |

> 命名冲突提醒：`principles-core/src/runtime-v2/receipt-coverage.ts:78` 已有 `ReceiptEvidenceCoverage`（`sourceStatus: available/disabled/unavailable`、`validationStatus: valid/partial/malformed`）。它与 SPEC 的 `evidenceCoverage`（配置来源覆盖）**语义不同**，不要复用同名概念，否则会形成第二真相。

---

## 2. 逐字段明细（producer / consumer / getter / 测试）

### 2.1 `host`

1. **producer**
   - **安装清单（多宿主数组）**：`packages/install-layout/src/index.ts:9-37` 定义 `InstallManifest.hosts: InstallHost[]`（`INSTALL_HOSTS = ['codex','openclaw','workbuddy']`，行 6）。这是安装期的宿主注册，**允许 1..N 个**。
   - **workspace 级声明文件**：`packages/host-runtime/src/host-tool-declaration.ts:27` 目录名 `host-tool-semantics`，`:97` `saveHostToolDeclaration()` 写入 `.pd/host-tool-semantics/<hostKind>.json`；写入者见对照表②。文件名即 hostKind —— 由写入方硬编码字面量传入。
   - **事件级归属**：`packages/host-runtime/src/production-pain-evidence.ts:302-304,555` 把 `options.hostKind` 写进 `tool_calls.host_kind`；各适配器自己的字面量（`openclaw`/`codex`/`workbuddy`）是唯一输入。
   - **遥测归因**：`packages/host-runtime/src/product-telemetry/service.ts:282-287` —— 仅当 `manifest.hosts.length === 1` 才取 `hosts[0]`；否则若存在遗留扩展目录则回落 `'openclaw'`，否则 `'other'`。**注意这是单一 `hostKind`，且带遗留回落。**
2. **consumer**
   - 生产：`host-runtime/src/host-tool-semantic-resolver.ts:50`（合并多宿主语义）；`host-runtime/src/host-liveness-contract.ts:214`（读声明事实）；`host-runtime/src/prompt-injection-projection.ts:95`（route 决策）；`pd-console/src/server/models/ActivationsConsoleModel.ts:665,669,695`（`toolSemantics`）；`product-telemetry/service.ts:283-287`。
   - 测试：`host-runtime/tests/host-tool-semantic-resolver.test.ts:47-102`；`host-runtime/tests/host-liveness-contract.test.ts:67-258`。
3. **已有 getter**：`resolveWorkspaceHostToolSemantics(workspaceDir)`（`host-tool-semantic-resolver.ts:50`）与 `readWorkspaceHostKindFacts(workspaceDir)`（`host-liveness-contract.ts:214`）。**两者返回的都是 `hostKinds: string[]`，不是单值。**
4. **测试**
   - `resolveWorkspaceHostToolSemantics`：`merges multiple hosts...`（48）、`order independence`（66）、`single-host workspace resolves exactly that host`（84）、`missing declarations → structured refusal`（95）、`conflicting canonicalKind ... fails loud`（102）。
   - `resolvePromotionHostLiveness`：`codex and workbuddy declarations together stay multi-host ambiguous`（139）、`fails closed with an ambiguity reason when multiple hosts are declared`（151）、`openclaw.json ... alongside workbuddy evidence still fails closed`（223）等。
   - **结论：多宿主是既有、被测试保护的真实行为，不是异常。**

### 2.2 `hostVersion`

1. **producer**
   - **Codex（真实值，唯一可持久化的宿主上报）**：`codex-adapter/src/ingestion/transcript-decoder.ts:199` 从 `session_meta.payload.cli_version` 取出；`codex-adapter/src/ingestion/codex-version.ts:11-14` 明说“hook payload 不含版本字段，转录里才有”；落库 `host-runtime/src/governance-observation-store.ts:259,616-623`。
   - **OpenClaw（仅安装期探测）**：`create-principles-disciple/src/utils/env.ts:87-91`（`openclaw --version` / `clawd --version`），结果只用于 `index.ts:152` 的成功日志；**不写清单、不写 workspace 状态**。
   - **声明式兼容基线上限**：`openclaw-plugin/package.json:56`（`openclawVersion: "2026.4.4"`）；Codex 是 `CODEX_INGESTION_MIN_VERSION='0.148.0'` / `VERIFIED_VERSION='0.167.0'`（`codex-version.ts`，2026-11-13 依真实 0.167.0-alpha.4.1 抓包提升；比较只看 core triplet，prerelease 不参与判定）。
   - **命名陷阱（不是宿主版本）**：`host-liveness-contract.ts:8-9 / 51-52 / 81-82` 的 `version: 'openclaw-legacy@1' | 'codex-v2@1' | 'workbuddy-v1@1'` 是 **PD 契约版本**，经 `hostRuntimeVersion` 字段（`:122,311,354`）暴露。
2. **consumer**
   - 生产：`resolvePromotionHostLiveness`（`host-liveness-contract.ts:284`）把 `hostRuntimeVersion` 放进 liveness 结果；Codex 版本分类器（`codex-version.ts`）。
   - 测试：`host-runtime/tests/host-liveness-contract.test.ts:67-258`（断言的是 `hostRuntimeVersion` = 契约版本，不是宿主版本）。
3. **已有 getter**：`readGovernanceCheckpoint(args).cliVersion`（`governance-observation-store.ts:681,694`）—— **仅 Codex**。本次所列 PD 仓库路径未发现 OpenClaw / WorkBuddy 的运行期版本 getter；宿主自身 API 是否提供该信息仍为未知。
4. **测试**：Codex 版本分类有 `codex-version` 单测；本次未找到 OpenClaw hostVersion 的消费与对应测试（不等于宿主不存在该数据）。

### 2.3 `runtimeMode`

1. **producer**：代码中**不存在** `runtimeMode` 标识符（全仓 `rg runtimeMode`：源码 0 命中；仅 `pd-console/src/ui/utils/runtime-mode.ts` 这个**文件名**，其内容是 `IS_DEV` 构建标志，与宿主运行模式无关）。三个候选：
   - A `shouldUseSharedHostRuntime()`（`openclaw-plugin/src/index.ts:142`）→ `{enabled, source, rollbackReason}`，source 可为 `'openclaw_legacy'`；这是**注入实现路径**开关。
   - B `PromptInjectionRouteName`（`prompt-injection-projection.ts:29`）→ `legacy_trim` / `shared_render`，由 `promptRouteForHost(hostKind, flagEnabled)`（`:82`）与 `resolvePromptInjectionRouteDecision`（`:95`）产生。
   - C `InstallLayoutMode`（`install-layout/src/index.ts:4-5`）→ `canonical` / `legacy` / `missing`，由 `resolveInstallLayout`（`:271`）产生。
   - **D（SPEC §7 真正描述的那一维）**：OpenClaw 嵌入 prompt-build vs 普通 Gateway、Codex headless vs 交互式 TUI、WorkBuddy Desktop —— **代码中 0 表示**。`rg "embedded|gateway"` 在 `packages/**/*.ts` 无命中。
2. **consumer**：A → `index.ts:320-323` `runtimeGateFor`（用于 464/509/567）；B → `prompt-injection-projection.ts:95` 与 Console 激活投影；C → `product-telemetry/service.ts:295`（`installMode`）。D → 无。
3. **已有 getter**：A/B/C 各自有；D 无。
4. **测试**：`host-runtime/tests/prompt-injection-projection.test.ts:115-281`（覆盖 A/B 的 route 行为）；`install-layout` 有 layout 单测；D 无测试。

### 2.4 `pluginVersion`

1. **producer**
   - 运行期“已安装插件版本”：`packages/host-runtime/src/product-telemetry/service.ts:288-294` —— 读 `<pluginDir>/package.json`，失败则退回扩展目录 `package.json`，仍失败 → `'unknown'`。读取函数 `readJsonFile`（`:267-273`）**任何异常都返回 `undefined`（静默）**。
   - Console 当前版本：`pd-console/src/server/routes/update.ts:50` ← `installStatus?.productVersion`；可升级版本 `:51` ← `check.candidate?.productVersion`。
   - 构建期真源：`packages/openclaw-plugin/package.json` 的 `version`。
2. **consumer**：遥测 payload（`:406,533`）；Console 更新/历史页（`update.ts:50,51,75,76,93,231,238`）。
3. **已有 getter**：无统一入口。CLI 侧为 `principles-core/src/product-identity.ts:129`。
4. **测试**：`host-runtime/tests/product-telemetry-units.test.ts:575`（安装期版本/清单用例）；`principles-core/src/runtime-v2/__tests__/product-telemetry-contract.test.ts:118`（payload 契约）；`pd-console/tests/ui/cr10-api-validators.test.ts:640` 只是夹具（`pluginVersion: '1.999.0'`）。

### 2.5 `effectiveHookSetFingerprint`

1. **producer**（**没有该字段；以下均为候选“有效 hook 集合”的来源**）
   - ① `PLUGIN_SURFACE_REGISTRY`：`plugin-surface-registry.ts:25-88`，8 个 `hook:` 面，`enabledByDefault` 为 true 的 5 个（`before_prompt_build` 25、`before_tool_call` 33、`after_tool_call` 41、`llm_output` 49、`before_message_write` 84），quiet/关闭的 3 个（`before_reset` 57、`before_compaction` 66、`after_compaction` 75）。
   - ② 运行期注册：`openclaw-plugin/src/index.ts` 8 次 `api.on`（387/488/546/609/650/666/682/702），后 3 个为 quiet 面，被 `guardHook`（`surface-guard-policy.ts:156`）包成 no-op。
   - ③ Codex 宿主钩子模板：`plugins/principles-disciple/hooks/hooks.json` —— 5 个宿主事件（`PreToolUse`/`PostToolUse`/`UserPromptSubmit`/`SessionStart`/`Stop`）。
   - ④ WorkBuddy 宿主钩子模板：`packages/workbuddy-adapter/plugin/hooks/hooks.json` —— 5 个事件（`PreToolUse`/`PostToolUse`/`PostToolUseFailure`/`UserPromptSubmit`/`SessionStart`）；**与 ③ 的集合不同**。
   - ⑤ 部署后文件：`create-principles-disciple/src/installers/codex-host-installer.ts:4,18,22,85` 合并写 `~/.codex/hooks.json`（该文件自己声明“hooks.json is the canonical hook config — EP-06”）；`.../workbuddy-host-installer.ts:90,473` 写插件根 `hooks/hooks.json`。**部署文件可被用户或旧安装改写，与仓库模板漂移；且 Codex 把该文件当权威，而 OpenClaw 把进程内 registry 当权威 —— 同一“有效 hook 集合”概念在两个宿主上权威不同。**
   - ⑥ 遗留重复注册：`host-runtime/src/codex-legacy-registration.ts:27`（`detected` 状态；不可读时静默 `false`，可导致“遗留 hook 仍在”却判为无）。
2. **consumer**
   - 生产：①→`checkSurfaceGuard()`（`surface-guard-policy.ts:75`）/`isSurfaceEnabled()`（`:120`）；②→真实执行；③④⑤→宿主派发。
   - 测试：`openclaw-plugin/tests/integration/mvp-surface-registry-guard.test.ts`（**断言 `api.on` 注册集合与 registry hook 集合一致**）；`principles-core/.../feature-flags/__tests__/surface-guard-policy.test.ts`。
3. **已有 getter**：`checkSurfaceGuard()` 返回 `enabledCoreSurfaces` / `disabledNonCoreSurfaces`；`isSurfaceEnabled(surfaceId)`。**没有**“读取宿主部署文件并归一化出有效集合”的 getter。
4. **测试**：仅覆盖 ①②（OpenClaw 进程内）；③④⑤⑥ **无一致性测试**。

### 2.6 `evidenceCoverage`

1. **producer**：不存在。可拼装的现有状态来源：
   - `host-runtime/src/pd-config.ts:15-22`（`source: 'defaults'|'user_config'|'malformed'`、`warnings`、`errors`），`:75-109` 实际分支。
   - `install-layout/src/index.ts:164` `parseInstallManifest` 返回 `{manifest?, warnings?, error?}`。
   - `host-tool-declaration.ts:140` `loadHostToolDeclarations` 返回 ok/reason。
   - `host-liveness-contract.ts:214` `readWorkspaceHostKindFacts`。
   - `product-telemetry/service.ts:267-273` `readJsonFile`：**静默 `undefined`**（rc-9 风险）。
   - 能力声明（可视为“证据能力覆盖”的既有近似）：`openclaw-plugin/src/core/intervention-evidence-recorder.ts:55-82`、`workbuddy-adapter/src/workbuddy-evidence-recorder.ts`、`codex-adapter/src/codex-evidence-recorder.ts`（status: `supported`/`unsupported`/`unknown`）。
2. **consumer**：无。
3. **已有 getter**：无。
4. **测试**：无（该概念尚未存在）。`receipt-coverage` 的测试覆盖的是 receipt 数据的 `available/disabled/unavailable`，**不可当作本字段的测试**。

---

## 3. 已验证事实（可与主助手共享）

1. **多宿主是受支持且被测试保护的真实状态**：`resolvePromotionHostLiveness` 在 `codex.json+workbuddy.json` 同时存在时**故意 fail-closed**（`host-liveness-contract.test.ts:139,151`）。因此不能从工作区清单猜选当前执行宿主；运行证据应使用本次适配器的明确归属。
2. **`hostRuntimeVersion` ≠ 宿主版本**：它取的是 PD 契约常量（`'openclaw-legacy@1'` 等），见 `host-liveness-contract.ts:8-9,311,354`。
3. **所列 PD 仓库路径未提供 OpenClaw 运行期宿主版本 getter**：本次找到的版本探测来源是安装期 `--version` 探测，且只进日志（`env.ts:87-91` → `index.ts:152`）。
4. **Codex 的宿主版本只存在于转录**：hook payload 明确无版本字段（`codex-version.ts:11-14`），且需要转录摄取后才落库。
5. **`effectiveHookSetFingerprint` 的跨宿主来源不可比**：OpenClaw 是进程内 `api.on`（有 registry 守卫），Codex/WorkBuddy 是宿主 JSON 文件（无守卫，部署后可漂移）。
6. **插件版本读取失败是静默的**：`readJsonFile` 吞异常（`:267-273`），最终 `'unknown'`；无法区分“文件缺失”“JSON 损坏”“权限不足”。
7. **SPEC 的 `runtimeMode` 语义在代码中不存在**；全仓只有 3 个不等价的替代概念。

---

## 4. 歧义升级（需要主助手/Owner 裁决，不自行选型）

### A. `host`：单数 vs 复数
- 现状：workspace 级 getter 返回 `hostKinds: string[]`；多宿主被显式支持并 fail-closed。
- **最小反例**：同一 workspace 同时存在 `.pd/host-tool-semantics/openclaw.json` 与 `codex.json` → `hostKinds = ['codex','openclaw']`；工作区清单无法独立确定这次请求由谁执行；但本次 OpenClaw 适配器可为该条证据提供 host=openclaw。
- 实施结论：保持单值 host，绑定本次执行适配器；仅当当前事件缺少可信归属时记 unknown。不把安装清单改造成第二个运行宿主权威。

### B. `hostVersion`：四种候选
- **最小反例**（同一 OpenClaw 机器，同一时刻）：
  1. liveness getter → `hostRuntimeVersion = 'openclaw-legacy@1'`
  2. 安装期 probe → 例 `'OpenClaw 2026.10.10'`
  3. `package.json` 声明 → `'2026.4.4'`
  4. 若改用 Codex 路径 → `cli_version` 实值
  四个值互不相等。SPEC 只说“宿主版本”，未指定采用哪一个。
- 实施结论：只接受与本次实际运行实例绑定的宿主版本；声明兼容版本和 PD 契约版本不得代用。可复用的宿主 API/实例清单仍待核实，缺证写 unknown；安装时版本不能自动代表升级后的运行实例。

### C. `runtimeMode`：3 个候选 + 1 个缺失
- 候选 A（shared vs legacy 注入路径）与 B（`legacy_trim`/`shared_render`）**在同一进程内可以同时成立且不一致**：A 以 workspace 的 flag 决策为准，B 还接受调用方 `flagEnabled` 参数。示例：同一 workspace，A 判 shared 开启，而某调用点传 `flagEnabled=false` → B 判 `legacy_trim`。
- 候选 D（嵌入/Gateway、headless/TUI、Desktop）**代码中完全没有**，若要实现必须新增宿主上报，属于新能力而非“定位来源”。
- 需要裁决：SPEC §7 的“运行模式”到底指哪一维；这将直接决定是否需要新增宿主自报（当前 `hostVersion` 的缺口同源）。

### D. `evidenceCoverage`：静默读取使其不可判定
- `readJsonFile` 吞错 → 插件 version 来源无法区分“缺失”与“不可读”。若 `evidenceCoverage` 需要 `complete`，必须先补结构化失败原因（否则只能恒为 `partial`）。
- 另需裁决：是否允许把“能力声明表”（`supported/unsupported/unknown`）与“配置来源覆盖”合并为一个 `evidenceCoverage`。二者语义不同，合并会形成第二真相。

### E. 命名冲突
- `ReceiptEvidenceCoverage`（`receipt-coverage.ts:78`）已占用 `evidenceCoverage` 近义命名。建议 SPEC 显式区分（如 `configSourceCoverage`），否则实现期极易误接。

---

## 5. 未知清单（含“缺什么证据才能确定”）

| # | 未知 | 缺什么证据 |
| --- | --- | --- |
| U1 | OpenClaw 是否有可在 hook 进程内获得的版本 API（除安装期 probe） | 需读 OpenClaw 官方插件 API 文档或真实宿主实验；本轮禁止运行实验 |
| U2 | WorkBuddy 是否有任何宿主版本信号（源码中 0 命中） | 需 WorkBuddy 插件 API 文档或真实宿主上报样本 |
| U3 | OpenClaw 是否也支持文件式 hooks 声明（而非仅进程内 `api.on`） | 需 OpenClaw 安装目录真实文件清单；本轮禁止安装/探针 |
| U4 | `runtimeMode` 在 SPEC §7 的确切所指（嵌入/Gateway 等） | SPEC §7 已定义宿主运行模式维度；需核实所选入口能否提供相应事实，不用注入 route 或安装布局代替 |
| U5 | `installStatus.productVersion` 的上游写入方 | 需读 `update-authority` / 安装状态写入路径；本轮未展开（避免越界到 PRI-1106 范围） |
| U6 | 部署后的 `~/.codex/hooks.json` 与仓库模板是否一致 | 需真实部署机器上的文件；本轮禁止访问生产/安装目录 |
| U7 | `before_message_write` 在非 OpenClaw 宿主是否存在对应事件 | 需 Codex/WorkBuddy 钩子事件文档 |
| U8 | `evidenceCoverage` 的枚举是否与 `ReceiptValidationStatus`（`valid/partial/malformed`）同构 | 已确定为不同语义：配置来源用 complete/partial/unknown，receipt 继续使用自身状态，不作枚举转换 |

---

## 6. 本轮证据边界

- 仅静态源码阅读 + 既有测试阅读；**未运行任何测试、未运行宿主实验、未读取 `~/.pd` / `~/.openclaw` / 生产库**。
- 未修改主工作区；未触碰其他会话 worktree；未开 PR、未合并。
- 本文件为唯一交付物，未改动任何生产代码。

## 7. 主助手审查修订

本表是给定基线的静态源码定位，未运行测试。审查修正了两项推断越界：工作区多宿主不等于运行事件无宿主归属；未发现 PD getter 不等于宿主运行时 API 不可用。现有适配器身份和读取逻辑优先复用，不因缺少统一画像而新建配置平台。声明完整配置仍须具备与本次实例绑定的来源覆盖证据。
