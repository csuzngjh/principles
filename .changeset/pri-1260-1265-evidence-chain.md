---
"@principles/core": patch
"@principles/host-runtime": patch
"@principles/pd-mcp-server": patch
"@principles/pd-cli": patch
"@principles/codex-adapter": patch
"@principles/workbuddy-adapter": patch
---

宿主反馈证据链四项修复：`pd_submit_pain` 接受宿主会话声明并按本工作区授权轨迹校验（PRI-1260，verified 才写 sessionIdHint 与回执关联，未验明保留 unbound 合同并回报具体原因）；Codex live/catch-up 采集复用正式 v3 授权判定，缺失/撤回/失败记录在读转录前拒绝（PRI-1262）；超限完整 JSONL 记录由 pipeline 扫描跳过并留可追踪处置，检查点前进、与未完成尾部区分（PRI-1261，Codex+WorkBuddy 生产边界）；授权轨迹读取器接入 pd diagnose/pain retry 与 Codex/WorkBuddy worker/auto-run（PRI-1265，会话两种拼写匹配、过期档不可见）。

评审轮整改（2026-11-18）：live 采集路径同样先过正式授权判定（撤回/缺失不再落 prompt）；超限跳过路径对 `compacted` 控制记录有界提取并应用 compaction（无法安全解析则不越过该记录）；轨迹读取只服务 `retention_class IN (operational, promoted)`、返回最新 N 条、精确 rollout_identity 优先（子代理原文不再混入父会话）、可选 host 隔离；会话校验排除 sentinel 值；过期行重放不再复活正文。
