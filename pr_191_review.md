我已针对这个 PR (Pull Request #191) 进行了全面且深入的源码审查，并实际跑了测试用例。从整体架构来看，引入 Principle Tree Ledger、代码存储分离 (Storage)、沙箱执行 (RuleHost) 和回放评估 (Replay Engine) 构成了非常完整的“闭环演化”设计。

然而，如果以“**真的可用、可维护、而不是一个满是 Bug 的半成品**”为标准，这个 PR 目前存在**非常致命的安全漏洞、严重的性能缺陷以及多处脆弱的代码实现**。以下是深度评审报告和合并前必须修复的问题：

### 🚨 一、 致命的系统脆弱性 (System Fragilities & Security)

#### 1. 虚假的沙箱机制导致 RCE 逃逸 (Critical Sandbox Escape)
在 `src/core/rule-host.ts` 的 `_loadSingleImplementation` 方法中，代码注释明确承诺了沙箱机制：*“vm context receives only { helpers: frozenHelpers } — no fs, process, require, global”*。
**但代码实现却完全没有做到这一点：**
```typescript
const compiled = nodeVm.compileFunction(
  normalizeImplementationSource(sourceCode),
  [],
  { filename: impl.id } // 致命错误：缺少 parsingContext！
);
```
根据 Node.js `vm` 模块官方文档，如果不显式传入 `parsingContext`，代码将在**当前 Node.js 进程的主全局上下文中编译并执行**。这意味着所谓被沙箱隔离的候选代码实现，完全可以随意访问 `globalThis.process` 等全局变量，不仅可以调用 `process.exit()` 终止整个服务，甚至可以通过拿到其他挂载在 global 上的模块绕过限制进行破坏。
* **修复方案**: 必须显式创建干净的沙箱上下文，改为 `parsingContext: nodeVm.createContext(Object.create(null))`。

#### 2. Replay Engine 的链式崩溃 (Deserialization Fragility)
在 `src/core/replay-engine.ts` 的 `listReports` 中处理回放报告读取时：
```typescript
return files.sort().reverse().map((f) => {
  const content = fs.readFileSync(path.join(reportDir, f), 'utf-8');
  return JSON.parse(content) as ReplayReport;
});
```
如果在回放报告目录下（`replays/`）有**任何一个**历史 JSON 文件损坏或格式错误，`JSON.parse` 就会抛出异常。由于异常没有在 `map` 内部被捕获，会导致整个 `map` 抛错并进入外层的 `catch` 块，从而返回空数组 `[]`。
**结果**: 只要存在一个坏文件，该实现的所有历史回放报告会全部瞬间“消失”。
* **修复方案**: 把 `try-catch` 移到 `map` 回调的内部，对损坏的文件进行 `logger.warn` 记录并过滤，而非吞掉整个列表。

### 🐌 二、 数据流与性能灾难 (Data Flow & Performance)

#### 3. O(N) 级别的高频磁盘 I/O 和热编译损耗
您的架构是在 `src/hooks/gate.ts` 的 `handleBeforeToolCall` 中，每次拦截工具调用时即时实例化 `RuleHost` 并进行执行。
问题在于，`ruleHost.evaluate()` 内部的执行流是：
1. `listImplementationsByLifecycleState` (同步读取 `principle_training_state.json`)
2. 对每个 Active 状态的实现调用 `_loadSingleImplementation`
3. 各自同步读取 `manifest.json` 和 `entry.js` 
4. 运行 `vm.compileFunction`（V8 JS 引擎编译损耗）

**这意味着，Agent 发出的每一个工具调用（甚至是只读工具），都会触发至少 N+1 次同步读盘和 N 次 JS 运行时编译！** 随着系统中 Active Implementation 数量的增加，这会严重拖慢 Agent 任务循环 (Event Loop) 的响应速度，甚至造成 I/O 阻塞。
* **修复方案**: 必须在 `RuleHost` 或者整个上下文层面引入内存级别的**缓存层 (In-memory Cache)**。可以监听 Ledger 和 Manifest 的 `lastUpdated` 时间戳，只有在代码实现或状态发生变更时才重新读盘和进行 `vm.compileFunction` 编译。

### 🧩 三、 接口一致性与可维护性 (Interface Consistency)

#### 4. Ledger 强转滥用与解析不完整 (Type Safety Hacks)
在 `src/core/principle-tree-ledger.ts` 的核心实现中，大量出现了 `(impl as any).lifecycleState` 这样的 TypeScript "Hack" 强转。
追查发现这是因为在 `parseImplementations` 中，从 JSON 读取对象时并未设置默认的 schema 值（例如如果旧的 JSON 里面没有 `lifecycleState`，它依然是 `undefined`）。这破坏了 `Implementation` 的类型一致性。
* **修复方案**: 在 `parseImplementations` 时进行完整的字段解构和向前兼容填充（如 `lifecycleState: value.lifecycleState ?? 'candidate'`），彻底消灭掉核心状态机里的 `as any`。

#### 5. 测试套件大面积崩溃 (Widespread Test Failures)
在检出 `pr191` 分支并执行了 `npm run test`，发现有**数十个老测试用例处于失败状态**。
例如：
* `tests/core/local-worker-routing.test.ts` (8 个 Failed)
* `tests/hooks/prompt.test.ts` (13 个 Failed)
* `tests/core/evolution-engine-gate-integration.test.ts` (5 个 Failed)
如果这代表着旧有接口行为被无意破坏，或者旧的契约已经被新系统取代而测试没跟上，它都是**不可合并**的。作为一个核心演化机制更新，不能为了新功能把现存的网关 (Gate) 和路由逻辑测试跑挂。
* **修复方案**: 更新所有相关的测试用例，确保重构后的数据流能在所有的用例中通过，并为 `rule-host.ts` 添加包含沙箱恶意调用拦截的专属测试。

### 📋 总结与评审结论

这个 PR 的架构思路是极其优秀的，特别是 `Artificer` 选取目标 Rule 以及回放打分的逻辑非常严密，处理了平局判定 (`ambiguous-target-rule`) 并分离了存储与状态流。

但是目前的落地代码绝对是一个**半成品**。强烈要求按照上述 5 个点进行修改（尤其是**消除高频读盘与沙箱逃逸漏洞**），修复相关单元测试，待 CI 完全通过后再行 Merge。