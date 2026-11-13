# PD-MCP-GATE3-OWNER-DECISION-CARD
# Gate 3 决策记录与待决事项

| 字段 | 内容 |
|---|---|
| 文档性质 | 决策记录卡（设计交付）；随本轮四文件一并提交 Owner |
| 配套文件 | ① `docs/implementation-reports/PD-MCP-GATE3-LATEST-SOURCE-DELTA-AUDIT.md`（事实）② `docs/specs/SPEC-PD-AGENT-CAPABILITY-API-001-v0.5.md`（契约）③ `docs/implementation-plans/PD-MCP-GATE3-IMPLEMENTATION-READINESS-001.md`（实施） |
| 基线 | origin/main `0d0ea7eb5`（2026-11-01 复核） |
| 修订记录 | r2（2026-11-01 最终修订轮）：①G-1 守卫拆分生产/测试分域（消除与测试迁移的规则冲突）；②三项数值限制责任归属分层（10 条=Core Capability/Gate 3；32 KiB 与 10s=Gate 4 MCP Adapter，READINESS §17 成文为 Gate 4 验收前置）<br>**r3（2026-11-02 记录收口）：决策状态更新见 §〇——OG-1/OG-2/Gate 3 实施=DONE；OG-3=NOT AUTHORIZED（**该状态已被 r4 取代，仅作历史记录**）；D-06/WB 实机/Gate 4 宿主审批模型=PENDING**<br>**r4（2026-11-02 OG-3 授权同步）：D-06=OWNER_CONFIRMED（方案 A：MCP Server 与启动宿主同 Windows 用户权限，首期仅只读 Tool，产品文档须明示残余风险）；OG-3=AUTHORIZED（Owner 2026-11-02 对话指令，范围=Gate 4-A～4-F 隔离环境内完整实施，明确不含正式发布/远端推送/合并 PR/生产部署/修改 Owner 日常宿主配置；实施工单 PRI-1071；产品合同=SPEC-PD-MCP-GATE4-001 v1.2）；WB 实机验证与宿主审批模型转入 Gate 4-A～4-F 执行项**<br>**r5（2026-11-13 OG-4 授权同步）：OG-4=AUTHORIZED（Owner 对话指令「修改代码对全部的workbuddy开启」，范围=WorkBuddy 单宿主生产注册 `pd_submit_pain`，不含 Codex/OpenClaw）；§〇 决策状态总表新增 OG-4 行作为授权记录；`docs/plans/2026-11-11-pain-submit-limited-rollout.md` 的仅 OpenClaw 提案标记 SUPERSEDED；SPEC §7.7 / TD §5.1.1 状态行按 r5 同步**<br>**r6（2026-11-13 OG-4 范围扩展）：Owner 追加指令「三个宿主都打卡」⇒ OG-4 授权范围由 WorkBuddy 单宿主扩展为 Codex / OpenClaw / WorkBuddy 全部部署；§〇 OG-4 行同步；MCP 生产装配改为按任一已知 host opt-in，Codex PreToolUse matcher 与三份 tool-semantics 同步登记 `pd_submit_pain`；PR #2621 承接本次变更** |
| 裁定 | 交付时点裁定：**SPEC v0.5：READY（待 OG-1 采信冻结）｜Gate 3 实施：READY_PENDING_OG2**（历史）；**当前状态见 §〇 决策状态总表（OG-1/OG-2 已完成，Gate 3 已实施合并，OG-3 已授权）** |

---

## 〇、决策状态总表（2026-11-02 记录收口更新）

本文其余章节保留 2026-11-01 设计交付时点状态（"待决-1/待决-2"等为当时的开放项）。以下为收口后的权威决策状态：

| 决策 | 状态 | 日期 | 证据 |
|---|---|---|---|
| OG-1：SPEC v0.5 采信（冻结生效，含三项数值及责任归属确认） | **DONE** | 2026-11-01 | Owner 任务书批准；PRI-1068 工单描述（"OG-1 已批准、OG-2 已授权"）+ PR #2270 Owner Review Card 实施记录 |
| OG-2：Gate 3 实施授权 | **DONE** | 2026-11-01 | 同上；**Owner 于 2026-11-01T10:23:37Z 亲自合并 PR #2270（merge commit `f15a5a6a6de75b8e9ce7eb909fac1e137637665a`）构成最终裁决** |
| Gate 3 实施 | **DONE** | 2026-11-01 | PR #2270 MERGED；PRI-1068 = Done；CI 26/26 全绿（含 Verify Merge Gate）；最终交付报告 `PD-MCP-GATE3-IMPLEMENTATION-REPORT-001.md`（含 Post-Merge Closeout Addendum） |
| OG-3：Gate 4 实施授权 | **AUTHORIZED** | 2026-11-02 | Owner 对话指令明确授权（r4 同步）：隔离环境内 Gate 4-A～4-F 完整实施；**不含**正式发布、远端推送、合并 PR、生产部署、修改 Owner 日常宿主配置；实施工单 PRI-1071；产品合同 SPEC-PD-MCP-GATE4-001 v1.2。历史状态（NOT AUTHORIZED，截至 r3）保留于历史记录 |
| D-06：MCP Server 进程安全风险接受 | **OWNER_CONFIRMED（方案 A）** | 2026-11-02 | Owner 2026-11-02 对话指令确认（r4 同步）：接受 MCP Server 与启动宿主同 Windows 用户权限运行、无 OS 级隔离；首期仅提供只读 Tool；残余风险（文件访问/环境继承/网络能力/宿主 Sandbox 不自动约束子进程）须在产品文档中明确说明。历史状态（PENDING，截至 r3）保留于 §三 待决-3 |
| WorkBuddy 实机 MCP 验证 | **PENDING** | — | Gate 4 前置（现 DOC_VERIFIED_RUNTIME_NOT_VERIFIED；见下 §三 待决-4） |
| Gate 4 宿主审批模型 | **PENDING** | — | Codex 0.166.0 无头 MCP 调用审批阻塞为版本实测事实；实验中的危险旁路参数不得作为生产方案；目标宿主版本须在 Gate 4 重验（SPEC v0.5 §10.2） |
| OG-4：MCP 写类工具生产注册授权 | **AUTHORIZED（三宿主）** | 2026-11-13 | Owner 对话指令「修改代码对全部的workbuddy开启」，同日追加「三个宿主都打卡」把范围扩展为 **Codex / OpenClaw / WorkBuddy 全部部署**（r6）。落地：`pd-mcp-server/src/index.ts` 对任一已知 `PD_MCP_HOST`（codex / openclaw / workbuddy）在装配层显式 opt-in（`enableSubmitTool: true` + 注入 capability），`submit-assembly.ts` 按启动绑定传入 hostKind 并把 Core 能力绑定到有效 `.pd/config.yaml`（不回落 `workflows.yaml`）；Codex PreToolUse matcher 与三份 tool-semantics 均已登记 `pd_submit_pain`。host 标记缺失/未知时仍 recall-only。**不引入 env var / feature flag**，`server.ts` 的默认 gate 保持 `false`。本授权取代 `docs/plans/2026-11-11-pain-submit-limited-rollout.md`（仅 OpenClaw + env var + 观察期的未执行提案）；该提案的观察期与停止条件未随本次指令给出，列为 follow-up。授权记录即本行，不自行宣称于 SPEC 正文 |

**证据精度说明**：OG-1/OG-2 原始任务书的精确审批时间戳未在仓库证据中存档，记录精确到日期（2026-11-01）；日期依据为 PRI-1068 工单创建描述与 PR #2270 Owner Review Card 的书面记录，并经 Owner 亲自合并 PR #2270 的仓库动作佐证。后续版本联动：#2274（Version Packages）、#2276（Version Packages）、#2277（产品版本 2.8.0）、#2278（codex runtime pins）均已合并——发布治理路径（changesets → Version PR → publish → pins 自动刷新）按 SPEC v0.5 F10 落地完毕。

---

## 一、Owner 已确定的决策（2026-11-01，不再开放）

以下九项由 Owner 在本轮任务书中确定，已全部落入 v0.5 SPEC 与实施计划，此处仅作记录与映射（对应 OPTIMIZED 提案 D-01..D-08 编号）：

| # | Owner 决策 | 落点 | OPTIMIZED 映射 |
|---|---|---|---|
| 1 | OD-A 首期仅约束 MCP Tool 的响应披露，不宣称全局 Agent 数据边界 | v0.5 §8.2 | D-04A（关键决策）|
| 2 | CLI 保持现有完整输出、参数、JSON 和退出码 | v0.5 §9（硬约束）| D-07 |
| 3 | 不要求本次改造覆盖所有 Agent-facing 接口 | v0.5 §8.2/§10 | D-04A |
| 4 | 采用 Core Read Model + Capability Facade（仅 Read Model 登记 IO seam） | v0.5 §5/§6/§7 | D-01 + D-02 + D-04B |
| 5 | 首期不创建 pd-application（升格条件已成文） | v0.5 §13.2 | D-02 |
| 6 | Gate 3 不实现 MCP Server、不引入 MCP SDK | v0.5 §4.2/§10.1 | D-08 |
| 7 | Gate 3 不修改 Hook、宿主配置及生产治理逻辑 | v0.5 §10.2 | D-05 |
| 8 | Gate 3 只做共享能力抽取、披露契约、CLI 迁移 | v0.5 §4.1 | D-08 |
| 9 | Gate 4 必须另行授权（OG-3） | v0.5 §13 | D-08 |

**据此，OPTIMIZED 决策卡中 D-01 / D-02 / D-04A / D-04B / D-05 / D-07 / D-08 已全部落定**；D-03（数值）与 D-06（进程风险）为剩余开放项（见下）。

## 二、本轮新证据（支持直接进入冻结/实施）

1. **方案 C 在最新主干 CONFIRMED**：增量区间 42 提交中，Gate 3 依赖的全部架构关键面（pain-recall.ts / CLI 外壳 / 两测试 / hooks.json / io-seam-registry / barrel）**字节级零变化**；变化仅为版本推进与安装器/文案域 PR（DELTA-AUDIT §B）。
2. **OD-A 冻结工件完整**：预注册 JSON/MD + 版本链 + %TEMP% 原型共 **6 项 SHA-256 全 MATCH**；白名单以可执行清单逐字段恢复，与预注册文本一致（唯一分歧 `statusDetail` 为保守方向，已按更窄者写入 v0.5 §8.1）。
3. **Gate 2 "0/36 副作用"口径闭环**：= 工作区业务数据指纹（72 次正式运行未装 PD hooks）；治理遥测由 Phase 3 独立证明增量 0——两个口径均净（DELTA-AUDIT §C.10）。
4. **OPTIMIZED 提案仅需 4 项小修正**（无重大修改）：平铺文件命名（非 capabilities/ 目录）、895 行勘误、副作用口径关闭、statusDetail 冻结细则（DELTA-AUDIT §D）。
5. **实施机械清单已穷举到行级**（READINESS §1-§16），含测试拆分定案、守卫设计、发布联动、单次回滚、P0/P1 停止条件。

## 三、仍需 Owner 决定的事项

### 待决-1｜OG-1：采信 SPEC v0.5（冻结生效）——**本轮唯一必需决策**（✅ 已完成 DONE，见 §〇；下文保留原评审记录）

- **决策内容**：批准 `docs/specs/SPEC-PD-AGENT-CAPABILITY-API-001-v0.5.md` 作为 **Gate 3 实施契约**，并确认以下三项数值**及其责任归属**（v0.5 §7.5.1；数值保留原提案，未作调整）：

| 数值 | 责任归属 | 实施与验收 |
|---|---|---|
| 单次最多 **10 条** | **Core Capability**（业务能力约束） | **Gate 3** 实现并测试（v0.5 §7.5.2；READINESS §5/§10-7） |
| 结构化响应最大 **32 KiB** | **Gate 4 MCP Adapter**（传输约束；UTF-8 字节口径） | Gate 4 实施与验收（v0.5 §7.5.3；READINESS §17.1；超限为 Gate 4 必测场景——"10 条必然满足 32 KiB"不作为已证不变量） |
| 调用截止时间 **10 秒** | **Gate 4 MCP Adapter**（执行边界；工具处理器起算，不含进程启动/排队） | Gate 4 实施与验收（v0.5 §7.5.4；READINESS §17.2；可控延迟合成测试验证） |

- **如需改值**：请直接批注数值与责任层级，SPEC v0.5 随批注定稿。
- **不决策的影响**：v0.5 保持 PROPOSED；OG-2 无法启动。
- **建议**：批准（三项数值均有实测或既有常量依据；责任分层已消除"Adapter 约束误入 Core"的歧义）。

### 待决-2｜OG-2：Gate 3 实施授权（独立动作，前置 = 待决-1）（✅ 已完成 DONE，见 §〇；下文保留原评审记录）

- **内容**：授权按 READINESS 文档执行单变更集实施（Read Model 迁移 + Capability Facade + 双子路径 + CLI 接线 + 测试拆分 + 守卫/黄金/泄露测试 + changeset）。
- **建议时点**：OG-1 之后任意时点；实施 PR 开工时按 READINESS §16 核对单执行（含 pain-recall.ts 零并发修改复核）。
- **规模预期**：移动 895 行 + 新增约 500-700 行（Facade+测试+守卫）+ 接线约 20 行级改动；单 PR；单次 revert 可回滚。

### 待决-3｜D-06：MCP Server 进程风险接受（✅ 已完成 OWNER_CONFIRMED（方案 A），2026-11-02，见 §〇 r4；下文保留原评审记录）

- **问题**：是否接受首期 MCP Server 与启动用户同权限、无 OS 级文件/网络隔离（应用层只读 ≠ 进程只读；stdio ≠ 网络隔离；对被攻陷进程/恶意依赖无隔离）。
- **建议**：在 Gate 4 立项时裁决；若不接受，Gate 4 前需增加并验证 OS 级隔离方案（成本显著上升）。

### 待决-4｜WorkBuddy 实机合成验证（⬜ 仍 PENDING——**Gate 4 前置**；见 §〇）

- **问题**：WB 宿主实机 MCP 验证（现 DOC_VERIFIED_RUNTIME_NOT_VERIFIED）是否列为 Gate 4 前置，或明确延期并接受单宿主（Codex）先行。
- **建议**：列为 Gate 4 前置（Hook 验证报告原建议）；或批注延期。

### 非阻塞备忘（无需现在决策）

- OG-4（未来 MCP 写类工具的 Hook 治理接入）：设计位已留（v0.5 §10.2），触发时另行授权。
- OG-5（逐宿主 Gate 5）：远期。
- Codex exit-2 阻断通道：等宿主版本升级后重验，不入公共契约（Hook 验证报告待决③，已按此处置）。
- `pd-application` 升格：条件成文（v0.5 §13.2），出现触发条件时再议。

## 四、五问快答（金字塔顶）

> （2026-11-01 设计交付时点快照；其中"待决"状态已变化——当前权威状态见 §〇。）

| 问题 | 答案 | 依据 |
|---|---|---|
| 最新源码是否仍支持方案 C？ | **YES——CONFIRMED**（架构面零变化；机制级直证补齐） | DELTA-AUDIT §B/§C |
| 优化版 Proposal 是否需要重大修改？ | **NO——仅 4 项小修正**（已吸收进 v0.5 与 READINESS） | DELTA-AUDIT §D |
| SPEC v0.5 是否达到冻结条件？ | **READY**（OG-1 采信即冻结；含三项数值**及其责任归属**确认，见待决-1 表） | v0.5 §15 |
| Gate 3 是否具备实施条件？ | **READY_PENDING_OG2**（OG-1 → OG-2 两步后即可开工；机械清单就绪） | READINESS §16 |
| 还存在哪些必须由 Owner 决定的事项？ | **待决-1（OG-1，本轮必需）**；待决-2（OG-2）；待决-3/4（Gate 4 前置，不阻塞本轮） | 本文 §三 |

## 五、状态与边界声明

- 本轮授权动作：只读源码审计 + 历史 PR 阅读 + 四份设计文档创建 + 只读哈希/构建验证。
- 本轮零改动：未修改任何生产源码/测试/package.json/lockfile/Hook/CLI/宿主配置；未创建 PR/push/merge/deploy；未触碰 `~/.codex` 与 WorkBuddy 配置。
- **本轮结束后停止，等待 Owner 授权 OG-2**；不自动进入 Gate 3 实施或 Gate 4。（历史声明：OG-2 已于 2026-11-01 获授权、Gate 3 已实施合并；当前状态以 §〇 为准。）
- 审计 worktree（`adhoc-20261101-mcp-gate3-audit2-7fd2e0`）零自产工件，交付后释放租约并清理；两个前置 worktree 与 %TEMP% 证据保持原样待 Owner 处置。
