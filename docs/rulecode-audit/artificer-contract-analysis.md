# Artificer 输出契约分析 — PRI-634-E（v2，核查修订版）

> 本版为核查修订版：补充 run_1/run_2 产物双版本事实与"契约满足 ≠ gate 可达"的
> 精确表述。根因定位详见 replay-gate-analysis.md v2（B 主因，精确化为可达性
> 依赖 LLM 输出形状）。

审计基线：origin/main `2e97ce1e`（PRI-634-C 修复分支 28aa49c2 与 main 在相关路径零差异，真实失败 artifact 可对照当前代码）。

## 1. 契约定义（当前权威）

`packages/principles-core/src/runtime-v2/internalization/artificer-output.ts` — `ArtificerRuleOutput`（PRI-439 统一输出，取代 V1/V2 双版本）：

| 字段 | 必填 | 约束 |
|---|---|---|
| `taskId` | ✓ | 与任务一致 |
| `sourceScribeArtifactId` | ✓ | 与 sourceTrace.scribeArtifactId 一致 |
| `implementationCode` | ✓ | 非空字符串（**无 plan-only 路径**，MANDATORY） |
| `goldenTraceCases` | ✓ | 2–10 条；≥1 positive（须 expect allow）+ ≥1 negative；propose_correction 须带 expectedProposedParams + expectedApplicationMode |
| `affectedTools` | ✓ | 非空字符串数组 |
| `implementationSummary` | ✓ | 非空 |
| `risks` | ✓ | 字符串数组 |
| `sourceTrace` | ✓ | scribeArtifactId 必填 |
| `generatedAt` | ✓ | |
| `requiresContextVersion` | 可选 | 仅支持字面量 `2`（v2 规则可读 input.context） |
| `evidenceRefs` | v2 必填 | PRI-490：来自 BehaviorExamplePack 的证据引用 |

Validator：`DefaultArtificerValidator`（同文件）逐项运行时校验（rc-1/rc-2：unknown → 结构化检查，无 `as` 绕过）。

## 2. 真实产物对照（PRI-634-C 失败链）

### e6e9636b（rule / code_tool_hook 链）— 契约**完全满足**（单产物）

```
implementationCode: 1734 字符（function evaluate(input, helpers) — 预检门规则）
affectedTools:      ["execute_command","run_script","write_file","create_file","edit_file","code_interpreter","exec"]
goldenTraceCases:   6 条（negative-1/2/3 block × execute_command/write_file/run_script；
                     positive-1/2/3 allow × 同三工具，positive 均带 path 参数）
implementationSummary / risks / sourceTrace / taskId / generatedAt：齐备
requiresContextVersion: 未声明（v1 规则）
```

### cf9ceca8（prompt 链）— 两轮产物，契约字段**逐字相同**（F-1 关键证据）

| | artifact -1（run_artificer_1，07:17） | artifact -2（run_artificer_2，07:50 修订轮） |
|---|---|---|
| implementationCode | 3703 字符 | 3703 字符（语义层经 scribe 修订重生成，但契约字段不变） |
| affectedTools | `["execute_command","read_file","write_file","edit_file"]` | 同左（逐字） |
| goldenTraceCases | 8 条；positive-1 = execute_command，params `{command, encoding}` **无 path/file_path** | 同左（逐字） |
| evidenceRefs | `[]` | `[]` |
| requiresContextVersion | 未声明 | 未声明 |

修订轮差异全部在 scribe 的**原则文本**（principleDraft 补边界/组合 antiPattern 表述）；
Artificer 的执行契约字段未随修订变化 → gate 死锁条件未被修订触及（见
failed-rule-analysis.md §4 F-1）。

## 3. 回答任务问题

**Artificer 当前输出什么？**
完整的 rule intent（implementationSummary）、可执行 RuleCode（implementationCode）、
触发面（affectedTools + golden trace 的 toolName）、positive/negative examples
（goldenTraceCases）、v2 上下文声明与证据引用。形式上**六项齐全**。

**契约缺口（与失败强相关）**：

1. **toolName 无受控词表**：契约只要求 `toolName` 非空字符串，不要求它落入
   RuleHost/canonical 别名表。真实产物用了 `execute_command`、`run_script`——
   这两个名字**不在** `canonicalizeToolKind` 的 `TOOL_ALIAS` 表
   （rule-context-v2.ts:118-137：read/write/edit/exec/execute/bash/run_shell_command
   有，`execute_command`/`run_script`/`code_interpreter` 无）→ canonical 结果 `'other'`
   （已用 node 直调 dist 运行时验证）。
2. **positive case 的路径参数键无契约约束**：v2 对抗用例自动生成要求
   `params.path` **或** `params.file_path`（`resolveCasePathParam`），但 Artificer
   契约对 params 形状零约束（`Type.Record(String, Unknown)`）。cf9ceca8 的
   positive-1 params 只有 `{command, encoding}` → 路径不可派生。
3. **没有"输出必须让确定性 gate 可达"的语义约束**：validator 全部通过 ≠
   对抗重放可执行。契约不知道存在一个下游合并器要求
   （write-canonical 工具 × 可派生路径 × LLM adversarialCases 至少其一）。
4. **（核查新增）契约字段游离于修订环之外**：F-1 实证修订指令只驱动 scribe 的
   原则文本，Artificer 的 affectedTools / params 形状在修订轮间逐字不变——
   即使未来把"gate 可达性要求"写进契约，还需要修订环能触达它。

## 4. 结论

Artificer 输出契约**不是**失败的充分原因（A 部分成立）：形式契约在两轮产物上
均满足，失败源于契约与下游 Replay Gate 的**语义接口断裂**——契约不约束 toolName
词表、params 形状，gate 的自动用例生成器在真实行为规则（execute 类）上结构性
不可达；而 gate 对 execute 类的可达性实际 100% 押在 LLM 输出形状上（V2 自带用例
则可达并正确工作，V1 同等合法则零兜底死锁，见 replay-gate-analysis.md v2 §5）。
A 为次因、B 为主因、C 为辅因、F-1 反馈错位为伴随发现——完整分类见
failed-rule-analysis.md v2 §3。
