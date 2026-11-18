<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-209",
  "displayId": "ERR-209",
  "title": "A new bypass predicate depended on state the same code path destroys, so a failed first attempt re-created the deadlock",
  "status": "active",
  "category": "Process & Workflow",
  "ep": "EP-02",
  "createdAt": "2026-11-17",
  "source": "PRI-1249 / PR #2697 devin-review 4600735424 (fixed in the follow-up commit of PR #2697)"
}
-->

一个修复引入的新放行判据，依赖了**同一段代码路径自己会销毁的状态**。

PRI-1249 的第一次修法要判断"这个宿主是不是已经装过 PD"，用的是 marketplace 载荷目录里的 `mcp-binding.json` 是否存在。看起来合理：这个文件就是上一个版本写下的绑定。但紧接着的 `materializeMarketplace()` 第一步就是 `rmSync(marketplaceRoot, {recursive: true, force: true})`，然后才 `cpSync` 载荷、再写新绑定。

于是出现一个只在失败路径上暴露的洞：复制因 ENOSPC / EBUSY / 权限失败时，旧目录已经删掉、新绑定还没写，catch 分支直接报错返回（同一函数里没有任何恢复）。用户腾出空间重试时，判据看到"没有 binding" ⇒ 判定为**首次注册** ⇒ 在 Gate 4 的同名条目检查处被拒 ⇒ 又回到原来那个不可自愈的死锁。修 bug 的改动反而给同一个 bug 造了一个新的入口，而且更隐蔽：只有"先失败一次再重试"才会踩到。

正确判据必须来自本次重建**不会破坏**的事实：宿主自己的注册记录（`installed_plugins.json` 里的 plugin key）在磁盘上是独立的，marketplace 重建动不到它。修法改为 `binding 存在 || details.registered`，并补了一条用例：先删掉 marketplace 载荷（模拟复制失败后的现场）、保留注册记录、`mcp.json` 留着失效条目 ⇒ 安装仍然成功并把 binding 重钉到 0.4.3。

Must check: 引入任何"是否已安装/是否首次"的判据时，先列出本次流程会删除或重建哪些路径；判据若落在这些路径上，就等于把失败路径变成"假装首次"。失败重试场景必须单独造一个用例（先失败、再修环境、再跑），否则只有 happy path 被验证。
