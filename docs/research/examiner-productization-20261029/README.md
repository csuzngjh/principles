最新后继：见 ../EXAMINER-v4-OFFLINE-ACCEPTANCE.md 与 ../EXAMINER-v4-HUMAN-REVIEW.md；v4 盲审包已准备，正式人工审核 PENDING。以下是原始审计时点记录，历史结论和日志保留，不代表当前实现状态。

# Examiner 产品化审计派生证据 · 2026-10-29

状态：`OFFLINE_AUDIT_ONLY_NOT_AUTHORIZED`。本目录不是新研究的正式题集、Gold 或授权；原研究仍是权威。完整说明见上级 EXAMINER-PRODUCTIZATION-AUDIT-2026-10-29.md。

文件来自只读原资产审计和现有离线工具/测试，不代表真实 Examiner、真实宿主实验或独立人审通过。

| 文件 | SHA-256（原始文件字节） | 用途 |
|---|---|---|
| baseline-freeze-verification.json | 2ccda4e0e664647b00c5a94fde97b99579eb9b14980a6d3aa163858abe2157b1 | 三研究冻结 hash、59 文件 hash 快照 |
| gold-audit-offline.json | d613a1715d838be92814f6375d80b4a28b63bb774eb22171ef41f3c2ff4865a5 | 逐运行诊断、历史 byte equality、四次现有 scorer 反例 |
| examiner-vitest.txt | 3ca2c602c10081d003381369f887e3aabed6af3131fe13727fe73c729d9fccd7 | 未修改的原始日志；372通过、2失败、0跳过 |

复核冻结使用仓库现有 freeze-challenge-study.mjs --study <ID> --verify，以及 challenge-runner.mjs 导出的 verifyFrozenStudy(studyDir)、verifyArmConfigsFrozen(studyDir)。只调用 verify，不调用生成/冻结写入分支。studyId 为 CEB-001/CEB-002/CEB-003-P。

复核统计从 gold-audit-offline.json 的 studies.<ID>.runs 逐项检查，并按其中原始 source 路径回读研究文件、校验其 SHA-256；replay 列出四次内存动作、runState 与 adjudication，可用原 env/scorer 重演。该 JSON 中的 networkRequests=0/productionWrites=0 是本诊断活动声明，不是对历史真实探针请求数的裁定；历史探针实际发出请求数仍为 0–5 不可证。

本目录不包含任何可用授权或模型凭据。所有新版本评分与 EXM-MVP-001 实现仍待设计批准。
