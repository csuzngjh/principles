<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-208",
  "displayId": "ERR-208",
  "title": "A sandboxed host install wrote the real host config because a host-exported env var outranked the injected home",
  "status": "active",
  "category": "Missing Tests & Verification",
  "ep": "EP-12",
  "createdAt": "2026-11-17",
  "source": "PRI-1249 / PR #2697"
}
-->

一个"沙箱化"的宿主安装把**真实宿主配置**写掉了：测试注入的 `homeDir` 没有赢过宿主进程导出的 `WORKBUDDY_CONFIG_DIR`。

PRI-1249 调查时发现 `~/.workbuddy/mcp.json` 里有一条指向已删除 vitest 临时目录的 `pd-recall` 条目（`.../test-runs/vitest-20261113-210500-.../source-codex/mcp/launcher.cjs`），文件 mtime 正好等于那次 vitest 运行的时刻。追到代码：`resolveWorkbuddyPaths(homeDir)` 的 `configDir` 取

```
process.env.WORKBUDDY_CONFIG_DIR ?? path.dirname(getWorkbuddyWorkspaceDir(homeDir))
```

即**环境变量优先于调用方传入的 home**。而 WorkBuddy 桌面进程会把这个变量导出给子进程，于是任何在该环境下跑的测试，即使给 installer 传了 `homeDir: <sandbox>`，`settings.json` / `installed_plugins.json` / `mcp.json` 的读写目标都还是真实用户目录。`mcp-registration-conflict.test.ts` 恰好没有隔离这个变量（其他 workbuddy 测试有），所以它的"沙箱安装"把沙箱里的临时 payload 路径注册进了真实宿主配置。

后果不是脏数据而是**生产故障链**：那条失效条目归属不可证明 ⇒ 之后每次宿主安装都在 Gate 4 中止 ⇒ `mcp-binding.json` 永远停在 0.4.1 ⇒ launcher 稳定 fail-closed `binding_version_mismatch:0.4.1!=0.4.3`。

同一天本会话第一次跑该测试（19:29）就现场复现了同类破坏：真实 `settings.json` 被写成 `{}`、`installed_plugins.json` 被指向沙箱的 `0.3.0` payload。

修复方向有两层，缺一不可：

1. 测试侧：凡是驱动宿主安装的用例，必须显式把 `WORKBUDDY_CONFIG_DIR` 指到沙箱（项目里已有这个配方，只是漏了一个文件）。
2. 产品侧：门禁不能建立在"归属不可证明"这种不可自愈的状态上——PRI-1249 让已绑定宿主越过不可验证条目并重钉 binding。

Must check: 任何"隔离 home"的测试，先枚举被测代码会不会读覆盖 home 的环境变量（`*_CONFIG_DIR`、`CODEX_HOME`、`HOME`/`USERPROFILE` 派生）；只 mock `os.homedir()` 或只传 `homeDir` 参数**不构成隔离证明**。写新宿主测试时，先断言产物的路径落在沙箱内（或断言真实宿主文件的 sha 不变），再断言业务结果。
