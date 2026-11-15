---
"@principles/pd-cli": patch
---

修复两处 CLI 语义缺陷（PRI-1221 / PRI-1222）：

- `runtime internalization run-once` 省略 `--runner` 时不再只派发 dreamer，而是按 formation 顺序（dreamer→philosopher→scribe→…）逐 kind 只读探测，自动发现并执行下一个就绪的 peer 任务。手动驱动 formation 链不再在 dreamer 完成后卡死（philosopher/scribe 就绪任务此前被单 kind 过滤屏蔽）。探测仅覆盖本 CLI 可派发的 peer kind，不会选中 run-once 无法执行的 diagnostician 阶段任务（diag_rootcause/distiller/router）而空转遮蔽就绪任务。显式 `--runner` 行为完全不变；自动消费者始终显式传 `--runner`，不受影响。仅当显式 `--runner` 过滤掉其它 kind 的候选（`filtered_out`）时，输出携带明示的 nextAction。
- `diagnose run` 的 `--json` 输出新增顶层 `diagnosisSucceeded` 布尔字段（成功、失败与执行异常三类诊断终态均携带），与候选 intake 状态解耦。诊断成功但候选被 admission gate 拒绝是合法终态（仍 exit 1），现在可与真正的诊断链失败区分。退出码保持不变（向后兼容），三态退出码语义写入命令帮助与代码注释。