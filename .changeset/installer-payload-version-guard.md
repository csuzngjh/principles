---
'create-principles-disciple': patch
---

修复发布包内 `pd-cli` 版本被降级打包（v3.2.1 / cohort `8851a3be8`）。

- 安装器 leg 的 `PD_BUNDLE_PRESERVE_SOURCE_VERSIONS=1` 原先写在不会执行 bundle 的构建步骤里，步骤级环境不会传递到后续 pack 步骤的 `prepack` 生命周期，导致 bundle 走“对齐 registry latest”分支，把 `pd-cli` 2.2.0 改写成 2.1.0。
- preserve 开关改到真正执行 `npm pack` / `prepack` 的步骤（`Pack and verify immutable candidate`）。
- bundle 默认分支不再允许任何组件版本回退：registry `latest` 比源版本旧时保留源版本并告警，而不是静默降级。
- `prepare-npm-candidate.mjs` 新增 fail-closed 断言：安装器 tarball 内 `pd-cli`、`core`、`host-runtime`、`codex-adapter`、插件本体的 `package.json` 版本必须等于 cohort 提交里的版本，不一致或缺失即在该 leg 失败。
