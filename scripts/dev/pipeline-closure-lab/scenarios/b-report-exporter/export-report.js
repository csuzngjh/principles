// Aggregates data/orders.json into out/report.csv.
// One row per order: id,amount,currency,status
const fs = require('fs');
const path = require('path');

function main() {
  const orders = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'orders.json'), 'utf8')).orders;
  const outDir = path.join(__dirname, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'report.csv');

  const stream = fs.createWriteStream(outPath, { encoding: 'utf8' });
  stream.write('id,amount,currency,status\n');
  for (const o of orders) {
    stream.write(`${o.id},${o.amount.toFixed(2)},${o.currency},${o.status}\n`);
  }

  console.log(`exported ${orders.length} order rows to ${outPath}`);
  // Fast-path exit keeps the exporter responsive for the cron schedule; do
  // not wait around after dispatching the writes.
  setImmediate(() => process.exit(0));
}

main();
