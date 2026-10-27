import { describe, expect, it } from 'vitest';
import { classifyBashRisk, classifyCommandRisk } from '../bash-risk.js';
import { createSyntheticRuleHostInput } from '../../golden-trace.js';
import { buildToolSemanticRegistry } from '../tool-semantic-registry.js';

/**
 * PRI-1047 R8: the read-only verdict is POSITIVE EVIDENCE ONLY. Expectations
 * below are hardcoded literals independent of the classifier under test —
 * the classifier must match them, never the reverse.
 *
 * Anchors: the Owner-confirmed R7 matrix (9 commands) plus the required
 * command-family probes (readonly queries / config-repo-file mutations / git
 * global options / output-file options / mutation keywords in args and paths /
 * pipes, composition and unsupported syntax / script & inline-code execution).
 */
const EXPECTED: readonly [command: string, expected: 'safe' | 'normal' | 'dangerous' | 'unknown'][] = [
  // ── Owner-confirmed R7 anchors ──
  ['git status --short', 'safe'],
  ['git commit -m change', 'normal'],
  ['git remote add review https://example.com/repo.git', 'normal'],
  ['git show --output=review.txt HEAD', 'normal'],
  ['cat instructions.txt | sh', 'unknown'],
  ['cat message.txt | git -C . commit -F -', 'normal'],
  ['git log --format=oneline', 'safe'],
  ['git show HEAD:src/form.ts', 'safe'],
  ['git grep touch', 'safe'],
  // ── Confirmed read-only queries ──
  ['git log --oneline -5', 'safe'],
  ['git diff HEAD~1', 'safe'],
  ['git --no-pager status', 'safe'],
  ['git -C . status', 'safe'],
  ['git branch', 'safe'],
  ['git tag', 'safe'],
  ['git remote', 'safe'],
  ['git remote -v', 'safe'],
  ['git config --list', 'safe'],
  ['git stash list', 'safe'],
  ['cat README.md', 'safe'],
  ["printf '%s' hello", 'safe'],
  ['head -n 5 README.md', 'safe'],
  ['tail -n 5 README.md', 'safe'],
  ['grep -n pattern README.md', 'safe'],
  ['ls -la src/', 'safe'],
  ['rg pattern src/', 'safe'],
  ['ls src/format', 'safe'],
  ['echo hello', 'safe'],
  ['find src -name "*.ts"', 'safe'],
  ['git show --stat HEAD', 'safe'],
  ['git status | cat', 'safe'],
  ['echo $(git log -1)', 'unknown'],
  ["find . $(printf '%s' '-delete')", 'unknown'],
  ["find . \"$(printf '%s' '-delete')\"", 'unknown'],
  ["echo '$(touch marker.txt)'", 'safe'],
  ["rg $(printf '%s' '--pre=./rewrite.sh') pattern .", 'unknown'],
  ['find . {-delete,-print}', 'unknown'],
  ['rg {--pre=./rewrite.sh,pattern} .', 'unknown'],
  ['git reflog show --output=/tmp/pd-probe', 'unknown'],
  ["printf '%n' marker", 'unknown'],
  ['wc -l < input.txt', 'safe'],
  ['git log -5; git status', 'safe'],
  // ── Regressions: argument shapes and shell structure ──
  ['sort -o out.txt input.txt', 'normal'],
  ['uniq input.txt out.txt', 'normal'],
  ['rg --pre=./rewrite.sh pattern .', 'unknown'],
  ['git hash-object -w input.txt', 'normal'],
  ['git reflog delete HEAD@{0}', 'normal'],
  ['git branch --unset-upstream', 'normal'],
  ['git status --sh\u0001ort', 'unknown'],
  ['git -c core.pager=./rewrite.sh log', 'unknown'],
  ['git --paginate log', 'unknown'],
  ['git diff --ext-diff HEAD', 'unknown'],
  ['git stash show --ext-diff', 'unknown'],
  ['git reflog show --ext-diff', 'unknown'],
  ["find . -name '<' -exec touch /tmp/pd-probe ';'", 'unknown'],
  ['cat README.md\ngit commit -m change', 'normal'],
  ['git status\nrm -rf src', 'dangerous'],
  ['echo "$(touch marker.txt)"', 'normal'],
  ['echo "`touch marker.txt`"', 'normal'],
  ['cat "$INPUT_FILE"', 'unknown'],
  ['PATH=/tmp/tools cat README.md', 'unknown'],
  ['sudo cat README.md', 'unknown'],
  ['echo "git commit\nrm -rf src"', 'safe'],
  ['cat README.md\r\ngit status', 'safe'],
  ['cat README.md\r\ngit commit -m change', 'normal'],
  ['cat "a|rm -rf src"', 'safe'],
  // Explicitly supported stdout-only command families reject unknown/write options.
  ['cat --output=out.txt README.md', 'unknown'],
  ['ls --file=out.txt', 'unknown'],
  ['printf -v result value', 'unknown'],
  ['head -o out.txt input.txt', 'unknown'],
  ['tail -o out.txt input.txt', 'unknown'],
  ['grep --output=out.txt pattern input.txt', 'unknown'],
  ['rg --files -g "*.ts" src/', 'safe'],
  // ── Config / file / repo-state mutations ──
  ['git config user.email x@example.com', 'unknown'], // config write shape unverifiable → cannot confirm readonly
  ['git stash push', 'normal'],
  ['git branch feature-x', 'normal'],
  ['git tag v1.0.0', 'normal'],
  ['git remote rename origin upstream', 'normal'],
  ['git remote remove review', 'normal'],
  ['touch a.txt', 'normal'],
  ['cp a.txt b.txt', 'normal'],
  ['mkdir d', 'normal'],
  ['git push origin main', 'normal'],
  ['npm install left-pad', 'normal'],
  ['git add -A && git commit -m "x"', 'normal'],
  // ── Git global options (subcommand still resolved) ──
  ['git -C . commit -m x', 'normal'],
  ['git --git-dir=.git log', 'safe'],
  ['git --weird-flag log', 'unknown'], // unrecognized global option → cannot confirm
  // ── Output-file options in query subcommands ──
  ['git log --output out.txt', 'normal'],
  ['git diff --output=diff.txt HEAD', 'normal'],
  // ── Mutation keywords inside args / paths / plain text (no false trigger) ──
  ['cat "my rm file.txt"', 'safe'],
  ['echo "npm install"', 'safe'],
  ['grep commit message.txt', 'safe'],
  ['rg "git push" docs', 'safe'],
  // ── Pipes / composition / unsupported syntax ──
  ['echo hi > out.txt', 'normal'],
  ['echo hi >> out.txt', 'normal'],
  ['cat <> /tmp/pd-probe', 'normal'],
  ['cat 3<>/tmp/pd-probe', 'normal'],
  ['git status 2> err.txt', 'normal'],
  ['git status; git commit -m x', 'normal'],
  ['git status && git commit -m x', 'normal'],
  ['git status || git checkout -b x', 'normal'],
  ['echo $(git commit -m x)', 'normal'], // mutating substitution
  ['eval "git status"', 'unknown'],
  ['bash scripts/run.sh', 'unknown'],
  ['sh run.sh', 'unknown'],
  ['cat a | xargs rm', 'unknown'], // xargs wrapper unanalyzable
  ['diff <(git status) <(git status)', 'unknown'], // process substitution unsupported
  // ── Script / inline arbitrary code execution ──
  ['node -e "process.stdout.write(1)"', 'normal'],
  ['python -c "print(1)"', 'normal'],
  ['ruby -e "puts 1"', 'normal'],
  ['node --version', 'unknown'], // not in the positive readonly set → cannot confirm
  ['sed -i s/a/b/ file.txt', 'normal'], // in-place write confirmed
  ['sed s/a/b/ file.txt', 'unknown'], // stream form unverifiable (program may write via w)
  // ── Dangerous tier ──
  ['rm -rf node_modules', 'dangerous'],
  ['chmod +x run.sh', 'dangerous'],
  // ── Boundaries ──
  ['', 'unknown'],
  ['   ', 'unknown'],
];

describe('PRI-1047 R8 — positive-evidence bash-risk classification (hardcoded expectations)', () => {
  it('matches every independent expectation', () => {
    const failures: string[] = [];
    for (const [command, expected] of EXPECTED) {
      const actual = classifyCommandRisk(command);
      if (actual !== expected) failures.push(`${JSON.stringify(command)}: expected ${expected}, got ${actual}`);
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('negative evidence never yields safe: everything outside the positive readonly set is non-safe', () => {
    for (const [command, level] of EXPECTED) {
      if (level === 'safe') continue;
      expect(classifyCommandRisk(command), `${command}`).not.toBe('safe');
    }
  });

  it('classifyBashRisk boundaries: non-execute tools and unreadable params stay unknown', () => {
    expect(classifyBashRisk(false, { command: 'git status' })).toBe('unknown');
    expect(classifyBashRisk(true, {})).toBe('unknown');
    expect(classifyBashRisk(true, null)).toBe('unknown');
    expect(classifyBashRisk(true, { args: 'git status --short' })).toBe('safe');
    expect(classifyBashRisk(true, { command: 'totally-unknown-cmd --flag' })).toBe('unknown');
  });

  it('replay input derivation agrees with the classifier (production parity)', () => {
    const registryResult = buildToolSemanticRegistry([{ rawToolName: 'Bash', canonicalKind: 'execute' }]);
    if (!registryResult.ok) throw new Error('fixture registry');
    for (const [command, expected] of EXPECTED) {
      const input = createSyntheticRuleHostInput({ toolName: 'Bash', params: { command } }, {}, { toolSemantics: registryResult.registry });
      expect(input.derived.bashRisk, `${command}`).toBe(expected);
    }
  });

  it('fact-state independence: classification never depends on approval facts (separate concepts)', () => {
    // The classifier only sees command text; designGate facts ride ruleContext and
    // must not influence bashRisk. Pin the separation with two contexts.
    const registryResult = buildToolSemanticRegistry([{ rawToolName: 'Bash', canonicalKind: 'execute' }]);
    if (!registryResult.ok) throw new Error('fixture registry');
    const mkContext = (resolution: string) => ({
      version: 2 as const,
      history: { status: 'available' as const, truncated: false, calls: [] },
      facts: {
        priorReadOfTarget: 'unknown' as const, readCount: 0, writeCount: 0, uniqueWritePathCount: 0, sameActionBlockCount: null,
        designGate: { version: 1 as const, sourceRef: 'fixture:approval', revision: 1, requiresApproval: true,
          taskRef: 'fixture-task', specDigest: 'fixture-spec', scopeRef: 'fixture-scope',
          decisionTaskRef: 'fixture-task', decisionSpecDigest: 'fixture-spec', decisionScopeRef: 'fixture-scope',
          resolution: resolution as 'approved', revoked: false },
      },
    });
    for (const command of ['git status --short', 'git commit -m x', 'cat a | sh']) {
      const a = createSyntheticRuleHostInput({ toolName: 'Bash', params: { command } }, { context: mkContext('not_approved') }, { toolSemantics: registryResult.registry });
      const b = createSyntheticRuleHostInput({ toolName: 'Bash', params: { command } }, { context: mkContext('approved') }, { toolSemantics: registryResult.registry });
      expect(a.derived.bashRisk, `${command}`).toBe(b.derived.bashRisk);
    }
  });
});

describe('PRI-1047 R8 — safe command families reject unverified options', () => {
  it('only treats explicitly supported stdout query shapes as safe', () => {
    for (const command of [
      'sort -o out.txt input.txt', 'uniq input.txt out.txt', 'rg --pre=./rewrite.sh pattern .',
      'cat --output=out.txt README.md', 'ls --file=out.txt', 'printf -v result value',
      'head -o out.txt input.txt', 'tail -o out.txt input.txt', 'grep --output=out.txt pattern input.txt',
    ]) expect(classifyCommandRisk(command), command).not.toBe('safe');
  });
});
