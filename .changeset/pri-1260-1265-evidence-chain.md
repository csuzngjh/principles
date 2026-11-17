---
"@principles/core": patch
"@principles/host-runtime": patch
"@principles/pd-mcp-server": patch
"pd-cli": patch
"codex-adapter": patch
"workbuddy-adapter": patch
---

宿主反馈证据链四项修复：`pd_submit_pain` 接受宿主会话声明并按本工作区授权轨迹校验（PRI-1260，verified 才写 sessionIdHint 与回执关联，未验明保留 unbound 合同并回报具体原因）；Codex live/catch-up 采集复用正式 v3 授权判定，缺失/撤回/失败记录在读转录前拒绝（PRI-1262）；超限完整 JSONL 记录由 pipeline 扫描跳过并留可追踪处置，检查点前进、与未完成尾部区分（PRI-1261，Codex+WorkBuddy 生产边界）；授权轨迹读取器接入 pd diagnose/pain retry 与 Codex/WorkBuddy worker/auto-run（PRI-1265，会话两种拼写匹配、过期档不可见）。
