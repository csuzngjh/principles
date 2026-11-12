---
"principles-disciple": patch
"@principles/core": patch
---

实验实例隔离与证据可信度整改：

- P0-1 实验环境隔离改为 fail-fast：启动器显式覆盖继承的 `PD_WORKSPACE_DIR` / `OPENCLAW_WORKSPACE` / `OPENCLAW_WORKSPACE_DIR` 并固定 `OPENCLAW_STATE_DIR`、`OPENCLAW_CONFIG_PATH`、`OPENCLAW_PROFILE`、`XDG_CACHE_HOME`、`PD_EXPERIMENT_ROOT`；workspace 越出实验根或落在生产目录时拒绝启动。`PD_EXPERIMENT_ROOT` 存在时 hook / command resolver 与 AutoConsumer 对越界 workspace 直接失败，不再只记 warning 后写入生产 `state.db` / `trajectory.db`。生产实例行为不变。
- P0-2 实验模式 owner identity 落在 `<PD_EXPERIMENT_ROOT>/.pd/owner.json`；环境变量身份生效时不再读取生产 `owner.json`。
- P1-1 / P1-2 证据链不再把 task-only 记录硬编码为 `manual`，`#/pain` 展示真实来源、原始纠正文本与逐字 Assistant 输出。
- P1-3 diag_router 重试回喂上一次校验错误（按尝试新鲜度门控），Console 失败任务展示失败阶段、错误类型、最近错误、尝试次数、重试预算与下一步建议。
