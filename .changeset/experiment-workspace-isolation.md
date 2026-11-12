---
"principles-disciple": patch
"@principles/core": patch
"@principles/pd-cli": patch
---

实验实例隔离与证据可信度整改：

- P0-1 实验环境隔离改为 fail-fast：启动器显式覆盖继承的 `PD_WORKSPACE_DIR` / `OPENCLAW_WORKSPACE` / `OPENCLAW_WORKSPACE_DIR` 并固定 `OPENCLAW_STATE_DIR`、`OPENCLAW_CONFIG_PATH`、`OPENCLAW_PROFILE`、`XDG_CACHE_HOME`、`PD_EXPERIMENT_ROOT`；workspace 越出实验根或落在生产目录时拒绝启动。`PD_EXPERIMENT_ROOT` 存在时 hook / command resolver 与 AutoConsumer 对越界 workspace 直接失败，不再只记 warning 后写入生产 `state.db` / `trajectory.db`。生产实例行为不变。
- P0-2 实验模式 owner identity 落在 `<PD_EXPERIMENT_ROOT>/.pd/owner.json`；环境变量身份生效时不再读取生产 `owner.json`。
- P1-1 / P1-2 证据链不再把 task-only 记录硬编码为 `manual`，`#/pain` 展示真实来源、原始纠正文本与逐字 Assistant 输出。
- P1-3 diag_router 重试回喂上一次校验错误（按尝试新鲜度门控），Console 失败任务展示失败阶段、错误类型、最近错误、尝试次数、重试预算与下一步建议。
- P1-3 终态保留：预算耗尽不再用 `max_attempts_exceeded` 覆盖真实分类错误（如 `output_invalid`），终态原因单独记录在 `diagnosticJson.terminal_failure`；每次尝试的校验错误按尝试累积到 `validator_error_history`；父任务投影失败子任务的 `taskKind` / `errorCategory` / 最近校验错误。
- P1-3 契约纠正：`abstractedPrinciple` 保持结构可选（值来自 Stage B distiller，由 `DiagRouterRunner.postFetchTransform` 确定性注入），`DefaultDiagnosticianValidator` 仍作为非空最后一道闸；adapter 的语义化 union 报错会点名缺失字段。
