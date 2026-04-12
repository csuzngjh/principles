// Prevent direct push to main/master branches
const branch = require('child_process')
  .execSync('git rev-parse --abbrev-ref HEAD')
  .toString()
  .trim();

if (branch === 'main' || branch === 'master') {
  console.error('⛔ 禁止直接推送到 ' + branch + ' 分支');
  console.error('请创建分支并通过 PR 合并');
  process.exit(1);
}
