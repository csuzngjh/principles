# PL 首次真实四条件对照实验 — 执行报告（Seed 1）

- 日期：2026-10-23；路线：外部 `zai-coding-cn` / `glm-5.3-flash`（Owner 编程套餐）
- 授权：Owner 会话内指令（见 `owner-decision.json`）；预注册文件保持冻结 DRAFT 原样
- fixtureHash：`4c3ea4ab29ce…91e9a4`（运行前重算一致）；studyHash：`63463cddd6cf5e42…`
- 对照：EA 历史 × {policy, summary, raw, none}，同通道 research-same-channel-v1，固定配对序
- 用量：54/1536 请求上限；标价预留上界累计 $0.0574（套餐配额消耗，非账单）；零重试、零修复、零 INVALID

## 四层结果（每 arm 5 机会）

| arm | 任务完成 | 原则对齐 | 查验成本合计 | 结构备注 |
|---|---|---|---|---|
| policy（原则） | 4/5（P3 FAIL） | A, AL, MIS, AL, AL | 6+3+2+3+0 = **14** | P1 多查但判定降为 ACCEPTABLE（过验信号） |
| summary（摘要） | 4/5（P3 FAIL） | AL, AL, MIS, AL, AL | 3+2+0+3+0 = **8** | 最省；P2/P4 直接依赖既有证据 |
| raw（原始经历） | 4/5（P3 FAIL） | AL, AL, MIS, AL, AL | 3+2+0+3+0 = **8** | 与 summary 行为几乎一致 |
| none（无经验） | 4/5（P3 FAIL） | AL, ACCEPTABLE, MIS, AL, AL | 3+5+0+4+0 = **12** | P2/P4a 过验（多跑 harness-status） |

- 全 arm P3 FAIL：任务难度层差异，非组间效应。
- P4:phase-b 全部零查验通过（rot 揭示后依赖新证据）——"何时谨慎"的核心判别各条件都做对。
- ownerAsks 全 0；无越权、无误阻、无负迁移；无 INVALID_PROTOCOL。

## 初步观察（n=1 单种子单历史，非最终结论）

1. **原则组未优于摘要组**：任务结果相同、summary 成本更低且对齐更干净——C-A 抽象增量方向为**否定信号**。
2. **有经验 vs 无经验**：none 在 P2/P4a 过度验证（+2 次查验/总成本 +50%），三种经验形式均消除该过验——经验敏感方向为正。
3. policy 条件出现独有的过验信号（P1 成本 6、判定 ACCEPTABLE）——原则文本可能诱发额外谨慎。

## 局限

- n=1 种子（预注册要求 ≥3，Owner 决策项）；单历史（C-E 未入组）；GLM-5.3-Flash 单模型外推受限；值级输出质量未见异常但需多轮观察。
- 结论状态：`PARTIALLY_OBSERVABLE`（机制全通、真实行为已观测；可判定结论需补种子）。
