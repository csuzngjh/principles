import fs from 'node:fs';
import path from 'node:path';

/**
 * PD_PROMPT_CAPACITY_V1 Phase C / AC-12: read-model over the EXISTING
 * injection-event JSONL (`<stateDir>/logs/events_<date>.jsonl`, written by the
 * OpenClaw EventLog and the Codex shared path via appendEventLogLine).
 *
 * Honesty rules this model enforces (SPEC §6):
 * - NO logs ≠ zero injections: an activation with no events is simply absent
 *   from `rows`; the caller reports "unknown", never "0 proven injections".
 * - Duplicate lines (identical serialized payloads — rollover/replay) count
 *   once; the dedupe count is reported, not hidden.
 * - Statistics never mix entities: rows are keyed by (workspaceDir,
 *   activationId); the same runId across different workspaces/sessions stays
 *   separate.
 * - Old events missing identity fields (runId) still count as injection FACTS
 *   but flag `runIdComplete` false — the numbers degrade to "known counts,
 *   incomplete binding", never to zero.
 * - Model self-report (principle_applications kind self_reported) is a
 *   separate signal and is deliberately NOT read here: self-report ≠
 *   compliance.
 *
 * Untrusted input discipline: every line is parsed as `unknown` and narrowed
 * with typeof guards (rc-1..rc-5); structurally invalid lines are counted in
 * `parseFailures` and skipped loudly, never guessed (rc-3).
 */

export interface InjectionEvidenceRow {
  workspaceDir: string;
  activationId: string;
  /** Deduplicated injection facts: this activation appeared in the injected set. */
  provenInjections: number;
  /** Raw matching events before dedupe. */
  rawEventCount: number;
  duplicateEventsDeduped: number;
  sessions: string[];
  runIds: string[];
  /** False when any counted event lacked runId (old events / hosts without turn ids). */
  runIdComplete: boolean;
  lastEventAt: string | null;
}

export interface InjectionEventEvidenceReport {
  filesRead: string[];
  lines: number;
  parseFailures: number;
  rows: InjectionEvidenceRow[];
  note: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function readInjectionEventEvidence(input: { stateDir: string }): InjectionEventEvidenceReport {
  const logsRoot = path.resolve(input.stateDir, 'logs');
  const filesRead: string[] = [];
  if (!fs.existsSync(logsRoot)) {
    return {
      filesRead,
      lines: 0,
      parseFailures: 0,
      rows: [],
      note: 'no_logs: the injection-event log directory does not exist — injection/coverage numbers are UNKNOWN, not zero',
    };
  }
  const files = fs.readdirSync(logsRoot)
    .filter((name) => name.startsWith('events_') && name.endsWith('.jsonl'))
    .sort();
  let lines = 0;
  let parseFailures = 0;
  // key: workspaceDir + ' ' + activationId; payload-dedupe set per row.
  const rows = new Map<string, InjectionEvidenceRow & { seen: Set<string> }>();
  for (const name of files) {
    // Containment guard: only bare event filenames inside the resolved logs
    // root are ever read — a crafted name cannot escape the directory.
    const filePath = path.resolve(logsRoot, name);
    if (!filePath.startsWith(logsRoot + path.sep) || path.basename(name) !== name) continue;
    filesRead.push(filePath);
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      lines += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        parseFailures += 1;
        continue;
      }
      if (!isRecord(parsed)) {
        parseFailures += 1;
        continue;
      }
      if (nonEmptyString(parsed.type) !== 'runtime_v2_prompt_activations_injected') continue;
      const ts = nonEmptyString(parsed.ts) ?? null;
      const {data} = parsed;
      if (!isRecord(data)) {
        parseFailures += 1;
        continue;
      }
      const workspaceDir = nonEmptyString(data.workspaceDir);
      const sessionId = nonEmptyString(data.sessionId) ?? nonEmptyString(parsed.sessionId);
      const runId = nonEmptyString(data.runId);
      const {activationIds} = data;
      if (workspaceDir === undefined || sessionId === undefined || !Array.isArray(activationIds)
        || !activationIds.every((id): id is string => typeof id === 'string')) {
        // rc-3/rc-4: identity binding incomplete → loud skip, never a guess.
        parseFailures += 1;
        continue;
      }
      const dedupeKey = JSON.stringify([workspaceDir, sessionId, runId ?? null, ts, activationIds.join(','), data.injectedCharCount, data.selectionPolicy ?? null, data.rotationStartIndex ?? null]);
      for (const activationId of activationIds) {
        const rowKey = `${workspaceDir} ${activationId}`;
        let row = rows.get(rowKey);
        if (row === undefined) {
          row = {
            workspaceDir,
            activationId,
            provenInjections: 0,
            rawEventCount: 0,
            duplicateEventsDeduped: 0,
            sessions: [],
            runIds: [],
            runIdComplete: true,
            lastEventAt: null,
            seen: new Set<string>(),
          };
          rows.set(rowKey, row);
        }
        row.rawEventCount += 1;
        if (!row.seen.has(dedupeKey)) {
          row.seen.add(dedupeKey);
          row.provenInjections += 1;
          if (!row.sessions.includes(sessionId)) row.sessions.push(sessionId);
          if (runId !== undefined && !row.runIds.includes(runId)) row.runIds.push(runId);
          if (ts !== null && (row.lastEventAt === null || ts > row.lastEventAt)) row.lastEventAt = ts;
        } else {
          row.duplicateEventsDeduped += 1;
        }
        if (runId === undefined) row.runIdComplete = false;
      }
    }
  }
  return {
    filesRead,
    lines,
    parseFailures,
    rows: [...rows.values()].map((row) => ({
      workspaceDir: row.workspaceDir,
      activationId: row.activationId,
      provenInjections: row.provenInjections,
      rawEventCount: row.rawEventCount,
      duplicateEventsDeduped: row.duplicateEventsDeduped,
      sessions: row.sessions,
      runIds: row.runIds,
      runIdComplete: row.runIdComplete,
      lastEventAt: row.lastEventAt,
    })),
    note: 'absence from rows means UNKNOWN (no logs), never zero; self-report is a separate signal and is not compliance evidence; rows never merge workspaces',
  };
}
