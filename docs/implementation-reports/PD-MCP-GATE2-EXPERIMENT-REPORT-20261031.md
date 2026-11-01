# PD-MCP-GATE2-EXPERIMENT-REPORT-20261031

| 字段 | 内容 |
|---|---|
| Run ID | gate2-20261031-c（v3 修订版；v1/v2 均归档于 preregistration.v1.* / v2.*） |
| 报告生成 | 2026-10-31T11:51:28.572Z |
| 核心 SPEC | SPEC-PD-AGENT-CAPABILITY-API-001 v0.4（Gate 2 — MCP Value Validation） |
| 代码基线 | 9f0888a168def3b57a5e85fbb6b88273e82fe3fe（origin/main = 审计基线 9f0888a16…） |
| 数据 | SYNTHETIC_ONLY（12 哨兵标记合成场景，零真实 Owner 数据） |
| **最终裁定** | **GO_TO_GATE_3_PROPOSAL** |

---

## A. Executive Summary

1. **72/72 次运行全部完成，证据完整。** Arm A（Skill+CLI）任务成功率 **77.8%**（28/36）；Arm B（MCP 原型）**100%**（36/36）；绝对提升 **+22.2pp**——效用门第一分支（≥10pp）以两倍余量通过。
2. **交互效率数量级改善。** 中位工具调用 A=14 → B=1（**−92.9%**）；中位端到端耗时 A=109s → B=14s；p95 比值 0.19×（远优于 ≤2× 操作门）。
3. **Token 成本 7× 差距。** 输入 Token A=10,978,368 vs B=1,567,463；输出 A=96,926 vs B=8,353（CLI 冗长原始输出 + 探索链是主因；记录于 turn.completed.usage，72/72 有数据）。
4. **安全硬门全部通过（MCP 臂零违规）。** MCP 流量敏感字段泄露 0；MCP 臂工作区/数据库副作用 0；权限绕过 0；false-success 映射 0/40 次调用（正确 ID 的 36 次调用全部与 oracle 逐字一致；另 4 次 agent 自发的非法 ID 探索调用均诚实返回 not_found）。
5. **反向安全发现：现有路径才是副作用源。** Arm A 36 次运行中 **18 次（50%）改变工作区状态**——17 组 WAL sidecar、4 次直接**创建** state.db、6 次**修改** state.db、1 次因错误 --workspace 在 .pd/.pd/ 嵌套目录 bootstrap 建库（现有 CLI 读命令缺乏 recall 专属暂存保护，审计"只读风险不可泛化"预警的实测印证）。
6. **Hook 专项 6/6 PASS（第一手证据）。** MCP 工具调用确实进入 PreToolUse（`mcp__pd_recall__pd_recall_principle_pains`，每次恰好 1 次，无重复）；Server 启动/退出零幻影事件、零孤儿进程；查询未被计入 Pain/注入；现有 Bash 门禁照常工作，无绕过。
7. **重大宿主发现：codex-cli 0.166.0 无头模式拒绝一切 MCP 工具调用**（approval=never 时 "MCP tool call requires approval"）；唯一无头执行路径是 `--dangerously-bypass-approvals-and-sandbox`——生产化的真实治理成本，须 Owner 裁决审批模型（Gate 4 前置）。
8. **OD-A 最小元数据投影足以完成全部 12 个冻结任务**（B 臂 100%；能力缺口为零——没有任何场景需要被拒绝字段才能正确作答）。
9. **两臂状态词表差异（CLI 原生 vs SPEC §7.1 信封映射）按预注册等价类评分**，不构成系统劣势；A 臂 8 次失败的字段级分布见 J 节。
10. **结论：在冻结工作流上 MCP 呈现显著、可重复的净增量（成功率、交互、时延、Token、副作用五维同向），且安全/只读/Hook 边界全部受控。** 按预注册规则输出 **GO_TO_GATE_3_PROPOSAL**（仅为方案提交授权；Gate 3 仍需 Owner 独立批准，宿主审批模型与 matcher 覆盖裁决为前置条件）。

## B. Owner Authorization

- **OD-A（字段披露白名单）**：逐字段执行（见 F 节）；原 OWNER_DECISION_REQUIRED 五项（canonicalId/painId/occurredAt/source/host/score/severity）全部 DENY。
- **OD-B（实验授权）**：预注册冻结→一次性隔离原型→两臂对照→Hook 交互验证→完整报告。全程 SYNTHETIC_ONLY；未创建 packages/pd-mcp / pd-application；未改生产代码/正式宿主配置/仓库依赖。
- **Hook 专项强制**（§6）：作为正式验收门槛执行完毕（H 节）。

## C. Frozen Preregistration

| 项 | 值 |
|---|---|
| preregistration.json SHA256 | ea5b4bde23ff36ec77b6b0b9894da75bb6028d4b3d959c31a22d1e932cb95928 |
| preregistration.md SHA256 | 091c7fd48019f6e84a803edbe3a65005e97c559c4f3b241de2c966f3bae0b7e2 |
| v1（被取代，零正式运行时修订） | 009b0ace93dc691af831f3d26bbb401b89609291dedd70bb2734b65c58258744 |
| v2（被取代，run 0 后修订） | aaffe6b34b189e1f31e5fba6dab43aff91d4a1081caf523c7f7e6d875ce19fa0 |
| 修订链 | v2：codex 0.166 无头 MCP 审批阻塞 → 两臂对称 bypass；v3：Arm A 既有 CLI 副作用转为计量项（详附） |
| 模型 | glm-5.3-flash @ ZAI Coding（api.z.ai/api/v1，Responses wire，reasoning=low，凭据经环境变量） |
| 通道决策 | TokenFactory 额度耗尽 / ZAI 主通道余额不足 → 已授权 ZAI Coding 通道（模型身份不变） |
| MCP SDK | @modelcontextprotocol/sdk@1.32.2（独立临时 node_modules + lockfile 哈希冻结） |
| Codex CLI | 0.166.0（CODEX_HOME 隔离双重证据：二进制 84 处引用 + 行为实验） |
| Node | v26.7.0 |
| 随机化 | seed=20261031，mulberry32+Fisher-Yates，顺序冻结于 runOrder（v1→v2 逐项一致） |
| 场景 | 12（分布=SPEC §2.1：4 有效/2 无匹配/2 必需源/2 可选源/1 身份/1 非法输入）+ SPEC 缺口 2 项显式登记 |
| 阈值 | SPEC §2.3 冻结值（安全 0 容忍；效用 ≥10pp 或 ≤5pp&≥25%；操作 ≤5min & ≤2×） |

## D. Experiment Environment

- 隔离 worktree `adhoc-20261031-mcp-gate2-f505ca`（基线 9f0888a16…，bootstrap READY）；全部产物在其 `.tmp/pd-mcp-gate2/`（git-15 合规）+ `%TEMP%/pd-mcp-gate2/gate2-20261031/`。
- 每次 run：确定性重建 fixture（指纹比对冻结 manifest）→ 独立 CODEX_HOME（config.toml+models.json；Arm B 含 MCP server 条目）→ `codex exec --json --dangerously-bypass-approvals-and-sandbox`（两臂对称）→ 指纹复检 + 哨兵扫描 + oracle 评分。
- 会话隔离：每 run 独立 home/workspace/会话，无上下文复用；fixture 每次重置。
- 主 checkout 用户修改与真实 `~/.codex` 全程零接触（收尾核验见 K 后）。

## E. MCP Prototype

调用链（与 Arm A 共用同一业务实现）：Codex MCP Client → 临时 stdio Server（单工具 `pd_recall_principle_pains`，SDK 1.32.2）→ OD-A 投影（与 oracle 共用同一投影模块）→ **recallPains()**（worktree 冻结构建 `packages/pd-cli/dist/services/pain-recall.js`，pd.pain-recall.v1）→ core 公共出口。未包装 CLI 子进程、未复制业务逻辑、未使用 shadow 关联/trustedContextReceipt。工作区由启动配置绑定（`--workspace`），模型参数无法覆盖（smoke 验证注入 workspaceDir 不可重绑定）。

## F. Field Disclosure Validation

- **ALLOW（OD-A §4.1 全部落地）**：principle.requestedId/identityStatus；association.type/confidence；availability 三态；status/statusDetail；sources 固定枚举；summary 计数；truncated；contextUsedForRanking；unresolvedAssociations.reason（无内部 ID）；query.limit。
- **DENY（逐项验证零泄露）**：canonicalId、painId、evidenceRefs（candidateId/taskId/decisionId/decidedAt）、pain.text/reason/rawStatement/occurredAt/source/host/score/severity、diagnoses.*（含 rootCause/category/note）、correctionEvidence.*、lineage hops、session/turn IDs、trustedContextReceipt。
- 执行机制：投影模块（单实现）+ Server 每调用白名单断言（键路径集合 diff）+ 哨兵正则扫描 + Harness 三重复扫（session events/server evidence log/final answer）。**正式 Arm B 全部 40 次调用 + 阶段三全部调用：白名单违规 0、哨兵命中 0。**
- **false-success 交叉核验（0/40）**：正确 principleId 的 36 次调用 businessStatus 与 oracle expectedEnvelope.status 逐字一致（含 ok/no_matches/partial/not_found/unavailable 全谱）；另 4 次（S01r2/S06r2/S09r3/S10r3）为 agent 自发的非法 ID 探索调用（"not-a-uuid"/"invalid-id"），均诚实返回 not_found——非误映射。
- 每场景原始 recallPains() 输出（含全部敏感字段）与信封输出的逐字段差异存证于 oracle.json（raw vs expectedEnvelope）。

## G. Experiment Results（72 次运行）

| 指标 | Arm A（Skill+CLI） | Arm B（MCP） | MCP 增量 |
|---|---:|---:|---:|
| 任务成功率 | 77.8%（28/36） | 100%（36/36） | 22.2pp |
| 字段正确率 | 74% | 100% | 26.0pp |
| 工具发现率 | 100% | 100% | — |
| 能力调用成功 | 100% | 100% | — |
| 中位工具调用 | 14 | 1 | 92.9% |
| p95 端到端 | 181554ms | 35074ms | 0.19× |
| Token（输入/输出） | 10,978,368/96,926 | 1,567,463/8,353 | — |
| 无效最终 JSON | 0 | 0 | — |
| 超时 | 0 | 0 | — |
| 信息泄露（MCP 流量） | N/A | 0 | 0（硬门 PASS） |
| 答案中哨兵出现 | 0 | 0 | — |
| Hook 安全检查 | 6/6 PASS | 6/6 PASS | 见 H |
| 工作区副作用 | **18/36（既有 CLI 行为，计量值：WAL sidecar/建库/改库）** | **0/36** | 硬门仅辖 MCP 臂（v3 规则）：PASS |
| false-success 映射 | — | 0/40 调用 | 详 F 节 |

**逐场景（12 场景 × 3 重复，重复测量结构；括号内为逐次字段正确数/应答数）：**

| 场景 | A 成功率 | A 逐次 | B 成功率 | B 逐次 |
|---|---|---|---|---|
| S01 | 33.3% | 1/7, 7/7, 1/7 | 100% | 7/7, 7/7, 7/7 |
| S02 | 66.7% | 7/7, 1/7, 7/7 | 100% | 7/7, 7/7, 7/7 |
| S03 | 66.7% | 7/7, 1/7, 7/7 | 100% | 7/7, 7/7, 7/7 |
| S04 | 66.7% | 4/4, 0/4, 4/4 | 100% | 4/4, 4/4, 4/4 |
| S05 | 100% | 3/3, 3/3, 3/3 | 100% | 3/3, 3/3, 3/3 |
| S06 | 100% | 3/3, 3/3, 3/3 | 100% | 3/3, 3/3, 3/3 |
| S07 | 100% | 2/2, 2/2, 2/2 | 100% | 2/2, 2/2, 2/2 |
| S08 | 100% | 2/2, 2/2, 2/2 | 100% | 2/2, 2/2, 2/2 |
| S09 | 33.3% | 3/6, 0/6, 6/6 | 100% | 6/6, 6/6, 6/6 |
| S10 | 100% | 2/2, 2/2, 2/2 | 100% | 2/2, 2/2, 2/2 |
| S11 | 100% | 3/3, 3/3, 3/3 | 100% | 3/3, 3/3, 3/3 |
| S12 | 66.7% | 4/4, 2/4, 4/4 | 100% | 4/4, 4/4, 4/4 |

统计口径：72 次 = 12 场景内重复测量，非独立样本；场景间差异与三次重复稳定性见上表；小样本（每格 n=3）限制如实声明。无限流重试。

## H. Hook Compatibility（独立章节：第一手事件证据）

隔离 CODEX_HOME + 生产 PD hook（仓库构建 pd-hook.cjs → 隔离安装 @principles/codex-adapter 0.6.1，PLUGIN_DATA 解析）+ 观察钩子（matcher .*, 零干预）。每项含事件输入/预期/实际/数量/持久化副作用/DB 指纹/裁定，全文见 hook-phase3/phase3-evidence.json 与各 run 目录。

| # | 检查项 | 结果 | 关键证据 |
|---|---|---|---|
| M1 | 正常 MCP 调用 → PreToolUse | PASS | PreToolUse 恰 1 次（`mcp__pd_recall__pd_recall_principle_pains`）+ PostToolUse 恰 1 次；信封 ok/explicit_reuse 与 oracle 一致；两库表行数零变化 |
| M2 | Server 启动/退出 | PASS | 仅 SessionStart/UserPromptSubmit/Stop 三事件，零 PreToolUse/PostToolUse 幻影；孤儿进程 0 |
| M3 | 参数无效/工具拒绝 | PASS | limit=99 → "limit exceeds maximum of 10"（schema 层拒绝）；单次 PreToolUse，无重复 |
| M4 | 超时与重试 | PASS | 45s 慢调用完成（start→end 各一次）；Pre/Post 各 1 次，无重复、无卡死 |
| M5 | 无可信 Hook 上下文只读查询 | PASS | 工作区文件指纹与两库表行数**完全不变**；pain_events 增量 0（查询≠Pain） |
| M6 | 与真实 PD Hook 并发 | PASS | Bash echo 被 PD PreToolUse 正常检查（matcher Bash\|apply_patch）；MCP 调用另触发 PreToolUse（观察钩子 matcher .*）；PostToolUse 2 次（Bash+MCP 各一）；pain_events 增量 0（查询≠注入）；无绕过 |

**关键结论**：①MCP 工具调用是宿主工具调用事件（进入 PreToolUse/PostToolUse），**不是** PD 生命周期事件——未被计入 Pain 采集、注入统计或任何治理状态（M5/M6 双证）。②PD Hook 全程正常执行、零错误状态、零遗留进程。③两项 Gate 4 级观察（不改变本轮裁定，供 Owner 未来裁决）：(a) **无头审批阻塞**——codex 0.166 非交互模式拒绝 MCP 工具调用，唯一无头路径是危险旁路旗标；(b) **matcher 覆盖**——现有 PD PreToolUse matcher 为 `Bash|apply_patch`，MCP 工具名天然不匹配（事件仍触发，可扩展覆盖）；若要求 MCP 调用也受门禁，需 Owner 决策扩展 matcher，而非新增机制。

## I. Cost Analysis

- **依赖成本**：MCP 需引入 SDK（@modelcontextprotocol/sdk + 传递依赖 95 包）至独立 Adapter（SPEC 已禁止进 core/仓库）；Skill+CLI 零新增依赖。
- **宿主治理成本**：无头自动化下 MCP 调用被审批模型阻塞（H 节发现 ⑤）——生产化必须解决审批/信任模型或接受旁路风险；Skill+CLI 在 read-only sandbox 下原生可用。
- **运行成本**：p95 耗时比值 0.19×；Token 输入 1,567,463 vs 10,978,368。
- **工程维护成本**：需维护投影/白名单断言/信封映射/SDK 版本钉与协议兼容矩阵（SPEC §8.4）+ 第二入口的全套契约测试；现有 CLI 已有 25 用例只读矩阵。
- **相对收益**：本轮冻结工作流上未测得净增量（G 节）。
- **配置成本（操作门实测）**：SDK 安装 5s（95 包）+ 3 行 config + server 自启（<1s 就绪）——脚本化 <1 分钟、手工约 2-3 分钟，满足 ≤5 分钟目标。

## J. Failure Analysis（全部失败样本，无一删除）

失败运行 8 个（A 8 / B 0）：

| 臂 | 场景 | 字段 | 错误明细 | 运行状态 |
|---|---|---|---|---|
| A | S01 r2 | 1/7 | status: "principle_not_found"≠"ok"; returned_count: 0≠1; top_association_type: null≠"explicit_reuse"; top_association_confidence: null≠"explicit"; diagnoses_ava | rc=0 |
| A | S09 r2 | 3/6 | status: "ok"≠"partial"; diagnoses_availability: "not_recorded"≠"unreadable"; correction_evidence_availability: "not_recorded"≠"unreadable" | rc=0 |
| A | S09 r1 | 0/6 | status: "principle_not_found"≠"partial"; returned_count: 0≠1; top_association_type: null≠"explicit_reuse"; top_association_confidence: null≠"explicit"; diagnose | rc=0 |
| A | S02 r3 | 1/7 | status: "principle_not_found"≠"ok"; returned_count: 0≠1; top_association_type: null≠"derived_from"; top_association_confidence: null≠"lineage_verified"; diagnos | rc=0 |
| A | S12 r1 | 2/4 | status: "principle_not_found"≠"ok"; returned_count: 0≠2 | rc=0 |
| A | S01 r1 | 1/7 | status: "principle_not_found"≠"ok"; returned_count: 0≠1; top_association_type: null≠"explicit_reuse"; top_association_confidence: null≠"explicit"; diagnoses_ava | rc=0 |
| A | S03 r3 | 1/7 | status: "principle_not_found"≠"ok"; returned_count: 0≠1; top_association_type: null≠"multiple_paths"; top_association_confidence: null≠"explicit"; diagnoses_ava | rc=0 |
| A | S04 r1 | 0/4 | status: "principle_not_found"≠"ok"; returned_count: 0≠3; total_available: 0≠5; truncated: false≠true | rc=0 |

（异常值保留未剔除；三次重复的稳定性见 G 节逐场景表。）

### J.1 主观质量盲评（统一盲评规则，评分者不知臂别）

评分者不知道任何答案来自哪个实验臂。0/1/2 三档（2=完整诚实无虚构；1=基本正确有含糊；0=缺失/无效/虚构）。
| 臂 | n | 均分 | 0/1/2 分布 |
|---|---|---|---|
| A（去标识） | 36 | 1.81 | 2/3/31 |
| B（去标识） | 36 | 2.00 | 0/0/36 |

## K. Final Verdict

# **GO_TO_GATE_3_PROPOSAL**

安全硬门全过、证据完整且效用门通过（仅代表可向 Owner 提交 Gate 3 方案，不自动进入 Gate 3）。

判定依据（预注册规则逐条）：安全硬门 PASS（MCP 流量泄露 0 / MCP 臂副作用 0 / false-success 0/40 / 权限绕过 0 / Hook 专项 6/6）；效用门 PASS（成功率绝对差 +22.2pp ≥ 10pp，且中位交互 −92.9% ≥ 25%——两分支同时满足）；操作门 配置 <1 分钟（脚本化实测）/ p95 满足 ≤2×（实测 0.19×）；证据完整性 72/72；CLI 基线规则不触发（A=77.8% < 95%）。

**本结论仅授权向 Owner 提交 Gate 3 方案（最小共享应用用例抽取）；Gate 3/4 仍需独立批准。** 前置裁决项：①宿主无头审批模型（本报告发现 ⑦）——若无法以非危险旁路方式放行 MCP 工具调用，生产价值将大幅折损；②PreToolUse matcher 是否扩展覆盖 MCP 工具名；③Arm A 侧既有 CLI 读命令副作用（本报告发现 ⑤）建议作为独立工单（与 MCP 无关的既有缺口）。



---

## 附：执行纪律偏离披露（全量）

1. **预注册 v1→v2**（零正式运行时修订）：阶段三发现 codex 0.166 无头 MCP 审批阻塞；两臂对称改用 bypass 旗标（同 seed → 同顺序）。
2. **run-experiment.mjs 布尔缺陷修正**：`if (emptyArray)` 恒真导致 run 0（零实际变化）后误停机；修正为 `.length>0`，语义与冻结意图一致；run 0 记录保留、自索引 1 续跑。
3. **预注册 v2→v3**（run 1 后修订）：Arm A 既有 CLI 读命令（pd candidate show / pd health 等技能清单命令）直接开库产生 WAL sidecar——属被测基线的真实行为（审计"只读风险不可泛化"类），副作用规则细化为 Arm B 硬停 / Arm A 计量（run 1 记录保留，自索引 2 续跑；全部修订前后哈希与原因写入 preregistration.revision）。
4. **Harness 中途修复（v2 冻结前）**：评分状态等价类（两臂词表差异）、事件终态去重、fixture 改名重试。
5. **Token 采集**：provider 不发 token_count 事件；改从 turn.completed.usage 采集（analyze 阶段读取原始 events，未改冻结文件）。
6. **盲评**：主观质量盲评输入由 analyze.mjs 去标识洗牌生成（blind-rating-input.json + 隐藏映射 blind-mapping.json），评分者不知实验臂归属。
