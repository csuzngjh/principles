# DREAMER_V21_CURRENT_STATE_AUDIT.md — Phase 0 事实基线重建（2026-11-15）

审计人：AI（zcode）。方法：全部结论基于本次会话重新核实的 git/PR/代码/数据，未沿用上一轮记忆。

## 一、已证实的事实（本次核实，附证据）

| # | 事实 | 证据 |
|---|---|---|
| F1 | 工作树 HEAD = `1617635469ec16c913529a1b619caf29e56c2727`，与指令记录一致；分支 `ai/adhoc-20261115-prompt-v2-k4wz9t`；工作树干净（除本轮新增报告）；远端同步 | `git rev-parse HEAD` / `git status --porcelain`（空）/ FETCH_HEAD 同值 |
| F2 | PR #2653 仍 OPEN，head 同上；唯一 review 为 github-advanced-security bot（COMMENTED，无正文——CodeQL 注解类），**无人工评审**；3 条 Owner 侧评论（整改报告×2 + Round-2 结果报告 6893078593） | `gh pr view 2653 --json state,headRefOid,reviews,comments` |
| F3 | 上一轮（Round 2）CI 全绿：run 43705115991（workflow_dispatch 补触发，Verify Merge Gate + 全部测试车道 success） | `gh run view 43705115991` |
| F4 | V2.1 提示词在当前源码为 Owner 原文逐字，5 个动态组合变体与提交快照逐字节一致 | `dreamer-v21-verbatim.test.ts`（5 变体 byte-equality，快照 SHA `2d5ec3be…`，builder blob `23fefc96…`） |
| F5 | 其余五 Agent 提示词与 round-1 冻结状态逐字节一致（17/17 指纹 == prompt-hashes-v2.json）；冻结 16 文件 0 失败 | round-2 preflight（14/14 PASS） |
| F6 | 实验数据完整：paired-2（40 克隆记录 + 14 上游记录，20/20 对双臂 verified）+ grid-3（52 记录 = 41 done + 11 admission-refused）+ 盲评（60/60、123/123）+ diversity（40/40、38/38） | `runs/paired-2/`、`runs/grid-3/`、`analysis/paired-paired-2-analysis.json` |
| F7 | 抽检材料存在：`spotcheck/OWNER_SPOTCHECK_LIST.md`（35/174 包，盲态）+ 答案键（本地未盲开） | 文件存在；答案键未用于任何本轮分析 |
| F8 | V2.1 提示词体积 10,613 字符（V2 4,343，+144.4%） | fingerprints manifest + prompt-hashes-v2.json |

## 二、代码事实（本次阅读源码核实）

| # | 机制 | 代码位置 | 对审计的含义 |
|---|---|---|---|
| C1 | **一个 Candidate → 恰好一个 Dreamer Task**：taskId=`dreamer-<candidateId>-<channel>`； PRI-720 C6 候选级防双种（跨 channel 后缀查重）；rule 候选无机械触发证据时确定性降级 prompt 通道 | `intake-to-internalization-bridge.ts:14-16,129-188` | 跨任务重复不可能来自"同一候选多种任务"；只可能来自"多个候选各自成链" |
| C2 | 候选通道映射：principle→prompt，rule→code_tool_hook，implementation→skill（MVP 禁用），defer→不内化；maxAttempts=3 | `intake-to-internalization-bridge.ts:108-127,264` | rule 链走 code_tool_hook 通道 |
| C3 | Dreamer 的 evidence 基线 = **predecessorOutput（Router 诊断）**，非原始 Pain：buildContext 取 dependencyTaskIds 第一个 succeeded 任务的第一个 artifact | `dreamer-runner.ts:138-200` | 忠实性判定必须以"诊断层"为对照基线；超出诊断层的断言才算凭空 |
| C4 | 每次 Dreamer 成功 run 恰好落一个 artifact（`pi-art-<taskId>-<runId>`）；LLM 的 valid/sourcePainId/sourcePrincipleId 均为不可信自述（echo 门 + strip + normalize） | `dreamer-runner.ts:276-307,372-418` | artifact 计数可信；lineage 字段以运行时为准 |
| C5 | Philosopher 只见**本链** Dreamer 工件（buildContext 按 dependencyTaskIds 取 dreamer artifact 全量），并校验 sourceDreamerArtifactId 一致性（ERR-004） | `philosopher-runner.ts:141-196,249` | **跨链重复对 Philosopher 结构性不可见**——每链各自合成，互不知晓 |
| C6 | Scribe 消费 philosopher artifact + 其 sourceDreamerArtifactId；后继任务由 orchestrator 幂等创建（successor_exists 按 parentTaskId+kind+channel 去重） | `scribe-runner.ts:94-102`、`internalization-orchestrator.ts:412-424` | 链内血缘一致；跨链无任何汇合点 |
| C7 | rule 类候选（code_tool_hook 通道）的 **scribe 任务触发 needs_human_review（0 attempts，人工门）**——每 Pain 恰 1 条 rule 链 → 每克隆恒 1 个人审任务 | 实测 `v2c-sv2c-pS02-r0` state.db：scribe-e2b02349…-code_tool_hook | rule 链止步于 scribe 前；prompt 链可全自主完成 |

## 三、基于代码推导的判断（推导，非实测）

- D1：由 C1+C5，同 Pain 的 N 条候选链各自独立探索**同一份诊断**（C3：predecessorOutput 相同），提示词层面无任何跨链信息 → 跨链机制趋同是**结构必然**，提示词优化（V2.1 的链内多样性规则）无法消除它。此判断由 Phase 1 实测证实（见 MECHANISM_DIVERSITY_AUDIT §三）。
- D2：rule 链的人审门（C7）意味着 rule 类候选不产生自动原则稿——下游"保留率"必须分通道统计。

## 四、上一轮结论的复核结果

| 上轮结论 | 复核 |
|---|---|
| "V2.1 无退化（+0.81/+0.22）" | **维持**（数据仍在，可复算） |
| "单候选崩塌归零" | **维持**（本轮 Phase 1 再次实测：40 克隆 86 链、每链候选 ≥2） |
| "多样性聚合分未提升" | **维持，且本轮机制级审计给出更强结论**：跨链重复是主导冗余源（§MECHANISM_DIVERSITY） |
| "Scribe 全链 −1.11 边界退化" | 维持（数据不变）；本轮补充：Scribe 差异与"每链候选更少→合成原料更少"相关 |
| "评估器同族限制" | **维持并加强**：生成与评估均为 glm-5.3 家族（同模型），上轮所有"盲评分差"不能当独立质量证明使用——本轮 Phase 2 改用证据对照+确定性规则 |

## 五、尚未验证 / 本轮无法验证

- U1：真实宿主行为是否改善——无任何真实宿主运行数据（本轮禁止触发），所有质量结论止步于"管道产物质量"。
- U2：needs_human_review 的人工门在真实运营中的处置时长/结果——实验中无人处置，任务停留。
- U3：跨链重复原则是否会被 ledger 侧去重/Owner 评审拦截——实验未走到注册环节（SCRIBE→注册在实验配置外），无法验证。
- U4：V2.1 提示词 +144% 在真实宿主会话中的 token 成本影响——实验工作区无成本计量，只有字符数。
