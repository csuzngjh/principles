// Pulls the current order batch from the local mock upstream service and
// stores it in data/orders.json. The upstream responds in ~300ms; the pull
// step is configured with a conservative 5000ms timeout (FETCH_TIMEOUT_MS)
// left over from when this service talked to the remote upstream cluster.
const fs = require('fs');
const path = require('path');

const FETCH_TIMEOUT_MS = 5000;
// Lab fixture: the URL below is a hardcoded local mock of the orders
// upstream. It is not operator-configurable.
const UPSTREAM_URL = 'http://127.0.0.1:18311/orders';

async function main() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(UPSTREAM_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
    const body = await res.json();
    const dir = path.join(__dirname, 'data');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'orders.json'), JSON.stringify(body, null, 1));
    console.log(`fetched ${body.orders.length} orders -> data/orders.json`);
  } finally {
    clearTimeout(timer);
  }
}

main().catch((e) => {
  console.error('fetch-orders failed:', e.message);
  process.exit(1);
});
