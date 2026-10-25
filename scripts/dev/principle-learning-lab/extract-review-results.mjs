import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const zipPath = path.resolve('scripts/dev/principle-learning-lab/challenge-studies/CEB-001/blind-review-package/exports/CEB-001-ai-only-review-results.zip');
const outDir = path.dirname(zipPath);

const zip = fs.readFileSync(zipPath);
const eocdSig = zip.lastIndexOf(Buffer.from('PK\x05\x06'));
const totalEntries = zip.readUInt16LE(eocdSig + 10);
const centralStart = zip.readUInt32LE(eocdSig + 16);

// Central directory walk → get local header offsets
let ptr = centralStart;
const entries = [];
for (let i = 0; i < totalEntries; i++) {
  if (zip.readUInt32LE(ptr) !== 0x02014b50) break;
  const nameLen = zip.readUInt16LE(ptr + 28);
  const extraLen = zip.readUInt16LE(ptr + 30);
  const commentLen = zip.readUInt16LE(ptr + 32);
  const name = zip.slice(ptr + 46, ptr + 46 + nameLen).toString();
  entries.push({ name, localHeaderOffset: zip.readUInt32LE(ptr + 42) });
  ptr += 46 + nameLen + extraLen + commentLen;
}

for (const e of entries) {
  // Local file header
  const lp = e.localHeaderOffset;
  const nameLen = zip.readUInt16LE(lp + 26);
  const extraLen = zip.readUInt16LE(lp + 28);
  const dataStart = lp + 30 + nameLen + extraLen;
  const raw = zip.slice(dataStart, dataStart + e.compSize);
  
  const content = zlib.inflateRawSync(raw).toString('utf8');
  fs.writeFileSync(path.join(outDir, e.name), content);
  console.log('extracted:', e.name, `(${content.length} chars)`);
}
console.log('extraction complete');
