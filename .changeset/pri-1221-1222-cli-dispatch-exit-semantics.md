---
"@principles/pd-cli": patch
---

修复两处 CLI 语义缺陷（PRI-1221 / PRI-1222）：

- `runtime internalization run-once` 省略 `--runner` 时不再只派发 dreamer，而是自动发现并执行任意 runner kind 的下一个就绪任务（dreamer/philosopher/scribe/…）。手动驱动 formation 链不再在 dreamer 完成后卡死（philosopher/scribe 就绪任务此前被单 kind 过滤屏蔽）。显式 `--runner` 行为完全不变；自动消费者始终显式传 `--runner`，不受影响。当显式 `--runner` 过滤掉其它 kind 的就绪任务（`filtered_out`）时，输出携带明示的 nextAction。
- `diagnose run` 的 `--json` 输出新增顶层 `diagnosisSucceeded` 布尔字段（成功与失败路径均携带），与候选 intake 状态解耦。诊断成功但候选被 admission gate 拒绝是合法终态（仍 exit 1），现在可与真正的诊断链失败区分。退出码保持不变（向后兼容），三态退出码语义写入命令帮助与代码注释。