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
release cohort = 该落地提交 SHA（merge / squash 皆可——身份是「复现」，不是提交形态）
        ↓
发布火车（合并后自动派发；或每日对账窗口）
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
- **Release cohort** = Version PR 落地提交 SHA（merge / squash 皆可，身份是
  对第一父提交的复现，不是提交形态）。重试与每日窗口都从该 SHA 构建；
  之后 main 的新变化不会泄漏进已规划的发布。
- **精确版本发布** = 按精确 `name@version` 查询 registry：不存在 → 发布；
  存在且来源匹配（gitHead = cohort SHA）→ 跳过上传并补齐收尾；冲突 /
  落后 registry / registry 故障 → 大声失败。
- **C4 产品组装** = 插件进入最终发布计划（直接或随 core 变更）就必须有安装器
  发布；pd-console 变更必须有安装器发布——除非该 PR 带官方空 changeset 显式
  声明不发布（保守路径命中，与 N-3 同一豁免语义；由计划触发的边永不豁免）。
  守卫只报错，从不替你发明缺失版本。

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

- **Cohort 合并**：合并 Version Packages PR 会自动派发绑定该落地 SHA 的发布
  火车（`version-packages.yml`；merge / squash 皆由复现证明身份）。
- **恢复 / 手动**：Actions → Publish to npm → Run，可指定 `cohort_sha`
  （留空 = 自动探测最新 cohort）。
- **每日窗口**（04:00 UTC）：只做对账——补齐待发布 cohort 与未完成收尾；
  永不制造版本。无 cohort 且 registry 已含 main 上的全部精确版本 → 成功空跑；
  无 cohort 但 main 上有版本在 registry 缺失 → **断链告警**（exit 1 +
  `::error::`，PRI-922：squash 合并曾让整条 npm 链静默停摆）。PRI-986：窗口
  原为每周五，周一落地的 cohort 要等四天才能发布。
- **每日频道预演**（06:00 UTC，`release-metadata.yml`）：定时跑一次签名频道的
  全矩阵 **dry-run**，证明发布通路是活的而不发布任何东西。发布仍是人的决策：
  工作流对 schedule 事件拒绝 `mode=publish`；定时运行从线上频道指针推导
  `data_schema_forward_readable_from`，手动 dispatch 仍必须显式传入（盲填的
  默认值不是证据，PRI-853）。
- **签名频道产物发布**（`release-metadata.yml`，手动 `mode=publish`）：自
  PRI-1103 起，构建 commit **不再**取 dispatch 的 `ref`——工作流先问 registry：
  该产品版本实际由哪个 cohort 发出（`create-principles-disciple` 已发布
  manifest 的 `gitHead`），再构建那个 commit。于是「控制台更新通道」与「新装
  通道」不可能在同一版本号下携带不同字节。`ref` 只选发布工具链；`cohort_sha`
  是对「当前 npm `latest` 指向的提交」的显式身份断言（用于确定性重建、频道未
  变时的重复发布、同一 cohort 的密钥轮换/重签名），**不是**历史版本选择器：
  `latest` 一旦指向其他提交，旧 cohort 会被拒绝（`EXPLICIT_NOT_LATEST`），
  因为那会让控制台更新通道与新装通道代码身份不一致。`allow_version_drift`
  不改变 npm latest 的提交身份。若 npm 侧尚未发出该版本：publish 直接拒绝，
  预演带 `::warning::` 退回构建 ref。

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

### 组件镜像与 Codex 运行时 pin（Version PR 范围）

- `packages/openclaw-plugin/openclaw.plugin.json`——由 Version PR 物化同步到
  插件版本（唯一批准的镜像）。
- `plugins/principles-disciple/runtime-version.json` +
  `plugins/principles-disciple/.codex-plugin/plugin.json`——Codex 运行时 pin，
  由同一个 Version PR 从四个工作区版本物化（`@principles/codex-adapter`、
  `@principles/host-runtime`、`@principles/core`、`@principles/pd-mcp-server`）。
  pin 只接受精确三段版本（不允许范围或 `latest`）、禁止降级、四个组件必须齐全。
  pin 一旦变化，`.codex-plugin/plugin.json` 的 Codex 缓存版本必须在**同一个
  提交**里递增一个 patch——Codex 以该版本号作为已安装插件缓存的键，payload 变了
  却不升版本，已有安装永远收不到更新。
- `README.md` / `README_ZH.md` 徽章——不再由任何流程自动同步；需要时在发布
  说明 PR 里手动更新（外观项，非权威）。
- 根 `package.json`——永远不碰（包含性；产品版本面不是发布物料）。

#### 为什么把 Codex pin 移进 Version PR（Owner 决策，2026-11-11）

pin 以前由发布流水线完成后的独立“runtime pins 维护 PR”写入。这样能工作，但
代价是每次发版多一个 PR（评审 + CI + cohort 可见性等待），并且在发布完成到维护
PR 合并之间，`main` 与已发布插件对“插件 pin 的是哪个运行时”存在不一致窗口——
“插件已发布、却仍指向上一版运行时”恰好能藏在这个窗口里。

现在 pin 是 Version PR 的又一个确定性产物，与 `changeset version`、组件镜像并列。
`materialize-version-plan.mjs` 从它正在 bump 的同一个提交合成 pin，发布意图守卫
逐字节复现这次合成，因此手改 pin 与手改版本号一样会被 CI 拒绝。

**风险：pin 先落到 `main`，包稍后才在 npm 上出现。** 这是“pin 随 cohort 一起
发布”的固有风险，靠发布**顺序**而不是第二个 PR 控制：流水线先发布四个运行时包
与 `pd-mcp-server`，最后才发布内嵌 pin 的插件，因此可下载的插件版本永远不会
带着未发布的 pin。若流水线在插件腿之前失败，用户还拿不到这个 pin。

**失败兜底（绝不静默通过）：**

1. `codex-plugin-delivery-verify` 在 `publish-full-product` 之后运行，用该 cohort
   的 manifest 与 registry 双重核对已发布 pin（逐包精确身份，使用相同的传播
   预算，超时即硬失败），并重跑 `npm run check:runtime-pin`——按 pin 的精确版本
   安装已发布字节并做能力探针。
2. 不一致会让发布流水线变红，并指出具体包与实测等待时间，绝不降级为告警。
3. 修复方式是开一个正常的 Version Packages PR（pin 由工作区 manifest 重新生成）。
   `sync-codex-runtime-pins.mjs --cohort <sha>` 仍作为人工恢复路径保留，但它
   只写文件、不开 PR。

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
| CI：`C4 ... requires create-principles-disciple` | 补安装器 changeset——守卫不会替你发明；确属非发布内容（dev-config/测试）则改用官方空 changeset 显式声明不发布 |
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
