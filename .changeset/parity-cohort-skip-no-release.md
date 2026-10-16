---
---

test(create-principles-disciple): registry-parity 双模测试接入 pre-publish cohort 跳过 —— 合并门禁恢复（附：发布意图显式 no-release）

本 PR 仅改 packages/create-principles-disciple/tests/ 下的一个测试文件并新增本空 changeset，按路径规则 release-intent 守卫保守命中 N-3。经实质核查判定为 genuinely non-release-affecting，故按 SPEC §10.2 以官方空 changeset 显式声明 no-release：

- 改动是给 #2047 引入的双模 registry-parity 测试接上仓库既有的 classifyPrePublishCohort 跳过通道（与同文件 npx parity 门完全同一分类器）：Version PR 窗口内 install-layout ^0.4.0 尚未上架，干净目录 registry 安装按构造必然 ETARGET，该形态被显式 admit 为 skip；其余任何失败（含 2026-09-04 缺陷形态）保持响亮失败。
- 无生产源码、无 dist 输出、无 schema/契约变化；installer 打包物内容零变化（tarball 由 src/ 构建，tests/ 不入包）。
- npm install 的 ETARGET 失败发生在外部 npm 进程，测试文件本身的类型/语法由 tsc --noEmit 与 lint 覆盖；skipped 分支在 Version PR #2050 的 CI 上即为其实景验证。
