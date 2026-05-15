import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventLogReadModel } from '../../src/server/models/EventLogReadModel.js';
import type { EventLogEntry } from '../../src/server/types/index.js';

function makeEvent(overrides: Partial<EventLogEntry>): EventLogEntry {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    type: 'pain_signal',
    category: 'runtime',
    ts: new Date().toISOString(),
    metadata: {},
    ...overrides,
  };
}

function writeJsonlFile(dir: string, fileName: string, entries: EventLogEntry[]): string {
  const filePath = path.join(dir, fileName);
  const content = entries.map(e => JSON.stringify(e)).join('\n');
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

describe('EventLogReadModel', () => {
  let stateDir: string;
  let logsDir: string;
  let model: EventLogReadModel;

  beforeAll(() => {
    stateDir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-test-'));
    logsDir = path.join(stateDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  describe('getEventsByTypes', () => {
    it('returns empty array when no event files exist', async () => {
      model = new EventLogReadModel(stateDir);
      const events = await model.getEventsByTypes(['pain_signal']);
      expect(events).toEqual([]);
    });

    it('returns events matching the given types', async () => {
      const events: EventLogEntry[] = [
        makeEvent({ id: 'e1', type: 'pain_signal', ts: '2026-05-15T10:00:00Z' }),
        makeEvent({ id: 'e2', type: 'task_created', ts: '2026-05-15T10:01:00Z' }),
        makeEvent({ id: 'e3', type: 'pain_signal', ts: '2026-05-15T10:02:00Z' }),
      ];
      writeJsonlFile(logsDir, 'events_2026-05-15.jsonl', events);

      model = new EventLogReadModel(stateDir);
      const results = await model.getEventsByTypes(['pain_signal'], 10);

      expect(results).toHaveLength(2);
      results.forEach(e => expect(e.type).toBe('pain_signal'));
    });

    it('respects the limit parameter', async () => {
      const events: EventLogEntry[] = Array.from({ length: 10 }, (_, i) =>
        makeEvent({ id: `e-${i}`, type: 'pain_signal', ts: `2026-05-15T10:0${i}:00Z` }),
      );
      writeJsonlFile(logsDir, 'events_2026-05-16.jsonl', events);

      model = new EventLogReadModel(stateDir);
      const results = await model.getEventsByTypes(['pain_signal'], 3);

      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('returns newest events first (reverse chronological)', async () => {
      const newDir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-rev-'));
      const newLogsDir = path.join(newDir, 'logs');
      fs.mkdirSync(newLogsDir, { recursive: true });
      writeJsonlFile(newLogsDir, 'events_2026-05-14.jsonl', [
        makeEvent({ id: 'oldest', type: 'pain_signal', ts: '2026-05-14T10:00:00Z' }),
      ]);
      writeJsonlFile(newLogsDir, 'events_2026-05-15.jsonl', [
        makeEvent({ id: 'newest', type: 'pain_signal', ts: '2026-05-15T10:00:00Z' }),
      ]);

      const m = new EventLogReadModel(newDir);
      const results = await m.getEventsByTypes(['pain_signal'], 1);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('newest');
      fs.rmSync(newDir, { recursive: true, force: true });
    });

    it('matches multiple event types', async () => {
      const events: EventLogEntry[] = [
        makeEvent({ id: 'e1', type: 'pain_signal', ts: '2026-05-15T10:00:00Z' }),
        makeEvent({ id: 'e2', type: 'task_created', ts: '2026-05-15T10:01:00Z' }),
        makeEvent({ id: 'e3', type: 'candidate_generated', ts: '2026-05-15T10:02:00Z' }),
      ];
      const newDir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-test2-'));
      const newLogsDir = path.join(newDir, 'logs');
      fs.mkdirSync(newLogsDir, { recursive: true });
      writeJsonlFile(newLogsDir, 'events_2026-05-15.jsonl', events);

      const m = new EventLogReadModel(newDir);
      const results = await m.getEventsByTypes(['pain_signal', 'task_created'], 10);

      expect(results).toHaveLength(2);
      fs.rmSync(newDir, { recursive: true, force: true });
    });
  });

  describe('getEventsPaginated', () => {
    it('returns paginated results', async () => {
      const events: EventLogEntry[] = Array.from({ length: 25 }, (_, i) =>
        makeEvent({ id: `page-${i}`, type: 'pain_signal', ts: `2026-05-17T10:${String(i).padStart(2, '0')}:00Z` }),
      );
      const newDir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-pag-'));
      const newLogsDir = path.join(newDir, 'logs');
      fs.mkdirSync(newLogsDir, { recursive: true });
      writeJsonlFile(newLogsDir, 'events_2026-05-17.jsonl', events);

      const m = new EventLogReadModel(newDir);
      const result1 = await m.getEventsPaginated({ page: 1, pageSize: 10 });
      const result2 = await m.getEventsPaginated({ page: 2, pageSize: 10 });

      expect(result1.events).toHaveLength(10);
      expect(result2.events).toHaveLength(10);
      expect(result1.total).toBe(25);
      expect(result1.totalPages).toBe(3);

      fs.rmSync(newDir, { recursive: true, force: true });
    });

    it('filters by event types', async () => {
      const events: EventLogEntry[] = [
        makeEvent({ id: 't1', type: 'pain_signal', ts: '2026-05-18T10:00:00Z' }),
        makeEvent({ id: 't2', type: 'task_created', ts: '2026-05-18T10:01:00Z' }),
      ];
      const newDir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-pag2-'));
      const newLogsDir = path.join(newDir, 'logs');
      fs.mkdirSync(newLogsDir, { recursive: true });
      writeJsonlFile(newLogsDir, 'events_2026-05-18.jsonl', events);

      const m = new EventLogReadModel(newDir);
      const result = await m.getEventsPaginated({ types: ['pain_signal'] });

      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe('pain_signal');

      fs.rmSync(newDir, { recursive: true, force: true });
    });

    it('filters by date range', async () => {
      const events: EventLogEntry[] = [
        makeEvent({ id: 'old', type: 'pain_signal', ts: '2026-05-01T10:00:00Z' }),
        makeEvent({ id: 'new', type: 'pain_signal', ts: '2026-05-20T10:00:00Z' }),
      ];
      const newDir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-pag3-'));
      const newLogsDir = path.join(newDir, 'logs');
      fs.mkdirSync(newLogsDir, { recursive: true });
      writeJsonlFile(newLogsDir, 'events_2026-05-01.jsonl', [events[0]]);
      writeJsonlFile(newLogsDir, 'events_2026-05-20.jsonl', [events[1]]);

      const m = new EventLogReadModel(newDir);
      const result = await m.getEventsPaginated({ startDate: '2026-05-15' });

      expect(result.events).toHaveLength(1);
      expect(result.events[0].id).toBe('new');

      fs.rmSync(newDir, { recursive: true, force: true });
    });
  });

  describe('countEventsByTypeAndDate', () => {
    it('returns 0 when file does not exist', async () => {
      model = new EventLogReadModel(stateDir);
      const count = await model.countEventsByTypeAndDate('pain_signal', '2099-01-01');
      expect(count).toBe(0);
    });

    it('counts events of a specific type on a specific date', async () => {
      const events: EventLogEntry[] = [
        makeEvent({ id: 'c1', type: 'pain_signal', ts: '2026-05-19T10:00:00Z' }),
        makeEvent({ id: 'c2', type: 'pain_signal', ts: '2026-05-19T10:01:00Z' }),
        makeEvent({ id: 'c3', type: 'task_created', ts: '2026-05-19T10:02:00Z' }),
      ];
      writeJsonlFile(logsDir, 'events_2026-05-19.jsonl', events);

      model = new EventLogReadModel(stateDir);
      const count = await model.countEventsByTypeAndDate('pain_signal', '2026-05-19');
      expect(count).toBe(2);
    });
  });

  describe('countEventsByCategoryAndDate', () => {
    it('counts events by category', async () => {
      const events: EventLogEntry[] = [
        makeEvent({ id: 'cat1', type: 'pain_signal', category: 'runtime', ts: '2026-05-19T10:00:00Z' }),
        makeEvent({ id: 'cat2', type: 'task_created', category: 'runtime', ts: '2026-05-19T10:01:00Z' }),
        makeEvent({ id: 'cat3', type: 'gate_block', category: 'gate', ts: '2026-05-19T10:02:00Z' }),
      ];
      writeJsonlFile(logsDir, 'events_2026-05-20.jsonl', events);

      model = new EventLogReadModel(stateDir);
      const count = await model.countEventsByCategoryAndDate('runtime', '2026-05-20');
      expect(count).toBe(2);
    });
  });

  describe('getGateBlocks', () => {
    it('returns gate_block events', async () => {
      const events: EventLogEntry[] = [
        makeEvent({ id: 'gb1', type: 'gate_block', category: 'gate', ts: '2026-05-21T10:00:00Z' }),
        makeEvent({ id: 'gb2', type: 'gate_block', category: 'gate', ts: '2026-05-21T10:01:00Z' }),
        makeEvent({ id: 'other', type: 'pain_signal', ts: '2026-05-21T10:02:00Z' }),
      ];
      const newDir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-gb-'));
      const newLogsDir = path.join(newDir, 'logs');
      fs.mkdirSync(newLogsDir, { recursive: true });
      writeJsonlFile(newLogsDir, 'events_2026-05-21.jsonl', events);

      const m = new EventLogReadModel(newDir);
      const blocks = await m.getGateBlocks(10);

      expect(blocks).toHaveLength(2);
      blocks.forEach(b => expect(b.type).toBe('gate_block'));

      fs.rmSync(newDir, { recursive: true, force: true });
    });

    it('respects the limit parameter', async () => {
      const events: EventLogEntry[] = Array.from({ length: 5 }, (_, i) =>
        makeEvent({ id: `gb-${i}`, type: 'gate_block', category: 'gate', ts: `2026-05-22T10:0${i}:00Z` }),
      );
      const newDir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-gb2-'));
      const newLogsDir = path.join(newDir, 'logs');
      fs.mkdirSync(newLogsDir, { recursive: true });
      writeJsonlFile(newLogsDir, 'events_2026-05-22.jsonl', events);

      const m = new EventLogReadModel(newDir);
      const blocks = await m.getGateBlocks(2);

      expect(blocks.length).toBeLessThanOrEqual(2);

      fs.rmSync(newDir, { recursive: true, force: true });
    });
  });

  describe('getRelatedEvents', () => {
    it('returns events around a target event', async () => {
      const events: EventLogEntry[] = Array.from({ length: 5 }, (_, i) =>
        makeEvent({ id: `rel-${i}`, type: 'pain_signal', ts: `2026-05-23T10:0${i}:00Z` }),
      );
      const newDir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-rel-'));
      const newLogsDir = path.join(newDir, 'logs');
      fs.mkdirSync(newLogsDir, { recursive: true });
      writeJsonlFile(newLogsDir, 'events_2026-05-23.jsonl', events);

      const m = new EventLogReadModel(newDir);
      const related = await m.getRelatedEvents('rel-2', 2);

      expect(related.some(e => e.id === 'rel-2')).toBe(true);

      fs.rmSync(newDir, { recursive: true, force: true });
    });

    it('returns empty array when event not found', async () => {
      const events: EventLogEntry[] = [
        makeEvent({ id: 'x1', type: 'pain_signal', ts: '2026-05-24T10:00:00Z' }),
      ];
      const newDir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-rel2-'));
      const newLogsDir = path.join(newDir, 'logs');
      fs.mkdirSync(newLogsDir, { recursive: true });
      writeJsonlFile(newLogsDir, 'events_2026-05-24.jsonl', events);

      const m = new EventLogReadModel(newDir);
      const related = await m.getRelatedEvents('nonexistent', 5);

      expect(related).toEqual([]);

      fs.rmSync(newDir, { recursive: true, force: true });
    });
  });

  describe('countEventsGroupedByType', () => {
    it('groups events by type', async () => {
      const events: EventLogEntry[] = [
        makeEvent({ id: 'g1', type: 'pain_signal', ts: '2026-05-25T10:00:00Z' }),
        makeEvent({ id: 'g2', type: 'pain_signal', ts: '2026-05-25T10:01:00Z' }),
        makeEvent({ id: 'g3', type: 'task_created', ts: '2026-05-25T10:02:00Z' }),
      ];
      const newDir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-group-'));
      const newLogsDir = path.join(newDir, 'logs');
      fs.mkdirSync(newLogsDir, { recursive: true });
      writeJsonlFile(newLogsDir, 'events_2026-05-25.jsonl', events);

      const m = new EventLogReadModel(newDir);
      const counts = await m.countEventsGroupedByType();

      expect(counts['pain_signal']).toBe(2);
      expect(counts['task_created']).toBe(1);

      fs.rmSync(newDir, { recursive: true, force: true });
    });
  });

  describe('extractFileDate', () => {
    it('extracts date from valid event file names', async () => {
      const events: EventLogEntry[] = [
        makeEvent({ id: 'd1', type: 'pain_signal', ts: '2026-05-26T10:00:00Z' }),
      ];
      writeJsonlFile(logsDir, 'events_2026-05-26.jsonl', events);

      model = new EventLogReadModel(stateDir);
      const results = await model.getEventsByTypes(['pain_signal'], 10);

      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('ignores non-event files', async () => {
      fs.writeFileSync(path.join(logsDir, 'notes.txt'), 'hello', 'utf8');

      model = new EventLogReadModel(stateDir);
      const results = await model.getEventsByTypes(['pain_signal'], 10);

      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('malformed JSON handling', () => {
    it('skips malformed lines without crashing', async () => {
      const newDir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-mal-'));
      const newLogsDir = path.join(newDir, 'logs');
      fs.mkdirSync(newLogsDir, { recursive: true });
      const malformedContent = '{"id":"good","type":"pain_signal","category":"runtime","ts":"2026-05-27T10:00:00Z","metadata":{}}\nthis is not json\n{"id":"bad"\n';
      fs.writeFileSync(path.join(newLogsDir, 'events_2026-05-27.jsonl'), malformedContent, 'utf8');

      const m = new EventLogReadModel(newDir);
      const results = await m.getEventsByTypes(['pain_signal'], 10);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('good');
      fs.rmSync(newDir, { recursive: true, force: true });
    });
  });
});
