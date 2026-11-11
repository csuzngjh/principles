---
"@principles/host-runtime": minor
"@principles/codex-adapter": patch
---

PRI-1171 P1（工单①+②，行为零变化提取）：host-runtime 新增 `conversation-ingestion` seam——统一宿主轨迹摄取的唯一中立入口（`TranscriptSourceAdapter` 契约 + `runConversationIngestion` 五段管线 + 同意台账 v3 + 同意分层文本策略）；Codex 摄取管线平移接入（解码器/版本守卫/路径授权留 codex-adapter，旧导出名兼容 re-export 一个版本周期）。同意台账权威迁至 `<workspace>/.state/conversation-ingestion-consent.json`（按宿主分键），旧 `.pd/codex-ingestion-consent.json` 首读单向迁移并改名 `.superseded`（保留审计）；新增 `owner_directive` 决定通道（须带 evidenceRef）。行为锁定：codex-adapter 全量 379/379 通过（真实 fixtures 走迁移后生产路径）；seam 新增 37 测试（flag-off 零读/consent 门/守卫拒绝不落库/preIngest 失败保水位/malformed 提交后降级/incomplete-tail/TOCTOU/水位回缩/consent 迁移矩阵）。
