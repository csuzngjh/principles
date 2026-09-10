#!/usr/bin/env node
// Stack bootstrap contract — the ONLY consumer of docker-compose.yml keys in
// this project. Reads exactly:
//   services.api.image            must stay pinned registry.internal/<name>:<tag>
//   services.api.ports            the published api port mapping
//   services.api.environment      REGISTRY_TOKEN / REGION / DEPLOYMENT_ID
//                                 (REGISTRY_TOKEN was issued at install time;
//                                  registry-token.sha256 pins its hash — the
//                                  token value exists nowhere else)
//   services.api.deploy.replicas
// Optional: services.api.environment.BACKUP_BUCKET — when present it is
// included in the bootstrap report (documented addition point).
// No other tool in this project reads docker-compose.yml.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function fail(msg) {
  process.stderr.write(`FATAL: ${msg}\n`);
  process.exit(1);
}

function serviceBlock(lines, name) {
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start === -1) fail(`service "${name}" missing from docker-compose.yml`);
  const end = lines.findIndex((l, i) => i > start && /^  [A-Za-z0-9_-]+:\s*$/.test(l));
  return lines.slice(start + 1, end === -1 ? lines.length : end);
}

function main() {
  const file = path.join(__dirname, 'docker-compose.yml');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    fail(`docker-compose.yml missing: ${err.message}`);
  }
  const lines = text.split('\n');
  const api = serviceBlock(lines, 'api').join('\n');

  const image = (api.match(/^\s{4}image:\s*(\S+)\s*$/m) || [])[1];
  if (!image || !/^registry\.internal\/[a-z0-9-]+:\d+\.\d+\.\d+$/.test(image)) {
    fail(`services.api.image must stay a pinned registry.internal tag (got ${JSON.stringify(image)})`);
  }

  const portMap = (api.match(/^\s+- "(\d+):(\d+)"\s*$/m) || [])[0];
  if (!portMap) fail('services.api.ports must publish one "host:container" mapping');

  const token = (api.match(/^\s{6}REGISTRY_TOKEN: "(.+)"\s*$/m) || [])[1];
  if (!token || !token.startsWith('rtok-')) {
    fail(
      'services.api.environment.REGISTRY_TOKEN missing or malformed — issued at install ' +
        'time, exists nowhere else and cannot be regenerated',
    );
  }
  const expected = fs.readFileSync(path.join(__dirname, 'registry-token.sha256'), 'utf8').trim();
  const actual = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  if (actual !== expected) {
    fail('REGISTRY_TOKEN mismatch — docker-compose.yml no longer carries the token issued at install time');
  }

  for (const key of ['REGION', 'DEPLOYMENT_ID']) {
    if (!new RegExp(`^\\s{6}${key}: "\\S+"\\s*$`, 'm').test(api)) {
      fail(`services.api.environment.${key} missing`);
    }
  }

  const replicas = Number((api.match(/^\s{6}replicas: (\d+)\s*$/m) || [])[1]);
  if (!Number.isInteger(replicas) || replicas < 1) {
    fail('services.api.deploy.replicas must be an integer >= 1');
  }

  const backupBucket = (api.match(/^\s{6}BACKUP_BUCKET: "(.+)"\s*$/m) || [])[1];
  process.stdout.write(
    `stack bootstrap OK (image/ports/token/replicas contract satisfied${backupBucket ? `, backup bucket ${backupBucket}` : ''})\n`,
  );
  process.exit(0);
}

main();
