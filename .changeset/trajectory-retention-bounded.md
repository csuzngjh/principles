---
"@principles/core": minor
"@principles/host-runtime": minor
"@principles/pd-cli": minor
"principles-disciple": minor
---

轨迹库有界保留与在线瘦身（SPEC-PD-TR-001）：

- 新增 `trajectoryRetention` 配置（默认 `enabled: true`，90 天 / 6 小时 / 每批 2000 行 / 单轮 3000 ms），按批删除严格早于 cutoff 的行，每批独立提交。
- cutoff 每轮最多前进 7 天；marker 缺失或损坏时以库内最早记录为基线；**窗口外的 `lastCutoff`（未来时间或比当前窗口更靠近 now）一律归一化为 `null`**，不会删掉保留窗口内的数据。
- 每批删除前把拟删集合写入 `.state/exports/trajectory-retention-<date>.jsonl`；写失败则该批不删（fail closed）。
- 常规轮次只做只读索引存在性检查，缺索引时记录 `index_missing` 并去重告警；`CREATE INDEX` 只在显式的 `pd trajectory vacuum --yes` 执行，不再让 DDL 卡住宿主。
- 新增 CLI：`pd trajectory maintain | retention status | vacuum`；`maintain` 仅在"该删而没删"时返回非 0。
- `sessions` 本版不删除，只保留 50,000 行 tripwire。
