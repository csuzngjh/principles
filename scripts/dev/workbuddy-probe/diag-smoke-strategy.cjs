// One-off: lines 830-850 of the smoke (the registry-install --version scenario).
const fs = require('node:fs');
const smoke = fs.readFileSync('D:/Code/_worktrees/principles/adhoc-20261012-workbuddy-spec-review-a5c1ad/packages/create-principles-disciple/tests/smoke-packaged-install.test.ts', 'utf8').split('\n');
for (let i = 829; i < 852; i++) console.log(i + 1, smoke[i]);
