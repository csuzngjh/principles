---
"create-principles-disciple": patch
---

更新检查不再被载体 5xx 判死（PRI-1219）：TUF 刷新对 `<已信任版本+1>.root.json` 的探测，遇到持续 5xx 时按“无更新根”处理（根仍钉住既有 anchor；轮转到旧根不认识的新密钥仍会在后续 timestamp/snapshot/targets 验签处 fail-closed，而仅换版本号或吊销密钥的轮转会被推迟、不会被判定为失败），并对瞬时 5xx 做有界重试。被推迟的轮转不再静默：成功结果新增 `retainedTrustAnchor`，给出探测 URL、状态码与处置建议。下载失败的错误信息改为报出对象、URL 与 HTTP 状态（含传输层 cause 链），不再伪装成“无法通过可信根验证”。发布侧补齐 TUF 规范要求的 `<version>.root.json` 版本化根对象，并额外发布 `404.html` 作为仍未证实的缓解措施。
