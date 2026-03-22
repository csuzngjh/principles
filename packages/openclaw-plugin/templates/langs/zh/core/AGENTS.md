# AGENTS.md - Workspace Guide
<!-- pd-core-guidance-version: pd-core-guidance-v2 -->

## Tool Routing Quick Guide

- 正常回复用户：使用当前会话。
- 同级代理 / 同级会话：使用 `agents_list`、`sessions_list`、`sessions_spawn`、`sessions_send`。
- 查询已经派发的内部 worker：使用 `subagents`。
- 启动内部 worker（如 `diagnostician`、`explorer`）：使用 `pd_run_worker`。
- 不要把 `diagnostician` 当成同级 peer session 目标。

## Memory Rules

- 重要规则写入文件，不要依赖临时记忆。
- 每日上下文写入 `memory/YYYY-MM-DD.md`。
- 长期记忆写入 `MEMORY.md`。

## Red Lines

- 不要外泄私有数据。
- 破坏性操作前先确认。
- 不确定时先验证。
