# PD Release Dependency Model — 发布依赖语义模型

> **状态**: Active
> **最后更新**: 2026-09-20（PRI-878）
> **基线**: `main` @ `f3ef3102`（实测取证；PR #1781 当时仍 OPEN，其影响单独标注，见 §14）
> **关联**: [`version-model.md`](./version-model.md)（版本语义——"dependency ≠ same version" 的出处）、
> `docs/research/package-release-system-audit.md`（本模型的前置调查）、ADR-0023 §2.5

---

## 1. Purpose

回答一个问题：**"我修改了这个组件，哪些其他组件实际上会受到影响？为什么？"**

PD 的真实依赖关系**不能**只从 package.json 读出。发布链的大部分关键边存在于
CI 逻辑、打包复制脚本、安装期符号链接、宿主目录约定和签名元数据中。本文给出
七类依赖的官方分类和每类的证据图，作为所有 package/version/release 修改任务的
影响面判定依据。

**全文方向约定：`A ──▶ B` 一律读作 "A depends on B / A 在前置意义上需要 B"。**

---

## 2. Dependency Taxonomy

| # | 类别 | 回答的问题 | 载体（在哪里才看得到） |
|---|---|---|---|
| C1 | **code** | 编译/运行时谁 import 谁 | package.json deps + 源码 import |
| C2 | **build** | 构建 A 前必须先存在 B 的 dist/types | 根 `package.json` build 链、CI build 步骤顺序 |
| C3 | **package-release** | 发 npm 包 A 前 registry 必须已有 B | `publish-npm.yml` detect 顺序 + `action.yml` registry preflight |
| C4 | **product-assembly** | 谁被复制/bundle/stamp 进谁的发布载荷 | `bundle-plugin.mjs` SRC→DEST 映射、CI sed 步骤 |
| C5 | **runtime** | 装到 `~/.pd` 后谁靠谁的哪份文件活着 | `installer.ts` 符号链接/junction 构造、Node 模块解析 |
| C6 | **distribution** | 更新链上谁验证谁、谁提交谁 | 签名元数据 → ReleaseManager → installer → active.json |
| C7 | **host-integration** | 宿主（OpenClaw/Codex/OS）按什么约定加载/调用什么 | 宿主发现规则、`plugins/principles-disciple/**`、shim |

判定"修改 A 影响谁"时，先确定沿着**哪一类**边传播——不同类别的传播规则完全不同
（这正是 §11 的用途）。类别可依证据增补，不得为抽象而抽象。

---

## 3. Canonical Package Inventory

来源：`git ls-files "*package.json"`（29 个），按角色三分。**三类不得混入同一发布图。**

### Canonical（真实源码，workspace 成员，`package.json:7-9` workspaces）

| Package | Path | Published | Private | Role |
|---|---|---|---|---|
| `@principles/core` | `packages/principles-core` | ✅ 1/7 | 否 | 领域/运行时核心 |
| `@principles/install-layout` | `packages/install-layout` | ✅ 2/7 | 否 | 安装布局库 |
| `@principles/host-runtime` | `packages/host-runtime` | ✅ 3/7 | 否 | 宿主中立运行时 |
| `@principles/codex-adapter` | `packages/codex-adapter` | ✅ 4/7 | 否 | Codex 宿主适配器 |
| `@principles/pd-cli` | `packages/pd-cli` | ✅ 5/7 | 否 | `pd` CLI |
| `principles-disciple` | `packages/openclaw-plugin` | ✅ 6/7（npm+ClawHub） | 否 | OpenClaw 插件 |
| `create-principles-disciple` | `packages/create-principles-disciple` | ✅ 7/7 | 否 | installer + ReleaseManager |
| `@principles/pd-console` | `packages/pd-console` | ❌ 永不 | 是 | Console 服务端/UI（只随 installer 载荷分发） |
| `@principles/pd-companion` | `packages/pd-companion` | ❌ | 是 | Electron 桌面外壳（`companion-v*` tag → GitHub Release） |
| `@principles/website` | `packages/website` | ❌ | 是 | VitePress 站（Cloudflare Pages） |
| （聚合根）`principles-disciple-monorepo` | `/package.json` | ❌ | 是 | **产品版本权威载体**（见 version-model.md） |

### Generated / bundled copy（打包生成物，被 git 跟踪，**不是维护对象**）

`packages/create-principles-disciple/{plugin,pd-cli,console,core,host-runtime,codex-adapter,install-layout,release-manager}`
——由 `bundle-plugin.mjs:50-71` 的 SRC→DEST 映射产生；嵌套 `package.json` 版本在打包时
从 npm registry 现取覆写（`bundle-plugin.mjs:689-728`）。同名不同版本的"幽灵成员"，
任何 workspace 扫描工具都会撞上它们（§10 风险表 R6）。

### Fixture / lab / internal（不进入真实发布体系）

`scripts/dev/pipeline-closure-lab/scenarios/**`（5 个实验室夹具）、
`tests/e2e-fixtures/trap-*`（3 个 e2e 陷阱夹具）、
`scripts/nocturnal{,/trainer}`（离线评测库）、`packages/website/video/homepage-demo`（视频资产）。

---

## 4. Code Dependency Graph（C1，package.json 显式声明）

依赖声明实测（canonical，`A ──▶ B` = A 声明依赖 B）：

```
core            ──▶ （无内部依赖，最底层）
install-layout  ──▶ （无内部依赖）
host-runtime    ──▶ core(^1.74.1), install-layout(^0.2.0)
codex-adapter   ──▶ core, host-runtime, install-layout
pd-cli          ──▶ core, codex-adapter, host-runtime, install-layout, plugin(principles-disciple ^1.74.1)
plugin          ──▶ core(deps), host-runtime(devDeps)
installer       ──▶ install-layout(^0.2.0)          ← 唯一声明的内部 runtime dep
pd-console      ──▶ core(*), host-runtime(*), install-layout, installer(*), plugin(*)
pd-companion    ──▶ install-layout(^0.2.0)
website         ──▶ core(devDeps)
```

源码 import 与声明逐包核对（`rg "from '@principles/…'" packages/*/src`）：
pd-console 的 `create-principles-disciple/update-console`、`principles-disciple/governance-audit`
等子路径 import 均在 exports map / deps 中有对应声明。**除下表外未发现 undeclared 真实代码边。**

### 声明了但仅类型使用 / 手工镜像的边

| From ──▶ To | 类型 | 证据 | 备注 |
|---|---|---|---|
| installer ──▶ core | **type-only import**（未声明依赖） | `installer.ts:39` `import type { HostInstallContext } from '@principles/core/host'` | 编译期擦除，npm 消费者不受影响；workspace 内可解析。属"package.json 未表达"的 C1 缺口 |
| installer ──▶ core 常量 | **手工镜像常量** | `installer.ts:71-72` "PRI-343: Keep in sync with @principles/core CONVERSATION_ACCESS_CONFIG_KEY"，值 `'allowConversationAccess'`；权威在 `principles-core/src/runtime-v2/config/pd-config-types.ts:394` | 无 guard 的 value-coupling，见 §10 R5 |

---

## 5. Package Release Graph（C3，发布顺序及其原因）

### 列车顺序（full-product train，`publish-full-product` job 步骤序）

```
core → install-layout → host-runtime → codex-adapter → pd-cli → plugin → installer
```

**原因（逐条有注释证据，`publish-npm.yml:91-97,186-196`）**：
是 **registry dependency**（C3），不是人工偏好也不是历史 workaround——消费者的
`npm install` 在声明依赖缺失时直接失败。每个发布步骤另有 **registry preflight 硬门**
（`action.yml:90-130`：`check_published` 重试 5 次后 fail，注释明言 "publishing now
would make 'npm install X' fail dependency resolution"）。preflight 覆盖矩阵：
host-runtime→install-layout、codex-adapter→host-runtime、pd-cli→{host-runtime,
codex-adapter,install-layout}、installer→{host-runtime,install-layout}。

### 两条发布路径（勿混淆）

| 路径 | 触发 | 顺序保证 |
|---|---|---|
| 单包/子集 matrix | push 路径过滤（7 个 packages 目录，`publish-npm.yml:39-47`）或 dispatch 指定包 | `max-parallel:1` **只是限流不是排序**；权威保证=每包 registry preflight（注释 `publish-npm.yml:247-251` 明言 ordering is advisory） |
| full-product 列车 | 仅 `workflow_dispatch` 且 `package=full-product` | 单 job 顺序步骤 = 权威依赖序 |

### 结构性强制边（不是"建议"，是 CI 逻辑硬编码）

| 边 | 机制 | 证据 |
|---|---|---|
| plugin 发布 ──**强制⇒** installer 必须同列车发布 | detect 里若 matrix 含 openclaw-plugin 而 installer 不在，**自动追加 installer** | `publish-npm.yml:203-224`（"update-drift fix"：否则 /check 承诺的版本 /apply-full 永远给不出 → 永久假"update available"） |
| pd-console 变更 ──**强制⇒** installer 发布 | 同上模式，console-only merge 自动追加 installer | `publish-npm.yml:225-238`（PRI-558 事故：UI 改版在 main 搁置一天无人收到） |
| 列车产品身份 ──注入⇒ installer 步骤 | `product_identity_version` 由 `resolve-product-version.mjs` 解析后传给 7/7 | `publish-npm.yml:760-763,830` |

### 非 npm 出口（各自独立的发布图）

```
release-metadata.yml（人工 dispatch + PD_RELEASE_SIGNING_KEY）
    ──▶ build-release-asset × (platform/arch/nodeAbi) 矩阵（PRI-850：Node ABI 是资产身份一部分）
    ──▶ ed25519 签名 + TUF 链 → gh-pages（channels/releases）+ pd-assets GitHub Release
companion-release.yml ←── git push tag companion-v*（独立生命周期）
publish-npm.yml(6/7) ──▶ ClawHub marketplace 同步（continue-on-error，失败人工兜底）
website ──▶ Cloudflare Pages（与上述全部无关）
```

---

## 6. Build and Product Assembly Graph（C2 + C4）

### C2 构建序（workspace 构建必须先有谁）

根 `package.json` build 链 + CI build 步骤（`publish-npm.yml:315-330` 注释）：

```
build(core) → build(install-layout) → build(host-runtime) → …
                    ↑ 原因：host-runtime 的 TypeScript 编译 import
                      @principles/install-layout 的 dist/index.d.ts，
                      clean `npm ci` 后不存在 → 必须先构建 install-layout
```

（这是 C2 与 C3 分离的实例：types 存在性是构建期约束，与 registry 无关。）

### C4 installer 载荷组装（bundle-plugin.mjs SRC→DEST，行 50-71）

```
create-principles-disciple 载荷
├── plugin/          ◀─ packages/openclaw-plugin        （build-time copy；依赖改写 file:）
├── pd-cli/          ◀─ packages/pd-cli                  （同上）
├── console/         ◀─ packages/pd-console              （同上，console 唯一分发通道）
├── core/            ◀─ packages/principles-core         （同上）
├── host-runtime/    ◀─ packages/host-runtime            （同上）
├── codex-adapter/   ◀─ packages/codex-adapter           （同上）
├── install-layout/  ◀─ packages/install-layout          （同上）
└── release-manager/ ◀─ packages/create-principles-disciple 自身 dist（PRI-672：目录名按
                        runtime 角色，package name 仍是 create-principles-disciple）
```

每一条都是 **product-assembly 边（复制）**，不是 npm dependency；打包时依赖被改写为
`file:` 引用（`bundle-plugin.mjs:444-484`），嵌套 package.json 版本从 npm 现取（689-728）。

`release-locks/<component>/package-lock.json`（8 份，git 跟踪）= 各载荷组件的**依赖锁定
记录**；`pd.bundledPluginVersion` 打包时从 **npm registry** 读插件实际版本盖章
（`bundle-plugin.mjs:648-656`）——纯诊断 metadata。

---

## 7. Runtime Dependency Graph（C5，安装后谁靠谁活着）

安装态模块解析**不走 npm 依赖解析**，走 installer 构造的文件系统拓扑：

```
~/.pd/runtime/
├── core/ host-runtime/ codex-adapter/ install-layout/    （installer 解包铺设）
├── pd-cli/  node_modules/@principles/{core,host-runtime,codex-adapter}
│              ── junction/symlink ──▶ ../../{core,host-runtime,codex-adapter}
│              （installer.ts:1997-2042；bundle 把依赖改写成 file:../core 等，
│                链接缺失则 pd-cli 静态 import 崩溃——注释逐条写明）
├── console/（pd-console dist，由 console server 直接 require 同目录 runtime）
├── release-manager/（update-console seam 的实现体）
└── plugin/  core ── junction ──▶ runtime/core（installer.ts:1658：插件的 core 是链接，
│           不是第二份拷贝）
~/.openclaw/extensions/principles-disciple/                （宿主发现位置）
```

`~/.pd/bootstrap/dist/bootstrap-entry.js` = console 派生的独立 executor 进程入口
（C5/C6 交界，见下）。

**build-time vs installed-runtime 的界线**：C4 复制发生在 runner；C5 链接发生在
用户机器 installer 运行期。同一对组件可能两条边都有（plugin→core），含义不同。

---

## 8. Distribution / Update Graph（C6）

**必须与 §4 分开看：这里的节点不是包，是发布物与状态文件。**

```
main 源码 + 根 manifest（产品版本权威）
  ↓ CI build + stamp
release asset tar（per platform/arch/nodeAbi，_release/manifest.json + _release/product-identity.json）
  ↓ publish-release-metadata.mjs（ed25519 签名；publicationSequence 单调+1）
gh-pages: channels/<c>.json + releases/<id>/metadata.json
  ↓ ReleaseManager.check()（TUF 验签；release-manager.ts:523）
UpdateCheck 决策（release-policy：sequence_regression / downgrade_blocked / 破坏性迁移拒绝）
  ↓ ReleaseManager.apply()（事务 journal-first）
installer()（双 slot 写入 ~/.pd/runtime + 备份/恢复）
  ↓ commit 点（唯一写者）
~/.pd/active.json（productVersion / releaseId / generation）
  ↑ 只读消费
pd version --json / Console / 下次 check()
```

npm 上的 `create-principles-disciple` 包版本只是**引导安装器的版本**，
不在这条链的判定轴上（判定轴 = `publicationSequence` + 策略，见 version-model.md §D）。

---

## 9. Host Integration Graph（C7）

```
OpenClaw 宿主
  ├─loads─▶ ~/.openclaw/extensions/principles-disciple（openclaw.plugin.json 是其发现契约）
  │           └─uses─▶ ~/.pd/runtime（core 经 junction；hooks/pd-hook.cjs spawn runtime）
  ├─发现规则─▶ extensions/ 的【每个子目录】都会被当作插件扫描
  │           ⇒ 备份目录不得留在 extensions/ 内（installer.ts:1058-1070 migrateLegacyPdBackups
  │             的存在就是这条宿主页约束的化石证据）
  └─devDeps─▶ @principles/host-runtime（仅编译期协议对齐，装机后无 npm 关系）

$pd-setup（plugins/principles-disciple/scripts/pd-setup.cjs）
  ├─reads──▶ runtime-version.json pins
  ├─execs──▶ npm install @principles/{host-runtime,core,codex-adapter}@<pinned>（:144-145）
  └─requires▶ 全局 pd-cli（:171 fail 提示 `npm install -g @principles/pd-cli`）

pd-companion（Electron）
  └─spawns──▶ `pd console open --json --no-browser --no-auth`（main.ts:8 注释）
              ── 依赖的是【已安装的 pd CLI 二进制】，不是 workspace 包
pd-console server
  └─spawns──▶ node ~/.pd/bootstrap/dist/bootstrap-entry.js（routes/update.ts:71,107）
              ── 进程边 + 文件系统边，无 npm 关系
Codex 宿主 ◀──adapter── codex-adapter（协议边；codex-adapter/tests/codex-plugin-bundle.test.ts
              同时校验 runtime pins——测试也在守这条边）
```

---

## 10. Hidden Dependencies（package.json 看不到的关键边 + 风险表）

| # | Hidden Edge | Why Hidden | Failure if missed | Current Guard |
|---|---|---|---|---|
| R1 | console 变更 ──▶ installer 必须重发 | console 是 private，不在任何发布矩阵；分发通道只有 bundle | UI 改动在 main 上永远到不了用户（PRI-558 实际发生过） | ✅ CI detect 自动追加 installer（`publish-npm.yml:225-238`） |
| R2 | plugin 发布 ──▶ installer 必须同列车 | plugin 被捆进 installer 载荷 | /check 与 /apply-full 分叉 → 永久假更新提示 | ✅ CI detect 强制（`:203-224`）+ 列车 installer 最后发 |
| R3 | runtime pins ──▶ npm 上必须已存在该精确版本 | pins 是纯人工 JSON，与任何 graph 工具无关 | `$pd-setup` 装不出 runtime / 装出缺能力地板的 runtime（PRI-810） | ✅ `check:runtime-pin`（真实能力探针）；⚠️ 改 pins 本身无 CI 门 |
| R4 | 发布顺序 ──▶ registry 传播延迟 | 时序问题不出现在任何静态清单 | 列车中途 npm install 解析失败 | ✅ `check_published` 5×15s 重试 |
| R5 | installer 常量 ──▶ core 常量值相等 | 注释约定（"Keep in sync"），无类型/导入连接 | 配置键漂移：installer 写入的 hook 键 core 读不到 | ❌ **无任何自动 guard**（仅记录，不实现） |
| R6 | 嵌套 bundle 副本 ──▶ 被工具误当 workspace 成员 | git 跟踪的生成物，与 canonical 同名 | 版本工具/扫描器作用面错误（Changesets 评估的决定性问题） | ❌ 无 guard（audit F9；§12 矩阵） |
| R7 | OpenClaw 扫描 extensions 所有子目录 ──▶ 备份位置约束 | 宿主行为，不在 PD 代码里 | 重复插件告警 / 双实例 | ✅ installer `migrateLegacyPdBackups()` 吸收历史违规 |
| R8 | companion ──▶ 已安装 `pd` CLI 可执行文件 | 进程 spawn，无包依赖 | 新 shell 无 CLI 时 companion 起不了 console | ⚠️ 运行时报错路径，无发布前测试 |
| R9 | 载荷 `_release/product-identity.json` ──▶ 列车产品版本 | stamp 在 runner 内生成 | 无 stamp 载荷被当正式安装源 | ✅ installer fail-closed（缺 stamp = 非正式构建） |

---

## 11. If I Change X, What Is Affected?

判定次序：先沿 C1/C2 看编译面，再查本节 C4/C5/C6 分发面。**"may require"取决于
改动是否进入对应发布物的内容；不要把 may 读成 must。**

### 修改 core
- rebuild：always（自身）；host-runtime/codex-adapter/pd-cli/plugin/console 若 typecheck 需其新 dist——CI build 序已保（C2）。
- npm publish：core 自己进 matrix 即可；**但**若改动要到达用户，见下两条。
- installer 重发：**requires if** 改动需到达已装 runtime——运行时有两条 core 供给线：
  (a) ReleaseManager 更新链（re-bundle 载荷里的 core）；(b) `$pd-setup` pins 线
  （装 npm 上的 core）。走 (a) 必须随列车重发 installer（C4）；走 (b) 必须人工升 pin（C5/§7）。
- runtime pin：**requires if** 依赖方（pins note 的能力地板）需要新能力。
- product release：**may require**——产品版本推进是独立决策（version-model.md）。
- plugin manifest/根 manifest：不受影响（不共用版本号）。

### 修改 pd-console
- npm publish：**never**（private，永不发布）。
- installer 重发：**always required**（C4 唯一分发通道；CI 自动强制，R1）。
- 产品版本：**不因此相等**——console 0.1.0、installer 版本、产品版本三条线各走各的
  （这正是 V6 的答案：console 内容进了 installer 载荷 ⇒ 载荷要重发；载荷重发 ⇒
  载荷身份由 product-identity stamp 表示；它与 console 的 package version 无任何相等义务）。

### 修改 OpenClaw plugin
- npm + ClawHub 发布（6/7）；openclaw.plugin.json 版本由 CI 发布时 sed 对齐（必须一致对，version-model.md）。
- installer 重发：**always**（R2 强制边）。
- 宿主用户经 npm/ClawHub 升级插件本体；`~/.pd/runtime` 用户经更新链拿到 bundled 插件——两条到达路径同物不同源（audit §5.3）。

### 修改 host-runtime
- 下游 C1：codex-adapter、pd-cli、plugin(dev)、console 重新解析到新 semver range（**下次发布时**，不是立刻）。
- C3：必须晚于 install-layout 发布（exact-dep 注释 + preflight 门）。
- plugin 的 npm 装机结构不依赖它（devDeps 仅编译期）；运行时经 `$pd-setup` pins（人工）与 bundle（C4）。

### 修改 installer
- 自身发布 7/7；**它不自动重发上游**——bundle 副本从 npm registry 现取版本（C4），
  未重发的上游组件保持旧 npm 版。
- 产品身份：installer 载荷携带列车 stamp（R9）；根 manifest 不受 installer 版本影响。
- 已装端 ReleaseManager 更新链由 release-metadata 发布驱动（C6），与 npm installer 包发布是两个出口，须保持 lockstep（R2 的成因）。

### 修改 Companion
- 触发条件：push `companion-v*` tag → 独立构建 .exe。**不触碰** npm 列车、pins、
  channel 元数据、产品版本（ADR-0023 §2.7 独立生命周期）。
- 若其依赖的 console 行为变化：那是 console→installer 链的事，companion 只是 spawn 方（R8）。

---

## 12. Tool Visibility Matrix（供 PRI-879，仅结构性预判）

| Dependency edge | npm workspace 可见 | Changesets 预计可见 | Nx 免配置预计可见 |
|---|---|---|---|
| pd-cli ──▶ core 等 C1 声明边 | YES | YES | YES |
| installer ──▶ core（type-only，未声明） | NO | NO | PARTIAL（nx 可扫 import） |
| installer ──▶ core 常量镜像（R5） | NO | NO | NO |
| build 序 host-runtime ⇐ install-layout dist | NO | NO | PARTIAL（nx targets 依赖需声明） |
| 列车发布顺序 + registry preflight（C3） | NO | YES*（changeset 按依赖序 version/publish） | YES*（同样只到 registry 为止） |
| plugin ──▶ installer 强制边（R2） | NO | NO | NO |
| console ──▶ installer bundle（R1/C4） | NO | NO | NO |
| release-locks / bundledPluginVersion stamp | NO | NO | NO |
| pins ──▶ published npm artifact（R3） | NO | NO | NO |
| channel 元数据 ──▶ ReleaseManager ──▶ active.json（C6） | NO | NO | NO |
| OpenClaw 加载 / extensions 扫描约定（C7/R7） | NO | NO | NO |
| companion spawn pd CLI（R8） | NO | NO | NO |
| 嵌套副本幽灵成员（R6） | **误可见**（会被扫入） | 未验证（PRI-879 实测项） | 误可见 |

**结论性预判**：第三方版本工具至多覆盖 C1/C3（registry 为止）；
C4-C7 全部 13 条关键边中对工具可见 0 条。任何"引入工具即可统一发布管理"的
预期都不成立。（本矩阵不构成引入建议，工具决策在 PRI-879。）

---

## 13. AI Agent Rules

1. **不要根据 package.json dependency graph 推断完整产品影响面**——先查 §5/§6/§10
   的 C3/C4/隐藏边（典型反例：改了 console 以为"没人依赖它"，实际 R1 决定用户能否收到）。
2. **"需要一起发布"不代表"版本号应该一致"**——R1/R2 是 assembly/distribution 边，
   版本义务由 version-model.md 定义，两者无关。
3. **不要为了让 npm 依赖图"完整/漂亮"，把 bundle/runtime/host 关系改写成 package
   dependency**——C4 是复制、C5 是文件系统链接、C7 是宿主约定；声明成 deps 会
   改变真实安装语义并可能引入装机 npm install 行为。
4. **修改 runtime pin 前必须确认目标版本已真实发布且能力已验证**——pins 指向
   published artifact（R3），必须跑 `check:runtime-pin`，永远人工。
5. **修改 package/version/release 相关代码前，先给涉及关系归入 §2 的某一类**，
   并在 PR 描述里写明类别；跨类改动（如同时动 C3 和 C4）需要分开论证。
6. 嵌套 bundle 副本（`create-principles-disciple/{core,…}`）与 `release-locks/**`
   是生成物/锁定记录，**不得手工编辑**，也不得作为 canonical 源码引用。

---

## 14. Known Unknowns 与 Pending Changes

**Pending: PR #1781（检查时仍 OPEN，基线 f3ef3102）**
不改变本文件的任何依赖边结构；改变的是版本治理行为：
根 manifest 1.76.1→2.1.0、新增 `check-product-version-channel.mjs` 发布门与
`product-version-drift.yml`（为 §8 链首增加"main ≥ channel"不变量）、
`sync-version.sh` 不再触碰根 manifest、`scripts/release.sh` 停用。
合并后请核对 §8 与 version-model.md 示例列。

**Unknowns（仅记录）**
1. `.cnb.yml` 与 GitHub workflows 并存，实际执行平台未在只读调查中证实（audit Unknowns #1）。
2. ClawHub 同步失败时的人工兜底流程无仓内文档。
3. release-locks 的生成/消费闭环：文件存在且 git 跟踪，但打包时是否强制刷新、
   何处读取，未逐行核实。
4. R5（PRI-343 常量镜像）是否有隐性测试覆盖——未发现 guard，不排除 fixture 偶然覆盖。
5. companion 对全局 `pd` 的版本兼容性范围（R8）无声明的最低版本。
