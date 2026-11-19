---
"@principles/core": patch
"@principles/pd-cli": patch
"@principles/codex-adapter": patch
"create-principles-disciple": patch
---

宿主运行与诊断记录三项：父诊断运行记录实际执行 runtime 而非硬编码 openclaw（PRI-1266，历史行读取不变）；worker liveness 记录 lastCycleDriver，`pd codex worker --status` 区分 companion/manual 停滞原因并给出下一步，Companion 停滞转 Owner 通知+托盘，采集降级不阻塞领取钉为回归（PRI-1264）；`pd mcp probe` 对不可验证的同名注册不再拒绝握手（与 PR#2697 安装器姿态对齐，proven foreign 仍拒，PRI-1249 验收补口）。

评审轮整改（2026-11-18）：不可验证注册降级为独立 warning、不再以 first-error 遮蔽后续层（版本不匹配等仍拒绝 probe 放行）；配置性暂停（host.codex 关闭）写入新鲜 paused 心跳，Companion 与 `pd codex worker --status` 不再将有意暂停误报为停滞；托盘新增"worker 周期停滞"持久分区（不复用重启耗尽文案，与 registry 降级去重）。
