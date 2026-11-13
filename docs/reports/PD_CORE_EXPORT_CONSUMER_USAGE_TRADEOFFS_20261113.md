# 导出面 consumers 使用点判定 · 误报 / 漏报取舍（PRI-1197）

> 基线：`origin/main` @ `bec5d4ee`
> 实现：`scripts/check-core-export-surface.mjs` 的 `moduleImports` / `hasUsagePoint` / `consumerProof`
> 保护用例：`packages/principles-core/src/runtime/__tests__/export-surface-admission.test.ts`
> 关联：PRI-416（桶文件行数上限）、PRI-775（导出名快照）

## 修复的是什么

原 `consumerProof()` 对 named import 只做 `imported.has(symbol)` 判断：文件里写了
`import { X } from '@principles/core/host'` 但从未读 `X`，也算「有消费者」。
现在该分支要求同文件存在**使用点**。namespace import 分支原本就有 `ns.X` 的 AST
使用点判定，re-export 分支保持既有证据语义，两者均未改动。

落地时 `export-admissions.json` 为 `admissions: [] / removals: []`，即线上没有任何
准入记录经由这个洞被放行 —— 本单是**门禁硬化**，不是事故修复；没有存量记录需要迁移。

## 逐类判定与理由

| 类别 | 判定 | 理由 |
|---|---|---|
| (a) 仅类型引用（`import type` / 类型位置） | **算使用** | `kind: 'type'` 的准入本来就只在类型位置被消费；把类型位置判成未使用会让所有类型准入无法通过，是纯误报。实现只排除绑定名与键名，TypeReference、`typeof`、泛型实参、元组元素都算读。 |
| (b) re-export（`export { X } from '@principles/core/host'`） | **算证据，不查使用点** | 既有契约：转发把符号带到下游，文件内没有「读」是结构性的，不是漏洞。改判会破坏既有语义且无收益。由独立的 `reExported` 集合承载，与新增加的使用点检查解耦。 |
| (c) 动态 `import()` / `require()` | **不算证据，判红，无豁免** | `moduleImports` 只解析静态 Import/ExportDeclaration；动态形式无法静态证明用到具体命名符号，纳入等于重新开洞。确需时应改成静态 import 后走同一判定。 |
| (d) 测试文件内引用 | **不作为 consumer，直接拒绝** | 测试专用使用不构成扩大公共 API 的理由。这是门禁原有规则（`TEST_PATH_RE`），本单未改。 |
| 别名导入 `import { X as Y }` | **按本地名 `Y` 查使用点** | 原实现把导出名 `X` 记进集合，直接用它查引用会把别名用法误判为未使用。`imported` 改为 `Map<导出名, 本地名>`。 |
| 只作为对象键 / 属性访问名 / 局部声明名 | **不算使用** | 这些位置是引入名字或标签，不是读取导入的符号；计入会产生假绿。 |
| 默认导入 | **不算证据（既有行为）** | 入口文件禁止 default export（门禁对 `export *` / default 直接 fail loud），不存在合法的默认导入 consumer。 |

误报方向：一个真实使用点被判成「未使用」，会让合法准入被挡。已通过「类型位置算使用」
「别名解析」「re-export 直放」三处收敛；代价是接受 re-export 这种传递证据。
漏报方向：一个假使用点被判成「已使用」。只保留静态 AST 可证的位置，动态形式与键名
一律不计入；代价是少量写法需要改成静态 import。

## 失败样例（应判红）

```ts
// packages/consumer/src/unused.ts
import type { HostEventResult } from '@principles/core/host';
export type Nothing = string;              // import 后从未读 HostEventResult
```

```ts
// packages/consumer/src/property-key.ts
import type { HostEventResult } from '@principles/core/host';
export const bag = { HostEventResult: 1 };  // 同名只是对象键，不是引用
```

```ts
// packages/consumer/src/dynamic.ts
const host = await import('@principles/core/host'); // 动态 import 无法证明具名使用
```

门禁错误文案：`consumers entry ... imports "HostEventResult" from "@principles/core/host"
but never uses it`。

## 豁免样例（应判绿）

```ts
// 仅类型位置使用（现有 fixture consumer.ts）
import type { HostEvent, HostEventResult } from '@principles/core/host';
export type Both = [HostEvent, HostEventResult];
```

```ts
// 别名解析到局部名
import type { HostEventResult as Result } from '@principles/core/host';
export type Aliased = Result;
```

```ts
// re-export 保持既有证据语义
export { HostEventResult } from '@principles/core/host';
```

```ts
// namespace import 的既有分支
import * as host from '@principles/core/host';
export type Ns = host.HostEventResult;
```

## 与 PRI-775 快照的关系

两面正交，**本单不改快照、不做数据迁移**：

- PRI-775 是**名字集冻结**（哪些名字可以被公开），name-set 快照；
- consumers 使用点是**证据强度**（某条准入记录是否真有需求方），admission 记录校验。

新增准入时两者都要过；本单只加严后者。PRI-416 的桶文件行数 / 导出行上限是第三个面，
同样不受影响。

## 验收

| 项 | 结果 |
|---|---|
| `vitest run export-surface-admission.test.ts` | 27 passed（原 22 + 新增 5） |
| `node scripts/check-core-export-surface.mjs` | exit 0，`28 entry points / 2352 unique symbols / 0 added, 0 removed` |
| 改动测试文件 `eslint` | exit 0 |
