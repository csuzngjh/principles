---
'create-principles-disciple': patch
---

修复 Codex 更新链的合并后评审发现（#2505 后续加固）：

- `reconcileInstalledPlugin` 在 `codex plugin add` 刷新成功后，复核载荷 pin 是否真的追上本次发布的 canonical 运行时。当 Marketplace 源 checkout 自身落后时（刷新"成功"但载荷原地不动），不再返回 success/updated（旧语义会打出 "payload refreshed 0.3.19 → 0.3.19" 的误导性成功），而是 fail-loud 报 `manualActionRequired`，下一步指向"先更新源 checkout（git pull），再重跑安装器"。
