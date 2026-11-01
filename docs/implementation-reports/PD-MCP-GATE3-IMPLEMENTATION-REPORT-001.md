# PD-MCP-GATE3-IMPLEMENTATION-REPORT-001
# Gate 3 端到端实施最终交付报告（P2+P3，OG-2 授权执行）

| 字段 | 内容 |
|---|---|
| 任务 | SPEC-PD-AGENT-CAPABILITY-API-001 v0.5（OG-1 冻结）的 Gate 3 单变更集实施 |
| 实施工单 | PRI-1068（In Review） |
| 实施基线 | origin/main `797d2e9fd`（2026-11-01 fetch；比 DELTA-AUDIT 基线 `0d0ea7eb5` 新 8 个提交，全部经并发修改复核确认零交集） |
| 最终 HEAD | `535737f3d`（实现 commit `bf7191f85` + origin/main git-7 刷新 merge） |
| PR | [#2270](https://github.com/csuzngjh/principles/pull/2270)（OPEN，待 Owner 评审；AI 不合并） |
| 实施形态 | 单变更集 + 单次 git-7 刷新 merge；独立 worktree `D:\Code\_worktrees\principles\PRI-1068-pain-recall-extraction`（writer=zcode，租约+git lock 持有） |
| 黄金生成记录 | 生成脚本 `.tmp/pain-recall-golden/generate-goldens.mjs`（worktree 内，gitignored）；生成时点 = 删除旧实现**之前**、built CLI 为旧路径实现（base `797d2e9fd` 构建）；MANIFEST.json 含全部夹具与输出 SHA-256 |

---

## 1. 最终裁定

**PASS_WITH_LIMITATIONS**

- 全部授权范围（READINESS §1–§16）已实施并分层验证：黄金等价、只读矩阵、Capability 契约、架构守卫、发布治理、实机验收全部通过；
- limitations（均不阻塞合并，逐项见 §7）：①PR CI 结果待确认（本地等价证据已分层提供，CI 若红按归因修复）；②Mimosa 深度扫描后台运行中（本报告提交时补充结论，不宣称安全结论）；③一处已知计时 flake（与本 diff 零交集，已给隔离证据）。

## 2. 基线与变更

- origin/main 基线：`797d2e9fd`；最终 HEAD：`535737f3d`；PR：#2270。
- 修改：`commands/pain-recall.ts`（1 行 import）、`pain-recall.test.ts`（拆分留壳）、`io-seam-registry.json`、core `package.json`（+2 exports 键）、`architecture-regression.test.ts`（+2 房例条目）、`.gitattributes`（黄金语料子树 `-text` 字节钉定）。
- 新增：`pain-recall-read-model.ts`（git 识别为 rename 96%）、`pain-recall-snapshot-hooks.ts`、`pain-recall-capability.ts`、四份 core 测试（readonly/service/capability/architecture-guards）、`pain-recall.golden.test.ts`、`tests/helpers/golden-replay.ts`（`.fixture` 存储→显式映射→临时目录物化→真实子进程重放）、`__golden__/`（4 工作区×扁平 fixture + 8 黄金 + MANIFEST）、changeset。**夹具存储合规**：语料不含任何 `.pd/`、`.state/`、`*.db` 或 ledger 文件名（generated-artifacts 门禁与 gitignore 规则零触碰，`.gitignore` 零修改）。
- 删除：`pd-cli/src/services/pain-recall.ts`、`pd-cli/tests/commands/pain-recall-readonly.test.ts`（均迁移）。

## 3. 架构交付

- Read Model 新位置：`packages/principles-core/src/runtime-v2/pain-recall-read-model.ts`，子路径 `@principles/core/runtime-v2/pain-recall`；三条原 core import 改相对引用（`../principle-tree-ledger.js`、`../trajectory-store.js`、`./store/runtime-state-manager.js`——房例同 PainChainReadModel），其余逐字节保持（`recallPains` 签名/契约类型/常量/排序/截断/三态/错误语义）。
- **只读构造陷阱规避证明**：`readonly: true, bootstrapIfMissing: false`（read-model L548 原位）逐字保留；与 `PainChainReadModel` 的默认构造（`pain-chain-read-model.ts:123-125` 不传 readonly）零合并；ro 矩阵 25/25 随迁全绿即行为证明。
- Capability Facade：`pain-recall-capability.ts`；IO seam：read model 入 read-model seam（描述含 temp-staging-only 声明）；snapshot-hooks（结构化 `SnapshotStatsLike` 替代 `fs.Stats` 类型引用，零 fs import）与 capability（零 IO）不登记——满足 eslint 组1 无 type 豁免的边界且不违反"仅真正 IO 者登记"（Owner 决策 4 附带条件）。
- exports：两键分离（`./runtime-v2/pain-recall` / `./runtime-v2/pain-recall-capability`），barrel 零触碰（G-2 断言 + 493 架构回归绿）。
- CLI 接线：仅 import 行变更；`resolveWorkspaceDir`/选项/退出码/fail() 不动。
- Hook 未修改证明：`git diff 797d2e9fd..HEAD -- plugins/principles-disciple/hooks/ packages/*/src/**/pd-hook*` 为空（PR diff 中无 hooks.json/tool-semantics/宿主配置文件）。

## 4. 安全交付

| 项 | 证明 |
|---|---|
| OD-A 白名单一致 | `ALLOWED_PATHS` 逐字段复制自 Gate 2 `project.mjs:23-37`（27 叶）+ `disclosureProfile`（v0.5 唯一增项）；测试侧持**独立冻结副本**做包含断言（静默扩权即红）；DENY 路径清单独立断言逐项缺省 |
| DENY 字段无泄露 | 哨兵植入测试（reason/text/rootCause/correction/sessionId/decidedAt 六哨兵）信封全文零命中（含 error/warnings 路径）；实机验收复测零命中；`statusDetail` 键全文零出现 |
| 输入校验有效 | unknown 逐字段守卫；拒绝一切未声明属性；非法值（0/负/11/99/非整/非数/超长/空/非对象）全部 `invalid_input` 且 read model 零调用（mock 计数断言） |
| limit 上限有效 | [1,10] 边界 + 默认 3 + >10 候选夹具（12 条）截断语义诚实（`truncated:true`） |
| 工作区只读 | 25 用例矩阵 + 黄金重放对物化工作区前后 SHA-256 全等（每用例 workspaceIntact 断言）+ 实机验收字节哈希不变 |
| 测试钩子未进公共 API | G-2 源级+运行时双重断言（hooks 不在任一子路径/任何 exports 键）；service/capability 测试内运行时键集合精确快照 |
| G-1 完整扫描 | 生产/测试域完整互斥（计数总和=全量文件）；六类正负自测全过；`__tests__` 外 `*.test.ts` 盲区关闭且有专项负例 |
| G-2/G-3 | G-2 导出面（源级+运行时+package.json exports 映射精确断言）；G-3 pd-cli 零 capability 引用/子路径唯一消费点/旧路径零残留 |
| 构造即白名单 | 投影逐字段构造（无对象展开带入）；每调用 collectPaths 自检，越权即扣留负载返回 `unavailable`+`disclosure_assertion_failed`（mock 注入越权叶的负例证明该路径真实可达且扣留） |

**契约修正记录（实施中发现）**：SPEC §7.2 规定 `data:null` 仅当 unavailable/invalid_input，而 Gate 2 原型从不发 null data → 初版实现沿原型对 `source_missing` 投影了非空 data，与 SPEC 冲突。裁定按 SPEC（更严者）：Facade 改为 unavailable→data:null，自检对裸 `data` 叶增加 §7.2 空标记豁免（有注释论证：白名单辖制的是 data.* 的**填充形态**，null 标记是信封层语义）。该分歧已在 PR 描述披露。

## 5. 测试证据

| 验收项 | 结果 | 证据（命令/位置） |
|---|---|---|
| 只读矩阵 | PASS 25/25 | `npx vitest run --root packages/principles-core src/runtime-v2/__tests__/pain-recall-readonly.test.ts` |
| 服务行为 | PASS 30/30（29 迁移 + 1 导出面） | `... pain-recall-service.test.ts`（对账：原 771 行文件 82 用例 = 壳 28 + 服务 29 + readonly 25，零丢失） |
| 注入健全性 | PASS | 每注入用例断言注入器计数 >0（race×4/inj×3/aba×5/interleave×2 全覆盖） |
| Capability 契约 | PASS 16/16 | `... pain-recall-capability.test.ts` |
| OD-A 泄露测试 | PASS | 同上（DENY 哨兵/路径/错误路径三重扫描） |
| G-1 守卫 | PASS（含 6 自测） | `... pain-recall-architecture-guards.test.ts` |
| G-2 导出面 | PASS | 同上 + service/capability 测试运行时键断言 |
| G-3 CLI 引用面 | PASS | 同上 |
| CLI 黄金测试 | PASS 12/12（真实子进程 fork built CLI） | `npx vitest run tests/commands/pain-recall.golden.test.ts`（pd-cli） |
| 黄金重放脚本 | 8/8 MATCH（终态复核两次） | `node .tmp/pain-recall-golden/replay-goldens.mjs` |
| Core 构建 | PASS | 根 `npm run build`（依赖序，dist 含两新子路径产物） |
| CLI 构建 | PASS | 同上；built CLI 实机运行成功 |
| Core 全量回归 | PASS 8809/8810（1 计时 flake） | `vitest run --maxWorkers=2`；flake 用例隔离重跑 139/139 绿（pi-ai 预算计时，与 pain-recall 零交集） |
| pd-cli 全量回归 | PASS（exit 0） | `vitest run --maxWorkers=2` |
| 实机运行验收 | PASS | `node .tmp/pain-recall-golden/runtime-acceptance.mjs`：dist 子路径真实解析、ok 信封、6 哨兵零泄露、工作区字节不变、limit=99→invalid_input、CLI 原始合同输出 |
| lint / typecheck | PASS 0 errors | core+pd-cli 全部涉改文件 eslint；两包 `tsc --noEmit` |
| 架构回归 | PASS 493/493 | `architecture-regression.test.ts`（IO seam/barrel/DAG/REQUIRED_SOURCE_FILES） |
| release-locks | PASS | `node scripts/check-release-locks.mjs` exit 0 |
| PR CI | 首轮 Verify Merge Gate 红（generated-artifacts 拒绝 `.pd/state.db` 检入）→ 已改为扁平 `.fixture` 存储+物化重放并本地复跑门禁 PASS / 2102 pd-cli 全量绿，等待重跑 | PR #2270 checks |
| Mimosa 深扫 | 运行中 | job `scan-job-mvxiqw9a`（结论后补，不预宣称） |

## 6. 发布治理

- changesets：core **minor**（新公共子路径=新 API）+ pd-cli/plugin/installer **patch**（PRI-1065 `5ac3a8863` 四包联动先例；plugin bundle 随安装器发布）。依赖范围零编辑（全 `^1.297.x` 容纳 minor）；Version PR 自动 bump。
- release-locks：`check:release-locks` 通过；`generate:release-locks` 的 diff 经逐项核对全部为无关注册表漂移（锁内 core 版本仍为 1.293.2 时代 + @aws-sdk/typebox 传递依赖浮动），非本 diff 所致——本 PR 无 manifest 版本变更，ERR-131 触发条件（manifest bump）未满足，故判定**无需再生**并还原了再生产物。若 Owner 评审要求保守同批再生，可按正式流程在紧随的维护 PR 执行（再生产生的注册表漂移不应混入本 PR——P3 最小变更面）。
- 回滚路径：PR 合并后 `git revert <merge>` 一次回收全部（exports/registry/守卫/接线/测试/夹具例外）；发布后回退发 patch 即可（子路径纯新增）。

## 7. 未完成事项

| 项 | 状态 | 阻止合并？ |
|---|---|---|
| PR CI | 运行中（本地分层等价证据已提供） | 视结果；本次引入的红必修 |
| Mimosa 深扫 | 后台运行中（静态边界） | 否（补充性证据；hook 多次 enobufs 故启动正式扫描） |
| pi-ai 计时 flake | 已记录（隔离绿，零交集；历史 `.pd-test-temp` flaky 同类） | 否 |
| Gate 4 全部内容（MCP Server/SDK/32KiB/10s/取消/D-06/WB 实机） | **未实施**（OG-3 另行授权） | 否（明确出界） |
| 未验证场景 | CI Linux 环境下黄金夹具字节稳定性已由 `.gitattributes -text` 机制保证，但尚无 CI 实跑记录（PR CI 将首次证明） | 否 |

## 8. 最终边界声明

本实施**未**：实现 MCP Server；引入 MCP SDK；修改 Hook/hooks.json/tool-semantics/宿主配置/生产治理逻辑；实现 Gate 4（32 KiB 响应预算、10 秒调用截止、取消机制、MCP 协议类型均未进入 Core/Facade——范围自检通过）；创建 pd-application；新增外部依赖/feature flag/数据库 schema/迁移；发布 npm；部署生产；合并 PR。**最终状态：READY_FOR_OWNER_REVIEW（PR #2270 OPEN）。**
