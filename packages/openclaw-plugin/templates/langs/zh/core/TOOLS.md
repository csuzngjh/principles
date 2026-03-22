# TOOLS.md - Routing
<!-- pd-core-guidance-version: pd-core-guidance-v2 -->

## Core Routing Rules

- `sessions_list`：查看运行中的同级会话。
- `sessions_send`：给已有同级会话发消息。
- `sessions_spawn`：新建或编排同级会话。
- `subagents`：查看已经派发的内部 worker 及其输出。
- `pd_run_worker`：启动内部 worker，例如 `diagnostician`、`explorer`。

## Guardrails

- 不要用 `sessions_list` 查询由 `pd_run_worker` 启动的内部 worker。
- 不要用 `pd_run_worker` 做同级代理通信。
- 看到 `diagnostician`、`explorer` 这类角色时，优先按内部 worker 处理，再用 `subagents` 验证。
