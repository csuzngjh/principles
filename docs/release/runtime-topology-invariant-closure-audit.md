# Runtime Topology Invariant Closure Audit — PRI-923（只读收敛审计）

- 日期：2026-09-25 · 基线：main @ `6199897a`（Version PR #1870 squash 合并提交）
- 性质：**只读审计**。未修改任何生产代码、guard、topology、installer 或 release pipeline。所有行号/文件名均为基线 checkout 实测。
- 目的：把 PRI-912/913/918/919/920/921/922 已确认的 runtime 拓扑事实收敛为一张 **Runtime Topology Invariant Matrix**——哪些不变量已由自动守卫保护，哪些仍依赖人工记忆/纪律，并给出 Keep / Strengthen / New Ticket 分级建议（**只建议，不实施**）。
- 前置文档（本审计的证据来源，均已在 main）：`runtime-topology-audit.md`（PRI-920 RTA）、`junction-lifecycle-audit.md`（PRI-913）、`runtime-previous-json-audit.md`（PRI-921）、`artifact-hygiene-gate-audit.md`（PRI-918）。
- 本文是**取证快照，不是 SSoT**：行号会随演进漂移；机制权威始终是被引用的 guard/测试/工作流本身。

---

## TL;DR

安装面（`~/.pd` runtime）的核心不变量在 PRI-920 之后已基本机械化：writer 唯一性有 merge-time 静态守卫（Guard A），落盘拓扑有 settled-install 断言（Guard B），junction 生命周期有五阶段回归门，previous.json 幽灵槽已退役并有负向测试。**成熟度评级：B**。

拉开与 A 差距的是**发布边界**：2026-09-25 的发版验证实测证明 cohort 绑定是一条"靠人工合并姿势成立、且断链一周零告警"的隐性不变量——Version PR 自 #1852 后被改用 squash 合并，火车两次 dispatch 失败（auto 路径在 detached 检出下直接 fatal），npm 链静默断链、1.144.4/5/6 三个版本号烧掉。该缺口与 PRI-913~922 的改动**无关**（它们是受害者视角的验证），但暴露了同类结构：凡"约定正确但无机械防线"的地方，ERR-137 模式就会重演。修复票已立（Linear 实号 PRI-922，号位复用）。

---

## 1. Invariant Matrix

判定列口径：**Keep** = 现有保护充分，本审计不提议改动；**Strengthen** = 不变量真实且有自动保护，但存在明确可机械化的小缺口，建议作为后续小票/搭车项；**New Ticket** = 缺口需要独立裁决（产品或机制决策），不应塞进任何在途任务。

### 1.1 Runtime Layout

| # | 不变量 | 已确认事实来源 | 保护机制（实测） | 自动化程度 | 判定 |
|---|---|---|---|---|---|
| L1 | canonical 组件目录 = `~/.pd/runtime/<component>` 稳定目录；`active.json` 记身份不记路径、`install.json` 是布局指针 | ADR-0023 §2.1 / RTA §1 | `installed-layout.test.ts`（canonical wins :135/:182）、Guard B settled 断言经生产 reader API（`resolveInstallLayout`/`getInstallLayoutPaths`） | 自动（PR fast lane） | Keep |
| L2 | 各组件 `node_modules/@principles/*` 依赖槽 junction → canonical，禁止物化拷贝漂移 | PRI-912 | 三层：`plugin-core-junction.test.ts`（15 例单元，包 CI）；Guard B 对 `installConsole()` 两条依赖链接的显式 realpath 断言；`release-junction-lifecycle.test.ts`（全生命周期，仅发布火车腿，见 R14） | 自动（单元+settled 在 PR 快线；生命周期在火车） | Keep（快线盲区属成本设计，见 §3 N2） |
| L3 | runtime 树零数据（R3）：不出现 `.db/.sqlite/config.yaml/.state` | ADR-0023 §2.1 / RTA I3 | Guard B：真实 `install()` 落沙箱 HOME 后全树扫描 + S2 失败注入（事务外直写 `runtime/core/state.db` → 断言炸） | 自动 | Keep |
| L4 | 不存在 `~/.pd/state`；工作区可变状态根 = `<workspace>/.pd` | RTA §1 事实修正 | Guard B 显式断言 `~/.pd/state` 不存在 | 自动 | Keep |
| L5 | `previous.json` 幽灵槽已退役：layout 无 `previousRecordPath`、恢复裁决无该入参、任何 writer 不得复活 | PRI-921 审计（B 类）→ PRI-922 实现 | 行为负向测试 ×3（含"伪造 previous.json 不得翻转恢复裁决"单元+端点两腿） | **半自动**：裁决不被翻转有测试锁，但"文件/槽位不得再现"无机械防线——Guard A token 列表（`check-runtime-writers.mjs` 实测 grep `previous` 零命中）不含 `previous\.json`；Guard B 只扫数据后缀，不断言 `~/.pd` 根精确文件集 | **Strengthen**（低危）：Guard A token 补一条 + Guard B 补根文件集断言，二选一即可封死复活面 |

### 1.2 Writer Ownership

| # | 不变量 | 来源 | 保护机制 | 自动化程度 | 判定 |
|---|---|---|---|---|---|
| W1 | `install()` 是唯一部署 writer（ADR-0024 §2.1）；bootstrap/ReleaseManager 汇聚到它，console 零直写（D-1） | RTA §2 writer 矩阵 | **Guard A** `scripts/check-runtime-writers.mjs`：runtime 路径 token × 写原语共现扫描 + 9 条 SSoT 双向白名单（越界 FAIL、陈旧条目也 FAIL，ERR-146 防线），挂在 `verify:merge` 尾棒 | 自动（每次 PR 合并门禁） | Keep |
| W2 | `install.json` 双写者契约：installer 之外的合并保持写（PRI-709 merge-preserving） | RTA §2 | `installer.test.ts:204/:252` 等：字段缺省保盘值、hosts 合并、workspace 注册三套件 | 自动 | Keep |
| W3 | 旧开发链 `install.mjs`/`sync-plugin.mjs` 永久拒绝执行（PRI-868） | RTA §2 / ERR-137 | 脚本内无条件拒绝守卫 + verify:merge 覆盖 | 自动 | Keep |
| W4 | repair 不部署 payload、零触碰 node_modules（D-4） | RTA §2 | `repairUpdateChain` 结构（installer.ts:569-626 不 import 部署面）+ Guard A 白名单约束 + PRI-913 生命周期门 Phase 3 真实调用零接触断言 | 自动 | Keep |

### 1.3 Recovery State

| # | 不变量 | 来源 | 保护机制 | 自动化程度 | 判定 |
|---|---|---|---|---|---|
| R1 | journal-first：状态链 planned→…→confirmed 先记账后动手；失败落入既有回滚通道不新增状态 | ADR-0024 §2.2/§2.4 | installer-journal / active-record / transaction-recovery 测试族 | 自动 | Keep |
| R2 | `active.json` 是恢复唯一身份权威；strict reader fail-loud（corrupt→throw，不猜） | ADR-0023 §2.5 / PRI-922 收敛后 | corrupt-throw 单测 + `update-state-contract.test.ts` 钉住恢复端点契约（含删除 previousRecord 入参后的新签名） | 自动 | Keep |
| R3 | 备份 retention：成功确认后保留当前 + 一份旧备份，多余裁剪 | PRI-853 | **仅源码文本断言**：`mvp-config.test.ts:1195-1210` 用 `indexOf('retainSupersededBackup(...)')` 锁调用顺序，retention 计数/裁剪语义本身无行为单测（行为观察散落在 PRI-913 生命周期门） | **半自动**：调用位置有锁、行为无锁 | **Strengthen**：把 indexOf 断言升级为行为单测（造 N 份备份跑真函数断言存活集合），可搭车任何动 backup 的票 |
| R4 | 启动时非终态 journal 由 reconcile 收编 | RTA §2 bootstrap 行 | transaction-recovery 测试族 | 自动 | Keep |

### 1.4 Installer Lifecycle

| # | 不变量 | 来源 | 保护机制 | 自动化程度 | 判定 |
|---|---|---|---|---|---|
| C1 | junction 在 install/upgrade/rollback/repair/uninstall 五阶段存活且安全（G1-G7） | PRI-913 审计 | `release-junction-lifecycle.test.ts`（真实 installer 事务、含 Windows reparse job）+ `release-upgrade-gate.test.ts` N-1→N 真升级 | 自动（**火车专属**，见 §3 N2） | Keep |
| C2 | payload 无身份戳则拒装（I4 refuse-unstamped）；active.json 记 sourceCommit/releaseMetadataDigest | RTA §4 / PRI-911A | installer.ts 拒戳路径 + embedded-product-identity 测试 + Guard B 身份字段相等断言 | 自动 | Keep |
| C3 | 发布产物卫生：dist/payload/npm-tarball 三腿拦截 | PRI-918 | verify:merge 三腿（pack 用 `--ignore-scripts` 等坑已注释固化） | 自动 | Keep |
| C4 | satellite bundle 尺寸预算 | PRI-919 | `SIZE_BUDGETS` SSoT + esbuild metafile 门（每次 build 跑） | 自动 | Keep |
| C5 | plugin↔runtime 能力 pin 对齐 | codex-adapter pin 契约 | 脚本 `check:runtime-pin` 存在但**无任何自动调用者**（root package.json:28，CI/lefthook grep 零命中）；仅有 codex-adapter `runtime-pin-guard.test.ts` 下限守卫 | **靠人工记忆**（人记得才跑） | **Strengthen**：接入 verify:merge 尾棒或发布 preflight，一行接线级别；不接线则该不变量实质无人守 |

### 1.5 Release Boundary

| # | 不变量 | 来源 | 保护机制 | 自动化程度 | 判定 |
|---|---|---|---|---|---|
| N1 | **cohort 绑定**：一次发布=一个 Version PR 合并 SHA，身份由复现证明（SPEC §17）；resolver 硬要求**双父 merge commit**（`resolve-release-cohort.mjs:59`） | publish-npm.yml / resolver | **实测已断**：#1858/#1862/#1864/#1870 均 squash（p=1），auto 扫描 `git rev-list --merges main` 找不到 cohort；`resolver:106` 在火车的 detached-SHA tools 检出（`fetch-depth: 0`，无本地 `main` ref）上直接 fatal；周 cron 把"窗口无 cohort"当 exit-2 干净 no-op → **npm 链断链两天、烧 1.144.4/5/6、零告警**（run 36094167454 / 36094525933 取证）。resolver 本身零测试覆盖 | **断裂**（2026-09-25 实证） | **New Ticket：已立**（Linear PRI-922 号位复用，题=修复发布火车断链：squash 兼容裁决 + detached main 修复 + 断链告警 + resolver 单测） |
| N2 | 火车重试幂等（精确 `name@version` 查 registry，gitHead 溯源） | SPEC §18/§24 | 火车各腿运行时逐包核查（本次失败运行验证了 fail-loud 端；成功端有历史 v2.0.4 运行） | 自动 | Keep |
| N3 | 产品版本链（根 package.json version）与签名频道链由 Owner 手动推进 | PRI-874 / skill 三条链模型 | `release-metadata.yml` 的 product_version 降级拒绝守卫；**手动 dispatch 本身是治理设计**（对外发布须人点头），不是缺口 | 人工（by design） | Keep |
| N4 | 「合并 → 火车」自动派发腿：`version-packages.yml:84-97`（push 到 main 即跑，`--is-cohort` 复现证明通过才 dispatch，绑定该 SHA） | SPEC §16/§17 | **存在且工作正常——但门与 N1 同门**：squash 的 Version PR 合并 push（run 36093288167 @ `6199897a`）绿且只 `echo "Not a release cohort"`，不派发也不变红。自动腿本身不需要新机制，需要的是"识别为 Version PR 形状却没派发"时的告警（归入 N1 缺口 3） | 自动（受 N1 断裂牵连） | Keep（修复随 N1 票，勿单开） |
| N5 | plugin bundle 级 digest 登记（0023 §2.3 后半） | RTA §5 G4 | 未实现 | 无 | New Ticket（RTA 已登记为独立 SPEC 范围，勿并入它票） |
| N6 | settled 安装两版之间的带外漂移检测（pd doctor，0023 §2.9 Phase 1） | RTA §5 G3 | 未实现（规划中的 runtime 功能） | 无 | New Ticket（RTA 已排除出 guard 任务范围，维持独立） |
| N7 | `history.jsonl` 是恢复/审计叙事的一半：pd-cli `version-report.ts:251` 真实读 `<pdHome>/logs/history.jsonl`，但 `appendHistoryEvent`（update-history.ts:99）**生产零调用**；pd-cli 测试自己造文件 | 本审计实测 | 无（死 writer 不会被任何测试炸出来） | 断裂（半接线权威） | **New Ticket**：wire-or-retire 裁决（与 previous.json 同形态：要么 writer 接进事务终态、要么删 reader 链），勿顺手修 |

## 2. Missing Coverage 汇总（按风险排序）

1. **N1 发布火车断链**——已实际发生、影响已量化（3 个版本号 + 组件链静默 2 天，影响面：所有等 npm 更新的新装用户）。三条腿共享同一失效门：`version-packages.yml` 的合并自动派发（`--is-cohort` 拒绝单父 squash → echo-only 静默不派发、push run 仍绿）、周五 cron 的 auto 扫描（detached 检出下 `rev-list ... main` fatal）、以及两者共同的"断链零告警"。→ 票已立。
2. **N7 history.jsonl 半接线**——一个生产 reader 消费着永远为空的文件；version-report 的更新历史段落实际是恒空降级。属 P4 单权威漂移，不是故障源。
3. **C5 check:runtime-pin 无人调用**——脚本存在即安全感，实际 pin 漂移只被下限守卫挡住一半。
4. **L5 previous.json 复活面**——恢复裁决不被翻转有负向锁，但"槽位再现"（layout 字段回加 / 幽灵文件再现）无静态防线；Guard A token 列表实测不含 `previous`。
5. **R3 retention 行为无锁**——indexOf 型断言在函数改名/参数变化时以红测提示，但裁剪计数错误（多删/漏删备份）不会有任何测试变红。

## 3. No-Change Decisions（判定为"不动"并列理由）

- **重量门不进 PR 快线**（C1/L2 生命周期门只在火车跑）：本地实测单腿 14 分钟起，快线成本不可接受；单元层 + Guard B settled 层已在快线兜住大部分漂移面。
- **Owner 手动发版腿保持手动**（N3）：对外发布授权是治理资产，机械化反而破坏审批语义。
- **previous.json 不反向补齐 writer**：与 8eefee1e1 退役理由（同代假回滚）正面冲突，PRI-921 §6 已裁决。
- **pd doctor / bundle digest 登记维持独立范围**（N5/N6）：RTA §7 的排除判定维持有效，本审计不扩大它们。
- **本文档自身不新增 SSoT**：矩阵是快照；权威在各行"保护机制"列指向的代码/工作流。

## 4. Recommended Follow-ups（只列不做）

| 优先级 | 建议 | 落点 | 形态 |
|---|---|---|---|
| P1 | 发布火车断链修复三件套（squash 裁决 + detached main + 断链告警 + resolver 单测） | Linear **PRI-922（已立）** | New Ticket ✅ |
| P2 | `history.jsonl` wire-or-retire 裁决票（reader 有、writer 零的半接线权威） | 新票 | New Ticket |
| P2 | `check:runtime-pin` 接进 verify:merge 尾棒或发布 preflight（一行接线 + changeset） | 小票或搭车 | Strengthen |
| P3 | Guard A token 列表补 `previous\.json`（或 Guard B 补 `~/.pd` 根精确文件集断言，二选一） | 搭车任何动 guard 的票 | Strengthen |
| P3 | `retainSupersededBackup` 行为单测替代 indexOf 断言 | 搭车任何动 backup 的票 | Strengthen |
| P3 | 发版 runbook/技能已同步"合并姿势必须 merge commit"纪律（2026-09-25 完成于用户级 skill），resolver 修复票合并后回标 N4 | — | 已完成/待回标 |

## 5. Complexity Review（本审计交付=文档一件）

```text
New durable source of truth: NO   （快照文档，非权威；权威均指向既有 guard/测试）
New persisted schema/state:  NO
New subsystem/service:       NO
New public abstraction:      NO
New feature flag:            NO
New cross-package dependency:NO
New host-specific behavior:  NO
New external/network capability: NO
```

## 6. Maturity 评级

**B**。理由：安装面核心（writer 唯一 / 零数据 / journal-first / canonical 拓扑 / junction 生命周期 / 产物卫生 / 尺寸预算）已全员机械化且有 merge-time 防线，这是 A 的底盘；但发布边界上仍存在一条**已被现实击穿且静默无告警**的不变量（N1，连带吞掉本已存在的合并自动派发腿 N4），外加一条半接线权威（N7）与一条"记得才跑"的人工腿（C5）——A 级要求"违反必变红"，本轮取证证明该词在发布边界尚不成立。N1 修复票合并 + C5 接线后可升 A-；N7 裁决收口 + previous.json 复活面封死后升 A。

---

## Owner Review Card

1. **Problem**：PRI-912~922 七连票确认后，哪些 runtime 拓扑事实有自动守卫、哪些仍靠记忆，无一张总账；发版验证顺带实测出发布边界一条静默断链。
2. **Before**：各票各留各的审计文档（RTA / junction / previous-json / hygiene），矩阵级"谁在守什么"散落在四份文档 + 会话记忆。
3. **After**：22 行不变量总账 + 5 项缺口排序 + 6 项分级建议；N1 断链完成取证并立票（Linear PRI-922 号位复用），技能文档三处过时表述同步修正。
4. **既有机制复用**：全部证据指向既有 guard（A/B）、既有测试族与既有 workflow，未发明新抽象。
5. **Complexity Delta**：全 NO（见 §5）。
6. **Design reason**：只读收敛是任务硬边界；唯一写动作=新文档 + 用户级技能修正 + 一张 Linear 票，均为记录性质。
7. **Verification**：矩阵每行均来自本会话 file:line 实测（Guard A token 列表、retention indexOf、check:runtime-pin 无 caller、history.jsonl writer 零调用、resolver:59/:106、两次失败 run 日志、npm 1.144.3 现值、四条 Version PR p=1）。
8. **Risk**：快照会漂移——行号/机制随演进过时；已在文档头部声明非 SSoT。
9. **Rollback**：删除本文件即可，无任何代码/机制耦合。
10. **Follow-ups**：见 §4；未做：任何 guard 改动、任何 workflow 改动、任何 resolver 修复（任务禁令）。

---

```text
PRI-923 Audit Complete
Changed: none (production); Created: docs/release/runtime-topology-invariant-closure-audit.md
Finding: Runtime topology maturity: B
Missing guards: cohort 绑定对 squash 合并零防线且断链无告警（已立票 PRI-922）；
  history.jsonl 半接线（reader 无 writer）；check:runtime-pin 无自动调用者；
  previous.json 复活面无静态防线；retainSupersededBackup retention 计数仅 indexOf 保护。
Recommendation: P1 修火车票照 §4 落地；P2 history.jsonl wire-or-retire 立票 + pin-check 接线；
  P3 Guard A token 补 previous.json、retention 行为单测（均搭车，勿单开 PR）。
```
