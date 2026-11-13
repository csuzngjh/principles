---
"create-principles-disciple": minor
---

新增 `repair-host-manifest` 命令：只删除有证据证明已不存在的 host 记录。

- 默认 dry-run，`--apply` 才写入；写入前把原 `install.json` 备份到 `~/.pd/backups/`，并在输出里给出恢复命令。
- 判定逐 host 进行：openclaw 以扩展目录是否仍存在为证据，workbuddy 以 `installed_plugins.json` 是否仍注册为证据；证据面不可读时记为 `undecidable` 并保留，绝不猜测。
- 未知 host id（更新版 installer 写入的）不参与判定，原样保留。
- 若删除后 host 记录会变空，拒绝写入并返回 `manifest_would_be_empty`，引导走官方安装器。
- 复用既有 `install.json` 作为唯一事实源，写回走 `writeInstallManifest`，保留 channel、workspaces 等既有字段。
