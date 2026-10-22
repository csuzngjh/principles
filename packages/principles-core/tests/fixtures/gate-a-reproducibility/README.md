# Gate A 可复现夹具（gate-a-reproducibility）

> **这是什么**：2026-10-17 首轮 Gate A 只读审计（基线 `702d9223`）与 2026-10-18 freshness-delta 复验（基线 `f2539e07e`）所使用的两套合成夹具的**逐字节原样副本**，外加一个把源码快照（`core-mirror`）落到固定相对路径的准备脚本。
>
> **为什么入库**：此前这两套夹具只存在于 gitignored 的 `.tmp/`，任何人在新基线上都无法重放那 30 项断言——这正是 P-02 无法在当前 main 复验的直接原因。入库后，重放变为一条可复现命令。
>
> **不是什么**：这不是新写的测试套件。断言文本、期望值、判定逻辑与原始文件**逐字节一致**（SHA-256 见 §5）。它也不是 Gate B/C 的任何授权。

---

## 1. 目录结构

```
packages/principles-core/tests/fixtures/
├── .gitignore                          # 只忽略 core-mirror/（生成物）
├── core-mirror/                        # 生成物：git archive 源码快照（不入库）
│   ├── packages/principles-core/src/…
│   ├── packages/host-runtime/src/…
│   └── .provenance.json                # ref / SHA / 文件数 / 生成时间
└── gate-a-reproducibility/
    ├── fixture-ledger.ts               # 原样副本（13 项断言）
    ├── fixture-sqlite.ts               # 原样副本（17 项断言）
    ├── replay.test.ts                  # 原样副本（vitest 仅作 TS loader）
    ├── prepare-mirror.mjs              # 新增：生成 core-mirror
    └── README.md                       # 本文件
```

## 2. 运行方式

```bash
# 1) 生成源码快照（默认 origin/main；可显式指定任意 ref/SHA）
node packages/principles-core/tests/fixtures/gate-a-reproducibility/prepare-mirror.mjs [ref]

# 2) 跑重放——必须在【仓库根目录】执行，并带 --root=.
#    fixture-sqlite 约需 5s，故显式放大超时（默认 5s 会误判为超时失败）
npx vitest run packages/principles-core/tests/fixtures/gate-a-reproducibility/replay.test.ts \
  --root=. --testTimeout=120000 --reporter=verbose
```

两个夹具各自把结果以 JSON 打印到 stdout；`pass/fail` 由夹具自身判定，vitest 只负责装载 TS。判定通过 = 两个 JSON 的 `failed` 均为 `0`。

### 为什么必须在仓库根目录跑

`packages/principles-core/vitest.config.ts` 新增了 `exclude: ['tests/fixtures/**']`（原因见下），该排除对**包内**显式路径同样生效，所以在 `packages/principles-core/` 目录下直接指定文件会报 "No test files found"。仓库根目录的 `vitest.config.mjs` 不做此排除，因此从根目录运行即可。

### 为什么默认测试发现不到它

CI 的 `test-principles-core` 作业在 `packages/principles-core` 下执行 `npm run test -- --coverage`，其 `include` 含 `tests/**/*.test.ts`，会把本目录的 `replay.test.ts` 纳进默认发现。但 `core-mirror` 是生成物，CI 的干净检出里不存在，直接发现会让 CI 失败。因此该配置新增 `exclude: ['tests/fixtures/**']`（与 root 配置排除 `tests/e2e-fixtures/**` 同一先例）。**重放是显式命令，不是默认测试，也不在 CI 中自动运行。**

## 3. 环境要求

- Node ≥ 18 + 仓库依赖已安装（`better-sqlite3` 需可用原生模块）；
- `git`（`git archive`）与 `tar`（GNU tar 或 bsdtar；脚本会依次尝试 `tar` 与 `C:/Windows/System32/tar.exe`）；
- 无需网络、无需数据库、无需真实 workspace。

若还要跑 §10 的定向回归，需先构建 `@principles/workbuddy-adapter` 与 `@principles/codex-adapter`（其测试以 `dist/pd-hook.js` 为生产入口；未构建时会报 `ENOENT ... dist/pd-hook.js`，那是环境缺口，不是产品失败）。

## 4. 断言映射（30 项）

### 4.1 `fixture-ledger.ts` — Ledger 可用性与身份解析（13 项）

| # | 断言 | 期望 | 对应 Gate A 结论 |
|---|---|---|---|
| L01 | 目录/文件均缺失 → availability | `empty` | A-01 §1.2 三态 |
| L02 | 合法非空 JSON → availability | `ok` | A-01 §1.2 |
| L03 | `loadLedger()` 丢弃 availability | 见夹具 | A-01（E3：不得用它判可用性） |
| L04 | 零字节文件 → availability | `empty` | F-03 |
| L05 | 仅空白文件 → availability | `empty` | F-03 |
| L06 | 语法非法 JSON → availability | `unreadable` | F-03 |
| L07 | 语法合法但结构非法的 4 种输入 | 全部 `ok` | F-04（宽松解析归空） |
| L08 | 直接盖章 UUID 且为 Ledger 成员 | `resolved` | A-01 身份解析 |
| L09 | 直接盖章 UUID 但非成员 | `unresolved:principle_not_in_ledger` | A-01（拒绝猜测） |
| L10 | candidate 映射到 2 条原则 | `unresolved` | A-01（双匹配不猜） |
| L11 | candidate 映射到 1 条原则 | `resolved` | A-01（lineage 解析） |
| L12 | Ledger 不可读 + 已盖章 ID | `ledger_unavailable` | A-01（不可读不等于 0） |
| L13 | `candidateIdFromDreamerTaskId` 旧命名 | 提取 UUID | A-01（candidateId 反查） |

### 4.2 `fixture-sqlite.ts` — 只读入口与副作用证明（17 项）

| # | 断言 | 期望 | 对应 Gate A 结论 |
|---|---|---|---|
| S01 | `SqliteConnection(readonly, no-bootstrap)` 缺 state.db | 抛错 | A-03 |
| S02 | 同上，且**不创建** `.pd/state.db` | `false` | A-03 状态不变 |
| S03 | 同上，且**不创建** `.pd` 目录 | `false` | A-03 状态不变 |
| S04 | 对照：默认 `bootstrapIfMissing:true` | 会建库（写） | A-03（危险默认，反证只读需显式） |
| S05 | 同上，state.db 确实存在 | `true` | A-03 |
| S06 | `openTrajectoryDbReadonly` 缺库 | `TrajectoryDbUnavailableError` | A-03 |
| S07 | 同上，且**不创建** `.state` 目录 | `false` | A-03 状态不变 |
| S08 | `listGovernanceObservations` 缺库 | `trajectory_db_not_found`，不建文件 | A-03 |
| S09 | 对已存在但无 governance schema 的库调用 | `ok:true` | A-03 |
| S10 | 副作用：governance 表被创建 | `true` | **A-03 负面结论**（该入口不得作只读） |
| S11 | 副作用：`governance_observations` 存在 | `true` | 同上 |
| S12 | 副作用：`journal_mode` 变为 `wal` | `wal` | 同上 |
| S13 | `BehaviorEvidencePort` 缺 trajectory.db | 抛 `evidence_source_error` | A-02/A-03 |
| S14 | 同上，且**不创建** `.state/trajectory.db` | `false` | A-03 状态不变 |
| S15 | 前一步运行未在库周围产生额外文件 | `false` | A-03 |
| S16 | Port 读已存在夹具库：只读打开、无 WAL 翻转、无 governance schema | `govTables=0; wal=false` | A-03 正面结论 |
| S17 | 上一项的明细（`ok7`、`journal`）记录在断言名中 | `proven` | 见下方"已知弱断言" |

### 已知弱断言（原样保留，未修改）

**S17 是自满足断言**：无论 `ok7`/`journal` 实际取值如何，期望值恒为 `proven`。它的信息量在于把实际值编码进断言名。这是原始夹具的设计，本次**未改写**；使用者应把 S16 作为该场景的有效判据，S17 仅作记录。此项在 §6 覆盖差异中标注。

## 5. 原始文件清单与 SHA-256

来源：`D:\Code\_worktrees\principles\PRI-1000-gate-a-freshness-delta\.tmp\pri-1000\fixture-f2539e07e\`（PRI-1000 freshness replay 的逐字节副本；其上游为 2026-10-17 Gate A 夹具）。

| 文件 | 行数 | SHA-256 |
|---|---|---|
| `fixture-ledger.ts` | 145 | `9cc272ea5e7feeff9ad86640ee88521e5ee0fec5f4b101fcaa4a20ddb2d7a55d` |
| `fixture-sqlite.ts` | 167 | `6959aa3482d4820d3b5cee67624c8f6cb1cc11f8dae108fdb99b8c025c65a3a0` |
| `replay.test.ts` | 14 | `e10fc82df09d24751d1316d7d05a303fef29d9bcd1bab2e9caa46e0113fbf862` |

> `replay.test.ts` 的测试标题写着 "against f2539e07e mirror"——这是 PRI-1000 时期的历史文本，本次**未改写**。实际被测快照的 SHA 以 `core-mirror/.provenance.json` 为准。

## 6. 数据安全边界

- 全部输入为合成数据：`os.tmpdir()` 下 `mkdtempSync` 创建的临时工作区、伪造 UUID（`a1a1a1a1-…`）、假 artifact/候选/任务 ID、假命令串（`fake-cmd-invalid --flag test`）、假 pain ID（`pain_1_ok`）。
- **不含**真实用户历史、私人内容、Owner 原话、凭据、授权数据、真实 workspace 路径。
- 运行过程中只在 `os.tmpdir()` 与 `core-mirror/` 写文件；不打开任何真实 `.pd`/`.state`/生产库。
- `core-mirror` 是 `git archive` 快照，只含两个包的 `src/` 下 `.ts` 文件。

## 7. 覆盖范围与已知缺口

本套件覆盖：Ledger 可用性三态/四态、身份解析拒绝语义、SQLite 只读打开与状态不变、`listGovernanceObservations` 的写副作用（负面证据）、`BehaviorEvidencePort` 只读证明。

**未覆盖**（需要另外的证据，见 Gate A 增量审计报告）：

- `readWorkspaceRuleContextRowsBefore()`（PRI-1015 新增，2026-10-17 时不存在）——由增量审计的 18 项合成探针覆盖；
- 真实分母（`AUTHORIZED_REAL_SAMPLE` = 0，真实覆盖率仍 `NOT_MEASURED`）；
- 跨 session / 跨 project / 并发锁 / 旧 schema 升级顺序。

## 8. 与 P-02 的关系

本套件的通过**只证明**"30 项原始断言在当前 main 上仍然成立"，不证明 Gate B 已授权、不证明任何行为收益。P-02 的裁决仍由 Owner 依据完整证据链作出。

## 9. 本轮实跑结果（2026-10-22）

| 项 | 值 |
|---|---|
| 执行 worktree | `D:\Code\_worktrees\principles\PRI-1001-gate-a-fixtures`（独立 worktree，基线 = `origin/main`） |
| 被测快照 | `origin/main` @ `2fb3b04c8fae1fc865f2297ea448dc4c531ff7cf`（`core-mirror/.provenance.json` 记录） |
| 夹具哈希 | 三个 `.ts` 的 SHA-256 与 §5 表中逐一相符（逐字节副本） |

| 运行 | 命令 | 结果 |
|---|---|---|
| fixture-ledger | 见 §2 | **13 / 13 PASS**，`failed: 0` |
| fixture-sqlite | 见 §2 | **17 / 17 PASS**，`failed: 0` |
| 合计 | — | **30 / 30 PASS，0 失败，0 跳过** |
| 定向回归 | `npx vitest run packages/workbuddy-adapter/tests/explicit-owner-statement.test.ts packages/workbuddy-adapter/tests/plugin-skeleton.test.ts packages/codex-adapter/tests/codex-explicit-owner-statement.test.ts --root=. --testTimeout=120000` | **43 / 43 用例 PASS，0 失败** |

### 证据形式的差异（如实披露）

2026-10-18 freshness-delta 报告写的是"30/30 夹具 + **72/72 定向断言**"。本轮对三个定向测试文件按 **vitest 用例**计数为 43/43；未按原报告的"断言条数"口径重新计数，因此**不声称复现了 72/72 这个数字**。两个口径下的通过率均为 100%，但数字口径不同，使用者应知悉。

### 一个过程性发现

首次运行定向回归时有 24 个失败，根因是 `packages/workbuddy-adapter/dist/pd-hook.js` 不存在（未构建该 workspace）。补齐 `npm run build --workspace=@principles/workbuddy-adapter` 与 `--workspace=@principles/codex-adapter` 后 43/43 全部通过。**这是本地环境缺口，不是产品缺陷，也未修改任何测试或代码以迁就它。**
