# PL 正式四条件对照实验 — 三种子综合报告（PLE-PILOT-01-FORMAL, Seeds 1-3）

- 日期：2026-10-23；路线：外部 `zai-coding-cn` / `glm-5.3-flash`（Owner 编程套餐，三种子**同供应商同模型**，完全可比）
- fixtureHash：`4c3ea4ab29ce…91e9a4`（每种子运行前重算一致）；授权：`g2-real-run-authorization.v1`（runs/formal-2026-10-23/）
- 对照：EA 历史 × {policy, summary, raw, none}，同通道投递、固定配对序、每 arm 独立会话与账本
- 总用量：**166/1536 请求**（54+55+57）；标价预留上界合计 **$0.178**（套餐配额消耗，非账单）；**零重试、零修复、零 INVALID_PROTOCOL、ownerAsks 全 0、60/60 裁定 dataQuality=VALID**

## 一、每种子执行台账

| 种子 | studyId | studyHash（前 16） | 请求 | 异常 |
|---|---|---|---|---|
| 1 | PLE-PILOT-01-FORMAL | `63463cddd6cf5e42` | 54 | 无 |
| 2 | PLE-PILOT-01-FORMAL-S2 | `b59773bceeccc81f` | 55 | 无 |
| 3 | PLE-PILOT-01-FORMAL-S3 | `f18b2a5fe8419c8f` | 57 | 无 |

每个种子均产出完整六件产物（principle-study / adjudications / actor-inputs / budget-audit / study-hash / sidecar-validation），sidecar 校验全部 0 problems。

## 二、四条件 × 三种子聚合（每 arm 15 机会 = 3 种子 × 5 机会）

| 条件 | 任务完成 | ALIGNED | ACCEPTABLE | MISALIGNED | 查验成本均值（机会均摊） |
|---|---|---|---|---|---|
| policy（原则） | 12/15 | 11 | 1 | 3 | **11.0**（14/9/10） |
| summary（摘要） | 12/15 | **12** | 0 | 3 | **8.3**（8/8/9） |
| raw（原始经历） | 12/15 | **12** | 0 | 3 | **10.3**（8/11/12） |
| none（无经验） | 12/15 | **8** | 4 | 3 | **15.3**（12/15/19） |

- 全部 60 机会中 P3 均FAIL（60/60）——P3 是任务难度天花板，非组间效应。
- 失败分母完整：无排除、无静默删除；所有裁定行均在 adjudications.jsonl。

## 三、跨种子一致的模式（三种子方向相同）

1. **无经验组的过度验证稳定复现**：none 每个种子都是查验成本最高者（12/15/19），且对齐降级（ALIGNED 8/15 + ACCEPTABLE 4/15 = 过验被裁判降级）。三种经验形式（policy/summary/raw）一致地消除该过验。
2. **C-A 抽象增量方向：否定信号跨种子稳定**——summary 在对齐（12 vs 11/15）与成本（8.3 vs 11.0）上均 **≥ policy**，policy 无任何单一维度优于 summary。raw 与 summary 几乎等价（信息保持型表示已足够）。
3. policy 条件在 Seed 1 出现独有 P1 过验（成本 6、ACCEPTABLE），Seed 2/3 消退（9/10、全 ALIGNED）——单种子信号，不稳定，不计入结论。
4. ownerAsks 全 0：未出现不必要的 Owner 打扰。

## 四、结论（按预注册判定框架）

- **C-A（本任务分布/成本下）**：原则文本**未产生比高质量摘要更好的未来行为**；摘要与原始经历等价且最省。这是 SPEC §2 预设的合法结果之一——**支持"高质量摘要/普通 Memory 方案已可获得同等行为收益"，削弱"原则抽象表示有独立增量"的假设**。
- **经验 vs 无经验（观察性，C-E 对照未入组）**：经验（任意形式）降低过度验证成本的效应跨三种子方向一致——值得后续以完整 C-E 对照（E0/EB/EN）正式检验。
- **状态**：三种子齐备、方向一致 → C-A 在此任务/模型/成本条件下可判为 **NOT_SUPPORTED（原则表示无增量）**，边界：单任务族（动态验证权衡）、单历史（EA）、单模型（GLM-5.3-Flash）、n=3 种子。

## 五、可比性与限制

- 三种子全部使用 `zai-coding-cn/glm-5.3-flash`（无模型切换），同 fixtureHash、同授权 caps——**完全可比，无跨模型混淆**。
- 值级输出质量：60 机会中未出现损坏 JSON（GLM-5.3-Flash 的结构化输出遵守度与 Luna 的失败形成对照）。
- 实际消耗按 provider usage 字段记录于 budget-audit.json（tokenAudit totals 全 available）；标价数字仅为预留上界，不代表套餐账单。
