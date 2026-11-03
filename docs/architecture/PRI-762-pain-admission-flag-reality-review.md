# PRI-762 — Pain Admission Flag Contract Reality Review

> 任务描述引用 PRI-761，但 Linear 中 PRI-761 已被「CNB Cloud Auditor Trial-001」（In Review）占用；
> 本任务另立 **PRI-762** 承载，归「PD 瘦身与架构收敛」专项（PRI-744）。
> 本报告在最新 `origin/main`（`ef71be063`，2026-09-12）上独立复核，不采信任何历史结论作为删除依据。

- Baseline Commit: `ef71be063d75c6721e20fe8f25aec84c2e82e7d0`
- Branch: `ai/PRI-762-pain-admission-flag-review`
- Date: 2026-09-12
- 结论速览：**两个 flag 均无生产可执行消费者；Gate B 无条件接管准入；删除不改变用户行为（live 键退化为 unknown-flag 告警）；处置 = NEED SPEC（protected zone），不直接删码。**

---

## 1. Reality Report

### 1.1 Flag Definition

| 项 | painEvidenceAdmission | painEvidenceAdmissionDefault |
|-|-|-|
| Definition | feature-flag-contract.ts:259 | feature-flag-contract.ts:266 |
| Category | quiet | quiet |
| Default | true | true |
| 别名 | pain_evidence_admission → painEvidenceAdmission（contract:24） | pain_evidence_admission_default → painEvidenceAdmissionDefault（contract:25） |
| Lifecycle | census（feature-flag-lifecycle.ts:111）KEEP_QUIET，consumers 声称 pain.ts/llm.ts/gate-block-helper.ts | census（feature-flag-lifecycle.ts:119）同声称 |
| 描述 | PEAT-B1 evidence triage；PRI-452 补充 "no executable consumers" | PRI-454 kill switch；PRI-752 补充 "flag value has no runtime effect" |

注册表描述自身已标注 PRI-752 复核结论：无执行消费者、无运行时效果、disposition 待 Owner 决策。

### 1.2 Consumer Matrix

全仓检索（`!**/dist/**`）结果：

| 类别 | 命中 | 判定 |
|-|-|-|
| 生产可执行消费者 | **零**。hooks（pain.ts/llm.ts/gate-block-helper.ts/after-tool-call-helpers.ts）无任何 `loadFeatureFlagFromConfig('painEvidenceAdmission…')` / `isFeatureEnabled` / `flags[…]` 读取 | 无 |
| 注册表/生命周期自指 | contract:24-25/259/266；lifecycle:111/119 | 元数据 |
| 测试锁定断言 | gate-b-only-runtime-guard.test.ts:42-45、pain-emission-characterization.test.ts:189/270/351（断言 hooks **不加载**/不使用）；host-runtime pd-config-flag-alias.integration.test.ts（PRI-609 别名测试，测试加载函数本身） | 测试 |
| 注释/文档 | triage-adapter.ts:49（"flag is NOT consulted"）；pain-diagnostic-gate.ts / policy 头注（"to re-activate"为过期描述）；pain-evidence.ts:191（CLI 提示已删该建议）；synthetic-baseline-runner.ts:223 | 注释 |
| UI 标签 | pd-console enum-labels.ts:101（只读展示，非消费） | 展示 |
| 公共导出 | runtime-v2/index.ts:2027-2035 导出 pain-gate（Gate A policy） | 见 1.3 |

**结论：无生产读取。动态读取（loadFeatureFlagFromConfig 通用加载器）存在但没有任何生产路径以这两个 ID 调用；DI/registry 无注册。**

### 1.3 Runtime Path（真实准入链路）

```
Pain Event（tool failure / llm / gate block / manual）
  → Ingress（plugin hooks 或 host-runtime production-pain-evidence.ts）
  → Gate B：evaluateTriggerController（evidence-triage/trigger-controller.ts:276）
      ├── production-pain-evidence.ts:359（无条件调用，无 flag 检查）
      ├── openclaw-plugin hooks: pain.ts:565 / llm.ts:327 / gate-block-helper.ts:246 / after-tool-call-helpers.ts:494
      └── host-runtime governance-signal-admission.ts:646（Codex 治理信号准入）
  → Diagnosis → Candidate → Activation
```

- **Gate B 职责**：唯一准入决策者（trigger-controller.ts:264 "the ONLY function that decides whether a diagnostic task is created"），无 flag 参数、无 flag 依赖，完全替代 Gate A。
- **Gate A 状态**：
  - core `pain-gate/pain-diagnostic-gate-policy.ts`：纯逻辑，经 pain-gate/index.ts + runtime-v2/index.ts:2027-2035 进入公共导出 `@principles/core/runtime-v2`。
  - plugin `src/core/pain-diagnostic-gate.ts`：deprecated shim（@deprecated PRI-454），唯二 src 消费者收集点；
    **该 shim 自身无任何生产调用方**（仅测试 import：auto-entry-gate.test / pain-diagnostic-gate.test / gate-block-helper-profile.test）。
  - 任务要求检查 dynamic loading / DI / registry 调用：均无。
- **共存形态**：Gate A = 归档死代码（仅公共导出与测试存活）；Gate B = 唯一运行时权威。二者**不是并存**，是被替代关系。

### 1.4 Compatibility Analysis

| 场景 | 删除 flag 后行为 | 判定 |
|-|-|-|
| 用户配置 `painEvidenceAdmission: false` | 键未注册 → computeFeatureFlagsFromConfig 产生 `unknown flag ignored` 告警；无其他副作用 | 可观察、无行为影响 |
| 用户配置 `painEvidenceAdmissionDefault: false`（或 alias） | 同上 unknown-flag 告警 | 同上 |
| live workspace（2026-09-12 实测） | 仅含 `painEvidenceAdmissionDefault` + `pain_evidence_admission_default`（同值 true，2 键）；**不含** `painEvidenceAdmission` 本体 | SPEC §49 所述"4 个残留键（canonical×2+alias×2）"与当前 live **不符**（实测 2 键），Spec 实施时需以实测为准 |
| 升级路径 | 无迁移文件强制依赖这两个键；aliases 若不同批清理会成为新死键 | 需同批删除 alias |
| 回滚路径（PRI-454 文档承诺 flag-off → Gate A） | **不存在接线**：无任何代码按 flag 路由回 Gate A | 文档契约失效；回滚只剩 PR revert |

**特别结论（与既有 Spec 一致并被本审计独立确认）**：删除 flag **不会改变任何用户可观察行为**——准入已无条件走 Gate B，两个 flag 的值从未被生产路径读取。

---

## 2. Decision

| Flag | 判定 | 依据 |
|-|-|-|
| painEvidenceAdmission | **NEED SPEC**（不直接删码） | 零生产消费者 + 零 runtime effect + 零用户行为影响；但涉 pain pipeline protected zone → 按纪律走 SPEC |
| painEvidenceAdmissionDefault | **NEED SPEC**（不直接删码） | 同上 |

建议处置路径（承接既有 SPEC `docs/specs/pain-admission-flag-contract-fix.md` 选项 A）：
1. 删除 contract 两条目 + lifecycle census 条目 + `FEATURE_FLAG_ALIASES` 两条（指向已删 ID 者是死键）
2. Gate A：core policy 归档/删除前，需评估公共导出面（runtime-v2/index.ts:2027-2035）——本仓不可证明无下游消费者，须在实施 PR 中逐一列举导出面与已知下游
3. plugin deprecated shim `pain-diagnostic-gate.ts` 删除前确认其保名调用方（已证全部为测试）
4. census 契约测试（feature purgatory=0）双向同步
5. 验证：pain 特征测试（pain-emission-characterization / gate-b-only-runtime-guard）**零改动且绿**；`rg painEvidenceAdmission` 仅剩历史文档 + 测试断言文本

Owner 决策权：Spec 选项 A（删除）/ B（真正接线 rollback）/ C（仅修文档）三选一。

---

## 3. PR

本任务零代码变更（Needed SPEC，protected zone 纪律；无确定性修改可安全落地）。
如 Owner 批准选项 A，另开实施 PR（单独 PR、不混入 cleanup、verify:merge、回归测试证明删除前后行为 A=A）。

## 4. Success Criteria

未来任何人看到这两个 flag 可回答：
- **为什么存在**：PRI-454 Gate B 迁移期的 kill switch（painEvidenceAdmissionDefault）与 PEAT-B1 证据准入开关（painEvidenceAdmission）的历史遗产。
- **当前谁消费**：无生产消费者；唯一读取是注册表/别名归一化/测试/展示（consumer matrix 见 §1.2）。
- **删除是否影响系统**：不影响——Gate B（evaluateTriggerController）无条件准入已在 production-pain-evidence.ts:359 与全部 hooks 路径确认；删除仅将存量配置键退化为 unknown-flag 告警。
- **下一步**：Owner 在既有 SPEC（选项 A/B/C）决策；批准 A 后开实施 PR。