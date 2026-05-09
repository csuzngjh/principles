const fs = require('fs');
const path = require('path');

const sessionsDir = 'D:\\.openclaw\\workspace\\.state\\sessions';
const snapshotsDir = 'D:\\.openclaw\\workspace\\.state\\control-plane-observation\\snapshots';

console.log('=== Session & Snapshot Cleanup ===\n');

console.log('--- Probe Sessions ---');
const sessionFiles = fs.readdirSync(sessionsDir);
const probeFiles = sessionFiles.filter(f => f.startsWith('pd-runtime-probe-'));
const regularFiles = sessionFiles.filter(f => !f.startsWith('pd-runtime-probe-'));
console.log(`Total session files: ${sessionFiles.length}`);
console.log(`Probe sessions: ${probeFiles.length}`);
console.log(`Regular sessions: ${regularFiles.length}`);

if (probeFiles.length > 0) {
  console.log(`\nDeleting ${probeFiles.length} probe sessions...`);
  let deleted = 0;
  for (const f of probeFiles) {
    try {
      fs.unlinkSync(path.join(sessionsDir, f));
      deleted++;
    } catch (e) {
      console.log(`  Failed: ${f}: ${e.message}`);
    }
  }
  console.log(`Deleted ${deleted} probe sessions`);
}

console.log('\n--- Old Snapshots ---');
if (fs.existsSync(snapshotsDir)) {
  const snapshots = fs.readdirSync(snapshotsDir).sort();
  console.log(`Total snapshots: ${snapshots.length}`);
  snapshots.forEach(s => console.log(`  ${s}`));

  if (snapshots.length > 1) {
    const toDelete = snapshots.slice(0, -1);
    console.log(`\nKeeping latest: ${snapshots[snapshots.length - 1]}`);
    console.log(`Deleting ${toDelete.length} old snapshots...`);
    let deleted = 0;
    for (const s of toDelete) {
      try {
        fs.rmSync(path.join(snapshotsDir, s), { recursive: true, force: true });
        deleted++;
      } catch (e) {
        console.log(`  Failed: ${s}: ${e.message}`);
      }
    }
    console.log(`Deleted ${deleted} old snapshots`);
  }
}

console.log('\n--- Final Count ---');
const remaining = fs.readdirSync(sessionsDir);
console.log(`Remaining session files: ${remaining.length}`);

console.log('\n=== Done ===');
