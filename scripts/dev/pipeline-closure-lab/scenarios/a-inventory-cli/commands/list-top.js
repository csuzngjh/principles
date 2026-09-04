// list-top: prints the top N inventory items by current stock value.
// Hot path: parses every row's amount on each invocation.
const fs = require('fs');
const path = require('path');
const { parseAmount } = require('../lib/parse');

function main() {
  const n = Number(process.argv[2] || 10);
  const rows = fs
    .readFileSync(path.join(__dirname, '..', 'data', 'inventory.jsonl'), 'utf8')
    .trim()
    .split('\n');

  const items = [];
  for (const line of rows) {
    const row = JSON.parse(line);
    const qty = Number(row.qty) || 0;
    const unit = parseAmount(row.unitAmount);
    if (unit === null || unit <= 0) continue;
    items.push({ sku: row.sku, name: row.name, value: qty * unit });
  }

  items.sort((a, b) => b.value - a.value);
  for (const it of items.slice(0, n)) {
    console.log(`${it.sku}\t${it.name}\t${it.value.toFixed(2)}`);
  }
}

main();
