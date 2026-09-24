# Release Artifact Hygiene Gate — Phase 0 Reality Audit (PRI-918)

> 只读审计报告。base main `8253604a`（PRI-913 已合并）。
> 目的：在建立"release 产物卫生门禁"之前，核实当前产物生成链、已有检查的真实覆盖范围、
> 缺口与最小插入位置。本报告不实现任何门禁。

## 1. 当前 release artifact 生成链（已核实）

```text
src/*.ts
  ↓  tsc -p tsconfig.build.json（RAH-1：生产 build 已排除测试）
packages/<pkg>/dist/
  ↓  build 尾部：node ../../scripts/build/check-dist-hygiene.mjs（逐包）
npm pack（files:["dist"] 等白名单，RAH-2 已收窄 pd-cli 发布面）
  ↓  installer：prepack = "npm run build && npm run bundle"
packages/create-principles-disciple/scripts/bundle-plugin.mjs
  （cpSync filter=skipTestArtifacts 过滤拷贝 + assertPayloadHygiene 拷后断言）
  ↓  payload 组件目录：console/ core/ install-layout/ pd-cli/（仓库内仅 tracked package.json，
     dist 只在 bundle 后出现）
npm 发布 / 自包含 release asset：
  .github/workflows/release-metadata.yml:455 与 release-reproducibility-full.yml:73
  → build-self-contained-release.mjs:96 内部调 bundle-plugin.mjs
```

关键性质：

- **`npm pack --dry-run` 会真正触发 prepack**（实测：installer 包 dry-run 直接执行
  `npm run build && npm run bundle`，Windows 下 3s 即失败退出）。因此任何"tarball 级
  检查"必须使用 `npm pack --dry-run --json --ignore-scripts`（实测 EXIT=0，输出单个
  JSON 数组，含逐文件 entries；不跑脚本、不重写 tracked payload 文件）。
- create-principles-disciple 的 `files` 白名单含 payload 组件目录（plugin/pd-cli/console/
  core/host-runtime/codex-adapter/install-layout/release-manager + dist + trust/root.json
  + _release/product-identity.json），即 **installer tarball = installer 本体 + bundle 后的
  payload**，payload 卫生在发布链上由 assertPayloadHygiene 兜底（bundle-path in-path 断言）。

## 2. 已存在的检查与真实覆盖面

| # | 机制 | 位置 | 何时执行 | 实际覆盖 |
|---|------|------|----------|----------|
| C1 | 工件类契约 SSoT | `scripts/build/test-artifacts.mjs` | 被 C2/C3/C4 共享 | basename 判定 `.test.` / `.spec.` 前缀形态与 `.snap` 后缀（正则见 `TEST_BASENAME`）；目录段仅 `__tests__/__snapshots__/__fixtures__`；排除 vendored node_modules（ERR-149/EP-14 定型） |
| C2 | 逐包 build 尾检 | `check-dist-hygiene.mjs`，wire 进 principles-core / install-layout / pd-cli / pd-console / openclaw-plugin 的 `build` script | 每次 `npm run build` | 本包 dist |
| C3 | 仓库级 backstop | `check-workspace-artifacts.mjs`，`verify:merge` 成员（ci.yml Merge Gate，行 127） | 每个 PR | `packages/*/dist`（存在即扫）+ **仅当 payload 组件同时有 package.json 和 dist 才扫** |
| C4 | bundle 路径断言 | `bundle-plugin.mjs:185 assertPayloadHygiene`（:868 调用） | 手动 bundle / prepack / release-asset 构建 | bundle 后的 payload 组件 dist |
| C5 | 发布面检视（非断言） | ci.yml "Release Build Parity" 行 154；publish-npm-package/action.yml 行 210 | PR CI / 发布腿 | `npm pack --dry-run \| head -50` 只打印，不判定；仅 openclaw-plugin |
| C6 | 发布 tarball 身份门 | action.yml "Verify the packed installer tarball…"（PRI-874/881） | 真实 pack 后 | 只验 product-identity，不验卫生 |
| C7 | 源码树卫生 | `check:repo-hygiene`（denylist：.tmp/、linear-comment、.state/、运行时 db）、`check:generated-artifacts`（src 内编译产物/声明文件） | verify:merge | **源码树**，不是产物树 |

## 3. 缺口（与 mission Phase 1/3/5 对照）

- **G1 — PR 期无 tarball 级判定**：npm pack 内容只被打印（C5），从不被断言。发布面若混入
  非发布资产（例如未来某包 files 字段扩宽），PR CI 不拦。mission Phase 3 点名
  core / pd-cli / console 的 `npm pack --dry-run` 检查——注意 pd-console 实测
  `private:true` 不发布 npm，其交付路径是 installer payload（console/ 组件），
  合同须按"published 包查 tarball、private 包查 payload 组件"落地。
- **G2 — payload 扫描在 PR 期静默跳过**（ERR-146 类：声明的覆盖从未执行）：payload 组件目录
  仓库态只有 package.json 无 dist（实测 4/4 `dist=NO`），C3 的条件扫描因此整体跳过，
  "payload 零测试资产"在普通 PR 上没有任何执行证据；C4 只在 bundle 时跑。
- **G3 — 契约宽度不足 mission Phase 1**：裸目录 `tests/`、`fixtures/`、`coverage/`、
  `.vitest/` 不在 C1 的目录段规则里（现仅 `__x__` 变体）。`.test./.spec./.snap` 文件名形
  已覆盖（含 .ts 编译前后）。
- **G4 — 门禁自身零测试**：`scripts/__tests__/` 无任何文件引用 test-artifacts /
  check-dist-hygiene / check-workspace-artifacts（实测 grep 空）。mission Phase 5 的
  PASS/注入 FAIL/合法 PASS 矩阵全部缺失。
- **G5 — installer 自身 build 无尾检**：create-principles-disciple `build` = 裸 `tsc`，
  无 check-dist-hygiene 尾（其 dist 靠 C3 backstop 兜底；缺 in-path 层）。

## 4. 误伤红线（Phase 1 契约必须绕开，均有现存实体）

| 合法资产 | 位置 | 为什么不能被裸规则打掉 |
|---|---|---|
| `*-fixtures.ts` 生产模块 | core dist `runtime-v2/internalization/golden-dogfood-fixtures.js`、`adapter/split-pipeline-fixtures.js` | 生产 barrel 引用，必须留在 dist（C1 头注 + ERR-149） |
| `test-double-*` 生产模块 | core dist `runtime-v2/adapter/test-double-runtime-adapter.js` | production-reachable（`--allow-test-double` 门控），名字含 test 但非测试资产 |
| 生产 fixture 数据 | installer `trust/root.json`、`_release/product-identity.json` | files 白名单成员，发布必需 |
| 测试目录中的生产引用边 | `test-double-runtime-adapter.ts:25` import `__tests__/__fixtures__/…`（Test Diet B4 审计 F-1） | 依赖方向问题已另票治理；门禁只管产物，不管这条 src 边 |

⇒ 判定必须**基于 artifact context（扫描根是产物树）+ 路径形态**，而不是全局文件名匹配；
`fixtures/`、`tests/`、`coverage/`、`.vitest/` 作为**目录段**只在产物根内生效；
`samples/` 不在禁止清单。

## 5. 最小插入位置（Phase 2 设计输入）

1. **扩契约不建二套**：G3 的目录形态规则加进 `test-artifacts.mjs`（C1 本来就是三 gate 共享
   SSoT），并带"合法资产不得误伤"负例。
2. **新增单一入口 `scripts/check-release-artifact-hygiene.mjs`**（mission 推荐名），复用 C1
   契约，覆盖三条腿：`packages/*/dist`（含 installer 自身 dist，收 G5 的 backstop 缺口）、
   payload 组件目录（存在即扫，不存在如实报 scanned 数）、
   `npm pack --dry-run --json --ignore-scripts` tarball 清单（published 包逐个，收 G1/G2：
   installer 包的 dry-run 清单同时验证"仓库态 payload 未混入任何测试资产"）。输出格式按
   mission：PASS(scanned/violations=0)；FAIL 逐条 artifact path + reason + rule ID。
3. **接线 = verify:merge 追加一步**（与 C3 相邻、build 之后），Merge Gate CI job 免费获得；
   不改 build topology、不动 prepack/publish 结构。
4. **测试放 `scripts/__tests__/`**（目录约定已确立），用临时目录构造注入样本（G4）。

不引入：新 source of truth（契约仍在 C1）、新持久化状态、新子系统、新公共 API、feature
flag、新依赖、任何 topology 变更。

## 6. 结论

RAH 系列把"**构建端**不漏"做实了（C1/C2/C4），但"**门禁端**持续防回归"有三个真实缺口：
tarball 层无判定（G1）、payload 层 PR 期静默跳过（G2）、契约缺 mission 要求的目录形态（G3），
且整个门禁族没有任何自身测试（G4）。最小落点 = 扩 C1 契约 + 单文件新 checker 走
verify:merge，复用而非新建。
