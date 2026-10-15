---
---

fix(release): PRI-979 后续——签名频道链 `release-metadata.yml` 的依赖优先构建镜像补上 `@principles/workbuddy-adapter`。
它照抄了发布火车的构建顺序却没跟着加新包，dry-run run 38675317722 因此在 `@principles/pd-cli` 的 tsc 处 TS2307 失败。
同批把 drill 8 守卫扩到这条镜像（集合由包清单反推），并把 runbook 的"接三处"更正为守卫实际强制的全部接缝。
变更只在 GitHub Actions 控制面与测试/文档内，不随任何 npm 工件分发，故显式 no-release。
