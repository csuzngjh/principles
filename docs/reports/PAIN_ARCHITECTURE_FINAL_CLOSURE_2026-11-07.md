# PD Pain Architecture 最终架构收敛报告（2026-11-07）

**Status:** READY_FOR_OWNER_REVIEW（文档 PR #2401 保持 OPEN，不合并、不部署）
**Pull Request:** https://github.com/csuzngjh/principles/pull/2401
**Code Baseline:** `origin/main@86b6208042b6083d4a7bbf840730d060188a1517`（含 PRI-1136 `runtime-v2` → `runtime` 改名）
**Method:** 以当前生产代码、测试实跑、PR 合并记录与 Linear 状态为准；不以历史 PR 描述推断完成度。
**Companion artifacts:**
- `docs/specs/SPEC-PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE-001-v0.3.1.md` §8
- `docs/specs/SPEC-PD-CROSS-HOST-KEYWORD-PAIN-001-v0.2.md` §6
- `docs/specs/GFI_COMPLETE_REMOVAL_SPEC.md` §15
- `docs/reports/GFI_FINAL_ACCEPTANCE.md` §8

---

## 1. 执行摘要

- **Phase 0**：IMPLEMENTED，无剩余验收。
- **Phase A**：IMPLEMENTED，自动 RuleHost Block / Tool Failure / Repeated Failure Pain 已退役，Owner 显式入口保留。
- **Phase B**：代码实施 + 单元/集成测试已完成；**真实 LLM BDD** 与 **三宿主最终验收** 未完成。整体为 **PARTIALLY_IMPLEMENTED（最终验收层）**，不标 COMPLETE。
- **Phase C（GFI）**：生产逻辑/DB/CLI/Console 已移除；**历史 workspace JSON 未迁移**，`gfi` `gone` 墓碑与 SPEC §5.1 存在偏差。整体 **PARTIALLY_IMPLEMENTED**。
- **WorkBuddy**：自动关键词 Pain **明确不支持**（非待开发）；保留插件安装、显式启用、手动入口 `PD记录痛苦：`。
- **Linear**：新增 PRI-1147 / PRI-1148 / PRI-1149；完成工单保持 Done 并补充“实施完成 ≠ 最终验收完成”说明；PRI-1104 不被 GFI 数据清理污染。
- **本轮的 NOT RUN**：真实 LLM 调用、真实三宿主验收、`verify:merge` 全链。均未标记 PASS。

---

## 2. SPEC 要求 → 实际代码 → 测试证据 → 真实运行证据 → 裁定

| # | SPEC 要求 | 实际代码（现行路径） | 测试证据 | 真实运行证据 | 裁定 |
|---|---|---|---|---|---|
| 1 | PainIngress 纯函数、四 action（submit/degrade/refuse/observation_only） | `packages/principles-core/src/runtime/pain-ingress.ts` | `pain-ingress-spec-matrix.test.ts`、`pain-ingress-shared-semantics.test.ts`（core 套件 546 passed） | 无独立真实运行重跑（本轮 N/A） | **IMPLEMENTED** |
| 2 | Correction Detection：Signal Capture → Stage 1 关键词 → Stage 2 LLM → pending → 置信度门 | `runtime/signal-collector/`（`keyword-stage.ts`、`confidence-gate.ts`、`correction-types.ts`） | `keyword-stage.test.ts`、`confidence-gate.test.ts` | PR #2308 记录真实 LLM BDD **BLOCKED**（400/429/504）；本轮 **NOT RUN** | **PARTIALLY_IMPLEMENTED**（代码/单测完成，真实 LLM 未验） |
| 3 | P-1 引用/转述/第三人称/否定防护 | `runtime/signal-collector/keyword-stage.ts` | `keyword-stage.test.ts` | PR #2343 记录真实 WorkBuddy hook 对照（检测层 marker 变化、Pain 0） | **IMPLEMENTED** |
| 4 | P-2 学习词门（不再 STRONG 直通） | `keyword-stage.ts` + `correction-types.ts` | `keyword-stage.test.ts`、`pain-ingress-shared-semantics.test.ts` | 无真实 LLM 重跑 | **IMPLEMENTED**（D5 追认见 DC-02） |
| 5 | Pending Candidate 状态机（`pending_llm_review` / `resolved_none` / `abandoned`、TTL 72h、MAX_ATTEMPTS=5、CAS） | `runtime/signal-collector/confidence-gate.ts` + `host-runtime/src/governance-signal-admission.ts` | `governance-signal-admission.pending.test.ts` | 无真实运行重跑 | **IMPLEMENTED**（D6 追认见 DC-02） |
| 6 | Diagnostician 单写点 + 幂等任务链 | `host-runtime/src/governance-signal-admission.ts`（`ensureGovernanceDiagnosticianTask`） | `governance-signal-admission.test.ts` | PR #2343 记录 WorkBuddy 显式 Owner 入口产生 `tasks` 1 行 | **IMPLEMENTED** |
| 7 | RuleHost Block / Tool Failure / Repeated Failure 自动 Pain 退役 | `packages/openclaw-plugin/src/hooks/gate-block-helper.ts`（无 `rulehost_block` / Pain 写入） | `phase-a-default-production-path.test.ts`（4/4）、`gate-b-only-runtime-guard.test.ts` | 无生产运行重跑 | **IMPLEMENTED** |
| 8 | Owner 显式 Pain 入口（OpenClaw / CLI / WorkBuddy 前缀） | `openclaw-plugin/src/hooks/pain-ingress-adapter.ts`、`pd-cli` pain record、`workbuddy-adapter` explicit prefix | 同上 + `explicit-owner-statement.test.ts` | PR #2343 真实 WorkBuddy 引擎显式入口 **PASS**（`pain_events` 1 行） | **IMPLEMENTED** |
| 9 | Stage-2 周期预算（尾部执行、aggregate ≤60s、单次 60s、串行 CAS） | `host-runtime/src/signal-stage2-cycle.ts` | `signal-stage2-cycle.test.ts` | 无真实 worker 长跑证据（本轮 N/A） | **IMPLEMENTED** |
| 10 | Codex 适配器接入共享检测 | `packages/codex-adapter` + `workspace-worker.ts` | `signal-stage2-cycle.test.ts` 等 | PR #2343 记录 Codex `environment_missing`；本轮 **NOT RUN** | **PARTIALLY_IMPLEMENTED**（代码完成，最终验收未完成） |
| 11 | WorkBuddy 适配器接入共享检测 | `packages/workbuddy-adapter/src/pd-hook.ts` | `live-keyword-pain.test.ts`、`explicit-owner-statement.test.ts` | PR #2343 真实引擎显式入口 PASS；自动路径 `abandoned/evidence_invalid` | **IMPLEMENTED**（自动能力明确不支持，见 §4） |
| 12 | Feature Flag 生命周期（`gone` 不可被 override 重新启用） | `runtime/feature-flags/feature-flag-contract.ts`、`feature-flag-lifecycle.ts` | `feature-flag-lifecycle.test.ts` | 无运行重跑 | **IMPLEMENTED** |
| 13 | Session Tracker 无 GFI 类型字段 | `openclaw-plugin/src/core/session-tracker.ts` | `architecture-regression.test.ts` | 历史 JSON 仍可能保留未知键（见 PRI-1149） | **PARTIALLY_IMPLEMENTED**（类型完成，历史数据未迁移） |
| 14 | EventLog `daily-stats.json` 无 GFI 产出 | `openclaw-plugin/src/core/event-log.ts` | `architecture-regression.test.ts` | 同上 | **PARTIALLY_IMPLEMENTED**（类型完成，历史数据未迁移） |
| 15 | CLI / Console 无 GFI 表面 | 全仓 `packages/**/src/**/*.ts` 扫描无 GFI 打分逻辑 | `architecture-regression.test.ts` | 无运行重跑 | **IMPLEMENTED** |
| 16 | GFI 生产逻辑删除、仅留切换语义 | `runtime/gfi/` 目录不存在；`gfi` 为 `gone` 墓碑 | `feature-flag-lifecycle.test.ts` | 无 | **IMPLEMENTED**（墓碑例外见 DC-01） |
| 17 | 三宿主能力一致（自动关键词） | 代码共享，但 WorkBuddy 自动能力不可用 | 三宿主相关套件通过 | 真实三宿主最终验收 **NOT RUN** | **NOT_APPLICABLE**（Owner 已决定 WorkBuddy 自动不支持；一致性要求不再成立） |

> 说明：表中“真实运行证据”仅采信可引用的真实宿主/真实模型记录。本轮未重跑真实 LLM，故凡涉及真实模型的行一律标 NOT RUN，不标 PASS。

---

## 3. A. 各 Phase 真实状态

### Phase 0 — Safe Cleanup

- **状态：IMPLEMENTED**。
- 交付：PR **#2296**（merged `41289232d`，2026-11-03）。
- 证据：`llm-pain-source-retirement.test.ts` 本轮单文件实跑 **4/4 passed**；core 套件 **546 passed**。
- 剩余：无。

### Phase A — Legacy Retirement

- **状态：IMPLEMENTED**。
- 交付：PR **#2316**（merged `fa5a89af1`，2026-11-04）。
- 证据：`phase-a-default-production-path.test.ts` 本轮单文件实跑 **4/4 passed**；`gate-b-only-runtime-guard` 与相关 hook 测试 3 文件合计 **19/19 passed**。
- 生产路径事实：`gate-block-helper.ts` 已无 `rulehost_block` / Pain 写入；Tool Failure / Repeated Failure 自动 Pain 已退役；Owner 显式 Pain 入口保留。
- 剩余：无。

### Phase B — Shared Correction Detection（四层裁定）

| 层 | 状态 | 依据 |
|---|---|---|
| 1. 代码实施 | **COMPLETE** | PR #2308（merged `6ed14c02f`）、#2347（merged `57c299e29`）、#2343（merged `2a7aec5b1`） |
| 2. 单元与集成测试 | **COMPLETE** | core 546、host-runtime 89、openclaw-plugin 19（本轮实跑） |
| 3. 真实 LLM BDD | **BLOCKED / NOT RUN** | PR #2308 记录：WorkBuddy live 400、ZAI 429、AMD 504；本轮未重跑 → PRI-1147 |
| 4. 三宿主最终验收 | **NOT RUN** | PR #2343 明确 Phase 4/5/6 未完成；本轮未重跑 → PRI-1148 |

**整体裁定：PARTIALLY_IMPLEMENTED。不得标 COMPLETE。**

### Phase C — GFI Complete Removal

- **状态：PARTIALLY_IMPLEMENTED**。
- 交付：PR **#2332**（merged `46cbdabc3`，2026-11-04，100 files）。
- 已完成：GFI 评分内核、session state、SQLite 列、CLI/Console 表面、指标与命令删除；`runtime/gfi/` 目录不存在。
- 未完成：历史 workspace JSON 迁移（SPEC §6.2/§6.3）→ **PRI-1149**。
- 偏差：`gfi` `gone` 墓碑保留，与 SPEC §5.1 不一致 → **DC-01**。

### PR 实际交付范围核对

| PR | 标题 | 合并 SHA | 结论 |
|---|---|---|---|
| #2296 | `refactor(pain): Phase 0 legacy signal cleanup` | `41289232d` | Phase 0 |
| #2316 | `refactor(pain): Phase A — Legacy Retirement (PRI-1095)` | `fa5a89af1` | Phase A |
| #2308 | `feat(pain): Phase B — Shared Correction Detection` | `6ed14c02f` | Phase B 主体 |
| #2347 | `fix(pain): 补齐 P-5 条件语境守卫与真实 Hook 正向覆盖` | `57c299e29` | Phase B 补丁 |
| #2343 | `fix(pain): 退役 WorkBuddy 句首预过滤（SPEC P-5）` | `2a7aec5b1` | Phase B 补丁；自述 Phase 4/5/6 未完成 |
| #2332 | `GFI-COMPLETE-REMOVAL-001: retire GFI end to end` | `46cbdabc3` | Phase C 主体 |

---

## 4. B. WorkBuddy 最终能力边界

### 支持

- 插件安装。
- 显式插件启用。
- Owner 手动入口 `PD记录痛苦：`。
- 该入口之后由实际代码支持的 Pain 准入与后续治理。

### 明确不支持（Not Supported，非待开发）

- WorkBuddy 自动关键词 Pain 识别。
- 自动 Pain Admission。
- 任何“自动关键词识别已交付”的能力声明。

### 代码与配置事实

- `feature-flag-contract.ts`：`workbuddy_live_keyword_pain` 描述为 **UNSUPPORTED / manual explicit prefix only**，默认 `false`。
- `workbuddy-host-installer.ts`：新建与已有 governance 配置均写入 `false`，不再默认启用。
- `workbuddy-adapter/src/pd-hook.ts`：自动入口受双 flag；无持久化 observation writer，自动候选恒为 `observation_only`，不写 `pain_events`。
- CLI 状态展示与 `workbuddy-adapter/README.md`：自动关键词不可用。
- 手动前缀链路可用（PR #2343 真实引擎证据：显式入口产生 `pain_events` 1 行 + `admitted` + `tasks` 1 行）。

### 硬性约束

1. 不得通过修改默认 Feature Flag 重新启用自动识别。
2. 三宿主代码共享不等于能力一致；OpenClaw / Codex 边界单独描述。
3. 该边界已写入 `SPEC-PD-CROSS-HOST-KEYWORD-PAIN-001-v0.2.md` §6。

---

## 5. C. GFI 退役最终状态

### 已删除（生产逻辑）

- GFI 评分内核 / 策略 / 读模型 / session 适配器。
- SQLite GFI 列与迁移前逻辑（仅保留迁移器与防御性拒绝）。
- CLI / Console GFI 命令与健康面。
- `runtime/gfi/` 目录（完全不存在）。

### 剩余兼容内容

- `gfi` feature flag 的 `gone` 墓碑（无执行能力）。
- 数据库迁移器与 `production-pain-evidence.ts` 的旧列防御性拒绝（失败点名 `trajectory_migration_failed`）。
- 历史 workspace JSON 中可能残留的未知 GFI 键（`session-tracker.ts` / `event-log.ts` 原样写回保留）。

### 安全例外与待处理

- **例外**：`gone` 墓碑 vs SPEC §5.1 → **DC-01**（建议 SPEC 改为允许纯防御性墓碑）。
- **待处理**：历史 JSON 迁移 → **PRI-1149**（备份 / 原子写入 / 完整性校验 / 回滚；不触碰真实 Owner 数据）。
- **已修复文档**：GFI SPEC 状态、archive INDEX、architecture README/COMPONENTS/DATA_ARCHITECTURE/PD_SYSTEM_ARCHITECTURE/GLOSSARY；`GFI_FINAL_ACCEPTANCE.md` 仅追加状态，不改历史正文。
- **历史审计证据**：`docs/reviews/*`、`docs/architecture/PRI-736/751/760-*`、`docs/architecture/PD_Pain_Signal_Audit.md` 等保持原样，未删改。

---

## 6. D. Linear 变更清单

| 工单 | 当前状态 | 本轮动作 | 原因 |
|---|---|---|---|
| PRI-1072 | Done | 追加复核评论 + 计数更正评论 | Phase 0 无剩余；更正 `9/9` → 实测 **4/4** |
| PRI-1085 | Done | 追加复核评论；description 已补最终状态 | 代码/单测/集成完成，但最终验收未完成；保持 Done 不重开 |
| PRI-1093 | Done | 追加复核评论 | Done 仅代表代码交付；PR #2343 自述 Phase 4/5/6 未完成；剩余转 PRI-1147/1148 |
| PRI-1095 | Done | 追加复核评论 | Phase A 无剩余；保持 Done |
| PRI-1104 | In Progress | 追加边界说明评论 | GFI 历史 JSON 清理不并入本工单；转 PRI-1149 |
| PRI-1130 | Done | 未改动 | 范围与本轮无关，状态正确 |
| PRI-1131 | In Review | 未改动 | 范围与本轮无关，状态正确 |
| **PRI-1147**（新建） | Todo | 新建 | 支持宿主（OpenClaw/Codex）真实 LLM BDD |
| **PRI-1148**（新建） | Todo | 新建 | 三宿主最终验收（OpenClaw/Codex 自动 + WorkBuddy 手动）与 startsWith 判定 |
| **PRI-1149**（新建） | Todo | 新建 | GFI 历史 workspace JSON 迁移（含备份/原子写入/完整性/回滚） |

父子关系已核实：PRI-1085 的 8 个子工单（PRI-1086–1093）全部 Done；PRI-1093 无子工单；PRI-1104 的 6 个子工单状态分别为 Done/In Review/Backlog。未新建重复工单，未把 GFI 数据清理塞入 PRI-1104。

---

## 7. E. SPEC 与文档变更清单

| 文档 | 版本/状态变化 | 摘要 |
|---|---|---|
| `SPEC-PD-PAIN-SEMANTICS-...-v0.3.md` | Status → **Superseded for implementation by v0.3.1** | 保留历史设计；指向 v0.3.1 §8 的现行状态 |
| `SPEC-PD-PAIN-SEMANTICS-...-v0.3.1.md` | v0.3.1 + **2026-11-07 Implementation Closure（§8）** | 新增 Phase 状态、代码/测试映射、WorkBuddy 边界、剩余工作、验证命令；不改设计条款 |
| `SPEC-PD-CROSS-HOST-KEYWORD-PAIN-001-v0.2.md` | → **v0.2.1**；能力声明 Superseded by §6 | WorkBuddy 自动明确不支持；手动入口支持；不得靠 flag 重新启用；三宿主边界单列 |
| `GFI_COMPLETE_REMOVAL_SPEC.md` | v1.1 → **v1.2**；Status → **Partially Implemented** | §5.1 增偏差注记；新增 §15 Post-Implementation Closure（GFI-1/2/3） |
| `GFI_FINAL_ACCEPTANCE.md` | 追加 **§8（2026-11-07）** | 仅追加当前状态，不改历史裁定 |
| `docs/archive/specs/INDEX.md` | 更新两条过期结论 | Phase A/C 状态更正；Cross-host 能力边界更正 |
| `docs/architecture/README.md` | GFI `Active` → **Retired** | 无执行能力说明 |
| `docs/architecture/COMPONENTS.md` | §3.6 更正 | `runtime/gfi/` 完全不存在，不再称“空 `__tests__`” |
| `docs/architecture/DATA_ARCHITECTURE.md` | 读模型清单更正 | `GfiWorkspaceReadModel` 标记已删除 |
| `docs/architecture/PD_SYSTEM_ARCHITECTURE.md` | 目录树更正 | `gfi/` 目录不存在 |
| `docs/architecture/GLOSSARY.md` | 字段说明更正 | GFI 已退役，不再指向 GFI 文档 |

---

## 8. F. 剩余阻塞项（仅真实影响架构正确性 / 生产安全 / 真实验收）

| 阻塞项 | 影响 | 跟踪 |
|---|---|---|
| 真实 LLM BDD 未执行 | Phase B 无法宣称真实模型行为已验证；不得标 PASS | PRI-1147 |
| 三宿主最终验收未执行 | OpenClaw/Codex 自动 + WorkBuddy 手动的真实矩阵缺失；startsWith 最终判定未闭合 | PRI-1148 |
| GFI 历史 workspace JSON 未迁移 | 旧 GFI 字段可能长期残留；无迁移方案前不得清理 Owner 数据 | PRI-1149 |
| `gfi` `gone` 墓碑与 SPEC §5.1 偏差 | 文档与代码不一致；删除有兼容风险 | DC-01 |
| D5/D6 缺少 Owner 批准记录 | P-2 学习词逆转与 pending 最小化的行为契约未正式追认 | DC-02 |

> 以下**不**列为阻塞：`verify:merge` 未在本轮运行（属正常文档 PR 范围，CI 合并门会运行）；PRI-1104 的 V1/V2 治理仍在进行（与本轮无依赖）。

### 8.1 已知残余（非阻塞，记录但不扩大本轮范围）

| 项 | 事实 | 处置 |
|---|---|---|
| WorkBuddy 自动入口代码路径仍在 | `workbuddy-adapter/src/pd-hook.ts:292-317` 在手动开启双 flag 时仍可达；但 `correctionIngressEvidence` 对 WorkBuddy 恒无持久化证据 → `observation_only` → `abandoned` marker，**不写 `pain_events`**（`governance-signal-admission.ts:1003-1018`） | 默认 OFF 且安装器强制 false；不构成产品能力。后续可单独立项决定删除死路径，本轮不改代码 |
| 用户指南仍提到 GFI | `docs/runbooks/USER_GUIDE_ZH.md:71,145-147,218-221` 仍把 GFI 描述为现役 | 属用户文档而非现役架构文档；本轮不改写，记录为独立文档待办 |
| 历史实施报告与当前边界相反 | `docs/implementation-reports/SPEC-PD-CROSS-HOST-KEYWORD-PAIN-001-review-fresh-install-20261019.md:9` 称安装器会写 `enabled=true` | 该报告日期早于 2026-11-05 Owner 决定，已被 Cross-host SPEC §6 取代；保留为历史记录 |
| 测试注释指向已删命令 | `architecture-regression.test.ts:3246` 注释仍写 `runtime-canary.ts (GFI check)` | 纯注释、无执行语义；不改代码 |

---

## 9. G. Owner Decision Cards

### DC-01 — GFI `gone` 墓碑：保留还是按 SPEC §5.1 删除？

- **现状**：SPEC §5.1 要求“不保留 gone tombstone”；代码保留 `gfi` 的 `gone` 墓碑（`feature-flag-contract.ts:235`），无执行能力。
- **选项 A（建议）**：保留墓碑，并把 SPEC §5.1 修改为“允许保留纯防御性 tombstone，但不得具有任何执行能力”。
  - 收益：旧 `gfi` override 被可观测拒绝；无兼容风险；无法重新激活旧逻辑。
- **选项 B**：删除墓碑，完全依赖 unknown-flag warning。
  - 风险：旧配置失败模式变化；需要额外测试证明未知 flag 覆盖旧 override。
- **需要 Owner 裁定**：选 A 或 B。若选 A，本轮已准备好的 SPEC 修改可直接落地。

### DC-02 — D5 / D6 的 Owner 追认

- **D5**：学习词不再凭 TP≥3/FP=0 直接 STRONG 直通，仅作为 Stage-2 优先候选。这是行为契约变更（逆转 PRI-788 G3）。
- **D6**：pending payload 仅保存 Stage-2 必需数据，TTL 72h，终态最小化。
- **证据缺口**：PR #2308 自述“D6 待 Owner 认可”；历史审计称 D5/D6 待批；本轮未找到正式批准记录。
- **需要 Owner 裁定**：批准 / 不批准 / 调整条款。未批准前，相关行为在文档中保持“待追认”，不改代码。

---

## 10. 验证与未执行项

**本轮实跑（docs 收敛不跳过代码一致性验证）：**

```text
packages/principles-core        -> 546 passed
packages/host-runtime           -> 89 passed
packages/openclaw-plugin        -> 19 passed（phase-a 4/4、llm-pain-retirement 4/4、gate-b 等）
packages/create-principles-disciple / workbuddy-adapter / pd-cli -> passed
```

**未执行（明确 NOT RUN，不标 PASS）：**

- 真实 LLM 调用与真实 LLM BDD。
- 三宿主最终验收。
- `verify:merge` 全链（由 PR CI 合并门执行）。

---

## 11. 结论

Pain 架构的**代码事实**已经与 v0.3.1 的实施契约基本对齐；剩余的差异集中在两类：

1. **真实运行验收缺口**（真实 LLM BDD、三宿主最终验收）—— 已独立建单，不伪造状态。
2. **GFI 收尾**（历史 JSON 迁移、墓碑例外）—— 已独立建单，并保留 Owner 裁定卡。

因此本轮裁定为 **READY_FOR_OWNER_REVIEW**，不是“全部完成”。文档 PR 保持 OPEN，等待 Owner 复核与 DC-01/DC-02 裁定。
