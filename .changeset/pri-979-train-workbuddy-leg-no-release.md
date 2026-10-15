---
---

fix(release): PRI-979 发布火车补齐 `@principles/workbuddy-adapter`——`TRAIN_ORDER`、第 5/8 npm 腿、预演腿、
构建映射各加一处，并把「未映射的 pkg_dir」从静默跳过改成显式失败；另加两条从包清单反推的守卫测试（覆盖面 + 真实清单静态契约）。
变更只在 GitHub Actions 控制面与 `scripts/release` 治理脚本内，不随任何 npm 工件分发，故显式 no-release。
