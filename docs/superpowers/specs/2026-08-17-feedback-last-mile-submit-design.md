# PD 反馈最后一公里:提交通道与高价值信号收集设计

> Date: 2026-08-17
> Status: Draft(已完成代码核实与自评,修正记录见 §20)— 待 Owner 批准后建 Linear issue 实施
> Supersedes: 本 spec 修订 `2026-05-31-feedback-channel-design.md` 的 Product Boundary 一节(仅该节),其余条款继续有效
> Linear: (待建)

## 0. 已确认的 Owner 决策

| 决策点 | 结论 |
|---|---|
| 主通道 | 自托管接收端点(一键 POST) |
| 端点部署 | Cloudflare,复用官网项目 `principles-website`(Pages Function) |
| 反馈落地 | Linear issue(Principles_disciple 团队) |
| gh CLI 通道 | 保留为次通道(需代理环境) |
| GitHub 仓库 | `csuzngjh/principles` |
| 维护者邮箱 | `csuzngjh@hotmail.com`(注意:代码默认值是占位符 `maintainer@example.com`,**必须**经 config 显式设置;安装模板预填真实值) |
| 启用条件 | 配置存在即启用,无需独立子开关 |
| 约束 | 国内小白用户可能无法直连 GitHub;反馈质量设计优先于通道数量 |

## 1. Context

MVP 反馈通道(PRI-285)已实现"本地草稿生成 + 手动复制"闭环,但存在两个已确认问题:

1. **最后一公里断裂**:草稿只存本地 `.pd/feedback/drafts/`,无送达通道。gh CLI 与 GitHub 预填链接在国内无代理环境不可达;mailto 依赖本机邮件客户端,小白用户常在此卡死。收集率趋近于零。
2. **信号质量不足**:单一静态表单(所有类型共用 bug 模板),severity 枚举(low/medium/high)用户无法诚实作答;核心实体页(pain/principles/activation)无反馈入口,诊断上下文靠用户手敲;维护者侧收到的是散落的重复反馈,无法聚合分诊。

本 spec 解决两个问题:**通道按国内可达性分层降级** + **从表单到分诊的全链路信号质量控制**。

## 2. Product Boundary 修订

原 2026-05-31 spec 约束 "PD does not submit GitHub issues with a token; does not send email directly" 修订为:

**PD 拥有反馈的提交通道,但仅限于用户显式动作触发的提交**。具体:

- ✅ 允许:用户在确认面板点击"提交"后,Console 服务端向**配置的**端点(自托管 relay / gh CLI)提交**已脱敏的已存草稿**;
- ❌ 禁止:任何自动/后台/静默提交;agent 自动提交(agent 流仍为 draft-only,由人审阅后点击提交);
- ❌ 禁止:PD 存储 GitHub PAT、SMTP 凭证等任何提交密钥(gh 通道复用 gh CLI 本机登录态);
- ❌ 禁止:提交内容绕过创建时的脱敏管线(提交按 id 进行,服务端读已存草稿,客户端不可注入)。

隐私红线(不收集 raw prompt/chat/trajectory/文件内容/绝对路径/环境变量/token;脱敏元数据随报告输出)全部保持不变。

## 3. Goals / Non-Goals

### Goals

1. 国内无代理环境下,小白用户 3 次点击内完成反馈提交(填表 → 确认 → 提交)。
2. 反馈按类型差异化提问,产出结构化、可分诊的字段(阻塞度、频率、目标)。
3. 核心实体页(pain/principles/activation/failed-tasks)具备上下文入口,自动预填实体 ID 与标题摘要。
4. 维护者侧:重复反馈按指纹聚合,阻塞度 × 频率驱动优先级,落 Linear 单一收件箱。
5. 每次提交有回执(trackingId / issueUrl),草稿状态可见(draft / submitted)。

### Non-Goals

- 不做浏览器内直连 relay(提交由本地 Console 服务端执行,token 不进浏览器);
- 不做 SMTP 直发;
- 不做反馈状态双向同步(relay → Console 的回复通知等后置);
- 不做自然语言聚类/LLM 归并(指纹 = 确定性哈希,足够 MVP);
- 不改 agent 草稿流程(`pending_agent_drafts` 契约不变)。

## 4. 通道阶梯(Channel Ladder)

UI 按探测结果排序展示,不可用通道禁用并显示原因 + nextAction(rc-9)。

| 级 | 通道 | 国内可达 | 小白友好 | 触发方式 | 状态写回 |
|---|---|---|---|---|---|
| 1 | **ingest 一键提交** | ✅(与官网同域) | ✅ | 服务端 POST → relay → Linear | `submitted` + trackingId + issueUrl |
| 2 | gh CLI 提交 | ⚠️ 需代理 | 开发者向 | 服务端 execFile gh | `submitted` + issueUrl |
| 3 | mailto 邮件 | ⚠️ 依赖邮件客户端 | 弱 | 打开 mailto(已有) | 不自动标记;提供"手动标记已发送" |
| 4 | 导出文件 → 微信 | ✅ 零网络 | ✅ | 客户端 Blob 下载 `<id>.md` | 同上,手动标记 |

**设计要点**:

- GitHub 不可达问题被挪到 relay 服务端解决——relay(部署在 Cloudflare)调 Linear API,用户侧永远不碰 GitHub。
- 通道 3/4 无法服务端确认送达,绝不虚标 `submitted`;诚实性优先。
- 通道探测缓存 60 秒,探测失败 fail-open(显示可用,提交时失败再降级并给 reason)。

## 5. 数据模型扩展(core,全部可选字段,旧草稿向后兼容)

### 5.1 新增枚举

```ts
type FeedbackFrequency = 'always' | 'often' | 'sometimes' | 'once';
type FeedbackBlockingLevel = 'blocked' | 'workaround' | 'minor';
type FeedbackStatus = 'draft' | 'submitted';
type FeedbackSubmittedVia = 'ingest' | 'github' | 'email' | 'file';
```

### 5.2 FeedbackReport 扩展

```ts
interface FeedbackReport {
  // ...现有字段不变
  userText: {
    // ...现有字段不变(bug 模板继续使用)
    // 类型化新增(全部可选,按 type 条件渲染进 markdown)
    goal?: string;              // confusing: 你当时想做什么
    stuckAt?: string;           // confusing: 卡在哪一步
    job?: string;               // feature_request: 你想达成什么目标
    currentWorkaround?: string; // feature_request: 现在怎么凑合
    sawWhat?: string;           // privacy_concern: 你看到了什么
    whereSeen?: string;         // privacy_concern: 在哪里看到的
    frequency?: FeedbackFrequency;      // bug
    blockingLevel?: FeedbackBlockingLevel; // bug/confusing,UI 上取代 severity
  };
  area?: string;                // 来源页面 id(failed_tasks/pain/principles/...)
  status?: FeedbackStatus;      // 缺省 = 'draft'
  submittedAt?: string;
  submittedVia?: FeedbackSubmittedVia;
  trackingId?: string;          // relay 回执
  externalUrl?: string;         // Linear/GitHub issue URL
}
```

- **校验器是白名单式**(核实:`normalizeFeedbackDraftInput` 逐字段拷贝已知键,未知键静默丢弃不报错)——新 userText 字段必须同步扩展三处:`FeedbackDraftInput`(unknown 类型)、`FeedbackUserText` 接口、normalize 内的 `validateOptionalString` + 拷贝逻辑。UI 与 core 同 PR 发布,无版本漂移风险。
- **barrel 再导出**(EP-02):新类型/枚举 guard/`computeFeedbackFingerprint` 必须沿 `feedback/index.ts` → `runtime-v2/index.ts` 逐层 re-export;若触及 core 公共导出面,同步检查 `architecture-regression.test.ts`。
- `userSeverity` 保留读兼容(UI 不再展示);旧草稿展示时映射:high→blocked / medium→workaround / low→minor(仅展示映射,不改文件)。
- 新 userText 字段全部走既有脱敏管线(`redactAbsolutePaths + redactTokenLikeValues + redactEnvLikeValues`,8000 字符截断)。
- 渲染:`renderReportMarkdown` 按 type 条件输出新字段小节;`buildEmailText`/`buildMailtoUrl` 同步。

### 5.3 指纹(新增纯函数 `feedback/fingerprint.ts`)

```text
normalize(s) = lowercase → 去标点 → 压缩空白 → 截前 80 字符
fingerprint = sha256hex(`${type}|${area ?? 'general'}|${normalize(title)}`)
```

Console 侧计算并随提交发送;**relay 侧重算并校验**,不一致即拒绝(完整性检查,防伪造 area/title 解耦)。

**双实现 + 共享测试向量**:core 侧用 node:crypto,relay 侧(Workers)用 WebCrypto `subtle.digest`,两份实现必须配同一份 fixture(输入 → 期望 sha256 hex)做交叉一致性测试,防止归一化规则漂移。**已知限制**:指纹只聚合"同类型+同区域+同(归一化)标题",同一问题不同措辞不会聚类——MVP 接受此限制,靠 relay 侧人工归并兜底。

## 6. 类型化动态表单

| type | 必填 | 条件字段 |
|---|---|---|
| bug | 发生了什么 | 复现步骤 · 预期 · 实际 · **频率** · **阻塞度** |
| confusing | 你当时想做什么 | 卡在哪一步 · **阻塞度** |
| feature_request | 你想达成什么目标 | 现在怎么凑合的 |
| privacy_concern | 你看到了什么 | 在哪里看到的 |
| other | 描述 | — |

- 标题必填保持;类型默认值按来源推断:failed-tasks/error 入口 → `bug`,通用入口 → `other`。
- severity 下拉从 UI 移除,替换为阻塞度(卡住我了 / 能绕过 / 不影响)与频率(每次 / 经常 / 偶尔 / 仅一次)。
- 渐进披露:默认只展开必填区,条件字段折叠在"补充细节"下(类型切换时相应展开)。

## 7. 上下文入口(Contextual Entry Points)

| 页面 | 入口 | 预填 |
|---|---|---|
| failed-tasks | 已有 | taskId/painId(保持)+ **标题预填** `[失败任务] <错误摘要前 60 字>` |
| error-boundary | 已有 | source/message(保持)+ 标题预填 `[页面错误] <message 前 60 字>` |
| pain | 卡片"反馈"按钮(新增) | painId + area=pain + 标题预填 `[行为证据] <摘要>` |
| principles | 卡片"反馈"按钮(新增) | principleId + area=principles + `[原则] <名称>` |
| activation | 卡片"反馈"按钮(新增) | activationId + area=activation + `[生效] <摘要>` |
| focus / intent | 页面级入口(新增) | area=focus / intent |

- 入口视觉遵循克制的提醒风格(小图标按钮,hover 显现),不用高对比横幅。
- `context` 字段链路已存在(create-report.ts contextRefs),本切片只补 UI 接线。
- `area` 从 `context.page`/`sourceDetail` 归一化写入报告顶层。

## 8. Console 服务端(pd-console,全部 I/O 落此层)

### 8.1 通道探测

```
GET /api/feedback/submit/channels
→ 200 { channels: [
     { id:'ingest',  available, reason?, nextAction? },   // config 有 ingest_url + relay /health 探活(2.5s 超时, 60s 缓存)
     { id:'github',  available, reason?, nextAction? },   // gh 存在 + `gh auth status` exit 0 + github_repo 已配置
     { id:'email',   available, reason?, nextAction? },   // maintainer_email 非空(恒真,现有默认值)
     { id:'file',    available: true }                    // 恒可用
   ]}
```

### 8.2 提交端点

```
POST /api/feedback/reports/:id/submit   body: { channel: 'ingest' | 'github' }
→ 200 { status:'submitted', submittedVia, trackingId?, externalUrl?, alreadySubmitted? }
→ 409/4xx/5xx { error, reason, nextAction }
```

规则:

- **按 id 提交**:服务端读取已存脱敏草稿,用 `outputs` 内容提交;请求体不携带报告内容。
- **幂等**:已 `submitted` 的草稿再次提交同通道 → 200 + `alreadySubmitted: true` + 既有回执,不重复建单。
- **失败不降级状态**:任何失败草稿保持 `draft`,结构化 reason + nextAction,UI 引导降级通道。
- **写回**:`FeedbackReportConsoleModel` 新增 `update(id, patch)`(原子写:tmp + rename,与 create 同范式);写回失败时返回成功提交结果 + `writeBackFailed: true` + nextAction(宁重复提示不丢回执)。

### 8.3 ingest 适配器(本地 Node 服务端 → relay)

- `fetch(ingest_url, { method:'POST', headers:{ Authorization: Bearer <ingest_token> }, body: { report, fingerprint, area } })`;
- 20s 超时;token 仅存服务端配置,不进浏览器(浏览器 → 本地 Console → relay,无 CORS 问题)。

### 8.4 gh 适配器

```text
gh issue create --repo <github_repo> --title <title> --body-file <tmp> --label feedback
```

- `execFile`(参数数组,零 shell 拼接,防注入);
- body 写入 0600 临时文件,提交后删除;
- 30s 超时;`github_proxy` 非空时为子进程设 `HTTPS_PROXY`;
- 成功解析 stdout URL 写回 `externalUrl`。

### 8.5 导出文件(通道 4)

客户端实现:Blob(`outputs.markdown`)下载,文件名 `PD-feedback-<id>.md`(id 已过 `reportIdValidator`,天然安全)。零服务端改动,离线可用。

## 9. Relay 设计(Pages Function,`packages/website/functions/api/feedback.ts`)

部署形态:**官网项目的 Pages Function**,与 `principles-website.pages.dev` 同域同可达性;将来官网挂自定义域名时自动跟随,`ingest_url` 仅改配置。

### 9.1 端点

```
POST /api/feedback            提交(见 9.3)
GET  /api/feedback/health     → 200 { ok:true }(无数据,供 Console 探活)
```

`GET /api/feedback/:trackingId` 查询端点**推迟**(回执已含 issueUrl,用户侧无直接用途;需要时再加)。

### 9.2 防护

- **鉴权**:`Authorization: Bearer <INGEST_TOKEN>`,常量时间比较(Workers 无 `crypto.timingSafeEqual`,手写 XOR 循环比较);错误统一 401,不区分"缺 token/错 token"。**定位**:token 随发布版分发即公开,它是**防滥用边界而非安全边界**——真正的内容防线是 Console 侧脱敏管线 + relay 体积/限流。
- **限流**:KV 计数 `rl:<ip>:<hourBucket>`,5 次/小时/IP(CF-Connecting-IP);超限 429 + Retry-After。KV 最终一致性(≤60s 窗口)意味着极限并发下可略微超限——反馈量级下可接受。
- **体积**:请求体 ≤ 256KB(与 Console 路由一致);超限 413。
- **字段白名单**:只接受 FeedbackReport 已知字段的超集校验,未知顶层字段拒绝(400)。
- **日志边界**:错误日志只记 fingerprint/trackingId/原因,不落完整报告体。

### 9.3 提交流程

```
校验 token → 限流 → 解析/白名单校验 → 重算指纹并与提交值比对(不一致 400)
  → KV 读 fp:<fingerprint>
     ├─ 无 → Linear issueCreate(标题 `[PD反馈][<type>][<area>] <title>`,
     │        描述 = outputs.markdown + 回执脚注, 优先级 = blockingLevel 映射)
     │        → KV 写 fp/id 映射 → 202 { trackingId, issueUrl, duplicate:false }
     └─ 有 → Linear issueCommentCreate(新报告摘要: 时间/阻塞度/描述前 200 字)
              + count 自增 → 202 { trackingId, issueUrl, duplicate:true, count }
```

- `trackingId = 'fb-' + 8 位随机`(relay 生成);KV `id:<trackingId>` 存 { fingerprint, issueUrl, createdAt }。
- Linear 优先级:blocked→High / workaround→Medium / minor→Low;team = Principles_disciple(`LIN_TEAM_ID` 环境变量)。
- Linear API 失败 → 502 + nextAction(维护者侧问题,与用户无关,Console 显示降级通道)。
- 指纹 KV 记录:`{ count, firstSeen, lastSeen, issueId, issueUrl }`,无 TTL(长期聚合计数)。

### 9.4 绑定与密钥(Pages 项目)

```
KV:        FEEDBACK_KV
Secrets:   INGEST_TOKEN, LIN_API_KEY   (wrangler pages secret put)
Vars:      LIN_TEAM_ID
```

优先在 `packages/website/wrangler.toml`(Pages 项目配置,含 `pages_build_output_dir` + `[[kv_namespaces]]` 绑定)代码化声明,secrets 走 `wrangler pages secret put`;对既有 dashboard 配置的项目启用 wrangler.toml 是配置来源切换,runbook 中单独列出验证步骤。

## 10. 配置与 Feature Flag

```yaml
# .pd/config.yaml —— 沿用现有真实 schema:开关在 features 段,通道参数在 feedback 段
features:
  feedback_channel: { category: 'quiet', enabled: true }  # 现有总开关(关 → 提交端点 403,UI 隐藏提交区)
feedback:
  maintainer_email: csuzngjh@hotmail.com         # 代码默认是占位符 maintainer@example.com,必须显式设置
  ingest_url: https://principles-website.pages.dev/api/feedback   # 存在即启用主通道(必须 https)
  ingest_token: <随发布版分发的随机串>           # 防滥用令牌,非安全边界(见 §9.2)
  github_repo: csuzngjh/principles               # 存在即启用 gh 通道
  github_proxy: ""                               # 可选,为 gh 子进程设 HTTPS_PROXY
```

- **不新增 feature flag**:`feedback_channel` 现为 quiet 类 flag 且默认 enabled:true(create-principles-disciple/src/mvp-config.ts:298)。提交是该子系统内的功能扩展;flag 注册表条目的 scope 注释更新为"含提交通道"。
- **loader 双点同步**:新配置键的读取落在 `pd-console/src/server/config/pd-config-store.ts`(与 `getFeedbackMaintainerEmail` 同范式:unknown-first、Object.hasOwn、无 `as`);**同时** `create-principles-disciple/src/mvp-config.ts` 的 `generateConfigYamlContent` 模板必须同步写入新键 + 预填 maintainer_email,否则新装工作区没有 ingest 配置。
- **顺手修复既有矛盾**:`pd-console/src/server/index.ts:261` 注释声称默认邮箱为 hotmail,与实现(占位符)不符——本切片一并修正。
- **禁用路径**(mvp-q-3):总开关 `enabled: false`(403);单通道禁用 = 删对应配置键(探测返回不可用,按钮隐藏);全量回退 = PR revert,无 schema 迁移(新字段全可选)。

## 11. UI 设计要点

1. **确认面板(同意门)**:提交前模态展示最终标题 + 正文(已脱敏 markdown 预览)+ 目标(Linear 经由反馈服务 / GitHub 仓库),主按钮明确写动作后果("提交到维护者反馈服务")。
2. **通道按钮组**:按阶梯排序;禁用态内联显示原因 + nextAction(如 `gh auth login`);ingest 按钮文案用用户语言("一键提交"),不出现"POST/relay"等术语。
3. **回执**:提交成功内联展示 trackingId(等宽字体)+ issueUrl 链接 + "已提交"徽标;草稿列表区分 待发/已发 + 已发时间。
4. **手动标记已发送**:mailto/导出通道的草稿卡片提供"标记为已发送"(诚实标记,不伪造服务端确认)。
5. **期望管理文案**:提交后 toast 附下一步("已提交,回执编号 {{trackingId}},可在已保存草稿中查看")。
6. **i18n**:新键补 zh-CN + en;侧边栏"产品反馈"与页面标题统一为"产品反馈"。

## 12. 错误处理总表(全部含 nextAction,rc-9)

| 场景 | 行为 | nextAction |
|---|---|---|
| flag 关闭 | 提交端点 403,UI 隐藏提交区 | 在 .pd/config.yaml 将 features.feedback_channel.enabled 改为 true |
| relay 不可达/超时 | 草稿保持 draft,reason+降级提示 | 检查网络;或使用导出文件通道 |
| relay 401/429/413 | 同上,透传原因 | 等待后重试 / 精简内容 |
| Linear 建单失败 | 202 不达成,返回 502 | 稍后重试(草稿未消耗) |
| gh 未安装/未登录 | 通道禁用 | 安装 gh / gh auth login |
| gh 建单失败/超时 | 草稿保持 draft | 重试或改用 ingest |
| issue 已建但状态写回失败 | 返回成功 + writeBackFailed:true | 手动确认 externalUrl |
| 指纹校验失败(relay) | 400 | 重新保存草稿再提交 |

## 13. 测试计划

**core(vitest)**:新枚举校验;normalizeFeedbackDraftInput 接受/拒绝新字段;fingerprint 归一化确定性 + 大小写/标点不敏感;render-markdown 按 type 条件渲染;旧草稿(无新字段)解析不回归。

**pd-console server(vitest)**:channels 探测(配置缺失/gh 失败/fail-open);submit 按 id(拒绝客户端注入内容);幂等(已提交 → alreadySubmitted);ingest 适配器(超时/401/429 mock);gh 适配器(execFile 参数数组快照、临时文件删除、代理注入);model.update 原子写;flag 关闭 403;写回失败路径。

**relay(vitest-pool-workers / miniflare)**:token 常量时间比较;限流计数;白名单拒绝未知字段;指纹重算比对;首次建单 vs 重复评论分支(KV 状态断言);Linear mock 失败 → 502;体积上限 413。

**UI(vitest)**:新字段 validator;类型切换条件字段渲染;通道按钮禁用态;提交后回执渲染;旧草稿 severity→blockingLevel 展示映射。

**BDD(`docs/specs/features/feedback/feedback-submit.feature`,新增;现有 feature 按子目录组织:receipt/、story-a/、cli/ 等)**:

```gherkin
Scenario: 一键提交成功
Scenario: relay 不可达时草稿保持 draft 并展示降级通道
Scenario: feature flag 关闭时提交区隐藏
Scenario: gh 未登录时 gh 通道禁用并显示 nextAction
Scenario: 重复提交返回 alreadySubmitted
Scenario: bug 类型显示频率与阻塞度字段
Scenario: pain 页入口预填 painId 与 area
```

## 14. 实施切片

| # | 内容 | 位置 | 依赖 |
|---|---|---|---|
| 1 | 类型扩展 + fingerprint + 渲染器 + core 测试 | principles-core(纯逻辑) | — |
| 2 | channels 探测 + submit 端点 + ingest/gh 适配器 + model.update + 路由测试 | pd-console server | 1 |
| 3 | 类型化表单 + 实体入口 + 确认面板/通道按钮/回执/状态 + i18n + UI 测试 | pd-console UI | 2 |
| 4 | relay Pages Function + KV + Linear + relay 测试 | packages/website/functions | 1(字段契约) |
| 5 | config loader 双点(pd-config-store 新键读取 + create-principles-disciple 模板)+ 注册表 scope 注 + index.ts stale comment 修复 + loader 测试 + 文档修订 | 配置/文档 | 2 |
| 6 | 部署:deploy-website.yml 从 `cloudflare/pages-action@v1`(**官方已弃用,archived**)迁移到 `cloudflare/wrangler-action` + `command: pages deploy`(支持 functions/ 目录,LFS 守卫步骤保留)+ wrangler.toml/secrets runbook | CI | 4 |

切片 1/2/3 串行;4 与 2/3 可并行(契约冻结后);5 随 2;6 上线前完成。

## 15. 验收标准

1. 国内无代理环境,从 failed-tasks 入口 3 次点击完成提交,Linear 出现带 `[PD反馈]` 前缀的 issue。
2. 同一问题第二次提交,Linear 原 issue 收到评论而非新单,Console 回执显示 duplicate + count。
3. 草稿状态机正确:提交成功 → submitted + trackingId;任何失败 → 保持 draft + reason + nextAction。
4. gh 通道在未登录时禁用并显示 `gh auth login` 引导;配置 `github_proxy` 后可用。
5. flag 关闭时所有提交入口消失,端点 403。
6. 类型化表单:feature_request 不出现"复现步骤";bug 表单含频率与阻塞度。
7. pain/principles/activation 卡片可发起反馈,报告 contextRefs 含对应实体 ID,area 正确。
8. 旧草稿(无新字段)在列表与详情中正常展示,不报错。
9. relay 拒绝伪造指纹、超限体积、未知字段;错误日志不含报告正文。
10. 导出文件通道离线可用,生成合法 `PD-feedback-<id>.md`。

## 16. MVP 四问

1. **mvp-q-1-what-if-skip**:不做则种子验证期 Owner 对真实用户痛点全盲,反馈收集率≈0,产品迭代失去输入源。30 天内必然被重新提起。
2. **mvp-q-2-how-observed**:用户侧——提交回执(trackingId/issueUrl)+ 草稿状态徽标;Owner 侧——Linear Principles_disciple 团队收件箱出现 `[PD反馈]` issue 与聚合计数。
3. **mvp-q-3-how-disabled**:`features.feedback_channel.enabled: false`(403+UI 隐藏);单通道删 `feedback:` 段对应配置键即关闭;新字段全可选,PR revert 无迁移成本。
4. **mvp-q-4-emotional-value**:见下节。

## 17. 情绪价值评估(emotional-value.md §7)

| 负面情绪 | 转化 | 设计承载 |
|---|---|---|
| 失控感(反馈发了没人接?) | 掌控感 | 通道阶梯可见 + 禁用原因透明 + 提交前完整预览 |
| 疲惫感(写反馈像写作文) | 轻松感 | 类型化提问 + 实体入口预填 + 渐进披露 |
| 不被重视感(石沉大海) | 安心感/被重视感 | trackingId 回执 + "N 人撞此问题"聚合可见 |
| 信息过载(术语吓人) | 清醒感 | 用户语言文案("卡住我了"而非 severity high);类型化问题帮用户自己想清楚问题 |

## 18. Runtime Contract 映射

- rc-1/rc-2:relay 侧白名单解析,无 `as` 旁路;UI validator 同范式扩字段。
- rc-3:submit 缺 channel/草稿不存在 → fail loud。
- rc-4:recentEvents 等数组校验保持。
- rc-5:KV/JSON 读取用 Object.hasOwn。
- rc-7:提交重试每次重新加载草稿与通道状态,无陈旧循环态。
- rc-8:relay 日志/预览有界(safeStringifyPreview 范式)。
- rc-9:上表全路径含 nextAction。

CLI gate(cli-1~7):不适用——本设计不改 `pd-cli` 命令。

## 19. 文档更新清单

- 本 spec(新增;已经过一轮代码核实,修正项见 §20);
- `2026-05-31-feedback-channel-design.md`:Product Boundary 节追加修订引用(指向本 spec);
- flag 注册表:`feedback_channel` scope 注释更新;
- 部署 runbook:`docs/process/DEPLOY_WEBSITE.md`(packages/website wrangler.toml/secrets/KV 配置步骤 + pages-action → wrangler-action 迁移验证,切片 6 交付)。

## 20. 核实与自评记录(2026-08-17)

本节是 spec 写成后对照代码逐项核实的结果,修正已回写上文。

**核实为真**:256KB 体积上限(feedback-reports.ts:66);model 无 `update()`、create 为 tmp+rename 原子写;路由 `/api/feedback/reports` + subPath 前缀挂载(index.ts:333),`/:id/submit` 可行;`feedback_channel` 为 quiet flag 默认 on(mvp-config.ts:298);outputs 含 markdown/emailText/githubIssueUrl/mailtoUrl;failed-tasks 与 error-boundary 已有入口、pain 等页无入口;官网 dist = `packages/website/.vitepress/dist`。

**已修正的事实错误**:① 默认邮箱实为占位符 `maintainer@example.com`(pd-config-store.ts:734),非 hotmail——此前结论被 index.ts:261 的陈旧注释误导;② 配置 schema 实为 `features.feedback_channel` + `feedback:` 两段,原稿的混合段不存在;③ BDD feature 按子目录组织;④ pages-action 已被 Cloudflare 官方弃用,迁移 wrangler-action 本就势在必行(顺带强化了切片 6 的正当性)。

**补入的漏项**:校验器白名单三处同步(§5.2);barrel 再导出 + architecture-regression 检查(EP-02);指纹双实现共享测试向量 + 聚类已知限制(§5.3);trackingId 查询端点推迟(§9.1);token 定位为防滥用而非安全边界、Workers 常量时间比较、KV 最终一致性(§9.2);config loader 双点同步含 create-principles-disciple 模板(§10);stale comment 修复(§10/§14)。

**自评风险(接受)**:ingest_token 公开性(靠限流兜底);指纹无法跨措辞聚类(人工归并兜底);KV 无 TTL 累积(量极小);Pages Functions 免费额度 10 万 req/天(反馈量级远低)。**设计自评结论**:通道分层、按 id 提交、诚实状态机、全路径 nextAction 四个核心决策经核实无恙;主要风险集中在配置/loader 同步面(切片 5),已通过双点同步 + 测试覆盖。
