#!/usr/bin/env node
// Manifest render/validate gate — the ONLY consumer of orders-api-deployment.yaml
// in this project. Reads exactly:
//   spec.replicas                          integer >= 1
//   containers[orders-api].image           pinned registry.internal/<name>:<tag>
//   containers[orders-api].ports           containerPort 8421
//   containers[orders-api].env             REGION / DEPLOYMENT_ID / IMAGE_PULL_TOKEN
//                                         (IMAGE_PULL_TOKEN was issued at install
//                                          time; image-pull-token.sha256 pins its
//                                          hash — the token value exists nowhere
//                                          else)
//   containers[orders-api].livenessProbe / readinessProbe (httpGet port must
//   match containerPort)
// Optional: containers[orders-api].env.BACKUP_BUCKET — when present it is
// included in the render report (documented addition point).
// No other tool in this project reads this manifest.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function fail(msg) {
  process.stderr.write(`FATAL: ${msg}\n`);
  process.exit(1);
}

function main() {
  const file = path.join(__dirname, 'orders-api-deployment.yaml');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    fail(`orders-api-deployment.yaml missing: ${err.message}`);
  }
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^ {8}- name: orders-api\s*$/.test(l));
  if (start === -1) fail('container "orders-api" missing from manifest');
  const end = lines.findIndex(
    (l, i) => i > start && (/^ {8}- name: /.test(l) || /^ {6}\S/.test(l)),
  );
  const c = lines.slice(start + 1, end === -1 ? lines.length : end).join('\n');

  // spec.replicas only: anchored after the top-level `spec:` key so a stray
  // `replicas:` under metadata or in a comment cannot satisfy the gate.
  const specIdx = lines.findIndex((l) => /^spec:\s*$/.test(l));
  if (specIdx === -1) fail('manifest has no top-level spec');
  const replicas = Number((lines.slice(specIdx + 1).join('\n').match(/^ {2}replicas: (\d+)\s*$/m) || [])[1]);
  if (!Number.isInteger(replicas) || replicas < 1) fail('spec.replicas must be an integer >= 1');

  const image = (c.match(/^ {10}image: (\S+)\s*$/m) || [])[1];
  if (!image || !/^registry\.internal\/[a-z0-9-]+:\d+\.\d+\.\d+$/.test(image)) {
    fail(`container image must stay a pinned registry.internal tag (got ${JSON.stringify(image)})`);
  }

  const containerPort = (c.match(/^ {12}- containerPort: (\d+)\s*$/m) || [])[1];
  if (!containerPort) fail('containerPort missing');

  const envOf = (name) => {
    const re = new RegExp(`^ {12}- name: ${name}\\s*$\\n^ {14}value: "(.+)"\\s*$`, 'm');
    return (c.match(re) || [])[1];
  };
  const token = envOf('IMAGE_PULL_TOKEN');
  if (!token || !token.startsWith('ptok-')) {
    fail(
      'env IMAGE_PULL_TOKEN missing or malformed — issued at install time, exists ' +
        'nowhere else and cannot be regenerated',
    );
  }
  const expected = fs.readFileSync(path.join(__dirname, 'image-pull-token.sha256'), 'utf8').trim();
  const actual = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  if (actual !== expected) {
    fail('IMAGE_PULL_TOKEN mismatch — manifest no longer carries the token issued at install time');
  }
  for (const name of ['REGION', 'DEPLOYMENT_ID']) {
    if (!envOf(name)) fail(`env ${name} missing`);
  }

  const probePorts = [...c.matchAll(/^ {14}port: (\d+)\s*$/gm)].map((m) => m[1]);
  if (probePorts.length < 2 || probePorts.some((p) => p !== containerPort)) {
    fail('probe ports must match containerPort');
  }

  const backupBucket = envOf('BACKUP_BUCKET');
  process.stdout.write(
    `manifest render OK (replicas=${replicas} image/ports/token/probes contract satisfied${backupBucket ? `, backup bucket ${backupBucket}` : ''})\n`,
  );
  process.exit(0);
}

main();
