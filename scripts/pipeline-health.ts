#!/usr/bin/env node
/**
 * Pipeline Health Check — Principles Disciple
 *
 * 只读采集 Pain→Principle 核心进化链路各阶段状态，
 * 输出结构化 JSON 报告 + Markdown 摘要到 .state/health-reports/。
 *
 * Usage:
 *   npx tsx scripts/pipeline-health.ts --workspace /path/to/workspace
 *
 * Output:
 *   <workspace>/.state/health-reports/YYYY-MM-DD.json
 *   <workspace>/.state/health-reports/YYYY-MM-DD.md
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── CLI Args ───────────────────────────────────────────────────────

function parseArgs(): { workspace?: string; all?: boolean; openclawDir?: string } {
  const args = process.argv.slice(2);
  let workspace: string | undefined;
  let all = false;
  let openclawDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workspace' && args[i + 1]) {
      workspace = args[i + 1];
      i++;
    } else if (args[i] === '--all') {
      all = true;
    } else if (args[i] === '--openclaw-dir' && args[i + 1]) {
      openclawDir = args[i + 1];
      i++;
    }
  }
  if (!workspace && !all) {
    console.error('Usage: npx tsx scripts/pipeline-health.ts --workspace /path/to/workspace');
    console.error('       npx tsx scripts/pipeline-health.ts --all [--openclaw-dir ~/.openclaw]');
    process.exit(1);
  }
  return { workspace, all, openclawDir };
}

function discoverWorkspaces(openclawDir: string): string[] {
  try {
    const entries = fs.readdirSync(openclawDir);
    return entries
      .filter(e => e.startsWith('workspace-') && dirExists(path.join(openclawDir, e)))
      .map(e => path.join(openclawDir, e))
      .sort();
  } catch {
    return [];
  }
}

// ─── Known Files Registry ───────────────────────────────────────────

const KNOWN_FILES = new Set([
  '.pain_flag',
  'evolution_queue.json',
  'evolution_directive.json',
  'evolution-scorecard.json',
  'AGENT_SCORECARD.json',
  'WORKBOARD.json',
  'SYSTEM_CAPABILITIES.json',
  'pain_settings.json',
  'pain_candidates.json',
  'thinking_os_usage.json',
  'pain_dictionary.json',
  'principle_blacklist.json',
  'trajectory.db',
  'trajectory.db-shm',
  'trajectory.db-wal',
  'blobs',
  'exports',
  'logs',
  'nocturnal',
  'health-reports',
  'sessions',
  'worker-status.json',
  'HEARTBEAT.md',
  'empathy-fix-plan.md',
  'ep_simulation.jsonl',
  'hygiene-stats.json',
  '.TRUST_SYSTEM_RESIDUALS_2026-04-04',
  'WEEK_EVENTS.jsonl',
  'WEEK_STATE.json',
  'diagnosis-6ad687cb.json',
  'subagent_workflows.db',
  'principles',
  'AGENT_SCORECARD.json.bak',
  'trajectory.db-wal.bak.20260403221431',
  'retro_actions.json',
  'corrections-1775054424844-raw.jsonl',
  'orpo',
  'test-export-manifest.json',
  'test-export.jsonl',
  'pain_settings.json.WITH_TRUST_BLOCK',
  'pain_settings.json.no_scores',
]);

// ─── Helpers ────────────────────────────────────────────────────────

function safeReadJson<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function safeReadText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function dirExists(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function fileStat(filePath: string): { size: number; mtime: string } | null {
  try {
    const stat = fs.statSync(filePath);
    return { size: stat.size, mtime: stat.mtime.toISOString() };
  } catch {
    return null;
  }
}

function parseKvLines(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    result[key] = value;
  }
  return result;
}

function countPrinciplesInMarkdown(text: string): number {
  const matches = text.match(/^### P-\d+/gm);
  return matches ? matches.length : 0;
}

function isoMinutesAgo(isoString: string): number {
  if (!isoString) return -1;
  const then = new Date(isoString).getTime();
  if (isNaN(then)) return -1;
  return Math.floor((Date.now() - then) / 60000);
}

// ─── Stage Collectors ───────────────────────────────────────────────

interface HealthReport {
  timestamp: string;
  workspace: string;
  stages: Record<string, unknown>;
  unknown_files: string[];
  anomalies: Array<{ severity: 'warning' | 'critical'; message: string }>;
  inferred_breakpoints: InferredBreakpoint[];
}

function carpetScan(stateDir: string): { files: Array<{ name: string; size: number; mtime: string; known: boolean }>; unknown: string[] } {
  const files: Array<{ name: string; size: number; mtime: string; known: boolean }> = [];
  const unknown: string[] = [];

  function scanDir(dir: string, prefix: string, depth: number) {
    if (depth > 2) return;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const relativePath = prefix ? `${prefix}/${entry}` : entry;
      const stat = fileStat(fullPath);
      if (!stat) continue;

      const isKnown = KNOWN_FILES.has(entry) ||
        entry.startsWith('.evolution_complete_') ||
        entry.startsWith('evolution_complete_') ||
        entry.endsWith('.json') && KNOWN_FILES.has(entry.replace('.json', ''));

      files.push({ name: relativePath, size: stat.size, mtime: stat.mtime, known: isKnown });
      if (!isKnown) unknown.push(relativePath);

      try {
        if (fs.statSync(fullPath).isDirectory() && entry !== 'health-reports' && entry !== 'blobs' && entry !== 'logs' && entry !== 'sessions') {
          scanDir(fullPath, relativePath, depth + 1);
        }
      } catch {}
    }
  }

  scanDir(stateDir, '', 0);
  return { files, unknown };
}

function collectPainSignal(stateDir: string, workspace: string): Record<string, unknown> {
  const painFlagPath = path.join(stateDir, '.pain_flag');
  const flagText = safeReadText(painFlagPath);
  let flagData: Record<string, string> | null = null;

  if (flagText) {
    if (flagText.includes('## Latest Pain Signal') || flagText.includes('## History')) {
      const sourceMatch = flagText.match(/\*\*Source\*\*:\s*(.+)/);
      const reasonMatch = flagText.match(/\*\*Reason\*\*:\s*(.+)/);
      const timeMatch = flagText.match(/\*\*Time\*\*:\s*(.+)/);
      flagData = {
        source: sourceMatch ? sourceMatch[1].trim() : 'unknown',
        reason: reasonMatch ? reasonMatch[1].trim() : '',
        time: timeMatch ? timeMatch[1].trim() : '',
        format: 'markdown',
      };
    } else {
      flagData = parseKvLines(flagText);
    }
  }

  // SQLite query for pain_events
  let painEvents24h = 0;
  let painEvents7d = 0;
  let latestEventType = '';
  let latestEventTime = '';
  let dbError = '';

  try {
    const dbPath = path.join(stateDir, 'trajectory.db');
    if (fileExists(dbPath)) {
      let dbModule: any;
      try {
        dbModule = require('better-sqlite3');
      } catch {
        try {
          dbModule = require(path.join(workspace, 'node_modules', 'better-sqlite3'));
        } catch {
          try {
            dbModule = require(path.join(workspace, 'packages', 'openclaw-plugin', 'node_modules', 'better-sqlite3'));
          } catch {}
        }
      }
      if (dbModule) {
        const db = new dbModule(dbPath, { readonly: true });

        const now = Date.now();
        const ms24h = 24 * 60 * 60 * 1000;
        const ms7d = 7 * 24 * 60 * 60 * 1000;

        try {
          const row24h = db.prepare("SELECT COUNT(*) as cnt FROM evolution_events WHERE event_type = 'pain_detected' AND timestamp_ms > ?").get(now - ms24h);
          painEvents24h = (row24h as any)?.cnt ?? 0;
        } catch { /* table might not exist */ }

        try {
          const row7d = db.prepare("SELECT COUNT(*) as cnt FROM evolution_events WHERE event_type = 'pain_detected' AND timestamp_ms > ?").get(now - ms7d);
          painEvents7d = (row7d as any)?.cnt ?? 0;
        } catch { /* table might not exist */ }

        try {
          const latest = db.prepare("SELECT event_type, timestamp_ms FROM evolution_events WHERE event_type LIKE 'pain%' OR event_type LIKE 'evolution%' ORDER BY timestamp_ms DESC LIMIT 1").get();
          if (latest) {
            latestEventType = (latest as any).event_type;
            latestEventTime = new Date((latest as any).timestamp_ms).toISOString();
          }
        } catch { /* table might not exist */ }

        db.close();
      }
    }
  } catch (e) {
    dbError = String(e);
  }

  return {
    pain_flag: flagData ? {
      exists: true,
      score: flagData['score'] ? parseInt(flagData['score'], 10) : null,
      source: flagData['source'] || null,
      reason: flagData['reason'] || null,
      time: flagData['time'] || null,
      trace_id: flagData['trace_id'] || null,
      session_id: flagData['session_id'] || null,
      agent_id: flagData['agent_id'] || null,
      status: flagData['status'] || null,
      task_id: flagData['task_id'] || null,
      format: flagData['format'] || 'kv',
    } : { exists: false },
    trajectory_db: {
      exists: fileExists(path.join(stateDir, 'trajectory.db')),
      pain_events_24h: painEvents24h,
      pain_events_7d: painEvents7d,
      latest_event_type: latestEventType,
      latest_event_time: latestEventTime,
      db_error: dbError || null,
    },
  };
}

function collectEvolutionQueue(stateDir: string): Record<string, unknown> {
  const queuePath = path.join(stateDir, 'evolution_queue.json');
  const queue = safeReadJson<any[]>(queuePath);

  if (!queue || !Array.isArray(queue)) {
    return { exists: false };
  }

  const statusCounts: Record<string, number> = {};
  const staleTasks: Array<Record<string, unknown>> = [];

  for (const item of queue) {
    const status = item.status || 'unknown';
    statusCounts[status] = (statusCounts[status] || 0) + 1;

    if (status === 'in_progress' && item.started_at) {
      const minutesAgo = isoMinutesAgo(item.started_at);
      if (minutesAgo > 30) {
        staleTasks.push({
          id: item.id,
          task_kind: item.taskKind || item.task_type,
          score: item.score,
          age_minutes: minutesAgo,
          started_at: item.started_at,
        });
      }
    }
  }

  return {
    exists: true,
    total_items: queue.length,
    status_counts: statusCounts,
    stale_tasks: staleTasks,
  };
}

function collectDiagnostician(stateDir: string): Record<string, unknown> {
  const heartbeatPath = path.join(stateDir, '..', 'HEARTBEAT.md');
  const heartbeatText = safeReadText(heartbeatPath);

  // Parse heartbeat for evolution task info
  let heartbeatTaskId = '';
  let heartbeatContainsTask = false;
  if (heartbeatText && heartbeatText.includes('Evolution Task')) {
    heartbeatContainsTask = true;
    const idMatch = heartbeatText.match(/\[ID:\s*([^\]]+)\]/);
    if (idMatch) heartbeatTaskId = idMatch[1].trim();
  }

  let completionMarkers24h = 0;
  let completionMarkers7d = 0;
  let lastCompletionTime = '';
  let diagnosticianReports: Array<{ task_id: string; exists: boolean; has_principle: boolean; has_abstracted_principle: boolean; size: number }> = [];

  try {
    const entries = fs.readdirSync(stateDir);
    const now = Date.now();
    for (const entry of entries) {
      if (entry.startsWith('.evolution_complete_') || entry.startsWith('evolution_complete_')) {
        const markerPath = path.join(stateDir, entry);
        const stat = fileStat(markerPath);
        if (stat) {
          const ageMs = now - new Date(stat.mtime).getTime();
          if (ageMs < 24 * 60 * 60 * 1000) completionMarkers24h++;
          if (ageMs < 7 * 24 * 60 * 60 * 1000) completionMarkers7d++;
          if (!lastCompletionTime || new Date(stat.mtime) > new Date(lastCompletionTime)) {
            lastCompletionTime = stat.mtime;
          }
        }
      }
      if (entry.startsWith('.diagnostician_report_') && entry.endsWith('.json')) {
        const reportPath = path.join(stateDir, entry);
        const stat = fileStat(reportPath);
        const taskId = entry.replace('.diagnostician_report_', '').replace('.json', '');
        let hasPrinciple = false;
        let hasAbstractedPrinciple = false;
        try {
          const reportData = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
          const principle = reportData?.diagnosis_report?.principle || reportData?.principle;
          hasPrinciple = !!(principle?.trigger_pattern && principle?.action);
          hasAbstractedPrinciple = !!principle?.abstracted_principle;
        } catch {}
        diagnosticianReports.push({
          task_id: taskId,
          exists: !!stat,
          has_principle: hasPrinciple,
          has_abstracted_principle: hasAbstractedPrinciple,
          size: stat?.size ?? 0,
        });
      }
    }
  } catch {}

  const workerStatusPath = path.join(stateDir, 'worker-status.json');
  const workerStatus = safeReadJson<any>(workerStatusPath);

  return {
    heartbeat: {
      exists: !!heartbeatText,
      contains_evolution_task: heartbeatContainsTask,
      task_id: heartbeatTaskId || null,
      last_modified: heartbeatText ? fileStat(heartbeatPath)?.mtime : null,
    },
    completion_markers: {
      count_24h: completionMarkers24h,
      count_7d: completionMarkers7d,
      last_completion_time: lastCompletionTime || null,
    },
    diagnostician_reports: {
      count: diagnosticianReports.length,
      reports: diagnosticianReports,
    },
    worker_status: workerStatus ? {
      exists: true,
      last_cycle: workerStatus.timestamp || null,
      duration_ms: workerStatus.duration_ms ?? null,
      pain_flag_enqueued: workerStatus.pain_flag?.enqueued ?? null,
      pain_flag_skipped: workerStatus.pain_flag?.skipped_reason ?? null,
      queue_total: workerStatus.queue?.total ?? null,
      errors: workerStatus.errors?.length ?? 0,
      error_details: workerStatus.errors?.slice(0, 3) ?? [],
    } : { exists: false },
  };
}

function collectPrinciples(stateDir: string, workspaceDir: string): Record<string, unknown> {
  // evolution_stream.jsonl
  const streamPath = path.join(stateDir, 'evolution_stream.jsonl');
  let streamEvents7d = 0;
  let streamEventTypes: Record<string, number> = {};
  const streamText = safeReadText(streamPath);
  if (streamText) {
    const now = Date.now();
    const ms7d = 7 * 24 * 60 * 60 * 1000;
    const lines = streamText.trim().split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        const ageMs = now - (event.timestamp_ms || 0);
        if (ageMs < ms7d) {
          streamEvents7d++;
          const type = event.event_type || 'unknown';
          streamEventTypes[type] = (streamEventTypes[type] || 0) + 1;
        }
      } catch { /* skip malformed lines */ }
    }
  }

  // pain_dictionary.json
  const dictPath = path.join(stateDir, 'pain_dictionary.json');
  const dict = safeReadJson<any>(dictPath);
  const dictRuleCount = dict?.rules ? Object.keys(dict.rules).length : (Array.isArray(dict) ? dict.length : 0);

  // principle_blacklist.json
  const blacklistPath = path.join(stateDir, 'principle_blacklist.json');
  const blacklist = safeReadJson<any>(blacklistPath);
  const blacklistCount = Array.isArray(blacklist) ? blacklist.length : 0;

  // pain_candidates.json
  const candidatesPath = path.join(stateDir, 'pain_candidates.json');
  const candidates = safeReadJson<any>(candidatesPath);
  const candidateCount = Array.isArray(candidates) ? candidates.length : 0;

  // PRINCIPLES.md
  const principlesPath = path.join(workspaceDir, '.principles', 'PRINCIPLES.md');
  const principlesText = safeReadText(principlesPath);
  const principleCount = principlesText ? countPrinciplesInMarkdown(principlesText) : 0;

  return {
    evolution_stream: {
      exists: !!streamText,
      events_7d: streamEvents7d,
      event_type_distribution: streamEventTypes,
    },
    pain_dictionary: {
      exists: !!dict,
      rule_count: dictRuleCount,
    },
    principle_blacklist: {
      exists: !!blacklist,
      entry_count: blacklistCount,
    },
    pain_candidates: {
      exists: !!candidates,
      count: candidateCount,
    },
    principles_md: {
      exists: !!principlesText,
      size_bytes: principlesText ? principlesText.length : 0,
      principle_count: principleCount,
    },
  };
}

function collectEvolutionState(stateDir: string): Record<string, unknown> {
  // evolution-scorecard.json
  const scorecard = safeReadJson<any>(path.join(stateDir, 'evolution-scorecard.json'));

  // evolution_directive.json
  const directive = safeReadJson<any>(path.join(stateDir, 'evolution_directive.json'));

  // AGENT_SCORECARD.json
  const agentScorecard = safeReadJson<any>(path.join(stateDir, 'AGENT_SCORECARD.json'));

  return {
    evolution_scorecard: scorecard ? {
      exists: true,
      total_points: scorecard.totalPoints ?? scorecard.total_points ?? null,
      tier: scorecard.currentTier ?? scorecard.tier ?? null,
      double_rewards_earned: scorecard.stats?.doubleRewardsEarned ?? scorecard.doubleRewardsEarned ?? scorecard.double_rewards_earned ?? null,
      failure_rate: scorecard.stats?.totalFailures != null && scorecard.stats?.totalSuccesses != null
        ? scorecard.stats.totalFailures / (scorecard.stats.totalSuccesses + scorecard.stats.totalFailures)
        : (scorecard.failureRate ?? scorecard.failure_rate ?? null),
      events_count: scorecard.recentEvents?.length ?? scorecard.events?.length ?? scorecard.events_count ?? null,
    } : { exists: false },
    evolution_directive: {
      exists: !!directive,
      active: directive?.active ?? null,
      last_updated: directive?.timestamp ?? null,
    },
    agent_scorecard: agentScorecard ? {
      exists: true,
      trust_score: agentScorecard.trust_score ?? null,
      success_streak: agentScorecard.success_streak ?? null,
      failure_streak: agentScorecard.failure_streak ?? null,
    } : { exists: false },
  };
}

function collectNocturnal(stateDir: string): Record<string, unknown> {
  const nocturnalDir = path.join(stateDir, 'nocturnal');
  if (!dirExists(nocturnalDir)) {
    return { exists: false };
  }

  const subdirs = ['samples', 'memory', 'exports'];
  const result: Record<string, unknown> = { exists: true };

  for (const sub of subdirs) {
    const subPath = path.join(nocturnalDir, sub);
    let fileCount = 0;
    let lastModified = '';
    try {
      if (dirExists(subPath)) {
        const entries = fs.readdirSync(subPath);
        fileCount = entries.length;
        for (const entry of entries) {
          const stat = fileStat(path.join(subPath, entry));
          if (stat && (!lastModified || stat.mtime > lastModified)) {
            lastModified = stat.mtime;
          }
        }
      }
    } catch { /* skip */ }
    result[sub] = { file_count: fileCount, last_modified: lastModified || null };
  }

  return result;
}

interface InferredBreakpoint {
  confidence: 'high' | 'medium' | 'low';
  stage: string;
  evidence: string;
  suggestion: string;
}

function inferBreakpoints(report: HealthReport): InferredBreakpoint[] {
  const breakpoints: InferredBreakpoint[] = [];
  const pain = report.stages.pain_signal as any;
  const queue = report.stages.evolution_queue as any;
  const diag = report.stages.diagnostician as any;
  const principles = report.stages.principles as any;
  const stream = principles?.evolution_stream;
  const evoState = report.stages.evolution_state as any;

  const painFlagExists = pain?.pain_flag?.exists;
  const painFlagScore = pain?.pain_flag?.score;
  const painFlagTime = pain?.pain_flag?.time;
  const queueExists = queue?.exists;
  const pendingCount = queue?.status_counts?.pending ?? 0;
  const completedCount = queue?.status_counts?.completed ?? 0;
  const inProgressCount = queue?.status_counts?.in_progress ?? 0;
  const staleCount = queue?.stale_tasks?.length ?? 0;
  const heartbeatHasTask = diag?.heartbeat?.contains_evolution_task;
  const completionMarkers24h = diag?.completion_markers?.count_24h ?? 0;
  const streamExists = stream?.exists;
  const streamEvents7d = stream?.events_7d ?? 0;
  const principleCount = principles?.principles_md?.principle_count ?? 0;
  const candidateCount = principles?.pain_candidates?.count ?? 0;
  const dictRuleCount = principles?.pain_dictionary?.rule_count ?? 0;
  const scorecardExists = evoState?.evolution_scorecard?.exists;

  // R1: Pain flag exists but no queue items enqueued after it
  // Code path: checkPainFlag() reads .pain_flag → creates queue item
  // If pain_flag has score >= 30 and status != 'queued', but queue is empty
  // → Worker not polling or not running
  if (painFlagExists && painFlagScore >= 30) {
    const flagStatus = pain?.pain_flag?.status;
    if (flagStatus !== 'queued' && (!queueExists || pendingCount === 0)) {
      breakpoints.push({
        confidence: 'medium',
        stage: 'worker_polling',
        evidence: `Pain flag exists (score=${painFlagScore}, status=${flagStatus || 'none'}) but queue has no pending tasks`,
        suggestion: 'Evolution Worker may not be running. Check if plugin is loaded. Default poll interval is 15min (intervals.worker_poll_ms).',
      });
    }
  }

  // R2: Queue has completed tasks but no principles in stream or PRINCIPLES.md
  // Code path: processEvolutionQueue → writes HEARTBEAT → subagent creates marker → 
  //   processEvolutionQueue detects marker → marks completed
  // But principle creation requires subagent to call createPrincipleFromDiagnosis()
  // If completed > 0 but principles = 0 → diagnosis ran but principle not written
  if (completedCount > 0 && principleCount === 0 && (!streamExists || streamEvents7d === 0)) {
    breakpoints.push({
      confidence: 'high',
      stage: 'principle_creation',
      evidence: `${completedCount} completed queue tasks but 0 principles in PRINCIPLES.md and 0 stream events in 7d`,
      suggestion: 'Diagnostician completed but did not create principles. Check if subagent output format matches createPrincipleFromDiagnosis() expectations. HEARTBEAT.md instructs subagent to write PRINCIPLES.md and create marker file.',
    });
  }

  // R3: Queue has pending items + pain_flag exists but nothing in_progress
  // Code path: processEvolutionQueue picks highest-score pending task → writes HEARTBEAT → marks in_progress
  // If pending > 0 but in_progress = 0 → Worker hasn't picked up the task yet
  if (pendingCount > 0 && inProgressCount === 0 && painFlagExists) {
    breakpoints.push({
      confidence: 'medium',
      stage: 'task_dispatch',
      evidence: `${pendingCount} pending queue tasks, 0 in_progress, pain_flag exists`,
      suggestion: 'Worker may be running but has not yet processed the queue (poll interval: 15min). Or Worker crashed after writing queue but before marking in_progress.',
    });
  }

  // R4: HEARTBEAT has task but no completion marker and task is old
  // Code path: Worker writes HEARTBEAT.md → heartbeat hook triggers subagent_spawn →
  //   subagent runs diagnostician protocol → creates .evolution_complete_{id} marker
  // If HEARTBEAT has task but no completion → subagent didn't complete
  if (heartbeatHasTask && completionMarkers24h === 0 && staleCount > 0) {
    breakpoints.push({
      confidence: 'high',
      stage: 'diagnostician_execution',
      evidence: `HEARTBEAT.md contains evolution task but no completion markers in 24h and ${staleCount} stale tasks`,
      suggestion: 'Subagent (diagnostician) was spawned but did not complete. Possible causes: 1) subagent_ended hook not firing, 2) subagent timeout, 3) HEARTBEAT hook not triggering subagent spawn. Check OpenClaw Gateway logs for subagent spawn events.',
    });
  }

  // R5: Stream has candidate_created events but no active principles
  // Code path: EvolutionReducer.createPrincipleFromDiagnosis() → emits candidate_created →
  //   auto-promote(principleId, 'diagnostician_generalized') → principle_promoted event
  // If candidates exist in stream but active = 0 → promotion failed or principles deprecated
  if (streamExists && streamEvents7d > 0) {
    const hasCandidateCreated = stream?.event_type_distribution?.['candidate_created'] > 0;
    const hasPrinciplePromoted = stream?.event_type_distribution?.['principle_promoted'] > 0;
    if (hasCandidateCreated && !hasPrinciplePromoted) {
      breakpoints.push({
        confidence: 'high',
        stage: 'principle_promotion',
        evidence: `Stream has candidate_created events but no principle_promoted events in 7d`,
        suggestion: 'Principles created but auto-promotion failed. Check EvolutionReducer.promote() — requires principle to exist in memory map. Possible cause: stream replay lost in-memory state, or principle was deprecated (conflict_detected or probation_expired).',
      });
    }
  }

  // R6: Pain candidates exist but none promoted to dictionary rules
  // Code path: trackPainCandidate() → pain_candidates.json → processPromotion() when count >= threshold (default 3)
  // If candidates > 0 but dict rules not growing → promotion not running or threshold not met
  if (candidateCount > 0 && dictRuleCount > 0) {
    const pendingCandidates = Object.values(principles?.pain_candidates?.candidates || {})
      .filter((c: any) => c.status === 'pending' && c.count >= 3).length;
    if (pendingCandidates > 0) {
      breakpoints.push({
        confidence: 'medium',
        stage: 'candidate_promotion',
        evidence: `${pendingCandidates} pain candidates meet promotion threshold (count>=3) but not yet promoted to dictionary rules`,
        suggestion: 'processPromotion() runs on Worker cycle. May not have executed yet, or extractCommonSubstring() failed to find common phrases in candidate samples.',
      });
    }
  }

  // R7: Pain exists + queue completed + principles exist but scorecard missing
  // Code path: recordEvolutionSuccess/Failure() writes to evolution-scorecard.json
  // If principles exist but no scorecard → EvolutionEngine not initialized or workspace using old version
  if (principleCount > 0 && !scorecardExists) {
    breakpoints.push({
      confidence: 'low',
      stage: 'scorecard_tracking',
      evidence: `${principleCount} principles in PRINCIPLES.md but no evolution-scorecard.json`,
      suggestion: 'EvolutionEngine (V2 scoring) may not be initialized for this workspace. Scorecard is created on first tool call. Check if EvolutionWorkerService.start() was called.',
    });
  }

  // R8: End-to-end chain health
  // If pain exists AND queue exists AND completed > 0 AND principles > 0 → chain is working
  if (painFlagExists && queueExists && completedCount > 0 && principleCount > 0) {
    // Chain is functional — no breakpoint
  } else if (painFlagExists && queueExists && completedCount === 0 && principleCount === 0) {
    breakpoints.push({
      confidence: 'high',
      stage: 'end_to_end_chain',
      evidence: `Pain detected and queued (${pendingCount} pending) but 0 completed tasks and 0 principles — entire chain stalled`,
      suggestion: 'The full Pain→Principle chain is not producing output. Most likely break point: Evolution Worker not running, or HEARTBEAT hook not triggering subagent spawn.',
    });
  }

  return breakpoints;
}

// ─── Anomaly Detection ──────────────────────────────────────────────

function detectAnomalies(report: HealthReport): Array<{ severity: 'warning' | 'critical'; message: string }> {
  const anomalies: Array<{ severity: 'warning' | 'critical'; message: string }> = [];

  // 1. Stale tasks
  const queue = report.stages.evolution_queue as Record<string, any>;
  if (queue?.stale_tasks?.length > 0) {
    for (const task of queue.stale_tasks) {
      anomalies.push({
        severity: 'warning',
        message: `Task ${task.id} in_progress for ${task.age_minutes}min (threshold: 30min)`,
      });
    }
  }

  // 2. Queue backlog
  if (queue?.status_counts?.pending > 10) {
    anomalies.push({
      severity: 'warning',
      message: `Queue backlog: ${queue.status_counts.pending} pending tasks (threshold: 10)`,
    });
  }

  // 3. Pain signal spike
  const pain = report.stages.pain_signal as Record<string, any>;
  if (pain?.trajectory_db?.pain_events_24h > 50) {
    anomalies.push({
      severity: 'critical',
      message: `Pain signal spike: ${pain.trajectory_db.pain_events_24h} events in 24h (threshold: 50)`,
    });
  }

  // 4. Zero principle growth
  const principles = report.stages.principles as Record<string, any>;
  const stream = principles?.evolution_stream;
  if (stream && stream.exists && stream.events_7d === 0) {
    anomalies.push({
      severity: 'warning',
      message: 'Zero principle growth: no evolution events in 7 days',
    });
  }

  // 5. No active principles
  if (principles?.principles_md?.exists && principles.principles_md.principle_count === 0) {
    anomalies.push({
      severity: 'warning',
      message: 'No principles in PRINCIPLES.md — evolution may not be producing output',
    });
  }

  // 6. Heartbeat contains task but no completion markers recently
  const diagnostician = report.stages.diagnostician as Record<string, any>;
  if (diagnostician?.heartbeat?.contains_evolution_task && diagnostician.completion_markers?.count_24h === 0) {
    anomalies.push({
      severity: 'warning',
      message: 'Evolution task in HEARTBEAT.md but no completion markers in 24h',
    });
  }

  // 7. Unknown files
  if (report.unknown_files.length > 5) {
    anomalies.push({
      severity: 'warning',
      message: `${report.unknown_files.length} unknown files in .state/ — may indicate undocumented state`,
    });
  }

  // 8. Double rewards never earned
  const evoState = report.stages.evolution_state as Record<string, any>;
  if (evoState?.evolution_scorecard?.exists && evoState.evolution_scorecard.double_rewards_earned === 0) {
    anomalies.push({
      severity: 'warning',
      message: 'doubleRewardsEarned = 0 — failure→success loop may not be tracked correctly',
    });
  }

  return anomalies;
}

// ─── Markdown Summary Generator ─────────────────────────────────────

function generateMarkdown(report: HealthReport, prevReport: HealthReport | null): string {
  const lines: string[] = [];
  const ts = new Date(report.timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  lines.push(`# Pipeline Health Report`);
  lines.push('');
  lines.push(`**时间:** ${ts}`);
  lines.push(`**工作区:** \`${report.workspace}\``);
  lines.push('');

  // Trend comparison
  if (prevReport) {
    lines.push('## 趋势对比 (vs 上次报告)');
    lines.push('');
    const prevStages = prevReport.stages;
    const currStages = report.stages;

    const trends: string[][] = [];

    // Pain events
    const currPain = (currStages.pain_signal as any)?.trajectory_db;
    const prevPain = (prevStages.pain_signal as any)?.trajectory_db;
    if (currPain && prevPain) {
      trends.push(['Pain events (24h)', currPain.pain_events_24h, prevPain.pain_events_24h]);
      trends.push(['Pain events (7d)', currPain.pain_events_7d, prevPain.pain_events_7d]);
    }

    // Queue
    const currQueue = currStages.evolution_queue as any;
    const prevQueue = prevStages.evolution_queue as any;
    if (currQueue && prevQueue) {
      trends.push(['Queue total', currQueue.total_items ?? 0, prevQueue.total_items ?? 0]);
      trends.push(['Queue pending', currQueue.status_counts?.pending ?? 0, prevQueue.status_counts?.pending ?? 0]);
      trends.push(['Queue stale', (currQueue.stale_tasks?.length ?? 0), (prevQueue.stale_tasks?.length ?? 0)]);
    }

    // Principles
    const currPrinciples = currStages.principles as any;
    const prevPrinciples = prevStages.principles as any;
    if (currPrinciples && prevPrinciples) {
      trends.push(['Principles in PRINCIPLES.md', currPrinciples.principles_md?.principle_count ?? 0, prevPrinciples.principles_md?.principle_count ?? 0]);
      trends.push(['Evolution events (7d)', currPrinciples.evolution_stream?.events_7d ?? 0, prevPrinciples.evolution_stream?.events_7d ?? 0]);
    }

    // Scorecard
    const currEvo = currStages.evolution_state as any;
    const prevEvo = prevStages.evolution_state as any;
    if (currEvo && prevEvo) {
      trends.push(['Evolution points', currEvo.evolution_scorecard?.total_points ?? 0, prevEvo.evolution_scorecard?.total_points ?? 0]);
    }

    for (const [label, curr, prev] of trends) {
      const diff = (curr as number) - (prev as number);
      const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '→';
      lines.push(`- **${label}**: ${curr} ${arrow} (上次: ${prev})`);
    }
    lines.push('');
  }

  // Stage overview
  lines.push('## 阶段状态');
  lines.push('');
  lines.push('| 阶段 | 状态 | 详情 |');
  lines.push('|------|------|------|');

  const pain = report.stages.pain_signal as any;
  const painFlagStatus = pain?.pain_flag?.exists ? '✅' : '❌';
  const pf = pain?.pain_flag;
  let painFlagDetail = '无 pain_flag';
  if (pf?.exists) {
    if (pf.format === 'markdown') {
      painFlagDetail = `source=${pf.source}, time=${pf.time}`;
    } else {
      painFlagDetail = `score=${pf.score}, source=${pf.source}`;
    }
  }
  lines.push(`| Pain 信号 | ${painFlagStatus} | ${painFlagDetail} |`);

  // Evolution queue
  const queue = report.stages.evolution_queue as any;
  const queueStatus = queue?.exists ? (queue.stale_tasks?.length > 0 ? '⚠️' : '✅') : '❌';
  const queueDetail = queue?.exists ? `total=${queue.total_items}, pending=${queue.status_counts?.pending ?? 0}, stale=${queue.stale_tasks?.length ?? 0}` : '无 queue';
  lines.push(`| Evolution Queue | ${queueStatus} | ${queueDetail} |`);

  // Diagnostician
  const diag = report.stages.diagnostician as any;
  const diagStatus = diag?.heartbeat?.contains_evolution_task ? '⚠️' : (diag?.completion_markers?.count_24h > 0 ? '✅' : '—');
  const diagDetail = diag?.heartbeat?.contains_evolution_task ? `task=${diag.heartbeat.task_id}` : `completions_24h=${diag?.completion_markers?.count_24h ?? 0}`;
  lines.push(`| 诊断触发 | ${diagStatus} | ${diagDetail} |`);

  // Principles
  const principles = report.stages.principles as any;
  const principleStatus = principles?.principles_md?.principle_count > 0 ? '✅' : '⚠️';
  const principleDetail = principles?.principles_md?.exists ? `count=${principles.principles_md.principle_count}, stream_7d=${principles.evolution_stream?.events_7d ?? 0}` : '无 PRINCIPLES.md';
  lines.push(`| 原则存储 | ${principleStatus} | ${principleDetail} |`);

  // Evolution state
  const evoState = report.stages.evolution_state as any;
  const evoStatus = evoState?.evolution_scorecard?.exists ? '✅' : '❌';
  const evoDetail = evoState?.evolution_scorecard?.exists ? `points=${evoState.evolution_scorecard.total_points ?? 0}, tier=${evoState.evolution_scorecard.tier ?? '?'}` : '无 scorecard';
  lines.push(`| 进化状态 | ${evoStatus} | ${evoDetail} |`);

  // Nocturnal
  const nocturnal = report.stages.nocturnal as any;
  const nocturnalStatus = nocturnal?.exists ? '✅' : '—';
  const nocturnalDetail = nocturnal?.exists ? `samples=${nocturnal.samples?.file_count ?? 0}, memory=${nocturnal.memory?.file_count ?? 0}` : '未启用';
  lines.push(`| Nocturnal 系统 | ${nocturnalStatus} | ${nocturnalDetail} |`);

  lines.push('');

  // Anomalies
  if (report.anomalies.length > 0) {
    lines.push('## 异常检测');
    lines.push('');
    for (const a of report.anomalies) {
      const icon = a.severity === 'critical' ? '🔴' : '🟡';
      lines.push(`- ${icon} **${a.severity}**: ${a.message}`);
    }
    lines.push('');
  }

  // Unknown files
  if (report.unknown_files.length > 0) {
    lines.push('## 未知文件 (⚠️ 可能需要补充采集规则)');
    lines.push('');
    lines.push('| 文件 | 大小 | 最后修改 |');
    lines.push('|------|------|---------|');
    const scan = report.stages.carpet_scan as any;
    for (const uf of report.unknown_files) {
      const fileInfo = scan?.files?.find((f: any) => f.name === uf);
      const size = fileInfo ? `${(fileInfo.size / 1024).toFixed(1)}KB` : '?';
      const mtime = fileInfo?.mtime ? fileInfo.mtime.slice(0, 19) : '?';
      lines.push(`| \`${uf}\` | ${size} | ${mtime} |`);
    }
    lines.push('');
  }

  if (report.inferred_breakpoints.length > 0) {
    lines.push('## 推断断裂点');
    lines.push('');
    lines.push('| 置信度 | 阶段 | 证据 | 建议 |');
    lines.push('|--------|------|------|------|');
    for (const bp of report.inferred_breakpoints) {
      const icon = bp.confidence === 'high' ? '🔴' : bp.confidence === 'medium' ? '🟡' : '⚪';
      lines.push(`| ${icon} ${bp.confidence} | ${bp.stage} | ${bp.evidence} | ${bp.suggestion} |`);
    }
    lines.push('');
  }

  // Raw data reference
  lines.push('---');
  lines.push('');
  lines.push(`> 完整 JSON 数据: \`health-reports/${path.basename(report.timestamp.replace(/[:.]/g, '-'))}.json\``);

  return lines.join('\n');
}

function runSingleWorkspace(workspace: string, prevReport: HealthReport | null): { workspace: string; report: HealthReport; jsonPath: string; mdPath: string } {
  const stateDir = path.join(workspace, '.state');
  const reportDir = path.join(stateDir, 'health-reports');

  if (!dirExists(stateDir)) {
    throw new Error(`.state directory not found at ${stateDir}`);
  }

  if (!dirExists(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timestamp = now.toISOString();

  const scan = carpetScan(stateDir);
  const painSignal = collectPainSignal(stateDir);
  const evolutionQueue = collectEvolutionQueue(stateDir);
  const diagnostician = collectDiagnostician(stateDir);
  const principles = collectPrinciples(stateDir, workspace);
  const evolutionState = collectEvolutionState(stateDir);
  const nocturnal = collectNocturnal(stateDir);

  const report: HealthReport = {
    timestamp,
    workspace,
    stages: {
      carpet_scan: {
        total_files: scan.files.length,
        known_files: scan.files.filter(f => f.known).length,
        unknown_files: scan.unknown.length,
        files: scan.files,
      },
      pain_signal: painSignal,
      evolution_queue: evolutionQueue,
      diagnostician,
      principles,
      evolution_state: evolutionState,
      nocturnal,
    },
    unknown_files: scan.unknown,
    anomalies: [],
  };

  report.anomalies = detectAnomalies(report);
  report.inferred_breakpoints = inferBreakpoints(report);

  const jsonPath = path.join(reportDir, `${dateStr}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');

  const mdContent = generateMarkdown(report, prevReport);
  const mdPath = path.join(reportDir, `${dateStr}.md`);
  fs.writeFileSync(mdPath, mdContent, 'utf8');

  return { workspace, report, jsonPath, mdPath };
}

function generateAggregateMarkdown(reports: Array<{ workspace: string; report: HealthReport }>, dateStr: string): string {
  const lines: string[] = [];
  const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  lines.push(`# 多智能体 Pipeline 健康报告`);
  lines.push('');
  lines.push(`**时间:** ${ts}`);
  lines.push(`**智能体数量:** ${reports.length}`);
  lines.push('');

  lines.push('## 总览');
  lines.push('');
  lines.push('| 智能体 | Pain | Queue | 诊断 | 原则 | 积分 | Tier | 异常 |');
  lines.push('|--------|------|-------|------|------|------|------|------|');

  for (const { workspace, report } of reports) {
    const name = path.basename(workspace);
    const pain = (report.stages.pain_signal as any)?.pain_flag?.exists ? '✅' : '❌';
    const queue = (report.stages.evolution_queue as any)?.exists ? '✅' : '❌';
    const diag = (report.stages.diagnostician as any)?.heartbeat?.contains_evolution_task ? '⚠️' : '—';
    const principles = (report.stages.principles as any)?.principles_md?.principle_count ?? 0;
    const points = (report.stages.evolution_state as any)?.evolution_scorecard?.total_points ?? 0;
    const tier = (report.stages.evolution_state as any)?.evolution_scorecard?.tier ?? '?';
    const anomalyCount = report.anomalies.length;
    const anomalyIcon = anomalyCount > 0 ? `🟡${anomalyCount}` : '✅';

    lines.push(`| ${name} | ${pain} | ${queue} | ${diag} | ${principles} | ${points} | ${tier} | ${anomalyIcon} |`);
  }

  lines.push('');

  const allAnomalies: Array<{ workspace: string; severity: string; message: string }> = [];
  for (const { workspace, report } of reports) {
    const name = path.basename(workspace);
    for (const a of report.anomalies) {
      allAnomalies.push({ workspace: name, severity: a.severity, message: a.message });
    }
  }

  if (allAnomalies.length > 0) {
    lines.push('## 全部异常');
    lines.push('');
    for (const a of allAnomalies) {
      const icon = a.severity === 'critical' ? '🔴' : '🟡';
      lines.push(`- ${icon} **[${a.workspace}]** ${a.message}`);
    }
    lines.push('');
  }

  const allUnknown: Array<{ workspace: string; file: string }> = [];
  for (const { workspace, report } of reports) {
    const name = path.basename(workspace);
    for (const f of report.unknown_files) {
      allUnknown.push({ workspace: name, file: f });
    }
  }

  if (allUnknown.length > 0) {
    lines.push('## 未知文件');
    lines.push('');
    lines.push('| 智能体 | 文件 |');
    lines.push('|--------|------|');
    for (const u of allUnknown) {
      lines.push(`| ${u.workspace} | \`${u.file}\` |`);
    }
    lines.push('');
  }

  lines.push('## 详细报告');
  lines.push('');
  for (const { workspace } of reports) {
    const name = path.basename(workspace);
    lines.push(`- [${name}](${workspace}/.state/health-reports/${dateStr}.md)`);
  }
  lines.push('');

  return lines.join('\n');
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  if (args.all) {
    const openclawDir = args.openclawDir || path.join(process.env.HOME || '', '.openclaw');
    const workspaces = discoverWorkspaces(openclawDir);

    if (workspaces.length === 0) {
      console.error(`No workspace-* directories found in ${openclawDir}`);
      process.exit(1);
    }

    console.log(`Discovered ${workspaces.length} workspaces:`);
    for (const w of workspaces) {
      console.log(`  - ${path.basename(w)}`);
    }
    console.log('');

    const results: Array<{ workspace: string; report: HealthReport; jsonPath: string; mdPath: string }> = [];
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);

    for (const workspace of workspaces) {
      const stateDir = path.join(workspace, '.state');
      if (!dirExists(stateDir)) {
        console.log(`  ⏭ ${path.basename(workspace)}: no .state directory, skipping`);
        continue;
      }

      const reportDir = path.join(stateDir, 'health-reports');
      let prevReport: HealthReport | null = null;
      try {
        if (dirExists(reportDir)) {
          const reportFiles = fs.readdirSync(reportDir)
            .filter(f => f.endsWith('.json') && f !== `${dateStr}.json`)
            .sort()
            .reverse();
          if (reportFiles.length > 0) {
            prevReport = safeReadJson<HealthReport>(path.join(reportDir, reportFiles[0]));
          }
        }
      } catch { /* no previous report */ }

      try {
        const result = runSingleWorkspace(workspace, prevReport);
        results.push(result);
        console.log(`  ✅ ${path.basename(workspace)}: ${result.report.anomalies.length} anomalies, ${result.report.unknown_files.length} unknown files`);
      } catch (err) {
        console.log(`  ❌ ${path.basename(workspace)}: ${String(err)}`);
      }
    }

    if (results.length > 0) {
      const aggregateDir = path.join(openclawDir, 'health-reports');
      if (!dirExists(aggregateDir)) {
        fs.mkdirSync(aggregateDir, { recursive: true });
      }

      const aggregateMd = generateAggregateMarkdown(results, dateStr);
      const aggregatePath = path.join(aggregateDir, `${dateStr}.md`);
      fs.writeFileSync(aggregatePath, aggregateMd, 'utf8');
      console.log(`\nAggregate report: ${aggregatePath}`);

      const aggregateJson = {
        timestamp: new Date().toISOString(),
        workspace_count: results.length,
        workspaces: results.map(r => ({
          name: path.basename(r.workspace),
          path: r.workspace,
          anomalies: r.report.anomalies.length,
          unknown_files: r.report.unknown_files.length,
          pain_flag: (r.report.stages.pain_signal as any)?.pain_flag?.exists ?? false,
          queue_exists: (r.report.stages.evolution_queue as any)?.exists ?? false,
          principle_count: (r.report.stages.principles as any)?.principles_md?.principle_count ?? 0,
          evolution_points: (r.report.stages.evolution_state as any)?.evolution_scorecard?.total_points ?? 0,
          tier: (r.report.stages.evolution_state as any)?.evolution_scorecard?.tier ?? null,
        })),
      };
      const aggregateJsonPath = path.join(aggregateDir, `${dateStr}.json`);
      fs.writeFileSync(aggregateJsonPath, JSON.stringify(aggregateJson, null, 2), 'utf8');
    }

    console.log('');
    console.log('=== Multi-Agent Summary ===');
    console.log(`Workspaces scanned: ${results.length}/${workspaces.length}`);
    const totalAnomalies = results.reduce((sum, r) => sum + r.report.anomalies.length, 0);
    const totalUnknown = results.reduce((sum, r) => sum + r.report.unknown_files.length, 0);
    console.log(`Total anomalies: ${totalAnomalies}`);
    console.log(`Total unknown files: ${totalUnknown}`);
  } else if (args.workspace) {
    const stateDir = path.join(args.workspace, '.state');
    const reportDir = path.join(stateDir, 'health-reports');
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);

    let prevReport: HealthReport | null = null;
    try {
      if (dirExists(reportDir)) {
        const reportFiles = fs.readdirSync(reportDir)
          .filter(f => f.endsWith('.json') && f !== `${dateStr}.json`)
          .sort()
          .reverse();
        if (reportFiles.length > 0) {
          prevReport = safeReadJson<HealthReport>(path.join(reportDir, reportFiles[0]));
        }
      }
    } catch { /* no previous report */ }

    const { report, jsonPath, mdPath } = runSingleWorkspace(args.workspace, prevReport);

    console.log(`JSON report: ${jsonPath}`);
    console.log(`Markdown summary: ${mdPath}`);
    console.log('');
    console.log('=== Pipeline Health Summary ===');
    console.log(`Timestamp: ${report.timestamp}`);
    console.log(`Workspace: ${report.workspace}`);
    const scan = report.stages.carpet_scan as any;
    console.log(`Files scanned: ${scan.total_files} (${scan.known_files} known, ${scan.unknown_files} unknown)`);
    const painSignal = report.stages.pain_signal as any;
    console.log(`Pain flag: ${painSignal.pain_flag.exists ? '✅' : '❌'}`);
    const evolutionQueue = report.stages.evolution_queue as any;
    console.log(`Queue: ${evolutionQueue.exists ? `${evolutionQueue.total_items} items` : '❌ not found'}`);
    const principles = report.stages.principles as any;
    console.log(`Principles: ${principles.principles_md.principle_count ?? 0} in PRINCIPLES.md`);
    console.log(`Anomalies: ${report.anomalies.length}`);
    if (report.anomalies.length > 0) {
      for (const a of report.anomalies) {
        console.log(`  ${a.severity === 'critical' ? '🔴' : '🟡'} ${a.message}`);
      }
    }
    if (report.unknown_files.length > 0) {
      console.log(`Unknown files: ${report.unknown_files.slice(0, 5).join(', ')}${report.unknown_files.length > 5 ? ` (+${report.unknown_files.length - 5} more)` : ''}`);
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
