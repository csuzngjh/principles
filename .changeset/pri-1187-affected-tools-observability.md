---
'@principles/host-runtime': patch
---

PRI-1187：新增"只记录不改行为"的 `affectedTools` 偏差埋点。当规则声明不覆盖当前动作、但按安全门策略仍参与评估时，输出一条结构化事件（规则 id、声明工具/族、实际动作族、规则自身决策）；默认开启，可用构造项 `affectedToolsObservability.enabled=false` 或环境变量 `PD_AFFECTED_TOOLS_OBSERVABILITY=0` 关闭，sink 异常被吞掉，绝不影响判定。gate 顶部同时注明"规则不按声明过滤，声明只用于激活期校验"，并链接 proposals 文档。
