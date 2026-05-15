# 版本与兼容性架构（Versioning & Compatibility Architecture）

> **状态**: Active
> **最后更新**: 2026-05-15
> **关联**: `PD_ARCHITECTURE_OVERVIEW.md` §6.5, `DATA_ARCHITECTURE.md`, `GLOSSARY.md`

本文档定义 PD 系统的版本管理、Schema 演化、数据迁移、API/CLI 兼容性、Deprecation 流程。

---

## 1. 设计原则

### 1.1 核心信条

1. **数据持久化是契约** —— 老数据必须能被新代码读取
2. **Schema 演化只增不减** —— 新增字段允许，删除字段需要 deprecation 流程
3. **代码兼容数据，不强制相反** —— 升级 PD 不要求用户先迁移数据
4. **明确版本边界** —— 每个 schema 有版本号，运行时校验
5. **可读的 deprecation** —— 用户能从 log / warning 知道哪些用法即将失效

### 1.2 兼容性维度

| 维度 | 兼容方向 | 维护周期 |
|------|---------|---------|
| 数据 schema（SQLite / JSON） | 新代码读老数据 | 长期（≥ 12 个月）|
| Runtime 接口（PDRuntimeAdapter）| 新接口兼容老 adapter | 中期（≥ 6 个月）|
| Public API（@principles/core 导出）| Semver | 跟随 npm 版本 |
| CLI 命令 | 新版兼容老用法 | 中期（≥ 6 个月）|
| Hook 接口（OpenClaw plugin SDK）| 跟随 OpenClaw | 跟随上游 |
| 配置文件 schema | 新代码读老 config | 中期 |

---

## 2. 版本号体系

### 2.1 版本来源

| 版本号 | 含义 | 位置 |
|--------|-----|------|
| `principlesPackageVersion` | npm 包版本 | `packages/*/package.json` |
| `RUNTIME_V2_SCHEMA_VERSION` | Runtime v2 schema 总版本 | `runtime-v2/schema-version.ts` |
| `LedgerSchemaVersion` | Ledger 文件 schema | `principle-tree-ledger.ts` |
| `DiagnosticianOutputV1` 中的 `v1` | 单 schema 版本 | 各 output schema |
| `Plugin Manifest version` | OpenClaw plugin 版本 | `openclaw.plugin.json` |

### 2.2 npm 包版本（Semver）

PD 严格遵循 Semantic Versioning：

| 变更 | 版本 |
|------|-----|
| Bug fix（不影响 API）| patch（1.0.0 → 1.0.1）|
| 新增 feature（向后兼容）| minor（1.0.0 → 1.1.0）|
| Breaking change | major（1.0.0 → 2.0.0）|

### 2.3 Schema 版本

Schema 版本独立于 npm 版本，因为多个 npm minor 可能共享同一个 schema：

```typescript
// @principles/core/runtime-v2/schema-version.ts
export const RUNTIME_V2_SCHEMA_VERSION = 'v1' as const;

// 子 schema 版本（独立演进）
export const DIAGNOSTICIAN_OUTPUT_SCHEMA = 'diagnostician-output-v1';
export const DREAMER_OUTPUT_SCHEMA = 'dreamer-output-v1';
// ...
```

---

## 3. Schema 演化规则

### 3.1 允许的变更（不需要版本递增）

| 变更类型 | 示例 |
|---------|-----|
| 新增可选字段（`Type.Optional`）| `interface X { a: string; b?: number }` 加上 `c?: string` |
| 放宽现有字段（如 string → string \| number）| 谨慎，仅当所有读者都能处理 |
| 文档说明修改 | 注释 / JSDoc |

### 3.2 需要版本递增的变更（破坏性）

| 变更类型 | 示例 | 处理方式 |
|---------|-----|---------|
| 删除字段 | 删除 `actionPath` | 经 deprecation → 新版本 |
| 重命名字段 | `painId` → `signalId` | 经 deprecation alias → 新版本 |
| 必选字段类型变更 | `string` → `number` | 新版本 schema |
| 添加必选字段 | 加上没有 default 的 `Required` 字段 | 新版本 + 数据迁移 |
| 收窄现有字段 | union 缩小 | 谨慎，需调研使用情况 |
| 改变状态机转换 | 增加新状态 | 新版本 + 迁移规则 |

### 3.3 Schema 版本递增的命名

```
v1 → v2

文件命名：
diagnostician-output.ts                 ← 当前版本
diagnostician-output-v2.ts              ← 新版本

Schema constant：
DIAGNOSTICIAN_OUTPUT_SCHEMA = 'diagnostician-output-v1'   ← 老版本保留
DIAGNOSTICIAN_OUTPUT_SCHEMA_V2 = 'diagnostician-output-v2' ← 新版本
```

### 3.4 多版本共存

新版本上线时，旧版本至少保留**一个 minor 版本**周期：

```typescript
// runtime-v2/diagnostician-runner.ts
const SUPPORTED_OUTPUT_SCHEMAS = [
  'diagnostician-output-v1',
  'diagnostician-output-v2',
] as const;

// 解析时容错读取
function parseOutput(raw: unknown, schemaRef: string): DiagnosticianOutput {
  if (schemaRef === 'diagnostician-output-v2') {
    return parseV2(raw);
  }
  if (schemaRef === 'diagnostician-output-v1') {
    return upgradeV1ToV2(parseV1(raw));
  }
  throw new PDRuntimeError('output_invalid', `Unknown schema: ${schemaRef}`);
}
```

---

## 4. SQLite Schema 迁移

### 4.1 迁移机制

PD 使用 **forward-only migration**（不允许 down migration）。

#### 4.1.1 Migration 文件结构

```
@principles/core/runtime-v2/store/migrations/
├── 001-initial.sql
├── 002-add-pi-artifacts.sql
├── 003-add-approvals.sql       ★ 待建
├── 004-add-rejection-feedbacks.sql ★ 待建
└── ...
```

#### 4.1.2 Migration 表

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_id TEXT PRIMARY KEY,        -- '001-initial' 等
  applied_at TEXT NOT NULL,
  applied_by TEXT NOT NULL,             -- 'pd-cli@1.10.0' 等
  hash TEXT NOT NULL                    -- migration 文件内容的 SHA-256
);
```

#### 4.1.3 启动时迁移

```typescript
// @principles/core/runtime-v2/store/migration-runner.ts (existing)
async function applyMigrations(db: Database, migrations: Migration[]): Promise<void> {
  const applied = await getAppliedMigrations(db);
  const pending = migrations.filter(m => !applied.has(m.id));

  for (const migration of pending) {
    db.exec('BEGIN TRANSACTION');
    try {
      db.exec(migration.sql);
      db.prepare(`
        INSERT INTO schema_migrations (migration_id, applied_at, applied_by, hash)
        VALUES (?, ?, ?, ?)
      `).run(migration.id, new Date().toISOString(), getProcessVersion(), migration.hash);
      db.exec('COMMIT');
      logger.info('Applied migration', { migrationId: migration.id });
      auditLog.write({ event: 'schema_migration', target: { kind: 'sqlite_schema', id: migration.id } });
    } catch (err) {
      db.exec('ROLLBACK');
      throw new PDRuntimeError('storage_unavailable', `Migration ${migration.id} failed`, { cause: err });
    }
  }
}
```

### 4.2 Migration 编写规范

#### 4.2.1 命名

```
{ordinal}-{kebab-case-description}.sql

例：
003-add-approvals.sql
004-add-pi-artifact-validation-status-index.sql
```

#### 4.2.2 内容规范

```sql
-- 003-add-approvals.sql
-- Description: Add approvals table for ADR-0006 hybrid activation mechanism.
-- ADR: ADR-0006
-- Author: Reviewer
-- Date: 2026-05-XX

-- New table
CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  -- ... 其他字段
  FOREIGN KEY (artifact_id) REFERENCES pi_artifacts(artifact_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, channel);
CREATE INDEX IF NOT EXISTS idx_approvals_artifact ON approvals(artifact_id);
```

#### 4.2.3 强制约束

| ID | 约束 |
|----|------|
| MIG-1 | 一次 migration 是一个事务（BEGIN / COMMIT）|
| MIG-2 | migration 必须 idempotent（`CREATE TABLE IF NOT EXISTS` 等）|
| MIG-3 | 不允许 `DROP TABLE` / `DROP COLUMN` 在 minor 版本中 |
| MIG-4 | 不允许 destructive 修改（如改类型）—— 需新表 + 数据复制 |
| MIG-5 | migration 一旦发布**不可修改**（hash 校验失败启动失败）|
| MIG-6 | 添加索引使用 `IF NOT EXISTS` |

### 4.3 复杂迁移：新表 + 数据复制 + 旧表保留

```sql
-- 005-rename-tasks-id-column.sql
-- 把 tasks.task_id 改为 tasks.id

-- 1. 新表
CREATE TABLE IF NOT EXISTS tasks_v2 (
  id TEXT PRIMARY KEY,             -- 新名
  task_kind TEXT NOT NULL,
  -- ... 其他列
);

-- 2. 复制数据
INSERT INTO tasks_v2 (id, task_kind, ...)
SELECT task_id, task_kind, ... FROM tasks;

-- 3. 切换：保留 tasks 表至少 1 个 minor 版本，期间双写
-- （不在本 migration 中删除旧表，新代码读 tasks_v2）

-- 4. 在下一个 minor 版本中可执行清理 migration
```

---

## 5. Ledger（JSON）Schema 迁移

### 5.1 设计

Ledger 文件没有 SQL migration，而是通过**版本字段 + parser**实现：

```typescript
// principle-tree-ledger.ts 中已有简化版

interface LedgerFile {
  schemaVersion: string;            // 'ledger-v1', 'ledger-v2' ...
  // ...
}

function loadLedger(stateDir: string): HybridLedgerStore {
  const raw = readLedgerFromFile(...);
  const version = raw.schemaVersion ?? 'ledger-v0';

  switch (version) {
    case 'ledger-v0':
      return upgradeLedgerV0ToV1(parseV0(raw));
    case 'ledger-v1':
      return parseV1(raw);
    default:
      throw new PDRuntimeError('input_invalid', `Unknown ledger version: ${version}`);
  }
}
```

### 5.2 强制约束

| ID | 约束 |
|----|------|
| LDG-1 | Ledger 写入时**必须**写入 `schemaVersion` 字段 |
| LDG-2 | 加载时必须能识别老版本，**不抛错就升级** |
| LDG-3 | 升级是**原地写回**，但通过 atomic write |
| LDG-4 | 升级失败 → 保留原文件，错误降级（plugin 启动失败 → user 必须人工修复）|

---

## 6. 数据迁移工具

### 6.1 自动迁移

Schema migration 在启动时自动应用（参见 §4.1.3）。

### 6.2 手动迁移命令

某些迁移涉及业务逻辑（不仅是 schema），需要 CLI 命令：

```bash
# 从 nocturnal artifacts 迁移到 PIArtifact（ADR-0005）
pd legacy-import nocturnal-artifacts --dry-run
pd legacy-import nocturnal-artifacts --apply

# 数据清理
pd legacy-cleanup --older-than 30d
```

### 6.3 强制约束

| ID | 约束 |
|----|------|
| LMIG-1 | 业务数据迁移**默认 dry-run**，`--apply` 才执行 |
| LMIG-2 | 必须支持中断恢复（幂等）|
| LMIG-3 | 必须输出 before/after 报告 |
| LMIG-4 | 必须写审计日志 |

---

## 7. Public API 演化（@principles/core）

### 7.1 导出的稳定性等级

每个导出（type / function / class）有一个稳定性等级：

| 等级 | 含义 | 标记 |
|------|------|------|
| `stable` | 公开 API，遵循 semver | （默认，无标记）|
| `experimental` | 可能变化 | `@experimental` JSDoc |
| `internal` | 不应被外部使用 | `@internal` JSDoc |
| `deprecated` | 即将移除 | `@deprecated` JSDoc |

### 7.2 主入口规则

```typescript
// packages/principles-core/src/index.ts
export {
  PainSignal,
  PainSignalSchema,
  validatePainSignal,
} from './pain-signal.js';                            // stable

export {
  /** @deprecated Use PainToPrincipleService instead */
  PainSignalBridge,
} from './runtime-v2/pain-signal-bridge.js';          // deprecated

export {
  /** @internal — implementation detail */
  recordPainSignalObservability,
} from './runtime-v2/pain-signal-observability.js';   // internal
```

### 7.3 Breaking change 的处理

#### 7.3.1 Deprecation 流程

```
版本 N
  │ 添加 @deprecated 标记 + alias
  │ log 警告（detect 调用）
  ▼
版本 N+1（minor）
  │ 警告日志强化
  │ docs 标注
  ▼
版本 N+2（minor）
  │ 文档移除
  │ 仍保留 alias
  ▼
版本 N+3（next major）
  │ 删除
```

#### 7.3.2 Alias 机制

```typescript
// 旧名保留 alias
export {
  /** @deprecated Use PainSignal instead */
  PainSignal as PainEvent,
} from './pain-signal.js';
```

---

## 8. CLI 兼容性

### 8.1 命令演化规则

| 类型 | 示例 | 处理 |
|------|-----|------|
| 新增命令 | `pd activation list` | 直接添加 |
| 重命名命令 | `pd nocturnal-review` → `pd internalization-review` | 旧命令 deprecation alias |
| 修改输出格式 | JSON 字段重命名 | 旧字段保留 + 新字段共存 |
| 删除命令 | 极少 | 经 2 个 minor 版本 deprecation |

### 8.2 输出格式约定

| 维度 | 约定 |
|------|-----|
| `--json` 输出格式 | **稳定** —— 字段重命名走 deprecation |
| 文本（非 json）输出 | **不稳定** —— 仅给人读 |
| Exit code | 稳定 —— 0=success, 1=user-error, 2=system-error |
| 命令名 | 稳定 —— 改名走 deprecation |

### 8.3 Deprecation 警告

```bash
$ pd nocturnal-review
[WARN] Command 'nocturnal-review' is deprecated. Use 'pd internalization-review' instead.
       This command will be removed in v2.0.0.
... (正常输出)
```

---

## 9. Plugin / OpenClaw 兼容性

### 9.1 OpenClaw plugin SDK 版本

PD 使用 OpenClaw plugin SDK 类型 shims（`packages/openclaw-plugin/src/openclaw-sdk.ts`）。当 OpenClaw API 变化时：

1. 更新 shims 以匹配新 API
2. PD plugin 在 `package.json` 标注 `peerDependency: openclaw >= X.Y.Z`
3. 不向下兼容多个 OpenClaw 大版本

### 9.2 Plugin Manifest 演化

```json
{
  "name": "Principles Disciple",
  "version": "1.10.X",
  "compatibleWith": {
    "openclaw": ">=2.0.0 <3.0.0"
  }
}
```

启动时 OpenClaw 会校验。

---

## 10. 配置 Schema 演化

### 10.1 规则

参见 `CONFIGURATION_ARCHITECTURE.md` §4.4 的 warning vs error。

| 变更 | 处理 |
|------|-----|
| 新增可选字段 | 直接添加，老 config 仍可用 |
| 重命名字段 | 老名称保留 alias（warn）一个 minor 周期 |
| 删除字段 | warn → 下一个 major 删除 |
| 类型变化 | 经 deprecation alias |
| 强制安全字段 | 不可被覆盖（参见 SECURITY_ARCHITECTURE §7.3）|

### 10.2 Config 版本字段（可选）

```yaml
# {workspace}/.pd/config/activation.yaml
version: "1.0"        # 可选，便于多版本检测
activation:
  ...
```

---

## 11. 长期数据兼容承诺

### 11.1 必须长期兼容的数据

| 数据 | 承诺 |
|------|-----|
| `state.db` schema | ≥ 12 个月（2 个 minor） |
| `principle_training_state.json` | ≥ 24 个月 |
| `audit-log.jsonl` | 永久（合规需要）|
| `.principles/skills/*` 文件 | ≥ 12 个月 |
| `.principles/implementations/code/*` | ≥ 12 个月 |
| Telemetry events | ≥ 6 个月（可归档清理）|

### 11.2 短期允许变化的

| 数据 | 周期 |
|------|-----|
| `runtime-v2/` 内部接口 | 每个 minor |
| Plugin 内部数据结构 | 每个 minor |
| 内部 cache 文件（`.pd/cache/`）| 任意时刻可清空 |

---

## 12. 不变量与守护

| ID | 不变量 | 强制方式 |
|----|------|---------|
| VER-1 | 任何 schema 变更必须有 migration | review + 测试 |
| VER-2 | Migration 文件**不可修改**（hash 校验）| migration-runner |
| VER-3 | `@deprecated` 字段必须在导出列表标注 | TypeScript / ESLint |
| VER-4 | Public API 改动需 ADR | review |
| VER-5 | 老 schema 数据必须能被新代码读取 | 集成测试 |
| VER-6 | 不允许"双 source of truth" | architecture-regression |

### 12.1 守护测试示例

```typescript
test('VER-2: existing migrations are immutable', async () => {
  const migrationsDir = 'packages/principles-core/src/runtime-v2/store/migrations';
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql'));

  for (const file of files) {
    const content = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    const hash = createHash('sha256').update(content).digest('hex');
    const expectedHash = MIGRATION_HASHES[file];   // 锁定值
    expect(hash).toBe(expectedHash);
  }
});

test('VER-5: old ledger format still loads', () => {
  const oldLedger = JSON.parse(fs.readFileSync('test/fixtures/ledger-v0.json', 'utf-8'));
  fs.writeFileSync(tempPath, JSON.stringify(oldLedger));

  const loaded = loadLedger(tempStateDir);
  expect(loaded.tree.principles).toBeDefined();
});
```

---

## 13. 发布检查清单（Release Checklist）

每次发布前必须确认：

- [ ] 所有 migration 已加 hash
- [ ] 老数据 fixtures 仍能加载
- [ ] CHANGELOG 列出所有 deprecation
- [ ] 文档同步更新（OVERVIEW + 相关）
- [ ] 老 CLI 命令 alias 仍工作（如有）
- [ ] Public API 标注 stable / deprecated / internal
- [ ] 跨包版本协调（core / plugin / cli / console）
- [ ] semver 正确递增

---

## 14. 实施进度

| 项目 | 状态 |
|------|-----|
| Migration runner | ✅ 已有基础 |
| Migration 文件 | ⚠️ 现有 migrations 待补 hash 校验 |
| Schema 版本字段（数据中） | ⚠️ 部分（PainSignal 已有，Ledger 待加）|
| `@deprecated` 标注规范 | ⚠️ 部分（runtime-v2/index.ts 已用）|
| Deprecation warn 机制 | ❌ 待建 |
| Public API 稳定性标记 | ❌ 待建 |
| CLI alias 机制 | ❌ 待建 |
| 数据迁移测试 fixtures | ❌ 待建 |
| 架构守护测试 | ❌ 待建 |

---

## 15. 关联文档

- [`PD_ARCHITECTURE_OVERVIEW.md`](./PD_ARCHITECTURE_OVERVIEW.md) §6.5
- [`DATA_ARCHITECTURE.md`](./DATA_ARCHITECTURE.md) — 数据结构
- [`CONFIGURATION_ARCHITECTURE.md`](./CONFIGURATION_ARCHITECTURE.md) — 配置 schema 演化
- [`SECURITY_ARCHITECTURE.md`](./SECURITY_ARCHITECTURE.md) — 配置防篡改
- [`OBSERVABILITY_ARCHITECTURE.md`](./OBSERVABILITY_ARCHITECTURE.md) §5（migration 审计）
- ADR 是 schema 变更决策的载体
