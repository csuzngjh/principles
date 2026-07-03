/**
 * Workspace path leak guard.
 *
 * Test code historically uses Unix-style mock strings like '/fake/workspace',
 * '/mock/state', or '/tmp/fake-workspace' as mock workspaceDir values. On
 * Windows, Node.js resolves these against the *current drive letter* —
 * `/fake/workspace` becomes `D:\fake\workspace` when the test runner's cwd is
 * on D:, or `C:\fake\workspace` when on C:. This pollutes the filesystem
 * root with real SQLite DBs and log files that the user then has to clean
 * up manually (D:\fake\workspace\.pd\state.db, D:\mock\workspace\.state\
 * trajectory.db, C:\fake\workspace\.pd\state.db, D:\fake\workspace\memory\
 * logs\SYSTEM_*.log — all observed in the wild).
 *
 * Even when tests mock WorkspaceContext / SqliteConnection, mock gaps
 * remain: a singleton SystemLogger caches `cachedLogFile` across tests; an
 * `...original` mock spread leaks real code paths; an integration test
 * forgets to mock one store. Each gap silently writes to the filesystem
 * root.
 *
 * This helper is the single chokepoint. Called at every I/O entry point
 * (SqliteConnection constructor, initTrajectorySchema, TrajectoryDatabase
 * constructor, SystemLogger.log, EventLogService constructor), it detects
 * mock-leak paths and redirects them to a deterministic subdir under
 * os.tmpdir(). mkdir + new Database use the same redirected path, so the
 * operation succeeds without polluting the filesystem root.
 *
 * Production is a no-op: the redirect only fires under NODE_ENV=test or
 * when VITEST is set. Production paths are returned unchanged.
 *
 * Cross-platform: redirection target is os.tmpdir(), which resolves to
 *   - Windows: C:\Users\<user>\AppData\Local\Temp (auto-cleaned by OS)
 *   - macOS:   /var/folders/<hash>/T/ (auto-cleaned by OS)
 *   - Linux:   /tmp (or $TMPDIR)
 *
 * @example
 * const workspaceDir = guardWorkspaceLeak(opts.workspaceDir);
 * const pdDir = path.join(workspaceDir, '.pd');
 * fs.mkdirSync(pdDir, { recursive: true }); // safe — never writes to D:\fake
 */
import * as path from 'path';
import * as os from 'os';

/**
 * Patterns that mark a path as a mock leak.
 *
 * Match either forward-slash or backslash form so the same pattern works
 * on both Unix (test source uses '/fake/workspace') and Windows
 * (path.resolve produces 'D:\fake\workspace').
 */
const MOCK_LEAK_PATTERNS = [
  /(^|[/\\])fake[/\\]/i,
  /(^|[/\\])mock[/\\]/i,
  /(^|[/\\])tmp[/\\]fake-/i,
];

/**
 * Root directory under os.tmpdir() used to redirect leaked paths.
 * Deterministic — same input always maps to the same output, so mkdir +
 * Database land in the same dir.
 */
const QUARANTINE_ROOT = path.join(os.tmpdir(), '.pd-test-quarantine');

/**
 * True when the path looks like a mock leak — a Unix-style mock string
 * (e.g. '/fake/workspace', '/mock/state', '/tmp/fake-workspace') that, on
 * Windows, would resolve to a path directly under the filesystem root.
 *
 * Pure function — no side effects, safe to call from anywhere.
 */
export function isMockLeakPath(dir: string): boolean {
  if (!dir) return false;
  const normalized = dir.replace(/\\/g, '/');
  return MOCK_LEAK_PATTERNS.some(re => re.test(normalized));
}

/**
 * Detect mock-leak paths and redirect them to a deterministic subdir under
 * os.tmpdir(). Production is a no-op — the redirect only fires under
 * NODE_ENV=test or when VITEST is set.
 *
 * Returns the input unchanged when:
 *   - input is empty
 *   - we're not in a test environment
 *   - the path doesn't match any mock-leak pattern
 *
 * Otherwise returns a redirected path under
 *   `<os.tmpdir()>/<safe-basename>/`.
 */
export function guardWorkspaceLeak(dir: string): string {
  if (!dir) return dir;

  // Production is a no-op — never change production paths.
  const isTestEnv = process.env.NODE_ENV === 'test' || !!process.env.VITEST;
  if (!isTestEnv) return dir;

  if (!isMockLeakPath(dir)) return dir;

  // Deterministic redirect: same input → same output.
  // Strip drive colons and path separators so the result is a valid
  // single directory name on all platforms.
  // NOTE: leading/trailing underscore trim is split into two separate
  // regex calls (not `/^_+|_+$/g`) to avoid CodeQL ReDoS flag on
  // alternation with `+` quantifier on uncontrolled input. Each call is
  // linear and non-backtracking.
  const safeName = dir
    .replace(/[:*?"<>|]/g, '_')
    .replace(/[/\\]/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '');
  return path.join(QUARANTINE_ROOT, safeName);
}
