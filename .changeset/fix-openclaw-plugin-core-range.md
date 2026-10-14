---
'principles-disciple': patch
'create-principles-disciple': patch
---

fix(release): 把 openclaw-plugin 的 `@principles/core` 依赖范围对齐到一个**已发布**版本。

## 问题

`packages/openclaw-plugin/package.json` 声明 `"@principles/core": "^1.291.6"`，
但 **1.291.6 从未发布到 npm**（registry 上 `@principles/core` 的 latest 仍是 1.291.5）。

该范围由上一个 Version PR（#2015）的 changesets「Updated dependencies」机制自动写入，
而那次发布从未执行，范围就此悬空。一旦某个 Version PR 把 core 继续 bump（例如 1.291.7），
`^1.291.6` 的下界就不再等于 workspace 版本，`decidePending()` 判为 `broken`，
`packages/openclaw-plugin/tests/package/published-host-runtime-bundle.test.ts`
（以及 `test:host-runtime-parity`）随即抛错：

```
@principles/core@^1.291.6 resolves to nothing on the registry and is not a
changesets-materialized version of this workspace (1.291.7) — a genuinely
unresolvable publish range.
```

## 修法

把范围改为 `^1.291.5`——registry 上真实存在的版本，于是 `decidePending()` 走
`published` 分支：套件**真实运行**（而非因 pending 窗口被跳过），实际完成
`npm pack` → 隔离安装 → import bundle 的完整发布契约验证。

这不是降低需求：`^1.291.6` 本就是 changeset 自动生成的，不代表 plugin 的真实最低
core 版本。合并后 changesets 会在下一个 Version PR 中把该范围自动对齐到 core 的新版本。

## 附带影响

`package-lock.json` 同步更新。

> 注：1.291.6 / 2.1.2 这两个已 materialize 但未发布的版本仍悬在发布流程上，
> 需要单独补发布或由 release train 处理——不在本 changeset 范围内。
