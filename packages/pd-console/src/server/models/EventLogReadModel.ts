import * as fs from 'fs';
import * as path from 'path';
import type { EventLogEntry, GateBlockEvent } from '../types/index.js';

function extractFileDate(filePath: string): string | null {
  const match = /events_(\d{4}-\d{2}-\d{2})\.jsonl/.exec(filePath);
  return match ? match[1] : null;
}

export class EventLogReadModel {
  private readonly logsDir: string;

  constructor(stateDir: string) {
    this.logsDir = path.join(stateDir, 'logs');
  }

  async getEventsPaginated(options: {
    types?: string[];
    startDate?: string;
    endDate?: string;
    searchQuery?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{
    events: EventLogEntry[];
    total: number;
    totalPages: number;
  }> {
    const {
      types,
      startDate,
      endDate,
      searchQuery,
      page = 1,
      pageSize = 50,
    } = options;

    const allFiles = this.getEventFiles().reverse(); // newest first
    const filteredFiles = allFiles.filter(file => {
      if (!startDate && !endDate) return true;
      const fileDate = extractFileDate(file);
      if (!fileDate) return true;
      if (startDate && fileDate < startDate) return false;
      if (endDate && fileDate > endDate) return false;
      return true;
    });

    const allMatchingEvents: EventLogEntry[] = [];

    for (const file of filteredFiles) {
      const entries = await this.readEventsOfFile(file);
      for (const entry of entries.reverse()) {
        if (types && types.length > 0 && !types.includes(entry.type)) continue;
        if (searchQuery) {
          const entryStr = JSON.stringify(entry).toLowerCase();
          if (!entryStr.includes(searchQuery.toLowerCase())) continue;
        }
        allMatchingEvents.push(entry);
      }
    }

    const total = allMatchingEvents.length;
    const totalPages = Math.ceil(total / pageSize);
    const startIndex = (page - 1) * pageSize;
    const events = allMatchingEvents.slice(startIndex, startIndex + pageSize);

    return { events, total, totalPages };
  }

  async countEventsGroupedByType(dateRange?: {
    startDate?: string;
    endDate?: string;
  }): Promise<Record<string, number>> {
    const allFiles = this.getEventFiles().reverse();
    const filteredFiles = allFiles.filter(file => {
      if (!dateRange?.startDate && !dateRange?.endDate) return true;
      const fileDate = extractFileDate(file);
      if (!fileDate) return true;
      if (dateRange.startDate && fileDate < dateRange.startDate) return false;
      if (dateRange.endDate && fileDate > dateRange.endDate) return false;
      return true;
    });

    const counts: Record<string, number> = {};

    for (const file of filteredFiles) {
      const entries = await this.readEventsOfFile(file);
      for (const entry of entries) {
        counts[entry.type] = (counts[entry.type] || 0) + 1;
      }
    }

    return counts;
  }

  async getRelatedEvents(eventId: string, maxDistance = 10): Promise<EventLogEntry[]> {
    const allFiles = this.getEventFiles().reverse();
    const relatedEvents: EventLogEntry[] = [];
    let foundTarget = false;
    let distance = 0;

    for (const file of allFiles) {
      const entries = await this.readEventsOfFile(file);
      for (const entry of entries) {
        if (entry.id === eventId) {
          foundTarget = true;
          relatedEvents.push(entry);
        } else if (foundTarget && distance < maxDistance) {
          relatedEvents.push(entry);
          distance++;
        }
      }
    }

    return relatedEvents;
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
