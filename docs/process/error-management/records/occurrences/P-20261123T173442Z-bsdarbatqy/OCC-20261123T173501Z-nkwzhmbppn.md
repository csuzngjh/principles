<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "occurrence",
  "occurrenceId": "OCC-20261123T173501Z-nkwzhmbppn",
  "patternRecordId": "P-20261123T173442Z-bsdarbatqy",
  "displayId": "ERR-210",
  "originPattern": "EP-12",
  "observedAt": "2026-11-23",
  "source": "adhoc / PR #2779（Owner 现场报告）",
  "invariant": "A process that may run without a console (detached child, GUI parent, or a long-lived server they start) starts every child process with windowsHide: true",
  "severity": "P2",
  "escaped": "production",
  "caughtBy": "owner",
  "guard": "child-process-windows-hide.test.ts in create-principles-disciple, pd-cli, openclaw-plugin, pd-console and pd-companion (scripts/lib/child-process-window-scan.mjs, fail-closed AST scan; red on the pre-fix sources: 30/8/6/7/2 findings)"
}
-->

2026-11-23，Owner 报告用 PD Companion 更新时桌面跳出一串 cmd 窗口。根因是 Console 以 `detached` 拉起的更新执行器没有控制台，它调用的安装器代码里有 29 处起子进程的调用没带 `windowsHide: true`；安装器收尾自动拉起的 Console 服务进程同样没隐藏，它的窗口一直留着。同类未隐藏调用另见于 `pd console open`（6 处，含命名空间写法的旧 Console 探测）、Companion（2 处，GUI 进程）、OpenClaw 插件工具探测（6 处）和一个已无生产引用的 Console 模块（3 处）。缺陷在终端里手工运行时不出现，所以从未被本机验证或 CI 发现。修复随 PR #2779：全部调用补上选项，Console 服务进程启动时隐藏控制台（后代继承），并新增 fail-closed 的源码守卫放进五个包的测试套件；真实产物按安装器收尾形态启动的端到端实测确认服务进程不再带窗口。
