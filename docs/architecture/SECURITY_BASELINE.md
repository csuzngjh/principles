# PD 安全基线（Security Baseline）

> **状态**: Active
> **最后更新**: 2026-07-03
> **关联**: [`SECURITY_ARCHITECTURE.md`](./SECURITY_ARCHITECTURE.md)（威胁模型）、[`.github/SECURITY.md`](../../.github/SECURITY.md)（漏洞披露）、[ADR-0014](../adr/0014-mvp-first-strategy-and-product-pivot.md)（MVP-First）

本文档声明 PD（Principles Disciple）产品的**安全基线**——一组可验证的、由 CI 守护的最低安全要求。安装 PD 的用户可以据此评估 PD 的安全态势，并确认哪些保护已就位、哪些是已知的残余风险。

与 [`SECURITY_ARCHITECTURE.md`](./SECURITY_ARCHITECTURE.md) 的关系：后者定义**威胁模型与安全边界**，本文档定义**可验证的基线清单与守护机制**。

---

## 1. 基线范围（四层纵深防御）

PD 安全基线按四层纵深防御组织，每层均有 CI 守护测试与/或预推送钩子：

| 层 | ID | 覆盖 | 守护机制 |
|---|-----|------|---------|
| 供应链 | SEC-BASE-1 | npm 包来源、构建溯源、依赖审计、密钥扫描 | `scripts/check-security-baseline.js` + CodeQL + gitleaks pre-push |
| 沙箱 | SEC-BASE-2 | RuleCode 执行边界（vm + 子进程 + 静态 forbidden patterns） | `rule-code-validator.ts` + `sandbox-escape-regression.test.ts` + 架构回归 |
| 数据 | SEC-BASE-3/4 | PII 脱敏、日志密钥遮蔽、SQLite 参数化查询 | 架构回归 SEC-BASE-3/4 |
| 网络/配置 | SEC-BASE-5 | core 无网络导入、pd-console 不默认监听 0.0.0.0、code_tool_hook 默认 require_approval | 架构回归 SEC-BASE-5 |

---

## 2. SEC-BASE-1：供应链层

### 2.1 守护项

| 检查项 | 要求 | 守护位置 |
|-------|------|---------|
| SECURITY.md | 仓库根存在漏洞披露政策 | `check-security-baseline.js` |
| CodeQL | 启用 `javascript-typescript` + `security-extended` 周扫描 | `.github/workflows/codeql.yml` |
| npm provenance | `.github/workflows/publish-npm.yml` 含 `npm publish --provenance` | `check-security-baseline.js` |
| ignore-scripts | `.github/workflows/publish-npm.yml` 含 `npm ci --ignore-scripts` | `check-security-baseline.js` |
| lockfile | 仓库存在 `package-lock.json` | `check-security-baseline.js` |
| Dependabot | `.github/dependabot.yml` 配置 npm 周更新 | `check-security-baseline.js` |
| lefthook gitleaks | pre-push 钩子扫描 git 历史密钥 | `lefthook.yml` + `.gitleaks.toml` |
| npm audit | PR 检查运行 `npm audit --audit-level=high`（非阻塞） | `.github/workflows/pr-checks.yml` |

### 2.2 用户操作指引

- **安装前**：用户可运行 `npm audit --audit-level=high` 自行验证依赖安全
- **安装时**：CI 的 `npm ci --ignore-scripts` 确保依赖包不会在安装时执行脚本；用户本地安装也可加 `--ignore-scripts` 标志
- **发布溯源**：PD 发布到 npm 时使用 `npm publish --provenance`（Sigstore + SLSA Build L3），用户可用 `npm audit signatures` 验证

### 2.3 残余风险

- `npm audit` 在 PR 中是**非阻塞**的（`|| true`），避免依赖库的传递性漏洞阻塞 PD 开发；用户应定期自行运行审计
- Dependabot 仅配置了 npm 生态系统；GitHub Actions 依赖更新需手动维护

---

## 3. SEC-BASE-2：沙箱层

### 3.1 三层纵深防御

PD 执行 RuleCode（owner 批准的行为规则代码）时采用三层防御：

1. **静态层**（`rule-code-validator.ts`）：编译前静态扫描 forbidden patterns
2. **vm 层**（`rule-implementation-runtime.ts`）：`vm.createContext(Object.create(null))` + `runInContext({ timeout })`
3. **子进程层**（`rule-implementation-runtime.ts`）：`spawnSync` 子进程执行 evaluate，`--max-old-space-size=32` + `timeout: 3000ms` + `maxBuffer` + `windowsHide`

### 3.2 Forbidden Patterns 清单

以下模式在静态层被拒绝（完整清单见 `rule-code-validator.ts` `FORBIDDEN_PATTERNS`）：

| 类别 | 模式 | 原因 |
|------|------|------|
| 导出/导入 | `export`, `import`, `require` | 沙箱内不应加载外部模块 |
| 异步 | `async`, `await` | evaluate 必须同步，避免逃逸 |
| 求值 | `eval`, `Function` | 动态代码执行 |
| 元编程 | `Reflect`, `Proxy`, `import.meta` | 可操纵原型链/拦截器 |
| 共享内存 | `SharedArrayBuffer`, `Atomics` | 跨 realm 逃逸面 |
| 弱引用 | `WeakRef`, `FinalizationRegistry` | 绕过 GC 边界 |
| 全局 | `globalThis`, `global`, `process`, `Buffer` | 访问宿主运行时 |
| 网络 | `fetch`, `XMLHttpRequest` | 不允许网络 I/O |
| 加密 | `crypto` | 非确定性/侧信道 |
| 定时器 | `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask` | 异步逃逸 |
| 随机 | `Math.random` | 非确定性 |
| 括号访问 | `globalThis['require']` 等 | 绕过字面量检测 |

### 3.3 守护测试

- `packages/principles-core/src/runtime-v2/internalization/__tests__/rule-code-dialect.test.ts`：6 个 SEC-BASE-2 测试（5 forbidden + 1 bracket access）
- `packages/openclaw-plugin/tests/core/sandbox-escape-regression.test.ts`：23 个测试（15 静态层 + 7 子进程边界 + 1 残余风险声明）
- `packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts` SEC-BASE-2：4 个测试（validator 模块加载 + forbidden patterns 注册）

### 3.4 残余风险

- **`node:vm` 不是安全沙箱**（Node.js 官方声明）。PD 的 vm 层仅用于**编译期隔离**，evaluate 的实际执行在子进程层完成
- 静态 forbidden patterns 是**正则匹配**，可能对字符串字面量产生误报（保守策略：宁可误报不漏报）。未来可迁移到 AST 检查
- 子进程层依赖 `spawnSync` 超时（3 秒）和内存限制（32MB），无法防御 CPU 友好的资源耗尽攻击（如密集数学运算）

---

## 4. SEC-BASE-3：PII 脱敏

### 4.1 已实现（MVP）

| 模式 | 替换为 | 实现位置 |
|------|-------|---------|
| Windows 路径 `C:\...` | `<WINDOWS_PATH>` | `openclaw-plugin/src/core/trajectory.ts` `redactText()` |
| Unix 路径 `/a/b/c` | `<PATH>` | 同上 |
| 邮箱 `user@domain.com` | `<EMAIL>` | 同上 |
| API Token `(sk\|rk\|pk)_xxxx` | `<TOKEN>` | 同上 |

`message-sanitize` hook 将脱敏函数应用于消息内容。

### 4.2 守护测试

- `architecture-regression.test.ts` SEC-BASE-3：3 个测试
  - `<EMAIL>` + 邮箱正则存在性
  - `<TOKEN>` + `(sk|rk|pk)` 正则存在性
  - `message-sanitize` hook 委托 core 脱敏

### 4.3 残余风险（Post-MVP）

以下 PII 类别**未实现**自动脱敏，将在 post-MVP 阶段评估（见 [`docs/plans/post-mvp-conditional-roadmap.md`](../plans/post-mvp-conditional-roadmap.md)）：

- **电话号码** `<PHONE>`：未实现
- **信用卡号** `<CARD>`：未实现
- **IP 地址** `<IP>`：未实现

**用户缓解**：如果 trajectory 日志中包含上述 PII，用户应：
1. 在 `~/.openclaw/config.yaml` 中关闭 trajectory 记录（`trajectory.enabled: false`）
2. 或在分享 trajectory 导出前手动审查

---

## 5. SEC-BASE-4：日志与 SQL

### 5.1 日志密钥遮蔽

**守护**：core 源码中不应出现 `logger.api_key` / `logger.token` / `logger.secret` / `logger.password` 等原始密钥字段输出（除非伴随 `<REDACTED>` 或 `sanitiz` 调用）。

**守护测试**：`architecture-regression.test.ts` SEC-BASE-4 日志测试（扫描 core/src 所有非测试 `.ts` 文件的 logger/console 行）

### 5.2 SQL 注入防护

**守护**：core 源码中所有 `.prepare()` / `.exec()` 的 DML 模板字符串（SELECT/INSERT/UPDATE/DELETE）不得包含 `${X}` 值插值（除非 `X` 是安全的列名列表 `.join()` 或预构建子句变量）。

**允许的安全模式**：
- `${columns.join(', ')}` — 列名列表
- `${sets.join(', ')}` — `column = ?` 对列表
- `${placeholders.join(', ')}` 或 `${placeholders}` — `?` 占位符列表
- `${whereClause}` / `${orderByClause}` 等预构建子句变量

**禁止的模式**：
- `db.prepare(\`SELECT * FROM x WHERE y = ${userInput}\`)` — 值插值
- `db.prepare('SELECT * FROM x WHERE y = ' + userInput)` — 字符串拼接

**DDL 例外**：`ALTER TABLE ... ADD COLUMN ' + col` 允许，因为 SQLite DDL 不支持 `?` 占位符标识符；`col` 必须来自受控白名单（`check-security-baseline.js` 不检查此项，由 code review 把关）。

### 5.3 守护测试

- `architecture-regression.test.ts` SEC-BASE-4 SQL 测试：扫描 `.prepare()` / `.exec()` 模板参数，检测非安全插值

### 5.4 残余风险

- 正则匹配无法覆盖动态构造的 SQL 字符串（如先赋值给变量再传给 `.prepare()`）；code review 是最后防线
- DDL 字符串拼接（`ALTER TABLE ... ADD COLUMN`）依赖白名单约束，未被自动测试覆盖

---

## 6. SEC-BASE-5：网络与配置隔离

### 6.1 core 无网络导入

**守护**：`packages/principles-core/src/` 不得导入 `node:http` / `node:https` / `undici` / `node-fetch`，不得调用 `fetch()`（业务用途）。core 是纯逻辑层，所有 I/O 必须在 `openclaw-plugin`。

**例外**：`import type` 导入（仅类型，无运行时）允许。

**登记例外（PRI-683）**：`runtime-v2/adapter/pi-ai-http-transport.ts` 允许导入 `undici`（已登记 `io-seam-registry.json` 的 `pi-ai-http-transport` seam）。它是 PD LLM 传输层唯一所有者：为绕过 Node 全局 fetch 内置 undici dispatcher 的隐式 300s `headersTimeout`/`bodyTimeout` 帽（PRI-683 根因），经 pi-ai 官方 `options.fetch` 注入点提供专用 Agent 绑定的 fetch。该文件不发起新业务请求、不监听端口——所有请求仍由 pi-ai SDK 发出，本模块只配置传输超时语义。

### 6.2 pd-console 不默认监听 0.0.0.0

**守护**：`packages/pd-console/src/` 不得出现 `host: '0.0.0.0'` 默认配置。本地 Web UI 应默认绑定 `127.0.0.1` 或 `localhost`。

### 6.3 code_tool_hook 默认 require_approval

**守护**：`packages/openclaw-plugin/src/` 中 code_tool_hook 相关配置应包含 `require_approval` 默认值（非阻塞检查，配置可能在 yaml 模板中）。

### 6.4 守护测试

- `architecture-regression.test.ts` SEC-BASE-5：3 个测试

### 6.5 残余风险

- pd-console 的 bind host 检查仅在源码层；如果用户通过环境变量覆盖 `HOST=0.0.0.0`，PD 无法阻止
- code_tool_hook 的 require_approval 检查是**非阻塞**的（配置可能在 yaml 模板而非 src）

---

## 7. CI 守护总览

| 守护机制 | 触发时机 | 阻塞性 | 位置 |
|---------|---------|--------|------|
| `check-security-baseline.js` | `verify:merge` / PR | ✅ 阻塞 | `scripts/` |
| CodeQL 周扫描 | 每周一 + push/PR | ✅ 阻塞（PR） | `.github/workflows/codeql.yml` |
| npm audit | PR | ❌ 非阻塞 | `.github/workflows/pr-checks.yml` |
| gitleaks pre-push | `git push` | ✅ 阻塞 | `lefthook.yml` |
| SEC-BASE-1~5 架构回归 | `npm run test`（principles-core） | ✅ 阻塞 | `architecture-regression.test.ts` |
| sandbox-escape 回归 | `npm run test`（openclaw-plugin） | ✅ 阻塞 | `sandbox-escape-regression.test.ts` |
| rule-code-dialect | `npm run test`（principles-core） | ✅ 阻塞 | `rule-code-dialect.test.ts` |

---

## 8. 用户安全自查清单

安装 PD 后，用户可执行以下自查：

```bash
# 1. 验证供应链基线（15 项检查）
node scripts/check-security-baseline.js
# 期望输出: {"ok":true,"checked":15}

# 2. 运行安全守护测试
cd packages/principles-core && npx vitest run src/runtime-v2/__tests__/architecture-regression.test.ts -t "SEC-BASE"
# 期望: 17 passed

cd packages/openclaw-plugin && npx vitest run tests/core/sandbox-escape-regression.test.ts
# 期望: 23 passed

# 3. 自行审计依赖
npm audit --audit-level=high

# 4. 验证 pd-console 绑定地址（如果使用 Web UI）
# 检查 pd-console 配置中的 host 不应是 0.0.0.0
```

---

## 9. Post-MVP 安全路线图

以下项目**超出 MVP-First 范围**（ADR-0014），在 restart 条件满足后评估：

| 项目 | 当前状态 | 触发条件 |
|------|---------|---------|
| `<PHONE>` / `<CARD>` / `<IP>` 脱敏 | 未实现 | 首个客户提出 PII 合规需求 |
| AST 级 forbidden pattern 检查 | 正则匹配（保守） | 误报率影响开发效率 |
| npm publish --provenance | 待发布 | 首次发布到 npm |
| GitHub Actions 依赖更新 Dependabot | 手动维护 | Actions 依赖数量增长 |
| DDL 白名单自动化测试 | code review 把关 | DDL 迁移频率增加 |
| 沙箱资源限制强化（CPU 友好攻击） | 32MB + 3s 超时 | 出现实际滥用案例 |

---

## 10. 变更记录

| 日期 | 变更 | 关联 |
|------|------|------|
| 2026-07-03 | 初始基线建立（SEC-BASE-1~5） | spec `2026-07-03-security-baseline-design.md` |
