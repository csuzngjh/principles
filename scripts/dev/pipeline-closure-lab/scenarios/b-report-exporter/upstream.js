// Local mock of the orders upstream service.
// Real HTTP server; responds after ~300ms (simulating upstream latency).
const http = require('http');

const orders = Array.from({ length: 400 }, (_, i) => ({
  id: `ORD-${String(i + 1).padStart(5, '0')}`,
  amount: ((i * 37) % 977) / 10 + 1.5,
  currency: 'CNY',
  status: i % 7 === 3 ? 'refunded' : 'settled',
}));

const server = http.createServer((req, res) => {
  setTimeout(() => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ orders }));
  }, 300);
});

server.listen(18311, '127.0.0.1', () => {
  console.log('upstream listening on 127.0.0.1:18311');
});
