# 失败 Rule 分析 — PRI-634-E

审计范围：PRI-634-C 真实闭环中两条被对抗重放门阻挡的链（不重新模拟，只读取已持久化 artifact）。

## 1. 失败链总览

| 链 | 通道 | Artificer 产物 | Evaluator 决断 | 失败原因 |
|---|---|---|---|---|
| `e6e9636b` | code_tool_hook (rule) | `artificer-e6e9636b-…-1` | approved（V1 shape） | `no_adversarial_cases_after_merge` |
| `cf9ceca8` | prompt | `artificer-cf9ceca8-…-2`（修订轮） | approved（V1 shape） | `no_adversarial_cases_after_merge` |

## 2. 失败路径追踪（逐行代码验证）

### 2.1 e6e9636b（rule 链）

**artifact 实物**（`pi-art-artificer-e6e9636b-…-1`）：
```
affectedTools:     ["execute_command","run_script","write_file","create_file","edit_file","code_interpreter","exec"]
goldenTraceCases:  6 条（3 positive: execute_command/write_file/run_script，均带 path 参数）
implementationCode: 1734 字符（function evaluate — 预检门规则）
```

**gate 流水线**：
1. `extractPositiveCases` → 3 条 ✓
2. `llmCases = isEvaluatorOutputV2(output) ? output.adversarialCases : []` → **V1 output**（无 adversarialCases 字段）→ `[]` ✓
3. `generateV2CasesFromArtificer(affectedTools=['execute_command',...], positiveCases)`：
   - toolName = `'execute_command'` ✓（非空）
   - `resolveCasePathParam(positive-1.params)` → `{command, path: "/workspace/script.ps1", encoding}` → `path` 存在 → `"/workspace/script.ps1"` ✓
   - `canonicalizeToolKind('execute_command')` → **TOOL_ALIAS 表里无 `execute_command`**（有 `execute`、`exec`、`bash`、`run_shell_command` 但无 `execute_command`）→ `'other'`
   - `'other' !== 'write'` → **return []**（reason: `non_write_canonical_kind_for_v2_adversarial_cases`）

4. `merged = [] + [] = []` → **`no_adversarial_cases_after_merge`** → terminal state（R3 拒绝）

**根因**：`execute_command` 不在 `canonicalizeToolKind` 的别名表中，且 `canonicalKind !== 'write'` 是终止条件。

### 2.2 cf9ceca8（prompt 链，修订轮）

**artifact 实物**（`pi-art-artificer-cf9ceca8-…-2`）：
```
affectedTools:     ["execute_command","read_file","write_file","edit_file"]
goldenTraceCases:  8 条（4 positive + 4 negative）
positive-1 params: {command: "pwsh -NoProfile -File ./deploy.ps1", encoding: "utf8NoBom"}
                    — 无 path/file_path 键
```

**gate 流水线**：
1. `extractPositiveCases` → 4 条 ✓
2. `llmCases` = []（V1 output） ✓
3. `generateV2CasesFromArtificer`：
   - toolName = `'execute_command'` ✓
   - `resolveCasePathParam({command, encoding})` → params 中**无 `path` 也无 `file_path` 键** → **null** → **return []**（reason: `no_path_param_for_v2_adversarial_cases`）
   * 注：即使有 path，也会死在步骤 3c（`execute_command` → `'other'` ≠ `'write'`）

4. `merged = []` → 同死锁

**根因**：LLM 未在 positive case 的 params 中写入 `path` 或 `file_path`（契约未约束 param 形状）。

## 3. 失败分类

```
[ ] Rule 本身错误        → 不适用。implementationCode 通过了 DefaultArtificerValidator 且 evaluator 判定 approved。
[✓] Rule 信息不足        → 部分成立。Artificer 用了绕开 TOOL_ALIAS 的工具名，v2 自动生成失败。
[✓] Validation 无法理解 Rule → 核心。Replay Gate 的 v2 自动生成器设计上只理解 write 语义工具，行为规则（execute 类）结构性不可达。
[✓] Test case 缺失       → 部分成立。LLM 没有提供 adversarialCases（V1 output），且 v2 自动生成因 canonicalKind 失败。
[ ] 其它（请说明）        → 见下。
```

## 4. 判定

**根因 = B（Replay Gate 设计不适配）为主，C（Golden Trace 缺失）为辅，A（Artificer 输出契约不足）为次。**

```
假设分类（A/B/C/D）：
  A. Artificer 输出契约不足  → 次因（toolName 无受控词表、params 无形状约束）
  B. Replay Gate 设计不适配 → 主因（v2 自动生成模板只支持 write 语义，execute 类结构性不可达）
  C. Golden Trace 缺失       → 辅因（LLM 未提供 adversarialCases，V1 evaluator 输出合法但关闭了唯一逃生通道）
  D. 其它                    → 别名表不完整（TOOL_ALIAS 缺 execute_command/run_script/code_interpreter 等常用工具名）
```

**决定性证据链**：
1. e6e9636b 的 affectedTools 和 positive cases 全部满足"输出 affectedTools + positive case 带 path"的修复建议 → 但仍然失败
2. 失败点 = `canonicalizeToolKind('execute_command')` → `'other'` ≠ `'write'` → v2 生成 return []
3. 本次失败的规则是"脚本执行前检查编码/解释器契约"——行为规则（execute），不是写入安全规则——gate 设计时没覆盖这个类型