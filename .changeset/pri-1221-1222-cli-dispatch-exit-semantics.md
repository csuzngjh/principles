---
"@principles/pd-cli": patch
"@principles/core": minor
---

修复两处 CLI 语义缺陷（PRI-1221 / PRI-1222）：

- `runtime internalization run-once` 省略 `--runner` 时不再只派发 dreamer，而是按 formation 顺序（dreamer→philosopher→scribe→…）逐 kind 只读探测，自动发现并执行下一个就绪的 peer 任务。手动驱动 formation 链不再在 dreamer 完成后卡死（philosopher/scribe 就绪任务此前被单 kind 过滤屏蔽）。探测仅覆盖本 CLI 可派发的 peer kind，不会选中 run-once 无法执行的 diagnostician 阶段任务（diag_rootcause/distiller/router）而空转遮蔽就绪任务。显式 `--runner` 行为完全不变；自动消费者始终显式传 `--runner`，不受影响。仅当显式 `--runner` 过滤掉其它 kind 的候选（`filtered_out`）时，输出携带明示的 nextAction。
- `diagnose run` 的 `--json` 输出新增顶层 `diagnosisSucceeded` 布尔字段（成功、失败与执行异常三类诊断终态均携带），与候选 intake 状态解耦。诊断成功但候选被 admission gate 拒绝是合法终态（仍 exit 1），现在可与真正的诊断链失败区分。退出码保持不变（向后兼容），三态退出码语义写入命令帮助与代码注释。

评审收敛（CodeRabbit 两轮）：

- `diagnosisSucceeded` 改为"观察态"语义：诊断链成功后的后处理异常（候选读取/intake/种子）不再把它覆写为 false，异常终态如实上报（`status` 仍为 `failed`、仍 exit 1）。
- run-once 自动发现升级为候选级排除：`InternalizationOrchestrator.wakeOnce` 新增可选 `options.skipCandidate` 谓词（additive），探测与派发两次 wake 传入同一过滤器——本 CLI 不可执行的 Code Rule（非 prompt 通道）Artificer 候选不再遮蔽同 kind 后面的可执行任务；全部候选被排除时 `no_ready_tasks.reason` 新增 `all_skipped_by_caller`（stderr 同步可观察）。未传过滤器的调用方（显式 `--runner`、自动消费者）行为逐字节不变。
- intake 失败提示/退出码说明区分"admission gate 拒绝（合法终态）"与"intakeService 存储故障"；`exit 1 + diagnosisSucceeded:true` 的说明覆盖两种形态（intake 失败见 `intake.candidates[].error`；后处理异常见 `message` + `errorCategory`）。