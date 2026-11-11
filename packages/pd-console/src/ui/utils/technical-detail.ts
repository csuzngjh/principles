/**
 * Technical detail — keeps engineering strings out of the Owner-facing UI.
 *
 * SPEC-PD-UIUX-002 §4.1 (1A 语言层收口). Root cause fixed here: the console
 * rendered runtime-produced strings verbatim, so an Owner could read
 *
 *   Run: pd runtime internalization run-once --workspace "C:\Users\张三\AppData\..."
 *
 * on the behavior-evidence page. That is a machine instruction plus an absolute
 * path — neither belongs on a decision surface.
 *
 * Design constraints:
 * - Pure functions, no I/O, no DOM (directly unit-testable).
 * - Never hides information: every masked/summarized value is still available
 *   for the "技术详情" disclosure, just not in the reading path.
 * - Never guesses: unrecognised text is returned unchanged.
 */

export interface CommandSummary {
  /** Short, human sentence describing what the command does. */
  summary: string;
  /** The original command, for the technical-detail disclosure. */
  command: string;
}

/** `pd runtime internalization run-once ...` → what it means for the Owner. */
const COMMAND_SUMMARIES: readonly { match: RegExp; summary: string }[] = [
  { match: /^pd\s+runtime\s+internalization\s+run-once/i, summary: '继续处理这条候选（手动推进一次）' },
  { match: /^pd\s+runtime\s+internalization/i, summary: '推进原则内化' },
  { match: /^pd\s+runtime\s+diagnos/i, summary: '运行一次诊断' },
  { match: /^pd\s+intent\s+init/i, summary: '初始化拥有者意图' },
  { match: /^pd\s+update/i, summary: '更新 PD' },
  { match: /^pd\s+/i, summary: '运行一条 PD 维护命令' },
  { match: /^npx\s+/i, summary: '运行一条工具命令' },
  { match: /^node\s+/i, summary: '运行一个本地脚本' },
];

/** A leading `Run:` / `运行：` label, English or Chinese, is always stripped. */
const COMMAND_LABEL = /^\s*(?:run|运行|执行|command)\s*[:：]\s*/i;

/** Windows drive path, POSIX absolute path, or UNC path. */
const ABSOLUTE_PATH = /(?:[A-Za-z]:\\|\\\\|\/(?:Users|home|tmp|var|private|workspace)\/)/;

/** Anything that reads as "a sentence in English" rather than a label. */
const ENGLISH_SENTENCE = /[A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z'’-]+){3,}/;

/**
 * Mask the privacy-bearing segments of a path.
 *
 * The Owner persona (a single human) must not see another machine's user name
 * or a random temporary directory in a reading surface. The path shape stays
 * recognisable so the Owner can still tell "this is a local file".
 */
export function maskPath(input: string): string {
  let output = input;
  // C:\Users\<name>\... → C:\Users\***\...
  output = output.replace(/([A-Za-z]:\\Users\\)([^\\]+)/, '$1***');
  // /Users/<name>/... and /home/<name>/... → ***
  output = output.replace(/(\/(?:Users|home)\/)([^/]+)/, '$1***');
  // Temp directories carry a random token: ...\Temp\a1b2c3d4\... → ...\Temp\***\...
  output = output.replace(/([\\/](?:Temp|tmp)[\\/])([^\\/]+)/gi, '$1***');
  return output;
}

/** True when the text contains an absolute path (masked or not). */
export function containsAbsolutePath(input: string): boolean {
  return ABSOLUTE_PATH.test(input);
}

/**
 * Recognize a shell command and describe it in one human sentence.
 *
 * Returns `null` when the text is not a command — callers then render the text
 * unchanged, so this never swallows normal prose.
 */
export function summarizeCommand(input: string): CommandSummary | null {
  const trimmed = input.trim().replace(COMMAND_LABEL, '');
  if (trimmed === '') return null;
  const firstLine = trimmed.split(/\r?\n/)[0] ?? '';
  for (const entry of COMMAND_SUMMARIES) {
    if (entry.match.test(firstLine)) {
      return { summary: entry.summary, command: input.trim() };
    }
  }

  // Runtime messages often wrap the command in prose:
  //   "Candidate generated. Waiting for internalization pipeline. Run: pd runtime …"
  // The command still has to be recognised, otherwise the whole sentence leaks.
  const embedded = firstLine.search(/\b(?:pd|npx|node)\s+\S/);
  if (embedded > 0) {
    const candidate = firstLine.slice(embedded);
    for (const entry of COMMAND_SUMMARIES) {
      if (entry.match.test(candidate)) {
        return { summary: entry.summary, command: input.trim() };
      }
    }
  }
  return null;
}

/**
 * True when a string is machine-facing rather than Owner-facing.
 *
 * Used to decide between "show it" and "show a summary + technical disclosure".
 * Deliberately conservative: ids and codes are NOT technical text here — they
 * go through the enum/date formatters instead.
 */
export function isTechnicalText(input: string): boolean {
  const value = input.trim();
  if (value === '') return false;
  if (COMMAND_LABEL.test(value)) return true;
  if (summarizeCommand(value) !== null) return true;
  if (containsAbsolutePath(value)) return true;
  // A bare stack frame.
  if (/\bat\s+\S+\s+\([^)]*:\d+:\d+\)/.test(value)) return true;
  // A URL is technical, but only when it is not the whole readable sentence.
  if (/^https?:\/\/\S+$/.test(value)) return true;
  return false;
}

/** True when the text is an untranslated English sentence (3+ words). */
export function looksLikeEnglishSentence(input: string): boolean {
  const value = input.trim();
  if (value === '') return false;
  // Strip obvious technical fragments before judging sentence-ness.
  const withoutPaths = value.replace(/\S*[\\/]\S*/g, ' ');
  return ENGLISH_SENTENCE.test(withoutPaths);
}

export interface HumanizedText {
  /** What the reading surface shows. */
  text: string;
  /** Original machine text, shown only inside a technical disclosure. */
  technical: string | null;
}

/**
 * Server-produced reasons that reach the UI verbatim. These are not "untranslated
 * sentences" in the i18n sense — they are the runtime's own words, so they are
 * mapped here rather than duplicated into every locale file.
 */
const KNOWN_REASON_LABELS: readonly { match: RegExp; text: string }[] = [
  { match: /failed to fetch|fetch failed|networkerror|load failed|econnrefused|econnreset|network request failed/i, text: '控制台服务没有响应' },
  { match: /trajectory database not found/i, text: '行为轨迹库尚未建立，目前没有可展示的证据' },
  { match: /database not found/i, text: '本地数据尚未建立' },
  { match: /no verified owner identity/i, text: '还没有验证拥有者身份' },
  { match: /verified owner identity is required/i, text: '需要先验证拥有者身份' },
  { match: /workspace not (?:found|initiali[sz]ed)/i, text: '工作区尚未初始化' },
  { match: /principle ledger (?:unavailable|not found)/i, text: '原则账本暂时不可用' },
  { match: /permission denied|eacces/i, text: '没有读取权限' },
  { match: /not found/i, text: '相关数据尚未建立' },
];

/** Map a known runtime reason to an Owner-facing Chinese sentence, else `null`. */
export function localizeKnownReason(input: string): string | null {
  const value = input.trim();
  if (value === '') return null;
  for (const entry of KNOWN_REASON_LABELS) {
    if (entry.match.test(value)) return entry.text;
  }
  return null;
}

/**
 * One entry point for rendering a runtime-produced string.
 *
 * - known runtime reason → Owner-facing Chinese sentence
 * - command → summary sentence + original in `technical`
 * - absolute path → masked path
 * - otherwise → unchanged, `technical: null`
 */
export function humanizeRuntimeText(input: string, summaryFallback = '这条内容属于技术细节'): HumanizedText {
  const known = localizeKnownReason(input);
  if (known !== null) {
    return { text: known, technical: input.trim() === known ? null : input };
  }
  const command = summarizeCommand(input);
  if (command) {
    return { text: command.summary, technical: command.command };
  }
  if (containsAbsolutePath(input)) {
    return { text: maskPath(input), technical: input };
  }
  if (looksLikeEnglishSentence(input)) {
    return { text: summaryFallback, technical: input };
  }
  return { text: input, technical: null };
}
