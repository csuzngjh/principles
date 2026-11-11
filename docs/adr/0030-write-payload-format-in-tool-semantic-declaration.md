# ADR-0030: 把 write 载荷编码标识放进工具语义声明

| Field | Value |
| --- | --- |
| Status | **Proposed**（草案，待 Owner 裁决） |
| Date | 2026-11-11 |
| Supersedes | 无 |
| Superseded by | 无 |
| Related | `docs/plans/2026-11-10-b-series-tool-semantics-contract-plan.md`；`packages/host-runtime/src/codex-rule-context-provider.ts`；`packages/host-runtime/src/host-tool-declaration.ts`；`packages/host-runtime/src/host-tool-semantic-resolver.ts`；`scripts/check-tool-semantics-authority.mjs`；Linear PRI-673（persisted declaration 兼容契约，Backlog） |

---

## 1. Context（为什么需要）

B 系列确立了唯一工具语义权威 `ToolSemanticRegistry`（`rawToolName → canonicalKind`），并加入了结构守卫：`packages/*/src` 里出现 `toolName === '<literal>'` 即失败，除非登记在 `check-tool-semantics-authority.mjs` 的 allowlist。

仍有一处无法用 `canonicalKind` 表达的分支：

```ts
// codex-rule-context-provider.ts:119
...(targetKind === 'write' && request.toolName === 'apply_patch'
  ? { targetPaths: patchTargets(rawParams, projectDir) ?? [] }
  : {}),
```

`apply_patch` 的载荷不是普通 `content`，而是带文件头的 patch 信封（`*** Begin Patch` / `*** Add|Update|Delete File:` / `*** Move from|to:`）。设计门（design gate）需要从这些文件头解析 `targetPaths`，才能判断本次写入是否落在 Owner 批准的 scope 内。`canonicalKind: 'write'` 只说明“这是写”，不说明“载荷怎么编码”，因此这里只能按 raw name 选择解析器。

**风险不是风格问题，而是静默的 enforcement 输入漂移**：若 Codex 新增/改名一个 patch 工具（例如 `apply_patch_v2`），只要它在 registry 里被正确声明为 `write`，规则匹配、replay、evidence 全部正常；但 design-gate 的 `targetPaths` 会变成 `[]`，`design_approval` fact 从“在 scope 内”退化为 unknown/false，审批结论改变，而没有任何测试会红。这与 B 系列“一个权威、不允许第二份词表”的目标直接冲突，也是 B5 allowlist 里唯一剩下的语义分类类例外（`risk-calculator-policy.ts` 的 7 条已在 PR #2530 清零）。

**现状证据（2026-11-11，源码）**

- `ToolSemanticMappingV1` 当前只有 `rawToolName` + `canonicalKind`（`packages/principles-core/src/runtime/internalization/tool-semantic-registry.ts`）。
- Codex 声明 `{ rawToolName: 'apply_patch', canonicalKind: 'write' }`（`packages/codex-adapter/src/tool-semantics.ts:26`）。
- OpenClaw 也把 `apply_patch` 声明为 `write`（`packages/openclaw-plugin/src/constants/tools.ts:21`），其测试载荷为 `{"input":"*** Begin Patch"}`（`tests/core/rule-context-assembler.test.ts:146`）——同一信封，但当前没有 design-gate 目标解析消费方。
- WorkBuddy 只声明 `Read/Glob/Grep/Write/Edit/Bash`，无 patch 工具证据（`packages/workbuddy-adapter/src/tool-semantics.ts:23-30`）。
- 持久化声明文件 `.pd/host-tool-semantics/<hostKind>.json` 为 `version: 1`，逐条保存 mappings（`host-tool-declaration.ts:28-38`）；hook 解析时**工作区声明优先**，静态声明只补缺失的名字（`host-tool-semantic-resolver.ts:156-170`）。

---

## 2. Decision（建议方案）

### 2.1 声明字段

在 `ToolSemanticMappingV1` 上增加一个**可选**字段，语义是“这个 write 工具的载荷编码”：

```ts
export type WritePayloadFormat = 'file-header-patch';

export interface ToolSemanticMappingV1 {
  readonly rawToolName: string;
  readonly canonicalKind: CanonicalKind;
  /** 仅当 canonicalKind === 'write' 时合法；缺省表示普通 content 载荷。 */
  readonly writePayloadFormat?: WritePayloadFormat;
}
```

- 命名用 `file-header-patch` 而不是 `codex-apply-patch`：语义是**信封格式**（`*** ... File:` 文件头），不是宿主身份；core 不应认识宿主名。
- 首版只允许一个非默认值。不预留 `plain-content` / `unified-diff` 等未出现的变体（P7：没有第二个真实实现就不造取值的缝）。
- Registry 增加 `resolveWritePayloadFormat(rawToolName): WritePayloadFormat | undefined`；未声明 = `undefined`（普通载荷），**不猜测**。

### 2.2 校验与合并

- `validateToolSemanticMappings` 新增两条 fail-loud 规则（rc-3）：`writePayloadFormat` 出现在非 `write` 映射上 → invalid；取值不在枚举内 → invalid。
- `mergeDeclarations` 对“同一 raw name、不同 `writePayloadFormat`”按与 `canonicalKind` 相同的方式判冲突，不按启动顺序取胜（P4）。
- 静态声明校验在模块加载时 fail loud（现有模式不变）。

### 2.3 消费方改造（仅一处）

`codex-rule-context-provider.ts` 改为：

```ts
options.toolSemantics.resolveWritePayloadFormat(request.toolName) === 'file-header-patch'
```

`patchTargets()` 的解析逻辑、1MB 上限、NUL/空路径拒绝、`patch|input|command` 三种载体全部不变。B5 allowlist 中该字面量条目删除。

### 2.4 持久化兼容（PRI-673 边界）

只加可选字段会让**旧的 v1 Codex 声明文件**缺少该字段；而工作区声明优先于静态声明，合并后 `writePayloadFormat` 仍会缺失 → design-gate 目标解析静默退化。这不是可接受的默认行为。

因此：**`HOST_TOOL_DECLARATION_VERSION` 升到 2**。

- v1 文件在读取时 fail loud（`host_tool_declaration_invalid`），沿用既有策略：hook 侧回退到编译进二进制的静态声明以保证可用性，并输出结构化 warn（rc-9）；宿主下次启动时重写自己的文件。
- 不采用“用静态声明补齐缺失的可选字段”的软化方案：它改变合并语义，并让陈旧文件看起来是新的。

---

## 3. 对三宿主的影响

| 宿主 | 现状 | 本 ADR 后 | 行为变化 |
| --- | --- | --- | --- |
| Codex | `apply_patch` 是 `write`，provider 用 raw name 触发 patch 目标解析 | 声明 `{ apply_patch, write, writePayloadFormat: 'file-header-patch' }`；provider 查 registry | 无（同一输入同一结果），但别名自动跟随、字面量与 allowlist 例外消失 |
| OpenClaw | `apply_patch` 是 `write`，载荷同为 `*** Begin Patch` 信封，但无 design-gate 目标解析消费方 | 建议本轮**不声明**该格式（没有消费方，声明了也无行为收益）；等 OpenClaw 接入 design gate 时再按证据声明 | 无 |
| WorkBuddy | `Write`/`Edit` 为普通载荷，无 patch 工具证据 | 不声明（`undefined`） | 无 |

宿主声明持久化：Codex 升级后首次启动重写 v2 文件；OpenClaw/WorkBuddy 的 mappings 结构不变，但版本号升级同样触发重写。

---

## 4. 备选方案（未采纳）

- **A. 保留字面量 + allowlist 例外**：正是本 ADR 要消除的静默漂移；别名出现时无测试能发现。
- **B. 给 `CanonicalKind` 增加 `delete` / `patch`**：这个闭集同时被 replay、enforcement、evidence 与规则上下文消费，为“载荷编码”扩大语义分类面，影响远大于收益。
- **C. 对所有 `write` 载荷都尝试 patch 解析**：普通 `content` 以 `***` 开头时会被误判为 patch，且每次写操作都多一次无关解析。
- **D. 把 raw name 放进 host-runtime 配置/常量**：只是把第二份词表挪个位置，没有解决单一权威问题。

---

## 5. 实施与验证计划（获批后）

1. **改前红**：注册一个 `apply_patch_v2 → write + file-header-patch` 的声明，prove Codex provider 在旧实现下 `targetPaths` 为空（字面量不匹配）；测试写到 `host-runtime/tests/`。
2. **改后绿**：provider 走 `resolveWritePayloadFormat`；同一输入解析出目标；既有 `apply_patch` 路径结果逐字节一致。
3. **负控**：未声明格式的 `write`（普通 `content`，即使以 `***` 开头）不解析；超 1MB、NUL、范围外路径仍返回 `undefined`（保留既有测试）。
4. **兼容**：v1 声明文件 → 类型化拒绝 + 静态回退 + warn；v2 → 正常。
5. 门禁：`check-tool-semantics-authority` 通过且该字面量例外消失；host-runtime / codex-adapter 全量测试与构建；`npm run error:context` 复核。

**回退**：单 commit revert；v2 文件对旧代码会 fail loud 并回退静态声明，不产生静默错误。

---

## 6. 需要 Owner 裁决的问题

1. 是否批准该契约扩展（`writePayloadFormat` + 声明版本 v2）？
2. OpenClaw 的 `apply_patch` 是否本轮一并声明 `file-header-patch`？
   - 建议：**不**。没有消费方（design gate 目前只接 Codex），且这是声明语义而非行为；等接入时再声明，避免“为完整性”提前铺字段。
3. 若批准，是否接受 v1 → v2 的 fail-loud 迁移（宿主首次启动自动重写），而不是做静默补齐？
