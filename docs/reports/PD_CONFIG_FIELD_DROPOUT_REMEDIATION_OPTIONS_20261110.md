# 配置字段静默丢弃：结构性修法方案与影响面

- 日期：2026-11-10
- 状态：**只出方案与影响面，未实施**
- 关联：`docs/plans/2026-11-10-architecture-complexity-remediation-plan.md`（Phase 3A / 事故 #2）
- 结论级别：给 Owner 决策的输入，不是排期

---

## 0. 结论先行

1. **今天的问题不是"漏了 `systemPrompt` 一个字段"，而是一类结构**：
   `validatePdLocalProfile` 用"逐字段读取 + 逐字段写回"构造结果对象，且**不校验未知键**。
   于是"类型里有、构造时忘了写"与"配置里写了、类型里没有"两种漏法**都不报错**。

2. 已核实今天**静默丢 2 个字段**，不是 1 个：

   | 字段 | 位置 | 是否有人读 |
   | --- | --- | --- |
   | `systemPrompt` | `PdLocalRuntimeProfile` | 是：[pd-config-agent-binding.ts](file:///d:/Code/principles/packages/principles-core/src/runtime/config/pd-config-agent-binding.ts#L277-L279) |
   | `splitPipelineTimeoutMs` | `InternalAgentBinding` | **否**（全仓只有类型声明 `pd-config-types.ts:145`） |

   第二个字段说明这类 bug 不是一次手误：**没有消费者也能在类型里存活**，而校验器会把它静默丢掉。

3. 同一份文件里，**5 个 section 已经实现了"未知键 fail loud"**（`internalAgents` / `workspace` / `contextInjection` / `reuseEvaluation` / `promptBudget`）。
   `runtimeProfiles[*]` 与 `features[*]` 是仅有的例外。
   按 P2.1（Connection Before Creation），这是**把已有的模式接上**，不是新建一套机制。

4. 推荐：**方案 C（构造后"输入键 ⊆ 输出键"自检，fail-loud）+ 一张显式排除表**。
   排除表今天应为**空集**，并且"为空"本身要有测试与注释。
   方案 A（显式排除表 + 整体透传）作为**可选第二步**；方案 B（schema 生成）**不在配置层做**，转成 `validators.ts` 的独立立项。

5. 关于"以后新加字段还能不能受保护"：**运行时测试保不住新增构造点，编译期穷尽表才是唯一可靠信号**。
   三种方案都做不到"新加一个 validator 不写测试也会红"；能做到的是"新加一个字段不改表就编译失败"。第 4 节给出具体写法。

---

## 1. 已核实的事实（Implementation Truth）

### 1.1 类型规模与今天的丢失点

`PdLocalRuntimeProfile`（`pd-config-types.ts:83-118`）共 **10 个**字段：
`type` / `provider` / `model` / `apiKeyEnv` / `baseUrl` / `timeoutMs` / `maxRetries` / `maxTokens` / `reasoning` / `systemPrompt`。

`validatePdLocalProfile`（`pd-config-validate.ts:219-317`）逐个读取并校验上面前 9 个，然后在 `:305-316` 写回 9 个 —— **`systemPrompt` 从头到尾没有出现过**（全文件 `systemPrompt` 命中 0）。

### 1.2 全部"白名单构造"点

这是 `pd-config-validate.ts`（932 行）里所有"从 `Record<string, unknown>` 造出一个带类型对象"的位置：

| # | 位置 | 产出类型 | 今天是否丢字段 | 是否有未知键守卫 |
| --- | --- | --- | --- | --- |
| 1 | `:212-216` `validateOpenClawProfile` | `OpenClawRuntimeProfile` | 否（类型只有 4 个字段，都写了） | 否 |
| 2 | `:305-316` `validatePdLocalProfile` | `PdLocalRuntimeProfile` | **是：`systemPrompt`** | 否 |
| 3 | `:378-384` `validateInternalAgentBinding` | `InternalAgentBinding` | **是：`splitPipelineTimeoutMs`** | 否（`internalAgents` 层有，绑定层没有） |
| 4 | `:607-648` `validateContextInjection` | `Partial<ContextInjectionConfig>` | 否 | **是**（`:631-636`） |
| 5 | `:917-929` `validatePdConfig` | `PdConfig` | 否（读到的键都写了） | 否（顶层无未知键守卫） |

另有 2 个嵌套构造点与同类风险：

| # | 位置 | 说明 |
| --- | --- | --- |
| 6 | `:155-169` `validateFeatureFlagEntry` | 只读 `category` / `enabled` / `source`，其他键静默忽略（`enable`、`sourc` 之类拼写错误不会报错） |
| 7 | `:898-902` `principles` | 只读 `outputLanguage`，其余键静默忽略。**这段代码上方 `:889-891` 的注释记录的正是同一类事故**（"Dropping it here silently disabled the SSOT"） |

第 7 条是重要证据：**这类 bug 在本仓已经发生过一次并被手工修过**，然后又在 profile 上复发。
按 AGENTS §14，这具备 ERR 记录的资格（重复故障类 + 架构不变量违反）。

### 1.3 已经存在的"未知键 fail loud"模式（5 处）

| Section | 位置 | 处理方式 |
| --- | --- | --- |
| `internalAgents` | `:454-459` | `knownKeys` 之外的键 → error |
| `workspace` | `:562-567` | 同上 |
| `contextInjection` | `:627-641` | 同上 **+ 被容忍的遗留 no-op 走 `warnings`** |
| `reuseEvaluation` | `:818` | 键集常量 `REUSE_EVALUATION_KEYS` |
| `promptBudget` | `:856` | 键集常量 `PROMPT_BUDGET_KEYS` |

`REUSE_EVALUATION_KEYS` 上方的注释写明了这条仓库立场：

> a config key that looks valid while nothing reads it is how **ghost configuration** starts

这正是**拒绝"整体透传"**的仓库内依据：透传会把拼写错误变成"看起来合法的配置"，与既有立场相反。

### 1.4 敏感字段今天是被"拒绝"，不是被"剥掉"

- `DANGEROUS_KEYS`（`pd-config-types.ts:483`）= `__proto__` / `constructor` / `prototype` → `ok:false`。
- 8 个密钥类键（`apiKey` / `api_key` / `token` / `gatewayToken` / `gateway_token` / `secret` / `password` / `auth`）在 `:200-206`（openclaw）与 `:294-299`（pi-ai）命中即 `ok:false`。

因此**目前不存在"合法但应被剥掉"的 profile 键**。排除表今天必须为空 —— 但表本身要存在、要有测试、要有注释说明"什么情况下才允许非空"。

### 1.5 唯一丢点是 validate

`pd-config-effective.ts:140` 用 `{ ...profile }` 展开，不丢字段；`pd-config-redaction.ts` 是在**输出/展示**路径上做摘要（`apiKeyEnv` 名字可以显示、值不显示），与校验路径无关。
所以"补字段"只需动 validate，**不需要动 effective、redaction、adapter**。

### 1.6 `warnings` 已经是契约的一部分

`PdConfigValidationResultOk`（`pd-config-types.ts:396-401`）本来就带 `warnings: string[]`，并且已经有 12 处在 `effective.ts` 里被推送。
**"显式登记的容忍项 + 警告"不需要扩任何公共类型。**

---

## 2. 三个候选方案

### 2.1 方案 A｜显式排除表 + 其余整体透传

**机制**：结果对象不再逐字段写回，而是 `{ ...raw, type: 'pi-ai' }`；维护一张"必须拒绝/剥掉"的键表。

**必须先说明的缺陷**：裸透传**换来了另一种静默**——未知键（拼写错误、废弃键）会被当成合法配置流进 `PdConfig`，没有任何字段读它，但也没有任何信号。这与 `:818` 处的 ghost-configuration 立场直接冲突。

因此方案 A 若要成立，必须补一个**闭世界键表**（记作 **A'**）：

```ts
// 编译期穷尽：给 PdLocalRuntimeProfile 加字段而不改这张表 → tsc 失败
const PROFILE_KEYS: Record<keyof PdLocalRuntimeProfile, true> = {
  type: true, provider: true, model: true, apiKeyEnv: true,
  baseUrl: true, timeoutMs: true, maxRetries: true, maxTokens: true,
  reasoning: true, systemPrompt: true,
};
// 运行期闭世界：不在表内 → error（而不是忽略）
```

- **改动面**：`pd-config-validate.ts` 一个文件；每个构造点约 +8 行（键表 + 未知键循环）；`validatePdLocalProfile` 的结果构造从 12 行降到 1 行 spread。
- **对现有行为的影响**：以前被忽略的键会变成 error（升级破坏面，见 §6）。敏感键仍走拒绝路径，需在未知键循环前 `continue`，避免重复报错。
- **排除项登记**：A' 天然有一张"允许键表"；"必须剥掉"的键仍需单独登记，今天为空。
- **红→绿**：
  - 红：`runtimeProfiles.p.systemPrompt` 透传后存在；`runtimeProfiles.p.unknownProbe` → `ok:false`。
  - 绿：前者值保留，后者报 `unknown key`。
- **未来保护力**：**强**。新加字段 → 编译期强制进表；配置里出现未登记字段 → 运行期报错。
- **风险**：键表与类型重复一次（P4 的"第二个真相"味道，但有 `Record<keyof T, …>` 约束兜住，漏写即编译失败）。

### 2.2 方案 B｜从 schema 生成校验结果

**机制**：用 schema 描述字段（类型、可选性、校验器、排除策略），由它派生：类型、验证、构造、未知键拒绝。

**关键事实**：`@sinclair/typebox` 与 `typebox` **已经是** `principles-core` 的运行时依赖，且已有 20 个文件在用。所以这不是"引入新依赖"，而是"接入既有模式"。

- **改动面**：`pd-config-types.ts` 里两个 profile 接口改为 `Static<typeof Schema>`；`validatePdLocalProfile` / `validateOpenClawProfile` 改为"schema 校验 + 映射错误"；需要一层 `TypeBoxError → PdConfigValidationError` 的翻译（现有错误是 `{path, reason, nextAction}` 三件套，TypeBox 只给 path/message）。
- **对现有行为的影响**：类型来源改变。`PdLocalRuntimeProfile` 被 pd-cli / pd-console / installer 等 20+ 处引用，`Static<>` 的产物在可选性与字面量联合上不保证与手写接口逐字相同 → **这属于跨包类型契约变更**（AGENTS §19），需要逐消费者验证。
- **排除项登记**：schema 里可以显式标注 `excluded/secret`，比散落的字符串数组更集中。
- **红→绿**：同一组测试（`systemPrompt` 往返 + 未知键报错）。
- **未来保护力**：**最强**——schema 是唯一真相，字段、校验、构造三者不可能分叉。
- **结论**：对 10 个字段的两个 profile 来说，**投入 > 收益**。它的真正价值在 §7 的 `validators.ts` 场景。

### 2.3 方案 C｜构造后"输入键 ⊆ 输出键"自检，fail-loud

**机制**：不改变构造方式，在所有构造点之后加一次通用自检：

```ts
function findDroppedKeys(
  raw: Record<string, unknown>,
  value: object,
  excluded: ReadonlySet<string>,   // 今天为空集
): string[] {
  const produced = new Set(Object.keys(value));
  return Object.keys(raw)
    .filter(k => !DANGEROUS_KEYS.has(k) && !excluded.has(k) && !produced.has(k));
}
```

命中即 `errors.push(err(path + '.' + key, "field '<key>' was accepted but dropped by the validator", "…"))`，然后走既有的 `ok:false` 路径。

- **改动面**：1 个 helper（约 12 行）+ 5 个调用点各 1 行 + 1 张空的排除表。**零新依赖、零类型改动、零公共契约改动。**
- **对现有行为的影响**：今天静默丢的键变为 error（升级破坏面，见 §6）。**已知会漏报的情况**：值被规范化（例如布尔别名折叠）时，键在输出里存在，自检只看键，不会误报——这正是我们要的行为。
- **排除项登记**：`excluded` 参数即登记表，今天为空集；若将来出现"合法但不拷贝"的键，必须加进去并有测试。
- **红→绿**：
  - 红：`{...合法profile, unknownProbe: 1}` → 今天 `ok:true` 且字段消失。
  - 绿：`ok:false`，`reason` 里出现 `unknownProbe`。
  - 另加：`systemPrompt` 往返（这是事故 #2 本身，属于"补字段"，与 C 是两条独立测试）。
- **未来保护力**：**强（运行时），但只在已接入的构造点生效**。新加字段忘拷贝 → 只要配置里出现该字段就报错；新加一个**全新的 validator 函数**而不接入自检 → 不受保护（§4.3 给出编译期补丁）。
- **风险**：错误信息在"字段被丢"与"字段未知"之间不区分措辞，需要在 `nextAction` 里写清两条出路（去掉该键，或升级 PD）。

---

## 3. 横向对比

| 维度 | A'（闭世界键表 + 透传） | B（schema 生成） | C（构造后自检） |
| --- | --- | --- | --- |
| 忘记拷贝**已知**字段 | 消除（spread 不可能漏） | 消除 | 运行期拦截（配置含该键时） |
| 未知键/拼写错误 | 运行期报错 | 运行期报错 | 运行期报错 |
| 新加字段的**编译期**信号 | 有（`Record<keyof T,…>`） | 有（schema 即类型） | **无**（需另加一张表） |
| 新增构造点的保护 | 无 | 无（新 validator 仍需接入） | 无（新 validator 仍需接入） |
| 新抽象/新依赖 | 无 | 复用 TypeBox，但引入 schema→错误的翻译层 | 无 |
| 跨包类型契约变更 | 无 | **有**（类型来源改变） | 无 |
| 实现量（配置层） | 中（5 个构造点各约 8 行） | 大（类型 + 校验 + 错误映射 + 20 处消费者验证） | **小**（helper + 5 行） |
| 升级破坏面 | 有 | 有（且叠加类型风险） | 有 |
| 可否独立回退 | 可（单文件） | 难（类型回到手写即可，但已改的调用面要回退） | 可（删 5 行） |

---

## 4. 推荐与落地顺序

**推荐：C 作为不变量，A' 的键表作为可选第二步，B 不在配置层做。**

理由：
- C 用最小改动覆盖"两种漏法"，且不引入任何新概念；
- A' 的编译期穷尽表解决了 C 唯一的结构弱点（新加字段时没有编译期提醒）；
- 两者叠加的改动量仍小于 B 的 1/5，且不需要碰公共类型。

### 4.1 第一步（红）

1. `systemPrompt` 往返：`validatePdConfig` 后 `runtimeProfiles.p.systemPrompt === 'You are …'`。今天红。
2. `splitPipelineTimeoutMs` 往返。今天红。**但它没有消费者** —— 见 4.4。
3. 通用：`{...合法profile, unknownProbe: 1}` → `ok:false`。今天红（`ok:true`）。

### 4.2 第二步（绿）

1. `validatePdLocalProfile` 补 `systemPrompt`（`isString` 校验 + 写回）。
2. 接入 `findDroppedKeys` 到 §1.2 的 5 个构造点 + §1.2-6/7 两个嵌套点。
3. 排除表：`new Set<string>()`，附注释与"必须为空"的测试。

### 4.3 第三步（编译期穷尽，这是"以后仍然受保护"的关键）

```ts
// 给类型加字段而不改这里 → tsc 失败
const PROFILE_FIELDS: Record<keyof PdLocalRuntimeProfile, true> = { … };
const BINDING_FIELDS: Record<keyof InternalAgentBinding, true> = { … };
```

配一条运行期测试：`Object.keys(PROFILE_FIELDS)` 与 `findDroppedKeys` 使用的允许键集合一致（防止两者漂移）。

**诚实的边界**：这套机制保护的是"给已有类型加字段"；**不能**保护"新增一个未接入自检的 validator 函数"。后者只能靠 review 或未来的 lint 规则，本方案不承诺。

### 4.4 必须先做的一个决定：`splitPipelineTimeoutMs`

它在类型里、无消费者、被静默丢弃。两条出路，**不能默默透传**（那会制造 ghost configuration）：

- (a) 实现消费者（split diagnostician pipeline 的 3 阶段总超时）—— 属于功能开发，不在本修法范围；
- (b) 从类型与文档里删除 —— 与"它从未生效"的现状一致。

建议 (b)，另开一条小 issue；无论选哪条，**都要在排除表或类型里留下明确结论**。

---

## 5. 显式排除项登记（今天为空集）

| 类别 | 键 | 处理 | 测试 |
| --- | --- | --- | --- |
| dangerous | `__proto__` / `constructor` / `prototype` | `ok:false`（`:329-333`、`:675-679`） | 表驱动，每键一例 |
| 密钥类 | `apiKey` / `api_key` / `token` / `gatewayToken` / `gateway_token` / `secret` / `password` / `auth` | `ok:false`（`:200-206`、`:294-299`） | 表驱动，每键一例（现有测试是否覆盖全部 8 个需核对） |
| **允许但丢弃** | **无** | — | 断言 `excluded.size === 0`，注释写明"什么情况下才允许非空" |

"允许但丢弃"这一栏今天必须为空：一旦有人往里加键，就说明存在"配置合法但故意不生效"的设计，那必须同时给出 warning（`rc-9`），不能只是不进结果对象。

---

## 6. 影响面

### 6.1 升级破坏面（最大风险）

C/A' 会把"以前静默忽略的键"变成校验错误。真实用户配置里可能存在：
- 拼写错误的历史键（`systemprompt`、`baseURL`）；
- 从旧版本沿袭、已经被删除的键；
- 从别处复制来的、PD 从未支持的键（`temperature`、`top_p` 等）。

后果：`.pd/config.yaml` 从"能加载"变为"加载失败"。**这比静默丢弃更正确，但必须让 Owner 知情，并且错误信息要能自救**（`nextAction`: 删除该键 / 查看支持的键集）。

缓解：
- 错误文案带完整键路径 + 支持键集；
- `.changeset` 标注为行为变更（建议 `minor`，因为改变了校验结果语义；若维持 `patch` 需要在 release note 里显式提醒）；
- 可选：先用 `warnings` 观察一个版本再升级为 error。**不建议**，理由是这与 5 个既有 section 的立场不一致，会制造两套规则。

### 6.2 跨包消费

- `validatePdConfig` 的调用方：`pd-cli`（配置加载）、`pd-console`（`pd-config-store.ts`）、installer。
- `warnings` 已经被这些路径消费（13 处），所以"容忍项 + warning"不需要接线。
- `RuntimeProfile` 类型本身**不变**（方案 C/A' 都不动类型来源），所以 §1.3 里列出的 20+ 处重建点（`pd-cli` resolver、`pd-console` store、`pain-signal-runtime-factory`、3 个 adapter、installer）**不需要改动**。
- 需要 changeset：**是**（核 = `@principles/core`；`@principles/pd-console` 是 `private: true`，不需要）。

### 6.3 明确不做

- 不改 `pd-config-effective.ts`（它不丢字段）；
- 不改 `pd-config-redaction.ts`（不同关注点：展示脱敏）；
- 不改 UI `validators.ts`（§7 单独立项）；
- 不重构 `pd-config-validate.ts` 的其他 section；
- 不为这次修法新增 feature flag（`mvp-q-3`：可单文件回退）。

---

## 7. 是否作为 `validators.ts` 的模板？

**判断：同一类结构，不同结论 —— 不应直接把配置层的修法套过去；应单独立项，并在那里采用方案 B。**

理由：
- `packages/pd-console/src/ui/utils/validators.ts` 是 3,934 total / 3,564 non-blank 行，其中大量函数是同一形态："校验 + 逐字段重建对象"。字段数量是配置层的两个数量级，手工维护键表不现实。
- 它的失效模式与配置层相同（未知字段被静默丢弃），但**后果不同**：UI 丢字段通常是"新字段不显示"，而不是"配置不生效"。
- 因此那里的正确目标是**生成化**（B），而不是加一层运行期自检（C）。

### 独立立项建议（不塞进本计划）

```
标题：Console UI validators 生成化（字段白名单构造的收敛）
问题：validators.ts 3,934 行，逐字段重建；新增后端字段时 UI 静默丢弃，
      且没有任何编译期/运行期信号。
可量化目标：
  - 文件行数 3,934 → < 1,200（估计值，需在立项时按实际可生成比例重算）
  - "后端新增一个响应字段 → 前端需要改的文件数" 从 2（类型 + validator）
    降到 1（类型），并由编译期检查兜底
第一步（探针，1 个函数）：挑 `validateOwnerDecisionsData`（`validators.ts:3878-3890`），
      用 schema/生成方式重写，保持行为等价（现有 `owner-decision-validators.test.ts`
      的 12 个断言不改），度量生成代码量与可读性。
验证：同一批测试全绿 + 一个"新增字段自动透传"的新测试。
风险：UI 校验器承担了"拒绝畸形响应"的安全职责，生成化后必须保留 fail-closed 语义。
不做：不一次性重写全部 validator；不改 UI 渲染。
```

`validateOwnerDecisionsData` 是很好的探针：它今天用 `Object.hasOwn` 逐字段重建 `{ items, total, generatedAt }`，任何新增顶层字段都会被丢弃 —— 与本方案的失效模式完全同构。

---

## 8. Complexity Delta（若按推荐方案 C + 编译期表实施）

```
New durable source of truth: NO     （类型仍是唯一真相；键表是它的派生，受 Record<keyof T> 约束）
New persisted schema/state:   NO
New subsystem/service:        NO
New public abstraction:       NO     （helper 为模块内私有函数）
New runtime feature flag:     NO
New cross-package dependency: NO
New host-specific behavior:   NO
New external capability:      NO
```

行为变更：`YES`（以前静默忽略的配置键将报错）—— 需要 changeset 与 release note。

---

## 9. 待 Owner 决定的三件事

1. 采 C（+ 编译期表），还是直接上 A'？
2. `splitPipelineTimeoutMs` 走向 (a) 实现消费者 / (b) 删除？
3. 未知键的处理姿态：立即 error（与 5 个既有 section 一致），还是先 warning 一个版本？
