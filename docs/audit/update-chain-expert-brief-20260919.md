# PD 更新链路问题简报（给外部专家）

日期：2026-09-19 ｜ 编制：zcode 会话 ｜ 关联单：PRI-847（运营执行，已附证据评论）、PRI-848（UX P2）、PRI-849（版本治理）、PRI-850（bootstrap 缺口，当前阻塞）

---

## 0. 一页摘要

PD（Principles Disciple）的 Console「检查更新/一键更新」功能 9/19 报错 "The installation is not ready for a signed release update."。

诊断与执行（已经 Owner 授权并当日完成）发现这是一条**多缺口叠加**的链路，而非单点故障：

| # | 缺口 | 状态 |
| --- | --- | --- |
| 1 | 供给面缺口：签名发布流水线只跑过 dry-run，全世界没有任何已发布签名版本；GitHub Pages 也未开通 | **已修复**（9/19 首次正式发布成功，channel 指针已上线） |
| 2 | 配置面缺口：本机 install.json 无更新源 URL、Console 进程无 env → 就绪门拒绝 `metadata_source_unconfigured` | **已修复**（URL 已持久登记，就绪门转绿） |
| 3 | **bootstrap 缺口（当前唯一阻塞）**：已装代码把缺失的 bootstrap 清单按 0.0.0 处理，发布的元数据要求 ≥1.0.0，而**全仓不存在 bootstrap.json 的写入方**，拒绝建议"跑安装器更新 bootstrap"不可执行 → apply-full 干净拒绝 `bootstrap_too_old` | **未修复**（PRI-850，需产品决策） |
| 4 | 版本号"四张皮"：本机出厂戳 1.74.1 / main 字段 1.74.1·1.76.1（冻结） / npm 产品包 2.0.0 / npm 安装器·core·cli 1.143.2·1.284.20·1.152.9 | **未修复**（PRI-849，治理问题） |
| 5 | UX：更新页只显示英文通用错误，吞掉 JSON 里已有的 reason/nextAction | 未修复（PRI-848，小改） |

已验证健康的部分：签名链（TUF root → timestamp/snapshot/targets → channel → release metadata）**全链验签通过**；下载与摘要校验通过；策略门 fail-safe（拒绝时零状态变更）。**专家要解的核心题 = #3 的产品语义与修复，以及 #4 的版本权威统一。**

---

## 1. 系统背景（专家速览）

PD 是一个 Owner 治理系统，装在本机 `~/.pd/`。2026-09 的更新架构（相关 ADR：ADR-0024；关键工单：PRI-698/709/727/729/732/738）：

- **唯一更新权威**：ReleaseManager（`packages/create-principles-disciple/src/update/release-manager.ts`）。9/18 的 PRI-738 **物理删除**了 legacy 更新器回退，此后更新只有"签名发布"一条路。
- **供给端**：GitHub Actions `release-metadata.yml` —— 三平台构建资产 + TUF 签名（minisign/ed25519 风格 root/timestamp/snapshot/targets 链）+ 原子推送到 `gh-pages` 分支。发布物：`targets/channels/stable.json`（频道指针）、`targets/releases/<releaseId>/metadata.json`（发布元数据）、每平台 asset tarball。
- **消费端**：Console 更新路由（`packages/pd-console/src/server/routes/update.ts`）→ 每请求构造 `createReleaseManagerAuthority` → 四项就绪检查（元数据源已配置 / 已安装 / 安装状态可读 / 交易日志可写）→ `manager.check`（影子模式：只评估已缓存元数据）→ `manager.apply`（事务式：拉元数据→验签→下载资产→安装→日志确认）。
- **信任锚**：`~/.pd/trust/root.json`（安装时钉入，PRI-732）；签名私钥在 GitHub secret `PD_RELEASE_SIGNING_KEY`。
- **配置面**：更新源 URL 三级解析（显式 > env `PD_RELEASE_METADATA_URL` > `~/.pd/install.json` 的 `releaseMetadataUrl` 持久层，PRI-709）；安装器只在**安装时 env 存在**才写入持久层。
- **策略门**：`src/update/release-policy.ts` —— 频道指针一致、未过期、序列单调、降级默认拒绝、**bootstrap 兼容**（`minBootstrapVersion`）。

## 2. 症状与时间线

- 09-10 ~ 09-16：Console 一键更新正常（交易日志 `~/.pd/transactions/console-apply-full-*.jsonl` 共 7 次，均带 `releaseMetadataDigestSource:"fallback"` = 走 legacy 更新器，版本 1.231.2→1.243.5）。
- 09-18：PRI-738（PR #1750）合并，删除 legacy 更新器。
- 09-19 00:22：本机 force 重装 `bundled-1.74.1`（generation 17 前为 16），新 runtime 生效。
- 09-19 上午：Owner 点「检查更新」→ 就绪门拒绝，页面只有英文通用句。

## 3. 证据总账（全部可复核）

### 3.1 修复前的拒绝（问题 #2）
- 复算命令（用已装 runtime 同版本代码，零写入）：
  `node` 动态 import `~/.pd/runtime/console/node_modules/create-principles-disciple/dist/update/release-manager-authority.js` 构造 authority →
  `{"check":{"ready":false,"reasons":["metadata_source_unconfigured"]}}`，`metadataSource.kind="unconfigured"`。
- 根因文件对照：`~/.pd/install.json` 无 `releaseMetadataUrl`；`installer.ts` `persistReleaseMetadataSource()`（absent env = no-op）；Console 启动命令行无 token/env（`wmic` 取证：`node ...server.js --workspace D:\.openclaw\workspace --port 3110 --host 127.0.0.1`）。
- 供给面反证：`gh run list --workflow release-metadata.yml` 历史 3 次全为 dry-run（作业名 "Assemble + publish (dry-run)"，2 success / 1 failure）；`git ls-remote origin gh-pages` 不存在；`GET /repos/csuzngjh/principles/pages` 404（Pages 未开通）。

### 3.2 已执行的修复（9/19，PR 风格证据见 PRI-847 评论）
1. `gh workflow run release-metadata.yml -f mode=publish` → run 35420740216 success（三平台构建+签名+原子推送）。
2. 发现 Pages 未开通 → `POST /repos/.../pages`（source=gh-pages/）开通。
3. 上线验证：`https://csuzngjh.github.io/principles/targets/channels/stable.json` → 200，`productVersion=1.143.2`、`publicationSequence=1`、`expiresAt=2026-12-18`；`targets/releases/<id>/metadata.json` → 200（assets: darwin/linux/win32）。
4. 首跑安装器被 EPERM 干净中止（网关锁插件目录，零变更）→ `openclaw gateway stop --force` → 重跑 success。
5. `~/.pd/install.json` 新增 `"releaseMetadataUrl": "https://csuzngjh.github.io/principles"`，旧字段全保留（merge 语义实证）。
6. 就绪探针（无 env）：`checkReady=true, reasons=[], metadataSource="install_config"`。

### 3.3 当前阻塞：bootstrap_too_old（问题 #3）★核心
- 真实 `manager.check('stable')`：**TUF 签名链验证通过**（拿到频道指针后）在"影子模式缓存未命中"处停下（原文："This shadow-mode check only evaluates already-verified metadata. Download arrives with the transactional updater."）——设计行为，非故障。
- `manager.apply({workspaceDir})`（与 Console 更新按钮同路径）：自行下载并验签发布元数据 → 落盘 `~/.pd/channels/stable.json` 与 `~/.pd/releases/<releaseId>/metadata.json`（缓存实证存在）→ 策略门拒绝：
  ```
  OUTCOME: {"kind":"no_update","note":"bootstrap_too_old: Release 1.143.2 requires bootstrap >= 1.0.0; installed bootstrap is 0.0.0."}
  ```
  事务未开、active.json 不变（1.74.1 / generation 17）——fail-safe 正确。
- **缺口本质**：
  - `~/.pd/bootstrap/bootstrap.json` 不存在 → `inspect().bootstrapVersion=null` → 代码按 `'0.0.0'` 参与（已装 dist：`status.bootstrapVersion ?? '0.0.0'`）。
  - 发布硬编码 `--min-bootstrap-version 1.0.0`（release-metadata.yml "Sign and emit release metadata" 步骤）。
  - **全仓 grep 证实**：bootstrap.json 只有读者（`install-layout.ts:99 readBootstrapManifest`、`pd-cli version-report.ts`），**没有任何写者**；`ensurePdHomeLayout` 建目录不写文件；本机 9/17-9/19 四次安装后文件仍不存在 = 直接反证。
  - 因此拒绝消息建议的 "Run the official installer once to update the bootstrap" **不可执行**；且影响**所有**由当前安装器装出的实例——发布门上线即全局锁死更新链。
- 修复选项（PRI-850 已列，需产品裁决）：A) 安装器在提交点写 bootstrap.json + 存量安装补写策略；B) 发布侧降门槛（弱保护，不推荐单独）；C) SPEC 层重审 bootstrap 语义（它本意是不是 standalone 外壳的版本？对 dual-slot 安装是否适用）。

### 3.4 版本号四张皮（问题 #4）
| 平面 | 值 | 说明 |
| --- | --- | --- |
| 本机 active.json | 1.74.1（bundled-1.74.1，两次 digest 不同=重建） | 安装器出厂戳；9/17-9/19 四次安装反复盖写 |
| main package.json | root/product 1.76.1；installer/core/cli 1.74.1 | publish-npm 改为 "tag-only release; we no longer push to main"（工作流注释原文）→ 字段冻结 |
| npm principles-disciple | **2.0.0**（9/19 02:59，前版 1.245.2） | 触发：#1761 push 自动火车，"Resetting to npm version before bump" + major → 2.0.0；GitHub Release v2.0.0 零附件（纯告示），tag 指向 9ca2a4b5（落后 main 头） |
| npm installer/core/cli | 1.143.2 / 1.284.20 / 1.152.9 | 同一"全产品火车"，各包 reset 回各自 npm 最新再 bump → 各奔前程 |
- 签名发布的 auto 语义 = `npm view create-principles-disciple version`（registry-anchored）→ 首个签名发布 = 1.143.2，与 npm 产品包 2.0.0 又是两个数。
- 危害：版本比较跨平面发生（semver 上 1.143.2 > 1.74.1，但它们属于不同号流）；"当前/最新"对 Owner 不可读。

### 3.5 UX（问题 #5）
`update.ts` 就绪门 failure JSON 含 `reason`/`nextAction`，页面只渲染英文通用句（9/19 截图佐证）。建议按 reason 映射大白话（四个就绪原因 + 策略类拒绝）。

## 4. 环境现状（专家入场基线）

- 本机：install.json 已登记 URL；就绪门绿；TUF 信任根 `~/.pd/trust/root.json` 在位；channels/releases 缓存已暖；active.json = 1.74.1 / generation 17；Console 3110 在线；网关服务注册正常。
- 发布面：gh-pages 已存在且 Pages 已开通；channel=stable 指向 1.143.2（seq=1，exp 2026-12-18）。下一次发布会从 seq=1 单调 +1。
- 仓库：main 头 fb397452；installer dist（本地）= 1.74.1、9/19 00:03 构建（含 URL 持久化）。
- 复现命令模板：
  - 就绪探针/check/apply：动态 import 已装 dist 的 `release-manager-authority.js`（脚本见会话，等价 Console 生产路径）
  - 重跑安装登记：`PD_RELEASE_METADATA_URL=https://csuzngjh.github.io/principles node packages/create-principles-disciple/dist/index.js --force --workspace <ws> --host openclaw --yes --json --stop-gateway`（先 `openclaw gateway stop --force` 防 EPERM）

## 5. 请专家决策/解决的问题清单

1. **bootstrap 语义与写者**（PRI-850）：bootstrap.json 应由谁在何时写？存量安装如何一次性补齐（或门槛重审）？给出 SPEC 级澄清 + 实现。
2. **版本权威统一**（PRI-849）：单一版本源（建议：发布即真源，main 字段生成化或发布回写）；火车内全组件同号或声明映射；active.json 出厂戳、npm、签名发布三者可互比较。
3. **check 影子模式与 UI 的配合**（P2，关联 PRI-848）：冷缓存时 check 的失败文案与"立即更新"按钮的关系（apply 不依赖 check 成功——本机实证 apply 自行取元数据）。
4. （顺带）release-metadata.yml 对 Pages 开通的依赖：首次 bootstrap 发布需要在工作流里探测并提示/自动开通 Pages，否则发布成功但不可达。
