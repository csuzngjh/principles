# ADR-0018: BDD 规约层

> **Status**: Proposed
> **Date**: 2026-06-30
> **Decider**: Owner
> **Context**: MVP-First (ADR-0014), seed-customer readiness

## 1. Context

PD 项目当前测试体系存在三类痛点(详见 [BDD spec §1](../superpowers/specs/2026-06-30-bdd-specification-layer-design.md#1-问题定义)):

1. **Owner 看不懂验收标准**——测试代码只有开发者读得懂,Owner(中文非技术用户)无法独立审阅"系统应该怎样行为"。
2. **AI 助手跨 session 反复犯同类错误**——没有行为契约护栏,每个 session 都从零理解 PD 的用户旅程约束。
3. **发版时"实现绿但旅程断"**——单元测试全绿,但用户旅程(如 owner 审批 → 激活 → rollback)已经断了。这是 EP-09 (Test Reality Gap) 的典型表现:测试证明了字符串/helper 行为,而非用户真实依赖的行为(ERR-025/ERR-088)。

## 2. Decision

引入 BDD 规约层,用 `.feature` 文件描述 Owner 可读的用户旅程契约。规约用 Gherkin 语法,执行仍由现有 Vitest/Playwright runner 负责,0 运行时改造。

### 2.1 关键决策

1. **`.feature` 文件集中在 `docs/specs/features/`**,不分散在 `packages/*/tests/`。这是规约(specification),不是测试代码;Owner 审阅的对象是规约,不是 step definitions。

2. **BDD runner 放 `tests/bdd/support/`,不进 `src/`**。理由:`@principles/core` 是公开发布的 SDK,放 `src/testing/` 会进 dist,把 BDD 工具带进 SDK。runner 与 step definitions 都属于测试侧代码,不进发布包。

3. **`@cucumber/gherkin-utils` 作为 root devDependency**,不进任何子包的 dependencies。实际解析器从其传递依赖 `@cucumber/gherkin` 导入 `Parser`/`AstBuilder`/`GherkinClassicTokenMatcher`;但注册的 devDependency 是 `@cucumber/gherkin-utils`(版本 `^9.2.0`),避免污染 `@principles/core` 的发布依赖。

4. **BDD 不进 `verify:merge` 合并门禁**。`verify:merge` 只跑 9 个静态门(check:generated-artifacts / check:error-handbook / check:repo-hygiene / check:runtime-contract / check:docs-structure / lint / build / build pd-cli / typecheck:openclaw-plugin / typecheck:pd-console)。BDD 场景随 CI per-package test job 跑;要让 BDD 成为合并门禁,需显式修改 CI required checks(Phase 2 评估)。

5. **禁用必须显式**:`@disabled(reason,owner,date)` 标签 + skip 报告(runner 输出 `SKIP: 场景名 [SKIP: reason; owner=...; date=...]`)。**禁止**通过删除 `.feature` 文件让测试绿——删除文件会让 `readFileSync` fail loud(ENOENT),不允许静默通过。

6. **Phase 1 范围克制**:3 个示范场景(后端 prompt channel、前端 FocusPage、CLI strict JSON),不追求全覆盖。先验证规约/解析/执行三层架构可跑通,再决定是否扩展。

7. **`.feature` 全中文**(Owner 是中文非技术用户),术语首次出现中英对照,如 `原则 (principle)`。解析器支持 `# language: zh-CN` 指令和无指令的混合写法(英文 Feature/Scenario + 中文步骤关键词)。

## 3. Alternatives Considered

### A. 完整 Cucumber 栈

**否决**:引入 cucumber 运行时,增加依赖和复杂度。PD 只需 Gherkin 解析,执行仍由 Vitest/Playwright 负责。引入完整栈会让测试执行分裂成两套(Vitest + Cucumber),维护成本上升。

### B. BDD runner 进 `src/testing/` 并作为 SDK API 导出

**否决**:污染发布包,把测试工具带进 SDK。`@principles/core` 的 dist 必须只含生产逻辑。除非外部用户需要 BDD API(目前无此需求),否则不进 src。

### C. BDD 进 verify:merge

**否决(Phase 1)**:Phase 1 是试点,不应立即成为合并门禁。在三层架构未经实战验证前就加入门禁,会让"删 .feature 让测试绿"成为合并压力的诱因。Phase 2 评估稳定后再决定是否加入 CI required checks。

## 4. Consequences

### 4.1 正面

- **Owner 可独立审阅验收标准**——`.feature` 文件是中文、非技术语言,Owner 不需要读 TypeScript 就能确认行为契约。
- **AI 助手有行为契约护栏**——改代码前先读 `.feature`,降低跨 session 反复犯同类错误的风险。
- **发版时用户旅程有规约级保护**——直接缓解 EP-09 (Test Reality Gap):"实现绿但旅程断"会被 BDD scenario 抓住(ERR-025/ERR-088)。

### 4.2 负面

- **新增依赖**:`@cucumber/gherkin-utils` 进 root devDependencies(传递带入 `@cucumber/gherkin`、`@cucumber/messages`)。
- **维护成本**:需要维护 `.feature` 文件和 step definitions 两套;重构真实接口时 step definitions 必须同步更新。
- **BDD 不在 verify:merge 内**:需 Owner 知晓——合并门禁不包含 BDD,BDD 失败不会阻断 `npm run verify:merge`。Phase 2 评估是否加入 CI required checks。

## 5. References

- [BDD spec](../superpowers/specs/2026-06-30-bdd-specification-layer-design.md)
- [ERROR_PATTERN_INDEX EP-09 (Test Reality Gap)](../process/error-management/ERROR_PATTERN_INDEX.md) — ERR-025 / ERR-088
- [ADR-0014 MVP-First](0014-mvp-first-strategy-and-product-pivot.md)
