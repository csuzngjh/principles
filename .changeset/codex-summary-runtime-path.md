---
'create-principles-disciple': patch
---

修复 Install summary 中 Codex 恒显示 `runtime not verified` 的路径拼接缺陷（#2505 回归）。

`summarizeTouchedHosts` 用 `resolvePluginDataRoot()` 拿到的是 PLUGIN DATA 根目录，却直接交给
`readInstalledRuntimeCohort()` —— 该读取器会在传入目录下追加 `node_modules`，而 Codex 的运行时
实际位于 `<plugin-data>/runtime/node_modules`。因此即使本次安装已把 Codex 刷新到载荷 pin，
安装摘要仍打印 `runtime not verified`，误导 Owner 以为运行时没有装好。

修复方式：先按 `resolvePluginDataRoot()` 解析根目录，再追加 `runtime` 后读取；显式注入的
`codexRuntimeDir` 语义保持不变。新增回归测试走生产默认路径（仅设置 `CODEX_HOME`），修前失败、
修后通过。
