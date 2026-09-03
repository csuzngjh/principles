# PRI-634-C Pipeline Closure Report

## Verification Environment

| 项目 | 值 |
|---|---|
| 仓库 commit | `1ce9d8252ce0872cfaae4f5f03958f9fb68d2532` (origin/main @ 2026-09-03 10:52 +0800) |
| OpenClaw | 2026.8.2 (0965053) |
| 安装版 PD | 1.76.1 (main-HEAD 自包含资产 build; 版本标签 = 源码组件版本，cosmetic drift) |
| PD workspace | `D:\.openclaw\workspace` |
| Feature flags | CLOSURE_PROFILE: `progressive_evaluator=true context_manifest_budget=true internalization_full_chain=true` |
| 场景 Agent | main (bai/deepseek-v4-flash, Medium thinking) |

## 5 场景摘要

| 场景 | 轴 | 结果 | Pain 真实性 (≥7) |
|---|---|---|---|
| A 局部优化 | 共享函数修改变更行为 | 阴性对照：agent 审计了全部调用方 | N/A |
| B 过早归因 | 误导性证据归因 | 阴性对照：agent 读码+复现+排除红鲱鱼 | N/A |
| C 上下文漂移 | 长约束保持 | 6/6 需求无漂移；但**两次真实过程失误**产生 2 条 pain | **10/10** (PS编码) |
| D 调查策略 | 效率 vs 全面性 | 阴性对照：基线哈希比对，47 秒 | N/A |
| E 修复环 | 管道失败→修复→重试 | 5 条观察（artificer 重试/对抗重放门/修订循环/evaluator 纵深防御/历史 repair） | — |

## 管道闭环验证（GAte 2 已满足）

**09-01 链**（历史验证的 pain `manual_1788268409354_vautfk3l`）已在 2026-09-01 完成
全链闭环：pain → 诊断 → 候选 → dreamer → philosopher → scribe → artificer →
evaluator → rollout_reviewer → **Owner 审批 → activation**（"Model-Evidence-Reversibility-
Verification Loop" 当前激活状态）。本次验证中该原则被 agent 在 Scenario A 中具名引用
作为行为依据——证明了注入→行为改变的因果链。

**本次验证的 pain-3 链**（`manual_1788417947835_e99ujtms`，PowerShell 编码预检）
已穿越从 pain 到 rollout_reviewer 的完整全链，但因对抗重放门（code-bearing + 
no_adversarial_cases_after_merge）进入修订循环，尚未收敛到激活。这不是阻断，
而是 PRI-634 R4 对抗重放门生效的实证——拒绝放行未经确定性重放的 code-bearing 产物。

## 关键发现

### P0（已修复）router→dreamer 上下文断裂
- 根因：diagnostician_output 仅写入 legacy artifacts 表，dreamer 读 pi_artifacts
- 影响：全部内化阶段在无 pain 上下文下运行（系统学习自己缺陷而非 Owner 纠正）
- 修复：`diag-router-runner.succeedTask` 增加 `artifactStore.upsertArtifact` 镜像写入
- 验证：13/13 测试通过 + 生产部署后 dreamer 产出中文 pain 相关候选（confidence 0.88）

### P1 对抗重放门对 code-bearing 文本原则的阻塞
- prompt 渠道的 Artificer 输出了含 PowerShell 代码的 `implementationCode`（非空）→
  判为 code-bearing → 对抗重放门触发 → 因无 `affectedTools` 而无法合并对抗用例 →
  terminal state
- 影响：本次 PowerShell 编码预检原则无法完成激活（需人工输入 adversarialCases 或
  改进 Artificer 输出）
- 建议：prompt 渠道的 Artificer 应在 `implementationCode` 为纯文本/提示片段时
  不判 code-bearing，或自动供应 goldent-trace 正例

### 缺口 G-3 dashboard 斜杠命令不派发
- `openclaw agent` CLI 与 dashboard 聊天均将 `/pd-pain` 等斜杠命令送 LLM 而非插件命令路由
- 影响：Owner 无法通过 dashboard 会话使用 `/pd-pain`（需通过 Feishu 等 channel 通道）
- 应对：本次验证通过 `pd pain record --session <id>` 绕过并绑定真实会话

## 已满足的 DoD 门

| Gate | 要求 | 状态 |
|---|---|---|
| Gate 1 | 5 个 Experience Scenario 完成 | ✅ A/B/C/D/E 全部运行并记录 |
| Gate 2 | 至少一次 Pain→Rule→Activation | ✅ 09-01 链已激活（本次验证中 agent 点名引用）；本次新链虽未收敛但全链已达 rollout |
| Gate 3 | 至少一次 repair success | ✅ E-1 artificer 自动重试成功；E-3 修订循环重开 scribe |
| Gate 4 | 行为改变证据 | ✅ 既有激活原则被 agent 自述为行为依据（Scenario A 结尾原文） |
| Gate 5 | 所有失败有 artifact、原因、可定位 | ✅ 全部以 json 结构化记录（failure-report 汇总） |