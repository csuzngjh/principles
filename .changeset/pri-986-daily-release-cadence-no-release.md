---
---

chore(release): PRI-986 发版节奏日更——npm 对账窗口改为每日 + 签名频道每日 dry-run 预演（publish 保留人工）

- `publish-npm.yml`：对账 cron 从每周五 04:00 UTC 改为每日 04:00 UTC（原窗口让周一落地的 cohort 等四天）；只补发已提交版本，仍不制造版本。
- `release-metadata.yml`：新增每日 06:00 UTC 的全矩阵 dry-run 预演，并显式拒绝 schedule 事件下的 `mode=publish`；定时运行的 `data_schema_forward_readable_from` 从线上频道指针推导，手动 dispatch 缺失仍大声失败（PRI-853）。
- 节奏断言从解析后的 cron 派生（day-of-week = `*`），不再手抄 cron 字面量（PRI-979 seam 6）：`scripts/__tests__/release-workflows.test.ts` 与 `packages/create-principles-disciple/tests/release-target-matrix.test.ts` 两处各抄了一份，后者在改 cron 后直接把 verify:merge 跑红，正是这类复制的代价。

变更只在 GitHub Actions 控制面与测试/文档内，不随任何 npm 工件分发，故显式 no-release。
