# SPEC v0.3 Final Contract Closure Review（v0.3 → v0.3.1）

**日期:** 2026-11-02
**性质:** 实施前最后一次契约收口审查（不做全仓审计）
**基线:** 起草时 HEAD=`457bbf0fcd8df85c069b78ce60858acf742fe970`；origin/main 前移至 `fd8fe301f`（版本发布增量，与五项议题函数无交叠，见 SPEC v0.3.1 §5 基线说明）
**证据方式:** 承重函数一手读取（pain-ingress.ts 全文 239 行；gsa 的 admitCorrection :746-826、insertAdmissionMarker :699-705、ensureGovernanceDiagnosticianTask :1210-1318、isGovernanceTaskPayload :1146-1180、readGovernanceAdmissionCounts :1731-1759、admitOne :947-980）+ 全库 grep 决策点清单；无推测补齐，无法验证处标 UNVERIFIED。

---

## Part 1 — 两项技术问题的核查与定案

### P0：PainIngress 执行顺序

**现状核实**（一手）：governance 路径**当前不含** PainIngress——`evaluatePainIngress` 现有调用点仅 openclaw-plugin/hooks/pain-ingress-adapter.ts:72 与 pd-cli pain-record；`ensureGovernanceDiagnosticianTask` 硬编码 `provenance:'host_context_bound'`（gsa:1269）。接入是 v0.3 §5 计划项。

**定案**（SPEC v0.3.1 §1.2）：Stage-2 分类（结果持久化）→ Build Report → **evaluatePainIngress 前置**（纯函数，pain-ingress.ts:21-23，重执行零副作用）→ 四分支：submit/degrade → 准入事务 {marker CAS(changes=1) → 去重探针 → 限流 → insertCorrectionPain → payload 换入} → ensure 任务 → Case A/B；refuse/observation_only → `abandoned(reasonCode)` 终态（零 Pain/零任务/零额度；不误标 resolved_none；优先用现有 decision 值，不新增命名）。

**为什么可以放在 CAS 之前且安全**：evaluate 纯函数（可重入、零消耗、零记录）；并发仲裁唯一性由事务内 changes=1 保证——evaluate 结果只影响分支走向，不影响竞争裁决。

**场景 F（Pain Event 创建失败 → marker 不得遗留 admitted）的机制保证**：步骤 ①-④ 同一 SQLite 事务，任一步失败整体回滚，marker CAS 亦随之回滚——原子性是现状事务模式（gsa:790-818）的直接继承。

### P1：Worker 总执行预算

**问题确认**：v0.3 允许最坏 2×60s=120s ≥ 周期 120s。

**定案**（SPEC v0.3.1 §2.2）：Stage-2 步骤移至**周期末尾**（诊断/reconcile/后处理之后 append——现状周期顺序：Codex catch-up:281→reconcile:289→diagnostician:332-340；WB reconcile:170→sweep:177→diagnose:207-215），aggregate budget ≤60s/周期（monotonic 时钟、逐候选检查、耗尽跳过），单次 60s 不变，串行+CAS 不变。最坏占用周期 50% 且发生在诊断之后。

**Liveness 的诚实表述**：现状无 Stage-2，"liveness 不受影响"现状下不成立也无从成立；最终证据是 Phase B §8 新增测试。实施前按 UNVERIFIED 对待，SPEC 不声称现状已保证。

---

## Part 2 — D5/D6

- **D5（G3 逆转）**：建议批准。明确为**行为契约变更**而非代码优化；Phase B 的 P-2 以 D5 批准为门。理由链：Codex 子串路径零引用/转述负向测试（"他说这是错的"今天即 STRONG）+ 子串匹配零防护 + confidence 无门控（v0.2 定点审查一手证据）→ TP/FP 计数不足以支撑直通资格。
- **D6（Pending 保留与最小化）**：建议有条件批准。`task_payload_json` 为自由 JSON（TEXT 列，无 CHECK），最小化方案=终态 UPDATE 同语句重写 payload（丢弃文本、保留 metadata），**零 DDL 零新表**；admitted 形态与现行 `taskSubmissionPayload`（gsa:635-668，sanitizeString 界定文本）完全一致，无新增留存范围。

两项在 SPEC v0.3.1 §3 中均标记**待 Owner 最终批准**，未写成已授权。

---

## Part 3 — 兼容性验收（任务书 §五 七项，证据见 SPEC v0.3.1 §4）

七项全部闭合：payload 双形状隔离（validator 形状门 + fail-loud :1232-1234）；decision 新值对全部 10 个访问点惰性（单一 owner 文件，reconcile :1651 与健康计数 :1736-1739 显式过滤 admitted，其余按 canonical_pain_id=NULL 惰性）；reconcile 只扫 admitted；既有 STRONG+high 内联准入与 CR-07 显式声明路径零改动；UNIQUE 语义保持（pending 行占用键 + v0.3 预探守卫）。唯一注意点：`last_admission = MAX(created_at)` 语义会含 pending 行——最小处置=文档注明，可选一行过滤，不阻塞。

---

## Part 4 — 交付执行记录

- 新文件：`docs/specs/SPEC-PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE-001-v0.3.1.md`（本文同时交付）；v0.3 原文件保留不动。
- `git diff --check`：通过（见 PR 执行记录）。
- 生产代码/schema/flag/配置：零变更（纯文档分支，`git diff --name-only` 仅 docs/**）。
- 交叉检查四项（内部引用/状态机-准入一致性/预算一致性/Owner 决策完整性）：见 SPEC v0.3.1 §6，全过。
- 已知局限：Mimosa 对本次提交给出 `scanner_enobufs`（内存不足未出完整扫描结论），按兼容策略继续；**不宣称项目安全结论**，建议后续补跑完整审计。

---

## Part 5 — 裁定

**READY_WITH_OWNER_DECISIONS**（与 SPEC v0.3.1 §7 一致）：两项技术问题已解决；无实施阻塞；D1-D6 全部待 Owner 批准；Phase 0 可立即实施，Phase B 待 D5/D6，Phase A 以 Phase B 验收为前置，Phase C 第一阶段可实施、第二阶段必须等 D4。
