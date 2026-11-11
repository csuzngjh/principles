# ADR-0030: 把 write 载荷编码标识放进工具语义声明

| Field | Value |
| --- | --- |
| Status | **Accepted**（Owner 2026-11-11 批准；v1 → v2 以“降级 + 可见诊断”实现） |
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

只加可选字段会让**旧的 v1 Codex 声明文件**缺少该字段；而工作区声明优先于静态声明，合并后 `writePayloadFormat` 仍会缺失 → design-gate 目标解析静默退化。

Owner 裁决的安全前提（2026-11-11）：**旧声明被新版本读到，必须是“降级到缺省 + 可见诊断”，不能拒绝启动或抛错中断宿主加载**。因此把 `HOST_TOOL_DECLARATION_VERSION` 升到 2 时，读取语义定义为：

| 输入 | 行为 |
| --- | --- |
| `version === 2` | 正常读取；`writePayloadFormat` 参与校验与合并 |
| `version === 1` | **降级读取**：按 v1 语义剥离 `writePayloadFormat`（视为未声明），映射与 `declaredAt` 仍完整校验；返回结构化 warning（含 hostKind、声明版本、支持版本、被降级字段与刷新动作）。宿主加载不中断 |
| `version > 2` | fail loud：未来版本可能携带本构建无法解释的字段，猜读比拒绝更危险（这是降级方向的反向，不在兼容承诺内） |
| 缺失/非正整数 `version`、非法 JSON、非法映射、缺失 `declaredAt` | fail loud（与 v1 一致） |

- warning 经 `loadHostToolDeclarations → resolveWorkspaceHostToolSemantics / resolveHostToolSemanticsForHook` 透传；Codex/WorkBuddy 写入 hook stderr 诊断，OpenClaw 走 `logger.warn`（rc-9：降级必须可观察）。
- 不采用“用静态声明补齐缺失的可选字段”的软化方案：它改变合并语义，并让陈旧文件看起来是新的。降级只在**读取 v1 文件**时发生，且明确告知该文件应被宿主重写。
- Owner 要求的三条证据（见 §5）已落地为测试；“降级”与“损坏仍 fail loud”在实现上可同时成立，无需二选一。

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

## 5. 实施与验证计划（已获批，已实施）

1. **改前红**：旧实现下不存在 `resolveWritePayloadFormat`、`HOST_TOOL_DECLARATION_VERSION === 1`，新测试无法编译/断言失败；`apply_patch_v2 + file-header-patch` 在旧 provider 中不会解析目标。
2. **改后绿**：provider 走 `resolveWritePayloadFormat`；`host-runtime/tests/production-design-gate-pretool.test.ts` 证明**新别名声明 `file-header-patch` 后自动解析 targetPaths 并触发 design-gate deny**（反例自动跟进）。
3. **负控**：同一别名只声明 `write`、不声明格式时，`targetPaths` 不解析，design gate 不得声称 Owner 拒绝（`decision: 'allow'`）；普通 `content` 即使以 `***` 开头也不会被误判。既有 1MB / NUL / 范围外测试保留。
4. **兼容三条证据**（Owner 安全前提，`host-runtime/tests/host-tool-declaration.test.ts`）：
   - 证据 1：构造 v1 文件 → v2 加载路径**不抛错**、语义等价于缺省（无 `writePayloadFormat`）、warning 含 hostKind / 声明版本 / 支持版本 / 被降级字段 / 刷新路径。
   - 证据 2：同一份 v1 文件与等价 v2 文件（同 mappings、无格式）解析出的**语义快照完全一致**；唯一差异是 v1 有 warning、v2 无。
   - 证据 3：真正损坏的声明（非法 JSON、缺失/非整数/超前版本、v1 中损坏映射、非 write 带格式、未知格式、缺失 `declaredAt`）**仍逐一 fail loud**。
   - 生产路径：`codex-adapter/tests/pd-hook.production.test.ts` 证明 v1 文件下 hook 仍 exit 0、输出合法决策，且 stderr 可见 `host_tool_declaration_version_legacy`。
5. 门禁：`check-tool-semantics-authority` 通过且该字面量例外消失；core / host-runtime / codex-adapter / openclaw / workbuddy 相关测试与构建；`npm run error:context` 复核。

**回退**：整体 revert。降级读路径使“旧代码 + 新 v2 文件”不会静默：`version > 1` 在旧加载器中 fail loud 并回退静态声明，不产生错误语义。

---

## 6. Owner 裁决记录（2026-11-11）

1. **契约扩展：批准**。`writePayloadFormat` 仅对 `canonicalKind: 'write'` 合法；`resolveWritePayloadFormat()`、冲突合并、fail-loud 校验按 §2 实施。
2. **OpenClaw：本轮不声明**。同意 §3，等出现 design-gate 消费方再按证据声明。
3. **迁移方式：v1 → v2 必须“降级到缺省 + 可见诊断”**，不得拒绝启动或抛错中断宿主加载；同时真正损坏的声明仍须 fail loud。若两者无法同时成立，必须停下并上报 Owner。实施结论：**可以同时成立**，证据见 §2.4 与 §5.4。
