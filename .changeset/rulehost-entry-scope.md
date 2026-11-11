---
'@principles/core': patch
'@principles/host-runtime': patch
'principles-disciple': patch
'create-principles-disciple': patch
---

RuleHost 门恢复入口路由契约：只有 `write` / `execute` / `agent` 家族、且能提取到非空目标路径的调用才进入规则评估；`read` / `search` 及其它类型、以及无路径调用直接放行，RuleCode 引擎零调用。

同时修掉 `normalizedPath === null` 永远不成立的死分支——无路径时 `normalizePathPure` 返回 `""`，此前被当成"有路径"进入评估。
