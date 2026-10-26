---
"create-principles-disciple": patch
---

PRI-1046：Codex 插件的 `$pd-control setup` 不再凭 npm 退出码认领 runtime pin——装完必须读 `runtime/node_modules` 里三个包 manifest 的真实版本并与 `runtime-version.json` 逐一比对，不一致就结构化失败；marker 只在字节核对通过后写，撒谎的 marker 会触发重装而不是永久短路；精确 pin 的安装不再带 `--prefer-offline`（陈旧 cache 会让 npm 静默丢掉精确版本却仍 exit 0）。
