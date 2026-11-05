/**
 * Minimal ZIP writer (deflate + UTF-8 names) for the MCP log export command.
 *
 * The repository ships no zip dependency and the export must work offline on
 * an Owner machine; the format needed here is the small, well-specified subset:
 * local headers, one central directory, end-of-central-directory. Archives are
 * bounded by the caller (≤20 MiB) and contain only text files.
 */
import { deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const UTF8_FLAG = 0x0800;
const DEFLATE_METHOD = 8;
const VERSION_NEEDED = 20;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    const table = CRC_TABLE[(crc ^ byte) & 0xff] ?? 0;
    crc = table ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS date/time (local); fixed to the generation time. */
function dosDateTime(date: Date): { time: number; date: number } {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: dosDate };
}

export function buildZip(entries: readonly ZipEntry[], generatedAt: Date = new Date()): Buffer {
  const stamp = dosDateTime(generatedAt);
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_FILE_HEADER, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(DEFLATE_METHOD, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, name, compressed);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(CENTRAL_DIRECTORY_HEADER, 0);
    directory.writeUInt16LE(VERSION_NEEDED, 4);
    directory.writeUInt16LE(VERSION_NEEDED, 6);
    directory.writeUInt16LE(UTF8_FLAG, 8);
    directory.writeUInt16LE(DEFLATE_METHOD, 10);
    directory.writeUInt16LE(stamp.time, 12);
    directory.writeUInt16LE(stamp.date, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(entry.data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt16LE(0, 30);
    directory.writeUInt16LE(0, 32);
    directory.writeUInt16LE(0, 34);
    directory.writeUInt16LE(0, 36);
    directory.writeUInt32LE(0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralOffset = offset;
  const centralSize = central.reduce((size, chunk) => size + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, ...central, end]);
}
