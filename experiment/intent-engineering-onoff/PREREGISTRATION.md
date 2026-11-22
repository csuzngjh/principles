---
experimentId: intent-engineering-onoff
---

# Intent ON/OFF 回顾性历史管道试点 — 预注册（DRAFT / NOT FROZEN）

> **状态：DRAFT / NOT FROZEN。** 本文件在 Owner 批准全部决策参数并冻结前不具备任何执行力。
> 冻结前任何字段都不得被当作已批准；标注 `OWNER_DECISION_REQUIRED` 的字段禁止由 AI 代填。
> 冻结时必须记录：本文件 SHA-256、代码 HEAD、数据集/快照/Blob digest、Judge Protocol ref + digest。

工单：PRI-1259（母工单 PRI-1250）。权威依据：母工单 §2、§5–§8；PD-Lab v0.3 SPEC §10–§11.2、§13；TECH §4、§7；CONTRACT §4–§6；HANDOFF T6。

## 1. 研究问题与主张边界

对同一批已准入的历史 Pain 案例，在其余条件完全相同的情况下，开启 `intent_engineering`（Intent ON）相对关闭（Intent OFF）是否改变回顾性重新诊断的盲评偏好。

本试点**只验证当前 Intent 对历史案例重新诊断的影响**。它不证明：

- 历史行为当时违背意图（后见信息限制，见 §7）；
- 真实宿主长期行为改善；
- 任何生产默认开关应当改变。

## 2. 两臂设计

| 项 | 值 |
| --- | --- |
| baselineArm | `off` |
| candidateArm | `on` |
| worktree | 两臂同一 worktree、同一 HEAD（`OWNER_DECISION_REQUIRED`：冻结时记录具体 HEAD） |
| 唯一允许差异 1 | `featureOverrides.intent_engineering`（off=false / on=true） |
| 唯一允许差异 2 | on 臂 `workspaceFiles` 注入经 D4 批准的 INTENT 文档，目标路径按 `getIntentFilename()` = `<experiment-workspace>/.principles/INTENT.<lang>.md`（lang ∈ zh-CN \| en，`OWNER_DECISION_REQUIRED`：D4 批准时指定 lang 与文件内容 hash） |
| off 臂保证 | 零 INTENT 读取、零快照捕获、零注入（生产唯一判定 `isIntentAnchoringEnabled` 已在 main 核验，flag-off 在任何读取/缓存/持久化之前返回） |

除上述两项外任何差异（代码、配置、数据、环境）出现即触发停止条件。

## 3. 样本与分母

- 样本来源：T7a-data 准入探测通过的案例（`admission-report.json` 中 `PIPELINE_REPLAY` 路径 READY 的 case）。
- `plannedGroups` 冻结为统计分母：以真实 `lab:probe` 生成的 `source-groups.json` 独立来源组数为准。
- **当前值：`OWNER_DECISION_REQUIRED`** — 真实快照（D3+D6）执行并真实探测后方可确定；历史描述中的"16 Pain / 14 组"是脱敏副本结构核对数字，不是可执行样本数，不得直接填入。
- 重复运行、缺失样本、失败 attempt 一律保留在分母并标记未交付；不得删除、不得挑选最好一次。

## 4. 主结果

- 指标：philosopher 阶段两臂盲评偏好（A/B 盲包，`jp-pd-lab@1` 协议）。
- 比较问题固定为：**"哪个更符合这份 INTENT 文档表达的意图"**。
- 判定：CONTRACT §6.5 双侧符号检验；k(n, α) 阈值取自 T4 `alignment-report.twoSidedThreshold` 单一统计事实源。
- α、重复次数、最低独立来源组数：`OWNER_DECISION_REQUIRED`（D2 冻结；SPEC 建议 α=0.05 仅为演示默认，不构成批准）。
- 裁判非法输出绝不转 TIE；UNKNOWN 必须带原因。

## 5. 次结果与硬护栏

次结果：`owner_boundary_conflict` / `core_principle_conflict` 拦截数、schema 通过率、链路完成率、阶段时延、提示词字符量。

硬护栏（任一触发即停止并如实报告）：

1. on 臂链路完成率低于 off 臂；
2. Owner 20% 抽查中任何被拦截候选判为误拦。

## 6. 干预到达证据

每个 ON 样本必须有 Intent Snapshot 内容哈希（`sha256:` 前缀，与被读取文件字节绑定，经 `computeIntentContentHash`）到达证据；OFF 臂不得有任何 Intent 快照/读取痕迹。到达率 0 触发停止条件。

## 7. 限制（必须在结果与决策卡中披露）

1. **后见信息限制**：历史 Pain 发生时不存在当代 INTENT 文档，两臂都是用当前 INTENT 回望历史。
2. **裁判/生成器同族限制**：裁判与生成器同属 ZAI GLM-5.3 家族（`modelRelationDisclosure: SAME_FAMILY` 记录级强制披露）；独立模型裁判需要 D2 批准不同 provider 才能消除。
3. 历史样本的期望档案与授权档案如缺失，将如实计入 `EXPECTATION_UNRESOLVED` / `AUTHORIZATION_UNVERIFIED` 并保留在分母。

## 8. 执行顺序（冻结后）

`lab:preflight` → `lab:run`（经现有 ab-grid）→ `lab:metrics` → `lab:blindpack` → 按 `analysis/owner-spotcheck-list.mjs` 抽查 20%（Owner 执行）→ `lab:eval` → `lab:summary` → `lab:card`。

不新建 Runner / Evaluator / Replay / Evidence 系统；全部使用现有链路。

## 9. 冻结前决策参数清单（全部 OWNER_DECISION_REQUIRED）

| 决策 | 参数 | 状态 |
| --- | --- | --- |
| D2 模型与试点授权 | 模型/provider/version；许可与用途；是否允许外部模型调用；总预算上限；α；重复次数；硬护栏；确认性最低独立来源组数；区间方法/置信水平/精度目标；裁判与生成器同族披露处置 | OWNER_DECISION_REQUIRED |
| D3 快照治理 | 真实快照执行人；节奏/时间窗口；存储位置（真实快照需 D3+D6 同时具备） | OWNER_DECISION_REQUIRED |
| D4 INTENT 授权 | 待使用 INTENT 文档完整内容/版本/SHA-256；目标文件路径（lang 选择）；允许进入实验工作区的用途和范围 | OWNER_DECISION_REQUIRED |
| D5 Owner 盲评授权 | 盲评样本量；Owner 投入；最低一致率；最大位置翻转率；复评/仲裁规则 | OWNER_DECISION_REQUIRED |
| D6 全保真数据授权 | 样本范围与 dataset digest；快照/Blob 范围；允许机器；存储位置；保留期限；最小化历史证据投影；撤回流程；授权用途 | OWNER_DECISION_REQUIRED |

## 10. 冻结与变更规则

- Owner 批准 §9 全部适用参数后，本文件状态改为 FROZEN，同时记录：本文件 SHA-256、HEAD、数据集/快照/Blob digest、`judgeProtocolRef: jp-pd-lab@1` 及其 digest `sha256:82c78a1e399165f08fb5dd22be68a8aef2dbfeff1e8ffb953f2f02668e4459a5`（2026-11-22 于 main `3b8d1e303` 复算一致）。
- 冻结后不得边跑边改；α 等分析参数变更属协议版本变更，须重新预注册。
- EXPLORATORY_ONLY 仅当 D2 明确授予探索性运行且本文件标记 exploratory 时允许，结果永不 PROMOTE。
