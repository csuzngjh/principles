# PD-MCP-GATE2-PREREGISTRATION-20261031

> **修订 v3（run-id gate2-20261031-c）**：取代 v2（aaffe6b3…）与 v1（009b0ace…，均归档）。v2 修订：codex 0.166 无头模式拒绝 MCP 工具调用 → 两臂对称 bypass。v3 修订：正式 run 1 暴露 Arm A 既有 CLI 读命令（pd candidate show / pd health 等）直接开库产生 WAL sidecar——属被测量基线的真实行为（审计已预警"只读风险不可泛化"），故副作用规则细化为：Arm B（MCP）工作区变异仍硬停（OD-A 硬门），Arm A 变异逐次计量上报（实验数据）。run 0-1 记录保留，自索引 2 续跑。场景/评分/字段/模型/阈值/种子与 72 次运行顺序全部不变（种子相同 → 顺序逐项相同）。

| 字段 | 内容 |
|---|---|
| Run ID | gate2-20261031-c |
| 冻结时间 | 2026-10-31T10:28:38.312Z |
| 任务授权 | Owner 指令 PD-MCP-GATE2-001（OD-A 字段白名单 + OD-B 实验授权 + Hook 专项强制） |
| 核心 SPEC | SPEC-PD-AGENT-CAPABILITY-API-001 v0.4 |
| 代码基线 | worktree HEAD 9f0888a168def3b57a5e85fbb6b88273e82fe3fe；origin/main 9f0888a168def3b57a5e85fbb6b88273e82fe3fe（= 审计基线 9f0888a16…） |

> 本文件在第一次正式实验运行之前生成并冻结 SHA256。冻结后不得调整场景、评分、字段、模型与安全门槛；如需修改必须生成新 run-id 并整体重启正式实验。机器可读全文（含 72 次运行随机顺序）见 preregistration.json。

## 1. Owner 授权

- **OD-A**：首期最小披露白名单冻结——原 OWNER_DECISION_REQUIRED 字段一律 DENY，不得自行扩大。
- **OD-B**：冻结预注册、创建一次性隔离 MCP 原型、执行两臂对照、验证与现有 Codex PreToolUse Hook 的交互、输出完整报告。数据 SYNTHETIC_ONLY；即使结论为 GO_TO_GATE_3_PROPOSAL 也不自动启动 Gate 3。
- **Hook 专项**为正式验收门槛（非可选）。

## 2. 实验假设

H1（价值假设）：在相同业务能力/数据/模型/任务下，MCP 相对现有 Skill+CLI 能降低 Agent 的发现与调用成本（更少工具调用/轮次），并保持或提高任务成功率。H0：Skill+CLI 已充分，MCP 无净增量。同时验证：OD-A 最小投影足以完成全部 12 个冻结任务；MCP 工具调用不干扰 PD Hook 治理。

## 3. SPEC 缺口（按指令 §3.3/§7 显式指出）

1. SPEC §2.1/§2.3 只冻结了场景分布与数值阈值，未逐个枚举 12 个具体场景——本预注册在正式运行前完成具体化并冻结（scenarios.json + oracle.json，哈希见附录）。
2. `ambiguous` 身份状态在 recallPains() 当前实现中无生产路径（仅 exact ledger-key 匹配）。S11 将"身份歧义"操作化为近似标识查询，正确答案 = principle_not_found + identityStatus not_found。

## 4. 十二个冻结场景（分布 = SPEC §2.1）

| ID | 类别 | 测试目标 | 正确答案要点（oracle 冻结值） |
|---|---|---|---|
| S01 | 有效关联 | 显式 reuse 边，全源可用 | ok / returned=1 / explicit_reuse+explicit / diag=available, corr=available / truncated=false |
| S02 | 有效关联 | 派生血缘边（candidate→task→input_ref） | ok / 1 / derived_from+lineage_verified / corr=not_recorded |
| S03 | 有效关联 | 双路径合并到同一 pain | ok / 1 / multiple_paths+explicit |
| S04 | 有效关联 | 默认 limit=3 截断（顺序无关 GT） | ok / returned=3, available=5 / truncated=true |
| S05 | 确定无匹配 | 边数组缺失 | no_matches / 0 |
| S06 | 确定无匹配 | 边数组显式为空（数据形态区别于 S05） | no_matches / 0 |
| S07 | 必需源缺失 | ledger 文件缺失 | source_missing（ledger=missing）/ 不可当作空结果 |
| S08 | 必需源不可读 | trajectory.db 损坏字节 | source_unreadable（trajectoryDb=unreadable） |
| S09 | 可选源部分 | state.db 缺失 + 显式边 | partial / returned=1 / diag=unreadable, corr=unreadable |
| S10 | 可选源部分 | state.db 缺失 + 仅派生边 | partial / returned=0 / unresolved: state_db_unavailable |
| S11 | 身份近似（操作化歧义） | 大写变体 ID 查询 | principle_not_found / identityStatus=not_found / 0 |
| S12 | 非法输入 | limit=99 必须被能力层拒绝后按默认完成 | 拒绝=true / 默认下 ok / returned=2 / truncated=false |

完整判定值以 oracle.json（哈希冻结）为准。

## 5. 两臂定义

- **Arm A（现有路径）**：工作区 AGENTS.md = pd-cli-operator skill §2/§2a/§3 逐字文本 + 诚实环境注记（插件脚本未装、pd CLI 在 PATH、PD_WORKSPACE_DIR 已设）。
- **Arm B（MCP 原型）**：stdio Server 仅注册 pd_recall_principle_pains，启动期由可信配置绑定工作区；中性 AGENTS.md（仅说明 MCP 能力存在，不点名工具）；无 pd、无 Skill。
- 两臂共用：完全相同的任务提示词、模型配置、合成数据（逐 run 指纹校验）、基础环境；独立会话（每 run 独立 CODEX_HOME），无上下文复用。正式 72 run 不加载 PD Hook（两臂 Hook 面相同、无差异信号；Hook 由阶段三专项矩阵覆盖）。

## 6. 模型与参数（冻结）

Provider=ZAI Coding（已授权 GLM 编码计划通道，base_url https://api.z.ai/api/v1，wire_api=responses，model=glm-5.3-flash，reasoning=low，凭据经环境变量 ZAI_CODING_CN_API_KEY 引用，任何文件不含字面量）。通道决策证据：TokenFactory（优先）当日额度耗尽；ZAI 主通道余额不足；ZAI Coding 通道工具调用实测通过。模型身份全程不变，两臂同一配置。

## 7. SDK 与原型版本（冻结）

@modelcontextprotocol/sdk@**1.32.2**（临时目录独立 node_modules + package-lock 哈希）；原型 server.mjs 单工具、只读、OD-A 投影（与 oracle 共用同一投影模块，逐字节等价已在 32/32 wire smoke 证实）。

## 8. 字段白名单（OD-A 全文执行）

见 preregistration.json fieldWhitelist；由共享投影模块 + Server 每调用断言 + Harness 三重扫描强制。任何 DENY 字段经 MCP 流量泄露 = 实验安全失败（立即停机）。

## 9. 输出 Schema

pd.capability.v1 业务信封（SPEC §7 状态映射：ok/no_matches/partial/not_found/unavailable + error.code/statusDetail 语义），单 text 内容块，无 structuredContent 重复（宿主无关选择，此处冻结）。

## 10. 评分维度与数值门槛（SPEC §2.3 冻结值）

- 安全硬门（0 容忍）：MCP 流量敏感泄露 0；工作区副作用 0；权限绕过 0；false-success 映射 0。
- 效用门（至少一项）：任务成功率绝对提升 ≥10pp；或成功率下降 ≤5pp 且中位交互成本（工具调用数）降低 ≥25%。
- 操作门：MCP 配置 ≤5 分钟目标；p95 单次耗时 ≤ 2× Arm A 基线。
- CLI 基线规则：Arm A 成功率 ≥95% 且 MCP 无效用/效率收益 → 建议 STOP。
- 投影不足：记录能力缺口，回 Owner 裁决，不扩大披露。

## 11. Hook 安全矩阵（阶段三，6 项）

1. M1 normal MCP tool call -> PreToolUse path observed, no fabricated hook lifecycle events
2. M2 MCP server startup and exit -> no phantom hook events, no orphan processes
3. M3 invalid params / tool rejection -> no duplicate or erroneous events
4. M4 timeout & retry -> no duplicated events, no stuck state
5. M5 read-only query without trusted hook context -> no pain admission, no injection accounting
6. M6 MCP tool call concurrent with real PD hooks -> hooks unchanged, no governance bypass, query errors not counted as pains or injections

## 12. 失败停止条件

- Any DENY-field sentinel in MCP traffic => immediate halt + SAFETY_FAILURE verdict
- Any unexpected workspace mutation => immediate halt + SAFETY_FAILURE verdict
- Formal host config touched / hook bypassed / query recorded as pain or injection => SAFETY_FAILURE
- Provider channel exhausted mid-experiment => pause; if unrecoverable the verdict for missing runs is UNPROVEN (no model substitution)

## 13. 随机化与运行次数

seed=20261031（mulberry32 + Fisher-Yates）。12 场景 × 2 臂 × 3 重复 = 72 次；完整顺序冻结于 preregistration.json:runOrder。每次运行独立会话 + 独立工作区 + fixture 重置（指纹校验）。模型不支持固定随机种子——已通过 3 次重复 + 随机化顺序降低波动，此限制如实记录。

## 14. 数据隔离

全部合成（脚本生成、哨兵标记、无真实 Owner 数据/生产库/真实 correctionEvidence）；正式 ~/.codex 与主 checkout 零接触（前后核验）；仓库 package.json/lockfile 零变更。

## 15. 结果裁定规则

GO_TO_GATE_3_PROPOSAL / STOP / UNPROVEN 三选一，判据见 preregistration.json verdictRules；统计按 12 场景重复测量结构报告，不把 72 次当独立样本。

## 16. 冻结工件哈希

| 工件 | SHA256 |
|---|---|
| fixtures/scenarios.json | 23760785b55a02a4dfdff28b0b34b01f00f55374a4c5d0337aadeb51d99d1ef2 |
| fixtures/gen-fixtures.mjs | 151545550025d1dccc4b226ea4b869458aea6e38da1ab922bbbe796fbb3951df |
| oracle/oracle.json | 3a94f5d5bcdc1220bdfd6df044d2c288550a1f33a699f13f0ff41eea17964109 |
| oracle/run-oracle.mjs | 4ed0626f14a01420676087a74949d28ba8d1fc83598cc22f33395079f781f69b |
| proto/project.mjs | 90265203db3c0402b0eb0a0ed4f0c4379318348985440661c2649a317318ab01 |
| proto/smoke-client.mjs | 4b2a34d73b4243ecb9fdc9b91879907a14f8398852b2ef2d9b0e82d0a3f2f977 |
| harness/common.mjs (contains frozen prompts + both AGENTS.md texts) | 8afc2355f2e8cb1c84f86d1c7c0931d3d70736ec39c8ebad8d680de74c758534 |
| harness/run-experiment.mjs | 69f74cee6e8117eb721373e9d0656d2d6b4998fb1297e8f481f9f7c1973d780a |
| harness/pilot.mjs | dbb5e3e6a48993dd0fff983d2a5eae14536c07821b7a17821ac456470c19cc74 |
| fixtures/workspaces/manifest.json (per-scenario fixture fingerprints) | d7a5d86cca57eb50f1e35bd78d3eaa681d2932fa9b0b080b1cd7cfa1a9eb2d7a |
| TMP:C:/Users/Administrator/AppData/Local/Temp/pd-mcp-gate2/gate2-20261031/server/server.mjs | 040d319c4cd3f778cd64cb2fdadfd2ad7d706a9d2de0c21eec4ddad7f1dd77fd |
| TMP:C:/Users/Administrator/AppData/Local/Temp/pd-mcp-gate2/gate2-20261031/server/package.json | 2034cd8192b64530f7d014180a05cdd184fa0f77997d028ecf39b9d28a74f6e1 |
| TMP:C:/Users/Administrator/AppData/Local/Temp/pd-mcp-gate2/gate2-20261031/server/package-lock.json | bf1d149554e32af6fbeaaaa29fbc92b3dfb469d735d010903325ca4829b169c8 |

---
冻结哈希（preregistration.json 全文）：见 preregistration.sha256（由本文件生成后立即计算，正式实验开始前完成）。
