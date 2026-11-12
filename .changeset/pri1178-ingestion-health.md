---
'@principles/pd-cli': minor
'@principles/host-runtime': patch
'@principles/workbuddy-adapter': patch
'create-principles-disciple': patch
---

PRI-1171 P2 工单⑦：采集健康可观察。`pd health` 主报告内嵌三宿主对话摄取段（每宿主 hostFlag/ingestionFlag/consent 元数据/检查点水位 lastSuccessAt·checkpointOffset·lagBytes·lastDegradation/显式 live_only 会话列表——live 路径从不写 checkpoint，缺检查点是状态不是滞后异常；openclaw 为显式 not_wired 行，P3 工单⑨接线；全部降级带 reason+nextAction，cli-1/6 合规）。host-runtime 新增 `listGovernanceUncheckpointedSessions`（live_only 数据面，有界+截断标记）。workbuddy-adapter 导出 `locateWorkbuddyTranscriptBySessionIdentity`（采集写入者与健康读取者共用同一定位器）。宿主适配器在 pd-cli 内惰性加载（PRI-1061 宿主无关启动：`pd health --help` 在适配器缺失时仍可启动，缺失降级为结构化 host_adapter_unavailable）。Console 新增只读采集健康状态页（`/api/health/ingestion` 逐字透传 CLI 权威报告 + `/ingestion-status` 页面 + 工具导航项；G6 红线：状态视图，非轨迹浏览；pd-console 为私有包，其发布意图按 guard 指引落在 installer patch）。
