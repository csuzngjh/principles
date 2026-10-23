# C-E 四历史对照实验 — 研究设计核对表与授权材料（PENDING OWNER APPROVAL）

- 日期：2026-10-23；轮次 studyId：`PLE-PILOT-01-CE`（新轮次，不复用/覆盖 C-A 的 `PLE-PILOT-01-FORMAL*`）
- 冻结预注册：**无需新预注册文件**——C-E 的全部定义已在冻结的 `fixtures/preregistration.json`（fixtureHash `4c3ea4ab29ce…91e9a4`，本轮重算一致）中：claims[0]（C-E）与 contrastDesign.E0/EA/EB/EN 原文逐字可用
- 模型路线：`zai-coding-cn / glm-5.3-flash`（与 C-A 三种子完全一致，跨轮可比）

## 1. 研究设计核对表

1. **假设（预注册原文）**：相关受控历史（EA/EB）以方向适当的方式改变候选策略范围与未来行动；无关变化（EN）不漂移决策。
2. **各条件实际提供给 Agent 的信息**（同通道 research-same-channel-v1、位置 after-task-text、2000 chars）：
   - **E0**：零生成调用、哨兵冻结、**空载荷**——仅 world manual 基线先验（runner 内建 E0 流程，语义与定义精确一致）；
   - **EA**：对"漏检教训"历史（PLAT-2214 未发现消费者事故）做 I0 反思 → 冻结 policy 文本投递；
   - **EB**：对"过验教训"历史（当前证据已覆盖时过查烧掉时限）→ 同；
   - **EN**：与 EA 因果证据相同+仅无关差异的历史 → 同（**EA vs EN 的行为/候选等价=稳定性要求**）。
3. **唯一允许改变的变量**：历史内容（经 I0 冻结后的 policy 文本）。模型、manual、任务、投递通道/位置/预算、caps 全固定。
4. **主要指标与裁定**：四层独立报告（任务完成率 / 原则对齐 / 查验成本 / Owner 负担），机械 Oracle 唯一后果权威；arm 级行为 delta 矩阵 + 冻结 policy 文本 delta（预注册 primaryMetric 原文）。
5. **可支持/反驳**：
   - EA vs E0：漏检教训历史使 P1（漏检风险）更谨慎（事故=0、成本落 gold 档）→ 经验敏感性；
   - EB vs E0/EA：过验教训历史使 P2（证据已覆盖）零查验 → **方向适当性**（不同教训产生不同方向的行为改变=经验学习最强证据形态）；
   - EN vs EA 等价：表面形式鲁棒；分歧=表面拟合；
   - 零结果合法：无组间差异="该条件下无经验敏感性"（预注册 nullResultInterpretation 原文）。
6. **不能推导**：跨任务族泛化、长期保留、原则抽象价值（C-A 已答 NOT_SUPPORTED）、C-D 交付增量、其他模型外推。

## 2. 与 C-A 三种子已观测证据的衔接

C-A 的 none 条件（空载荷+manual，语义等价 E0 流程）三种子一致显示 **P2 过验（成本 12→19 递增、ALIGNED 8/15）**——这正是 EB 教训历史应纠正的行为；EA 条件三种子在 P1 保持零事故。C-E 将检验：**EB 的 policy 是否在 P2 复现 none→改善的差值**（方向适当性），**EA 的 policy 是否在 P1 产生相对 none 的谨慎差值**，以及 **EN 是否与 EA 等价**。

## 3. 判别力与 P3 问题

P3 全条件 FAIL（60/60，任务难度天花板）不损 C-E 判别力——组间差在 P1/P2/P4 三层可测；P3 占 20% 机会的浪费是真实的，**独立 P3-revised 任务版本**建议为独立后续（不混入本轮）。

## 4. 预算与请求上限（工程硬上限 / 标价估算 / 实际消耗分层）

| 层级 | 值 | 性质 |
|---|---|---|
| 每机会 HTTP | 48 | 工程硬上限（spawn 前 fail-closed） |
| 每 arm HTTP | 256 | 同上 |
| 全场 HTTP（4 历史 × 3 种子） | 1,536 | 同上 |
| 输入/输出 Token 每请求 | 8,192 / 1,024 | costGuard 预检上界（实测最坏 7,925B） |
| 单请求标价最坏 | $0.001741 | 标价估算（catalog $0.15/$0.5） |
| 单 arm 标价预留 | $0.446（cap $0.50） | 估算上界 |
| 全场标价预留 | $2.67（cap $5.00） | 估算上界 |
| 预期实际 | ~200 请求 / ~$0.35 标价当量 | C-A 实测每 arm 13-19 请求外推 |
| 套餐配额 | 按 provider usage 字段记录（budget-audit.json tokenAudit） | 实际消耗记录 |

E0 arm 零生成调用——全场实际生成调用仅 9（3 历史×3 种子）。

## 5. 执行顺序（冻结于授权记录 od3）

每种子依序 `E0 → EA → EB → EN`（固定配对序），种子间完全隔离（独立 transport/账本/会话）；建议 3 种子。

## 6. Owner 签署动作（唯一待决）

编辑 `runs/ce-2026-10-23/owner-decision.json`：`approved` 改 `true`、填 `decidedBy`/`decidedAt`——然后：
```
cd scripts && node dev/principle-learning-lab/run-formal-study.mjs \
  --authorization dev/principle-learning-lab/runs/ce-2026-10-23/authorization.json \
  --arms formal-ce --start-seed 1 --seed-count 3
```
未签署时同命令被门拒绝（已实测："does not carry approved: true"，零 HTTP）。
