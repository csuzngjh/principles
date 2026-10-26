---
"create-principles-disciple": patch
---

chore(deps): bump i18next 26.4.7 -> 26.5.6（#2159；@principles/pd-console 运行时 dependency，打进 console bundle 随 installer 工件分发）。Dependabot 只同步了 root workspace lock，`release-locks/console` 里仍钉 26.4.7，release staging 的 `npm ci --omit=dev` 会以 `Invalid: lock file's i18next@26.4.7 does not satisfy ^26.5.6` 失败（ERR-131/068 同族）；本 PR 把那条 staged lock 一起调和到 26.5.6。
