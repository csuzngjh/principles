# Agent-Software Contract Architecture

> **状态**: Active
> **最后更新**: 2026-05-21
> **关联文档**: `INTERNALIZATION_PIPELINE.md`, `OBSERVABILITY_ARCHITECTURE.md`, `ERROR_ARCHITECTURE.md`, `VERSIONING_AND_COMPATIBILITY.md`, `SECURITY_ARCHITECTURE.md`
> **关联 ADR**: ADR-0001, ADR-0003, ADR-0004, ADR-0008, ADR-0009

本文档定义 PD 中 **LLM/内置代理输出如何安全进入软件系统** 的架构边界。

背景问题：PD 依赖多个内置代理和 Peer Runner 协同工作，但 LLM 输出具有随机性。最常见失败是 JSON 格式不正确、字段缺失、字段语义矛盾、lineage 错误、或 schema 版本与解析代码漂移。若只靠提示词要求“请输出 JSON”或在代码里无限增加 parser fallback，系统会变成脆弱的 prompt/parser 竞赛。

因此，PD 采用三层 Agent-Software Contract：

1. **软件拥有确定性写入和校验**：Agent 负责推理，PD CLI/core 负责写入、校验、迁移和审计。
2. **Runtime Adapter 拥有格式修复回路**：schema validation failure 先进入有界修复回路，而不是直接堆 parser 兜底。
3. **可选的证书式输出契约**：LLM 可以提交数据及其自证材料，但权威仍是 PD 的 schema、replay、sandbox gate。

---

## 1. 非目标

本契约不要求：

- 修改 `DiagnosticianOutputV1`。
- 让 LLM 直接写 SQLite / ledger / artifact store。
- 信任 LLM 生成的验证代码作为最终判断。
- 用单个通用 parser 吞掉所有输出错误。
- 引入 LangChain 作为运行时依赖。

LangChain / Instructor / Guardrails / Outlines 等框架的价值在于“schema feedback retry”和“structured output enforcement”。PD 可以复用这些思想，但核心契约保持框架无关，避免把内化管线绑定到某个外部框架。

---

## 2. 设计原则

| 原则 | 含义 |
|------|------|
| 软件是写入权威 | 任何进入 DB/ledger/artifact 的变更必须由 PD CLI/core API 完成。 |
| Agent 是推理者，不是数据库客户端 | Agent 输出意图、证据、候选，不直接执行重复性 SOP 写入。 |
| Schema failure 是一等事件 | `output_invalid` 必须保留 schemaRef、error path、raw preview、prompt version。 |
| 修复回路有界 | 对同一输出最多 1-2 次格式修复；超出后失败并落证据。 |
| Parser fallback 有上限 | fallback 只能处理明确格式变体，不能猜测业务语义。 |
| Lineage 不可伪造 | Agent 不能改变 `taskId/sourcePainId/sourceArtifactId/sourceRefs` 等归属字段。 |
| 证书式输出只能辅助 | LLM 生成的 validator/checker 只能作为 shadow evidence，最终由 PD gate 判定。 |

---

## 3. 三层结构

### 3.1 Layer 1: PD CLI Validated Write Contracts

Agent 不应直接构造最终存储对象。它应调用或输出给 PD CLI，由 CLI 执行确定性写入。

```text
Agent reasoning
  -> completion/intention payload
  -> pd <domain> write/validate command
  -> core schema validation
  -> store write + telemetry + audit
```

建议的 CLI 合同：

| 命令 | 责任 | 输入 | 输出 |
|------|------|------|------|
| `pd output validate` | 验证任意 runner 输出 | schemaRef + JSON | valid/errors/repairPrompt |
| `pd artifact write` | 写入 PIArtifact | schemaRef + payload + lineage | artifactId/resultRef |
| `pd candidate ingest` | 摄入 candidate | candidate payload | candidateId/intake decision |
| `pd trace refine` | 确定性 TraceRefiner | FullTracePayloadV2 | RefinedTracePayload |
| `pd golden-trace build` | 从 refined trace 生成 candidate | RefinedTracePayload | GoldenTrace draft |

要求：

- 所有写命令必须支持 `--dry-run`。
- 所有写命令必须返回 JSON。
- 所有写命令必须记录 actor：`agent/system/human`。
- 写入失败必须用 `PDRuntimeError` 分类。
- CLI 必须做 schema validation，不能把验证委托给 Agent。

### 3.2 Layer 2: Runtime Adapter Structured Output Repair Loop

每个 Runner 仍通过 `PDRuntimeAdapter` 调 LLM。Adapter 在 `fetchOutput` 或 `completeWithRetry` 后执行 schema dispatch：

```text
raw LLM output
  -> extractJsonObject / provider native structured output
  -> schema validation
  -> valid: return StructuredRunOutput
  -> invalid: build repair prompt with structured errors
  -> retry 1-2 times
  -> still invalid: output_invalid + evidence pack
```

修复回路必须记录：

```typescript
interface OutputRepairAttempt {
  schemaRef: string;
  attempt: number;
  rawOutputPreview: string;
  validationErrors: Array<{
    path: string;
    expected: string;
    actualPreview: string;
  }>;
  repairPromptVersion: string;
  repaired: boolean;
}
```

允许的修复：

- 去除 prose/code fence 包裹。
- 修复缺失的 JSON object wrapper。
- 要求 LLM 根据明确 schema errors 重发。
- 保留原始 raw preview 和 validation error。

禁止的修复：

- 猜测业务字段。
- 修改 lineage 字段。
- 默默把 unknown 转成任意默认值。
- 无限重试。

### 3.3 Layer 3: Certifying Output Contract (Shadow)

这是长期方向，不作为短期生产写入权威。

设想：LLM 不只提交 JSON 数据，也提交“自证材料”，例如：

```typescript
interface CertifiedAgentOutput<TData> {
  data: TData;
  contractVersion: string;
  claims: Array<{
    claim: string;
    sourceRefs: string[];
  }>;
  selfCheck: {
    schemaSummary: string;
    invariantChecks: string[];
    failureCasesConsidered: string[];
  };
  optionalVerifierCode?: string;
}
```

解释：

- `data` 是候选结果，不直接写入。
- `claims` 和 `sourceRefs` 用于可追溯性。
- `selfCheck` 是 LLM 自述，不可信但有审计价值。
- `optionalVerifierCode` 如存在，必须在 sandbox 中运行，且只作为 evidence。

这个模式适合：

- TraceRefinerAgent shadow output。
- GoldenTrace candidate builder。
- RuleHost implementation proposal。
- Long-running built-in agents 的 completion artifact。

不适合：

- 直接更新 ledger。
- 直接批准 live auto_correct。
- 直接改变用户文件。

---

## 4. 和现有管线的关系

### 4.1 Pain Pipeline / Diagnostician

短期优先做 Layer 2：Diagnostician/Dreamer/Evaluator/RolloutReviewer 的 `output_invalid` 失败必须进入 schema feedback repair loop，并把失败证据落盘。

### 4.2 Internalization Peer Runners

Peer Runner 输出必须满足：

- `outputSchemaRef` 明确。
- promptContractVersion 明确。
- schema validation errors 可观测。
- lineage 字段由 Runner context 注入并强校验，不由 LLM 自由决定。

### 4.3 TraceRefiner / GoldenTrace

TraceRefiner 已经是确定性 read model；TraceRefinerAgent 应保持 shadow。后续 GoldenTrace candidate builder 可以采用 Layer 3 的 certifying output 结构，但生成后的 GoldenTrace 仍必须由 core validator 和 replay gate 判定。

### 4.4 RuleHost / Activation

RuleHost live activation 必须满足：

- GoldenTrace replay 通过。
- Refiner sandbox gate 通过。
- Approval context 可审计。
- Agent 生成的代码或自证材料不能绕过 sandbox/gate。

---

## 5. 可观测性要求

每次 agent/software contract 边界失败必须产生可查询证据。

| 失败类型 | 必须记录 |
|----------|----------|
| JSON extraction failed | schemaRef, provider, model, rawOutputPreview |
| schema validation failed | schemaRef, error paths, promptContractVersion |
| repair exhausted | attempts, final raw preview, validation errors |
| lineage mismatch | expected source id, actual source id, taskId |
| CLI write rejected | command, dryRun, validation errors, actor |
| certifying output rejected | claim/sourceRef errors, sandbox result |

建议统一事件类型：

- `output_extraction_failed`
- `output_schema_invalid`
- `output_repair_attempted`
- `output_repair_exhausted`
- `validated_write_rejected`
- `certifying_output_rejected`

---

## 6. 启动顺序

### Phase A: 先堵当前真实痛点

1. 修 PITask hydration 非 PeerRunnerKind。
2. 修 CorrectionProposal correctedFields/proposedParams 交叉验证。
3. 给 PDRuntimeAdapter 增加 schema feedback repair loop。

### Phase B: 固化 Agent 写入边界

4. 新增 `pd output validate`。
5. 新增 `pd artifact write --dry-run/--confirm`。
6. 把关键 agent instructions 改成调用 CLI，而不是手写最终 JSON。

### Phase C: 证书式输出 shadow 试点

7. 在 TraceRefinerAgent 上实现 `CertifiedAgentOutput` shadow contract。
8. 在 GoldenTrace candidate builder 上复用。
9. 只记录/评估，不作为生产写入权威。

---

## 7. 成功标准

| 阶段 | 量化标准 |
|------|----------|
| Phase A | `output_invalid` 能区分 extraction/schema/lineage；repair loop 后仍失败的样本有 evidence pack |
| Phase B | 关键写入命令都有 dry-run、schema validation、actor audit；agent 不直接写 artifact/ledger |
| Phase C | Certified output 可被 sandbox/replay 验证；被拒绝时有结构化 reason |

最终目标不是让 LLM 永远输出正确 JSON，而是让错误输出成为系统可理解、可修复、可审计的普通状态。
