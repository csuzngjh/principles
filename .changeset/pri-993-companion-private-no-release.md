---
---

仅改私有包 `packages/pd-companion`（`"private": true`）的运行时行为，不进入任何发布物，显式声明非发布相关。

PRI-993：Companion 工作区路径存在性判定从"清单读取处 statSync 过滤（stat 失败一律视为已删除）"改为"registry 按 tick 确认窗口判定"（ENOENT 连续 10 个窗口才确认删除并停止，其余 stat 失败保持运行并升级告警）。消费方（两个 registry 构造点）都在同一包内，无跨包契约变化、无导出变化、无 schema 变化。
