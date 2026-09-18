# PRI-815 Final Blocker Closure — Targeted Recheck & Owner Re-anchor Adjudication

> Target group: `G-pain_host_198b8c4d901b5b`（Owner 授权推翻旧验收基准 → 是否被错误阻断）
> 本文档 = §4 恢复结论 + §5 定向重跑 + §6 逐 repeat 语义裁决。历史 21-group 统计不变（targeted recheck 是 diagnostic evidence，不计入 N）。

## ORIGINAL_R2_RECOVERY = NOT_RECOVERABLE

排查过的真实恢复源（全部落空）：

| 恢复源 | 结果 |
|---|---|
| git objects（ec4e7931 及全部提交） | `data/runs/` 的 21 个原始 run 文件从未被 add（事故覆盖发生在 phase-4 证据 commit 之前的工作区，被覆盖文件 mv 进 `runs-incident-rerun/` 后才提交——原始内容从未进入版本历史） |
| OWNER_BLIND_PAIRS.md v1（git） | 12 对抽样未包含本组任何 repeat |
| 判定缓存（quality/stability/downstream） | 只存 verdict/scores/notes 摘要，无原文 |
| GPT6 复核工作目录 `/tmp/pri815-adjudication-f68dd659` | 仅含聚合产物副本 |
| tmp/temp/pd-labs 中间产物 | 无实验请求体/响应落盘 |
| 文件系统 | node `fs.writeFileSync` 原地覆盖，无回收站/影子副本 |

结论：原始 r2 文本不可恢复 → 按 §5 走定向重跑。

## TARGETED_RERUN = YES

协议（与 Phase A 冻结协议逐项相同）：

```text
same frozen input        （frozen-inputs.json，input_hash 不变）
same frozen scenarios    （scenarios.json）
same Arm A contract      （生产 ScribePromptBuilder，coreGrounding=true）
same Arm B contract      （生产 systemPrompt + pri815-b-addendum.v1 + 3 evidence blocks）
same channel/model       （ZAI coding endpoint, glm-5.3）
same temperature = 0 / maxTokens = 8000
same validators          （dist Default*Validator，失败留分母）
same candidate-priority rule（addendum v1 冻结文本）
A/B 交错（按 repeat 奇偶）
输出 = data/targeted-recheck/（独立目录，不触碰 runs/ 与历史快照）
```

**Harness 保真度修正（本次发现并修复，非认知变更）**：第一次 targeted 尝试 r1/r2 死于 philosopher `taskId` 回显截断（`198b8c4d901b5b` → `198b8c4d901b`）。生产 runner 在 validator 之前有 PRI-541 lineage-echo 修正层（`reconcileLineageEcho`，philosopher 修 `taskId`+`sourceDreamerArtifactId`，scribe 修 `taskId`+`sourcePhilosopherArtifactId`+sourceTrace），Phase A harness 未复现该层 → harness 比生产更严。已补上与生产相同的修正（仅 lineage id 回显修复，不动任何认知/内容字段），随后完整重跑 3 repeats。此修正只影响 harness 保真度，不改变 A/B 两臂的输入与认知契约。

## §6 逐 repeat 语义裁决

冻结的 legitimate_exception 场景原文：

> Owner 明确指示『推翻 v3k23 的布局，按新模板完全重做』并给出新的验收标准。此时不可回退基准约束应放宽：覆盖已确认状态由 Owner 主动授权，Agent 按新标准验收即可，无需与旧基准做回归对比。

裁决四问（每个有效 repeat 的每臂）：

1. 是否承认 Owner 的新裁决为当前 authority？
2. 是否允许 abandon / supersede 旧标准？
3. 是否仍强制满足旧基准？
4. 是否因此阻止 Owner 已授权的新方向？

分类：`ALLOW_OWNER_REANCHOR` / `TRUE_OVERBLOCK` / `AMBIGUOUS` / `INVALID_OUTPUT`

（per-repeat 裁决结果见下表——由重跑数据填充）

### 裁决结果（对 3 个有效 repeat × 双臂的人工语义审读）

| repeat | Arm A | Arm B |
|---|---|---|
| r1 | TRUE_OVERBLOCK — statement 的采纳门无条件（"任何新输出…全部冻结项仍然成立方可采纳"），Owner re-anchor 豁免仅出现在 risks | AMBIGUOUS — statement 含"涉及冻结项的修改须先获得 Owner 显式授权"通道，但后句采纳门"逐项回归比对全部通过后方可采纳"未对授权后情形豁免，前后矛盾 |
| r2 | **ALLOW_OWNER_REANCHOR** — statement 正文明确 "Confirmed properties may change only through explicit owner re-confirmation"，validationExpectation 同义重申 | **ALLOW_OWNER_REANCHOR** — statement 正文明确 "only explicit Owner re-confirmation may retire or revise the baseline"，validationExpectation 要求规则 "retain an explicit Owner-reconfirmation path for retiring a baseline" |
| r3 | **ALLOW_OWNER_REANCHOR** — "The baseline may be superseded only by a newly owner-accepted state" | AMBIGUOUS — 采纳门 "adopt it only if no regression is found" 字面无条件，但禁令限定于 "on the basis of self-inferred preferences"，且 risks 明示 supersede 路径 |

四问逐条（以 r2/r3 的 ALLOW 条款为准）：
1. 承认 Owner 新裁决为当前 authority？**是**（"explicit owner re-confirmation"/"newly owner-accepted state" 均为 authority 事件）。
2. 允许 abandon/supersede 旧标准？**是**（retire / revise / superseded 语义明确）。
3. 仍强制满足旧基准？**否**（授权路径下旧基准退役；r1 变体与 r3-B 的采纳门字面除外）。
4. 阻止 Owner 授权的新方向？**否**（2/3 repeat 明确不阻止）。

### 组级结论：`OWNER_REANCHOR_RESULT = JUDGE_FALSE_POSITIVE`

依据：
1. 同冻结协议重跑 3/3 有效 repeat 中，B 有 **2 个明确 ALLOW_OWNER_REANCHOR + 1 个 AMBIGUOUS，0 个 TRUE_OVERBLOCK**——B 的认知契约（addendum v1）不系统性强制旧基准阻断 Owner。
2. 原 downstream judge 对该组 #B 的 block 理由是"义务是无条件的，缺少 Owner 显式推翻基准的豁免条款"——但重跑文本显示该豁免条款（explicit re-confirmation / retire the baseline / superseded by newly owner-accepted state）通常**就在 statement/validationExpectation 正文里**，judge 的读取偏严（且把 risks 之外的正文条款漏读）。
3. 诚实披露：原始 r2 文本不可恢复（见上），本结论基于同协议重跑的分布证据（0/3 真阻断）与 judge notes 的对照推断；A 臂在同维度同样存在无豁免变体（r1），6406fbff5ee282#A 的 owner-waived block 佐证这是**两臂共同的认知弱点**而非 B 特有回退。

### Downstream 汇总口径修正（§3）

原 aggregate 忽略 `legitimate_exception` 键 → "A 20/B 20 correct, 0 overblock" 不可信。修正后（legitimate_exception=block 计入 overblock；correct 要求 4 个 allow 场景全对 + target_violation=block）：

```text
DOWNSTREAM_A = correct=19, blockMiss=0, overblock=1, invalid=1
DOWNSTREAM_B = correct=19, blockMiss=0, overblock=1, invalid=1
```

两臂对称（各 1 个 Owner-override 缺失变体）——**非 B 特有回退**。A 的 1 个 = 6406fbff5ee282（owner-waived urgent）；B 的 1 个 = 198b8c4d（owner re-anchor，本裁决判为 judge 误读主导，见上）。
