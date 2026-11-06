---
"@principles/host-runtime": patch
---

PRI-1114 修复：单会话分类查询（纠正/任务结果/弱候选）被每会话行上限截断时，截断状态现在传播到全局覆盖判定。
以前目标 run 的记录恰好落在截断之后时，会返回空列表且 `coverage.complete=true`；现在降级为 `complete=false` 并给出 `session_rows_truncated`，计数按“下界”处理。
读取预算未放宽，仍未新增表或写入路径。
