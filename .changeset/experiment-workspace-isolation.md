---
"principles-disciple": patch
---

实验实例 workspace 隔离改为 fail-fast：启动器显式覆盖继承的 `PD_WORKSPACE_DIR` / `OPENCLAW_WORKSPACE` / `OPENCLAW_WORKSPACE_DIR` 并清除 `PD_STATE_DIR`，workspace 越出实验根或落在生产目录时拒绝启动；`PD_EXPERIMENT_ROOT` 存在时 hook / command resolver 对越界 workspace 直接失败，不再只记 warning 后写入生产 `state.db` / `trajectory.db`。生产实例行为不变。
