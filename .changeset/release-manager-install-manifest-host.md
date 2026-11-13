---
"create-principles-disciple": patch
---

更新链按 `~/.pd/install.json` 记录的 host 部署，不再默认 openclaw（PRI-1204）。

- `release-manager` 在产生任何副作用之前解析部署目标：优先使用调用方显式传入的 host，否则读取安装器自己维护的 `install.json`。
- 只选一个目标即可，安装器自身的升级计划会在同一次运行里刷新其它已安装 host。
- 没有 manifest 字段的旧记录保持历史行为（openclaw），因为不存在可反驳的记载；损坏或不可读的记录同样回落到历史行为，不新增猜测。
