---
"create-principles-disciple": patch
---

chore(deps): bump react 19.3.0 -> 19.3.1（#2163；@principles/pd-console 运行时 dependency，打进 console bundle 随 installer 工件分发）。同时把 lock 里 react-dom 一并解析到 19.3.1 并删掉 Dependabot 留下的 `packages/pd-console/node_modules/react` 嵌套副本——否则工作区里会同时存在两份 React（app 用 19.3.1、react-dom 的 peer 用 19.3.0），Console 会以 `Cannot read properties of null (reading 'useMemo')` 白屏。
