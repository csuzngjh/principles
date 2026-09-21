# 发布流程

[English](RELEASE_PROCESS.md) | [中文](RELEASE_PROCESS_ZH.md)

---

## 🌟 最重要的段话（PRI-874 + Changesets 切换）

产品只有**一个版本**：根目录 `package.json` 的 `version` 字段。它是唯一权威，
`scripts/resolve-product-version.mjs` 为所有发布入口（npm 火车、签名频道、
安装器身份戳）读取它。各组件包版本（`@principles/*`、`principles-disciple`、
`create-principles-disciple`）是**诊断号**——永远不是产品版本。

组件版本现在有自己的权威（Changesets 切换，SPEC v1.2）：普通 PR 用
`.changeset/*.md` 声明发布意图；一个滚动的 **Version Packages PR** 把
版本/CHANGELOG/lockfile 落到 main；发布火车只分发**绑定该 PR 合并 SHA 的、
已提交的精确版本**。CI 里不再有任何"现场发明版本号"的路径。

### 组件发布现在如何工作

```
特性 PR  =  代码  +  .changeset/*.md（声明意图；缺意图会被守卫拦截）
        ↓  合并进 main
Version Packages PR（机器人，changesets/action）
        =  版本 + CHANGELOG + 内部依赖范围 + lockfile + 插件镜像
        ↓  Owner 审阅并合并        ← 唯一的版本落地路径
release cohort = 该合并 SHA
        ↓
发布火车（合并后自动派发；或每周对账窗口）
        =  checkout cohort SHA → 精确 name@version 查询 registry
           → 不存在则发布精确已提交版本；存在且身份匹配则跳过上传
        ↓  幂等收尾
tag vX.Y.Z（插件语义）/ GitHub Release / ClawHub
```

要点（由 `scripts/release/*` 守卫与测试强制）：

- **发布意图权威** = 仅 `.changeset/*.md`。不再猜测 commit message、没有手动
  bump 输入、没有"重置到 registry 再 bump"。旧路径已随切换删除，无遗留回退。
- **版本落地** = 仅 Version Packages PR。普通 PR 不得修改任何
  `packages/*/package.json` 的 `version` 字段。
- **Release cohort** = Version PR 合并 SHA。重试与每周窗口都从该 SHA 构建；
  之后 main 的新变化不会泄漏进已规划的发布。
- **精确版本发布** = 按精确 `name@version` 查询 registry：不存在 → 发布；
  存在且来源匹配（gitHead = cohort SHA）→ 跳过上传并补齐收尾；冲突 /
  落后 registry / registry 故障 → 大声失败。
- **C4 产品组装** = 插件进入最终发布计划（直接或随 core 变更）就必须有安装器
  发布；pd-console 变更必须有安装器发布。守卫只报错，从不替你发明缺失版本。

### 产品版本如何推进（不变，PRI-874）

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
  根版本没有自动 bump——产品版本是 Owner 决策。Version Packages PR 也永远
  不会碰它（包含性是它契约的一部分）。
- **该提交必须落到 main 上**。只存在于特性分支的版本推进不算数（`79226910`，
  PRI-849：权威停在 1.76.1，而线上频道已推进到 2.1.0 一整天）。

---

## 🤖 为 AI 准备的发布摘要

### 我的改动需要 changeset 吗？

问自己：**它影响任何可发布产物吗？**（bug 修复、运行时行为、公共 API、依赖
契约、向后兼容新能力、破坏性变更、产物内容——对七个可发布包中的任何一个，
包括随它们一起交付的私有代码改动，例如 pd-console → `create-principles-disciple`
patch。）

- 需要 → 添加 `.changeset/<slug>.md`，写诚实的 bump（`patch`/`minor`/`major`）
  与说明"改了什么、为什么需要发布"的摘要（"fix"/"update"/"misc" 会被评审拒绝）。
- 纯文档/测试/fixture，却被保守路径规则命中？→ 添加**空 changeset**
  （`---\n---\n` + 一行理由）——这是官方的"明确无需发布"声明，不是豁免。
- 插件发布必须在同一 PR 里带安装器 changeset（C4）。

永远不要：手改所有包版本、从 tag 或组件版本推导产品版本、为"看起来对齐"而改
runtime pin、或"因为一起发布就让版本相同"。

### 发布触发

- **Cohort 合并**：合并 Version Packages PR 会自动派发绑定该合并 SHA 的发布
  火车（`version-packages.yml`）。
- **恢复 / 手动**：Actions → Publish to npm → Run，可指定 `cohort_sha`
  （留空 = 自动探测最新 cohort）。
- **每周窗口**（周五 04:00 UTC）：只做对账——补齐待发布 cohort 与未完成收尾；
  永不制造版本；无 cohort → 成功空跑。

Version PR 机器人（`changesets/action`，已锁版本）**必须**配置
`PD_VERSION_PR_TOKEN` secret（细粒度 PAT：contents:write +
pull-requests:write）。未配置时工作流会**跳过 Version PR 创建**并输出
配置指引警告——本仓库根本不允许 GITHUB_TOKEN 创建 PR（切换后首跑实测），
即便允许，其 PR 也不会触发必需检查 "Verify Merge Gate"（GitHub 抑制
递归触发）。

### 三道硬门（时序按发布入口不同——切换未改变）

1. **单调**——在该入口首次发布之前；查询远程频道指针；低于即拒绝，相等允许。
2. **盖章**——安装器包发布时：tarball 携带 `_release/product-identity.json`
   （火车产品版本 + cohort SHA）。
3. **安装时**——安装器在目标机任何变更之前校验 payload 身份。

### 组件镜像（Version PR 范围）

- `packages/openclaw-plugin/openclaw.plugin.json`——由 Version PR 物化同步到
  插件版本（唯一批准的镜像）。
- `README.md` / `README_ZH.md` 徽章——不再由任何流程自动同步；需要时在发布
  说明 PR 里手动更新（外观项，非权威）。
- 根 `package.json` / runtime pins——永远不碰（包含性）。

---

## 🛠️ 极客与开发者日志

### 本地操作

```bash
# 查看三个版本面（产品 = 根 manifest）
node scripts/resolve-product-version.mjs          # 产品版本
npm view principles-disciple version              # 插件流（诊断）
npm view create-principles-disciple version       # 安装器流（诊断）

# 守卫自检（CI 在每个 PR / 发布上跑的就是这些）
node scripts/release/check-pr-release-intent.mjs  # PR 意图守卫（需 PR_BASE_SHA，否则回退）
node scripts/release/check-release-plan.mjs       # 最终计划 C4 守卫
node scripts/release/registry-exact.mjs <pkg> <精确版本> --expect-git-head <sha> --json
node scripts/release/resolve-release-cohort.mjs   # 火车会发布什么

# 一次性迁移取证工具（只读；不是运行时权威）
node scripts/release/snapshot-registry-baseline.mjs --out docs/release/<日期>.json
```

> `scripts/release.sh` 已停用（PRI-874）。`./scripts/sync-version.sh` 由
> Version PR 镜像同步取代（仅保留为本地诊断）。

### 故障排除

| 问题 | 解决 |
|------|------|
| CI：`N-3 ... without a changeset` | 添加声明该包的 `.changeset/*.md`（确实无需发布则加空 changeset） |
| CI：`C4 ... requires create-principles-disciple` | 补安装器 changeset——守卫不会替你发明 |
| CI：`N-version ... version field in a normal PR` | 撤掉手改；版本只经 Version Packages PR 落地 |
| 发布：`LOCAL_BEHIND_REGISTRY` | main 落后于 registry（上面有计划外版本）——先对齐基线再发布 |
| 发布：`PRESENT_CONFLICT` | 同名同版本已存在但来源不同——先调查，绝不覆盖 |
| 部分失败后重跑火车 | 直接重跑：npm 跳过已验证存在的版本，tag/release/ClawHub 幂等补齐 |
| Version PR 没有检查 / 无法合并 | 缺 `PD_VERSION_PR_TOKEN` secret——见上"发布触发" |
| 安装器拒绝："no embedded product identity" | 该 payload 不是火车/资产构建产物——安装带戳的 payload |

### 必要配置

1. [npmjs.com → Access Tokens](https://www.npmjs.com/settings/tokens)
2. 创建 "Automation" token
3. GitHub → Secrets → `NPM_TOKEN`
4. （Version PR 检查）GitHub → Secrets → `PD_VERSION_PR_TOKEN`——细粒度 PAT，contents:write + pull-requests:write
