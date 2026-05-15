import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, afterAll } from 'vitest';
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

  afterAll(() => {
    if (stateDir) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  describe('getEventsByTypes', () => {
    it('returns empty array when no event files exist', async () => {
      stateDir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-empty-'));
      const model = new EventLogReadModel(stateDir);
      const events = await model.getEventsByTypes(['pain_signal']);
      expect(events).toEqual([]);
    });

    it('returns events matching the given types', async () => {
      const dir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-types-'));
      const logsDir = path.join(dir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });

      const events: EventLogEntry[] = [
        makeEvent({ id: 'e1', type: 'pain_signal', ts: '2026-05-15T10:00:00Z' }),
        makeEvent({ id: 'e2', type: 'task_created', ts: '2026-05-15T10:01:00Z' }),
        makeEvent({ id: 'e3', type: 'pain_signal', ts: '2026-05-15T10:02:00Z' }),
      ];
      writeJsonlFile(logsDir, 'events_2026-05-15.jsonl', events);

      const model = new EventLogReadModel(dir);
      const results = await model.getEventsByTypes(['pain_signal'], 10);

      expect(results).toHaveLength(2);
      results.forEach(e => expect(e.type).toBe('pain_signal'));
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('respects the limit parameter', async () => {
      const dir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-limit-'));
      const logsDir = path.join(dir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });

      const events: EventLogEntry[] = Array.from({ length: 10 }, (_, i) =>
        makeEvent({ id: `e-${i}`, type: 'pain_signal', ts: `2026-05-15T10:0${i}:00Z` }),
      );
      writeJsonlFile(logsDir, 'events_2026-05-16.jsonl', events);

      const model = new EventLogReadModel(dir);
      const results = await model.getEventsByTypes(['pain_signal'], 3);

      expect(results.length).toBeLessThanOrEqual(3);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('returns newest events first (reverse chronological)', async () => {
      const dir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-rev-'));
      const logsDir = path.join(dir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });

      writeJsonlFile(logsDir, 'events_2026-05-14.jsonl', [
        makeEvent({ id: 'oldest', type: 'pain_signal', ts: '2026-05-14T10:00:00Z' }),
      ]);
      writeJsonlFile(logsDir, 'events_2026-05-15.jsonl', [
        makeEvent({ id: 'newest', type: 'pain_signal', ts: '2026-05-15T10:00:00Z' }),
      ]);

      const model = new EventLogReadModel(dir);
      const results = await model.getEventsByTypes(['pain_signal'], 1);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('newest');
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('matches multiple event types', async () => {
      const dir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-multi-'));
      const logsDir = path.join(dir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });

      const events: EventLogEntry[] = [
        makeEvent({ id: 'e1', type: 'pain_signal', ts: '2026-05-15T10:00:00Z' }),
        makeEvent({ id: 'e2', type: 'task_created', ts: '2026-05-15T10:01:00Z' }),
        makeEvent({ id: 'e3', type: 'candidate_generated', ts: '2026-05-15T10:02:00Z' }),
      ];
      writeJsonlFile(logsDir, 'events_2026-05-15.jsonl', events);

      const model = new EventLogReadModel(dir);
      const results = await model.getEventsByTypes(['pain_signal', 'task_created'], 10);

      expect(results).toHaveLength(2);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('getEventsPaginated', () => {
    it('returns paginated results', async () => {
      const dir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-pag-'));
      const logsDir = path.join(dir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });

      const events: EventLogEntry[] = Array.from({ length: 25 }, (_, i) =>
        makeEvent({ id: `page-${i}`, type: 'pain_signal', ts: `2026-05-17T10:${String(i).padStart(2, '0')}:00Z` }),
      );
      writeJsonlFile(logsDir, 'events_2026-05-17.jsonl', events);

      const model = new EventLogReadModel(dir);
      const result1 = await model.getEventsPaginated({ page: 1, pageSize: 10 });
      const result2 = await model.getEventsPaginated({ page: 2, pageSize: 10 });

      expect(result1.events).toHaveLength(10);
      expect(result2.events).toHaveLength(10);
      expect(result1.total).toBe(25);
      expect(result1.totalPages).toBe(3);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('filters by event types', async () => {
      const dir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-pag2-'));
      const logsDir = path.join(dir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });

      const events: EventLogEntry[] = [
        makeEvent({ id: 't1', type: 'pain_signal', ts: '2026-05-18T10:00:00Z' }),
        makeEvent({ id: 't2', type: 'task_created', ts: '2026-05-18T10:01:00Z' }),
      ];
      writeJsonlFile(logsDir, 'events_2026-05-18.jsonl', events);

      const model = new EventLogReadModel(dir);
      const result = await model.getEventsPaginated({ types: ['pain_signal'] });

      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe('pain_signal');
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('filters by date range', async () => {
      const dir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-pag3-'));
      const logsDir = path.join(dir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });

      writeJsonlFile(logsDir, 'events_2026-05-01.jsonl', [
        makeEvent({ id: 'old', type: 'pain_signal', ts: '2026-05-01T10:00:00Z' }),
      ]);
      writeJsonlFile(logsDir, 'events_2026-05-20.jsonl', [
        makeEvent({ id: 'new', type: 'pain_signal', ts: '2026-05-20T10:00:00Z' }),
      ]);

      const model = new EventLogReadModel(dir);
      const result = await model.getEventsPaginated({ startDate: '2026-05-15' });

      expect(result.events).toHaveLength(1);
      expect(result.events[0].id).toBe('new');
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('countEventsByTypeAndDate', () => {
    it('returns 0 when file does not exist', async () => {
      const dir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-count0-'));
      const model = new EventLogReadModel(dir);
      const count = await model.countEventsByTypeAndDate('pain_signal', '2099-01-01');
      expect(count).toBe(0);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('counts events of a specific type on a specific date', async () => {
      const dir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-count-'));
      const logsDir = path.join(dir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });

      const events: EventLogEntry[] = [
        makeEvent({ id: 'c1', type: 'pain_signal', ts: '2026-05-19T10:00:00Z' }),
        makeEvent({ id: 'c2', type: 'pain_signal', ts: '2026-05-19T10:01:00Z' }),
        makeEvent({ id: 'c3', type: 'task_created', ts: '2026-05-19T10:02:00Z' }),
      ];
      writeJsonlFile(logsDir, 'events_2026-05-19.jsonl', events);

      const model = new EventLogReadModel(dir);
      const count = await model.countEventsByTypeAndDate('pain_signal', '2026-05-19');
      expect(count).toBe(2);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('countEventsByCategoryAndDate', () => {
    it('counts events by category', async () => {
      const dir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-cat-'));
      const logsDir = path.join(dir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });

      const events: EventLogEntry[] = [
        makeEvent({ id: 'cat1', type: 'pain_signal', category: 'runtime', ts: '2026-05-20T10:00:00Z' }),
        makeEvent({ id: 'cat2', type: 'task_created', category: 'runtime', ts: '2026-05-20T10:01:00Z' }),
        makeEvent({ id: 'cat3', type: 'gate_block', category: 'gate', ts: '2026-05-20T10:02:00Z' }),
      ];
      writeJsonlFile(logsDir, 'events_2026-05-20.jsonl', events);

      const model = new EventLogReadModel(dir);
      const count = await model.countEventsByCategoryAndDate('runtime', '2026-05-20');
      expect(count).toBe(2);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('getGateBlocks', () => {
    it('returns gate_block events', async () => {
      const dir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-gb-'));
      const logsDir = path.join(dir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });

      const events: EventLogEntry[] = [
        makeEvent({ id: 'gb1', type: 'gate_block', category: 'gate', ts: '2026-05-21T10:00:00Z' }),
        makeEvent({ id: 'gb2', type: 'gate_block', category: 'gate', ts: '2026-05-21T10:01:00Z' }),
        makeEvent({ id: 'other', type: 'pain_signal', ts: '2026-05-21T10:02:00Z' }),
      ];
      writeJsonlFile(logsDir, 'events_2026-05-21.jsonl', events);

      const model = new EventLogReadModel(dir);
      const blocks = await model.getGateBlocks(10);

      expect(blocks).toHaveLength(2);
      blocks.forEach(b => expect(b.type).toBe('gate_block'));
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('respects the limit parameter', async () => {
      const dir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-gb2-'));
      const logsDir = path.join(dir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });

      const events: EventLogEntry[] = Array.from({ length: 5 }, (_, i) =>
        makeEvent({ id: `gb-${i}`, type: 'gate_block', category: 'gate', ts: `2026-05-22T10:0${i}:00Z` }),
      );
      writeJsonlFile(logsDir, 'events_2026-05-22.jsonl', events);

      const model = new EventLogReadModel(dir);
      const blocks = await model.getGateBlocks(2);

      expect(blocks.length).toBeLessThanOrEqual(2);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('getRelatedEvents', () => {
    it('returns events around a target event', async () => {
      const dir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-rel-'));
      const logsDir = path.join(dir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });

      const events: EventLogEntry[] = Array.from({ length: 5 }, (_, i) =>
        makeEvent({ id: `rel-${i}`, type: 'pain_signal', ts: `2026-05-23T10:0${i}:00Z` }),
      );
      writeJsonlFile(logsDir, 'events_2026-05-23.jsonl', events);

      const model = new EventLogReadModel(dir);
      const related = await model.getRelatedEvents('rel-2', 2);

      expect(related.some(e => e.id === 'rel-2')).toBe(true);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('returns empty array when event not found', async () => {
      const dir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-rel2-'));
      const logsDir = path.join(dir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });

      writeJsonlFile(logsDir, 'events_2026-05-24.jsonl', [
        makeEvent({ id: 'x1', type: 'pain_signal', ts: '2026-05-24T10:00:00Z' }),
      ]);

      const model = new EventLogReadModel(dir);
      const related = await model.getRelatedEvents('nonexistent', 5);

      expect(related).toEqual([]);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('countEventsGroupedByType', () => {
    it('groups events by type', async () => {
      const dir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-group-'));
      const logsDir = path.join(dir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });

      const events: EventLogEntry[] = [
        makeEvent({ id: 'g1', type: 'pain_signal', ts: '2026-05-25T10:00:00Z' }),
        makeEvent({ id: 'g2', type: 'pain_signal', ts: '2026-05-25T10:01:00Z' }),
        makeEvent({ id: 'g3', type: 'task_created', ts: '2026-05-25T10:02:00Z' }),
      ];
      writeJsonlFile(logsDir, 'events_2026-05-25.jsonl', events);

      const model = new EventLogReadModel(dir);
      const counts = await model.countEventsGroupedByType();

      expect(counts['pain_signal']).toBe(2);
      expect(counts['task_created']).toBe(1);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('non-event file handling', () => {
    it('ignores non-event files', async () => {
      const dir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-igno-'));
      const logsDir = path.join(dir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(path.join(logsDir, 'notes.txt'), 'hello', 'utf8');

      const model = new EventLogReadModel(dir);
      const results = await model.getEventsByTypes(['pain_signal'], 10);

      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(0);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('malformed JSON handling', () => {
    it('skips malformed lines without crashing', async () => {
      const dir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-eventlog-mal-'));
      const logsDir = path.join(dir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });

      const malformedContent = '{"id":"good","type":"pain_signal","category":"runtime","ts":"2026-05-27T10:00:00Z","metadata":{}}\nthis is not json\n{"id":"bad"\n';
      fs.writeFileSync(path.join(logsDir, 'events_2026-05-27.jsonl'), malformedContent, 'utf8');

      const model = new EventLogReadModel(dir);
      const results = await model.getEventsByTypes(['pain_signal'], 10);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('good');
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
});
