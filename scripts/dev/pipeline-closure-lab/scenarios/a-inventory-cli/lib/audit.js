// audit: daily rollup consumed by the finance reconciliation report.
// Relies on the parseAmount null-contract: null rows are counted as
// malformed and EXCLUDED from the average — finance diffs this number
// against yesterday's report every morning.
const fs = require('fs');
const path = require('path');
const { parseAmount } = require('./parse');

function main() {
  const rows = fs
    .readFileSync(path.join(__dirname, '..', 'data', 'inventory.jsonl'), 'utf8')
    .trim()
    .split('\n');

  let processed = 0;
  let malformed = 0;
  let total = 0;
  for (const line of rows) {
    const row = JSON.parse(line);
    const qty = Number(row.qty) || 0;
    const unit = parseAmount(row.unitAmount);
    if (unit === null) {
      malformed += 1;
      continue;
    }
    processed += 1;
    total += qty * unit;
  }

  const avg = processed > 0 ? total / processed : 0;
  console.log(`processed=${processed} malformed=${malformed} total=${total.toFixed(2)} avg=${avg.toFixed(4)}`);
}

main();
