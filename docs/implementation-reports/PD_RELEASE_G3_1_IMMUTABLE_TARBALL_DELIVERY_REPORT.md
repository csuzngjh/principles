# PD Release G3.1 — Immutable Tarball Identity 交付报告

- 日期：2026-11-03
- 阶段：G3.1 实施（Owner 授权；基于 G3.1 审计 + G3.1.1 ADDENDUM 的 A+B+C v2 方案）
- 分支：`ai/adhoc-20261102-pdrel-g31-immutable-release-pipeline-26721e`（worktree READY，writer claim = zcode）
- 基线：`a69b8fc31`（= 创建 worktree 时的 origin/main，含 #2294/#2295/#2300）

## A. 核心设计

**目标语义（ARCH-SIMPLIFICATION-001 §6）**：`Pack immutable candidate → Verify candidate → Publish that candidate`。

installer leg 的发布物从"从目录第三次重打包的 tarball"改为"构建并验证过的一份不可变候选 tarball"：

1. **唯一一次 lifecycle-bearing pack**：`npm pack`（触发 prepack = installer tsc + bundle）——每 leg 3 次 pack → 1 次；publish 路径零 lifecycle（tarball-spec 不触发任何 pack/prepublish 脚本，npm 10/11 源码级证实）。
2. **gitHead overlay**（G3.1.1 勘误的对策：npm pack 不注入 gitHead）：在解包副本的 `package/package.json` 注入 `gitHead = cohort_sha`（仅当缺失；已存在则必须相等否则 fail-closed）；源 package.json/lockfile 零修改。
3. **确定性重封**：GNU tar（`--sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner`）+ `gzip -n`——文件集不变、顺序/mtime/属主归一。
4. **对最终 tarball 的完整验证**（摘要计算在注入之后）：stamp（productVersion==train 版本 && sourceCommit==cohort）+ 最终 manifest 深度校验（仅 gitHead 变化）+ 文件集合与原始 pack 一致 + 无 symlink/hardlink/特殊文件 + 无不安全路径（绝对/盘符/`..`/重复项）。
5. **发布同一个文件**：publish 步骤上传前**重新计算 SHA-512** 与候选步骤输出比对（篡改即拒绝，绝不回退目录发布）；`npm publish <candidate.tgz> --provenance` —— provenance subject = 上传 tarball 的 sha512（G3.1.1 源码级证实：attestation 覆盖的就是已验证字节）。
6. **registry 契约原样保留**：registry-exact（--expect-git-head cohort → PRESENT_MATCH）、deps-preflight、verify-publish-outcome 恢复语义（G3.1.1 已用真实脚本 + mock registry 五场景验证：UNVERIFIED fail-closed / MATCH 恢复 / CONFLICT 拒绝）。

## B. 修改文件

| 文件 | 变更 |
|---|---|
| `.github/actions/publish-npm-package/action.yml` | dry-run pack 步骤限定为非 installer 包；新步骤 "Pack and verify immutable installer candidate"（调 prepare-npm-candidate.mjs，输出 tarball/sha512_hex 到 GITHUB_OUTPUT）；publish 步骤 installer 分支 = 上传前 re-hash + `npm publish "$PUBLISH_TARGET" --provenance`，其余 7 包保持目录发布不变 |
| `scripts/release/prepare-npm-candidate.mjs` | 新增：候选构建+overlay+确定性重封+四重验证+SHA-512（213 行；usage 校验、GNU tar/gzip 前置断言、fail-loud） |
| `scripts/__tests__/release-immutable-candidate.test.ts` | 新增：production-path 测试（直接执行 action run block，非复写实现） |
| `scripts/__tests__/release-workflows.test.ts` | 工作流契约断言更新（ABSENT 门集、candidate 步骤接线、publish 目标、dry-run 判决权不归 head 预览） |
| `.github/workflows/publish-preflight.yml` | 注释同步（rehearsal 语义描述）；8/8 installer rehearsal leg 已传 `product_identity_version` + `dry_run: true`，与真实发布走同一候选构建路径 |

本会话对既有初稿的修复（3 处跨平台缺陷，全部不影响 CI ubuntu 行为）：

1. **ERR-045 复发**：`execFileSync('npm')` 在 Windows 无法解析 npm.cmd → 改为 `findNpmCliJs()` + `node npm-cli.js` 纯 argv（bundle-plugin.mjs 同款）。
2. **GNU tar 远程主机歧义**：任何含盘符冒号的参数（含 `-C`）在 Windows 被改写为 `D\:\...` → 所有 tar/gzip 调用改为 **cwd=临时根 + 纯相对路径**（ubuntu/Windows 行为一致，弃用 `--force-local` 方案）。
3. **coreutils 转义模式**：`sha512sum` 对含反斜杠路径输出前缀 `\` → re-hash 比对前 `tr -d '\\'`（哈希为纯 hex，剥离精确）。

## C. 验证证据

### C.1 身份契约（G2 清单 → 测试映射，91/91 定向绿）

| # | 要求 | 测试 |
|---|---|---|
| 1 | 缺 gitHead → 注入 cohort | positive 测试断言 `manifest.gitHead === COHORT` |
| 2 | 已有正确 gitHead → 保持 | matching-gitHead 测试 |
| 3 | gitHead 冲突 → 拒绝 | conflict 测试（fail-closed，无 tarball 落盘：runner-temp 内 0 个 .tgz） |
| 4 | stamp 缺失/错误 → 拒绝 | missing-stamp + wrong-cohort-stamp 测试 |
| 5 | 最终 tarball gitHead+stamp 均正确 | positive 测试从最终 tarball 解包断言 |
| 6 | 重复构建同 SHA-512 | 第二次构建 sha512 相等 + prepack 计数器 `xx` |
| 7 | 文件集合一致 | 脚本内 `isDeepStrictEqual(originalFiles, finalFiles)` fail-loud + 测试断言 |
| 8 | 无不安全路径/symlink/特殊文件 | 脚本 `listArchiveFiles` 逐项校验 + `tar -tvz` 类型检查 |

### C.2 发布链（G3 清单）

- npm pack 一次：positive 测试 prepack 计数器 = `x`（且 prepublishOnly 计数器文件不存在 → publish 路径零 lifecycle）；
- fake npm 测试：DRY_RUN=true 时 publish 步骤 exit 0、fake npm 标记文件**不存在**（dry-run 永不调用真实 npm publish）；
- 篡改检测：翻转首字节 → publish 步骤 fail-closed（"changed after verification"）且 fake npm 不执行；
- 上传前 re-hash：action 内 `ACTUAL_SHA512_HEX` 比对（G3.1.1 已证 registry integrity = 上传字节 sha512，发布字节≡验证字节结构性成立）；
- registry 语义：release-registry.test.ts + publish-recovery.test.ts 全绿（PRESENT_MATCH/UNVERIFIED/CONFLICT/恢复语义未动——本轮零修改这三个脚本）；
- provenance：`--provenance` 标志与 `id-token:write` 权限不变；subject = 上传 tarball（G3.1.1 源码级证据）。**真实 registry attestation 未演练**（见 E 节限制）。

### C.3 测试与检查结果

| 项 | 结果 |
|---|---|
| 定向四件套（candidate/workflows/recovery/registry） | **91/91 绿**（初稿 4 败 → 3 处跨平台修复后全绿） |
| candidate 测试独立重跑 | 4/4 绿（8.8s） |
| scripts 全套件 | **1958/1958 全绿**（`--maxWorkers=2`，187s）；默认全并行下曾出现 6 文件超时类 flaky（同机另一会话并行 vitest 负载所致，每次集合不同），隔离重跑 186/186 绿 + maxWorkers=2 全绿双重证明为环境性负载问题，非本 diff 引入 |
| check:error-handbook | OK（145 patterns / routing 完整） |
| check:repo-hygiene | OK |
| dev:worktree:ready | READY（无 PRIMARY_LEAKAGE） |
| git diff --check | OK |
| eslint（3 个改动 JS/TS 文件） | 0 error |
| release-intent guard | PASS mode=empty（本轮无 changeset：纯发布工具变更，TOOLS/PRODUCT 分离使其不烧产品版本，PRI-886 契约） |

### C.4 GNU tar/gzip 平台验证（指令要求）

- 发布 train 与 preflight rehearsal 均为 **ubuntu runner**（publish-npm train = 单 ubuntu job；preflight 两 job = ubuntu-latest）——GNU tar/gzip 为 runner 预装，脚本含 `tar --version`/`gzip --version` 前置断言（非 GNU 即 fail）。
- 本机验证 = Windows Git GNU tar 1.34（与 runner 同一 GNU tar 实现、同 flag 集），相对路径模式在两平台行为一致；`--maxWorkers=2` 套件与 CI（ubuntu）为最终验收，不以本机结论替代。

## D. G5 工作流集成验收

- **TOOLS_DIR**：train 与 rehearsal 均用 `./release-tools/.github/actions/publish-npm-package` + `tools_dir: release-tools`；TOOLS checkout `ref: inputs.tools_ref || github.sha`（钉死 trusted SHA，PRI-886）→ 候选脚本与 registry 脚本同源同版本。candidate 步骤从 workspace root 解析相对 TOOLS_DIR（无 cd），不受 run 35666369142 的相对路径教训影响；publish 步骤保留 TOOLS_ABS 预解析。
- **同一候选路径**：candidate 步骤只 gate 在 `ABSENT`，不 gate `dry_run` → rehearsal 走完全相同的 pack/overlay/重封/验证，仅 publish 步骤的 bash 字符串门跳过上传。
- **门禁未绕过**：exact-state/deps-preflight/stamp/verify-publish-outcome 全部原样；新增门（gitHead 冲突、stamp 不符、文件集漂移、SHA 漂移、非 GNU 工具链）全部 fail-closed。
- **平台**：全部调用方为 ubuntu（GNU 工具链预装）；release-metadata / reproducibility / companion 工作流不使用该 action，零影响。
- **reproducibility 双构建**：未触碰（build-self-contained-release 路径独立于 npm train）。

## E. 已知限制与剩余风险

1. **provenance 真实 attestation 未演练**（同 G3.1/G3.1.1 结论）：dry-run 跳过 libpub，mock registry 无法覆盖 OIDC。首个真实 cohort 即验证点；异常表现 = npm publish provenance 错误（fail-closed，无半发布）；回滚 = revert 本 PR。
2. 确定性重封依赖 runner 的 GNU tar/gzip 形态（版本差异理论上可变字节）——同 runner 内两次构建一致已由测试证明；跨 runner 的字节比较由既有 reproducibility 门禁体系在资产侧继续覆盖（npm tarball 无跨构建字节比较门禁，现状亦无——非本轮引入）。
3. 其余 7 个 npm 包仍走目录发布（其 prepack/prepublishOnly 重复依旧）——G3.1 A 项的完整收尾（扩展 candidate 机制到全部包）为后续工作，本轮按指令只交付 installer leg（体积/耗时最大项）。
4. 本机全量套件存在并行负载 flaky（另一 agent 会话同机运行）；证据链 = 定向 91/91 + 隔离 186/186 + CI ubuntu 权威跑。

## F. 回滚

Revert 单提交即恢复原发布路径（identity 步骤还原为 pack-verify-discard、publish 还原目录发布）；无 schema/状态/依赖变化；registry 侧兼容不变（已发布版本零影响）。`.tmp/g3-1-impl/` 的 WSL smoke 为历史实验参考材料，gitignored，不随提交。

## G. 裁定

PASS_WITH_LIMITATIONS（唯一限制 = E.1 provenance 首发布演练项；其余完成标准全部满足，最终裁定在 CI 完成后于 PR 处确认）。
