# 安全基线设计(PD Security Baseline)

> **状态**: Draft — 待用户审阅
> **创建**: 2026-07-03
> **关联**: [SECURITY_ARCHITECTURE.md](../../architecture/SECURITY_ARCHITECTURE.md)、[ADR-0014](../../adr/0014-mvp-first-strategy-and-product-pivot.md)、[post-mvp-conditional-roadmap.md](../../plans/post-mvp-conditional-roadmap.md)
> **范围**: MVP-Core 安全加固,不突破 ADR-0014 边界

---

## 0. 目的与定位

PD 已有完整的 [SECURITY_ARCHITECTURE.md](../../architecture/SECURITY_ARCHITECTURE.md)(17 节,威胁模型 T-1~T-10,约束 ID WS/SBX/APR/PII/SEC/CFG/INJ/NET/ART/IMPL),但实施进度表中多项 `❌ 待建`,且这些未实施项多数属 post-MVP 基础设施(dual approval / rate limit / hash chain / PII scanner),在 ADR-0014 MVP-First 阶段不能启动。

本基线是 SECURITY_ARCHITECTURE.md 的**子集 + 截止日期 + CI 守护**:

- **子集**:只声明"已实施 + 本轮加固 + CI 守护"的控制项
- **截止日期**:post-MVP 项明确标注触发条件,不在本轮实施
- **CI 守护**:每条基线控制项有对应的 `scripts/check-security-baseline.js` 或 `architecture-regression.test.ts` 守护,漂移被 CI 拦截

**目标**:确保 `npm install principles-disciple` 的用户不会因供应链投毒、沙箱逃逸、PII 泄漏、本地 WebUI 暴露、配置篡改而出现安全风险。

---

## 1. 产出物(双轨)

| 轨 | 文件 | 角色 |
|----|------|------|
| 文档轨 | `docs/architecture/SECURITY_BASELINE.md`(新建) | 人读:基线是什么、为什么、覆盖哪些威胁、残余风险声明 |
| CI 守护轨 | `scripts/check-security-baseline.js`(新建)+ `architecture-regression.test.ts` 新增 describe 块 | 机器读:必须是什么、漂移被 CI 拦 |

**与 SECURITY_ARCHITECTURE.md 的关系**:ARCHITECTURE 是完整设计愿景,BASELINE 是"已守护子集"。两者共存,BASELINE 顶部交叉引用 ARCHITECTURE。

---

## 2. In-scope(本轮基线覆盖,四层)

1. **供应链层** — npm 发布与 CI 侧(§4)
2. **沙箱层** — vm 纵深防御,不替换 vm(§5)
3. **数据层** — PII / log / SQLite(§6)
4. **本地面与网络层** — pd-console 绑定、配置防篡改、core 网络 import(§7)

四层均属 MVP-Core 守卫,不引入新 functional subsystem / hook / writer / reader,不触发 ADR-0014 feature flag 注册要求。

---

## 3. Out-of-scope(写进基线但不实施)

| 项 | 原因 | 触发条件 |
|----|------|---------|
| T-2 model_training 训练数据污染防护 | model_training 通道 post-MVP | 见 post-mvp-conditional-roadmap.md |
| T-8 双人审批 + 24h 冷却(APR-1~APR-6)| post-MVP 基础设施 | 同上 |
| T-9 速率限制 / 队列 DoS 防护 | post-MVP 基础设施 | 同上 |
| audit log hash chain tamper-evidence | post-MVP 基础设施 | 同上 |
| PII 扫描器(SECURITY_ARCHITECTURE §5.3)| 仅 model_training 导出场景需要,该通道 post-MVP | 同上 |
| isolated-vm / quickjs-wasm 迁移 | 突破 MVP 边界,需 maintainer 批准 | post-MVP,残余风险可接受时 |

每项在 BASELINE.md 中标注:`状态: post-MVP | 触发条件: 见 post-mvp-conditional-roadmap.md`。

---

## 4. 供应链层(SEC-BASE-1)

**目标**:让 `npm install principles-disciple` 的用户能验证包来源完整、无已知漏洞、无密钥泄漏。

| 控制项 | 现状 | 本轮动作 | CI 守护 |
|--------|------|----------|---------|
| `npm publish --provenance` | ✅ 已做 | 文档化声明 | `check-security-baseline.js` 校验 publish workflow 含 `--provenance` |
| `npm ci --ignore-scripts` | ✅ 已做 | 文档化声明 | 校验 publish workflow 含 `--ignore-scripts` |
| lockfile 入库 | ✅ 已做 | — | 校验 `package-lock.json` 存在且未被 .gitignore |
| Dependabot | ✅ 已做 | — | 校验 `.github/dependabot.yml` 存在且覆盖 npm + github-actions |
| **SECURITY.md** | ❌ 缺失 | **新建** `.github/SECURITY.md`(漏洞披露流程、SLA、不公开 issue) | 校验存在且含 "Vulnerability Disclosure" |
| **CodeQL** | ❌ 缺失 | **新建** `.github/workflows/codeql.yml`(javascript-typescript) | 校验 workflow 存在 |
| **gitleaks pre-push** | ❌ 缺失 | **新建** lefthook 配置(项目已有 lefthook dep) | 校验 lefthook 配置含 gitleaks |
| `npm audit` in CI | ❌ 缺失 | 在 `pr-checks.yml` 加 `npm audit --audit-level=high` | 校验 workflow 含 audit step |
| Secret scanning push protection | ❌ 未开 | GitHub repo settings 启用(非代码变更,BASELINE.md 文档化为一次性操作步骤) | CI 无法守护 GitHub repo settings;gitleaks pre-push 作为本地侧补充(两者互补:push protection 拦截 server 端,gitleaks 拦截本地推送前) |

**威胁覆盖**:T-4(API key 泄漏)、供应链投毒(OWASP A08:2021)。

**外部基准**:OWASP Top 10 for LLM Applications 2025、npm provenance/SLSA、GitHub Open Source Security 文档。

---

## 5. 沙箱层(SEC-BASE-2,vm 纵深防御)

**真实姿态**(代码确认,[rule-implementation-runtime.ts](../../../packages/openclaw-plugin/src/core/rule-implementation-runtime.ts)):

- `loadRuleImplementationModule` 编译阶段:`nodeVm.createContext(Object.create(null))` + `runInContext({timeout: 1000})`
- `callEvaluate` 执行阶段:`spawnSync` 起子进程(`--max-old-space-size=32`、`timeout: 3000`、`maxBuffer: 1MB`、`windowsHide: true`)
- 子进程内:`vm.createContext(Object.create(null))` + `runInContext({timeout: 1000})`
- helpers:`Object.freeze`,白名单 7 个 getter(isRiskPath / getToolName / getEstimatedLineChanges / getBashRisk / hasPlanFile / getPlanStatus / getEpTier)
- forbidden patterns 在 [rule-code-validator.ts](../../../packages/principles-core/src/runtime-v2/internalization/rule-code-validator.ts)(core 纯逻辑)

**基线动作**(不替换 vm,加固纵深):

| 控制项 | 动作 | CI 守护 |
|--------|------|---------|
| Forbidden patterns 审计与升级 | 审计现有 patterns,补充:`import.meta`、`Reflect`、`Proxy`、`WeakRef`、`FinalizationRegistry`、`SharedArrayBuffer`、`Atomics` | architecture-regression SEC-BASE-2 断言每个 pattern 被拒 |
| Escape regression test suite | 新增 `packages/openclaw-plugin/src/core/__tests__/sandbox-escape-regression.test.ts`,收录已知 vm 逃逸 payload(Node 官方文档示例 + 公开 PoC 摘要),断言被 forbidden pattern 或子进程边界拦截 | 作为独立 test 文件 |
| 子进程边界守护 | 文档化声明"子进程隔离 = 主进程不直接执行 LLM 代码";architecture-regression 断言 `callEvaluate` 使用 `spawnSync` 且 `windowsHide: true`、`maxBuffer` 有界 | SEC-BASE-2 |
| Shadow mode 强制 | 校验 `code_tool_hook` 默认走 shadow mode(SBX-8,已有 PRI-146 守护) | 已有,基线文档引用 |
| 残余风险声明 | BASELINE.md §5.5 明确写:node:vm 非安全沙箱(Node 官方声明),PD 采用子进程+vm+forbidden patterns 三层纵深防御,残余风险 = 0day V8 逃逸。MVP 期间接受此残余风险 | — |

**威胁覆盖**:T-1(LLM 恶意代码)、T-10(prompt injection 触发代码生成)。

**外部基准**:Node.js 官方文档 vm 模块安全声明、OWASP LLM01 Prompt Injection。

---

## 6. 数据层(SEC-BASE-3 / SEC-BASE-4,PII / log / SQLite)

| 控制项 | 现状 | 本轮动作 | CI 守护 |
|--------|------|----------|---------|
| PII 脱敏(基础)| ✅ 已做([message-sanitize.ts](../../../packages/openclaw-plugin/src/hooks/message-sanitize.ts) 委托 core) | — | SEC-BASE-3 断言 email/phone/card/ip 正则存在并被 sanitizeValue 调用 |
| PII 扫描器 | ❌ 待建 | **本轮不实施**(post-MVP,model_training 通道未激活) | 基线文档标注 post-MVP |
| log sanitizer 核心 | ❌ 待建(SEC-5) | **本轮不实施**核心 sanitizer,加守护测试 | SEC-BASE-4 扫描现有 logger 调用,断言敏感字段(api_key/token/secret/password)不出现明文 |
| SQLite parameterized query | ✅ better-sqlite3 默认安全 | 文档化声明 + 守护测试 | SEC-BASE-4 断言 core 无字符串拼接 SQL(grep `SELECT.*\+`、`INSERT.*\+`) |
| SQLite 文件权限 | ⚠️ 未显式设置 | **本轮不实施**(依赖 OS 默认,文档化为用户指引) | 基线文档 §"用户操作指引" |
| Audit log hash chain | ❌ 待建 | **本轮不实施**(post-MVP) | 基线文档标注 post-MVP |

**威胁覆盖**:T-4(PII/secret 泄漏)。

**外部基准**:SQLite security 官方文档、better-sqlite3 API。

---

## 7. 本地面与网络层(SEC-BASE-5)

| 控制项 | 现状 | 本轮动作 | CI 守护 |
|--------|------|----------|---------|
| pd-console 127.0.0.1 绑定(NET-5) | ⚠️ 文档声明,未守护 | 守护测试 | SEC-BASE-5 grep pd-console server 配置断言 bind_host 默认非 `0.0.0.0` |
| core 网络隔离(NET-1) | ❌ 未守护 | 守护测试 | SEC-BASE-5 断言 core 不 import `node:http`/`node:https`/`undici`/`fetch` |
| 配置防篡改关键字段(CFG-4) | ❌ 未实施强制覆盖 | **本轮不实施**强制覆盖机制(post-MVP),加守护测试 | SEC-BASE-5 断言 `.pd/config.yaml` schema 中 `code_tool_hook.mode` 默认 `require_approval` |
| 远程导出默认关闭(NET-4) | ⚠️ 未守护 | 守护测试 | SEC-BASE-5 断言 export 相关配置默认 `enabled: false` |

**威胁覆盖**:T-3(跨工作区)、T-5(配置篡改)、T-6(audit 篡改,部分)。

---

## 8. CI 守护脚本设计

### 8.1 `scripts/check-security-baseline.js`(新建)

**职责**:静态扫描仓库,校验供应链层控制项存在。**不**做运行时检查(那是 vitest 的职责)。

**校验项**(每项失败 → exit 1,输出 JSON `{ ok: false, reason, fix }`):

1. `.github/SECURITY.md` 存在且含 "Vulnerability Disclosure"
2. `.github/workflows/codeql.yml` 存在
3. `.github/workflows/publish-npm.yml` 含 `--provenance` 且 `--ignore-scripts`
4. `package-lock.json` 存在(根 + 子包)
5. `.github/dependabot.yml` 存在且含 `npm` 和 `github-actions` ecosystem
6. lefthook 配置含 gitleaks(或等价 secret scan)
7. `.github/workflows/pr-checks.yml`(或 ci.yml)含 `npm audit`

**接入**:`package.json` 新增 `"check:security-baseline": "node scripts/check-security-baseline.js"`,`verify:merge` 链尾部追加 `&& npm run check:security-baseline`。

**输出规范**(对齐 cli-1/cli-6 风格,虽非 pd-cli operator command):
- 成功:stdout 输出 `{"ok":true,"checked":N}`,exit 0
- 失败:stdout 输出 `{"ok":false,"failures":[...],"nextAction":"..."}`,exit 1
- 不输出 banner / 解释文本,严格 JSON

### 8.2 `architecture-regression.test.ts` 新增 describe 块

在现有 [architecture-regression.test.ts](../../../packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts) 尾部追加 5 个 describe 块(遵循现有 `PRI-*` 命名风格,改用 `SEC-BASE-*` 前缀):

```text
describe('SEC-BASE-1: supply chain provenance guards', () => { ... })  // 校验 publish workflow 字段
describe('SEC-BASE-2: sandbox escape regression', () => { ... })        // forbidden patterns + 子进程边界
describe('SEC-BASE-3: PII redaction guards', () => { ... })             // email/phone/card/ip 正则
describe('SEC-BASE-4: log secret redaction guards', () => { ... })      // 敏感字段 + SQLite 拼接
describe('SEC-BASE-5: network & config isolation', () => { ... })       // bind_host + core 网络隔离 + 配置默认
```

每个 describe 内 2-5 个 test,使用现有 `readFile` + `grep` 模式(参考已有 PRI-* describe 的实现风格)。这些是**架构守护测试**,不是单元测试,放 architecture-regression 符合 AGENTS.md "never skip or delete"。

### 8.3 独立测试文件

- `packages/openclaw-plugin/src/core/__tests__/sandbox-escape-regression.test.ts` — vm 逃逸 payload 回归,属单元测试,独立于 architecture-regression

---

## 9. 实施顺序(给 writing-plans 的输入)

按风险降序、依赖升序:

1. **P0** — `.github/SECURITY.md` + lefthook gitleaks 配置(漏洞披露入口 + 防 token 推送,最快见效)
2. **P0** — `scripts/check-security-baseline.js` + `verify:merge` 接入(守护基础设施先立起来)
3. **P1** — `.github/workflows/codeql.yml`(自动化 SAST)
4. **P1** — `pr-checks.yml` 加 `npm audit --audit-level=high`
5. **P1** — `architecture-regression.test.ts` 新增 SEC-BASE-2 sandbox escape regression(最高运行时风险点)
6. **P2** — `architecture-regression.test.ts` 新增 SEC-BASE-3/4/5(PII/log/network 守护)
7. **P2** — forbidden patterns 升级([rule-code-validator.ts](../../../packages/principles-core/src/runtime-v2/internalization/rule-code-validator.ts))
8. **P3** — `docs/architecture/SECURITY_BASELINE.md` 文档(汇总声明,放最后,前面动作确定文档内容)

---

## 10. 情感价值对齐(AGENTS.md mvp-q-4 强制)

| 负面情绪 | 基线如何减少 | 正面感受 |
|----------|-------------|---------|
| 失控感(用户不知道 PD 在自己机器上做了什么) | BASELINE.md §5 沙箱姿态声明 + §"用户操作指引" 让行为可预测 | 掌控感 |
| 不信任感(第三方 npm 插件天然不信任) | provenance + SECURITY.md + CodeQL + gitleaks 让供应链可验证 | 安心感 |
| 信息过载(安全文档太多看不懂) | BASELINE.md 是 ARCHITECTURE.md 的子集,只列"已守护"项,post-MVP 项明确排除 | 清醒感 |

---

## 11. MVP 三问对齐(AGENTS.md 强制)

| ID | 回答 |
|----|------|
| `mvp-q-1-what-if-skip` | 跳过后,首个 npm 安装 PD 的用户若遇供应链投毒 / vm 逃逸 / PII 泄漏,30 天内必然被提起,且可能直接毁掉 seed customer 信任 |
| `mvp-q-2-how-observed` | `npm run verify:merge` 失败即基线违规;`npm run check:security-baseline` 输出基线合规报告 JSON |
| `mvp-q-3-how-disabled` | 基线本身是 CI 守护 + 守护测试,无运行时副作用,无需 feature flag。新增 forbidden patterns 走现有 code_tool_hook shadow mode 路径,本身已有 disable 机制 |
| `mvp-q-4-emotional-value` | 见 §10 |

---

## 12. 风险与边界

- **残余风险**:node:vm 0day V8 逃逸(§5.5 已声明);GitHub repo settings(secret scanning push protection)无法 CI 守护,依赖人工启用一次
- **不突破 MVP 边界**:不引入新 functional subsystem / hook / writer / reader;不实施 dual approval / rate limit / hash chain / PII scanner / isolated-vm 迁移;不新增 feature flag(本轮全是 CI 守护 + 文档 + 守护测试,无运行时行为变化)
- **不违反 core 边界**:forbidden patterns 升级在 [rule-code-validator.ts](../../../packages/principles-core/src/runtime-v2/internalization/rule-code-validator.ts)(core 纯逻辑),守护测试在 architecture-regression(core 测试目录),CI 脚本在 scripts/(工具链)。无 I/O 进 core
- **ERR 考量**:本轮无运行时逻辑变更,主要风险是守护测试误报。ERR-001/005(as bypass)在守护测试中应避免——守护测试用 `unknown` + 类型守卫处理读到的文件内容;ERR-009(fail-loud-missing)在 check 脚本中落实——缺失文件直接 exit 1 + JSON reason

---

## 13. 外部基准参考

- OWASP Top 10 for LLM Applications 2025(LLM01=Prompt Injection,扩展到 RAG/agent 工具安全)
- Node.js 官方文档 vm 模块安全声明(https://nodejs.org/api/vm.html — "The node:vm module is not a security mechanism")
- npm provenance / SLSA Build L3(https://docs.npmjs.com/generating-provenance-statements)
- GitHub Open Source Security(SECURITY.md / CodeQL / secret scanning push protection / Dependabot)
- SQLite security(https://www.sqlite.org/security.html)
- better-sqlite3(parameterized queries 默认安全)

---

## 14. 验收标准

本 spec 实施完成后,以下条件必须全部满足:

- [ ] `.github/SECURITY.md` 存在
- [ ] `.github/workflows/codeql.yml` 存在且 CI green
- [ ] lefthook 配置含 gitleaks
- [ ] `pr-checks.yml` 含 `npm audit --audit-level=high`
- [ ] `scripts/check-security-baseline.js` 存在,`npm run check:security-baseline` 输出 `{"ok":true,...}`
- [ ] `npm run verify:merge` 包含 `check:security-baseline` 且整体 green
- [ ] `architecture-regression.test.ts` 含 SEC-BASE-1~5 五个 describe,全部 pass
- [ ] `sandbox-escape-regression.test.ts` 存在且 pass
- [ ] [rule-code-validator.ts](../../../packages/principles-core/src/runtime-v2/internalization/rule-code-validator.ts) forbidden patterns 含 `import.meta`/`Reflect`/`Proxy`/`WeakRef`/`FinalizationRegistry`/`SharedArrayBuffer`/`Atomics`
- [ ] `docs/architecture/SECURITY_BASELINE.md` 存在,含四层基线声明 + post-MVP 项 + 残余风险声明 + 用户操作指引
