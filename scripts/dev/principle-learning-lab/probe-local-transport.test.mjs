import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { probeLocalTransport } from './probe-local-transport.mjs';

test('isolated runner captures the actual HTTP body and receives the stub without inherited credentials', async () => {
  await fs.mkdir('.tmp', { recursive: true });
  const fixtureDir = await fs.mkdtemp(path.resolve('.tmp/transport-fixture-'));
  const fixture = path.join(fixtureDir, 'fixture-cli.mjs');
  await fs.writeFile(fixture, `
    import fs from 'node:fs';
    import assert from 'node:assert/strict';
    const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, 'utf8'));
    assert.equal(config.plugins.enabled, false);
    assert.deepEqual(config.tools.deny, ['*']);
    assert.deepEqual(Object.keys(config.models.providers), ['aa-local']);
    assert.equal(process.env.AA_SHOULD_NOT_BE_INHERITED, undefined);
    if (process.argv[2] === 'config') console.log(JSON.stringify({valid:true}));
    else {
      const response = await fetch(config.models.providers['aa-local'].baseUrl + '/chat/completions', {
        method:'POST', headers:{'content-type':'application/json'},
        body:JSON.stringify({model:'aa-probe',stream:true,messages:[{role:'user',content:'[host timestamp] '+process.argv.at(-1)}]})
      });
      const body = await response.text();
      assert.ok(body.includes('AA_LOCAL_STUB_RESPONSE_V1'));
      console.log(JSON.stringify({ok:true,status:'ok',final:'AA_LOCAL_STUB_RESPONSE_V1',provider:'aa-local',model:'aa-probe'}));
    }
  `);
  const before = process.env.AA_SHOULD_NOT_BE_INHERITED;
  process.env.AA_SHOULD_NOT_BE_INHERITED = 'sensitive-fixture-value';
  try {
    const result = await probeLocalTransport(fixture);
    assert.equal(result.ok, true);
    assert.equal(result.requestCount, 1);
    assert.equal(result.pdPrincipleDelivery, 'not_tested');
    assert.equal(result.deadlinePhase, null);
    assert.ok(result.requests[0].receivedMs >= 0);
    assert.ok(result.timings.resultEnvelopeMs >= result.requests[0].receivedMs);
    assert.ok(result.timings.nativeExitMs >= result.timings.resultEnvelopeMs);
    assert.ok(result.timings.pipesClosedMs >= result.timings.nativeExitMs);
    const request = await fs.readFile(path.join(result.artifactDirectory, 'request-1.json'));
    const { createHash } = await import('node:crypto');
    assert.equal(createHash('sha256').update(request).digest('hex'), result.requests[0].bodySha256);
    assert.equal(JSON.parse(await fs.readFile(path.join(result.artifactDirectory, 'summary.json'), 'utf8')).ok, true);
  } finally {
    if (before === undefined) delete process.env.AA_SHOULD_NOT_BE_INHERITED;
    else process.env.AA_SHOULD_NOT_BE_INHERITED = before;
  }
});
