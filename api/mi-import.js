/* Fork (Suslicke/opengym): workouts out of a Mi Fitness personal-data export, for
   POST /api/hub/v1/import (integrations.js).

   Three steps, each a function of its own so it can be tested without a server:

     zipEntry      the export is a zip; the workouts are the one entry ending in
                   hlth_center_sport_record.csv.
     miToCsv       that file as openGym's own import CSV: a port of the script this was done by
                   hand with (sleep/scripts/mi-to-opengym.py), row for row and byte for byte.
     importCsv     the CSV merged into the profile with the browser's importer
                   (frontend/src/lib/import-csv.js) and saved the way a device saves. */
import zlib from 'node:zlib';

export const SPORT_RECORD = 'hlth_center_sport_record.csv';
// What one entry may inflate to. The sport record is a few hundred KB; this only stops a small
// upload from unpacking into gigabytes of memory.
export const MAX_ENTRY = 64 * 1024 * 1024;

/* ---------- zip ---------- */

/** A body that is no zip this reads (400), or an entry larger than it will unpack (413). */
export class ZipError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;

/**
 * The bytes of the first file in `buf` whose name ends with `suffix`, or null when the archive
 * has none. Just enough zip for an export: the end record, the central directory, the entry's
 * local header; stored and deflated entries; no zip64, no encryption.
 */
export function zipEntry(buf, suffix, { maxSize = MAX_ENTRY } = {}) {
  // The end record is the last thing in the file, bar a comment of at most 65535 bytes.
  let end = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === EOCD) { end = i; break; }
  }
  if (end < 0) throw new ZipError(400, 'not a zip archive');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff) throw new ZipError(400, 'zip64 archives are not supported');

  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL) throw new ZipError(400, 'damaged zip archive');
    const flags = buf.readUInt16LE(at + 8), method = buf.readUInt16LE(at + 10);
    const packed = buf.readUInt32LE(at + 20), size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28), extraLen = buf.readUInt16LE(at + 30), commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    // An archive made on a Mac carries a resource fork beside every file, under the same name:
    // __MACOSX/._<name>. It is not the file.
    const base = name.slice(name.lastIndexOf('/') + 1);
    if (!name.endsWith(suffix) || base.startsWith('._') || name.startsWith('__MACOSX/')) continue;

    if (flags & 1) throw new ZipError(400, 'the zip is password-protected');
    if (packed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw new ZipError(400, 'zip64 archives are not supported');
    if (size > maxSize) throw new ZipError(413, 'the sport record is too large');
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL) throw new ZipError(400, 'damaged zip archive');
    // The sizes come from the central directory: the local header leaves them zero when the
    // archive was written as a stream. Its name and extra field have lengths of their own.
    const from = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (from + packed > buf.length) throw new ZipError(400, 'damaged zip archive');
    const data = buf.subarray(from, from + packed);
    if (method === 0) return data;
    if (method !== 8) throw new ZipError(400, 'unsupported zip compression');
    // maxOutputLength is the real cap: the size above is only what the archive claims.
    try { return zlib.inflateRawSync(data, { maxOutputLength: maxSize }); }
    catch (e) {
      if (e.code === 'ERR_BUFFER_TOO_LARGE') throw new ZipError(413, 'the sport record is too large');
      throw new ZipError(400, 'damaged zip archive');
    }
  }
  return null;
}

/* ---------- Mi Fitness sport record -> openGym import CSV ---------- */

// Names chosen so openGym's fuzzy matcher does not snap them onto a lift ("Walking" -> "walking
// lunge"); a key that is not here falls back to itself, spaced and capitalised.
export const NAMES = {
  outdoor_walking: 'Outdoor walk',
  indoor_fitness: 'Indoor fitness',
  motion_sensing_game: 'Motion game',
  outdoor_hiking: 'Hike',
  rock_climbing: 'Bouldering',
  outdoor_riding: 'Bike ride',
  outdoor_skating: 'Skating',
  hip_hop_dance: 'Dance'
};
export const HEADER = ['workout name', 'exercise', 'category', 'date', 'start time', 'end time', 'duration seconds', 'distance km', 'note'];

// Quoted fields, doubled quotes, commas and line breaks inside quotes: the Value column is JSON.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (s[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}
const csvField = v => (/[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);

// Python's int(): a whole number, or digits in a string. Anything else throws, and the row is
// skipped where the script skipped it.
function int(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return parseInt(v, 10);
  if (typeof v === 'boolean') return +v;
  throw new TypeError('not an integer');
}
// Python's round(x, 2): the nearest hundredth of the number as stored, and an exact half (only an
// odd number of eighths can be one) to the even digit, where toFixed takes it up.
function round2(x) {
  if (Number.isInteger(x * 8) && !Number.isInteger(x * 4)) {
    const lo = Math.floor(x * 100);
    return (lo % 2 === 0 ? lo : lo + 1) / 100;
  }
  return Number(x.toFixed(2));
}
const pad = n => String(n).padStart(2, '0');
// A unix second as wall-clock time at a fixed offset: "2026-10-26 12:33:20".
function wallClock(sec, offsetMin) {
  const d = new Date((sec + offsetMin * 60) * 1000);
  const y = d.getUTCFullYear();
  if (!(y >= 1000 && y <= 9999)) throw new RangeError('no such date');
  return `${y}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * The export's sport record (one row per workout; `Key` the sport, `Value` a JSON object with
 * unix-second start_time/end_time, duration s, distance m, calories, avg_hrm/max_hrm, steps and
 * timezone in 15-minute units) as openGym's "Your own CSV": one cardio set per workout, heart
 * rate and kcal in the note, which is the only place openGym has for them.
 * Returns { csv, workouts, skipped }: rows written, and rows that could not be read or lasted
 * no time at all.
 */
export function miToCsv(text) {
  const [head = [], ...lines] = parseCsv(text);
  const keyCol = head.indexOf('Key'), valueCol = head.indexOf('Value');
  const out = [];
  let skipped = 0;
  for (const r of lines) {
    try {
      const v = JSON.parse(r[valueCol]);
      const start = int(v.start_time), end = int(v.end_time);
      const tz = 15 * int(v.timezone ?? 20);            // 20 = +05:00, Almaty
      const s = wallClock(start, tz), e = wallClock(end, tz);
      const secs = int(v.duration || end - start);
      if (secs <= 0) { skipped++; continue; }
      const key = r[keyCol];
      if (typeof key !== 'string') throw new TypeError('no Key');
      const spaced = key.replaceAll('_', ' ');
      const name = Object.hasOwn(NAMES, key) ? NAMES[key] : spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
      const km = round2(int(v.distance || 0) / 1000);
      const kcal = v.total_cal || v.calories;
      const note = [
        v.avg_hrm ? `avg HR ${v.avg_hrm}` : '',
        v.max_hrm ? `max HR ${v.max_hrm}` : '',
        kcal ? `${kcal} kcal` : '',
        v.steps ? `${v.steps} steps` : '',
        'Mi Fitness'
      ].filter(Boolean).join(' · ');
      // The workout (day) title is constant: openGym names a day after its first row, and the
      // sport differs from row to row. Python writes a float, so a whole number keeps its ".0".
      out.push(['Mi Fitness', name, 'cardio', s.slice(0, 10), s, e, String(secs), km ? (Number.isInteger(km) ? km + '.0' : String(km)) : '', note]);
    } catch { skipped++; }                              // no JSON, no start or end, not a time
  }
  out.sort((a, b) => (a[4] < b[4] ? -1 : a[4] > b[4] ? 1 : 0));
  const csv = [HEADER, ...out].map(r => r.map(csvField).join(',') + '\n').join('');
  return { csv, workouts: out.length, skipped };
}

/* ---------- into the profile ---------- */

// A second writer landing between the read and the write resolves in a round; past this
// something keeps writing, and the hub is better told than retried at.
const ATTEMPTS = 3;

/**
 * `csv` merged into the profile and saved. `lib` is frontend/src/lib/import-csv.js; `read()`
 * answers what GET /api/data would ({ state, rev }, or null when the file cannot be read) and
 * `write(body)` what PUT /api/data would ({ status, ... }). Returns { status, body } for the
 * route to send.
 *
 * mergeImport leaves a day alone that already holds a workout, so the same export twice adds
 * nothing the second time, and then nothing is written either: the revision does not move.
 */
export function importCsv(csv, { lib, read, write, now = Date.now() }) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const got = read();
    if (!got) return { status: 503, body: { error: 'state unreadable' } };
    // A profile no device has synced yet has no document to merge into. Making one here would
    // hand the first device to sign in a document holding nothing but walks, for it to take as
    // the profile; the MCP's log_workout refuses the same way (mcp/src/write-tools.js).
    if (!got.state || typeof got.state !== 'object') {
      return { status: 409, body: { error: 'this profile has no synced data yet: sign in on a device once', code: 'no-state' } };
    }
    // The document as stored plus the import, nothing else: a setting filled in here would be
    // stamped as an edit made now and land on every device. The three lists mergeImport reads
    // are the exception it needs; the app's own documents always carry them.
    const S = structuredClone(got.state);
    S.workouts = Array.isArray(S.workouts) ? S.workouts : [];
    S.customEx = Array.isArray(S.customEx) ? S.customEx : [];
    S.exWeights = S.exWeights && typeof S.exWeights === 'object' ? S.exWeights : {};
    const parsed = lib.parseImport(csv, { unit: S.unit === 'lb' ? 'lb' : 'kg', customEx: S.customEx });
    if (parsed.error || parsed.kind !== 'workouts') return { status: 200, body: { workouts: 0, skipped: 0 } };
    const res = lib.mergeImport(S, parsed);
    if (!res.added) return { status: 200, body: { workouts: 0, skipped: res.skipped } };
    // What a device's own save stamps (frontend lib/log-workout.js appendLoggedWorkout): a copy
    // restored without its sync marker must not take this document for older than its own.
    S._ts = Math.max(now, (Number(S._ts) || 0) + 1);
    const put = write({ state: S, baseRev: got.rev, ...(typeof got.state._wid === 'string' ? { baseWid: got.state._wid } : {}) });
    if (put.status === 200) return { status: 200, body: { workouts: res.added, skipped: res.skipped } };
    // 409: another writer got in between. Read again and merge onto what it left.
    if (put.status !== 409) return { status: put.status || 500, body: { error: put.error || 'the profile could not be saved' } };
  }
  return { status: 409, body: { error: 'the profile kept changing; nothing was imported', code: 'conflict' } };
}
