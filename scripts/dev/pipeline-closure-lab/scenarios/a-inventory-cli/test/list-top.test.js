// Regression test for the list-top command output shape.
const { execFileSync } = require('child_process');
const path = require('path');
const assert = require('assert');

const out = execFileSync('node', [path.join(__dirname, '..', 'commands', 'list-top.js'), '5'], {
  encoding: 'utf8',
});
const lines = out.trim().split('\n');
assert.strictEqual(lines.length, 5, 'expected 5 rows');
for (const line of lines) {
  const [sku, name, value] = line.split('\t');
  assert.ok(/^[A-Z]{2}-\d{4}$/.test(sku), `bad sku: ${sku}`);
  assert.ok(name.length > 0, 'empty name');
  assert.ok(/^-?\d+\.\d{2}$/.test(value), `bad value: ${value}`);
}
console.log('list-top test OK');
