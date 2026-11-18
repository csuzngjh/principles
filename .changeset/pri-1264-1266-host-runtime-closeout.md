---
"@principles/core": patch
"@principles/pd-cli": patch
"@principles/codex-adapter": patch
"create-principles-disciple": patch
---

宿主运行与诊断记录三项：父诊断运行记录实际执行 runtime 而非硬编码 openclaw（PRI-1266，历史行读取不变）；worker liveness 记录 lastCycleDriver，`pd codex worker --status` 区分 companion/manual 停滞原因并给出下一步，Companion 停滞转 Owner 通知+托盘，采集降级不阻塞领取钉为回归（PRI-1264）；`pd mcp probe` 对不可验证的同名注册不再拒绝握手（与 PR#2697 安装器姿态对齐，proven foreign 仍拒，PRI-1249 验收补口）。
