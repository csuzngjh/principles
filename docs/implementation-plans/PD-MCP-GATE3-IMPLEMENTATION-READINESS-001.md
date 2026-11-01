# PD-MCP-GATE3-IMPLEMENTATION-READINESS-001
# Gate 3 实施准备：机械步骤清单与防错设计

| 字段 | 内容 |
|---|---|
| 文档性质 | 实施准备（设计交付）；**不构成实施授权**——启动条件 = SPEC v0.5 获 OG-1 采信 + OG-2 授权 |
| 契约依据 | `docs/specs/SPEC-PD-AGENT-CAPABILITY-API-001-v0.5.md`（下称 v0.5） |
| 事实依据 | `docs/implementation-reports/PD-MCP-GATE3-LATEST-SOURCE-DELTA-AUDIT.md`（基线 `0d0ea7eb5`，下称 DELTA-AUDIT） |
| 决策依据 | `docs/implementation-reports/PD-MCP-GATE3-OWNER-DECISION-CARD.md` + 2026-11-01 Owner 九项已决 |
| 实施形态 | **单变更集（单 PR）**完成 P2+P3；独立 worktree（git-1/git-11）；变更集可单次 revert |
| 前置复核 | 实施 PR 开始时重新确认 `pain-recall.ts` 仍无并发修改（`git log 796000a10..HEAD -- <file>` 应仅含本 PR） |

> 本文每个步骤给出**精确文件与行级锚点**（基线 `0d0ea7eb5` 现测）；行号在实施时以当日 HEAD 复核为准（DELTA-AUDIT 已证该文件历史零漂移，风险低）。

---

## 1. 文件迁移清单（move / create / edit / delete）

| 动作 | 文件 | 说明 |
|---|---|---|
| **MOVE** | `packages/pd-cli/src/services/pain-recall.ts` → `packages/principles-core/src/runtime-v2/pain-recall-read-model.ts` | 895 行整体移动；三包名 import（:63-65）改相对引用（`.js` 后缀，模式同 `pain-chain-read-model.ts:15-17`）；其余零改动 |
| **CREATE** | `packages/principles-core/src/runtime-v2/pain-recall-snapshot-hooks.ts` | 内部模块：`painRecallSnapshotTestHooks` 四注入位迁出（原 :269-283）；Read Model 相对引用；**不进任何 exports 键** |
| **CREATE** | `packages/principles-core/src/runtime-v2/pain-recall-capability.ts` | Capability Facade（§5 接口设计）；零文件 IO；原型 `project.mjs` 的 TS 化 + `disclosureProfile` 增项 |
| **EDIT** | `packages/principles-core/package.json` | exports 增两键（§4） |
| **EDIT** | `packages/principles-core/io-seam-registry.json` | read-model seam `files[]` 增 `runtime-v2/pain-recall-read-model.ts` + 描述补一句临时 staging 说明 |
| **EDIT** | `packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts` | `REQUIRED_SOURCE_FILES`（:13-580）补两个新文件名（房例 :1-6） |
| **EDIT** | `packages/pd-cli/src/commands/pain-recall.ts` | :22 import 改 `@principles/core/runtime-v2/pain-recall`（:15 resolve-workspace 不动） |
| **DELETE** | `packages/pd-cli/src/services/pain-recall.ts` | 同一变更集内（无副本残留） |
| **MOVE** | `packages/pd-cli/tests/commands/pain-recall-readonly.test.ts` → `packages/principles-core/src/runtime-v2/__tests__/pain-recall-readonly.test.ts` | 整体迁移；import :22 改相对 `../pain-recall-read-model.js` + `../pain-recall-snapshot-hooks.js` |
| **SPLIT-MOVE** | `packages/pd-cli/tests/commands/pain-recall.test.ts` | 服务组四段迁 core（§7）；外壳组留 pd-cli（import :25 改子路径；B5 处理见 §7） |
| **CREATE** | `packages/principles-core/src/runtime-v2/__tests__/pain-recall-capability.test.ts` | Facade 契约测试（§10） |
| **CREATE** | 架构守卫测试 + 导出面断言 + CLI 黄金测试（§8/§9） | 位置见各节 |
| **CREATE** | `.changeset/*.md` | §12 |

## 2. 目标目录结构

```text
packages/principles-core/src/runtime-v2/
  pain-recall-read-model.ts         # Read Model（迁移，895 行，seam 登记）
  pain-recall-snapshot-hooks.ts     # 测试钩子（内部，不导出）
  pain-recall-capability.ts         # Capability Facade（新增，零 IO）
  __tests__/
    pain-recall-readonly.test.ts    # 迁移：25 用例只读矩阵
    pain-recall-service.test.ts     # 迁移：assoc/avail/sem/rank 四组（自 pain-recall.test.ts 拆出）
    pain-recall-capability.test.ts  # 新增：Facade 契约
    fixtures/…                      # 黄金夹具（迁移等价 + parity）
packages/pd-cli/
  src/commands/pain-recall.ts       # 仅 import 行变化
  tests/commands/pain-recall.test.ts # 保留外壳组（cli-A/parse/cli-B）
  tests/commands/pain-recall.golden.test.ts  # 新增黄金等价（§9）
```

**命名决策**：平铺、无 `capabilities/` 目录（core 惯例先例 `diagnostician-capability.ts`；DELTA-AUDIT §D-1 修正）。测试文件名 `pain-recall-service.test.ts` 避免与迁移来的 readonly 测试混淆。

## 3. 依赖方向（变更后 DAG 增量）

```text
pd-cli ──► @principles/core/runtime-v2/pain-recall（Read Model 子路径，唯一新增消费）
（未来 Gate 4）MCP Adapter 包 ──► @principles/core/runtime-v2/pain-recall-capability（唯一允许）
core 内部：pain-recall-capability.ts ─相对─► pain-recall-read-model.ts ─相对─► 三原语 + snapshot-hooks
```

- 无新包、无新边方向的例外：pd-cli→core 既有边上新增一个消费点。
- **禁止**：core 任何文件 import pd-cli（既有守卫语义 + rg 基线零命中维持）；barrel re-export 新模块（R3）。
- 验证：既有 DAG 守卫 + 新增守卫（§8）。

## 4. Core 专用子路径导出

`packages/principles-core/package.json` exports（在 `:89` 先例条目旁插入，键序按现有排列约定）：

```json
"./runtime-v2/pain-recall": {
  "types": "./dist/runtime-v2/pain-recall-read-model.d.ts",
  "default": "./dist/runtime-v2/pain-recall-read-model.js"
},
"./runtime-v2/pain-recall-capability": {
  "types": "./dist/runtime-v2/pain-recall-capability.d.ts",
  "default": "./dist/runtime-v2/pain-recall-capability.js"
}
```

- **两键分离**（而非单键 re-export）：使"受限 Capability 出口"与"完整 Read Model 出口"在依赖面上可被守卫区分（v0.5 §5.3 R4）。
- Read Model 子路径导出面 = `recallPains` + 全部契约类型 + 三常量（`PAIN_RECALL_SCHEMA_VERSION`/DEFAULT/MIN/MAX_LIMIT）——**不含** `painRecallSnapshotTestHooks`（已迁内部模块）。
- barrel fixture（1976/196）**零触碰**（守卫只扫 barrel 文件本身——DELTA-AUDIT §C.4 直证）；`tsc -p tsconfig.build.json` 自然产出 dist（新文件在 `src/` 下）。
- Capability 子路径导出面 = `recallPrinciplePainsCapability` + `PainRecallCapabilityResult` 等信封类型 + `OD_A_DISCLOSURE_PROFILE` 常量。

## 5. Capability Facade 接口设计

```ts
// pain-recall-capability.ts（协议无关；零文件 IO；不 import fs/path——eslint 无需 seam）
import { recallPains, type PainRecallResult, … } from './pain-recall-read-model.js';

export const CAPABILITY_SCHEMA_VERSION = 'pd.capability.v1' as const;
export const OD_A_DISCLOSURE_PROFILE = 'od-a-v1' as const;
export const RECALL_PAIN_CAPABILITY_ID = 'pd_recall_principle_pains' as const;

export interface PainRecallCapabilityInput {
  readonly workspaceDir: string;      // 可信上下文：Adapter 注入，绝不来自模型参数
  readonly principleId: string;       // 1..200
  readonly limit?: number;            // 1..10，缺省 PAIN_RECALL_DEFAULT_LIMIT
}

export type PainRecallCapabilityStatus =
  | 'ok' | 'no_matches' | 'partial' | 'not_found' | 'unavailable' | 'invalid_input';

export interface PainRecallCapabilityResult { /* v0.5 §7.2 字段树 */ }

// OD-A 白名单：模块内编译期常量（Set<string>，27+1 叶路径），不导出集合本身；
// 由 pain-recall-capability.test.ts 以行为断言钉死。
const ALLOWED_PATHS: ReadonlySet<string> = new Set([ … ]);   // ← 逐字段复制自冻结工件
const OUTER_STATUS: Readonly<Record<string, PainRecallCapabilityStatus>> = { … }; // v0.5 §7.3

export async function recallPrinciplePainsCapability(
  input: PainRecallCapabilityInput,
): Promise<PainRecallCapabilityResult> {
  // 1) 输入校验（rc-1/rc-2：入参视为 unknown 逐字段守卫；拒绝一切未声明属性）
  // 2) const raw = await recallPains(input.workspaceDir, { requestedPrincipleId, limit })
  // 3) const envelope = projectEnvelope(raw, input)   // 构造即白名单
  // 4) assertDisclosurePathSet(envelope)              // collectPaths 键路径自检
  //    └─ 违规 → 返回 unavailable 信封 + 内部错误码（不返回违规负载）
  // 5) return envelope
}
```

实现来源对照（Gate 2 原型 → 生产 TS）：`projectEnvelope`（project.mjs:67-114）、`collectPaths`（:117-128）、断言（:134-141 去实验哨兵）、`errorFor` 状态派生（:45-64）。**语义零变化**；唯一增项 = `disclosureProfile: 'od-a-v1'` 字段（v0.5 §7.2）。

**实现约束**：输入校验用手写逐字段守卫（rc-1/rc-2 语义：入参按 unknown 处理、逐字段验证、拒绝未声明属性）——**不引入任何校验库**（zod 等属 Gate 4 MCP Adapter 层选择，不入 core）；`ALLOWED_PATHS` 为模块内编译期常量，不导出集合本身（由契约测试以行为断言钉死）。

**单次 ≤10 条 = Core Capability 约束（v0.5 §7.5.2，Gate 3 实施范围）**：Facade 强制 `limit ∈ [1,10]`（缺省沿用 `PAIN_RECALL_DEFAULT_LIMIT=3`），非法值 fail-closed 返回 `invalid_input`；结果条数由服务既有截断语义保证 ≤ limit ≤ 10；Read Model 迁移**不得**改变既有查询/截断语义。**32 KiB 与 10 秒不是 Facade 的职责**（传输/执行边界，属 Gate 4 MCP Adapter——见 §17；实施人员不得把这两项实现进 Core）。

## 6. CLI 迁移方案

1. `commands/pain-recall.ts:22`：`from '../services/pain-recall.js'` → `from '@principles/core/runtime-v2/pain-recall'`（命名导入集不变：`recallPains` + 三常量 + `type PainRecallResult`）。
2. 其余零改动：选项注册（index.ts :178-193）、严格解析（:51-54）、退出码（:169-173）、fail()（:33-42）、`resolveWorkspaceDir`（:15）。
3. pd-cli `package.json`：**零编辑**（core 范围 `^1.297.11` 已容纳新 minor；版本 bump 由 Version PR 自动）。
4. 自检断言（PR 内）：rg 确认 `services/pain-recall` 全仓零残留命中（代码文件）；pd-cli 全仓零 `pain-recall-capability` 引用（R6）。

## 7. 测试迁移清单

**迁 core**（服务边界，import 改相对）：

| 来源 | 内容 | 目标 |
|---|---|---|
| `pain-recall-readonly.test.ts`（830 行） | 全部 25 用例：ro-×11 / race-×4 / inj-×3 / aba-×5 / interleave-×2 + 钩子注入器（:463-465,:469,:753） | `core/src/runtime-v2/__tests__/pain-recall-readonly.test.ts`（import :22 改 `../pain-recall-read-model.js` + `../pain-recall-snapshot-hooks.js`；钩子 import 从服务文件改 hooks 模块） |
| `pain-recall.test.ts` :450-765 | `recallPains: association graph`（assoc-1..11,:450-567）/ `availability`（avail-1..10,:581-672）/ `information semantics`（sem-1..4,:687-714）/ `ranking and truncation`（rank-1..4,:739-765）+ 夹具构造器（:27-262 随迁） | `core/src/runtime-v2/__tests__/pain-recall-service.test.ts` |

**留 pd-cli**（外壳边界，原地不动或微调 import）：

| 内容 | 处理 |
|---|---|
| `handlePainRecall: parameter contract`（cli-A1/2/4/5,:263-330）+ `parsePainRecallLimit`（:332-358） | 原地不动 |
| `handlePainRecall: end-to-end`（cli-B1-B6,:360-438） | 留 pd-cli；import :25 改子路径。**cli-B5（:411-437）双依赖**：:422 直调 `recallPains` 作预断言——保留直调（同子路径 import 即可），不迁移 |
| `vi.mock('../../src/resolve-workspace.js')`（:19-21） | 留（仅外壳组使用） |
| `cli-skill-contract.test.ts`（139 行） | 原地不动（驱动 built CLI） |
| `cli-startup-host-agnostic.test.ts` | 原地不动 |

**新增**：`pain-recall-capability.test.ts`（§10）、守卫/导出面/黄金（§8/§9）。

**基建核对**：core vitest include 已覆盖 `src/runtime-v2/__tests__/**/*.test.ts`（DELTA-AUDIT §C.9）；better-sqlite3 是 core runtime 依赖——迁移测试**零新依赖**；真 sqlite 临时夹具模式 core 已有先例（`activation-compatibility-read-model.test.ts:21,130`）。

## 8. 新增架构守卫（位置：`architecture-regression.test.ts` 或独立守卫测试）

### G-1｜Core 内 Read Model 引用白名单（生产代码与测试代码分域扫描）

**A. 生产代码规则**（扫描范围 `packages/principles-core/src/**`，**排除** `**/__tests__/**` 与 `*.test.ts`）：

- `pain-recall-capability.ts` 是唯一允许引用 `pain-recall-read-model.js` 的**生产**业务模块（相对 import）。
- 其他任何生产模块不得直接引用 Read Model（静态 import、`export … from` re-export、`import()` 动态导入一律禁止——防止以间接方式绕过约束）。
- 不得出现 Core 对 pd-cli / host-runtime 的反向依赖（既有 DAG 语义维持）。

**B. 测试代码规则**（扫描范围为 `__tests__` 内**非** G-1-A 域；合法引用不触发 G-1）：

以下测试文件允许直接引用 Read Model（相对 import）：
- `pain-recall-readonly.test.ts`（只读矩阵）
- `pain-recall-service.test.ts`（服务行为四组）
- `pain-recall-capability.test.ts`（Facade 契约，经 Facade 间接 + 必要时直调对照）

测试代码可按测试职责引用内部模块 `pain-recall-snapshot-hooks.js`（见 §7 钩子迁移）。**测试钩子不得进入任何公共 exports 键**（由 G-2 钉死）。

**C. 守卫验收标准**（防平凡通过）：

1. 生产域与测试域**分别扫描**——守卫先按路径划分域，再对生产域执行白名单断言；
2. 上述三个测试文件对 Read Model 的引用**不触发** G-1（守卫自测试：构造一个合法测试引用，断言守卫不报错）；
3. 任何**非授权生产模块**引用 Read Model 必须失败（守卫自测试：构造一个越权生产引用夹具/用例，断言守卫报错）；
4. Facade 的合法引用被守卫显式识别（白名单含该文件名，而非"恰好唯一"）；
5. 零新增第三方依赖（守卫用既有测试设施实现，沿用 architecture-regression.test.ts 的源码扫描风格：读文件 + import 语句解析）；
6. 守卫不得因扫描范围写错（例如误扫全部文件或漏扫生产域）而平凡通过——第 2/3 条负例即为其证明。

### 其余守卫

| 守卫 | 断言 | 位置建议 |
|---|---|---|
| G-2 子路径导出面快照 | 两个新 exports 键的导出名集合精确等于预期清单；**断言不含** `painRecallSnapshotTestHooks` | 新增 describe 于 architecture-regression.test.ts（rg 逻辑测试化） |
| G-3 pd-cli 引用面 | `packages/pd-cli/src/**` 对 `pain-recall-capability` 零引用；对 Read Model 子路径引用仅 `commands/pain-recall.ts` 一处 | 同上 |
| G-4（Gate 4 预置位） | 未来 MCP Adapter 包仅可 import capability 子路径——本 PR 只留 TODO 注释 + 守卫骨架注释（不实现，P7） | 注释位 |
| 既有自动生效 | IO seam 双守卫（注册即绿，仅辖生产源码——测试文件本就被排除：eslint :196-205 / arch-test :3850-3851）；barrel 守卫（零触碰即绿）；DAG 守卫 | 无需动作 |

## 9. CLI 黄金测试（新增 `pd-cli/tests/commands/pain-recall.golden.test.ts`）

- **机制**：检入黄金夹具（合成工作区：ledger + trajectory.db(WAL) + state.db 三源、含多路径关联/部分可用场景）+ 黄金 JSON 文件（**迁移 PR 之前**在旧实现上生成并检入）；测试构建真实 CLI（或直接驱动 `handlePainRecalls` + 捕获 stdout）对同一夹具运行，断言输出与黄金文件**逐字节等价**。
- **生成时点纪律**：黄金文件必须在删除旧服务之前的同一 PR 内、由旧路径实现生成（PR 叙述中记录生成命令与 SHA-256）；这使"等价"有锚。
- 覆盖：ok / no_matches / partial / principle_not_found / 参数错误（--json 信封）/ 默认 limit 截断，至少六场景。
- 退出码断言随行（0/1 表）。

## 10. OD-A 字段泄露测试（`pain-recall-capability.test.ts` 核心）

1. **ALLOW 逐项存在**：构造全字段可用夹具 → 断言每个 ALLOWED_PATHS 叶在信封中存在且值 == Read Model 完整结果对应字段（**同时满足 v0.5 §11 D parity**）。
2. **DENY 逐项缺省**：断言 DENY 集每个键路径在序列化信封全文（`JSON.stringify` 整树）中**零出现**（键与值双重：植入唯一哨兵值 `LEAK-<field>`，全文搜索零命中）。
3. **错误路径泄露**：not_found/unavailable/invalid_input 三类信封的 error.message/warnings 同样过哨兵扫描（错误文本不得回带任何 DENY 内容——包括 `statusDetail` 的原文）。
4. **键路径自检负例**：测试用注入手段（仅测试可达）在投影输出中加一个越界字段 → 断言 Facade 自检返回 unavailable 且不返回违规负载。
5. **快照**：信封 JSON 结构快照（字段树级，值参数化）钉 `od-a-v1`。
6. **statusDetail 冻结语义**：断言 data 中无 `statusDetail` 叶；`pain_not_found` 场景断言 `error.code='pain_not_found'`（经 statusDetail 派生路径）。
7. **单次 ≤10 条（Core Capability 约束，v0.5 §7.5.2）**：limit 上界（10）/下界（1）/缺省（3）/非法值（0、负数、11、99、非整数、非数值）逐项断言——合法透传、非法 fail-closed `invalid_input`；构造 >10 条关联的夹具断言返回条数 ≤ limit 且 `truncated` 语义正确（既有服务行为，迁移后不退化）。

## 11. WAL 与只读回归测试

- 25 用例矩阵**整体随迁**（§7），迁移即回归——ro-×11 覆盖 WAL quiet/live-writer/empty-wal/crashed-trio/mixed 全模式 sidecar 零创建、缺库不建库、字节哈希不变；race/inj/aba/interleave 覆盖快照竞态与故障注入。
- **迁移等价附加断言**：readonly 测试头部增加一项"staging 根清理"汇总断言（现有 finally 清理路径已测，保持）。
- **注入健全性断言（防"测试平凡通过"）**：hooks 拆分为独立模块后，存在接线错误导致注入静默失效的风险——race/inj 用例会在无注入的情况下平凡通过，看似绿实未测。迁移套件须新增健全性断言：每个注入用例断言注入器实际被调用（如 `afterCopyFile` 计数 > 0、`mkdtempSync` 被替换生效），计数为 0 即测试失败。此断言在迁移 PR 中与用例同迁。
- **停止条件**（P0）：任一矩阵用例红 = 立即停 PR；禁止通过放宽断言变绿（v0.5 §11.5 语义）。
- core 测试运行注意（环境）：矩阵用例自带临时目录夹具，无 workspace 依赖；如遇 vitest 并行 flaky（历史经验：`.pd-test-temp` 三项），按房例 `--maxWorkers=2` 复核后再判。

## 12. 发布与依赖版本兼容方案

| 项 | 方案 |
|---|---|
| changeset（最低集） | `@principles/core: minor`（新公共子路径=新 API）+ `@principles/pd-cli: patch`（内部接线） |
| changeset（推荐集，PRI-1065 先例 `5ac3a8863`） | + `principles-disciple: patch` + `create-principles-disciple: patch`（安装器 bundle 含 core 字节；C4 守卫仅强制 plugin⇒installer，但保守同批避免 cohort 错位）——以实施 PR 评审最终定 |
| 依赖范围 | **零编辑**：全部 core 依赖方 `^1.297.x` 已容纳 1.298.0；Version PR `updateInternalDependencies:"patch"` 自动 bump |
| 发布顺序 | PR 合并 → Version PR（自动）→ 合并 Version PR = cohort 定版 → publish 列车 → runtime pins 自动刷新（`sync-codex-runtime-pins.mjs`，非手工） |
| release-locks | core manifest 变更（exports 增键）→ 按 ERR-131 政策在安装器包跑 `npm run generate:release-locks` 再生 + `check:release-locks` 验证（同 PR 或紧随的维护 PR，按当时 release 政策） |
| 兼容断言 | PR 内验证 `packages/pd-cli` 构建产物 import 解析（worktree READY 检查 L3：`@principles/core/runtime-v2/pain-recall` 真实可解析）；主 checkout 与 worktree 均构建后跑定向测试 |

## 13. 单次回滚方案

- **前提**：全部步骤在同一变更集（§1 表），无中间合并点。
- **回滚**：`git revert <PR merge>` 一次执行——文件移回原位（git rename 追踪）、exports/registry/REQUIRED_SOURCE_FILES 行回收、commands import 复原、测试归位。无数据迁移、无配置残留、无用户可见状态。
- **发布后回滚**：core 已发 minor 也不阻塞 revert——子路径是纯新增（semver 加法），回退 PR 发 patch 即可；pd-cli 回退后恢复自包含。
- **不可回滚形态检查**（PR 自审项）：diff 中不得出现无法由单 revert 撤销的操作（无 schema、无数据、无配置文件写入）。

## 14. P0 / P1 停止条件

**P0（立即停止，修复或放弃该变更集）**：
1. 任一只读矩阵用例（ro/race/inj/aba/interleave）红；
2. CLI 黄金等价失败或任何 CLI 输出/退出码非授权变化；
3. OD-A DENY 字段（键或值）出现于信封/错误/日志；
4. core 出现对 pd-cli/host-runtime 的反向 import 或依赖环；
5. 守卫 G-1/G-2/G-3 无法建立（说明导出面或引用面失控）；
6. 迁移引入 schema 变更/feature flag/未批准依赖；
7. barrel fixture 被迫触碰（说明违反 R3——停止并重新设计导出方式）。

**P1（暂停并升级 Owner/评审，不得静默绕过）**：
1. 测试拆分导致任何用例丢失（迁移前后用例计数对账不齐）；
2. 发布联动（plugin/installer changeset、release-locks）无法按 §12 完成或政策冲突；
3. `pain-recall.ts` 在实施期间出现他人并发修改（前置复核失败）；
4. 黄金夹具生成结果与预期业务语义不符（说明基线认知有误）；
5. 单 PR 规模/验证质量冲突（OPTIMIZED §12：不得为守"单 PR"降验证质量——暂停并提交拆分方案）。
6. **范围越权信号**：diff 中出现 32 KiB 响应预算、10 秒超时控制器、取消机制、MCP 协议类型（content block / isError / transport）等 Gate 4 Adapter 职责进入 Core/Facade——立即暂停并收缩范围（这些属 §17 Gate 4 验收前置项，不是 Gate 3 代码任务）。

## 15. "重点防止"八项 → 机制映射

| 防止项 | 机制 |
|---|---|
| 双重业务实现 | 同一变更集 DELETE 旧文件 + rg 零残留断言（§6.4）+ G-1 引用白名单 |
| Core 反向依赖 pd-cli | 既有零反向基线 + DAG 守卫 + G-3 |
| MCP Adapter 直接获得完整 Read Model | 双子路径分离 + G-2/G-3 +（Gate 4）G-4 包级白名单 |
| OD-A 字段泄露 | 构造即白名单 + 每调用自检 + §10 六组测试 + P0-3 |
| CLI 输出非授权变化 | §9.1 不变量表 + 黄金逐字节等价 + P0-2 |
| 测试钩子进入公共 API | 内部模块拆分 + G-2 导出面快照（显式断言不含钩子） |
| 只读契约退化 | F7 显式化（禁止统一构造）+ 矩阵随迁 + P0-1 |
| 包发布顺序问题 | §12 changeset 组合（PRI-1065 模式）+ Version PR 自动 bump + pins 自动刷新 + release-locks 政策 |

## 16. 实施前最终核对单（PR 开工时执行）

- [ ] OG-1 已采信 SPEC v0.5（含 §7.5 数值）；OG-2 已授权
- [ ] `git log 796000a10..<当日HEAD> -- packages/pd-cli/src/services/pain-recall.ts` 确认零外部修改
- [ ] 独立 worktree（`npm run dev:worktree -- PRI-<id> pain-recall-extraction`）+ claim + bootstrap READY
- [ ] 黄金夹具与黄金 JSON 在删除旧路径前生成并检入（记录 SHA-256）
- [ ] §1 全表步骤在单变更集内完成；§14 停止条件全程有效
- [ ] **范围自检**：diff 中无任何 Gate 4 Adapter 职责（32 KiB 预算、10s 超时/取消、MCP 协议类型——见 §17 与 §14 P1-6）
- [ ] PR 描述附：Complexity Delta（v0.5 §1 已述）+ Owner Review Card + 本文引用

---

## 17. Gate 4 验收前置项（记录用；**非 Gate 3 实施任务**）

以下两项数值限制的责任层级是**未来 MCP Adapter（Gate 4，OG-3 授权）**，此处成文是为了：(a) OG-1 数值确认时有完整责任归属；(b) 防止 Gate 3 实施人员误将其实现进 Core。Gate 3 的 Facade/Read Model **不实现**以下任何机制。

### 17.1 结构化响应 ≤ 32 KiB（32768 bytes）——MCP Adapter 传输约束（v0.5 §7.5.3）

- **职责**：MCP Adapter 对最终 MCP 响应的体积预算。不属 Core Read Model，也不属 Capability Facade 的传输层职责（Facade 产出的是内存中的信封对象，无传输语义）。
- **测量口径**：沿用 Gate 2 的单一 text content block 约定，测量其中 **JSON 文本的 UTF-8 编码字节数**（`Buffer.byteLength(json, 'utf8')` 语义）——不是 JavaScript 字符串长度（.length），不是整个 JSON-RPC 网络报文长度。
- **超限处理**：不得静默截断结果；不得删除 OD-A 白名单字段后继续返回成功；不得 false-success。应返回**有界、符合既有契约的失败信封**：外层状态 `unavailable`（既有状态集，不新增顶层状态）+ 稳定错误码（建议 `response_budget_exceeded`，随 Gate 4 契约冻结确认）。
- **10 条 vs 32 KiB 等价性**：**未证明为契约不变量，不得声称"10 条必然满足 32 KiB"**。分析性依据（OD-A 投影不含数据域自由文本——均为枚举/计数/有界回显，10 条投影量级远低于 32 KiB）只能作为设计参考；Gate 4 必测场景：以允许字段最大合理长度构造 10 条结果的合成夹具，实测序列化字节数并验证超限路径。

### 17.2 调用截止 10 秒——MCP Adapter 执行边界（v0.5 §7.5.4）

- **计时范围**：单次工具调用响应截止时间，从 **MCP Server 工具处理器开始处理请求**时计时，包括参数校验、Core 调用（recallPains）、OD-A 投影、响应序列化；**不包括** Server 进程启动时间与客户端排队时间。
- **超时语义**：超时不得返回成功；使用既有 `unavailable` 信封 + 明确超时错误语义（沿用 Gate 2 已验证的 `tool_execution_failed` 错误码或其超时细分，随 Gate 4 冻结）。**诚实性要求**：`Promise.race` 类机制只是停止等待，**不等于底层任务已取消**——若底层只读调用不支持真正取消，必须如实记录（文档与代码注释）；超时后迟到的结果不得再次发送、不得被记录为成功。
- **验证方式**：Gate 4 通过可控延迟的合成测试验证（如注入延迟的 Core 调用或 slow-server 夹具，Gate 2 已有 `slow-server.mjs` 模板）。
- **Gate 3 边界**：不实现 MCP Server、超时控制器或取消机制（Owner 已决 ✅6）。

---

*本计划与 v0.5 SPEC、DELTA-AUDIT、OWNER-DECISION-CARD 四文件互为引用；任何三者冲突时以 v0.5 契约条款为准，事实争议以 DELTA-AUDIT 证据为准。*
