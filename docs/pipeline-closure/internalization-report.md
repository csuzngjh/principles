# PRI-634-C Internalization Report

## 最终 Owner 问题

> 如果明天有一个新的 OpenClaw 用户安装 PD，他犯了一次真实错误，PD 是否有能力把这个错误变成未来 Agent 的行为改进？

**结论：是——但有三个前置条件和一个已知 P1 阻塞。**

本次验证（main HEAD 1ce9d825，全真实会话）证明了整条数据管道的每一步都在生产路径上真实运转：

| 问题 | 答案 | 证据 |
|---|---|---|
| 1. 真实 Pain 是否进入 PD？ | **是** | Scenario C 会话（uuid 00521544）真实失误 → `pd pain record --session` → 4 条候选全部 `admitted / evidence_sufficient / host_context_bound`；无绑定的 CLI 上报被正确拒绝（needs_evidence），低置信内容被置信门拒绝（0.42<0.5） |
| 2. Pain 是否生成 Principle？ | **是** | 诊断产出 3-4 条语义准确的候选（"落地任何代码文件前必须确认解释器版本与编码契约"等），哲学家阶段置信 0.85-0.88 |
| 3. Principle 是否生成 Rule？ | **是** | Artificer 从同一 pain 生成 RuleHost 拦截规则（"脚本写入/执行前无编码/解释器预检证据则拦截"），并触发对抗重放门验证 |
| 4. Rule 是否改变后续 Agent 行为？ | **是（既有原则实证）** | 已激活原则 "Model-Evidence-Reversibility-Verification Loop" 被 agent 在 Scenario A 中**具名引用**作为行为依据："应用了你的原则……改动前先保存 golden 输出，改完后做逐字节 diff 和差分模糊测试验证行为不变，而非仅依赖现有测试"。这是注入→行为的直接因果证据 |
| 5. 失败是否可解释？ | **是** | 所有失败路径（上下文缺失/低置信/对抗门拦截/输出契约违规）均有结构化 reason + nextAction + artifact 定位 |

## 新用户场景的诚实评估

一个**新的** OpenClaw 用户犯一次真实错误后能否改进未来行为，取决于：

1. **错误必须发生在可绑定的会话中**：pain 必须带真实 sessionId（`--session` 或
   channel 命令）。CLI 无绑定上报会被证据门拦截（这是特性不是 bug——防伪造）。
   新用户最自然路径 = OpenClaw 会话中犯错 → Owner 纠正 → 会话内 `/pd-pain`（channel）
   或 `pd pain record --session <id>`。
2. **安装必须包含 PRI-634-C 的 P0 修复**：诊断→内化阶段的上下文贯通（本次验证发现
   并修复的 router→dreamer pi_artifacts 镜像）。修复前，dreamer 及以下阶段在无 pain
   上下文下运行，产出的原则与纠正无关。该修复在验证 worktree
   （`ai/PRI-634C-pipeline-closure-validation` 分支）中，**尚未合入 main**——这是
   "明天的新用户能否闭环"的关键前置。
3. **code-bearing 文本原则需人工放行或 Artificer 改进**：当前对抗重放门会阻塞
   含代码片段的 prompt 原则（本次 PowerShell 预检原则卡在修订环），需要
   P1 级改进（见 PIPELINE_FINDING follow-up）。

## 机制层面的诚实边界（本次验证暴露）

1. **当前工作区治理强度高**：4 个场景（A/B/C/D）agent 全部表现优秀——已激活原则 +
   workspace 纪律让"推理类失误"几乎不可诱发。真实 pain 更可能来自环境交互细节
   （解释器/编码/命令通道），而非任务推理本身。**对新用户的推论：没有既有原则
   的新 agent 更容易犯错、pain 更容易产生，闭环价值更高。**
2. **dashboard/CLI 斜杠命令不派发**（G-3）：本地 Owner 最常用的表面无法触发
   `/pd-pain`；这是 UX 缺口（已记录，属于 PRI-629 review-UX 断层类问题）。
3. **版本标签漂移**：安装版版本号与源码组件版本脱节（已知 P2）。

## 修复状态

| 项 | 状态 |
|---|---|
| P0 router→dreamer 上下文断裂 | ✅ 已修复 + 13/13 回归测试 + 生产部署验证 |
| P1 对抗重放门阻塞文本原则 | 📋 follow-up（需 Artificer 输出 affectedTools/golden-trace 或放宽 prompt 渠道判定） |
| G-3 dashboard 斜杠命令 | 📋 follow-up（宿主侧） |
| 旧链处置（09-01 遗留 needs_human_review 等） | 📋 见收尾清单 |

## 补充说明

- 本次验证过程产生的全部 artifact（pain/候选/原则/规则/任务）都在工作区 state.db
  中可查；报告均在 docs/pipeline-closure/ 目录。
- 垃圾链（P0 期间上下文饥饿链）已全部被评估层拦截（evaluator failed: tier2 evidence
  unavailable），无一进入审批——纵深防御实证。
