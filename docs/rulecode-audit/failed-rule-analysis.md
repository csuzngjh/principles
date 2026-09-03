# 失败 Rule 分析 — PRI-634-E（v2，核查修订版）

> 核查修订：初版基于"evaluator V1 输出"的单一叙事。运行时取证后确认 cf9ceca8 链
> 存在**三个 evaluator run**、**两次 Artificer 产物**，失败机制在轮间不同。
> 本版按真实时间线重写，全部结论标注证据来源（DB 直查 / telemetry / 运行时验证）。

审计范围：PRI-634-C 真实闭环中两条被对抗重放门阻挡的链。不重新模拟，只读取
workspace `state.db`（runs/pi_artifacts）、`.pd/telemetry/critical-events.jsonl` 与
当前 main 代码（2e97ce1e）的确定性路径。

## 1. 真实时间线（cf9ceca8，prompt 链 — 最复杂）

| 时刻 | 阶段 | 事件 | 证据 |
|---|---|---|---|
| 07:08:08 | scribe run_1 | 产出原则草稿（Pre-execution contract validation） | pi_artifacts |
| 07:16:54 | artificer run_1 | 产出 artifact **-1**（affectedTools×4、8 golden cases、无 path 的 execute positive） | runs + pi_artifacts(07:17:12) |
| 07:33:48 | evaluator run_1 | LLM 输出 **V2**（自带 4 条 adversarialCases）→ merged=7 → **重放实际执行** | telemetry: `evaluator_adversarial_replay` caseCount=7 |
| 07:34:30 | 同上 | gate **正确抓到 2 处规则漏拦**（v2-path-boundary、v2-combination：expected block / actual allow）→ verdict 翻转 needs_revision → 重开 scribe | run_1 output.adversarialResult.passed=false；runs.reason |
| 07:46:07 | scribe run_2 | 修订原则文本（补边界/组合 antiPattern 表述） | runs |
| 07:48:16 | artificer run_2 | 产出 artifact **-2**：**执行契约字段与 -1 逐字相同**（affectedTools、positive[0]=execute_command params {command,encoding} 无 path、evidenceRefs=[]） | runs output_payload 直查 |
| 07:52:26 | evaluator run_2 | LLM 输出 **schema invalid**（"does not match evaluator-output-v1 schema"） | runs.reason |
| 07:55:17 | evaluator run_3 | LLM 输出 **V1**（无 V2 字段）→ merged=0+0=0 → **no_adversarial_cases_after_merge** 终态（attempt 3/3 耗尽 → 链 failed） | telemetry + runs.reason |

## 2. e6e9636b（rule / code_tool_hook 链 — 单轮死锁）

- artificer run_1 唯一产物：affectedTools×7（`execute_command`,`run_script`,`write_file`,
  `create_file`,`edit_file`,`code_interpreter`,`exec`）、6 golden cases（3 positive 均
  **带 path**）、implementationCode 1734 字符预检规则。契约完全满足。
- evaluator run_1：V1 输出 → llmCases=[]；v2 自动生成：
  toolName='execute_command' → **运行时验证 canonicalizeToolKind → 'other'** →
  non_write 分支 → [] → merged=0 → 终态。
- 该链**重放从未运行**（无 evaluator_adversarial_replay 事件），无任何轮次逃生。

## 3. 失败分类（对照任务四选项）

```
[ ] Rule 本身错误          → 不成立。两条链 evaluator LLM 均判 approved；
                             cf9ceca8 run_1 gate 发现的 2 处漏拦是真实规则缺陷
                             （见 F-2），属"规则可改进"而非"错误"。
[✓] Rule 信息不足          → 部分成立（F-1 反馈错位，见 §4）。
[✓] Validation 无法理解 Rule → 成立（B 主因）。gate 的自动用例生成只理解 write
                             语义；execute 类规则的可达性完全押在 LLM 输出形状上。
[✓] Test case 缺失         → 成立（C 辅因）。V1 输出合法但关闭唯一逃生通道；
                             修订轮 LLM 三次输出三种形状（V2/invalid/V1）证明
                             该通道不可靠。
[✓] 其它：反馈错位（新发现 F-1）
```

## 4. 核查新发现

### F-1 反馈错位（修订环不修复到达条件）— 新 P1

rollout_reviewer 下发的修订指令（记录于 rollout 任务 diagnostic_json）要求：
"评估须与对抗失败（v2-path-boundary, v2-combination）和解 / 原则补 antiPattern /
测试装备模拟环境变异"。修订轮执行结果：
- scribe 改了**原则文本** ✓
- **Artificer 契约字段零变化**（-1 与 -2 的 affectedTools / positive params 逐字相同，
  run output_payload 直查证实）
- 而 gate 死锁条件（execute 类 + 无 path + V1 输出）恰恰全部在 Artificer 契约字段上

即：**修订环按指令修了语义层，但 gate 的可达性条件在结构层，指令与死因之间没有
映射**。修订轮收敛无从谈起——即使修订 10 轮，只要 LLM 输出 V1 就死锁。

### F-2 gate 的判定质量（正面证据）

run_1 重放抓到的 2 处漏拦（v2-path-boundary：同名解释器不同运行时上下文须 block；
v2-combination：版本+编码组合信号须 block）是**真实规则缺陷**——原规则只检查
"encoding 参数存在"，未覆盖"有 encoding 但版本组合冲突"的场景。对抗重放门在
LLM 供用例时工作完全正常且有价值。**问题从来不是门太严，而是到达门的路径不可靠。**

### F-3 attempt 计数语义

cf9ceca8 evaluator 3 次 attempt：run_1 实际是"gate 判负"（不算 LLM 输出失败），
run_2 是 schema invalid，run_3 是 V1 死锁。三种不同性质的失败共用同一个
attemptCount=3 上限，且 run_1 的"gate 发现规则缺陷"本应导向**定向修订**
（Artificer 契约字段），实际消耗了重试预算。

## 5. 判定（维持并精确化）

```
A. Artificer 输出契约不足  → 次因（且是 F-1 的结构侧根源：契约字段未进入修订指令）
B. Replay Gate 设计不适配  → 主因（write-only 自动生成 + 可达性依赖 LLM 输出形状）
C. Golden Trace 缺失       → 辅因（V1 合法但零兜底；LLM 形状漂移 V2→invalid→V1）
D. 其它                    → F-1 反馈错位（新）：修订指令不携带 gate 死因的结构性条件
```

主因排序不变；新增 F-1 为设计文档方案 1/方案 2 之外的第四个修复靶点
（修订指令需携带结构化 gate-reachability 条件），已补入 rulecode-graduation-design.md。