# Intent ON/OFF 试点 — Owner 决策卡（草稿，无真实运行结果）

> **状态：DRAFT。** 本卡当前不含任何真实 T6 结果 — 真实 T6 资格为 BLOCKED（见 §2）。
> 真实运行完成前，本卡所有结果字段保持 TBD；任何数字都必须能从 `decision-input.json` 与归档原始证据复算。

工单：PRI-1259。配对预注册：`experiment/intent-engineering-onoff/PREREGISTRATION.md`（DRAFT / NOT FROZEN）。

## 1. 结论（当前）

**T6 启动资格：BLOCKED — 真实 T6 不得启动。**

机械复算（2026-11-22，main `3b8d1e303`，`npm run lab:qualify`）：

```json
{ "status": "BLOCKED",
  "blockedReasons": ["EVIDENCE_MISSING_FOR_CLAIM","DATA_PATH_AUTHORIZATION_INVALID","DATA_INTEGRITY_UNPROVEN",
    "NO_READY_SOURCE_GROUPS","D2_NOT_APPROVED","D5_NOT_APPROVED","D6_NOT_APPROVED","MODEL_CALIBRATION_NOT_RUN"],
  "t6Permissions": { "confirmatoryT6Allowed": false, "exploratoryT6Allowed": false, "promotePossible": false } }
```

阻断原因与 T7a-judge 报告 §10 一致，另增 `EVIDENCE_MISSING_FOR_CLAIM`（#2740 终审 12.1 加固：声明性 α/最低组数必须绑定冻结预注册证据；当前预注册为 DRAFT，属如实机械结果，非回归）。

## 2. 授权缺口（D2–D6 逐项，全部 NOT_GRANTED / UNVERIFIED）

| 决策 | 内容 | 状态 | Owner 需提供的批准参数 |
| --- | --- | --- | --- |
| **D2** 模型与试点授权 | 裁判/生成模型、预算、统计参数 | NOT_GRANTED | 模型/provider/version；许可与用途；是否允许外部模型调用；总预算上限；α；重复次数；硬护栏；确认性最低独立来源组数；区间方法/置信水平/精度目标；同族（ZAI GLM-5.3）裁判处置 |
| **D3** 快照治理 | 真实 T1 快照执行 | NOT_GRANTED | 执行人；节奏/时间窗口；存储位置（须与 D6 同时批准） |
| **D4** INTENT 授权 | 进入实验工作区的 INTENT 文档 | NOT_GRANTED | 文档完整内容/版本/SHA-256；目标路径（`.principles/INTENT.<lang>.md`，lang 二选一）；允许用途和范围 |
| **D5** Owner 盲评授权 | Owner 20% 抽查与盲评 | NOT_GRANTED | 盲评样本量；Owner 投入；最低一致率；最大位置翻转率；复评/仲裁规则 |
| **D6** 全保真数据授权 | 真实数据集/快照/Blob 使用 | NOT_GRANTED | 样本范围与 dataset digest；快照/Blob 范围；允许机器；存储位置；保留期限；最小化投影；撤回流程；授权用途 |

口头推断、聊天摘要、旧实验授权、合成 fixture 均不构成批准。真实模型调用数 = 0，Owner 盲评样本 = 0。

## 3. 结果字段（真实 T6 完成后填充）

| 字段 | 值 |
| --- | --- |
| 判定（IMPROVED / REGRESSION / INCONCLUSIVE / HOLD） | TBD |
| unknownsCouldChangeVerdict | TBD |
| 胜 / 负 / 未定组数（plannedGroups 分母） | TBD |
| k(n, α) 阈值与双侧判定过程 | TBD |
| 硬护栏 1：on 臂链路完成率 ≥ off 臂 | TBD |
| 硬护栏 2：误拦抽查结果 | TBD |
| Intent 干预到达率（ON 样本 content-hash 证据 / 分母） | TBD |
| 次结果（拦截数/schema 通过率/时延/字符量） | TBD |
| 限制（后见信息、同族裁判） | 见预注册 §7，结果解读时必须复述 |

## 4. 允许的决策建议边界

- IMPROVED 也不自动打开生产默认开关；生产默认变更需独立决策。
- EXPLORATORY_ONLY 结果永远不得 PROMOTE。
- HOLD / INCONCLUSIVE 是合法终态，如实记录。
- 本实验不证明历史行为当时违背意图，也不证明真实宿主长期行为改善。

## 5. 解除 BLOCKED 的最短路径（供 Owner 决策参考，不代决策）

1. 批准 D3 + D6 → 按 D3/D6 边界执行真实 T1 快照；
2. 对真实快照运行 `lab:probe` → 得到真实 READY 组数（n）；
3. 批准 D2（含 α/最低组数/预算）+ D4（INTENT 文档与路径）+ D5（盲评规则）；
4. 冻结 `PREREGISTRATION.md`（记录全部 digest）；
5. 重跑 `lab:qualify`：CONFIRMATORY_READY 才允许确认性 T6；EXPLORATORY_ONLY 需 D2 显式探索性授权且永不 PROMOTE；仍 BLOCKED 则继续停止。
