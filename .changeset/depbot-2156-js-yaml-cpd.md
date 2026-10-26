---
"create-principles-disciple": patch
---

chore(deps): bump js-yaml 5.4.3 -> 5.5.0（#2156，连带 argparse 2.0.1 -> 3.0.3；create-principles-disciple 的运行时 dependency，安装器读 YAML 配置随 installer 工件分发）。本 PR 只调和 `packages/create-principles-disciple/package-lock.json`，`package.json` 的 range `^5.4.3` 未变；各组件 staged release-lock 里的 js-yaml 已是 5.5.0，无需重新生成。
