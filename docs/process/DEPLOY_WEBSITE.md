# 官网 + 反馈 Relay 部署 runbook

> 相关:反馈最后一公里 spec §9.4 / §14 切片 6(`2026-08-17-feedback-last-mile-submit-design.md`)
> 交付物:本轮将部署由 `cloudflare/pages-action@v1`(官方已弃用/archived)迁移到 `cloudflare/wrangler-action@v4` + `pages deploy`,并把 Pages 项目配置代码化到 `packages/website/wrangler.toml`。

官网与反馈 relay 共用一个 Cloudflare Pages 项目 `principles-website`(静态资源 + `functions/`)。`ingest_url` 与官网同域同可达性。

## 1. 前置:GitHub secrets

仓库已配置(沿用即可):

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

本地操作(wrangler)需登录:`npx wrangler login`。

## 2. 项目配置来源切换(dashboard → wrangler.toml)

从 `cloudflare/pages-action` 迁移的关键:**Pages 项目配置的来源从 dashboard 切换到 `packages/website/wrangler.toml`**。对已存在的项目启用 wrangler.toml 是配置来源切换,必须先核对再落地,避免生产配置漂移。

`packages/website/wrangler.toml` 现行内容:

```toml
name = "principles-website"
compatibility_date = "2026-06-08"
pages_build_output_dir = ".vitepress/dist"

[[kv_namespaces]]
binding = "FEEDBACK_KV"
id = "REPLACE_WITH_FEEDBACK_KV_NAMESPACE_ID"

[vars]
LIN_TEAM_ID = "REPLACE_WITH_LINEAR_TEAM_ID"
```

> - 每次新的 `wrangler pages deploy` 都以该文件为 source of truth(dashboard 中的绑定会被本品覆盖)。
> - `INGEST_TOKEN`、`LIN_API_KEY` 是 **secret**,**绝不可写入 wrangler.toml**(会进仓库),一律用 §4 的 `wrangler pages secret put`。
> - **前提**:Pages 项目使用 wrangler 配置要求 **V2 build system**(或更新),且 wrangler ≥ 3.45.0。若项目仍在 V1 build system,先按 Cloudflare 文档迁移到 V2,否则 `pages deploy` 不会读取本配置。

### 验证(必须,防止覆盖既有绑定)

1. 下载现网项目配置(functions 的 binding 来源):`npx wrangler pages download config`
2. 确认现有 dashboard 绑定(若有 KV/vars)与新 wrangler.toml 语义一致后再覆盖。
3. 若项目此前**没有** binding,切到 wrangler.toml 后首次 deploy 会新增 `FEEDBACK_KV`/`LIN_TEAM_ID`;此后 dashboard 与 file 不可再双写(以 file 为准)。

## 3. KV namespace 创建与绑定

```bash
# 创建命名空间,输出 <NAMESPACE_ID>
npx wrangler kv namespace create FEEDBACK_KV
```

把输出的 ID 填入 `packages/website/wrangler.toml` 的 `[[kv_namespaces]] id = "..."`,提交 `main` 后触发 deploy 即生效。若需 preview 隔离,另建命名空间并加 `preview_id`。

## 4. Secrets(`wrangler pages utility secret put`)

> Pages 的 secret 绑定到项目,用 `wrangler pages secret put` 设置(也可在 dashboard → Settings → Bindings → Secrets 添加)。

```bash
cd packages/website
npx wrangler pages secret put INGEST_TOKEN     # 输入:随发布版分发的防滥用令牌(非安全边界,见 spec §9.2)
npx wrangler pages secret put LIN_API_KEY      # 输入:Linear 个人/服务 token(personal API key)
npx wrangler pages secret put TELEMETRY_HMAC_SECRET  # 输入:≥32 字节随机 hex(node -e "require('crypto').randomBytes(32).toString('hex')")。遥测收集器服务端 ID 保护,缺失/过短 → 收集器 500 fail-closed
npx wrangler pages secret put PRODUCT_SIGNALS_TOKEN  # 输入:≥24 字节随机 hex。/product-signals 维护者视图 Bearer token
```

每个 secret 设置后需重新 deploy 生效。

## 4a. 匿名产品遥测 D1(ADR-0021)

D1 数据库与迁移(一次性,已完成):

```bash
cd packages/website
npx wrangler d1 create pd-product-telemetry    # 已创建:id c96b7ef1-f6f4-43b0-bce7-9c12881d6b21(APAC),binding PD_PRODUCT_TELEMETRY 已写入 wrangler.toml
npx wrangler d1 migrations apply pd-product-telemetry --remote   # 应用 migrations/0001_product_telemetry_daily.sql
```

- 保留策略:90 天,由每次成功写入时的 DELETE 清扫强制执行(Pages Functions 无 cron)。
- 验证:`node scripts/telemetry-e2e-validate.mjs --endpoint https://principles-website.pages.dev --signals-token <token>`。
- 本地开发:`.dev.vars`(已 gitignore)+ `wrangler d1 migrations apply pd-product-telemetry --local`。

## 5. Vars(`LIN_TEAM_ID`)

`LIN_TEAM_ID` 非 secret,已在 wrangler.toml `[vars]` 声明,填 Linear 团队 id 即可(Principles_disciple 团队)。无 UI/dashboard 双写之忧(file 为准)。

## 6. CI 工作流(.github/workflows/deploy-website.yml)

迁移的核心改动(已提交):

- 原:`uses: cloudflare/pages-action@v1`,`directory: packages/website/.vitepress/dist`
- 现:`uses: cloudflare/wrangler-action@v4`,`workingDirectory: packages/website`,`command: pages deploy --project-name=principles-website --branch=main`
- LFS 守卫步骤(`Verify LFS assets pulled`)保留(官方弃用 pages-action 后需确认 `pages deploy` 仍上传完整 LFS 资源)。

> 为什么不直接写 `packages/website/.vitepress/dist` 目录参数:`pages deploy` 在 `workingDirectory`(即 wrangler.toml 所在目录)执行,通过 `pages_build_output_dir + wrangler.toml` 定位静态目录与 `functions/`。迁移后需验证 `functions` 目录被正确打包(见 §7)。

## 7. 迁移后验证清单

1. **构建**:`npm run docs:build -w @principles/website` 通过。
2. **健康端点**:`curl https://principles-website.pages.dev/api/feedback/health` → `200 {"ok":true}`(证明 relay function 已部署)。
3. **提交连通**:本地 Console 配置 `ingest_url` + `ingest_token` 后,从 failed-tasks 入口完成一次真实提交,Linear 出现 `[PD反馈]` issue(见 spec §15 验收①)。
4. **绑定生效**:提交触发 KV 写入(rl 计数/指纹记录),`wrangler kv key get` 可查到对应 key(或 dashboard KV 查看)。
5. **LFS 资源**:`homepage-demo-*.mp4` 仍为真实内容(>1KB),未被 LFS 占位指针替代。
6. **遥测端点**:`curl https://principles-website.pages.dev/api/product-telemetry/health` → `200 {"ok":true}`;完整校验跑 `scripts/telemetry-e2e-validate.mjs`(含 schema 拒绝、413、限流、视图 401)。

## 8. 回滚

- **部署方式回退**:将 deploy step 改回 `cloudflare/pages-action@v1`(或本文件的上一版),重跑 workflow。
- **binding 回退**:从 wrangler.toml 删除 `[[kv_namespaces]]`/`[vars]` 段,回到 dashboard 管理(dashboard 中还原绑定)。
- **功能回退**:`features.feedback_channel.enabled: false`(端 403)或删除 `feedback:` 段对应键;新字段全可选,PR revert 无迁移成本(spec §10 禁用路径)。
- **遥测回滚**(ADR-0021,四条独立路径):客户端 flag `anonymous_product_telemetry.enabled: false`(默认即 off)→ 零请求;用户 `pd telemetry disable`;环境 `PD_TELEMETRY_DISABLED=1`;服务端删除 endpoint binding 或清空 D1(`wrangler d1 execute pd-product-telemetry --remote --command "DELETE FROM product_telemetry_daily"`)。