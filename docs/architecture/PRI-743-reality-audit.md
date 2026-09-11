# PRI-743 Architecture Reality Report

> 阶段：第一阶段（数据链路审计）
> 分支：`ai/PRI-743-codex-dogfood-validation`，base `origin/main e62537dac`
> 方法：源码 + schema + 生产 wiring grep + 只读数据库探针（全程 `readonly: true`）
> 结论性质：Implementation Truth（代码与数据事实），非 SPEC 意图

---

## 0. 一句话结论

**当前机器上，PD 的核心闭环没有任何真实数据。** 所有 `pain_events` 中带 `host_kind` 的记录只有 2 条，且来自 PRI-640 的 smoke 测试构造；`pain_diagnoses` / `principle_candidates` / `activations` 在真实 workspace 中全部为 0。

因此 PRI-743 的最终问题「PD 是否真的让 Agent 从一次失败中学习」，**目前无法用数据回答** —— 不是因为闭环坏了，而是因为闭环从未在真实使用中通电。

---

## 1. 真实数据流（源码验证）

### 1.1 OpenClaw（默认生产路径）

```
OpenClaw before_prompt_build hook
  └─ index.ts:334
     └─ hooks/prompt.ts:393 handleBeforePromptBuild
        └─ core/signal-collector-host.ts:164 detectSync → :315 routeStrong
           └─ deriveProductionCorrectionPainIdentity     [host-runtime/production-pain-evidence.ts:229]
              └─ hooks/pain.ts:130 emitPainDetectedEvent
                 └─ pain-ingress-adapter.ts:56  hostKind='openclaw'  ★归因
                 └─ pain-ingress-adapter.ts:73  evaluatePainIngress
                    └─ PainToPrincipleService.recordPain   [core/runtime-v2/pain-to-principle-service.ts:145]
                       └─ pain-signal-observability.ts:404  INSERT pain_events(host_kind='openclaw')
                          └─ [同步] onPainDetected → Diagnostician → principle_candidates
                             └─ pain_diagnoses  ← 仅当 pain_diagnosis_persistence=ON（默认 OFF）
```

**门控**：`abstraction_layer_v1` 默认 **OFF**（feature-flag-contract.ts:338）。因此共享 host-runtime 路径（`createProductionPainEvidenceHandler` + `hostKind:'openclaw'`，`openclaw-host-runtime.ts:113`）**默认不执行**，OpenClaw 走上述 legacy 路由（`index.ts:520-533`）。

### 1.2 Codex（需 hook 装配 + ingestion 开启）

```
Codex CLI Stop / PostToolUse / UserPromptSubmit
  └─ ~/.codex/hooks.json → pd-hook.js            ← ★当前机器上该文件不存在
     └─ pd-hook.ts:94  host.codex 门禁（默认 ON）
     └─ pd-hook.ts:97  ingestionEnabled           ← codex_conversation_ingestion 默认 OFF
        └─ ingestion/ingestion.ts:262 ingestCodexConversation → governance_observations
           └─ ingestion/admission.ts:141 admitGovernanceSignals
              └─ governance-signal-admission.ts:699  if hostKind !== 'codex' → 拒绝  ★仅 Codex
              └─ INSERT pain_events(host_kind='codex') + governance_signal_admissions
                 └─ ensureGovernanceDiagnosticianTask → recordPain(asyncMode:true)
                    └─ workspace-worker.ts:220 executePendingDiagnosis（异步）
                       └─ pain_diagnoses ← 仅当 pain_diagnosis_persistence=ON（默认 OFF）
```

### 1.3 汇流点与分叉点

| 维度 | 是否共享 | 证据 |
|---|---|---|
| `pain_events` 表 + `host_kind` 列 | ✅ 共享 | `pain-signal-observability.ts:404` / `production-pain-evidence.ts:396` / `governance-signal-admission.ts:475` |
| canonical pain id 派生 | ✅ 共享 | `deriveProductionCorrectionPainIdentity`（OpenClaw `signal-collector-host.ts:331` 与 Codex `governance-signal-admission.ts:568` 同一函数） |
| `PainToPrincipleService.recordPain` | ✅ 都调用 | 但**角色不对称**：OpenClaw 用它写 pain row；Codex 已自写 row，只用它建诊断任务 |
| **Admission** | ❌ 分叉 | `admitGovernanceSignals` 仅接受 codex（`:699` 硬拒），OpenClaw 无任何调用者 |
| **诊断执行时机** | ❌ 分叉 | OpenClaw 同步（hook 内 inline 跑 LLM）；Codex 异步（worker `executePendingDiagnosis`） |
| **语义权威 `evaluatePainIngress`** | ❌ 不对称 | 全仓生产调用者仅 openclaw-plugin + pd-cli；**Codex 链路零调用** |

**判定**：若验收口径是「同一张表 + 同一 id 派生 + 同一 host_kind 列」→ **通过**；若口径是「同一个写入函数 / 同一条准入链路」→ **不通过**。

---

## 2. 现状数据（只读探针，全盘扫描 `D:\Code`）

| 数据源 | pain_events | host_kind 分布 | 说明 |
|---|---|---|---|
| `D:\Code\principles\trajectory.db` | 26 | **全部 NULL（unknown）**，source 全为 `manual`，canonical id 全 NULL | 2026-09-01 的 "empty state test" 测试数据 |
| `D:\Code\pd-pri640-smoke-ws\ws\.state\trajectory.db` | 2 | openclaw ×1 / codex ×1 | PRI-640 smoke 构造数据；`governance_signal_admissions` 1 条（codex） |
| `tests/e2e-workspace/**` | 1–2 each | — | 测试产物，非 dogfood |

闭环表（真实 workspace）：

| 表 | 数量 |
|---|---|
| `pain_diagnoses` | **0** |
| `principle_candidates` | **0** |
| `activations` | **0** |
| `tasks` | 0（`pd-pri640-smoke-ws` 为 1） |

`principle_candidates` / `activations` 的非零值**只出现在 `tests/e2e-workspace/**` 下**（如 `acceptance-l3g` 有 5 candidates + 5 activations），即测试产物。

---

## 3. 阻塞点（为什么没有真实数据）

| # | 阻塞 | 证据 | 性质 |
|---|---|---|---|
| B1 | **Codex hook 未装配**：`~/.codex/hooks.json` 不存在 | `ls ~/.codex/hooks.json` 无输出；`~/.pd/runtime/codex-adapter` 已安装但 hook 未写入 | 环境未开通 |
| B2 | **`codex_conversation_ingestion` 默认 OFF** | feature-flag-contract.ts:402；flag-off = 零 transcript 读取 | 设计默认值，需显式开启 |
| B3 | **`pain_diagnosis_persistence` 默认 OFF** | feature-flag-contract.ts:376；`pain-signal-bridge.ts:351` 默认 false | 诊断不可观测 |
| B4 | **OpenClaw 共享 runtime 被门控** | `abstraction_layer_v1` OFF（:338）+ `index.ts:520-533` | 设计默认值 |
| B5 | `pd pain record` 硬编码 `host_kind='openclaw'` | `pd-cli/src/commands/pain-record.ts:141` | 归因缺陷（污染 host 统计） |
| B6 | Codex 不调用 `evaluatePainIngress` | 全仓生产 grep 仅命中 openclaw-plugin / pd-cli | 语义不对称 |

---

## 4. Follow-up Recommendations（本次不擅自修复）

1. **B5 归因缺陷**：`pain-record.ts:141` 应支持 `--host` 或按调用方判定。（需 PR + regression test）
2. **B6 语义对称**：Codex 链路接入 `evaluatePainIngress`，否则双 Host 的 `painIngress.v1` 溯源不对称。
3. **可观测性**：`pd pain list --json` 缺按 host 的聚合汇总（`byHost`），建议增补字段而非新增命令。
4. **口径确认**：「两个 Host 进入同一 canonical pipeline」的验收口径需 Owner 明确（表级汇流 vs 链路级汇流）。

---

## 5. 待决策：dogfood 如何产生真实数据

PRI-743 要求每 Host 5–10 条真实 correction。当前约束：

* **Codex**：可由我跑真实 `codex` CLI session 产出，但需先 `pd codex setup`（写 hooks.json）+ 开启 `codex_conversation_ingestion` + 开启 `pain_diagnosis_persistence`。
* **OpenClaw**：需要真实 OpenClaw 会话中的自然 correction。当前会话是 WorkBuddy，不是 OpenClaw host，**我无法代替产生**；只能由你在 OpenClaw 中真实使用，或用生产 CLI 路径（`pd pain record`）显式记录（会被计为 `manual` source，且受 B5 影响）。
