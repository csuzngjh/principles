import * as fs from 'fs';
import * as path from 'path';
import type { EventLogEntry, GateBlockEvent } from '../types/index.js';

export class EventLogReadModel {
  private readonly logsDir: string;

  constructor(stateDir: string) {
    this.logsDir = path.join(stateDir, 'logs');
  }

  async getGateBlocks(limit = 100): Promise<GateBlockEvent[]> {
    const blocks: GateBlockEvent[] = [];
    const files = this.getEventFiles();

    for (const file of files.reverse()) {
      if (blocks.length >= limit) break;
      
      const entries = await this.readEventsOfFile(file);
      for (const entry of entries.reverse()) {
        if (entry.type === 'gate_block' && blocks.length < limit) {
          blocks.push(entry as GateBlockEvent);
        }
      }
    }

    return blocks;
  }

  async countGateBlocksToday(): Promise<number> {
    const [today] = new Date().toISOString().split('T');
    const file = path.join(this.logsDir, `events_${today}.jsonl`);

    if (!fs.existsSync(file)) return 0;

    let count = 0;
    for await (const line of this.readLines(file)) {
      try {
        const entry = JSON.parse(line) as EventLogEntry;
        if (entry.type === 'gate_block') count++;
      } catch { /* skip malformed */ }
    }
    return count;
  }

  async countEventsByTypeToday(eventType: string): Promise<number> {
    const [today] = new Date().toISOString().split('T');
    const file = path.join(this.logsDir, `events_${today}.jsonl`);

    if (!fs.existsSync(file)) return 0;

    let count = 0;
    for await (const line of this.readLines(file)) {
      try {
        const entry = JSON.parse(line) as EventLogEntry;
        if (entry.type === eventType) count++;
      } catch { /* skip malformed */ }
    }
    return count;
  }

  async getEventsByTypes(types: string[], limit = 50): Promise<EventLogEntry[]> {
    const results: EventLogEntry[] = [];
    const files = this.getEventFiles();

    for (const file of files.reverse()) {
      if (results.length >= limit) break;

      const entries = await this.readEventsOfFile(file);
      for (const entry of entries.reverse()) {
        if (types.includes(entry.type) && results.length < limit) {
          results.push(entry);
        }
      }
    }

    return results;
  }

  async countEventsByTypeAndDate(eventType: string, date: string): Promise<number> {
    const file = path.join(this.logsDir, `events_${date}.jsonl`);

    if (!fs.existsSync(file)) return 0;

    let count = 0;
    for await (const line of this.readLines(file)) {
      try {
        const entry = JSON.parse(line) as EventLogEntry;
        if (entry.type === eventType) count++;
      } catch { /* skip malformed */ }
    }
    return count;
  }

  async countEventsByCategoryAndDate(category: string, date: string): Promise<number> {
    const file = path.join(this.logsDir, `events_${date}.jsonl`);

    if (!fs.existsSync(file)) return 0;

    let count = 0;
    for await (const line of this.readLines(file)) {
      try {
        const entry = JSON.parse(line) as EventLogEntry;
        if (entry.category === category) count++;
      } catch { /* skip malformed */ }
    }
    return count;
  }

  private getEventFiles(): string[] {
    if (!fs.existsSync(this.logsDir)) return [];

    return fs.readdirSync(this.logsDir)
      .filter(f => f.startsWith('events_') && f.endsWith('.jsonl'))
      .sort()
      .map(f => path.join(this.logsDir, f));
  }

  private async readEventsOfFile(filePath: string): Promise<EventLogEntry[]> {
    const entries: EventLogEntry[] = [];
    for await (const line of this.readLines(filePath)) {
      try {
        entries.push(JSON.parse(line) as EventLogEntry);
      } catch { /* skip malformed */ }
    }
    return entries;
  }

  private async *readLines(filePath: string): AsyncIterable<string> {
    const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const readline = await import('readline');
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (line.trim()) yield line;
    }

    void this.logsDir;
  }

  dispose(): void {
    void this.logsDir;
  }
}
