# Phase m7-02: PrincipleTreeLedger Adapter - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-26
**Phase:** m7-02-PrincipleTreeLedger-Adapter
**Areas discussed:** A (LedgerPrinciple.id format), B (triggerPattern/action defaults), C (sourceRef storage), D (existsForCandidate implementation)

---

## A — LedgerPrinciple.id format

| Option | Description | Selected |
|--------|-------------|----------|
| 直接复用 UUID v4 | 把 LedgerPrincipleEntry.id (UUID v4) 直接作为 LedgerPrinciple.id。账本中id格式混合(P_XXX + UUID)可接受，sourceRef作为主要溯源键。 | ✓ |
| P_\<sequential\> | 与现有 evolution-worker 相同逻辑：扫描账本文件找最大数字后缀。不走 UUID。 | |
| P_\<UUID前8位\> | 混合式：P_ 前缀 + UUID 前8位。树形结构更整洁但会与现有 P_XXX 格式冲突。 | |

**User's choice:** 直接复用 UUID v4
**Notes:** 账本中混合 ID 格式可接受，sourceRef 作为主要溯源键。

---

## B — triggerPattern / action defaults

| Option | Description | Selected |
|--------|-------------|----------|
| 优先从 recommendation JSON 提取，为空则 null（推荐） | triggerPattern/action 优先从 DiagnosticianRecommendation JSON 提取。为空/缺失时设为 null（Optional字段），不在此处推导。M7 不做复杂推导。 | ✓ |
| description 前 100 字符作为 triggerPattern，为空则 null | triggerPattern 提取：尝试从 recommendation.description 前 100 字符。action 为空则 null。 | |
| JSON 提取 + description 文本推导作为 fallback | triggerPattern/action 优先从 JSON 提取。如果缺失，从 description 使用正则推导（如 "When \<X\>, then \<Y\>" 模式）。 | |

**User's choice:** 优先从 recommendation JSON 提取，为空则 null
**Notes:** M7 不做复杂推导；通过 sourceRecommendationJson 解析。

---

## C — sourceRef 处理

| Option | Description | Selected |
|--------|-------------|----------|
| 仅在内存/mapping 层处理，不写入 LedgerPrinciple（推荐） | sourceRef 不写入 tree.principles（Principle 接口无此字段）。existsForCandidate 在内存 mapping 或独立 index 中维护 candidateId→ledgerRef 映射，adapter 内部使用，不暴露到账本文件。 | ✓ |
| 添加到 Principle.source 字段 | 把 candidate://\<candidateId\> 作为额外字段塞入 source 对象的 candidateRef 键。但 source.painId 等字段是 pain 信号专用，混用会破坏语义。 | |
| 作为独立 provenanceMetadata 字段写入账本 | 扩展 LedgerPrinciple 类型添加 provenanceMetadata?: { sourceRef, artifactRef, taskRef }。需要改 Principle 接口，影响范围大。 | |

**User's choice:** 仅在内存/mapping 层处理，不写入 LedgerPrinciple
**Notes:** 但引出了 C+D 联合问题：existsForCandidate 需要用 sourceRef 扫描，但 sourceRef 不存在于账本中。

---

## D (combined with C) — existsForCandidate 实现路径

| Option | Description | Selected |
|--------|-------------|----------|
| adapter 实例级 Map 缓存（推荐） | writeProbationEntry 时：先从账本扫描（防重），确认无重复后写入，同时在 adapter 实例的 Map\<candidateId, ledgerRef\> 中记录。existsForCandidate 查此 Map。adapter 单例化或在 caller 层复用实例。 | ✓ |
| 写入 LedgerPrinciple 作为隐藏字段 | sourceRef 作为 provenanceRef 字段写入 LedgerPrinciple（虽不在标准 Principle 接口中）。账本文件本身无标准 schema 校验，可以自由扩展。existsForCandidate 通过扫描账本实现。 | |
| 账本内联扫描：JSON 扩展字段 | 不修改 LedgerPrinciple 接口，在写入时将 sourceRef 等 provenance 字段 base64 编码嵌入 LedgerPrinciple.text 尾部作为不可见的标记。existsForCandidate 扫描 text 字段匹配。 | |

**User's choice:** adapter 实例级 Map 缓存
**Notes:** adapter 单例化或 caller 层复用实例（与 m7-01 D-07 DI 决策一致）。

---

## Deferred Ideas

- **Provenance metadata persistence** — sourceRef 目前是纯内存层，未来可能需要将其持久化到账本中以便下游消费者追溯。

---
