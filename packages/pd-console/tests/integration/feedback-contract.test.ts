import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { probeChannels } from '../../src/server/feedback/channels.js';
import { FEEDBACK_CHANNEL_IDS } from '../../src/shared/feedback-channel-ids.js';
import {
  FeedbackChannelsDataSchema,
  FeedbackChannelStatusSchema,
  FeedbackSubmitResultSchema,
} from '../../src/shared/feedback-contract.js';
import {
  validateFeedbackChannels,
  validateFeedbackSubmitResult,
} from '../../src/ui/utils/validators.js';

/**
 * PRI-613 Schema→Type→Validator pilot contract tests — feedback submit ladder.
 *
 * Chain being locked:
 *   shared TypeBox schema (canonical) → Static types (server ChannelStatus +
 *   UI validator data shapes, import-type only)
 *   → UI handwritten mirror machine-locked to the schema by the
 *   accept/reject equivalence matrix below.
 *
 * Why a mirror instead of shipping Value.Check to the browser: bundling
 * @sinclair/typebox adds ~850KB to app.js (measured; SPEC §10.5 stop
 * condition). The equivalence matrix keeps drift CI-detectable at zero
 * bundle cost. Before the pilot this contract existed as three hand-written
 * copies (server interface, UI interfaces, UI literal checks) with zero
 * tests.
 */

const emptyConfig = { ingestUrl: '', ingestToken: '', githubRepo: '', githubProxy: '' };

describe('PRI-613 feedback shared contract — schema authority', () => {
  it('FEEDBACK_CHANNEL_IDS enumerates the documented ladder', () => {
    expect([...FEEDBACK_CHANNEL_IDS]).toEqual(['ingest', 'github', 'email', 'file']);
  });

  it('FeedbackChannelStatusSchema accepts valid entries and rejects drift shapes', () => {
    expect(Value.Check(FeedbackChannelStatusSchema, { id: 'ingest', available: false, reason: 'x', nextAction: 'y' })).toBe(true);
    expect(Value.Check(FeedbackChannelStatusSchema, { id: 'email', available: true })).toBe(true);
    // explicit null optionals are part of the wire contract (legacy readNullableString)
    expect(Value.Check(FeedbackChannelStatusSchema, { id: 'email', available: true, reason: null })).toBe(true);
    expect(Value.Check(FeedbackChannelStatusSchema, { id: 'carrier-pigeon', available: true })).toBe(false);
    expect(Value.Check(FeedbackChannelStatusSchema, { id: 'ingest' })).toBe(false);
    expect(Value.Check(FeedbackChannelStatusSchema, { id: 'ingest', available: 'yes' })).toBe(false);
    expect(Value.Check(FeedbackChannelStatusSchema, { id: 'ingest', available: true, reason: 42 })).toBe(false);
  });

  it('FeedbackSubmitResultSchema accepts valid results and rejects malformed ones', () => {
    expect(Value.Check(FeedbackSubmitResultSchema, { ok: true, alreadySubmitted: false, status: 'submitted' })).toBe(true);
    expect(Value.Check(FeedbackSubmitResultSchema, {
      ok: true, alreadySubmitted: false, status: 'submitted',
      submittedVia: 'ingest', trackingId: 't-1', externalUrl: 'https://x', writeBackFailed: false, nextAction: null,
    })).toBe(true);
    expect(Value.Check(FeedbackSubmitResultSchema, { ok: true, status: 'submitted' })).toBe(false);
    expect(Value.Check(FeedbackSubmitResultSchema, { ok: 'yes', alreadySubmitted: false, status: 's' })).toBe(false);
    expect(Value.Check(FeedbackSubmitResultSchema, { ok: true, alreadySubmitted: false })).toBe(false);
    expect(Value.Check(FeedbackSubmitResultSchema, { ok: true, alreadySubmitted: false, status: 's', writeBackFailed: 'no' })).toBe(false);
  });
});

describe('PRI-613 server wire parity — probeChannels output validates against the shared schema', () => {
  it('unconfigured probe result passes FeedbackChannelsDataSchema (server is a schema producer)', async () => {
    const result = await probeChannels(emptyConfig, {}, 'owner@example.org');
    const wirePayload = { channels: result.channels };
    expect(Value.Check(FeedbackChannelsDataSchema, wirePayload)).toBe(true);
  });

  it('the unconfigured ladder reports email+file available and ingest/github unavailable with nextAction', async () => {
    // A real maintainer email makes the email channel available; the
    // placeholder 'maintainer@example.com' would (correctly) disable it.
    const result = await probeChannels(emptyConfig, {}, 'owner@example.org');
    const byId = new Map(result.channels.map((c) => [c.id, c]));
    expect(byId.get('email')?.available).toBe(true);
    expect(byId.get('file')?.available).toBe(true);
    expect(byId.get('ingest')?.available).toBe(false);
    expect(byId.get('github')?.available).toBe(false);
    expect(byId.get('ingest')?.nextAction).toBeTruthy();
  });
});

describe('PRI-613 machine-enforced mirror — UI validator ⇄ schema equivalence matrix', () => {
  const channelStatusCases: ReadonlyArray<{ label: string; payload: unknown; schemaAccepts: boolean }> = [
    { label: 'minimal valid', payload: { id: 'email', available: true }, schemaAccepts: true },
    { label: 'full valid', payload: { id: 'ingest', available: false, reason: 'r', nextAction: 'a' }, schemaAccepts: true },
    { label: 'null reason', payload: { id: 'email', available: true, reason: null }, schemaAccepts: true },
    { label: 'unknown channel id', payload: { id: 'fax', available: true }, schemaAccepts: false },
    { label: 'missing available', payload: { id: 'email' }, schemaAccepts: false },
    { label: 'available wrong type', payload: { id: 'email', available: 'yes' }, schemaAccepts: false },
    { label: 'reason wrong type', payload: { id: 'email', available: true, reason: 42 }, schemaAccepts: false },
    { label: 'nextAction wrong type', payload: { id: 'email', available: true, nextAction: {} }, schemaAccepts: false },
    { label: 'id wrong type', payload: { id: 7, available: true }, schemaAccepts: false },
  ];

  it('per-item: UI validator accepts exactly what the schema accepts (channels)', () => {
    for (const { label, payload, schemaAccepts } of channelStatusCases) {
      const schemaVerdict = Value.Check(FeedbackChannelStatusSchema, payload);
      expect(schemaVerdict, `schema verdict mismatch on fixture '${label}' — test matrix is stale`).toBe(schemaAccepts);
      const uiVerdict = validateFeedbackChannels({ channels: [payload] })?.channels.length === 1;
      expect(uiVerdict, `UI mirror verdict drifted from schema on fixture '${label}'`).toBe(schemaAccepts);
    }
  });

  const submitResultCases: ReadonlyArray<{ label: string; payload: unknown; schemaAccepts: boolean }> = [
    { label: 'minimal valid', payload: { ok: true, alreadySubmitted: false, status: 'submitted' }, schemaAccepts: true },
    { label: 'all fields valid', payload: { ok: false, alreadySubmitted: true, status: 's', submittedVia: 'github', trackingId: 't', externalUrl: 'u', writeBackFailed: true, nextAction: 'a' }, schemaAccepts: true },
    { label: 'null optional strings', payload: { ok: true, alreadySubmitted: false, status: 's', trackingId: null }, schemaAccepts: true },
    { label: 'missing alreadySubmitted', payload: { ok: true, status: 's' }, schemaAccepts: false },
    { label: 'ok wrong type', payload: { ok: 'yes', alreadySubmitted: false, status: 's' }, schemaAccepts: false },
    { label: 'missing status', payload: { ok: true, alreadySubmitted: false }, schemaAccepts: false },
    { label: 'writeBackFailed wrong type', payload: { ok: true, alreadySubmitted: false, status: 's', writeBackFailed: 'no' }, schemaAccepts: false },
    { label: 'trackingId wrong type', payload: { ok: true, alreadySubmitted: false, status: 's', trackingId: 9 }, schemaAccepts: false },
  ];

  it('whole-payload: UI validator accepts exactly what the schema accepts (submit result)', () => {
    for (const { label, payload, schemaAccepts } of submitResultCases) {
      const schemaVerdict = Value.Check(FeedbackSubmitResultSchema, payload);
      expect(schemaVerdict, `schema verdict mismatch on fixture '${label}' — test matrix is stale`).toBe(schemaAccepts);
      const uiVerdict = validateFeedbackSubmitResult(payload) !== null;
      expect(uiVerdict, `UI mirror verdict drifted from schema on fixture '${label}'`).toBe(schemaAccepts);
    }
  });

  it('legacy UI edge semantics preserved: envelope rejection + null normalization + per-item skip', () => {
    expect(validateFeedbackChannels({ channels: 'nope' })).toBeNull();
    expect(validateFeedbackChannels(null)).toBeNull();
    const normalized = validateFeedbackChannels({ channels: [{ id: 'email', available: true, reason: null }] });
    expect(normalized?.channels[0]).toEqual({ id: 'email', available: true });
    expect(Object.hasOwn(normalized?.channels[0] ?? {}, 'reason')).toBe(false);
    const skipped = validateFeedbackChannels({
      channels: [{ id: 'bogus', available: true }, { id: 'file', available: true }],
    });
    expect(skipped?.channels.map((c) => c.id)).toEqual(['file']);
    expect(validateFeedbackSubmitResult({ ok: true, status: 'x' })).toBeNull();
    expect(validateFeedbackSubmitResult('string')).toBeNull();
  });
});
