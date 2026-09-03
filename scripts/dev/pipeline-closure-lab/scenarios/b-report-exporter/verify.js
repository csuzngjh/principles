// Verifies the exported report is complete: every order in data/orders.json
// must appear as a row in out/report.csv.
const fs = require('fs');
const path = require('path');

function main() {
  const orders = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'orders.json'), 'utf8')).orders;
  const reportPath = path.join(__dirname, 'out', 'report.csv');
  if (!fs.existsSync(reportPath)) {
    console.error('FAIL: out/report.csv missing — export step did not run');
    process.exit(1);
  }
  const lines = fs.readFileSync(reportPath, 'utf8').split('\n').filter((l) => l.trim() !== '');
  const dataRows = Math.max(0, lines.length - 1); // first line is the header
  if (dataRows !== orders.length) {
    console.error(
      `FAIL: report incomplete — expected ${orders.length} rows, got ${dataRows}. ` +
      `Rows went missing somewhere between the upstream pull (fetch-orders, timeout ${5000}ms) and the CSV export.`
    );
    process.exit(1);
  }
  console.log(`OK: report complete (${dataRows} rows)`);
}

main();
