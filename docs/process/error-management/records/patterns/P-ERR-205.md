<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-205",
  "displayId": "ERR-205",
  "title": "An unverified mitigation was documented as the diagnosed cause: comments and architecture docs asserted causality the observations contradicted",
  "status": "active",
  "category": "Documentation & Spec Drift",
  "ep": "EP-06",
  "createdAt": "2026-11-15",
  "source": "PRI-1219 / PR #2656 self-review (commit 94d74e2f wrote the 404.html cause into code + PRI-727 doc; fixed in 952237f8)"
}
-->

代码注释与架构文档把一个**未经验证的缓解措施**写成了缺失路径返回 5xx 的成因。

PRI-1219 的 D2（载体对缺失路径回 503 而不是 404）当时只有一条观测：`curl` 拿到 `503 / Server: Varnish` 与 GitHub 的 "Unicorn" 错误页。基于这条观测，首个提交在发布器里加了静态 `404.html`，并在代码注释里写下「served 404 document is what makes the carrier do that」、在 PRI-727 架构文档里写下「publisher now ships … a 404 document so the carrier's miss answer is the status the client expects」——都是因果断言，而实际上证据指向别处：

- 同一时刻站点根 `/principles/` 也返回 503，那本该由 Pages 自己的索引/404 逻辑回答；
- 同 CDN 下其他 GitHub Pages 站点（`pages.github.com`、`octocat.github.io`）对缺失路径仍返回 404；
- 已存在的文件（含冷路径 `targets/channels/stable.json`）全部 200。

三条合起来更像 Pages 部署/构建故障，而不是「站点没有 404.html」。也就是说 `404.html` 是一个无害但未证实的缓解，而不是诊断结论；只有真实重发布之后观察状态码变化才能确认。把未证实的因果写进注释的代价很具体：下一个人会把它当结论，从而不去查部署状态。

自查后改为：注释与文档都标注「mitigation, not a diagnosed cause」，列出上述三条反向证据，并写明「只有真实 re-publish 才能验证」；同时把 `404.html` 与「版本化 root 对象」分开评价——后者是确定的仓库形状缺陷（发布器从来没产出过 `<version>.root.json`），前者不是。

Must check: 代码注释与架构文档里凡是「X 导致 Y」的断言，必须有本轮可直接观察的证据支撑，并且要主动列出与断言冲突的观测；证据不足时写「缓解措施/待验证」，不要写成因。评审时对「注释比证据更确定」的段落单独提一条意见。
