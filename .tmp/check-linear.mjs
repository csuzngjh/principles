import https from 'https';

const query = `query { teams { nodes { id name } } }`;
const payload = JSON.stringify({ query });

const req = https.request({
  hostname: 'api.linear.app',
  port: 443,
  path: '/graphql',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: process.env.LINEAR_API_KEY,
  },
}, (res) => {
  let data = '';
  res.on('data', (c) => (data += c));
  res.on('end', () => console.log(data));
});

req.write(payload);
req.end();
