/**
 * bash-risk.ts — PRI-1047/R8: 宿主 bash 命令风险分类的单一实现（P4）。
 *
 * 契约（SPEC-PRI-1047 §R8 修订，Owner 评审 2026-10-27）：
 *   safe     = 正面证据确认整条命令链只读（显式只读白名单 + 参数形状核验
 *              + 结构核验：管道/组合/换行/重定向/命令替换全部确认）。
 *   normal   = 确认发生变更（已知变更命令/子命令、写文件选项、输出重定向、
 *              内联任意代码执行）。
 *   dangerous= 确认高破坏性变更（rm -rf / chmod / chown）。
 *   unknown  = 无法可靠解释（未识别命令/子命令/全局选项、不支持的结构、
 *              解释器执行不可分析输入）。unknown 不获得只读豁免，
 *              但与审批事实 unknown/missing 的中性降级是两个概念。
 *
 * 能力边界（如实声明，不假装完整 shell 语义）：
 *   - 仅 POSIX 风格 tokenizer（单/双引号、结构算子、重定向、$()/``）；
 *     不实现变量展开、glob 语义、进程替换（>(  <( → unknown）。
 *   - 只读是显式白名单子集；清单外的命令一律 unknown（不是 safe）。
 *   - git 仅识别显式全局选项集；未识别的子命令前选项 → unknown。
 *   - 命令替换递归深度上限 3。
 *
 * 三方共用（保持零调用方改动）：host-runtime 生产 gate（无 provider 时的
 * 确定性默认）、OpenClaw 插件 enrichment、golden-trace 回放推导。
 */

export type BashRiskLevel = 'safe' | 'normal' | 'dangerous' | 'unknown';

// ── 结构层 tokenizer ─────────────────────────────────────────────────────────

/** 引号感知的 tokenizer；无法解析（引号未闭合等）返回 null。 */
function tokenize(input: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let hasCurrent = false;
  let i = 0;
  const n = input.length;
  let state: 'plain' | 'single' | 'double' = 'plain';
  while (i < n) {
    const ch = input[i];
    if (ch === undefined) break;
    if (state === 'single') {
      if (ch === "'") state = 'plain';
      else current += ch;
      i += 1;
      continue;
    }
    if (state === 'double') {
      if (ch === '"') state = 'plain';
      else if (ch === '\\' && i + 1 < n && '"\\$`'.includes(input[i + 1] ?? '')) {
        current += input[i + 1] ?? '';
        i += 2;
        continue;
      } else current += ch;
      i += 1;
      continue;
    }
    if (ch === "'") {
      state = 'single';
      hasCurrent = true;
      i += 1;
      continue;
    }
    if (ch === '"') {
      state = 'double';
      hasCurrent = true;
      i += 1;
      continue;
    }
    if (ch === '\\' && i + 1 < n) {
      current += input[i + 1] ?? '';
      hasCurrent = true;
      i += 2;
      continue;
    }
    if (' \t\r\n'.includes(ch)) {
      if (hasCurrent || current) {
        tokens.push(current);
        current = '';
        hasCurrent = false;
      }
      i += 1;
      continue;
    }
    // Structural operators become standalone tokens (newline included).
    if ('|;&<>()'.includes(ch)) {
      if (hasCurrent || current) {
        tokens.push(current);
        current = '';
        hasCurrent = false;
      }
      let op: string = ch;
      const next = input[i + 1];
      if ((ch === '|' || ch === '&' || ch === '>' || ch === '<') && next === ch) op += next;
      if ((ch === '>' || ch === '<') && next === '(') op += next; // process substitution marker
      tokens.push(op);
      i += op.length;
      continue;
    }
    current += ch;
    hasCurrent = true;
    i += 1;
  }
  if (state !== 'plain') return null;
  if (hasCurrent || current) tokens.push(current);
  return tokens;
}

/** 段（一条简单命令）的结构化视图。 */
interface Segment {
  readonly command: string | null;
  /** 输出重定向目标存在（>、>>、&>、2>、&>>）→ 确认写文件。 */
  readonly hasOutputRedirect: boolean;
  /** 输入重定向（<、<<）不影响只读性。 */
  readonly hasInputRedirect: boolean;
  /** 未支持的结构（进程替换、括号组等）。 */
  readonly unsupported: boolean;
  /** 简单命令的参数 token（含 --output x 等，未消费）。 */
  readonly args: readonly string[];
  /** 命令替换的内部命令文本（递归判定用）。 */
  readonly substitutions: readonly string[];
}

const REDIRECT_OUT_OPS = new Set(['>', '>>', '&>', '&>>', '2>', '2>>']);

/**
 * 把 token 流切成段。遇到 `|`、`;`、`&&`、`||` 结束当前段；重定向算子吞掉
 * 其目标 token。无法解释的结构（`(`、`)`、`>(`、`<(`、裸 `&`）标记
 * unsupported。命令替换在 tokenize 前已被提取（见 classifyCommandRisk）。
 */
function splitSegments(tokens: readonly string[]): Segment[] | null {
  const segments: Segment[] = [];
  let args: string[] = [];
  let hasOut = false;
  let hasIn = false;
  let unsupported = false;
  const flush = () => {
    // 剥离前缀环境赋值（FOO=bar cmd）与 sudo 包装。
    const cleaned: string[] = [];
    for (const token of args) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
      if (token === 'sudo' && cleaned.length === 0) continue;
      cleaned.push(token);
    }
    segments.push({
      command: cleaned[0] ?? null,
      hasOutputRedirect: hasOut,
      hasInputRedirect: hasIn,
      unsupported,
      args: cleaned.slice(1),
      substitutions: [],
    });
    args = [];
    hasOut = false;
    hasIn = false;
    unsupported = false;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (token === '|' || token === ';' || token === '&&' || token === '||') {
      flush();
      continue;
    }
    if (REDIRECT_OUT_OPS.has(token)) {
      hasOut = true;
      i += 1; // swallow the redirect target token
      continue;
    }
    if (token === '<' || token === '<<' || token === '<<<') {
      hasIn = true;
      i += 1; // swallow the target word (heredoc body is data)
      continue;
    }
    if (token.startsWith('2>') || token.startsWith('&>') || token.startsWith('>>') || token.startsWith('>')) {
      // Glued forms like `2>x`, `>x`, `>>x`.
      hasOut = true;
      continue;
    }
    if (token === '(' || token === ')' || token === '>(' || token === '<(' || token === '&' || token === '>' || token === '<' || token === '>>') {
      unsupported = true;
      continue;
    }
    args.push(token);
  }
  flush();
  return segments;
}

// ── 命令级白名单/已知集合 ────────────────────────────────────────────────────

/** 只读命令：任何参数形状都不写文件/不改状态（输出到 stdout/stderr）。 */
const READONLY_ANY_ARGS = new Set([
  'cat', 'ls', 'pwd', 'echo', 'printf', 'head', 'tail', 'wc', 'file', 'stat', 'which', 'whoami', 'hostname',
  'date', 'printenv', 'id', 'uname', 'du', 'df', 'ps', 'grep', 'egrep', 'fgrep', 'rg', 'sort', 'uniq', 'cut',
  'tr', 'true', 'false', 'test', '[', '[[', 'tty', 'groups', 'basename', 'dirname', 'realpath', 'readlink',
  'seq', 'column', 'diff', 'cmp', 'md5sum', 'sha1sum', 'sha256sum', 'sha256sum.exe', 'history', 'type',
  'help', 'lscpu', 'lsblk', 'free', 'w', 'git--askpass', // (last entry defensive)
]);
READONLY_ANY_ARGS.delete('git--askpass');

/** git 显式全局选项集（带参 vs 布尔）。 */
const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix']);
const GIT_GLOBAL_BOOLEAN = new Set([
  '--no-pager', '-P', '--paginate', '-p', '--no-replace-objects', '--bare', '--literal-pathspecs',
  '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks', '--no-lazy-fetch',
  '--no-advice',
]);

/** git 查询子命令（需再核写文件选项）。 */
const GIT_READONLY_SUBCOMMANDS = new Set([
  'status', 'log', 'show', 'diff', 'blame', 'shortlog', 'describe', 'rev-parse', 'ls-files', 'ls-tree',
  'cat-file', 'ls-remote', 'show-ref', 'for-each-ref', 'check-ignore', 'check-attr', 'check-ref-format',
  'merge-base', 'name-rev', 'cherry', 'diff-tree', 'whatchanged', 'reflog', 'grep', 'count-objects',
  'verify-commit', 'verify-tag', 'hash-object', 'var', 'help', 'version', 'annotate', 'fsck',
]);
/** git 查询子命令中的写文件选项（--output=FILE / --output FILE / -o FILE）。 */
function gitArgsHaveWriteOption(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (a === '--output' || a === '-o') return true;
    if (a.startsWith('--output=')) return true;
  }
  return false;
}
/** 列表形状子命令（branch/tag/remote/stash/config）逐个判定；返回 true/false/'unknown'。 */
function isReadonlyGitListShape(sub: string, args: readonly string[]): boolean | 'unknown' {
  const positional = args.filter((a) => !a.startsWith('-'));
  const flags = args.filter((a) => a.startsWith('-'));
  if (sub === 'branch' || sub === 'tag') {
    // 列表/查询：无位置参数（branch <name> 创建、tag <name> 创建）。
    if (positional.length === 0) return !gitArgsHaveWriteOption(args);
    return false;
  }
  if (sub === 'remote') {
    if (positional.length === 0 && flags.every((f) => f === '-v' || f === '--verbose')) return true;
    return false; // add/rename/remove/set-url/prune/rm → 变更
  }
  if (sub === 'stash') {
    // stash list / stash show → 查询；裸 stash / push / pop / drop / clear → 变更。
    if (positional.length === 0 && flags.every((f) => f === 'list' || f === 'show')) return true;
    if (positional.includes('list') || positional.includes('show')) return !gitArgsHaveWriteOption(args);
    return false;
  }
  if (sub === 'config') {
    // 仅查询形状：--list/-l/--get*/--get-regexp + 可选 pattern。
    const queryFlags = ['--list', '-l', '--get', '--get-all', '--get-regexp', '--get-urlmatch'];
    const hasQuery = flags.some((f) => queryFlags.includes(f));
    const writing = flags.some((f) => f === '--unset' || f === '--add' || f === '--replace-all' || f === '--edit' || f === '-e' || f === '--remove-section' || f === '--rename-section');
    if (writing) return false;
    if (hasQuery && !positional.some((p) => p.includes('='))) return true;
    return 'unknown';
  }
  return 'unknown';
}

function isReadonlyGit(args: readonly string[]): boolean | 'unknown' {
  let i = 0;
  // 跳过显式全局选项，找到子命令。
  while (i < args.length) {
    const a = args[i] as string;
    if (GIT_GLOBAL_WITH_VALUE.has(a)) {
      i += 2;
      continue;
    }
    if (a.startsWith('--git-dir=') || a.startsWith('--work-tree=') || a.startsWith('--namespace=') || a.startsWith('--exec-path=') || a.startsWith('--super-prefix=')) {
      i += 1;
      continue;
    }
    if (GIT_GLOBAL_BOOLEAN.has(a)) {
      i += 1;
      continue;
    }
    break; // first non-global token = subcommand
  }
  const sub = args[i];
  if (sub === undefined) return 'unknown'; // `git` bare prints help — but conservative: unknown
  const rest = args.slice(i + 1);
  if (GIT_READONLY_SUBCOMMANDS.has(sub)) {
    return !gitArgsHaveWriteOption(rest);
  }
  if (['branch', 'tag', 'remote', 'stash', 'config'].includes(sub)) {
    return isReadonlyGitListShape(sub, rest);
  }
  if (sub.startsWith('-')) return 'unknown'; // unrecognized global option → cannot confirm
  return false; // any other git subcommand = confirmed mutating (add/commit/push/…)
}

/** 只读命令 + 参数形状约束；未识别命令 → 'unknown'（不默认 safe 也不默认变更）。 */
function isReadonlyWithArgShape(command: string, args: readonly string[]): boolean | 'unknown' {
  // find：不带写动作 flag 才只读。
  if (command === 'find') {
    const writeFlags = ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fls', '-fprint', '-fprint0', '-fprintf', '-fwrite'];
    if (args.some((a) => writeFlags.some((f) => a === f || a.startsWith(`${f} `) || a.startsWith(`${f}0`) || a.startsWith(`${f}=`)))) return false;
    return true;
  }
  // env：裸 env / 仅赋值与 flag → 打印环境（只读）；带命令 → 不可确认。
  if (command === 'env') {
    const nonFlag = args.filter((a) => !a.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(a));
    if (nonFlag.length === 0) return true;
    return 'unknown';
  }
  // git：全局选项核验 + 子命令白名单。
  if (command === 'git') return isReadonlyGit(args);
  // 正面白名单之外：未识别 → 无法确认（既不是 safe 也不是确认变更）。
  if (READONLY_ANY_ARGS.has(command)) return true;
  return 'unknown';
}

/** 确认变更（非破坏级）的已知命令/解释器内联代码。 */
const KNOWN_MUTATING = new Set([
  'npm', 'yarn', 'pnpm', 'pip', 'pip3', 'cargo', 'gem', 'brew', 'apt', 'apt-get', 'choco', 'winget',
  'docker', 'kubectl', 'make', 'cmake', 'gcc', 'g++', 'touch', 'tee', 'truncate', 'shred', 'patch', 'ln',
  'kill', 'pkill', 'killall', 'dd', 'mount', 'umount', 'useradd', 'userdel', 'groupadd', 'systemctl',
  'service', 'crontab', 'scp', 'rsync', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'install', 'chgrp', 'openssl',
  'gzip', 'gunzip', 'tar', 'zip', 'unzip', 'chmod', 'chown', 'aws', 'gcloud', 'az', 'ssh-keygen', 'watch',
]);

/** 危险级：显式破坏模式。 */
function isDangerousShape(command: string, args: readonly string[]): boolean {
  if (command === 'rm') return args.some((a) => /^-[a-zA-Z]*[rf][a-zA-Z]*$/.test(a) && /[rf]/.test(a));
  return command === 'chmod' || command === 'chown' || command === 'mkfs' || command === 'fdisk' || command === 'shred';
}

/** 内联任意代码执行（确认具备变更能力）与原地写入特判。 */
function isInlineCodeExecution(command: string, args: readonly string[]): boolean {
  if (command === 'node' || command === 'deno' || command === 'bun') return args.some((a) => a === '-e' || a === '--eval' || a === 'eval');
  if (command === 'python' || command === 'python3') return args.some((a) => a === '-c' || a === '--command');
  if (command === 'ruby' || command === 'perl') return args.some((a) => a === '-e' || a === '--eval');
  // sed/perl 原地写入是确认的文件变更；流式形态则不可确认（归 unknown）。
  if (command === 'sed' || command === 'perl') {
    return args.some((a) => a === '-i' || a === '--in-place' || a.startsWith('-i') && /^-[ip]/.test(a));
  }
  return false;
}

// ── 段级与链级判定 ──────────────────────────────────────────────────────────

const SEVERITY: Record<Exclude<BashRiskLevel, 'safe'>, number> = { normal: 2, dangerous: 3, unknown: 1 };

function worstLevel(a: BashRiskLevel, b: BashRiskLevel): BashRiskLevel {
  if (a === 'safe') return b;
  if (b === 'safe') return a;
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/** 命令替换提取：把 $(…) 与 `…` 的内部文本收集出来并替换为占位（保留结构）。 */
function extractBalanced(input: string, start: number, close: string): { inner: string; end: number } | null {
  let depth = 0;
  let inner = '';
  for (let i = start - 1; i < input.length; i += 1) {
    const ch = input[i] as string;
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { inner, end: i + 1 };
    }
    if (depth >= 1 && i >= start) inner += ch;
  }
  void close;
  return null;
}

function findDoubleEnd(input: string, start: number): number {
  for (let i = start; i < input.length; i += 1) {
    if ((input[i] as string) === '"') return i;
  }
  return -1;
}

function extractSubstitutions(input: string): { text: string; subs: string[] } | null {
  const subs: string[] = [];
  let out = '';
  let i = 0;
  const n = input.length;
  let depth = 0;
  let current = '';
  let mode: 'none' | 'paren' | 'backtick' | 'single' | 'double' = 'none';
  while (i < n) {
    const ch = input[i] as string;
    if (mode === 'single') {
      if (ch === "'") mode = 'none';
      out += ch;
      i += 1;
      continue;
    }
    if (mode === 'double') {
      if (ch === '"') { mode = 'none'; out += ch; i += 1; continue; }
      if (ch === '$' && input[i + 1] === '(') {
        // command substitution inside double quotes
        const sub = extractBalanced(input, i + 2, ')');
        if (sub === null) return null;
        subs.push(sub.inner);
        out += '"SUB"';
        i = sub.end;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    if (mode === 'paren') {
      if (ch === "'") { current += ch; i += 1; const close = input.indexOf("'", i); if (close === -1) return null; current += input.slice(i, close + 1); i = close + 1; continue; }
      if (ch === '"') { current += ch; i += 1; const close = findDoubleEnd(input, i); if (close === -1) return null; current += input.slice(i, close + 1); i = close + 1; continue; }
      if (ch === '(') { depth += 1; current += ch; i += 1; continue; }
      if (ch === ')') {
        depth -= 1;
        if (depth === 0) { mode = 'none'; subs.push(current); out += 'SUB'; i += 1; continue; }
        current += ch;
        i += 1;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }
    if (mode === 'backtick') {
      if (ch === '`') { mode = 'none'; subs.push(current); out += 'SUB'; i += 1; continue; }
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "'" && depth === 0) { mode = 'single'; out += ch; i += 1; continue; }
    if (ch === '"') { mode = 'double'; out += ch; i += 1; continue; }
    if (ch === '$' && input[i + 1] === '(') {
      mode = 'paren';
      depth = 1;
      current = '';
      i += 2;
      continue;
    }
    if (ch === '`') {
      mode = 'backtick';
      current = '';
      i += 1;
      continue;
    }
    if (ch === '>' && input[i + 1] === '(') return null; // process substitution unsupported
    if (ch === '<' && input[i + 1] === '(') return null;
    out += ch;
    i += 1;
  }
  if (mode !== 'none' && mode !== 'double' && mode !== 'single') return null;
  if (mode === 'double' || mode === 'single') return null; // unterminated quote
  return { text: out, subs };
}

function classifySegment(segment: Segment, subLevels: readonly BashRiskLevel[]): BashRiskLevel {
  let level: BashRiskLevel = 'safe';
  for (const s of subLevels) level = worstLevel(level, s);
  if (segment.unsupported) return worstLevel(level, 'unknown');
  if (segment.hasOutputRedirect) return worstLevel(level, 'normal');
  const {command} = segment;
  if (command === null || command === '') return 'unknown';
  // 原地写入（sed -i 等）在 isInlineCodeExecution 内特判为确认变更。
  if (isInlineCodeExecution(command, segment.args)) return worstLevel(level, 'normal');
  // 解释器执行不可分析输入：无法确认只读。
  if (['sh', 'bash', 'zsh', 'dash', 'ksh', 'powershell', 'pwsh', 'cmd', 'eval', 'source', '.', 'xargs', 'awk', 'sed', 'perl', 'expect', 'ssh'].includes(command)) {
    return worstLevel(level, 'unknown');
  }
  if (isDangerousShape(command, segment.args)) return 'dangerous';
  if (KNOWN_MUTATING.has(command)) return worstLevel(level, 'normal');
  const readonly = isReadonlyWithArgShape(command, segment.args);
  if (readonly === true) return level;
  if (readonly === false) return worstLevel(level, 'normal');
  return worstLevel(level, 'unknown');
}

function classifyCommandChain(input: string, depth: number): BashRiskLevel {
  if (depth > 3) return 'unknown';
  const extracted = extractSubstitutions(input);
  if (extracted === null) return 'unknown';
  const subLevels: BashRiskLevel[] = extracted.subs.map((sub) => classifyCommandChain(sub, depth + 1));
  const tokens = tokenize(extracted.text);
  if (tokens === null) return 'unknown';
  if (tokens.length === 0) return 'unknown';
  const segments = splitSegments(tokens);
  if (segments === null) return 'unknown';
  let level: BashRiskLevel = 'safe';
  for (const segment of segments) {
    const segLevel = classifySegment(segment, subLevels);
    level = worstLevel(level, segLevel);
  }
  return level;
}

/** 纯命令文本分类；空串 → unknown（与既有行为一致）。 */
export function classifyCommandRisk(command: string): BashRiskLevel {
  if (command.trim() === '') return 'unknown';
  try {
    return classifyCommandChain(command, 0);
  } catch {
    return 'unknown';
  }
}

/**
 * 按 (工具是否 execute 类, 参数) 分类。非 execute 类工具的 bashRisk 恒为
 * unknown——该字段只描述 shell 命令。
 */
export function classifyBashRisk(isExecuteKind: boolean, params: unknown): BashRiskLevel {
  if (!isExecuteKind) return 'unknown';
  try {
    const p = typeof params === 'object' && params !== null && !Array.isArray(params) ? params as Record<string, unknown> : {};
    const command = typeof p.command === 'string' ? p.command : typeof p.args === 'string' ? p.args : '';
    if (command === '') return 'unknown';
    return classifyCommandRisk(command);
  } catch {
    return 'unknown';
  }
}
