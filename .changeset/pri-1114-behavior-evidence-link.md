---
"@principles/host-runtime": minor
"@principles/pd-cli": minor
---

PRI-1114: 新增只读运行时行为证据关联读模型 `linkAdaptiveBehaviorEvidence`，以及 `pd activation link` 命令。
按 run 级归属连接注入机会、工具调用、纠正与任务输出，只复用既有 journal / EventLog / trajectory 读取路径，
不建表、不写库、不调用模型；缺证一律降级为 `unknown`，不推断送达先后或任务成功。
