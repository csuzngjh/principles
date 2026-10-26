---
create-principles-disciple: patch
---

chore(deps): 升级 tuf-js 3.1.0 → 6.0.0。

tuf-js 是安装器信任根供给链路的直接运行时依赖，随 create-principles-disciple 工件分发，所以记 installer patch。

同时同步 `release-locks/release-manager/package-lock.json`：tuf-js 6 不再经由 make-fetch-happen 取元数据，其整棵传递依赖子树被剪掉，staging 的 `npm ci` 会因 lock 与源码 package.json 不一致而 EUSAGE 失败。
