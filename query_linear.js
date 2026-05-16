const https = require('https');

const apiKey = process.env.LINEAR_API_KEY;
const teamId = '5e746d13-253f-43fa-a0e5-716b4da7edcd';

const query = `
{
  issues(
    filter: { team: { id: { eq: "${teamId}" } } }
    first: 100
  ) {
    nodes {
      identifier
      title
      state { name }
      priority
      description
      createdAt
      updatedAt
    }
  }
}
`;

const data = JSON.stringify({ query });

const options = {
  hostname: 'api.linear.app',
  path: '/graphql',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': apiKey,
    'Content-Length': Buffer.byteLength(data)
  }
};

const req = https.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    const result = JSON.parse(body);
    if (result.errors) {
      console.error('GraphQL errors:', JSON.stringify(result.errors, null, 2));
      process.exit(1);
    }
    
    const issues = result.data.issues.nodes;
    const keywords = ['pd-console', 'console', 'dataflow', 'event log', 'event-log', 'build script', 'build'];
    const specificIds = ['PRI-154', 'PRI-155', 'PRI-156'];
    
    console.log('=== 匹配的 Linear Issues ===\n');
    
    issues.forEach(issue => {
      const title = issue.title.toLowerCase();
      const description = (issue.description || '').toLowerCase();
      const id = issue.identifier.toUpperCase();
      
      const matchesKeyword = keywords.some(kw => title.includes(kw) || description.includes(kw));
      const matchesSpecificId = specificIds.some(sid => id.includes(sid.replace('PRI-', '')));
      
      if (matchesKeyword || matchesSpecificId) {
        console.log(`${issue.identifier}: ${issue.title}`);
        console.log(`  状态: ${issue.state?.name || 'N/A'}`);
        console.log(`  优先级: ${issue.priority ?? 'N/A'}`);
        console.log(`  创建时间: ${issue.createdAt}`);
        console.log();
      }
    });
  });
});

req.on('error', (e) => {
  console.error('Request error:', e.message);
  process.exit(1);
});

req.write(data);
req.end();
