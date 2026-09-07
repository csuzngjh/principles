# Evolution Benchmark Episode 001 — Report（2026-09-06/07）

> **PD Evolution Benchmark Dataset Episode #001**。目标：用最新 main 的 PD 完成一次
> 真实 Agent 失败 → Owner 理解/批准/激活 → 后续行为改变的完整闭环，并产出可作为
> 长期 Benchmark 的数据集样本。本报告是 `docs/pipeline-evolution/` 的第三轮实验记录
> （Round 1 = first-run-report，Round 2 = 2026-09-05-round2-report，本轮 = Episode 001）。
> 完整数据集：`D:\pd-labs\evolution-episode-001\evolution-dataset\episode-001\`（11 文件，
> 含 evidence-package 14/14 artifacts，全部只读派生可复算）。

## Executive Summary

> **PD 是否完成第一次真实 Evolution Episode？**

**没有走完——但在三十九小时的实验里，管道第一次把一条真实失败推进到「evaluator approved 0.84 + 全部治理门真实行使」；最后一公里的堵点从基础设施层（667→670→683，三个已修复并本轮全部实证有效）收敛到了单一的质量层断点 PRI-700（修复轮 LLM×输出契约死锁）。机制侧没有任何一扇门被削弱或绕过：无低质产物放行，注入面零泄漏。**

判定：**PARTIAL_EPISODE**——Pain→Diagnosis→Principle→Rule→Evaluation 全部真实走通且有高质量证据；Owner Review（生产路径）→Activation→Behavior Transfer 未达，堵点明确、已立 P1（PRI-700）、复跑成本明确。

## Environment snapshot（AC4）

| 项 | 值 |
|---|---|
| PD git sha | origin/main `9bbb041e4`（含 **PR #1524 PRI-683 修复**，2026-09-06 08:29 合并——本轮与 Round 2 的关键管道差异变量） |
| 版本 | repo 1.76.1 / core 1.74.1 / pd-cli 1.74.1（worktree 构建执行，安装版 live 1.230.2 全程未触碰） |
| OpenClaw | **2026.9.2 (3928bad)** dev profile（:19001），插件 junction → worktree `packages/openclaw-plugin`（AutoConsumer 启动行核对绑定 lab ws） |
| 隔离 | `PD_WORKSPACE_DIR=OPENCLAW_WORKSPACE=D:/pd-labs/evolution-episode-001/ws/main`；收尾核验 live trajectory/state 零污染（ep1-% session 计数 0） |
| 会话模型 | bai/glm-5.3-flash（thinking off，显式 --session-id） |
| 内化链 LLM | lab config 全链 bai-glm-5.3-flash（timeoutMs 900s→1500s 中途调优）；修复轮后半程 artificer 切 flatkey-ds（deepseek-v4-flash）；CLI 侧内联诊断经 home 链解析到 flatkey-ds（ENV-1，警告可见、状态未写穿） |
| flags | internalization_full_chain ✓ auto_consumer ✓ progressive_evaluator ✓（本轮全程 ON） |
| 对照 Round 2 变量 | #1524（PRI-683 修复）+ OpenClaw 2026.9.1→9.2；PRI-674/675/677/678 仍 Todo |

## Pipeline Result

| Stage | Result | Evidence |
|---|---|---|
| Pain | **PASS** | `manual_1788707211638_6jmh05ku`（score 70，session ep1-s001a 绑定）。发明字段 pain 自然复现第 4 次（Turn 1 阴性对照外科手术式改端口；Turn 2 欠约束+惯例诱导下 agent 自发补 5 个零消费者字段）；admission 2 candidates evidence_sufficient，skill 通道被 MVP 正确拒绝 |
| Diagnosis | **PASS** | 内联 337s；rootcause confidence 0.8，**5 层因果链直达系统性根因**（把 example/惯例当规范 schema 的错误假设 + 干净启动=非区分性验证信号），证据引用具体到 agent turn 时间戳——达到任务定义的「优秀」标准（非"改错文件"表面归因） |
| Principle | **PASS** | 双通道 philosopher 均成：*"No config field without a verified consumer"*（0.86），含 scope 泛化（config/env/API payload/事件 schema）与 5 条自省风险；scribe 反模式 6 条全对准失败家族 |
| Rule | **PASS（初版）** | v2 seed rule：声明式工件写门 + 消费者验证证据要求 + 显式拒绝 example/惯例理由；**诚实标注 PRI-508 缺口**（无状态 host 无法认证 evidence） |
| Evaluation | **PASS（门全部真实行使）** | hook 链 evaluator needs_revision 0.7 + 对抗重放真实执行（8 cases 2 fail→rejected_validation_failed）；prompt 链 evaluator **approved 0.84**（0 requiredChanges）后 rollout needs_revision 0.87（5 个对抗失配 case 逐个点名）——**修复指令精确到可执行** |
| Owner Review | **NOT_REACHED（生产路径）** | 两链修复轮耗尽于 PRI-700，链终止 failed，needs_human_review 从未产生，approvals 表 0 行。Owner-mode 模拟评审（独立完成，记为 SIMULATION）：原则产物 **APPROVE**、规则产物 **REQUEST_REVISION**（与管道自家门的结论一致） |
| Activation | **NOT_REACHED** | activations=0；14 artifacts 全部 pending 隔离；injections=0（隔离正确性本身得到验证） |
| Behavior Transfer | **INCONCLUSIVE** | 无激活即无注入面，任何行为都不能归因 PD。仍跑完 transfer 会话留原生基线：env-var 新面上 pain 第 5 次复现（同因新形）+ 部分认知卫生（拒抄非法键/披露假设/备份/用区分性信号验证），均**不可归因 PD** |

## 断点清单（全部有证据）

| # | 断点 | 层 | 证据 | 处置 |
|---|---|---|---|---|
| ① | **修复轮收敛死锁（PRI-700，P1）**：requiredChanges 文本中的 v2 对抗 case 名（v2-unavailable/truncated/alias…）诱导修复 LLM 声明 `requiresContextVersion:2`/`expectedDecision:'propose_correction'`（违例）+ 漏 ruleContext，output-contract gate 每次正确拒绝 → 两链 × 2 模型 × 3 次 force-recovery 共 **18/18 attempts 全灭**，链终止 failed，Owner 决策面不可达 | Quality × Pipeline 交界 | runs.reason 全文（evidence-package）；换模型违例形态不变 → 非 单模型缺陷 | **PRI-700 已立**（含修法建议：修复 prompt 注入通道 schema 白名单 + validator 错误全文回喂 + 对抗 case 命名与 contextVersion 词汇解耦） |
| ② | Bai glm-5.3-flash 大 payload 流方差：挂起（Request timed out）/中途 abort/900s 整耗尽交替；同日 lmstudio 27B 被外部实例挤死（VRAM 23.5/24.5GB） | Infrastructure | runs 时间线 8+ 次超时；nvidia-smi；240s 探测挂起 | 记录为 BP-2（P2）；PRI-677（per-stage timeout）承接；flatkey 切换后违例形态不变证明 ①与 provider 无关 |
| ③ | dev profile 陈旧锁（Round 2 残留 pid）阻止网关启动 | Infrastructure（环境） | gateway failed to start；锁内 pid 已死 | 手工清锁（BP-2/ENV-2 记录） |

**断点演进弧**（三轮 lab）：667（数据路径）→ 670（timeout 接线）→ 683（内层帽）→ **700（LLM×契约，质量层）**。前三者已修且**本轮全部生产实证**：

| 修复 | 本轮实证 |
|---|---|
| PRI-667（evaluator stage2 tier2 证据） | progressive_evaluator=ON 全程，双链 evaluator 一次跑通，对抗重放真实执行 |
| PRI-670（profile timeout 接通） | aborts 精确落在 900000ms/1500000ms profile 边界（非 300s 硬顶） |
| PRI-683（300s 内层帽） | **592s artificer 请求存活成功**——Round 2 必死区间；timeoutMs 成为唯一权威 |

## Principle Quality（数据集 principle-quality.json 全文）

```
Score: 90/100（Gold 边界——保守计 88-90 区间，落在 Gold/Useful 分界）
  Owner Understandability 22/25（plain-title 达标；thesis 学术化措辞扣分）
  Causal Understanding   24/25（双层根因：权威反转 + 非区分性验证信号——满分形态）
  Generalization         18/20（scope 跨 config/env/payload/schema；词汇锚定 config 域扣分）
  Evidence Quality       13/15（agent turn 引用+诚实 ambiguity notes；全量 trace 不可达扣分）
  Actionability          13/15（6 反模式+可执行检查方向；"如何廉价枚举消费者"遗留给 rule 层——死于 PRI-700）

Strength: 双层根因、自省风险 5 条、跨域 scope
Weakness: thesis 密集措辞、config 词汇锚定、无 golden 示例捆绑（rule 层缺口）
Owner Feedback (SIMULATION): 原则 APPROVE / 规则 REQUEST_REVISION（与管道门一致）

Safety: PASS（2 WARNING，均为管道自省自己发现——
  over-generalization: forward-declared 字段/外部消费者误伤（rule 只写门不删除，敞口有界）
  negative-transfer: 强制 pre-write 摩擦需随风险缩放；事故热修路径需逃生门）
```

## Issues Found（数据集 issues.json 全文）

- **PRI-700**（P1，已立）：修复轮 requiredChanges 词汇 × 输出契约诱导性违例死锁。
- **BP-2**（P2，记录）：Bai 大 payload 流方差——基础设施层余留，PRI-677 承接。
- **ENV-1**（P3，记录）：CLI 侧 workspace 解析穿透 home 链（警告可见、-w 覆盖生效；隔离性靠纪律）。
- **ENV-2**（P3，记录）：dev profile 陈旧锁 + lmstudio GPU 被外部实例挤占。

## 回答 Benchmark 核心问题

> PD 是否已经成为一个能够把 Agent 失败转化为可理解、可治理、可激活、可迁移经验的 Evolution System？

**本轮证据支持到「可理解、可治理」为止，且质量超出前两轮**：真实失败被 5 层因果链理解（0.8）、被蒸馏成 90 分级原则（0.86）、被编成诚实标注缺口的可执行规则、被对抗门与 rollout 逐 case 审查、低质产物零放行、注入面零泄漏——**「失败→可裁决的行为改进提案」闭环第三次稳定复现，且本轮 evaluator 首次给出 approved 0.84**。

**「可激活、可迁移」仍未走通**——第三次被阻断，但阻断点性质发生了决定性变化：不再是 PD 自己的基础设施（三修复全部实证有效），而是**修复循环里 LLM 产出与输出契约的兼容性**（PRI-700）。这是质量层问题，修法明确（schema 白名单注入 + validator 错误回喂），且一旦修复合拢，下一 episode 的复跑只剩「修复轮→Owner 决策→激活→transfer」一段（约 1-2 小时），且本轮已备好：原生基线 transfer 数据、同因新面 pain 源、全部可复算证据包。

## Final Judgment

**PARTIAL_EPISODE**

判定理由：全链 10 段中 6 段真实走通且证据质量高（pain/diagnosis/principle/rule/evaluation/治理门）；4 段未达（owner-decision/activation/behavior/transfer）但堵点单一、已立 P1、非架构缺陷；数据集 11 文件 schema 完整可复算；不满足 GOLD_EPISODE 的激活+迁移双门槛，显著高于 FAILED_BUT_VALUABLE（大量管道能力首次得到生产实证）。

## 纪律声明

- 无人工制造 pain：pain 来自真实会话真实失误 + 真实纠正话术（同族第 4 次自然复现）。
- 未降低任何 gate/验证标准；18 次修复尝试全部让 gate 独立拒绝，无人工放行。
- Owner 决策未被 AI 代投：生产路径 approvals=0；owner-mode 评审明记为 SIMULATION。
- lab workspace 一次性隔离；live 零污染（session 计数核验 0）；live 网关/安装版全程未触碰。
- 操作员干预仅限合法面：force-recovery（CLI 恢复出口）、runtime profile 切换（Round 2 同款）、timeoutMs 调优——全部在报告中逐条留痕。

## Next（Episode 002 入场条件）

1. **PRI-700 修复**（P1）——唯一断点；修法三选一已写入 issue。
2. 复跑窗口：**只需修复轮之后的链段**（scribe reopen→artificer→evaluator→rollout→Owner 决策→activation→S004/transfer），估 1-2 小时。
3. 本轮遗留资产直接复用：`D:\pd-labs\evolution-episode-001\`（experiment-manifest/数据集/evidence-package/transfer 夹具）、90 分级原则产物、原生基线行为数据。
