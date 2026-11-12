---
'@principles/core': minor
'@principles/host-runtime': minor
'@principles/codex-adapter': minor
---

PRI-1179：把 full 层文本策略接到生产路径，并保存 Codex reasoning 的可读摘要。

`@principles/core` — `sanitizeString` 增加可选 `maxChars` 内容上限（默认 200 行为不变；截断后仍追加 `___TRUNCATED___`，与旧的 200→215 形状一致）。

`@principles/host-runtime` — `ingestGovernanceObservations` 接受 `maxVisibleTextChars`，insert / user-turn 冲突比较 / fill 三条 `visible_text` 路径共用同一上限（避免 full 层行在 replay 被误判为 lineage conflict）；`runConversationIngestion` 接受 `textPolicy` 并透传。默认值不变，既有 bounded 路径与宿主观感不变。

`@principles/codex-adapter` — 新增 `resolveCodexTextPolicy`：读真实 v3 同意台账，仅当 `granted` 且 `disclosureVersion >= CODEX_INGESTION_DISCLOSURE_VERSION` 时使用 full 层 20,000 上限；台账缺失/不可读/已撤销/旧披露一律 bounded（只会收窄）。decoder 开始投影 reasoning 的明文 `summary`（没有 summary 则不写，`encrypted_content` 永不读取），此前 reasoning 记录被整体丢弃。WorkBuddy 侧的 full 层接线未包含在本批（其披露版本常量归属 `pd-cli`）。
