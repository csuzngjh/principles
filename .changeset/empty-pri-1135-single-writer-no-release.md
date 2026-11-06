---
---

PRI-1104 Stage 1 (PR-2 / PRI-1135): 内部 schema 治理收敛，无用户可见行为变化，明确声明 no-release。

- `TRAJECTORY_REQUIRED_COLUMNS` 从 DDL owner（core）导出，host-runtime 不再持有第二份手写列清单；新增清单 vs 真实 PRAGMA 的漂移守门。
- `convergeTrajectorySchemaVersion` 成为 schema_version 行的唯一写者；openclaw-plugin 两处生命周期入口改为委托，删除重复的 INSERT/UPDATE。
- 四条裸打开路径的版本收敛由真实文件库 round-trip 测试覆盖；补 T4 v1/v2 characterization 与 T5 负向控制。
