---
'principles-disciple': patch
'create-principles-disciple': patch
---

恢复共享门拒绝路径上的原则回执文案（PRI-1184 / F4）。

- `principles-disciple`（patch）：共享生产门（`accountSharedDeny`）现在返回与 legacy hook 路径相同的 owner-facing block 结果，`principle_receipt_block_copy` 在共享路径重新有真实生产者；OpenClaw 适配层对 deny 保留插件返回的阻断结果（返回非 block 值时不会把 deny 降级为放行）。仅恢复既有回执文案，不新增判定分支、不改变 `allow` / `deny` 语义，故为 patch。
- `create-principles-disciple`（patch）：安装器打包 OpenClaw 插件载荷（C4 装配边）；无安装器侧逻辑改动，仅随载荷刷新版本。
