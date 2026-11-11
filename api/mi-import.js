/* Fork (Suslicke/opengym): workouts and weigh-ins out of a Mi Fitness personal-data export, for
   POST /api/hub/v1/import (integrations.js).

   The steps, each a function of its own so it can be tested without a server:

     zipEntry      the export is a zip; the workouts are the one entry ending in
                   hlth_center_sport_record.csv, the weigh-ins are in hlth_center_fitness_data.csv.
     miToCsv       the sport record as openGym's own import CSV: a port of the script this was
                   done by hand with (sleep/scripts/mi-to-opengym.py), row for row and byte for
                   byte. Heart rate is text in the note there, the CSV having no column for it.
     miToImport    the same rows for this import, which puts the heart rate where openGym keeps
                   one (a set's `hr`): the port's CSV with a tag per row for a note, and beside
                   it what each row's set is to get.
     miWeights     the weigh-ins among the fitness data's rows.
     importMi      all of it merged into the profile with the browser's importer
                   (frontend/src/lib/import-csv.js) and saved the way a device saves; the
                   workouts an earlier import left there are brought up to date in place. */
import zlib from 'node:zlib';

export const SPORT_RECORD = 'hlth_center_sport_record.csv';
export const FITNESS_DATA = 'hlth_center_fitness_data.csv';
// What one entry may inflate to. The sport record is a few hundred KB and the fitness data some
// 30 MB; this only stops a small upload from unpacking into gigabytes of memory.
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
    if (size > maxSize) throw new ZipError(413, 'a file in the zip is too large to unpack');
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
      if (e.code === 'ERR_BUFFER_TOO_LARGE') throw new ZipError(413, 'a file in the zip is too large to unpack');
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
 * rate and kcal in the note, which is the only place that file has for them.
 * Returns { csv, workouts, skipped }: rows written, and rows that could not be read or lasted
 * no time at all.
 */
export function miToCsv(text) {
  const { rows, skipped } = sportRows(text);
  return { csv: toCsv(rows.map(r => [...r.cells, noteOf(r, true)])), workouts: rows.length, skipped };
}

// The rows the script writes, in its order: `cells` are a CSV row's columns up to the note, the
// rest is what the note is made of.
function sportRows(text) {
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
      // The workout (day) title is constant: openGym names a day after its first row, and the
      // sport differs from row to row. Python writes a float, so a whole number keeps its ".0".
      out.push({
        cells: ['Mi Fitness', name, 'cardio', s.slice(0, 10), s, e, String(secs), km ? (Number.isInteger(km) ? km + '.0' : String(km)) : ''],
        avg: v.avg_hrm, max: v.max_hrm, kcal: v.total_cal || v.calories, steps: v.steps
      });
    } catch { skipped++; }                              // no JSON, no start or end, not a time
  }
  out.sort((a, b) => (a.cells[4] < b.cells[4] ? -1 : a.cells[4] > b.cells[4] ? 1 : 0));
  return { rows: out, skipped };
}
const SEP = ' · ';
// The script's note. Without `hr` the two heart-rate parts are left out: they have gone to the set.
const noteOf = (r, hr) => [
  hr && r.avg ? `avg HR ${r.avg}` : '',
  hr && r.max ? `max HR ${r.max}` : '',
  r.kcal ? `${r.kcal} kcal` : '',
  r.steps ? `${r.steps} steps` : '',
  'Mi Fitness'
].filter(Boolean).join(SEP);
const toCsv = lines => [HEADER, ...lines].map(r => r.map(csvField).join(',') + '\n').join('');

/* ---------- heart rate, on the set ---------- */

// openGym keeps a heart rate on the logged set, `hr: { avg, max }` (frontend lib/heart-rate.js),
// and shows it after the set in the workout's detail. Its CSV importer has no column for one, and
// it builds the sets itself: a day's rows become one workout, the rows of one exercise one entry,
// and a row it cannot use is dropped without a word. So which set a row became is not guessed
// from the outcome (a name, rounded minutes) but carried through it, in the one column the
// importer hands on as it came: the note. Each row's note is its tag, its index in base 36, all
// tags the same width. The importer joins an entry's notes in the order of its sets, each once,
// so the entry's note afterwards names the row behind every set, and is then written over with
// the notes those rows are to have.

const tagWidth = n => Math.max(n - 1, 0).toString(36).length;
// What the importer keeps of an entry's joined notes (import-csv.js parseWorkoutCSV).
const NOTE_MAX = 280;

/**
 * The sport record for the import that keeps heart rate apart from the note. `sanitizeHr` is
 * frontend/src/lib/heart-rate.js's, the reading every reader of a set's `hr` puts it through.
 * Returns { csv, rows, workouts, skipped }:
 *
 *   csv    miToCsv's, row for row, but for the note: there each row has its tag (above).
 *   rows   by tag, { d, hr, note, was }: the row's day, its heart rate ({ avg, max }, or null
 *          when avg_hrm and max_hrm are not a reading `sanitizeHr` passes), the note it is to
 *          have (the script's, less the heart rate when that has a set to go to) and the note
 *          the script gave it, which is what an import from before this one left in the profile.
 */
export function miToImport(text, sanitizeHr) {
  const { rows: all, skipped } = sportRows(text);
  const width = tagWidth(all.length);
  const rows = all.map(r => {
    const hr = sanitizeHr({ avg: r.avg, max: r.max });
    return { d: r.cells[3], hr, note: noteOf(r, !hr), was: noteOf(r, true) };
  });
  const csv = toCsv(all.map((r, i) => [...r.cells, i.toString(36).padStart(width, '0')]));
  return { csv, rows, workouts: all.length, skipped };
}

/**
 * The workouts the importer made of miToImport's csv (`parsed.workouts`, changed in place), each
 * set given its row's heart rate and each entry the note of its rows, joined as the importer
 * joins them.
 *
 * A tag is taken only for what it says outright: the right width, a row that exists, on this
 * workout's day, not placed before. The importer cuts an entry's joined notes at 280 characters,
 * which is the tags of some forty rows of one sport on one day; past the cut the sets are left
 * without a heart rate rather than given a neighbour's.
 *
 * Returns, per entry, the note the script's CSV gave it (`was`, joined the same way): what
 * refreshOwn knows an earlier import's entry by.
 */
function placeRows(workouts, rows) {
  const tag = new RegExp(`^[0-9a-z]{${tagWidth(rows.length)}}$`);
  const placed = new Set(), before = new Map();
  for (const w of workouts) for (const e of w.entries) {
    const tags = typeof e.note === 'string' ? e.note.split(SEP) : [];
    const notes = [], was = [];
    for (let k = 0; k < tags.length && k < e.sets.length; k++) {
      const i = tag.test(tags[k]) ? parseInt(tags[k], 36) : -1;
      const row = rows[i];
      if (!row || row.d !== w.d || placed.has(i)) break;
      placed.add(i);
      if (row.hr) e.sets[k] = { ...e.sets[k], hr: row.hr };
      if (!notes.includes(row.note)) notes.push(row.note);
      if (!was.includes(row.was)) was.push(row.was);
    }
    const note = notes.join(SEP).slice(0, NOTE_MAX);
    if (note) e.note = note; else delete e.note;
    before.set(e, was.join(SEP).slice(0, NOTE_MAX));
  }
  return before;
}

/* ---------- what an earlier import left ---------- */

// The first import this route made wrote the script's CSV as it was: heart rate in the note,
// none on the set. The importer leaves a day alone that has a workout, so importing again does
// not reach those; they are brought up to date here, in place, and only they.

const noteIn = e => (typeof e?.note === 'string' ? e.note : '');

// Whether `w`, a workout in the profile, is still what the import made of this day (`fresh`):
// the same exercises in the same order, as many sets under each, and under each a note that is
// the import's own, the script's or the one it gives now. An exercise or a set added or taken
// away, a note written or added to: someone has had a hand in it, and it is theirs.
function stillOwn(w, fresh, before) {
  if (w.d !== fresh.d || !Array.isArray(w.entries) || w.entries.length !== fresh.entries.length) return false;
  return fresh.entries.every((fe, i) => {
    const e = w.entries[i];
    if (!e || typeof e !== 'object' || e.id !== fe.id) return false;
    if (!Array.isArray(e.sets) || e.sets.length !== fe.sets.length || !e.sets.every(s => s && typeof s === 'object')) return false;
    return noteIn(e) === noteIn(fe) || noteIn(e) === before.get(fe);
  });
}

/**
 * The workouts in `S` (changed in place) that an earlier import made and nobody has touched
 * since, each set given the heart rate the import has for it now and each entry its note.
 * `workouts` are the importer's, after placeRows; `had` the ids `S` held before this import
 * added any. Returns how many it changed.
 *
 * A workout is the import's own by its id, which the importer works out from the day and its
 * sets and nothing else gives one (import-csv.js importId), and by still looking as it was made
 * (stillOwn). Nothing of it is touched but a set's `hr` and an entry's `note`. A set that has a
 * heart rate keeps it, as the health hub's reading leaves one the watch took
 * (frontend lib/health-read.js); a workout with nothing to gain is not counted.
 */
function refreshOwn(S, workouts, before, had, sanitizeHr) {
  let n = 0;
  for (const fresh of workouts) {
    if (!had.has(fresh.id)) continue;
    const same = S.workouts.filter(w => w && w.id === fresh.id);
    if (same.length !== 1 || !stillOwn(same[0], fresh, before)) continue;
    let changed = false;
    fresh.entries.forEach((fe, i) => {
      const e = same[0].entries[i];
      fe.sets.forEach((fs, k) => {
        if (fs.hr && !sanitizeHr(e.sets[k].hr)) { e.sets[k].hr = fs.hr; changed = true; }
      });
      if (noteIn(e) !== noteIn(fe)) { e.note = fe.note; changed = true; }
    });
    if (changed) n++;
  }
  return n;
}

/* ---------- weigh-ins ---------- */

const numOf = v => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN);

/**
 * The weigh-ins in the export's fitness data (`buf`, the file's bytes): the rows whose `Key` is
 * `weight`, their `Value` a JSON object with `time` in unix seconds and `weight` in kg. Returns
 * [{ t, kg }], `t` in ms, oldest first.
 *
 * The file is every sample the band took, some 300,000 rows and 30 MB around a couple of
 * weigh-ins, so it is not read into rows, nor into one string: the bytes are searched for the
 * word, and only a line that holds it is decoded and parsed.
 */
export function miWeights(buf) {
  const eol = from => { const i = buf.indexOf(10, from); return i < 0 ? buf.length : i; };
  let to = eol(0);
  const head = parseCsv(buf.toString('utf8', 0, to))[0] || [];
  const keyCol = head.indexOf('Key'), valueCol = head.indexOf('Value'), timeCol = head.indexOf('Time');
  const out = [];
  if (keyCol < 0 || valueCol < 0) return out;
  for (let hit; (hit = buf.indexOf('weight', to)) >= 0;) {
    const from = buf.lastIndexOf(10, hit) + 1;
    to = eol(hit);
    // Another kind of row may say the word in its Value; only the Key column makes a weigh-in.
    const r = parseCsv(buf.toString('utf8', from, to))[0];
    if (!r || r[keyCol] !== 'weight') continue;
    try {
      const v = JSON.parse(r[valueCol]);
      const sec = numOf(v.time ?? r[timeCol]), kg = numOf(v.weight);
      if (Number.isFinite(sec) && sec > 0 && Number.isFinite(kg) && kg > 0) out.push({ t: Math.round(sec * 1000), kg });
    } catch { /* not JSON: not a weigh-in */ }
  }
  return out.sort((a, b) => a.t - b.t);
}

const isoLocal = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

/**
 * miWeights' weigh-ins as the app's own body-weight import reads a file ({ kind: 'bodyweight',
 * bodyweight: [{ d, w, t }] }), or null when none of them is one. They go through that import
 * (parseBodyweight) as a "date,weight_kg" file, so what counts as a body weight, the conversion
 * to the profile's unit and the rounding are the app's.
 *
 * One a day, the day's last. A weigh-in has no time zone of its own in the export, so its day is
 * the calendar day of its moment in the server's time zone (TZ): the zone the importer reads
 * every date in, and the summary beside this route counts its days in.
 */
function weighIns(lib, weights, unit) {
  const byDay = new Map();
  for (const x of weights) {
    const d = isoLocal(new Date(x.t));
    if (!(byDay.get(d)?.t > x.t)) byDay.set(d, x);
  }
  const parsed = lib.parseBodyweight('date,weight_kg\n' + [...byDay].map(([d, x]) => `${d},${x.kg}\n`).join(''), { unit });
  if (parsed.error || parsed.kind !== 'bodyweight' || !parsed.bodyweight.length) return null;
  // The moment it was taken: from a date alone the app can only say midnight.
  for (const b of parsed.bodyweight) b.t = byDay.get(b.d)?.t ?? b.t;
  return parsed;
}

/* ---------- into the profile ---------- */

// A second writer landing between the read and the write resolves in a round; past this
// something keeps writing, and the hub is better told than retried at.
const ATTEMPTS = 3;

/**
 * An export merged into the profile and saved, workouts and weigh-ins in the one write. Of the
 * export: `csv`, an import CSV of its workouts (miToImport's, or miToCsv's as it is); `rows`,
 * miToImport's, when the csv is that one; `weights`, miWeights'. Any of them may be missing.
 * `lib` is frontend/src/lib/import-csv.js and `sanitizeHr` frontend/src/lib/heart-rate.js's
 * (needed with `rows`); `read()` answers what GET /api/data would ({ state, rev }, or null when
 * the file cannot be read) and `write(body)` what PUT /api/data would ({ status, ... }). Returns
 * { status, body } for the route to send, the body of a 200 being { workouts, skipped, weights,
 * updated }: days added, days not added because they hold a workout, weigh-ins added, and
 * how many of those days' workouts were an earlier import's and were brought up to date
 * (refreshOwn).
 *
 * mergeImport leaves a day alone that already holds a workout, and a date that already has a
 * weigh-in, so the same export twice adds nothing the second time and finds nothing to bring up
 * to date, and then nothing is written either: the revision does not move.
 *
 * A workout changed in place has to win over the copy of it every device holds. Nothing is
 * stamped here for that: the write says it does not stamp (no `stamped`) and is over the
 * revision read, and for such a writer PUT /api/data stamps what changed itself (sync-stamps.js
 * stampUnstamped): the workout's `_ts` and its `_f.entries`, later than any stamp either copy
 * carries. A device's merge keeps, of a workout both have, the version with the later `_ts` and
 * each field from the side that stamped it last (frontend lib/sync-merge.js mergeEntry); its
 * own copy of an imported workout has no stamp at all, or older ones.
 */
export function importMi({ csv = '', rows = null, weights = [] }, { lib, sanitizeHr, read, write, now = Date.now() }) {
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
    const unit = S.unit === 'lb' ? 'lb' : 'kg';
    const body = { workouts: 0, skipped: 0, weights: 0, updated: 0 };
    const parsed = csv ? lib.parseImport(csv, { unit, customEx: S.customEx }) : null;
    if (parsed && !parsed.error && parsed.kind === 'workouts') {
      const before = rows ? placeRows(parsed.workouts, rows) : null;
      const had = new Set(S.workouts.map(w => w?.id));
      const res = lib.mergeImport(S, parsed);
      body.workouts = res.added; body.skipped = res.skipped;
      if (before) body.updated = refreshOwn(S, parsed.workouts, before, had, sanitizeHr);
    }
    const weighed = weights.length ? weighIns(lib, weights, unit) : null;
    if (weighed) {
      // The list mergeImport reads for these; as with the three above, only because it needs it.
      S.bodyweight = Array.isArray(S.bodyweight) ? S.bodyweight : [];
      body.weights = lib.mergeImport(S, weighed).added;
    }
    if (!body.workouts && !body.weights && !body.updated) return { status: 200, body };
    // What a device's own save stamps (frontend lib/log-workout.js appendLoggedWorkout): a copy
    // restored without its sync marker must not take this document for older than its own.
    S._ts = Math.max(now, (Number(S._ts) || 0) + 1);
    const put = write({ state: S, baseRev: got.rev, ...(typeof got.state._wid === 'string' ? { baseWid: got.state._wid } : {}) });
    if (put.status === 200) return { status: 200, body };
    // 409: another writer got in between. Read again and merge onto what it left.
    if (put.status !== 409) return { status: put.status || 500, body: { error: put.error || 'the profile could not be saved' } };
  }
  return { status: 409, body: { error: 'the profile kept changing; nothing was imported', code: 'conflict' } };
}
