---
'@principles/core': major
'@principles/pd-cli': major
'@principles/host-runtime': minor
'create-principles-disciple': patch
---

# PRI-1146: Diagnostician Output V2 Only — 唯一生产契约切换与 V1 彻底退役

Owner 决策（2026-11-06）：Diagnostician Output 采用 V2 Only / Clean Break。

## @principles/core (major)

- `DiagnosticianOutputV1` / `DiagnosticianOutputV1Schema` / `DiagnosticianRecommendation` 删除；唯一契约为 `DiagnosticianOutputV2Schema` / `DiagnosticianOutputV2` / `DiagnosticianRecommendationV2`（含 `recommendationRef` 与 rule 专属 `principleAssociation`，根对象封闭）。
- Registry：`diagnostician-output` → V2 Schema；`diagnostician-output-v1` 不再解析（fail-loud）；其他 Stage 的 alias 不受影响。
- 新增可信上下文证据（SPEC v0.6 §5）：`trustedContextReceipt` 升级 `router-context-v2`（canonicalPrinciples available/unavailable、证据引用、逐条 sha256 摘要、重启可复验）；`RouterTrustedPrincipleSource` 端口与 `PrincipleTreeLedgerAdapter.readTrustedPrinciples()`。
- Default Validator 增加 ASSC-1..4（recommendationRef 唯一、目标存在且为 principle、evidenceRefs 可追溯、非 rule 不得携带关联），并以 `invalidAreas` 区分 Schema/Association 失效。
- Committer 仅接受 V2，并增加 recommendationRef 唯一写边界守卫。
- 身份类型新增 `source_declared_relation` basis（仅只读 shadow，OD-01/02/03 未批不授权生成）；新增 `resolveSourceDeclaredRelations` 只读解析器。
- PainSignalBridge 三处读取切换 V2；历史重放跳过改为结构化 telemetry（rc-9）。

## @principles/pd-cli (major)

- diagnose/pain-retry 构造注入 trustedPrincipleSource；诊断输出契约随 core 升级为 V2 Only（CLI 输出与落库工件均为 V2）。
- synthetic baseline / flood simulation fixtures 输出 V2。

## @principles/host-runtime (minor)

- 遥测 allowlist 新增 `diag_router_trusted_context_unavailable` 与 `replay_review_source_invalid`（P1-01 / rc-9）：ledger 不可证明时 canonical association 保持 unresolved 的原因、以及 replay review skip 的唯一持久记录。

## create-principles-disciple (patch)

- 随包发布的 pd-console 展示文案与 e2e seed 同步 V2 契约（agent-metadata 输出说明、e2e-seed 诊断字面量）。

Breaking：V1 诊断输出、V1 registry ref 与 V1 兼容读取路径全部移除；本机旧 V1 数据按 Owner 授权清理重置，不提供迁移。
