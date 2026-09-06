/**
 * BDD step definitions for the commercial update system feature.
 *
 * Steps drive the REAL modules from create-principles-disciple/src/update/
 * (ReleaseManager, advancement policy, transaction journal + recovery, host
 * coordination policy, legacy migration, canonical version report via
 * pd-cli's service, history classification). The gherkin runner is pd-cli's
 * committed vitest-bdd support; fixtures build an isolated temp HOME with a
 * signed local TUF repository. No mocked-out behavior under test.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { afterAll, expect } from 'vitest';
import { Key, MetaFile, Metadata, Root, Signature, Snapshot, TargetFile, Targets, Timestamp } from '@tufjs/models';
import { createStepRegistry, defineFeature } from '../../../pd-cli/tests/bdd/support/vitest-bdd.js';
import { resolveFeaturePath } from '../../../pd-cli/tests/bdd/support/repo-root.js';

import { ReleaseManager, ReleaseManagerError, type LegacyUpdaterDecision } from '../../src/update/release-manager.js';
import { evaluateReleaseAdvancement, type ReleasePolicyDecision } from '../../src/update/release-policy.js';
import {
  appendJournalTransition,
  readActiveRecord,
  readTransactionJournal,
  recoverUnfinishedTransaction,
  writeActiveRecord,
  type ActiveRecord,
  type JournalTransition,
} from '../../src/update/transaction-journal.js';
import { decideHostCoordination, type HostObservation } from '../../src/update/rollback-policy.js';
import { migrateLegacyOverlay } from '../../src/update/legacy-migration.js';
import { classifyDirection, readHistoryEvents } from '../../src/update/update-history.js';
import { ensurePdHomeLayout, resolvePdHomePaths } from '../../src/update/install-layout.js';
import { buildReleaseMetadata, type ReleaseMetadata } from '../../src/update/release-metadata.js';
import { buildVersionReport, formatShortVersion } from '../../../pd-cli/src/services/version-report.js';

const expiresFar = '2030-01-01T00:00:00Z';

interface Fixture {
  home: string;
  paths: ReturnType<typeof resolvePdHomePaths>;
  repositoryUrl: string;
  candidate: ReleaseMetadata;
}

const openServers: http.Server[] = [];
const temporaryHomes: string[] = [];

// All derived paths must stay inside the scenario's temp HOME.
function withinHome(home: string, candidate: string): string {
  const resolved = path.resolve(candidate);
  const root = path.resolve(home);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`fixture path escaped the temp home: ${resolved}`);
  }
  return resolved;
}

function makeSigner(): { keyId: string; privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']; key: Key } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyId = `bdd-key-${createHash('sha256').update(publicKey.export({ type: 'spki', format: 'pem' })).digest('hex').slice(0, 10)}`;
  return {
    keyId,
    privateKey,
    key: new Key({ keyID: keyId, keyType: 'ed25519', scheme: 'ed25519', keyVal: { public: publicKey.export({ format: 'pem', type: 'spki' }).toString() } }),
  };
}

function signed<T extends Root | Snapshot | Targets | Timestamp>(doc: T, signer: ReturnType<typeof makeSigner>): Buffer {
  const metadata = new Metadata(doc);
  metadata.sign((data) => new Signature({ keyID: signer.keyId, sig: cryptoSign(null, data, signer.privateKey).toString('hex') }), false);
  return Buffer.from(JSON.stringify(metadata.toJSON()));
}

function buildRelease(productVersion: string, sequence: number): ReleaseMetadata {
  return buildReleaseMetadata({
    productVersion,
    sourceCommit: '1234567890abcdef1234567890abcdef12345678',
    minBootstrapVersion: '1.0.0',
    publicationSequence: sequence,
    expiresAt: expiresFar,
    assets: [{ platform: 'win32', arch: 'x64', nodeAbi: '147', archiveSha256: 'a'.repeat(64), archiveSizeBytes: 1024 }],
    dataSchemaForwardReadableFrom: '1.220.0',
  });
}

async function createFixture(ctx: { state: Record<string, unknown> }): Promise<Fixture> {
  const signer = makeSigner();
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-bdd-home-'));
  temporaryHomes.push(home);
  const pdHome = withinHome(home, path.join(home, '.pd'));
  const paths = resolvePdHomePaths(pdHome);
  ensurePdHomeLayout(paths);
  fs.writeFileSync(withinHome(home, paths.bootstrapManifestPath), JSON.stringify({ bootstrapVersion: '1.0.0', installedAt: '2026-08-25T00:00:00Z' }));

  const candidate = buildRelease('1.223.0', 9);
  const active = buildRelease('1.222.0', 8);
  for (const release of [candidate, active]) {
    const dir = withinHome(home, path.join(paths.releasesDir, release.releaseId));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(withinHome(home, path.join(dir, 'metadata.json')), JSON.stringify(release, null, 2));
  }
  writeActiveRecord(withinHome(home, paths.activeRecordPath), {
    generation: 2,
    releaseId: active.releaseId,
    releaseMetadataDigest: active.metadataDigest,
    previousReleaseId: null,
    transactionId: 'bdd-prev',
    productVersion: active.productVersion,
  });
  fs.copyFileSync(withinHome(home, paths.activeRecordPath), withinHome(home, paths.previousRecordPath));

  const channelPayload = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    channel: 'stable',
    version: 4,
    expiresAt: expiresFar,
    releaseMetadataDigest: candidate.metadataDigest,
    releaseId: candidate.releaseId,
    productVersion: candidate.productVersion,
    publicationSequence: candidate.publicationSequence,
  }, null, 2));
  const targetPath = 'channels/stable.json';
  const targets = new Targets({
    version: 1, specVersion: '1.0.31', expires: expiresFar,
    targets: {
      [targetPath]: new TargetFile({
        path: targetPath,
        length: channelPayload.length,
        hashes: { sha256: createHash('sha256').update(channelPayload).digest('hex') },
        unrecognizedFields: { custom: { releaseId: candidate.releaseId, channel: 'stable', platform: 'metadata' } },
      }),
    },
  });
  const root = new Root({ version: 1, specVersion: '1.0.31', expires: expiresFar, consistentSnapshot: false });
  for (const role of ['root', 'timestamp', 'snapshot', 'targets']) root.addKey(signer.key, role);
  const served = new Map<string, Buffer>([
    ['root.json', signed(root, signer)],
    ['timestamp.json', signed(new Timestamp({ version: 1, specVersion: '1.0.31', expires: expiresFar, snapshotMeta: new MetaFile({ version: 1 }) }), signer)],
    ['snapshot.json', signed(new Snapshot({ version: 1, specVersion: '1.0.31', expires: expiresFar, meta: { 'targets.json': new MetaFile({ version: 1 }) } }), signer)],
    ['targets.json', signed(targets, signer)],
    [`targets/${targetPath}`, channelPayload],
  ]);
  fs.writeFileSync(withinHome(home, path.join(paths.trustDir, 'root.json')), served.get('root.json') as Buffer);

  const server = http.createServer((request, response) => {
    const data = served.get(request.url?.replace(/^\//, '') ?? '');
    if (!data) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200).end(data);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  openServers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('BDD fixture repository failed to bind');
  }
  const fixture: Fixture = {
    home,
    paths,
    repositoryUrl: `http://127.0.0.1:${address.port}`,
    candidate,
  };
  ctx.state['fixture'] = fixture;
  return fixture;
}

function fixtureOf(ctx: { state: Record<string, unknown> }): Fixture {
  const fixture = ctx.state['fixture'];
  if (fixture === undefined) {
    throw new Error('fixture not initialized — Background step must run first');
  }
  return fixture as Fixture;
}

const registry = createStepRegistry();

registry.given(/一个隔离的临时 HOME 作为安装根/, async (ctx) => {
  await createFixture(ctx);
});

registry.given(/一个带 bootstrap 与双槽安装状态的 ~\/\.pd 布局/, (ctx) => {
  const fixture = fixtureOf(ctx);
  expect(fs.existsSync(fixture.paths.bootstrapManifestPath)).toBe(true);
  expect(readActiveRecord(fixture.paths.activeRecordPath)?.generation).toBe(2);
});

registry.when(/对 stable 渠道执行 ReleaseManager\.check/, async (ctx) => {
  const fixture = fixtureOf(ctx);
  const legacy: LegacyUpdaterDecision = { source: 'legacy-updater', latestVersion: '1.223.0', updateAvailable: true };
  const manager = new ReleaseManager({
    pdHome: fixture.paths.home,
    metadataBaseUrl: fixture.repositoryUrl,
    legacyCheck: async () => legacy,
  });
  ctx.state['check'] = await manager.check('stable');
});

registry.then(/返回候选发布的 canonical productVersion 与 publicationSequence/, (ctx) => {
  const check = ctx.state['check'] as { candidate: { productVersion: string; publicationSequence: number } };
  expect(check.candidate).toMatchObject({ productVersion: '1.223.0', publicationSequence: 9 });
});

registry.then(/决策为 allowed 且 direction 为 update/, (ctx) => {
  const check = ctx.state['check'] as { decision: ReleasePolicyDecision };
  expect(check.decision).toEqual({ allowed: true, direction: 'update' });
});

// PRI-698 Phase 1 contract change (Owner-directed, see PR): apply() no longer
// refuses with `shadow_mode_read_only` — it is the real orchestrator. On a
// repository that publishes metadata but no ARTIFACT target for the release,
// the refusal contract under test is: refuse at acquisition with a stable
// reason + Owner-facing next action, and close the opened transaction at a
// terminal `failed` state (rc-9 / rc-7; a strict journal reader must never
// see a mid-chain tail).
registry.when(/执行 ReleaseManager\.apply 而仓库未发布工件/, async (ctx) => {
  const fixture = fixtureOf(ctx);
  const manager = new ReleaseManager({ pdHome: fixture.paths.home, metadataBaseUrl: fixture.repositoryUrl });
  try {
    await manager.apply({ workspaceDir: fixture.paths.home });
    throw new Error('apply unexpectedly succeeded');
  } catch (error) {
    ctx.state['applyError'] = error;
  }
});

registry.then(/拒绝原因为 metadata_refresh_failed/, (ctx) => {
  const error = ctx.state['applyError'] as ReleaseManagerError;
  expect(error).toBeInstanceOf(ReleaseManagerError);
  expect(error.reason).toBe('metadata_refresh_failed');
});

registry.then(/拒绝信息包含面向 Owner 的 nextAction/, (ctx) => {
  const error = ctx.state['applyError'] as ReleaseManagerError;
  expect(error.nextAction.length).toBeGreaterThan(10);
});

registry.then(/打开的更新事务以终态 failed 关闭/, (ctx) => {
  const fixture = fixtureOf(ctx);
  const transactionsDir = fixture.paths.transactionsDir;
  const journalFiles = fs.readdirSync(transactionsDir).filter((name) => name.startsWith('update-'));
  expect(journalFiles).toHaveLength(1);
  const transitions = readTransactionJournal(path.join(transactionsDir, journalFiles[0]));
  expect(transitions[transitions.length - 1].to).toBe('failed');
});

registry.when(/前进策略评估同一 releaseId 的候选/, (ctx) => {
  const fixture = fixtureOf(ctx);
  const active = readActiveRecord(fixture.paths.activeRecordPath) as ActiveRecord;
  const candidate = buildRelease(active.productVersion, 8);
  ctx.state['policy'] = evaluateReleaseAdvancement({
    channel: {
      schemaVersion: 1, channel: 'stable', version: 4, expiresAt: expiresFar,
      releaseMetadataDigest: candidate.metadataDigest, releaseId: candidate.releaseId,
      productVersion: candidate.productVersion, publicationSequence: 8,
    },
    candidate,
    current: {
      productVersion: active.productVersion,
      releaseId: active.releaseId,
      publicationSequence: 8,
      bootstrapVersion: '1.0.0',
      previouslyConfirmedReleaseIds: [active.releaseId],
    },
    bootstrapVersion: '1.0.0',
  });
});

registry.when(/前进策略评估 publicationSequence 更小的候选/, (ctx) => {
  const candidate = buildRelease('1.221.0', 7);
  ctx.state['policy'] = evaluateReleaseAdvancement({
    channel: {
      schemaVersion: 1, channel: 'stable', version: 4, expiresAt: expiresFar,
      releaseMetadataDigest: candidate.metadataDigest, releaseId: candidate.releaseId,
      productVersion: candidate.productVersion, publicationSequence: 7,
    },
    candidate,
    current: {
      productVersion: '1.222.0', releaseId: 'c'.repeat(64), publicationSequence: 8,
      bootstrapVersion: '1.0.0', previouslyConfirmedReleaseIds: [],
    },
    bootstrapVersion: '1.0.0',
  });
});

registry.then(/决策为 allowed 且 direction 为 reinstall/, (ctx) => {
  expect(ctx.state['policy']).toEqual({ allowed: true, direction: 'reinstall' });
});

registry.then(/决策被拒绝且原因为 downgrade_blocked/, (ctx) => {
  expect(ctx.state['policy']).toMatchObject({ allowed: false, reason: 'downgrade_blocked' });
});

registry.then(/拒绝信息包含显式 downgrade 下一步说明/, (ctx) => {
  const policy = ctx.state['policy'] as { allowed: false; nextAction: string };
  expect(policy.nextAction).toMatch(/[Dd]owngrade/);
});

const crashTransitions = (fixture: Fixture, transactionId: string, generation: number): JournalTransition[] => ([
  { at: '2026-08-25T00:00:00Z', from: null, to: 'planned', transactionId, releaseId: fixture.candidate.releaseId, productVersion: '1.223.0', releaseMetadataDigest: fixture.candidate.metadataDigest, generation },
  { at: '2026-08-25T00:00:05Z', from: 'planned', to: 'activated', transactionId, releaseId: fixture.candidate.releaseId, productVersion: '1.223.0', releaseMetadataDigest: fixture.candidate.metadataDigest, generation },
]);

registry.when(/事务 journal 记录到 activated 但 active\.json 未落到新 generation/, (ctx) => {
  const fixture = fixtureOf(ctx);
  const journalPath = withinHome(fixture.home, path.join(fixture.paths.transactionsDir, 'bdd-crash.jsonl'));
  const transitions = crashTransitions(fixture, 'bdd-crash', 3);
  for (const item of transitions) {
    appendJournalTransition(journalPath, item);
  }
  const active = readActiveRecord(fixture.paths.activeRecordPath) as ActiveRecord;
  const previous = readActiveRecord(fixture.paths.previousRecordPath) as ActiveRecord;
  ctx.state['recovery'] = recoverUnfinishedTransaction({
    transitions,
    activeRecord: active,
    previousRecord: previous,
    transactionId: 'bdd-crash',
  });
});

registry.when(/事务 journal 记录到 activated 且没有任何先前 active 记录/, (ctx) => {
  const fixture = fixtureOf(ctx);
  ctx.state['recovery'] = recoverUnfinishedTransaction({
    transitions: crashTransitions(fixture, 'bdd-first', 1),
    activeRecord: null,
    previousRecord: null,
    transactionId: 'bdd-first',
  });
});

registry.then(/恢复结果为 old_confirmed/, (ctx) => {
  expect(ctx.state['recovery']).toMatchObject({ kind: 'old_confirmed' });
});

registry.then(/恢复原因说明回退到先前确认的 generation/, (ctx) => {
  const recovery = ctx.state['recovery'] as { kind: string; reason: string };
  expect(recovery.reason).toMatch(/previous|先前|confirmed/i);
});

registry.then(/恢复结果为 explicit_refusal/, (ctx) => {
  expect(ctx.state['recovery']).toMatchObject({ kind: 'explicit_refusal' });
});

registry.then(/nextAction 要求运行官方安装器/, (ctx) => {
  const recovery = ctx.state['recovery'] as { nextAction: string };
  expect(recovery.nextAction).toMatch(/official installer/i);
});

function hostObservation(failureClass: string): HostObservation[] {
  return [{
    hostId: 'pd-console',
    wasRunningBeforeActivation: true,
    outcome: { kind: 'failed', failureClass, detail: 'bdd fixture failure' },
  }];
}

registry.when(/一个先前运行中的 host 出现 handshake_mismatch/, (ctx) => {
  ctx.state['coordination'] = decideHostCoordination({ observations: hostObservation('handshake_mismatch'), autoRollbackAlreadyUsed: false });
});

registry.when(/已用过一次自动回滚后再次出现确定性失败/, (ctx) => {
  ctx.state['coordination'] = decideHostCoordination({ observations: hostObservation('deterministic_start_failure'), autoRollbackAlreadyUsed: true });
});

registry.when(/一个先前运行中的 host 出现 network_unavailable/, (ctx) => {
  ctx.state['coordination'] = decideHostCoordination({ observations: hostObservation('network_unavailable'), autoRollbackAlreadyUsed: false });
});

registry.then(/协调决策为 auto_rollback/, (ctx) => {
  expect(ctx.state['coordination']).toMatchObject({ action: 'auto_rollback' });
});

registry.then(/协调决策为 circuit_breaker_open/, (ctx) => {
  expect(ctx.state['coordination']).toMatchObject({ action: 'circuit_breaker_open' });
});

registry.then(/nextAction 说明保留最后确认版本并要求显式 Owner 操作/, (ctx) => {
  const coordination = ctx.state['coordination'] as { nextAction: string };
  expect(coordination.nextAction).toMatch(/last confirmed release remains active/i);
});

registry.then(/协调决策为 retry_handshake 而非回滚/, (ctx) => {
  expect(ctx.state['coordination']).toMatchObject({ action: 'retry_handshake' });
});

registry.when(/由官方安装器对存在的 overlay 执行迁移/, (ctx) => {
  const fixture = fixtureOf(ctx);
  const overlayPlugin = withinHome(fixture.home, path.join(fixture.home, '.openclaw', 'extensions', 'principles-disciple', 'plugin'));
  fs.mkdirSync(overlayPlugin, { recursive: true });
  fs.writeFileSync(withinHome(fixture.home, path.join(overlayPlugin, 'package.json')), JSON.stringify({ version: '1.218.0' }));
  ctx.state['overlayBefore'] = fs.readFileSync(path.join(overlayPlugin, 'package.json'), 'utf8');
  ctx.state['migration'] = migrateLegacyOverlay({
    homeDir: path.join(fixture.home, 'fresh-home'),
    openclawHome: path.join(fixture.home, '.openclaw'),
    invokedByOfficialInstaller: true,
    dryRun: false,
    bootstrapVersion: '1.0.0',
    transactionId: 'bdd-migration',
  });
});

registry.when(/非官方安装器调用方对 overlay 执行迁移/, (ctx) => {
  const fixture = fixtureOf(ctx);
  const overlayPlugin = withinHome(fixture.home, path.join(fixture.home, '.openclaw', 'extensions', 'principles-disciple', 'plugin'));
  fs.mkdirSync(overlayPlugin, { recursive: true });
  fs.writeFileSync(withinHome(fixture.home, path.join(overlayPlugin, 'package.json')), JSON.stringify({ version: '1.218.0' }));
  ctx.state['migration'] = migrateLegacyOverlay({
    homeDir: path.join(fixture.home, 'scope-home'),
    openclawHome: path.join(fixture.home, '.openclaw'),
    invokedByOfficialInstaller: false,
    dryRun: false,
    bootstrapVersion: '1.0.0',
    transactionId: 'bdd-scope',
  });
});

registry.then(/迁移成功且 active\.json 记录 generation 1/, (ctx) => {
  const migration = ctx.state['migration'] as { migrated: boolean; pdHome: string };
  expect(migration.migrated).toBe(true);
  expect(readActiveRecord(path.join(migration.pdHome, 'active.json'))?.generation).toBe(1);
});

registry.then(/overlay 目录保持只读原样/, (ctx) => {
  const fixture = fixtureOf(ctx);
  const overlayPlugin = withinHome(fixture.home, path.join(fixture.home, '.openclaw', 'extensions', 'principles-disciple', 'plugin'));
  expect(fs.readFileSync(path.join(overlayPlugin, 'package.json'), 'utf8')).toBe(ctx.state['overlayBefore']);
});

registry.then(/历史记录追加 legacy_migration 事件/, (ctx) => {
  const migration = ctx.state['migration'] as { historyEventPath: string };
  const events = readHistoryEvents(migration.historyEventPath);
  expect(events[events.length - 1]).toMatchObject({ kind: 'legacy_migration', outcome: 'succeeded' });
});

registry.then(/迁移被拒绝且原因为 bootstrap_write_out_of_scope/, (ctx) => {
  expect(ctx.state['migration']).toMatchObject({ migrated: false, reason: 'bootstrap_write_out_of_scope' });
});

registry.then(/磁盘上不产生任何 ~\/\.pd 写入/, (ctx) => {
  const fixture = fixtureOf(ctx);
  expect(fs.existsSync(path.join(fixture.home, 'scope-home', '.pd'))).toBe(false);
});

registry.when(/构建 ~\/\.pd 安装的 canonical 版本报告/, (ctx) => {
  const fixture = fixtureOf(ctx);
  const report = buildVersionReport(fixture.home);
  ctx.state['report'] = report;
  ctx.state['shortText'] = formatShortVersion(report);
});

registry.then(/productVersion 来自 active\.json/, (ctx) => {
  const report = ctx.state['report'] as { productVersion: string };
  expect(report.productVersion).toBe('1.222.0');
});

registry.then(/source 为 official-installer/, (ctx) => {
  const report = ctx.state['report'] as { source: string };
  expect(report.source).toBe('official-installer');
});

registry.then(/短文本格式为 Principles Disciple 前缀加版本与 releaseId 前缀/, (ctx) => {
  const shortText = ctx.state['shortText'] as string;
  expect(shortText).toMatch(/^Principles Disciple 1\.222\.0 \([a-f0-9]{12}\)$/);
});

registry.when(/历史事件以 release 序列 (\d+) 对先前序列 (\d+) 分类方向/, (ctx, releaseSequence, previousSequence) => {
  ctx.state['direction'] = classifyDirection({
    kind: 'update',
    releasePublicationSequence: Number(releaseSequence),
    previousPublicationSequence: Number(previousSequence),
  });
});

registry.then(/direction 为 forward/, (ctx) => {
  expect(ctx.state['direction']).toBe('forward');
});

registry.then(/direction 为 backward/, (ctx) => {
  expect(ctx.state['direction']).toBe('backward');
});

afterAll(async () => {
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  while (temporaryHomes.length > 0) {
    const home = temporaryHomes.pop();
    if (home) fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

defineFeature(fs.readFileSync(resolveFeaturePath('docs/specs/features/update/commercial-update-system.feature'), 'utf8'), registry);
