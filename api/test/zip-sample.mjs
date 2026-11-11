/* Fork (Suslicke/opengym): a zip written by hand, for the Mi Fitness import tests. There is no
   zip library in this package (by design), and the reader under test must not be checked against
   itself, so this follows the format note (APPNOTE 4.3) on its own: a local header and the data
   per entry, the central directory, the end record.

   An entry is { name, data } plus `deflate` (method 8 instead of stored), `streamed` (sizes left
   out of the local header, as an archive written to a pipe has them) or `encrypted` (the flag
   only; the data is not). */
import zlib from 'node:zlib';

export function makeZip(entries, { comment = '' } = {}) {
  const files = [], central = [];
  let offset = 0;
  for (const { name, data, deflate = false, streamed = false, encrypted = false } of entries) {
    const raw = Buffer.from(data), body = deflate ? zlib.deflateRawSync(raw) : raw;
    const nm = Buffer.from(name);
    const flags = (streamed ? 8 : 0) | (encrypted ? 1 : 0);
    const crc = zlib.crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    if (!streamed) { local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); }
    local.writeUInt16LE(nm.length, 26);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(deflate ? 8 : 0, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nm.length, 28);
    cd.writeUInt32LE(offset, 42);

    files.push(local, nm, body);
    central.push(cd, nm);
    offset += 30 + nm.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(Buffer.byteLength(comment), 20);
  return Buffer.concat([...files, dir, end, Buffer.from(comment)]);
}

const q = s => '"' + String(s).replace(/"/g, '""') + '"';

/** A sport record: the export's header, and one row per { key, ...the Value's fields } (or a
 *  string, written as the Value as it is). */
export function sportRecord(rows) {
  return 'Uid,Sid,Key,Time,Category,Value,UpdateTime\n' + rows.map(({ key, ...v }) =>
    `1,2,${key},${v.start_time ?? 1},${key},${q(typeof v.raw === 'string' ? v.raw : JSON.stringify(v))},1\n`).join('');
}

/** The fitness data: its header (no Category column, unlike the sport record), and one row per
 *  { key, ...the Value's fields } (or `raw`, written as the Value as it is). A weigh-in is
 *  { key: 'weight', time, weight, bmi }. */
export function fitnessData(rows) {
  return 'Uid,Sid,Key,Time,Value,UpdateTime\n' + rows.map(({ key, ...v }) =>
    `1,2,${key},${v.time ?? 1},${q(typeof v.raw === 'string' ? v.raw : JSON.stringify(v))},1\n`).join('');
}
