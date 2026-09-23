# Release Artifact Hygiene Audit — 发布产物卫生审计

- 日期：2026-09-22
- 性质：只读调查。未修改任何代码；所有 `npm pack` 实验均带 `--dry-run --ignore-scripts`（避免触发 prepack 重建写入工作区）。
- 范围：`packages/principles-core`、`packages/pd-cli`、`packages/pd-console`、`packages/pd-companion`（companion），含安装器 `packages/create-principles-disciple` 的打包/复制链路。
- 基线：main @ 48e75c419（工作区含另一会话未提交的 installer package.json 修改，见 §7 局限）。

---

## TL;DR

**发布链路上每一层都在搬运测试产物，且已经落到用户机器。** 根因是一处（测试与源码同放 `src/` 且被 `tsc` 全量编译进 `dist`），经三条链路放大：

1. `@principles/core` npm 包：**57.1% 字节（11.0/19.2MB）、51.3% 文件（1677/3267）是测试产物**；
2. `@principles/pd-cli` npm 包：无 `files` 字段，把 `src/`、`tests/`、`scripts/` 全部发布（677 文件，其中 205 个测试相关）；
3. 安装器 `create-principles-disciple`（76.8MB）：整目录复制各组件 `dist`，携带 **1747 个测试相关文件**进入用户机器。

实测用户机器（只读）：`~/.pd/runtime/core` 19247 文件中 **1576 个测试文件**；`~/.pd/runtime/pd-cli` 更是**双重污染**（自带 68 个 + 内嵌 `node_modules/@principles/core` 再次带入 ~1575 个）；OpenClaw 插件目录 1581 个。另有 stale 产物：core `dist/adapters/` 全树 48 文件（含 12 个测试）的**源码已不存在**，属于 tsc 无 clean 增量构建的历史残留。

---

## 1. 污染链全景

```
src/**__tests__**/*.test.ts   (测试与源码同放 src/)
        │  tsc include:["src/**/*"]，无排除        ← 根因 [F1]
        ▼
dist/**__tests__**/*.test.js(+.d.ts+.map+.snap)
        │                                ┌──────────────┐
        ├─ files:["dist"] → npm 包       │ stale 孤儿树  │ ← tsc 无 clean [F5]
        │  (@principles/core)            └──────────────┘
        ├─ 无 files 字段 → src+tests+dist 全发布
        │  (@principles/pd-cli)                    [F2]
        ▼
bundle-plugin.mjs: cpSync('dist', …, {recursive:true}) 整目录复制，无过滤
        │                                          [F3]
        ▼
create-principles-disciple npm 包 (76.8MB, 1747 test 文件)
        │  npx 安装
        ▼
~/.pd/runtime/*  与  ~/.openclaw/extensions/principles-disciple/
  实测 1576+1581 个测试文件在用户机器上               [F4]
```

---

## 2. 分项发现与证据

### F1 — 测试被编译进 dist（Q1）｜分类 A：Build configuration issue

**机制**：四个包的 tsconfig 均 `rootDir: src` + `include: src/**/*`，测试文件与源码同放 `src/` 即被全量编译。排除项不含 `**/__tests__` 或 `*.test.ts`。

| 包 | src 内测试文件数 | dist 总文件 | dist 内 test 文件 | `__tests__` 目录 |
| --- | --- | --- | --- | --- |
| principles-core | 384（`*.test.ts`） | 3265 | **1636 (50.1%)** | 30 |
| pd-cli | 17 | 448 | 68 (15.2%) | 2 |
| pd-console | 2 | 335 | 4 (1.2%) | 1 |
| pd-companion | 0（测试在包根 `tests/`） | 7 | **0（干净）** | 0 |

**证据（file:line）**：
- `packages/principles-core/tsconfig.json:21-22` — `"include": ["src/**/*"]`，`"exclude": ["node_modules", "dist", "tests"]`（顶层 `tests` 被排除，`src/` 内的不排除）。
- `packages/pd-cli/tsconfig.json:24-25`、`packages/pd-console/tsconfig.json:16-17`、`packages/pd-companion/tsconfig.json:19` — 同模式。
- core 的测试同放证据：`src/evolution-store.test.ts`、`src/host/__tests__/`、`src/runtime-v2/**/__tests__/`（共 384 个 `*.test.ts`）。
- **companion 是机制反证**：它的测试放包根 `tests/`（不在 `src/`），其 dist 仅 7 文件、零测试 → 证明污染源就是"测试放 src/ + tsc 全量编译"，不是别的。

**复现命令与实际输出**：
```bash
cd packages/principles-core && npx tsc   # 即 npm run build
find dist -type f \( -name "*.test.js" -o -path "*__tests__*" \) | wc -l
# 实际输出: 1636
```

**零消费价值证明**：`packages/principles-core/vitest.config.ts:7` 的 `include` 全部指向 `src/` 与 `tests/`，vitest 从不执行 dist 内测试；生产代码无任何 `import … *.test.js`。

### F2 — dist 及测试进入 npm 包（Q2/Q3）｜分类 B：Package publishing issue

**`@principles/core`**（`files: ["dist"]`，package.json:55-57）——dist 干不干净直接决定 npm 包干不干净：

```
命令: npm pack --dry-run --ignore-scripts --json
实际输出: total files: 3267, unpacked 20.2MB
  可疑文件: 1677 (51.3%)
  明细: test_js=409, test_dts=409, maps=838, snap=1, fixture=20
  字节占比: test相关 11.0MB / 总 19.2MB = 57.1%
样例: dist/adapters/__tests__/code-review-pain-adapter.test.js (14826 B)
```

**`@principles/pd-cli`** — **package.json 全文（1-42 行）没有 `files` 字段，也无 `.npmignore`**：

```
命令: npm pack --dry-run --ignore-scripts --json
实际输出: total files: 677, unpacked 5.6MB, 可疑 205
by top-level: dist=448(含68 test), src=111, tests=111, scripts=2, 其余=5
额外发布物: scripts/llm-dogfood.ts (18778 B),
           scripts/migrate-illegal-expected-decision.ts (9780 B)
```

即 **整个单元测试套件和开发脚本随包发布**，未编译的 `src/` 与编译后的 `dist/` 双份并存。

**`@principles/install-layout`**（`files: ["dist"]`）— 其 dist 内有 `dist/index.test.js` + `.d.ts`，同样发布（量小，同类问题）。

**`@principles/pd-console`、`@principles/pd-companion`** — 均 `"private": true`，不走 npm 发布（它们的暴露面在 F3/F4）。

### F3 — 安装器整目录复制 dist（Q2/Q3 bundle scan）｜分类 C：Installer issue

**证据（file:line）**：`packages/create-principles-disciple/scripts/bundle-plugin.mjs`
- 86-153 行：`*_REQUIRED` 清单均含 `'dist'`（仅作存在性检查）；
- 复制循环对 `'dist'` 项执行 **整目录无过滤递归复制**：
  - plugin: 229-237 行；pd-cli: 259-267 行；console: 275-285 行；core: 298-308 行；host-runtime: 318-328 行；codex-adapter: 338-348 行；
  - 形如 `cpSync(src, join(DEST, 'dist'), { recursive: true })`，无 exclude。

**实测安装器内嵌 payload（仓库工作区现状，即上次 bundle 的输出）**：

| payload 目录 | 总文件 | test 相关 |
| --- | --- | --- |
| `create-principles-disciple/core/` | 3266 | **1665** |
| `create-principles-disciple/pd-cli/` | 449 | 68 |
| `create-principles-disciple/console/` | 336 | 4 |
| `create-principles-disciple/plugin/` | 368 | 4 |
| `create-principles-disciple/install-layout/` | 5 | 2（`dist/index.test.js/.d.ts`） |
| host-runtime / codex-adapter | 57 / 35 | 0 |

**安装器 npm 包整体**（`files` 字段 `package.json:20-34` 覆盖全部 payload 目录）：

```
命令: cd packages/create-principles-disciple && npm pack --dry-run --ignore-scripts --json
实际输出: total files: 4841, unpacked 76.8MB
  test相关文件: 1747 (字节 11.4MB / 76.8MB = 14.9%)
样例: core/dist/adapters/__tests__/code-review-pain-adapter.test.d.ts
      console/dist/ui/utils/__tests__/onboarding-state.test.js
```

这是 `npx create-principles-disciple` 实际下载的内容。

### F4 — 用户机器实测（live 证据，只读 ls/find）

```
~/.pd/runtime/core:            总 19247 文件, 其中 test 文件 1576
~/.pd/runtime/pd-cli:          总 20207 文件, 其中 test 文件 1643
  └ 集中于 pd-cli/node_modules/@principles/core/dist/**/__tests__
    (135+87+23+19+15… 按目录计数) —— 被污染的 npm 包作为依赖二次安装
~/.openclaw/extensions/principles-disciple:  test 文件 1581
```

结论：污染已经历"编译 → 发布 → 安装"全链，**当前 live runtime 就是带测试产物运行的**。runtime 的 pd-cli 因自含 `node_modules` 依赖树而双重中招。

### F5 — Stale artifact（Q4）｜分类 D：Historical artifact

根构建无 clean：root `package.json` 的 `build` 逐 workspace 跑 `tsc`，**无任何 clean 步骤**；tsc 增量构建不删除源侧已消失的输出 → dist 积累孤儿文件。

孤儿扫描方法：dist 内每个 `.js` 在 `src/` 找对应 `.ts/.tsx/.jsx`（含 tsx 修正后的复扫）。

| 包 | 孤儿 .js 数 | 内容 |
| --- | --- | --- |
| principles-core | **60** | `dist/adapters/` **全树 48 文件（含 12 个 test 文件）**：`code-review-pain-adapter` 等在任何 src 中已不存在（`rg` 全仓 src 零命中），adapter 目录整体退役后 dist 未清 |
| pd-console | 12 | `dist/server/update/legacy-mutation-journal.js`、`mutation-controller.js`（`src/server/update/` 不存在）+ 8 个已删除 UI 组件的残留 |
| pd-cli | 1 | `dist/commands/runtime-internalization-context-trace.js` |
| pd-companion | 0 | — |

**本机残留（gitignored，不属仓库内容）**：
- `packages/pd-companion/` 下同时存在 `release/`、`release-2/`、`release-candidate/`、`release-local/` 四个输出目录，而 `electron-builder.yml:8` 只声明 `output: release`。`release-local/` 达 **416MB**（含 `pd-companion-0.1.2-setup.exe` + `win-unpacked/`）。`.gitignore:51` 覆盖 `release*/`。
- `packages/dist/web/assets` — 空目录骨架（`.gitignore:47` 的 `dist/` 模式匹配产物），孤儿。

**附带发现（分类 B 边缘）**：pd-cli 发布的 `scripts/migrate-illegal-expected-decision.ts` 属一次性迁移脚本（名称含 "migrate-illegal"），作为 npm 包内容发布既增重又扩大审计面。

---

## 3. 五个问题的直接回答

- **Q1 为什么 `__tests__` 会进 dist？** 测试与源码同放 `src/`（core 384 个 `*.test.ts`），tsconfig `include: ["src/**/*"]` 且排除项不含测试模式，`tsc` 将其与源码一并编译（companion 的干净 dist 反证了这一机制）。
- **Q2 dist 是否进入 npm/package/installer？** 是，三条路：core `files:["dist"]` 直发；pd-cli 无 `files` 全发；安装器 `bundle-plugin.mjs` 整目录 `cpSync('dist')` 后随 `files` 字段进入 `create-principles-disciple` 包。
- **Q3 发布产物是否包含 test/fixtures/snapshots？** 是。npm 层：core 1677 个可疑文件（含 1 个 `.snap`、20 个 fixture）；pd-cli 205 个；安装器层 1747 个。
- **Q4 是否存在 stale artifact？** 是。core `dist/adapters/` 48 文件全树孤儿（源码已删）、console 12 个孤儿（含整个 `server/update` 子树）、pd-cli 1 个；另有本机 416MB `release-local/` 与多版本 release 目录残留、空 `packages/dist/` 骨架。
- **Q5 最佳修复边界在哪？** 见 §4。

## 4. 修复边界与建议实施顺序（不含代码方案）

按"根治 → 发布面 → 纵深防御 → 清理"排序：

1. **P1 — 构建层（分类 A，根治，体量最大）**：在 tsc 编译范围内排除测试（或调整测试落位），并给构建加 clean 语义以消灭 stale 孤儿树。修此处后，dist 即干净，下游两层自动受益。验证边界：`vitest.config.ts` 的 include 全部指向 src/tests，dist 内测试零消费，排除不影响任何生产路径；需回归验证无跨包消费 dist 测试文件。
2. **P2 — 发布清单层（分类 B，低成本高收益）**：pd-cli 补 `files` 白名单（dist + README/LICENSE 等必要文件），一次性消除 src/tests/scripts 的 224 个多余发布文件；install-layout 同法处理 `index.test.js`。注意涉及已发布包内容变化，走正常 changesets/发版链。
3. **P3 — 安装器层（分类 C，纵深防御）**：`bundle-plugin.mjs` 的 dist 复制增加测试产物过滤，并在 bundle 后断言 payload 零测试文件（可挂入现有 `verify:build` / `check:generated-artifacts` 一类守卫——经查这两个现有守卫均不扫描 dist 测试污染，属自然扩展点）。这是到达用户机器前的最后一道闸。
4. **P4 — 残留清理（分类 D）**：孤儿 dist 树随 P1 的 clean 语义自然消失；本机 `release-local/`（416MB）等属破坏性清理，须按 `docs/process/DATA_CLEANUP_GUIDELINES.md` 走 Owner 决策，不并入工程 PR。

顺序理由：A 不修，B/C 只是反复过滤同一病灶；B/C 不修，A 的回归（未来有人再把测试放进 src）会重新无声漏到用户机器。三层各有独立验证面，可拆三个小 PR。

## 5. 影响（Impact）

- **体积**：`@principles/core` npm 包 57.1% 字节、安装器包 14.9% 字节为测试产物；安装器解包后 76.8MB 中 ~11.4MB 纯属浪费，且随每次更新重复下载/写入。
- **用户机器**：live runtime 实测 1576+1643+1581 个测试文件，污染已落地并在每次升级中保持。
- **审计/安全面**：发布的测试代码含 fixture 与快照，扩大第三方（ClawHub/npm 审计）静态分析面；PRI-547 曾因同类问题清理过 plugin scripts，本发现属同族。
- **正确性风险（低但存在）**：stale 孤儿树意味着"dist 内容 ≠ src 内容"，任何以 dist 为准的行号/SourceMap 诊断都可能指向已删除的代码。
- **性能/行为**：未发现 dist 内测试被执行的路径（vitest 只跑 src/tests），故属卫生问题而非行为缺陷。

## 6. 风险（修复时需注意）

- 移除 dist 内测试前需全仓确认无 `import` 指向 dist 测试/`__tests__` 内部模块（本次抽查未发现，但属 P1 的必要验证步骤）。
- pd-cli 加 `files` 白名单会改变已发布包内容，须确认无消费者依赖 `src/`（如 sourcemap 调试、类型直引 src）——当前 exports/main 全指向 dist，风险低。
- 安装器 payload 目录的 package.json 当前处于另一会话未提交的修改状态（见 §7），实施 PR 需先与该工作对齐或等其落地。
- `release-local/` 等 416MB 清理为破坏性操作，禁止单方执行。
- 本审计所有 pack 数据基于当前工作区（`--ignore-scripts`，未重跑 build/bundle）；正式发版会经 prepack 重建，文件数可能与本报告略有出入，但污染机制与量级结论不受影响。

## 7. 方法与局限

- 环境：main @ 48e75c419，Windows/Git Bash。所有命令只读或 `--dry-run --ignore-scripts`。
- 计数口径：`find -type f`；"test 相关" = 文件名含 `.test.`/`.spec.`/`.snap`/`fixture`/`snapshot` 或路径含 `__tests__`（两轮统计口径差异 ≤2%，不影响结论）。
- 孤儿扫描以文件名对应（`.js`↔`.ts/.tsx/.jsx`）为准，未处理重命名后同内容文件（会将"改名"计为"孤儿"），故孤儿数为上界；抽样的 `dist/adapters`、`server/update` 经 `rg` 证实源码确实不存在。
- live 机器验证仅为 `find | wc -l` 只读统计，符合 AGENTS.md §1.1 安装目录硬规则。

---

*调查执行：ZCode 只读审计会话，2026-09-22。*
