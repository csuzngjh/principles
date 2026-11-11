---
'@principles/pd-cli': patch
---

修复官方安装器产出的 bundled 安装被永久判定为 `degraded`：`canonical-runtime` 不再要求 `~/.pd/releases/<id>/metadata.json`（该文件只由签名通道更新写入），改为校验 `bundled-<productVersion>-<digest[:12]>` 与 active 记录内部自洽（版本非空、digest 为 64-hex）。自洽即 `healthy`，不自洽为 `corrupt`；签名通道安装缺元数据仍为 `degraded`，判定未放宽。
