# SPEC-PD-PRR-001 — Gate B Owner Decision Card（2026-10-17）

| 项目 | 值 |
|---|---|
| 状态 | **全部 PENDING** — 本卡只提供推荐值、备选值、证据与风险；未经 Owner 明确裁决不产生任何授权 |
| 上游 | SPEC v1.3（§3.1 三种 NOT_COVERED、§10.1 F 表）、Gate A 审计报告 A-02/A-04/A-05、Gate B 实验方案 §1~§4 |
| 最终结论 | Gate B 真实执行授权：**APPROVED（✅勾选名单）/ PENDING / REJECTED 三选一，均须 Owner 手工勾选或批示；本文档自身不预置任何勾选** |

---

## D-01 数据与费用授权（Gate B 读取与外发边界）

**需要裁决**：Workspace 选择、可读取字段清单、脱敏方式、外部模型调用许可、预算上限、撤回方式。

- **推荐值**：仅本机只读；workspace = PD 自身（Owner 指定）；读取字段 = Pain 结构化摘要 + 诊断摘要 + candidate/task/lineage ID 字段（**不含 Raw 原文、不含 Owner 原话全文**）；脱敏 = 聚合统计 + ID 级引用，正文示例仅留 D-01 逐项勾选字段；外部模型调用 = **0 次**；预算 = 0Token/0$；撤回 = 删除本机脱敏样本 + 授权状态标 REJECTED，无生产痕迹。
- **备选值**：放开 ≤3 次、【非生产】脱敏摘要送本地配置模型验证 H1（每段 ≤500 字符，逐段登记）；费用上限 Owner 设定。
- **证据依据**：Gate A 全部真实覆盖率 NOT_MEASURED（无授权分母未知）；Codex G2A 冻结文本仅覆盖 capture/retention/diagnosis-egress，不含 agent read-back（§3.1）；首实验按方案 §3 安全约束即可无外发完成 M1~M5。
- **风险**：不获批 → Gate B 保持 BLOCKED（可接受，纯文档路径损失）；获批过宽 → 私密内容出本机的不可逆风险。
- **最终授权**：☐ 按推荐值 批准 / ☐ 按备选值 批准 / ☐ REJECTED / ☐ 其他：____________

## D-02 原则召回资格（Recall eligibility）

**需要裁决**：Gate B 的 M1 资格集合口径。

- **推荐值**：资格 = **宿主有权披露的有效激活原则集合**（候选资格 ∩ 有效生命周期）；不计"本轮实际注入集合"；已停用（deactivated）、已撤回（revoked）、从未有效激活的原则一律**不计入资格**（排除，单独计数）。
- **备选值**：资格 = 注入集合与有效激活集合的**交集**（更小分母、更低灵敏度但零误召回歧义）。
- **误召回风险**：推荐口径 wider 侧的边界风险 = 宿主有权披露但本轮未注入的原则仍可被 Recall（D-02 裁决即视为接受该语义并进入资格投影规则冻结）；交集口径则低估真实可用面。
- **证据依据**：Gate A A-04：candidate 集合 ≠ 注入集合（budget/fair-rotation/exclude 三重删减，静态实证；真实差异分布 NOT_MEASURED）。
- **撤回/停用原则资格**：**待 Owner 裁决**——v1.3 §3.3 已冻结"未裁决前一律无资格、不可查询"的保护性默认；本项裁决是把该默认转正或修改的决定，不是既有事实。
- **最终授权**：☐ 推荐口径 / ☐ 交集口径 / ☐ 另定：____________ （撤回/停用资格：☐ 维持无资格 ☐ 另定：______）

## D-03 Codex 证据读取（observation / correctionEvidence read-back）

**需要裁决**：Codex read-back NOT_COVERED 是否在 Gate B/C 前补齐。

- **推荐值**：**维持 NOT_COVERED 不补齐**——首个 Pilot 无论落在 Codex 与否，M3 只依赖授权摘要字段；observation/correctionEvidence 披露给 Agent 是新的授权决定，单独提案，不与 Gate B 捆绑；Gate B 若选 Codex 宿主，只测"授权摘要字段"可达性，不含 read-back 扩展。
- **备选值**：Owner 批准最小 read-back 提案（仅 `governance_observation.visible_text` 的授权子集 + 32 轮窗口 + retention_class ∈ {operational, promoted}），进入单独披露决策后才可用作证据来源。
- **证据依据**：Gate A A-04：G2A 冻结文本完全没有 agent read-back 条款；五种 consent 状态全部 per-workspace feature flag 为权威；observation-only ≠ 有完整 Raw，更 ≠ Owner Correction 已关联。
- **风险**：维持现状 → 三宿主能力不对等如实存在（Codex 无法宣称与 OpenClaw 同等证据丰富度）；过早补齐 → 在没有行为收益证据（H1 UNPROVEN）前扩大隐私披露面。
- **最终授权**：☐ 维持 NOT_COVERED（推荐）/ ☐ 另起最小 read-back 提案 / ☐ 其他：____________

## D-04 WorkBuddy 授权（transcript 采集 consent）

**需要裁决**：是否为首个实验/Pilot 立项 WorkBuddy 数据采集 consent。

- **推荐值**：**暂缓立项**——第一实验轮不包含 WorkBuddy。理由：无 transcript self-report 通道（recorder 自报 unsupported）、capability 自报 unknown、Desktop 链路未实测（U6）；先补 consent 的边际收益低于把已有的 OpenClaw/Codex 证据验证清楚；符合"每新增宿主单独评估"的 v1.3 §6 纪律。
- **备选值**：并行立项最小 consent 设计（为 Gate D 铺路），但本轮实验不用其数据。
- **证据依据**：Gate A A-02/A-05：WorkBuddy 数据侧三宿主最弱；A-05 结论"WorkBuddy 暂缓（NOT_RUN；等 consent 立项）"。
- **风险**：暂缓 → 三宿主时间表对 WorkBuddy 延后（本就是分项 Gate D 语义）；提前立项 → 在 H1/H2 未证实前投入宿主实机验证成本。
- **最终授权**：☐ 暂缓（推荐）/ ☐ 备选：另行立项、本轮不用于实验 / ☐ 其他：____________

## D-05 Pilot 宿主（首个实验宿主）

**需要裁决**：Gate B 首个实验宿主。

- **推荐值**：**Codex 首选**。依据（Gate A A-05 邻接证据）：Skill+CLI 最小接线；G2A 披露/consent/kill switch 已存在，可作为 read-back 授权决策的最短路径延伸；脱敏管线已有；即时可用 E2E 差距最小。代价/风险：Shell 残余读取能力恒存（§3.2 已冻结判断——Skill 文本不是访问控制）；observation 路径证据丰富度中等。
- **备选值**：OpenClaw。依据：证据最富（canonical Pain + user_turns 三级回退），exact 锚点可达。代价：必须先做 manifest `contracts.tools`/Tool SDK 注册（当前无实例，宿主面改动 > Codex）；E2E 前置工程更多。
- **暂缓值**：WorkBuddy（见 D-04）。
- **比较表**：证据丰富度 OpenClaw>Codex>WorkBuddy；最小接线 Codex>OpenClaw>WorkBuddy；隐私风险三者 Shell 残余同在、Codex 另有 observation read-back 未覆盖面。
- **最终授权**：☐ Codex（推荐）/ ☐ OpenClaw / ☐ 其他：____________（Gate B 数据实验宿主与后续 Gate C Pilot 宿主**允许分别裁决**：☐ 一致 ☐ 分开）

---

## 关联裁决（不可跳过）

| 项 | 语义 | 勾选 |
|---|---|---|
| Gate B 真实执行授权 | 上述 D-01~D-05 与预注册完成后，允许开始真实数据只读测量 | ☐ APPROVED（附生效日期：____） / ☐ PENDING / ☐ REJECTED |
| PRI-1000（A4 汇总）启动 | 允许将三票审计产物继续汇总成 B-ready 提案 | ☐ 允许启动 / ☐ 暂缓 |
| Recall 实现（Gate C 工作包） | 生产代码改动 | ☐ 仍禁止（推荐） / ☐ 批准：________ |

> 裁决登记方式：Owner 在 PR 评论/线下任选其一；登记后本卡状态从 `PENDING` 转为记录结果（叠加"由 Owner 于 <日期> 批示"），**不由任何 AI 会话代填**。
