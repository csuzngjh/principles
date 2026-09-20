# 开发安装脚本复核与同机隔离方案

核查时间：2026-09-20 07:53（Asia/Shanghai）。仓库 HEAD：`3d363271`。
性质：只读代码/现场核查与方案建议，不是故障修复完成报告。
原报告：`docs/audit/install-mjs-dev-installer-analysis-20260919.md`，保留不改。
工作区已有其他任务修改；本次仅新增本文，不运行任何安装、重启、清理或数据修复。

## 1. 结论与证据边界

旧安装链直接覆盖正式插件安装面、缺少事务保护的问题属实，应退出日常开发流程。
但“证据链已闭合”“不会影响 ~/.pd”“截图分歧就是脚本造成”的表述超出了现有证据。
静态可达路径证明故障风险，不能证明每次历史事故实际走过该路径。
本次未重放破坏性安装，也未核验历史截图、历史安装日志或所有已合并 PR。

| 原断言 | 复核判断 | 证据与修正 |
| --- | --- | --- |
| 两套安装链写同一插件位置 | 成立 | `scripts/install.mjs:47`、`:253`；`packages/create-principles-disciple/src/mvp-config.ts:265`。旧链 Console 在扩展内，正式 canonical Console 在 runtime 内。 |
| 文件锁下原位覆盖可留下混合/残缺树 | 风险成立，历史发生条件未证明 | `scripts/install.mjs:350` 清理失败仍复制；`sync-plugin.mjs:602` 删除重试后 EPERM 继续。删除/复制都可能部分成功，后续失败没有全链回滚。不能断言所有 Node JS 文件都被持续持锁。 |
| 完全不影响 ~/.pd | 不成立 | 顶层源码没有字符串不等于调用树没有写入。`sync-plugin.mjs:880` realpath 解析链接，`:888` 删除真实目标，随后复制。现场两个 core junction 均解析到正式 runtime/core。若清理/依赖处理后该链接仍存在，此分支可直接改写正式 runtime。不是声称每次必然发生。 |
| 覆盖必然触发 identityDivergence | 过强 | `pd-console/src/server/routes/update.ts:39` 比较版本字段；`utils/installed-layout.ts:84` canonical 选 runtime/plugin，`:117` 才提供插件路径。仅替换扩展副本未必改变这个比较结果；同版本不同字节也可能不报警。 |
| 两个 Console 都默认 3100 | 成立，但当前双实例未证实 | `install.mjs:408`、Console `server/index.ts:123`。同地址同端口通常第二个绑定失败，不是同时随机分流。现场旧扩展 console 不存在。 |
| 现场 npm install 不等于确定性 release 闭包 | 成立 | `install.mjs:391`、`sync-plugin.mjs:927`。核心问题是运行中目标树原地依赖解析和包注入；不能单独归罪于 legacy-peer-deps。Console npm 失败仅警告，也未形成事务失败回滚。 |
| 旧链毫无身份/验证 | 需细化 | 无正式产品身份交付契约，但 `sync-plugin.mjs:474` 有 git SHA/bundle MD5 指纹，`:1399` 验证；另有依赖和 CLI/native smoke。顶层 Console 验证还检查 index.html，不能概括为全链只检查 server.js。 |
| 旧链仅异步重启 | 不准确 | 默认 restart=true（`sync-plugin.mjs:92`）；Windows 路径 `:1083` 同步执行停止/启动并检查端口，但它在安装后的 `:1408` 才运行。关键缺陷是修改前未协调停机，且硬编码正式端口/任务。 |
| repair-update-chain 能修复被覆盖的产品树 | 不成立 | `installer.ts:569` 主要交付 bootstrap、登记更新源；不部署产品 payload。CLI 声明见 `src/index.ts:501`。损坏产品树需要匹配目标版本的完整官方事务部署/恢复。 |

上表未写全的 `sync-plugin.mjs` 均指 `packages/openclaw-plugin/scripts/sync-plugin.mjs`；`installer.ts` 均指 `packages/create-principles-disciple/src/installer.ts`。

## 2. 原报告遗漏的副作用

1. `install.mjs:285` 修改正式 `openclaw.json`；子脚本 `:573` 写 `.openclaw/plugins/installs.json`。影响不限于扩展目录。
2. 子脚本 `:1363`、`:1378` 条件调用 bootstrap-rules 和 compile-principles，目标来自正式配置 workspace。这是旧规则 bootstrap，不是更新链 bootstrap executor。相关脚本使用 `.state`、编译器和 trajectory 数据库；是否在事故中成功执行尚未证明，但不能排除 workspace 副作用。
3. Windows 重启按 18789 查询 PID，并启动固定 `OpenClaw Gateway` 计划任务（`:1095` 起）。即使重定向 HOME，也可能停止正式网关。
4. 子脚本会清理旧备份（`:992` 起，`:1401` 调用）。不能只给父脚本加 active.json 检查，保留子脚本直接入口。

## 3. 现场快照

只读解析得到：

```text
~/.openclaw/extensions/principles-disciple/core
  -> C:\Users\Administrator\.pd\runtime\core
~/.openclaw/extensions/principles-disciple/node_modules/@principles/core
  -> C:\Users\Administrator\.pd\runtime\core
~/.openclaw/extensions/principles-disciple/console：不存在
~/.pd/active.json：productVersion=1.74.1
  releaseId=bundled-1.74.1-959ce5ad61e3
  generation=23
  LastWriteTimeUtc=2026-09-19 23:35:02
监听：127.0.0.1:3100 PID 23764；127.0.0.1:18789 PID 68648
```

这与原报告的 2.1.0 / generation 20 不同。只能说明当前活动记录已变化，不能认定触发者、证明运行进程已加载该版本，或据此声称整机健康/损坏。
Console package.json 的 0.1.0 是组件版本，不是产品版本。

## 4. 为什么换端口、换 workspace、worktree 都不够

现有 Console 仍有用户级状态和控制面：

- `server/config/WorkspaceConfigStore.ts:15` 默认读写 `~/.pd-console/workspaces.json`。
- `server/utils/installed-layout.ts:69` 从 `os.homedir()` 解析安装位置。
- `server/routes/update.ts:70` 从 `~/.pd` 找更新执行器。
- `server/index.ts:307` 从用户级 `.pd` 对账更新历史。
- 安装器 `mvp-config.ts:233` 优先 HOME，而部分控制路径使用 `os.homedir()`，环境变量语义未统一。

因此 worktree 隔离源码，不能隔离运行数据和正式进程；`--workspace` 隔离部分数据，不能隔离整个控制面；单独设置 OPENCLAW_STATE_DIR 也不能改变 PD 内部硬编码路径。

## 5. 推荐的三层验证方式

### A. 日常快速源码验证

复用仓库 build/dev/test，直接运行 worktree 产物，不复制到正式安装目录。
一个任务一个 worktree、独立依赖/构建、独立实验 workspace；默认合成数据。若确实需要生产数据复现，使用运行时支持的一致性备份/导出，不能直接复制活跃 SQLite 主文件或将正式目录 junction 进实验目录。

当前尚未补齐同用户控制面隔离时，把完整 Console/host 手工验证放在隔离 Windows 测试环境中。只涉及纯逻辑的测试继续在仓库中跑，不必每次打包或重装。
Console 热更新/重启只处理测试进程；不使用旧 sync 脚本。独立端口只是必要条件之一。

### B. 本地部署与集成验证

复用现有自包含发布包构建能力的实际入口：
`packages/create-principles-disciple/package.json` 的 **`build:release-asset`**，对应 `scripts/build-self-contained-release.mjs`。
使用现有打包器/官方安装事务，在隔离环境中部署本地 payload；不要再造一个 dev 复制安装器。
构建只重做受影响依赖和组件；部署前整体闭包验证不能跳过。
新版本先构建验证，再停止测试进程、执行受控替换、重启、验证；失败保留可恢复旧版本。Windows 下清理失败应中止，不再“原位覆盖兜底”。

本地未签名 payload 的部署验证与正式签名渠道验证必须区分；不伪造正式 release 身份，不通过关闭正式签名校验来满足开发便利。
构建标识应能追到 commit 和 dirty 内容/产物摘要，仅记录 HEAD 无法解释未提交修改；复用已有指纹和身份能力，补足差距即可。

### C. 发布验收

在隔离环境复用正式 release 打包、身份、签名/信任、ABI、更新与回滚链。
覆盖升级、同版本修复、降级拒绝/明确授权、失败恢复及 SQLite 数据兼容；随后正式环境只消费已验证的发布产物。
正式运行环境不是测试安装目标。

## 6. 在这台 Windows 机器上如何落地

推荐先保留现有 Administrator 正式环境，使用持久 Windows 测试 VM 做完整集成；临时验收可用 Windows Sandbox。共享给测试系统的只有只读源码或产物输入，不映射正式用户 home、runtime、workspace 为可写目录。持久 VM 可保留 Node/npm 缓存和依赖，缩短后续迭代。

这保留 Windows 文件锁、计划任务、junction 和原生 ABI 的测试条件，同时避免当前硬编码正式任务名/端口碰到宿主。Linux 容器可用于纯逻辑 CI，但不替代 Windows 安装验收。
独立普通 Windows 用户可作为较轻替代，但还需隔离计划任务/进程权限/端口；不能仅创建用户就宣称所有机器级资源已隔离。

长期若需要同用户双开，最小工程范围为：

1. 让旧父/子安装入口在任何副作用前明确拒绝并给出新开发流程；保留一段时间可解释的弃用入口，再清理调用文档。仅检测 active.json 不充分，缺失/损坏安装和直接子入口都会绕过。
2. 复用现有 install-layout 的 homeDir 参数与控制路径，统一测试环境的 home、runtime、workspace、Console 注册表、宿主状态、临时锁、日志和缓存；启动前检查 realpath，不允许写目标或其父级链接逃出实验根。
3. 同机端口可规划为正式 Console 3100/Gateway 18789，测试 Console 13100/Gateway 19789；实际启动前检查占用和 Gateway 派生端口。测试网关前台启动，只由所属进程句柄/PID 管理；禁止固定正式任务名和按全局端口杀进程。
4. Codex 测试独立 CODEX_HOME/hook 注册；OpenClaw 测试独立 profile/config/state/workspace；测试消息通道不用正式机器人账号，避免两个实例消费同一真实消息。
5. 开发启动页/日志显示环境名、绝对 workspace、源码/产物标识；禁止默认回退到正式目录。开发实例的更新入口必须明确指向实验安装。

以上是建议实现范围，并非现有命令已经完整支持。环境启动工具归开发脚本/host 配置，不给 principles-core 增加通用编排子系统。

OpenClaw 官方支持多实例独立配置、状态、workspace 和端口：
https://docs.openclaw.ai/gateway/multiple-gateways
微软支持 Sandbox 只读映射目录：
https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file
这些能力不能自动修复 PD 当前的硬编码路径。

## 7. 实施后的验收证据

- 正式环境空闲或受控条件下记录 runtime 文件摘要、链接目标、active generation、配置与进程身份；完成测试部署/回滚后对比，区分正式运行自身产生的日志/数据变化。
- 测试日志证明所有可写路径落在实验根；覆盖祖先 junction、既存链接、缺失 active、端口占用、HOME/USERPROFILE 不一致等拒绝路径。
- 故意占用测试文件/让安装中途失败，证明没有混合发布、没有正式进程停止、旧测试版本可恢复。
- 通过真实 Console、CLI、host hook 完成实验 workspace 的可观察闭环，并确认正式 workspace 未收到实验事件。
- 发布验收使用真实包、真实 installer 和对应 Windows Node ABI；单元测试通过不能替代此项。

## 8. 可重放只读核查

在仓库根目录执行 PowerShell；不运行 install.mjs 或 sync-plugin.mjs：

```powershell
git rev-parse HEAD
git status --short
rg -n 'realpathSync|writeTarget|rmSync|bootstrapScript|compileScript|restartGateway' packages/openclaw-plugin/scripts/sync-plugin.mjs
rg -n 'identityDivergence|readCurrentVersion|resolvePluginDir' packages/pd-console/src/server/routes/update.ts
rg -n 'os.homedir|paths.pluginDir' packages/pd-console/src/server/utils/installed-layout.ts
rg -n 'repairUpdateChain|deploys no payload' packages/create-principles-disciple/src/installer.ts
node -e "const fs=require('fs'),p=require('path'),os=require('os'); for(const r of ['core','node_modules/@principles/core']) {const f=p.join(os.homedir(),'.openclaw/extensions/principles-disciple',r); console.log(f,fs.existsSync(f)?fs.realpathSync(f):'missing')}"
node -e "const fs=require('fs'),p=require('path'),os=require('os');const a=JSON.parse(fs.readFileSync(p.join(os.homedir(),'.pd/active.json'),'utf8'));console.log({productVersion:a.productVersion,releaseId:a.releaseId,generation:a.generation})"
```

本次验证：上述关键源码读取、链接解析、active 字段提取和监听端口查询已执行；未启动应用、未执行自动化测试或完整性 canary，因此不宣称正式安装健康，亦不宣称隔离方案已实现。

Complexity Delta：本次仅文档新增，八项均 NO。实现方案的复杂度须在实际设计/PR 中另行评估。
Emotional value: N/A — no direct Owner-facing behavior.
