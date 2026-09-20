# scripts/install.mjs（开发版安装脚本）与官方安装渠道的差异及"目录损坏"机制分析

日期：2026-09-19 ｜ 分析人：ZCode 会话 ｜ 性质：只读分析，未修改任何代码
关联：AGENTS.md §1.1（2026-09-03 占位符事故同族）、PRI-849（版本权威）、PR #1768/#1771/#1773（更新链整改）

> ⚠️ **2026-09-20 更正**：本文"`install.mjs` 完全不写 `~/.pd`"的边界结论已被复核**推翻**（install.mjs 经 sync-plugin.mjs 间接处理 junction，可写穿 `~/.pd/runtime`，证据见 **[install-mjs-dev-prod-isolation-review-20260920.md](./install-mjs-dev-prod-isolation-review-20260920.md)**）；其余"目录损坏"机制分析经复核仍然成立。

---

## 0. 一页摘要

仓库里存在**两套互不相识的安装器**：

| | 官方安装器 | 开发脚本 |
| --- | --- | --- |
| 入口 | `packages/create-principles-disciple`（npm 包 create-principles-disciple） | `scripts/install.mjs`（"PD System Full Installer"，544 行） |
| Console 部署位置 | `~/.pd/runtime/console` | `~/.openclaw/extensions/principles-disciple/console` |
| 事务日志 | ✓ journal 全链 | ✗ 无 |
| 备份/回滚 | ✓ 改名换位+保留上一版 | ✗ EPERM 时"原位覆盖"（新旧混合） |
| active.json（安装身份） | ✓ 写入 | ✗ 完全不写 |
| bootstrap 执行器交付/登记 | ✓ | ✗ |
| 产品身份戳校验 | ✓ | ✗（无戳字节直接入生产目录） |
| 来源字节 | 签名发布/出厂包（可追溯） | 开发工作区即时构建（不可追溯） |

**Owner 观察到的"每次用脚本安装后 PD 目录就损坏"**= 三个机制叠加（§3）：
① 覆盖官方管理的插件/Console 目录但不写任何身份与日志 → 安装面与更新链状态脱钩；
② Windows 文件锁下"原位覆盖"产生半新半旧 dist；
③ 造出第二个 Console 入口（extensions 路径 + 3100 端口）与生产 Console（~/.pd/runtime/console）抢端口/抢身份。

**关键边界澄清（⚠️ 2026-09-20 已更正）**：~~`install.mjs` 不写 `~/.pd` 任何内容~~——此结论**只对 install.mjs 单文件成立，整体不成立**：它无条件调用 `sync-plugin.mjs`，而后者会解析插件内 junction 并改写**真实目标**（本机 `core`、`node_modules/@principles/core`、`node_modules/@principles/host-runtime` 三个链接均指向 `~/.pd/runtime`），因此旧链**可以**污染更新链权威状态。完整证据与修正见 **[install-mjs-dev-prod-isolation-review-20260920.md](./install-mjs-dev-prod-isolation-review-20260920.md)**。

---

## 1. 两套体系为何并存（背景）

- **官方链**（ADR-0024/SPEC v0.3）：`create-principles-disciple` 安装器是唯一部署权威——journal（D-2）、备份保留、active.json（安装身份）、bootstrap 执行器登记（§6.1）、产品身份戳（PRI-832）。
- **开发链**：`scripts/install.mjs` 是早期"从工作区一键装到本机"的开发工具，早于 dual-slot/签名发布体系，从未按新架构收敛。
- 两者写在**相同的目标目录**（`~/.openclaw/extensions/principles-disciple`），但官方链的管理工具（更新、修复、验证、canary）按"官方安装的产物"假设该目录内容——dev 字节混入即触发身份/完整性告警。

## 2. 脚本行为逐段分析（行号对应当前 main 的 scripts/install.mjs）

- L23-50：导入与路径常量——目标锁定 `~/.openclaw/extensions/principles-disciple/{plugin,console,bin}`。**全文件 0 处引用 `~/.pd`**（grep 实证）。（⚠️ 2026-09-20 更正：由此推出"不触碰 active.json/bootstrap/releases/journal"不成立——间接调用链 `sync-plugin.mjs` 会经 junction 写穿 `~/.pd/runtime`，见 §0 更正与[复核报告](./install-mjs-dev-prod-isolation-review-20260920.md)。）
- L56-90：`copyDir` 递归拷贝（无锁检测）；`injectCorePackage`：把 monorepo `node_modules/@principles/core`（开发版）覆盖注入目标 `node_modules`——生产目录从此混入开发依赖树。
- L94-140：参数解析；`--force` 跳过确认；`--skip-build` 用现有 dist（可能是陈旧/半成品构建）。
- L168+：`getVersion(dir)` 读目标 package.json 的 version——dev 树版本，非产品身份。
- L195 `checkPrerequisites`：只查 Node 版本与目录存在，**不查网关/Console 是否在运行**。
- L209/220/232：`installRootDeps`/`buildCoreAndCli`/`buildPdConsole`——在开发树里 npm install + 构建。
- L250-278 `installPlugin`：委托 `packages/openclaw-plugin/scripts/sync-plugin.mjs --force`。该脚本在 L1068+ 有 `restartGateway()`（Windows 走计划任务），**异步**重启网关——文件锁释放与后续拷贝之间存在竞态窗口。
- L285-333 `registerPlugin`：合并写 `~/.openclaw/openclaw.json` 的 plugins 段（保留用户配置，这点做对了）。
- L334-434 `installPdConsole`：**核心问题区**——
  - L352：尝试 `rmSync` 旧 dist；EPERM 时**不中止**，落日志后走"原位覆盖"；
  - L360-375：`cpSync` 3 次重试（每次仅等 2 秒）；Console/网关持有句柄时，拷贝产物=**新旧文件混合**；
  - L391：在**生产安装目录**里执行 `npm install --omit=dev --legacy-peer-deps`——依赖树与官方 payload 脱钩；
  - L400：再次注入开发版 @principles/core。
- L458 `verifyPdConsole`：仅检查 `dist/server.js` **存在且非 0 字节**——16 字节占位符即可通过（与 2026-09-03 事故同族弱点）。
- L477-542 `main`：装完提示用户从 `extensions/principles-disciple/console` 启动 **3100 端口**——与生产 Console（~/.pd/runtime/console，同端口）抢位。

## 3. "目录损坏"的四个机制（每个都独立可复现）

### 机制 1：文件锁下的原位覆盖 → 半新半旧 dist
Windows 下运行中的 Console/网关持有 dist 内文件句柄。脚本在 EPERM 后"原位覆盖"= 对可写文件覆盖、对锁定文件保留旧版 → **混合版本 dist**。症状：行为随机、版本报告与文件内容互相矛盾。
佐证：脚本 L350-355 的"原位覆盖"分支本身就是对此的承认；本机 9/19 修复流程中同类锁（网关占用插件目录）需 `openclaw gateway stop --force` 才能解除。

### 机制 2：覆盖官方管理的目录但不写任何身份/日志 → 三处真值脱钩
官方链在该目录部署的插件带产品身份戳（PRI-832），且 host installers/更新流按"官方部署"管理它。install.mjs 覆盖后：
- 插件目录字节 = dev 构建（版本号 = dev 树 package.json，无戳）；
- active.json/releases/更新历史 = 官方链状态（未被触碰）；
- Console 的 identityDivergence 检查（PRI-833）与 canary 随即报分歧/降级。
Owner 看到的"装完就乱"即此。**注意归因**：9/19 晚间观察到的 `activeVersion 2.1.0 vs pluginVersion 1.76.1` 分歧是 Release 附件升级后的**组件清单时间差**（预期内诊断），与 install.mjs 无关——但若 install.mjs 在其后运行，分歧将变为真实的字节脱钩。

### 机制 3：第二个 Console 入口 + 端口冲突
脚本教用户从 `extensions/.../console` 以 **3100** 端口启动 Console——与生产 Console（~/.pd/runtime/console，同样默认 3100）抢端口/抢 workspace。用户分不清自己连的是哪个构建。

### 机制 4：`npm install --legacy-peer-deps` 在生产目录
生产目录依赖树由 npm 平面解析+开发 node_modules 注入拼成，与官方 payload 的确定性依赖清单（manifest 校验过的闭包）不一致——正是"可重复构建"体系（SPEC §7/§18-3）要消灭的形态。

## 4. 与官方渠道安装的差异总结

| 维度 | 官方 create-principles-disciple | scripts/install.mjs |
| --- | --- | --- |
| 触发 | npm 包 / GitHub 发布流 | 开发工作区手动 |
| 字节来源 | 签名发布 / 出厂 payload（可溯源 commit） | 工作区即时构建 |
| 写入位置 | `~/.pd/runtime/*`（dual-slot）+ 插件目录 | `~/.openclaw/extensions/principles-disciple` |
| active.json | ✓（唯一安装身份） | ✗ |
| bootstrap 执行器交付/登记 | ✓（v0.3 §6.1） | ✗ |
| journal | ✓ 11 态 | ✗ |
| 备份/回滚 | ✓ + 保留上一版 | ✗ |
| 依赖闭包 | payload 内确定性清单 | 现场 npm install（浮动） |
| 身份戳校验 | ✓（CI 三层 + 安装预检） | ✗ |
| 网关协调 | ✓ stop → install → restart | ⚠️ 异步/竞态 |
| 更新链兼容 | ✓（url 流/TUF/ABI 矩阵全支持） | ✗（产物无身份，更新/校验链视其为异类） |

## 5. 本机实证时间线（供交叉核对）

- 09-19 白天：我们经官方链把机器升到 Release 附件版（channel ptr4 → 1.76.1，后 seq5 → 2.1.0）；Console（~/.pd/runtime/console，3100）`/api/update/check` 返回 `up_to_date`；同时可见 identityDivergence 诊断（活动 2.1.0 vs 插件 1.76.1——组件清单时间差，预期内）。
- 09-19 晚间：另一 AI 在"PRI-768 v5 现实验证"任务中检查进程与安装器入口；随后机器 active.json 变为 **gen 19 / bundled-1.74.1-959ce5ad61e3**——即有安装器运行，把机器盖回 bundled 1.74.1（这属于 §5"安装器重装语义"，另一机制，见 update-chain-expert-brief §3.3）。
- 09-19 深夜：本会话经官方执行器把机器升到 **2.1.0**（gen 20，journal confirmed）。

## 6. 复核清单（每条断言可独立重放）

```bash
# A. install.mjs 不写 ~/.pd（0 处引用）
grep -cE "\.pd\b" D:/Code/principles/scripts/install.mjs        # 预期 0（或仅注释）

# B. 两个 Console 部署位置不同
grep -n "getInstalledConsoleDir" D:/Code/principles/packages/create-principles-disciple/src/mvp-config.ts
grep -n "INSTALL_CONSOLE_DIR =" D:/Code/principles/scripts/install.mjs

# C. 官方安装器有 journal/active/备份/网关协调
grep -nE "appendJournalTransition|commitInstallerActiveRecord|retainSupersededBackup|checkOpenClawGateway" \
  D:/Code/principles/packages/create-principles-disciple/src/installer.ts | head

# D. install.mjs 无 journal/active/bootstrap
grep -cE "active\.json|bootstrap|journal|transaction" D:/Code/principles/scripts/install.mjs   # 预期 0

# E. 身份戳校验存在于官方链（对照：install.mjs 无）
grep -rn "parseEmbeddedProductIdentity" D:/Code/principles/packages/create-principles-disciple/src/installer.ts | head -2

# F. sync-plugin 的网关异步重启（EPERM 竞态来源）
grep -nE "function restartGateway" D:/Code/principles/packages/openclaw-plugin/scripts/sync-plugin.mjs
```

## 7. 处置选项（待 Owner 拍板，本次未改代码）

- **A（推荐）**：给 install.mjs 加守卫——检测到 `~/.pd/active.json` 存在或 extensions 目录已有官方安装时，拒绝运行并打印"请使用 repair-update-chain / 官方安装器"；头部加弃用横幅（PRI-849 关联）。
- **B**：直接删除 install.mjs（若确认开发流程已不需要）。
- **C**：保持现状 + 仅文档标注。

无论选哪个：**日常"更新 PD"的唯一正道 = Console 更新页 / `pd` 更新流；`npx create-principles-disciple` 只用于安装/修复；两者都不要在 dev 工作区里对着生产目录跑。**
