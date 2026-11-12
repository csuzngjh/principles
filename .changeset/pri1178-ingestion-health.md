---
'@principles/pd-cli': minor
'@principles/host-runtime': patch
'@principles/workbuddy-adapter': patch
---

PRI-1171 P2 工单⑦：采集健康可观察。`pd health` 主报告内嵌三宿主对话摄取段（每宿主 hostFlag/ingestionFlag/consent 元数据/检查点水位 lastSuccessAt·checkpointOffset·lagBytes·lastDegradation/显式 live_only 会话列表——live 路径从不写 checkpoint，缺检查点是状态不是滞后异常；openclaw 为显式 not_wired 行，P3 工单⑨接线；全部降级带 reason+nextAction，cli-1/6 合规）。host-runtime 新增 `listGovernanceUncheckpointedSessions`（live_only 数据面，有界+截断标记）。workbuddy-adapter 导出 `locateWorkbuddyTranscriptBySessionIdentity`（采集写入者与健康读取者共用同一定位器）。Console 新增只读采集健康状态页（`/api/health/ingestion` 逐字透传 CLI 权威报告 + `/ingestion-status` 页面 + 工具导航项；G6 红线：状态视图，非轨迹浏览；pd-console 私有包不声明 changeset）。
