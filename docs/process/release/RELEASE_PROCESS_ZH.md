# 发布流程

[English](RELEASE_PROCESS.md) | [中文](RELEASE_PROCESS_ZH.md)

---

## 🌟 最重要的段话（PRI-874）

产品只有**一个版本**：根目录 `package.json` 的 `version` 字段。它是唯一权威，
`scripts/resolve-product-version.mjs` 为所有发布入口（npm 火车、签名频道、
安装器身份戳）读取它。各组件包版本（`@principles/*`、`principles-disciple`、
`create-principles-disciple`）是**诊断号**——永远不是产品版本，PRI-874 之后
所有可能把组件号当产品号的路径已全部移除或加守卫。

### 产品版本如何推进

```
main 上的显式版本推进提交（根 package.json + lockfile）
        ↓  （守卫：发布运行若低于线上频道版本即拒绝）
npm 火车 / 签名发布工作流读根 manifest
        ↓
安装器 payload 携带身份戳（_release/product-identity.json）
        ↓
安装后的运行时如实上报该身份
```

- **推进产品版本** = 一个改根 `package.json` **与根 lockfile** 的显式 PR。
  根版本没有自动 bump——产品版本是 Owner 决策；
  [product-version-drift](../../.github/workflows/product-version-drift.yml)
  监视器会在"已发布版本从未落回 main"时报红。
- **该提交必须落到 main 上**。只存在于特性分支的版本推进不算数——而且此前没有
  任何机制会发现：`79226910`（`align product version to 2.1.0`，PRI-849）是在该
  分支的 PR **已经合并之后**才提交到 `ai/PRI-854-option-a` 的，因此从未进入 main：
  仓库权威停在 `1.76.1`，而线上频道已推进到 `2.1.0`。同一个单行改动只能作为版本
  治理工作的显式推进提交重新落地。这正是本监视器现在会报红的那类漂移。
- **组件版本**只在发布 CI 内推进（仅推 tag；不回写 main）。

---

## 🤖 为 AI 准备的发布摘要

### 发布触发

- **自动**：push/合并到 `main` 触发 npm 火车（`.github/workflows/publish-npm.yml`）。
  火车从根 manifest 解析产品身份；**若低于线上频道指针的版本会直接拒绝发布**。
- **手动**：Actions → Publish to npm → Run（`package` 输入），或签名发布工作流
  （`release-metadata.yml`，`product_version: auto`）。

### 三道硬门（都在任何发布副作用之前）

1. **盖章**：安装器 payload 打上解析出的身份（`_release/product-identity.json`）；
   校验对象是**打出来的 tarball**，不是工作目录。
2. **单调**：解析出的产品版本必须 `>=` 线频道的 `productVersion`
   （相等 = 同版本重发布，计数器递增）。更低即拒绝——永不发布降级。
3. **安装时**：安装器拒绝任何没有内嵌身份戳的 payload
   （`resolveInstallerPayloadIdentity` fail-closed）。

### 版本同步范围（发布 CI 内、仅 runner 本地——不回写 main）

- `packages/openclaw-plugin/openclaw.plugin.json`（组件面）
- `README.md` / `README_ZH.md` 徽章
- **不含**根目录 `package.json`——产品权威只经显式提交推进。

---

## 🛠️ 极客与开发者日志

### 本地操作

```bash
# 查看三个版本面（产品 = 根 manifest）
node scripts/resolve-product-version.mjs          # 产品版本
npm view principles-disciple version              # 产品/插件流（诊断）
npm view create-principles-disciple version       # 安装器流（诊断）

# 组件版本同步（不触碰根 manifest）
./scripts/sync-version.sh           # 从 tag
./scripts/sync-version.sh 1.5.6     # 指定
```

> `scripts/release.sh` 已停用（PRI-874）：它从组件版本推导发布、绕过上述全部守卫。

### 故障排除

| 问题 | 解决 |
|------|------|
| 发布拒绝："LOWER than the live channel pointer" | 先在 main 上推进根 `package.json`（显式提交） |
| 安装器拒绝："no embedded product identity" | 该 payload 不是火车/资产构建产物——安装带戳的 payload |
| 漂移监视器报红：main < 频道 | 已发布版本没落回 main——落实版本推进提交 |
| 漂移监视器提示：main > 频道 | 正常的待发布状态（版本已推进、发布未发出） |

### 必要配置

1. [npmjs.com → Access Tokens](https://www.npmjs.com/settings/tokens)
2. 创建 "Automation" token
3. GitHub → Secrets → `NPM_TOKEN`
