/**
 * V5 render-script acceptance tests (PR #2642 review, §5).
 *
 * These tests drive the real scripts as child processes:
 *   - parameter / environment resolution (PythonPath, CosyVoiceRoot, ReferenceAudio, BgmPath);
 *   - fail-fast preflight that lists every missing dependency with a nextAction;
 *   - -DryRun is genuinely side-effect free (no external program, no file written);
 *   - -SkipVoice refuses to run without timing.json + 8 chapter WAVs + vo-full.wav;
 *   - a full build runs end-to-end with externally supplied resources.
 *
 * External binaries (python / npx / ffmpeg / ffprobe) are replaced with
 * recordable stubs; `node` stays real so the three text-generation scripts
 * really execute. No model, WAV or MP4 fixture is committed.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const V5 = path.join(REPO, 'packages/website/video/product-walkthrough/hyperframes-product-v5');
const RENDER_SCRIPT = path.join(V5, 'scripts/render-all.ps1');
const VOICE_SCRIPT = path.join(V5, 'scripts/build-voiceover.py');

const PWSH = process.env.PWSH || 'pwsh';
const HAS_PWSH = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
  encoding: 'utf8',
}).status === 0;
const IN_CI = process.env.CI === 'true' || process.env.CI === '1';
const PWsh_SKIP = HAS_PWSH ? false : 'pwsh is not available on this machine';

test('pwsh is available where these tests are expected to run', { skip: !IN_CI || HAS_PWSH }, () => {
  assert.fail('pwsh must be installed in CI for the V5 render-script contract tests');
});

const COPY_ENTRIES = [
  'scripts',
  'compositions',
  'assets/style',
  'assets/logo',
  'assets/vendor',
  'assets/fonts',
  'assets/img',
  'VOICEOVER_ZH.json',
  'hyperframes.json',
];

const CHAPTER_IDS = ['ch01', 'ch02', 'ch03', 'ch04', 'ch05', 'ch06', 'ch07', 'ch08'];

function runPwsh(args, { cwd, env } = {}) {
  const result = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-File', ...args], {
    cwd: cwd || REPO,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 120000,
  });
  return {
    status: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function writeStub(dir, tool, body) {
  const helper = path.join(dir, `${tool}-stub.mjs`);
  fs.writeFileSync(helper, body);
  if (process.platform === 'win32') {
    const wrapper = path.join(dir, `${tool}.cmd`);
    fs.writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${helper}" %*\r\n`);
    return wrapper;
  }
  const wrapper = path.join(dir, tool);
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${helper}" "$@"\n`, { mode: 0o755 });
  return wrapper;
}

const RECORD = `
import fs from 'node:fs';
import path from 'node:path';
const log = process.env.PD_TEST_CALL_LOG;
function record(tool, args) {
  if (log) fs.appendFileSync(log, JSON.stringify({ tool, args }) + '\\n');
  const markerDir = process.env.PD_TEST_MARKER_DIR;
  if (markerDir) {
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, tool + '-' + process.pid + '-' + Date.now() + '.marker'), 'x');
  }
}
`;

const PYTHON_STUB = `${RECORD}
const args = process.argv.slice(2);
record('python', args);
if (args.includes('--version') || args.includes('-V')) {
  console.log('Python 3.10.16');
  process.exit(0);
}
if (args.includes('--check')) {
  console.log('check: result=OK');
  process.exit(0);
}
const ids = ['ch01','ch02','ch03','ch04','ch05','ch06','ch07','ch08'];
fs.mkdirSync(path.join(process.cwd(), 'assets/audio/vo'), { recursive: true });
fs.mkdirSync(path.join(process.cwd(), 'renders/audio'), { recursive: true });
const chapters = ids.map((id, i) => ({
  id,
  title: id,
  start: i,
  duration: 1,
  lines: [{ index: 0, text: '测试旁白', caption: true, start: 0, end: 0.9, duration: 0.9 }],
}));
for (const id of ids) fs.writeFileSync(path.join(process.cwd(), 'assets/audio/vo/' + id + '.wav'), 'wav');
fs.writeFileSync(path.join(process.cwd(), 'renders/audio/vo-full.wav'), 'wav');
fs.writeFileSync(path.join(process.cwd(), 'assets/audio/vo/timing.json'), JSON.stringify({
  voice: 'stub', reference: 'stub.wav', seed: 20261114, sampleRate: 48000,
  total: 8, lineCount: 8, chapters,
}, null, 2));
process.exit(0);
`;

const NPX_STUB = `${RECORD}
const args = process.argv.slice(2);
record('npx', args);
const outIndex = args.indexOf('-o');
if (outIndex >= 0) {
  const out = args[outIndex + 1];
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'mp4');
}
process.exit(0);
`;

const FFPROBE_STUB = `${RECORD}
const args = process.argv.slice(2);
record('ffprobe', args);
if (args.some((arg) => arg.includes('format=duration'))) {
  process.stdout.write('340.0\\n');
} else {
  process.stdout.write('nb_read_frames=1\\nduration=8.0\\nwidth=1920\\nheight=1080\\n');
}
process.exit(0);
`;

const FFMPEG_STUB = `${RECORD}
const args = process.argv.slice(2);
record('ffmpeg', args);
if (args.includes('-version')) {
  process.stdout.write('ffmpeg version 8.1-stub\\n');
  process.exit(0);
}
process.stderr.write(JSON.stringify({
  input_i: '-22.11', input_tp: '-6.14', input_lra: '1.80',
  input_thresh: '-32.15', target_offset: '0.00',
}) + '\\n');
const out = args[args.length - 1];
if (out && !out.startsWith('-') && out !== 'NUL' && out !== '/dev/null') {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'ffmpeg');
}
process.exit(0);
`;

const NODE_STUB = `${RECORD}
record('node', process.argv.slice(2));
process.exit(0);
`;

function makeFixture(t, { timing = 'real', voice = false, bgm = true, reference = true, model = true, stubNode = false } = {}) {
  // Under the repository .tmp/ (gitignored) instead of os.tmpdir(): Windows
  // exposes the system temp as an 8.3 short path (ADMINI~1), which would make
  // resolved-path comparisons depend on path normalisation.
  const fixtureRoot = path.join(REPO, '.tmp');
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(fixtureRoot, 'video-render-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  for (const entry of COPY_ENTRIES) {
    fs.cpSync(path.join(V5, entry), path.join(dir, entry), { recursive: true });
  }

  const binDir = path.join(dir, '_bin');
  const markerDir = path.join(dir, '_markers');
  const callLog = path.join(dir, '_calls.jsonl');
  fs.mkdirSync(binDir, { recursive: true });

  writeStub(binDir, 'python', PYTHON_STUB);
  writeStub(binDir, 'npx', NPX_STUB);
  writeStub(binDir, 'ffmpeg', FFMPEG_STUB);
  writeStub(binDir, 'ffprobe', FFPROBE_STUB);
  if (stubNode) writeStub(binDir, 'node', NODE_STUB);
  const pythonPath = path.join(binDir, process.platform === 'win32' ? 'python.cmd' : 'python');

  const external = path.join(dir, '_external');
  fs.mkdirSync(external, { recursive: true });
  const bgmPath = path.join(external, 'bgm.wav');
  const refPath = path.join(external, 'ref.wav');
  if (bgm) {
    fs.writeFileSync(bgmPath, Buffer.alloc(2048, 1));
    const defaultBgm = path.join(dir, 'assets/audio/bgm/bgm-bed-340s.wav');
    fs.mkdirSync(path.dirname(defaultBgm), { recursive: true });
    fs.writeFileSync(defaultBgm, Buffer.alloc(2048, 1));
  }
  if (reference) {
    fs.writeFileSync(refPath, Buffer.alloc(4096, 1));
    const defaultRef = path.join(dir, 'assets/audio/ref/02-serena-female-l0.wav');
    fs.mkdirSync(path.dirname(defaultRef), { recursive: true });
    fs.writeFileSync(defaultRef, Buffer.alloc(4096, 1));
  }

  const cosyRoot = path.join(external, 'cosyvoice');
  if (model) {
    const modelDir = path.join(cosyRoot, 'pretrained_models/CosyVoice2-0.5B');
    fs.mkdirSync(path.join(cosyRoot, 'cosyvoice'), { recursive: true });
    fs.mkdirSync(modelDir, { recursive: true });
    for (const file of ['config.json', 'llm.pt', 'flow.pt', 'hift.pt']) {
      fs.writeFileSync(path.join(modelDir, file), 'model');
    }
  }

  const timingPath = path.join(dir, 'assets/audio/vo/timing.json');
  if (timing === 'real') {
    fs.mkdirSync(path.dirname(timingPath), { recursive: true });
    fs.copyFileSync(path.join(V5, 'assets/audio/vo/timing.json'), timingPath);
  } else if (timing === 'stub') {
    fs.mkdirSync(path.dirname(timingPath), { recursive: true });
    fs.writeFileSync(timingPath, JSON.stringify({
      total: 8,
      chapters: CHAPTER_IDS.map((id, i) => ({ id, title: id, start: i, duration: 1, lines: [] })),
    }));
  }

  if (voice) {
    fs.mkdirSync(path.join(dir, 'assets/audio/vo'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'renders/audio'), { recursive: true });
    for (const id of CHAPTER_IDS) {
      fs.writeFileSync(path.join(dir, 'assets/audio/vo', `${id}.wav`), 'wav');
    }
    fs.writeFileSync(path.join(dir, 'renders/audio/vo-full.wav'), 'wav');
  }

  const env = {
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    PD_TEST_CALL_LOG: callLog,
    PD_TEST_MARKER_DIR: markerDir,
    PD_VIDEO_PYTHON: '',
    PD_VIDEO_COSYVOICE_ROOT: '',
    PD_VIDEO_REFERENCE_AUDIO: '',
    PD_VIDEO_BGM_PATH: '',
  };

  return {
    dir,
    scriptPath: path.join(dir, 'scripts/render-all.ps1'),
    binDir,
    markerDir,
    callLog,
    pythonPath,
    cosyRoot,
    bgmPath,
    refPath,
    env,
    calls() {
      if (!fs.existsSync(callLog)) return [];
      return fs.readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
    markers() {
      return fs.existsSync(markerDir) ? fs.readdirSync(markerDir) : [];
    },
  };
}

function walkSnapshot(root) {
  const entries = {};
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        entries[`${rel}/`] = 'dir';
        visit(full);
      } else if (entry.isFile()) {
        entries[rel] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      }
    }
  };
  visit(root);
  return entries;
}

test('render scripts contain no developer-specific absolute paths', () => {
  const render = fs.readFileSync(RENDER_SCRIPT, 'utf8');
  const voice = fs.readFileSync(VOICE_SCRIPT, 'utf8');
  for (const [name, text] of [['render-all.ps1', render], ['build-voiceover.py', voice]]) {
    assert.ok(!/pd-labs/i.test(text), `${name} must not reference D:\\pd-labs`);
    assert.ok(!/cosyvoice.*\.venv/i.test(text), `${name} must not hard-code a venv path`);
    assert.ok(!/D:\\/i.test(text), `${name} must not embed a D:\\ absolute path`);
  }
  const manifest = fs.readFileSync(path.join(V5, 'ASSET_MANIFEST.md'), 'utf8');
  for (const token of ['PD_VIDEO_PYTHON', 'PD_VIDEO_COSYVOICE_ROOT', 'PD_VIDEO_REFERENCE_AUDIO', 'PD_VIDEO_BGM_PATH', 'SHA-256', 'SkipVoice']) {
    assert.ok(manifest.includes(token), `ASSET_MANIFEST.md must document ${token}`);
  }
  assert.ok(fs.readFileSync(path.join(V5, '.gitignore'), 'utf8').includes('ASSET_MANIFEST.md'));
});

test('DryRun is a static plan: no external program runs and no file changes', { skip: PWsh_SKIP }, (t) => {
  const fixture = makeFixture(t, { timing: 'real', voice: true, stubNode: true });
  const before = walkSnapshot(fixture.dir);

  const result = runPwsh([
    fixture.scriptPath,
    '-DryRun',
    '-PythonPath', fixture.pythonPath,
    '-CosyVoiceRoot', fixture.cosyRoot,
    '-ReferenceAudio', fixture.refPath,
    '-BgmPath', fixture.bgmPath,
  ], { env: fixture.env });

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /DRY RUN/);
  assert.match(result.output, /Dry run complete: 0 external programs started, 0 files written/);
  assert.match(result.output, /voiceover \+ timing\.json/);
  assert.ok(result.output.includes(fixture.pythonPath), 'plan must print the resolved Python path');
  assert.ok(result.output.includes(fixture.cosyRoot), 'plan must print the resolved CosyVoice root');
  assert.ok(result.output.includes(fixture.refPath), 'plan must print the resolved reference audio');
  assert.ok(result.output.includes(fixture.bgmPath), 'plan must print the resolved BGM');

  assert.deepEqual(fixture.markers(), [], 'DryRun must not start python/node/npx/ffmpeg/ffprobe');
  assert.deepEqual(walkSnapshot(fixture.dir), before, 'DryRun must not modify the worktree');
});

test('PD_VIDEO_* environment variables supply every external path', { skip: PWsh_SKIP }, (t) => {
  const fixture = makeFixture(t, { timing: 'real', voice: true });
  const env = {
    ...fixture.env,
    PD_VIDEO_PYTHON: fixture.pythonPath,
    PD_VIDEO_COSYVOICE_ROOT: fixture.cosyRoot,
    PD_VIDEO_REFERENCE_AUDIO: fixture.refPath,
    PD_VIDEO_BGM_PATH: fixture.bgmPath,
  };
  const result = runPwsh([fixture.scriptPath, '-DryRun'], { env });

  assert.equal(result.status, 0, result.output);
  for (const expected of [fixture.pythonPath, fixture.cosyRoot, fixture.refPath, fixture.bgmPath]) {
    assert.ok(result.output.includes(expected), `plan must resolve ${expected} from the environment`);
  }
  assert.deepEqual(fixture.markers(), []);
});

test('missing dependencies fail fast with every gap and a nextAction', { skip: PWsh_SKIP }, (t) => {
  const fixture = makeFixture(t, { timing: 'none', bgm: false, reference: false, model: false });
  fs.rmSync(path.join(fixture.dir, 'VOICEOVER_ZH.json'));

  const result = runPwsh([
    fixture.scriptPath,
    '-PythonPath', fixture.pythonPath,
  ], { env: fixture.env });

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Preflight FAILED/);
  for (const label of ['CosyVoice 模型', 'Reference Audio', 'BGM', '旁白源 JSON']) {
    assert.ok(result.output.includes(label), `preflight must report ${label}`);
  }
  assert.match(result.output, /nextAction:/);
  assert.equal(fs.existsSync(path.join(fixture.dir, 'renders')), false, 'failed preflight must not create renders/');
  assert.equal(fs.existsSync(path.join(fixture.dir, 'NARRATION_ZH.md')), false, 'failed preflight must not build text');
});

test('SkipVoice requires timing.json + 8 chapter WAVs + vo-full.wav', { skip: PWsh_SKIP }, (t) => {
  const fixture = makeFixture(t, { timing: 'real', voice: false });

  const fail = runPwsh([fixture.scriptPath, '-SkipVoice', '-DryRun'], { env: fixture.env });
  assert.equal(fail.status, 1, fail.output);
  assert.match(fail.output, /SkipVoice 音频资产/);
  assert.match(fail.output, /ch01\.wav/);
  assert.match(fail.output, /vo-full\.wav/);

  for (const id of CHAPTER_IDS) {
    fs.writeFileSync(path.join(fixture.dir, 'assets/audio/vo', `${id}.wav`), 'wav');
  }
  fs.mkdirSync(path.join(fixture.dir, 'renders/audio'), { recursive: true });
  fs.writeFileSync(path.join(fixture.dir, 'renders/audio/vo-full.wav'), 'wav');

  const pass = runPwsh([fixture.scriptPath, '-SkipVoice', '-DryRun'], { env: fixture.env });
  assert.equal(pass.status, 0, pass.output);
  assert.match(pass.output, /\[ OK \] SkipVoice 音频资产/);
});

test('full build runs end-to-end with externally supplied python, CosyVoice, reference and BGM', { skip: PWsh_SKIP }, (t) => {
  const fixture = makeFixture(t, { timing: 'none', voice: false });

  const result = runPwsh([
    fixture.scriptPath,
    '-PythonPath', fixture.pythonPath,
    '-CosyVoiceRoot', fixture.cosyRoot,
    '-ReferenceAudio', fixture.refPath,
    '-BgmPath', fixture.bgmPath,
  ], { env: fixture.env });

  assert.equal(result.status, 0, result.output);
  assert.ok(fs.existsSync(path.join(fixture.dir, 'renders/final/principles-disciple-v5-zh.mp4')));

  const calls = fixture.calls();
  const pythonBuild = calls.filter((call) => call.tool === 'python' &&
    !call.args.includes('--check') && !call.args.includes('--version') && !call.args.includes('-V'));
  assert.equal(pythonBuild.length, 1, 'python must run exactly once for the voiceover step');
  assert.ok(pythonBuild[0].args.includes('--cosyvoice-root'));
  assert.ok(pythonBuild[0].args.includes(fixture.cosyRoot));
  assert.ok(pythonBuild[0].args.includes('--reference-audio'));
  assert.ok(pythonBuild[0].args.includes(fixture.refPath));

  const mix = calls.find((call) => call.tool === 'ffmpeg' && call.args.includes(fixture.bgmPath));
  assert.ok(mix, 'the mix step must consume the externally supplied BGM');

  const renders = calls.filter((call) => call.tool === 'npx' && call.args.includes('render'));
  assert.equal(renders.length, 8, 'all 8 chapters must be rendered when none exist yet');

  assert.equal(fs.readFileSync(path.join(fixture.dir, 'NARRATION_ZH.md'), 'utf8').includes('V5 中文旁白'), true);
});
