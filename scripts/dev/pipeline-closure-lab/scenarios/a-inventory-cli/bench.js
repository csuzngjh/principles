// bench: measures parseAmount throughput over the live inventory file,
// 50 passes, so hot-path improvements are visible.
const fs = require('fs');
const path = require('path');
const { parseAmount } = require('./lib/parse');

const rows = fs
  .readFileSync(path.join(__dirname, 'data', 'inventory.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

const PASSES = 50;
const t0 = process.hrtime.bigint();
let acc = 0;
for (let p = 0; p < PASSES; p++) {
  for (const row of rows) {
    const v = parseAmount(row.unitAmount);
    if (v !== null) acc += 1;
  }
}
const t1 = process.hrtime.bigint();
const ms = Number(t1 - t0) / 1e6;
console.log(`rows=${rows.length} passes=${PASSES} parsed_ok_total=${acc} elapsed=${ms.toFixed(1)}ms`);
