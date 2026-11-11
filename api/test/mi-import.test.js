/* Fork (Suslicke/opengym): the pieces of the Mi Fitness import (mi-import.js), without a server.

   The converter's cases are the ones the script it was ported from checks itself with
   (sleep/scripts/mi-to-opengym.py --test), then the rules that script states and does not test.
   The save loop runs against the real importer (frontend/src/lib/import-csv.js) with a profile
   held in memory, so a conflict can be staged.

   The port (miToCsv) keeps its cases, and its CSV still imports as it did, heart rate in the
   note. What the route does with the same rows is pinned beside it: heart rate on the set it
   belongs to (miToImport), the weigh-ins (miWeights), both in the one save (importMi), and the
   workouts an earlier import left in the profile brought up to date in place, stamped by the
   save so that a device's older copy does not undo it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { zipEntry, ZipError, miToCsv, miToImport, miWeights, importMi, HEADER, SPORT_RECORD, FITNESS_DATA } from '../mi-import.js';
import { makeZip, sportRecord, fitnessData } from './zip-sample.mjs';
import * as lib from '../../frontend/src/lib/import-csv.js';
import { sanitizeHr, hrLabel } from '../../frontend/src/lib/heart-rate.js';
import { mergeStates } from '../../frontend/src/lib/sync-merge.js';
import { stampPut } from '../sync-stamps.js';

const table = csv => csv.trimEnd().split('\n').map(l => l.split(','));

/* ---------- miToCsv ---------- */

test('the script\'s own test: two workouts, the unreadable row dropped', () => {
  const src =
    'Uid,Sid,Key,Time,Category,Value,UpdateTime\n' +
    '1,2,outdoor_walking,1793000000,walking,"{""start_time"":1793000000,""end_time"":1793002200,' +
    '""duration"":2200,""distance"":3021,""avg_hrm"":101,""calories"":150,""timezone"":20}",1\n' +
    '1,2,rock_climbing,1793100000,rock_climbing,"{""start_time"":1793100000,""end_time"":1793103600,' +
    '""duration"":3600,""timezone"":20}",1\n' +
    '1,2,broken,1,x,not-json,1\n';
  const out = miToCsv(src);
  assert.equal(out.workouts, 2);
  assert.equal(out.skipped, 1);
  const got = table(out.csv);
  assert.deepEqual(got[0], HEADER);
  assert.deepEqual(got[1].slice(0, 4), ['Mi Fitness', 'Outdoor walk', 'cardio', '2026-10-26']);
  assert.equal(got[1][4], '2026-10-26 12:33:20');
  assert.equal(got[1][5], '2026-10-26 13:10:00');
  assert.equal(got[1][6], '2200');
  assert.equal(got[1][7], '3.02');
  assert.equal(got[1][8], 'avg HR 101 · 150 kcal · Mi Fitness');
  assert.equal(got[2][1], 'Bouldering');
  assert.equal(got[2][7], '');
  assert.equal(got[2][8], 'Mi Fitness');
  assert.equal(got.length, 3);
});

test('a sport without a name of its own is its key, spaced and capitalised', () => {
  const got = table(miToCsv(sportRecord([{ key: 'pool_SWIMMING_laps', start_time: 1700000000, end_time: 1700000600 }])).csv);
  assert.equal(got[1][1], 'Pool swimming laps');
});

test('a workout that lasted no time is skipped; without a duration it is end minus start', () => {
  const out = miToCsv(sportRecord([
    { key: 'outdoor_riding', start_time: 1700000000, end_time: 1700000000 },
    { key: 'outdoor_riding', start_time: 1700000000, end_time: 1699999000 },
    { key: 'outdoor_riding', start_time: 1700000000, end_time: 1700000900, duration: 0 },
    { key: 'outdoor_riding', start_time: 1700003600, end_time: 1700004500, duration: 600 },
    { key: 'outdoor_riding', end_time: 1700004500 },
    { key: 'outdoor_riding', start_time: 'soon', end_time: 1700004500 },
    { key: 'outdoor_riding', raw: 'null' },
  ]));
  assert.equal(out.workouts, 2);
  assert.equal(out.skipped, 5);
  const got = table(out.csv);
  assert.deepEqual(got.slice(1).map(r => r[6]), ['900', '600']);
  assert.deepEqual(got.slice(1).map(r => r[1]), ['Bike ride', 'Bike ride']);
});

test('the time zone is the row\'s own, in quarter hours; +05:00 when it has none', () => {
  // 1700000000 is 2023-11-14 22:13:20 UTC: the next day already in Almaty.
  const at = tz => table(miToCsv(sportRecord([{ key: 'outdoor_hiking', start_time: 1700000000, end_time: 1700003600, ...tz }])).csv)[1];
  assert.deepEqual(at({}).slice(3, 6), ['2023-11-15', '2023-11-15 03:13:20', '2023-11-15 04:13:20']);
  assert.deepEqual(at({ timezone: 20 }).slice(3, 6), ['2023-11-15', '2023-11-15 03:13:20', '2023-11-15 04:13:20']);
  assert.deepEqual(at({ timezone: 0 }).slice(3, 6), ['2023-11-14', '2023-11-14 22:13:20', '2023-11-14 23:13:20']);
  assert.deepEqual(at({ timezone: 22 }).slice(3, 6), ['2023-11-15', '2023-11-15 03:43:20', '2023-11-15 04:43:20']);
  assert.deepEqual(at({ timezone: -32 }).slice(3, 6), ['2023-11-14', '2023-11-14 14:13:20', '2023-11-14 15:13:20']);
});

test('distance is km to two places and blank when zero; the note carries HR, kcal and steps', () => {
  const row = v => table(miToCsv(sportRecord([{ key: 'outdoor_walking', start_time: 1700000000, end_time: 1700000600, ...v }])).csv)[1];
  assert.equal(row({ distance: 0 })[7], '');
  assert.equal(row({ distance: 4 })[7], '');                 // 0.004 km rounds to nothing
  assert.equal(row({ distance: 12345 })[7], '12.35');
  assert.equal(row({ distance: 1005 })[7], '1.0');           // 1.005 is stored just under the half
  assert.equal(row({ distance: 3000 })[7], '3.0');           // Python writes the float
  // An exact half goes to the even digit, as Python's round() sends it.
  assert.equal(row({ distance: 125 })[7], '0.12');
  assert.equal(row({ distance: 375 })[7], '0.38');
  assert.equal(row({ distance: '2500' })[7], '2.5');
  assert.equal(row({ avg_hrm: 120, max_hrm: 164, total_cal: 410, calories: 380, steps: 5210 })[8],
    'avg HR 120 · max HR 164 · 410 kcal · 5210 steps · Mi Fitness');
  assert.equal(row({ avg_hrm: 0, calories: 95 })[8], '95 kcal · Mi Fitness');
});

test('rows come out by start time, whatever the order of the file; a BOM and CRLF are read through', () => {
  const src = '﻿' + sportRecord([
    { key: 'hip_hop_dance', start_time: 1700200000, end_time: 1700200600 },
    { key: 'outdoor_skating', start_time: 1700000000, end_time: 1700000600 },
    { key: 'indoor_fitness', start_time: 1700100000, end_time: 1700100600 },
  ]).replace(/\n/g, '\r\n');
  const got = table(miToCsv(src).csv);
  assert.deepEqual(got.slice(1).map(r => r[1]), ['Skating', 'Indoor fitness', 'Dance']);
  assert.ok(!miToCsv(src).csv.includes('\r'));
});

test('a file that is not a sport record converts to nothing', () => {
  assert.deepEqual(miToCsv(''), { csv: HEADER.join(',') + '\n', workouts: 0, skipped: 0 });
  assert.equal(miToCsv('a,b\n1,2\n3,4\n').workouts, 0);
});

/* ---------- zipEntry ---------- */

const RECORD = sportRecord([{ key: 'outdoor_walking', start_time: 1700000000, end_time: 1700000600 }]);
const NAME = '20261112_123_MiFitness_' + SPORT_RECORD;

test('the sport record is found by the end of its name, stored or deflated, in a folder or not', () => {
  for (const deflate of [false, true]) {
    for (const name of [NAME, 'MiFitness Personal Data/' + NAME]) {
      const zip = makeZip([
        { name: 'MiFitness Personal Data/', data: '' },
        { name: 'other_hlth_center_aggregated_fitness_data.csv', data: 'a,b\n', deflate },
        { name, data: RECORD, deflate },
        { name: 'last.csv', data: 'x\n' },
      ], { comment: 'exported' });
      assert.equal(zipEntry(zip, SPORT_RECORD).toString(), RECORD, `${name} deflate=${deflate}`);
    }
  }
});

test('an archive written as a stream has its sizes in the central directory only', () => {
  const zip = makeZip([{ name: NAME, data: RECORD, deflate: true, streamed: true }]);
  assert.equal(zipEntry(zip, SPORT_RECORD).toString(), RECORD);
});

test('a Mac\'s resource fork of the same name is not the file', () => {
  const zip = makeZip([
    { name: '__MACOSX/._' + NAME, data: 'Mac OS X' },
    { name: 'export/._' + NAME, data: 'Mac OS X' },
    { name: 'export/' + NAME, data: RECORD },
  ]);
  assert.equal(zipEntry(zip, SPORT_RECORD).toString(), RECORD);
  assert.equal(zipEntry(makeZip([{ name: '__MACOSX/._' + NAME, data: 'Mac OS X' }]), SPORT_RECORD), null);
});

test('an archive without the file is null, not an error', () => {
  assert.equal(zipEntry(makeZip([{ name: 'sleep.csv', data: 'a\n' }]), SPORT_RECORD), null);
  assert.equal(zipEntry(makeZip([]), SPORT_RECORD), null);
});

test('the fitness data is a file of its own, not the aggregated one beside it', () => {
  const zip = makeZip([
    { name: 'x/20261112_123_MiFitness_hlth_center_aggregated_fitness_data.csv', data: 'aggregated\n', deflate: true },
    { name: 'x/20261112_123_MiFitness_hlth_center_fitness_data.csv', data: 'samples\n', deflate: true },
    { name: 'x/' + NAME, data: RECORD },
  ]);
  assert.equal(zipEntry(zip, FITNESS_DATA).toString(), 'samples\n');
  assert.equal(zipEntry(zip, SPORT_RECORD).toString(), RECORD);
});

test('what is not a zip, or not one this reads, is a ZipError with the status to answer', () => {
  const status = fn => { try { fn(); } catch (e) { assert.ok(e instanceof ZipError, String(e)); return e.status; } return 'no error'; };
  assert.equal(status(() => zipEntry(Buffer.alloc(0), SPORT_RECORD)), 400);
  assert.equal(status(() => zipEntry(Buffer.from('{"state":{}}'), SPORT_RECORD)), 400);
  assert.equal(status(() => zipEntry(Buffer.from(RECORD), SPORT_RECORD)), 400);
  const good = makeZip([{ name: NAME, data: RECORD, deflate: true }]);
  // Cut short: the end record is gone.
  assert.equal(status(() => zipEntry(good.subarray(0, good.length - 10), SPORT_RECORD)), 400);
  // The directory points past the data.
  const moved = Buffer.from(good); moved.writeUInt32LE(good.length + 5, good.length - 22 + 16);
  assert.equal(status(() => zipEntry(moved, SPORT_RECORD)), 400);
  // The deflate stream is not one.
  const broken = Buffer.from(good); broken.fill(0xff, 30 + NAME.length, 30 + NAME.length + 8);
  assert.equal(status(() => zipEntry(broken, SPORT_RECORD)), 400);
  assert.equal(status(() => zipEntry(makeZip([{ name: NAME, data: RECORD, encrypted: true }]), SPORT_RECORD)), 400);
  const lzma = makeZip([{ name: NAME, data: RECORD }]);
  lzma.writeUInt16LE(14, lzma.length - 22 - 46 - NAME.length + 10);
  assert.equal(status(() => zipEntry(lzma, SPORT_RECORD)), 400);
});

test('an entry larger than the cap is refused, by its claim and by what it inflates to', () => {
  const big = Buffer.alloc(200000, 'a');
  const zip = makeZip([{ name: NAME, data: big, deflate: true }]);
  assert.equal(zipEntry(zip, SPORT_RECORD, { maxSize: 200000 }).length, 200000);
  assert.throws(() => zipEntry(zip, SPORT_RECORD, { maxSize: 199999 }), e => e instanceof ZipError && e.status === 413);
  // A claim of 10 bytes in front of 200000: the inflate is what stops it.
  const lying = Buffer.from(zip);
  lying.writeUInt32LE(10, zip.length - 22 - 46 - NAME.length + 24);
  assert.throws(() => zipEntry(lying, SPORT_RECORD, { maxSize: 1000 }), e => e instanceof ZipError && e.status === 413);
  assert.ok(zlib.deflateRawSync(big).length < 1000, 'the bomb is small on the wire');
});

/* ---------- importMi: the port's CSV as it is ---------- */

const CSV = miToCsv(sportRecord([
  { key: 'outdoor_walking', start_time: 1700000000, end_time: 1700002200, distance: 3021, avg_hrm: 101 },
  { key: 'rock_climbing', start_time: 1700100000, end_time: 1700103600 },
])).csv;
const profile = () => ({
  unit: 'kg', _ts: 5, customEx: [], exWeights: {}, routines: [],
  workouts: [{ id: 'w_old', d: '2023-11-01', start: 1, end: 2, name: 'Push', entries: [], prs: [] }]
});
// A profile in memory behind the two functions the route is given: GET's answer, PUT's outcome.
function store(doc, { conflicts = 0 } = {}) {
  const h = { doc, rev: doc ? 7 : 0, reads: 0, writes: [] };
  h.read = () => { h.reads++; return { state: h.doc && structuredClone(h.doc), rev: h.rev }; };
  h.write = body => {
    h.writes.push(body);
    if (body.baseRev !== h.rev) return { status: 409, error: 'conflict' };
    if (conflicts-- > 0) {
      // Another device saved a workout just before this write landed.
      h.doc.workouts.push({ id: 'w_race' + h.rev, d: '2023-12-0' + (h.rev - 6), start: 1, end: 2, name: 'Legs', entries: [], prs: [] });
      h.rev++;
      return { status: 409, error: 'conflict' };
    }
    h.doc = body.state; h.rev++;
    return { status: 200, ok: true };
  };
  return h;
}

test('the workouts are merged into the document read, and written over its revision', () => {
  const h = store(profile());
  const out = importMi({ csv: CSV }, { lib, read: h.read, write: h.write, now: 1000 });
  assert.deepEqual(out, { status: 200, body: { workouts: 2, skipped: 0, weights: 0, updated: 0 } });
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].baseRev, 7);
  assert.equal(h.writes[0].stamped, undefined, 'the server stamps what this writer changed');
  assert.deepEqual(h.doc.workouts.map(w => w.d), ['2023-11-01', '2023-11-15', '2023-11-16']);
  assert.deepEqual(h.doc.workouts[0], profile().workouts[0]);
  assert.deepEqual(h.doc.customEx.map(c => c.n), ['outdoor walk', 'bouldering']);
  assert.equal(h.doc._ts, 1000);
  assert.equal(h.doc.unit, 'kg');
});

test('the same file again adds nothing and writes nothing', () => {
  const h = store(profile());
  importMi({ csv: CSV }, { lib, read: h.read, write: h.write });
  const ids = h.doc.workouts.map(w => w.id);
  const out = importMi({ csv: CSV }, { lib, read: h.read, write: h.write });
  assert.deepEqual(out, { status: 200, body: { workouts: 0, skipped: 2, weights: 0, updated: 0 } });
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.doc.workouts.map(w => w.id), ids);
});

test('a write that lost a race is merged again onto what the other writer left', () => {
  const h = store(profile(), { conflicts: 2 });
  const out = importMi({ csv: CSV }, { lib, read: h.read, write: h.write });
  assert.deepEqual(out, { status: 200, body: { workouts: 2, skipped: 0, weights: 0, updated: 0 } });
  assert.equal(h.reads, 3);
  assert.deepEqual(h.writes.map(w => w.baseRev), [7, 8, 9]);
  assert.deepEqual(h.doc.workouts.map(w => w.d), ['2023-11-01', '2023-11-15', '2023-11-16', '2023-12-01', '2023-12-02']);
});

test('after three lost races it gives up, with nothing written', () => {
  const h = store(profile(), { conflicts: 9 });
  const out = importMi({ csv: CSV }, { lib, read: h.read, write: h.write });
  assert.equal(out.status, 409);
  assert.equal(out.body.code, 'conflict');
  assert.equal(h.writes.length, 3);
  assert.ok(!h.doc.workouts.some(w => w.name === 'Mi Fitness'));
});

test('a profile with no document yet is refused rather than made; an unreadable one is a 503', () => {
  const h = store(null);
  const out = importMi({ csv: CSV }, { lib, read: h.read, write: h.write });
  assert.equal(out.status, 409);
  assert.equal(out.body.code, 'no-state');
  assert.equal(h.writes.length, 0);
  assert.equal(importMi({ csv: CSV }, { lib, read: () => null, write: h.write }).status, 503);
  assert.equal(h.writes.length, 0);
});

test('a refusal from the write is passed on as it is', () => {
  const h = store(profile());
  const out = importMi({ csv: CSV }, { lib, read: h.read, write: () => ({ status: 400, error: 'invalid state' }) });
  assert.deepEqual(out, { status: 400, body: { error: 'invalid state' } });
});

test('a document without the lists the importer reads still takes the workouts', () => {
  const h = store({ unit: 'kg', routines: [] });
  const out = importMi({ csv: CSV }, { lib, read: h.read, write: h.write });
  assert.deepEqual(out.body, { workouts: 2, skipped: 0, weights: 0, updated: 0 });
  assert.equal(h.doc.workouts.length, 2);
});

test('the port\'s CSV imports as it always did: heart rate in the note, none on the set', () => {
  const h = store(profile());
  importMi({ csv: CSV }, { lib, read: h.read, write: h.write });
  const walk = h.doc.workouts[1].entries[0];
  assert.deepEqual(walk.sets, [{ min: 36.7, speed: 4.9, done: true }]);
  assert.equal(walk.note, 'avg HR 101 · Mi Fitness');
});

/* ---------- miToImport ---------- */

test('for the import the CSV is the port\'s but for the note, and each row says what its set gets', () => {
  const src = sportRecord([
    { key: 'outdoor_walking', start_time: 1700000000, end_time: 1700002200, distance: 3021, avg_hrm: 128, max_hrm: 140, calories: 168, steps: 2977 },
    { key: 'rock_climbing', start_time: 1700100000, end_time: 1700103600, avg_hrm: 101, calories: 150 },           // no maximum
    { key: 'outdoor_riding', start_time: 1700200000, end_time: 1700203600, avg_hrm: 150, max_hrm: 120 },           // a maximum under the average
    { key: 'hip_hop_dance', start_time: 1700300000, end_time: 1700303600, avg_hrm: 12, max_hrm: 300, steps: 40 },  // not a pulse
    { key: 'outdoor_skating', start_time: 1700350000, end_time: 1700353600, avg_hrm: '97.6', max_hrm: 121 },
    { key: 'outdoor_hiking', start_time: 1700400000, end_time: 1700403600 },
    { key: 'broken', raw: 'not-json' },
  ]);
  const port = miToCsv(src), out = miToImport(src, sanitizeHr);
  assert.equal(out.workouts, 6);
  assert.equal(out.skipped, 1);
  const a = table(port.csv), b = table(out.csv);
  assert.deepEqual(b.map(r => r.slice(0, 8)), a.map(r => r.slice(0, 8)));
  assert.deepEqual(b.slice(1).map(r => r[8]), ['0', '1', '2', '3', '4', '5']);
  assert.deepEqual(out.rows.map(r => r.d), a.slice(1).map(r => r[3]));
  assert.deepEqual(out.rows.map(r => r.hr), [{ avg: 128, max: 140 }, null, null, null, { avg: 98, max: 121 }, null]);
  assert.deepEqual(out.rows.map(r => r.note), [
    '168 kcal · 2977 steps · Mi Fitness',
    'avg HR 101 · 150 kcal · Mi Fitness',
    'avg HR 150 · max HR 120 · Mi Fitness',
    'avg HR 12 · max HR 300 · 40 steps · Mi Fitness',
    'Mi Fitness',
    'Mi Fitness',
  ]);
  // A row whose heart rate has no set to go to keeps the port's note to the letter.
  out.rows.forEach((r, i) => { if (!r.hr) assert.equal(r.note, a[i + 1][8]); });
});

test('the tags are all of one width, however many rows there are', () => {
  const many = n => miToImport(sportRecord(Array.from({ length: n }, (_, i) => ({ key: 'outdoor_walking', start_time: 1700000000 + i * 86400, end_time: 1700000600 + i * 86400 }))), sanitizeHr);
  assert.deepEqual(table(many(36).csv).slice(1).map(r => r[8]).filter((_, i) => i % 35 === 0), ['0', 'z']);
  assert.deepEqual(table(many(37).csv).slice(1).map(r => r[8]).filter((_, i) => i % 36 === 0), ['00', '10']);
  assert.deepEqual(miToImport('', sanitizeHr), { csv: HEADER.join(',') + '\n', rows: [], workouts: 0, skipped: 0 });
});

/* ---------- importMi: heart rate on the set ---------- */

const deps = h => ({ lib, sanitizeHr, read: h.read, write: h.write });

test('a heart rate lands on its set and leaves the note; a row without one keeps the note it had', () => {
  const src = sportRecord([
    { key: 'outdoor_walking', start_time: 1700000000, end_time: 1700002200, distance: 3021, avg_hrm: 128, max_hrm: 140, calories: 168, steps: 2977 },
    { key: 'rock_climbing', start_time: 1700100000, end_time: 1700103600, avg_hrm: 101, calories: 150 },
  ]);
  const h = store(profile());
  const out = importMi(miToImport(src, sanitizeHr), deps(h));
  assert.deepEqual(out, { status: 200, body: { workouts: 2, skipped: 0, weights: 0, updated: 0 } });
  const [, walk, climb] = h.doc.workouts;
  assert.deepEqual(walk.entries[0].sets, [{ min: 36.7, speed: 4.9, done: true, hr: { avg: 128, max: 140 } }]);
  assert.equal(walk.entries[0].note, '168 kcal · 2977 steps · Mi Fitness');
  // What the workout's detail shows after the set (frontend sheets.jsx).
  assert.equal(hrLabel(walk.entries[0].sets[0]), ' ♥ 128/140');
  assert.deepEqual(climb.entries[0].sets, [{ min: 60, speed: 0, done: true }]);
  assert.equal(climb.entries[0].note, 'avg HR 101 · 150 kcal · Mi Fitness');
  // The session keeps none of its own: a day is several activities, and no reader shows one.
  assert.equal(walk.hr, undefined);

  // Nothing else of the workout differs from the port's: the same days under the same ids.
  const p = store(profile());
  importMi({ csv: miToCsv(src).csv }, deps(p));
  const bare = w => ({ ...w, entries: w.entries.map(({ note, ...e }) => ({ ...e, sets: e.sets.map(({ hr, ...s }) => s) })) });
  assert.deepEqual(h.doc.workouts.map(bare), p.doc.workouts.map(bare));
  assert.deepEqual(h.doc.customEx, p.doc.customEx);
});

test('a day with several activities: every set has the heart rate of its own row', () => {
  // All on 2023-11-15 at +05:00, the file out of order: three walks (one entry, three sets), a
  // climb between them, and a walk of two seconds, which the importer drops without a word.
  const src = sportRecord([
    { key: 'outdoor_walking', start_time: 1700030000, end_time: 1700031800, distance: 2000, avg_hrm: 131, max_hrm: 150, calories: 90 },
    { key: 'rock_climbing', start_time: 1700010000, end_time: 1700013600, avg_hrm: 110, max_hrm: 165 },
    { key: 'outdoor_walking', start_time: 1700020000, end_time: 1700020002, avg_hrm: 99, max_hrm: 100 },
    { key: 'outdoor_walking', start_time: 1700000000, end_time: 1700002200, distance: 3021, avg_hrm: 101, max_hrm: 118, calories: 150 },
    { key: 'outdoor_walking', start_time: 1700040000, end_time: 1700041200, distance: 1000, avg_hrm: 140 },
  ]);
  const h = store(profile());
  assert.deepEqual(importMi(miToImport(src, sanitizeHr), deps(h)).body, { workouts: 1, skipped: 0, weights: 0, updated: 0 });
  const day = h.doc.workouts[1];
  assert.equal(day.d, '2023-11-15');
  assert.equal(day.entries.length, 2);
  const [walks, climb] = day.entries;
  assert.deepEqual(walks.sets.map(({ min, hr }) => ({ min, hr })), [
    { min: 36.7, hr: { avg: 101, max: 118 } },
    { min: 30, hr: { avg: 131, max: 150 } },
    { min: 20, hr: undefined },
  ]);
  assert.equal(walks.note, '150 kcal · Mi Fitness · 90 kcal · Mi Fitness · avg HR 140 · Mi Fitness');
  assert.deepEqual(climb.sets.map(({ min, hr }) => ({ min, hr })), [{ min: 60, hr: { avg: 110, max: 165 } }]);
  assert.equal(climb.note, 'Mi Fitness');
});

test('two activities of one length on one day are still told apart', () => {
  // Nothing in the sets differs but the heart rate: only the row itself says which is which.
  const walk = (start, avg, max) => ({ key: 'outdoor_walking', start_time: start, end_time: start + 1800, distance: 2000, avg_hrm: avg, max_hrm: max });
  const h = store(profile());
  importMi(miToImport(sportRecord([walk(1700030000, 150, 171), walk(1700000000, 96, 104), walk(1700010000, 120, 133)]), sanitizeHr), deps(h));
  assert.deepEqual(h.doc.workouts[1].entries[0].sets, [
    { min: 30, speed: 4, done: true, hr: { avg: 96, max: 104 } },
    { min: 30, speed: 4, done: true, hr: { avg: 120, max: 133 } },
    { min: 30, speed: 4, done: true, hr: { avg: 150, max: 171 } },
  ]);
  assert.equal(h.doc.workouts[1].entries[0].note, 'Mi Fitness');
});

test('past what the importer keeps of a day\'s notes a set is left without a heart rate, never given another\'s', () => {
  // Sixty walks of a minute on one day; row i has the pulse 60+i / 120+i.
  const rows = Array.from({ length: 60 }, (_, i) => ({ key: 'outdoor_walking', start_time: 1700000000 + i * 600, end_time: 1700000060 + i * 600, avg_hrm: 60 + i, max_hrm: 120 + i }));
  const h = store(profile());
  importMi(miToImport(sportRecord(rows.reverse()), sanitizeHr), deps(h));
  const sets = h.doc.workouts[1].entries[0].sets;
  assert.equal(sets.length, 60);
  const given = sets.filter(s => s.hr).length;
  assert.ok(given >= 40 && given < 60, `${given} sets with a heart rate`);
  sets.forEach((s, k) => assert.deepEqual(s.hr, k < given ? { avg: 60 + k, max: 120 + k } : undefined, `set ${k}`));
  assert.equal(h.doc.workouts[1].entries[0].note, 'Mi Fitness');
});

/* ---------- miWeights ---------- */

test('the weigh-ins are the rows whose Key is weight, wherever else the word turns up', () => {
  const data = fitnessData([
    { key: 'steps', time: 1700000000, steps: 12 },
    { key: 'weight', time: 1700050000, weight: 81.4, bmi: 24.1 },
    { key: 'body_composition', time: 1700050001, weight: 99, note: 'weight' },   // says the word, is not one
    { key: 'weight', raw: 'not-json' },
    { key: 'weight', raw: 'null' },
    { key: 'weight', time: 1700050002, weight: 0 },
    { key: 'weight', time: 1700050003 },
    { key: 'weight', time: 1700050004, weight: true },
    { key: 'weight', time: 'then', weight: 80 },
    { key: 'heart_rate', time: 1700000060, bpm: 61 },
    { key: 'weight', time: 1699900000, weight: '80.9' },
    { key: 'weight', time: 1700060000, raw: '{"weight":80.2}' },                 // no time of its own: the row's
  ]);
  assert.deepEqual(miWeights(Buffer.from(data)), [
    { t: 1699900000000, kg: 80.9 },
    { t: 1700050000000, kg: 81.4 },
    { t: 1700060000000, kg: 80.2 },
  ]);
});

test('a BOM, CRLF, a quoted Key and a last line without its line break are read through', () => {
  const odd = '﻿Uid,Sid,Key,Time,Value,UpdateTime\r\n' +
    '1,2,steps,1,"{""weight"":1}",1\r\n' +
    '1,2,"weight",5,"{""time"":1700050000,""weight"":81.4}",1\r\n' +
    '1,2,weight,5,"{""time"":1700060000,""weight"":81.9}",1';
  assert.deepEqual(miWeights(Buffer.from(odd)), [{ t: 1700050000000, kg: 81.4 }, { t: 1700060000000, kg: 81.9 }]);
});

test('a file that is not the fitness data has no weigh-ins', () => {
  assert.deepEqual(miWeights(Buffer.alloc(0)), []);
  assert.deepEqual(miWeights(Buffer.from('weight')), []);
  assert.deepEqual(miWeights(Buffer.from('a,b\nweight,"{""time"":1700050000,""weight"":81.4}"\n')), []);
  assert.deepEqual(miWeights(Buffer.from(fitnessData([]))), []);
  assert.deepEqual(miWeights(Buffer.from(fitnessData([{ key: 'steps', time: 1, steps: 3 }]))), []);
});

test('the weigh-ins are found in a file of a hundred thousand rows without reading them all', () => {
  const sample = '1,2,heart_rate,1700000000,"{""time"":1700000000,""bpm"":61}",1\n';
  const buf = Buffer.concat([
    Buffer.from('Uid,Sid,Key,Time,Value,UpdateTime\n' + sample.repeat(50000)),
    Buffer.from('1,2,weight,1700050000,"{""time"":1700050000,""weight"":81.4,""bmi"":24.1}",1\n'),
    Buffer.from(sample.repeat(50000)),
    Buffer.from('1,2,weight,1700060000,"{""time"":1700060000,""weight"":81.9,""bmi"":24.2}",1\n'),
  ]);
  const before = process.memoryUsage().heapUsed, t0 = performance.now();
  assert.deepEqual(miWeights(buf), [{ t: 1700050000000, kg: 81.4 }, { t: 1700060000000, kg: 81.9 }]);
  // The file is 6 MB; as rows it would be tens of MB of heap. Generous bounds, for a slow runner.
  assert.ok(process.memoryUsage().heapUsed - before < buf.length / 2, 'the heap did not take the file in');
  assert.ok(performance.now() - t0 < 1000, 'and it took no time to speak of');
});

/* ---------- importMi: weigh-ins ---------- */

// Midday UTC: the same calendar day wherever the test runs (the day is the server's, see the
// server test for a zone that moves it).
const NOON = Date.UTC(2023, 10, 16, 12) / 1000;
const weighed = rows => miWeights(Buffer.from(fitnessData(rows.map(r => ({ key: 'weight', bmi: 24, ...r })))));
const WEIGHTS = weighed([
  { time: NOON, weight: 81.44 },
  { time: NOON + 600, weight: 81.26 },                 // later the same day: the one that counts
  { time: NOON + 86400, weight: 79 },                  // the profile has that day already
  { time: NOON + 2 * 86400, weight: 80.30000305175781 },
  { time: NOON + 3 * 86400, weight: 900 },             // no body weighs that
]);

test('weigh-ins are added once: a day\'s last, in the profile\'s unit, and a date that has one is left alone', () => {
  const h = store({ ...profile(), bodyweight: [{ d: '2023-11-17', w: 82 }] });
  const out = importMi({ weights: WEIGHTS }, deps(h));
  assert.deepEqual(out, { status: 200, body: { workouts: 0, skipped: 0, weights: 2, updated: 0 } });
  assert.deepEqual(h.doc.bodyweight, [
    { d: '2023-11-16', w: 81.26, t: (NOON + 600) * 1000, src: 'import' },
    { d: '2023-11-17', w: 82 },
    { d: '2023-11-18', w: 80.3, t: (NOON + 2 * 86400) * 1000, src: 'import' },
  ]);
  assert.deepEqual(h.doc.workouts, profile().workouts);
  assert.equal(h.writes.length, 1);

  // The same weigh-ins again: nothing added, nothing written.
  assert.deepEqual(importMi({ weights: WEIGHTS }, deps(h)), { status: 200, body: { workouts: 0, skipped: 0, weights: 0, updated: 0 } });
  assert.equal(h.writes.length, 1);
  assert.equal(h.doc.bodyweight.length, 3);
});

test('a profile in pounds gets them in pounds; one without a body weight list still takes them', () => {
  const h = store({ ...profile(), unit: 'lb' });
  assert.equal(importMi({ weights: WEIGHTS }, deps(h)).body.weights, 3);
  assert.deepEqual(h.doc.bodyweight.map(b => [b.d, b.w]), [['2023-11-16', 179.15], ['2023-11-17', 174.17], ['2023-11-18', 177.03]]);
});

test('workouts and weigh-ins go in the one write, and either is written without the other', () => {
  const both = store(profile());
  assert.deepEqual(importMi({ csv: CSV, weights: WEIGHTS }, deps(both)).body, { workouts: 2, skipped: 0, weights: 3, updated: 0 });
  assert.equal(both.writes.length, 1);
  assert.equal(both.doc.workouts.length, 3);
  assert.equal(both.doc.bodyweight.length, 3);

  // The workouts are there already, the weigh-ins are new; then the other way round.
  const w = store(profile());
  importMi({ csv: CSV }, deps(w));
  assert.deepEqual(importMi({ csv: CSV, weights: WEIGHTS }, deps(w)).body, { workouts: 0, skipped: 2, weights: 3, updated: 0 });
  const c = store(profile());
  importMi({ weights: WEIGHTS }, deps(c));
  assert.deepEqual(importMi({ csv: CSV, weights: WEIGHTS }, deps(c)).body, { workouts: 2, skipped: 0, weights: 0, updated: 0 });
  for (const h of [w, c]) {
    assert.equal(h.writes.length, 2);
    assert.deepEqual(h.doc.workouts.map(x => x.id), both.doc.workouts.map(x => x.id));
    assert.deepEqual(h.doc.bodyweight, both.doc.bodyweight);
  }
});

test('an export with nothing in it reads the profile and writes nothing', () => {
  const h = store(profile());
  for (const data of [{}, { csv: '' }, { csv: HEADER.join(',') + '\n', rows: [], weights: [] }, { weights: weighed([{ time: NOON, weight: 900 }]) }]) {
    assert.deepEqual(importMi(data, deps(h)), { status: 200, body: { workouts: 0, skipped: 0, weights: 0, updated: 0 } });
  }
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.doc, profile());
});

/* ---------- importMi: what an earlier import left ---------- */

// Five days at +05:00. The 15th has three activities, two of them walks; the 16th's climb has
// only an average, the 19th's hike no heart rate at all: nothing for a set on either.
const EARLIER = [
  { key: 'outdoor_walking', start_time: 1700000000, end_time: 1700002200, distance: 3021, avg_hrm: 101, max_hrm: 118, calories: 150 },
  { key: 'rock_climbing', start_time: 1700010000, end_time: 1700013600, avg_hrm: 110, max_hrm: 165 },
  { key: 'outdoor_walking', start_time: 1700030000, end_time: 1700031800, distance: 2000, avg_hrm: 131, max_hrm: 150, calories: 90 },
  { key: 'rock_climbing', start_time: 1700100000, end_time: 1700103600, avg_hrm: 101, calories: 150 },
  { key: 'outdoor_riding', start_time: 1700200000, end_time: 1700203600, distance: 12000, avg_hrm: 140, max_hrm: 171, calories: 300 },
  { key: 'hip_hop_dance', start_time: 1700300000, end_time: 1700303600, avg_hrm: 120, max_hrm: 150, steps: 4000 },
  { key: 'outdoor_hiking', start_time: 1700400000, end_time: 1700403600 },
];
// A profile as the first deployment left it: the script's CSV imported as it was.
const earlier = (rows = EARLIER, opts) => {
  const h = store(profile(), opts);
  importMi({ csv: miToCsv(sportRecord(rows)).csv }, deps(h));
  return h;
};
const again = (h, rows = EARLIER) => importMi(miToImport(sportRecord(rows), sanitizeHr), deps(h));
// The same days imported for the first time by this version: what an update is to arrive at.
const afresh = () => { const h = store(profile()); again(h); return h.doc.workouts; };
const byDay = (h, d) => h.doc.workouts.find(w => w.d === d);

test('workouts of an earlier import get the heart rate on their sets and the note without it', () => {
  const h = earlier();
  const before = structuredClone(h.doc);
  assert.equal(byDay(h, '2023-11-15').entries[0].note, 'avg HR 101 · max HR 118 · 150 kcal · Mi Fitness · avg HR 131 · max HR 150 · 90 kcal · Mi Fitness');
  assert.ok(h.doc.workouts.every(w => w.entries.every(e => e.sets.every(s => !s.hr))));

  const out = again(h);
  // Three of the five days had a heart rate to move; all five are days the importer leaves alone.
  assert.deepEqual(out, { status: 200, body: { workouts: 0, skipped: 5, weights: 0, updated: 3 } });
  assert.equal(h.rev, 9, 'the revision moved: once for the first import, once for this');
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[1].stamped, undefined, 'the save stamps what changed, see below');
  const day = byDay(h, '2023-11-15');
  assert.deepEqual(day.entries[0].sets, [
    { min: 36.7, speed: 4.9, done: true, hr: { avg: 101, max: 118 } },
    { min: 30, speed: 4, done: true, hr: { avg: 131, max: 150 } },
  ]);
  assert.equal(day.entries[0].note, '150 kcal · Mi Fitness · 90 kcal · Mi Fitness');
  assert.deepEqual(day.entries[1].sets, [{ min: 60, speed: 0, done: true, hr: { avg: 110, max: 165 } }]);
  assert.equal(day.entries[1].note, 'Mi Fitness');
  // The whole history is what importing these days for the first time gives now.
  assert.deepEqual(h.doc.workouts.slice(1), afresh().slice(1));
  // And nothing but a set's heart rate and an entry's note is different from before.
  const bare = w => ({ ...w, entries: w.entries.map(({ note, ...e }) => ({ ...e, sets: e.sets.map(({ hr, ...x }) => x) })) });
  assert.deepEqual(h.doc.workouts.map(bare), before.workouts.map(bare));
  assert.deepEqual({ ...h.doc, workouts: 0, _ts: 0 }, { ...before, workouts: 0, _ts: 0 });
  // The two days with nothing to gain are as they were, to the letter.
  for (const d of ['2023-11-16', '2023-11-19']) assert.deepEqual(byDay(h, d), before.workouts.find(w => w.d === d), d);

  // Once more: nothing to bring up to date, nothing written.
  assert.deepEqual(again(h), { status: 200, body: { workouts: 0, skipped: 5, weights: 0, updated: 0 } });
  assert.equal(h.writes.length, 2);
  assert.equal(h.rev, 9);
});

test('a workout somebody changed is left alone, whatever was changed', () => {
  const changes = {
    'a set added': w => w.entries[0].sets.push({ min: 5, speed: 6, done: true }),
    'a set removed': w => w.entries[0].sets.pop(),
    'an exercise added': w => w.entries.push({ id: '0001', sets: [{ w: 20, r: 10, done: true }], topW: 20 }),
    'an exercise removed': w => w.entries.pop(),
    'another exercise in its place': w => { w.entries[1].id = '0001'; },
    'the exercises in another order': w => w.entries.reverse(),
    'a note written over the import\'s': w => { w.entries[1].note = 'felt strong'; },
    'a note added to': w => { w.entries[0].note += ' · sore knee'; },
    'a note removed': w => { delete w.entries[0].note; },
    'not the import\'s workout at all': w => { w.id = 'w_mine'; },
    'the workout twice': (w, S) => S.workouts.push(structuredClone(w)),
  };
  for (const [what, change] of Object.entries(changes)) {
    const h = earlier();
    change(byDay(h, '2023-11-15'), h.doc);
    const kept = structuredClone(h.doc.workouts.filter(w => w.d === '2023-11-15'));
    // The other two days still are the import's, and are brought up to date.
    assert.deepEqual(again(h).body, { workouts: 0, skipped: 5, weights: 0, updated: 2 }, what);
    assert.deepEqual(h.doc.workouts.filter(w => w.d === '2023-11-15'), kept, what);
    assert.deepEqual(byDay(h, '2023-11-17').entries[0].sets[0].hr, { avg: 140, max: 171 }, what);
  }
});

test('what else a workout carries stays as it is: its name, times and whatever a device put on it', () => {
  const h = earlier();
  const w = byDay(h, '2023-11-17');
  Object.assign(w, { name: 'Sunday ride', start: w.start + 60000, end: w.end + 3600000, bw: 81, _ts: 500, _f: { name: 500 }, media: [{ h: 'abc' }] });
  w.entries[0].sets[0].min = 61;                                 // the length corrected by hand
  w.entries[0].noProg = true;
  const kept = structuredClone(w);
  assert.equal(again(h).body.updated, 3);
  const now = byDay(h, '2023-11-17');
  assert.deepEqual(now.entries[0].sets, [{ ...kept.entries[0].sets[0], hr: { avg: 140, max: 171 } }]);
  assert.equal(now.entries[0].note, '300 kcal · Mi Fitness');
  assert.deepEqual({ ...now, entries: 0 }, { ...kept, entries: 0 });
  assert.deepEqual({ ...now.entries[0], sets: 0, note: 0 }, { ...kept.entries[0], sets: 0, note: 0 });
});

test('a set that already has a heart rate keeps it; one that only looks like it has gets the import\'s', () => {
  const h = earlier();
  const day = byDay(h, '2023-11-15');
  day.entries[0].sets[0].hr = { avg: 97, max: 112 };              // the watch's, or the health hub's
  day.entries[0].sets[0].restHr = { avg: 88, max: 99 };
  day.entries[1].sets[0].hr = { avg: 0, max: 0 };                 // not a reading (sanitizeHr)
  assert.equal(again(h).body.updated, 3);
  assert.deepEqual(byDay(h, '2023-11-15').entries.map(e => e.sets.map(s => s.hr)), [
    [{ avg: 97, max: 112 }, { avg: 131, max: 150 }],
    [{ avg: 110, max: 165 }],
  ]);
  assert.deepEqual(byDay(h, '2023-11-15').entries[0].sets[0].restHr, { avg: 88, max: 99 });
  assert.equal(byDay(h, '2023-11-15').entries[0].note, '150 kcal · Mi Fitness · 90 kcal · Mi Fitness');

  // Every set has one and the notes are the new ones: nothing to do, though none is the import's.
  const full = earlier();
  for (const w of full.doc.workouts) for (const e of w.entries) for (const x of e.sets) x.hr = { avg: 80, max: 90 };
  assert.equal(again(full).body.updated, 3, 'the notes still had the heart rate in them');
  assert.deepEqual(again(full).body, { workouts: 0, skipped: 5, weights: 0, updated: 0 });
  assert.ok(full.doc.workouts.slice(1).every(w => w.entries.every(e => e.sets.every(x => x.hr.avg === 80))));
});

test('one run adds the new days, brings its own earlier ones up to date and leaves the rest', () => {
  // The first import knew the 15th, 16th and 17th. Since then the 17th got a set by hand, and
  // the profile has a workout of its own on the 18th.
  const h = earlier(EARLIER.slice(0, 5));
  byDay(h, '2023-11-17').entries[0].sets.push({ min: 10, speed: 20, done: true });
  h.doc.workouts.push({ id: 'w_gym', d: '2023-11-18', start: 1, end: 2, name: 'Legs', entries: [], prs: [] });
  const before = structuredClone(h.doc);
  const out = importMi({ ...miToImport(sportRecord(EARLIER), sanitizeHr), weights: WEIGHTS }, deps(h));
  assert.deepEqual(out.body, { workouts: 1, skipped: 4, weights: 3, updated: 1 });
  assert.equal(h.writes.length, 2);
  assert.deepEqual(h.doc.workouts.map(w => [w.d, w.name]), [
    ['2023-11-01', 'Push'], ['2023-11-15', 'Mi Fitness'], ['2023-11-16', 'Mi Fitness'], ['2023-11-17', 'Mi Fitness'], ['2023-11-18', 'Legs'], ['2023-11-19', 'Mi Fitness'],
  ]);
  assert.deepEqual(byDay(h, '2023-11-15'), afresh().find(w => w.d === '2023-11-15'));          // brought up to date
  for (const d of ['2023-11-01', '2023-11-16', '2023-11-17', '2023-11-18']) assert.deepEqual(byDay(h, d), before.workouts.find(w => w.d === d), d);
  assert.equal(h.doc.bodyweight.length, 3);
  assert.deepEqual(importMi({ ...miToImport(sportRecord(EARLIER), sanitizeHr), weights: WEIGHTS }, deps(h)).body, { workouts: 0, skipped: 5, weights: 0, updated: 0 });
});

test('an update that lost a race is made again on what the other writer left', () => {
  const h = earlier(EARLIER, { conflicts: 0 });
  let raced = false;
  const write = body => {
    if (!raced) {
      // Another device gave the 17th a set of its own just before this write landed.
      raced = true;
      byDay(h, '2023-11-17').entries[0].sets.push({ min: 10, speed: 20, done: true });
      h.rev++;
      return { status: 409, error: 'conflict' };
    }
    return h.write(body);
  };
  const out = importMi(miToImport(sportRecord(EARLIER), sanitizeHr), { ...deps(h), write });
  assert.deepEqual(out.body, { workouts: 0, skipped: 5, weights: 0, updated: 2 });
  assert.deepEqual(byDay(h, '2023-11-17').entries[0].sets.map(x => x.hr), [undefined, undefined]);
  assert.deepEqual(byDay(h, '2023-11-18').entries[0].sets[0].hr, { avg: 120, max: 150 });
});

/* ---------- ...and what makes a device keep it ---------- */

// The store again, its write now PUT /api/data's own stamping (sync-stamps.js stampPut) the way
// routes.putData calls it: this writer does not stamp, and writes over the revision it read.
function stampingStore(doc, clock) {
  const h = store(doc);
  const plain = h.write;
  h.write = body => {
    if (body.baseRev === h.rev) stampPut(h.doc, body.state, { overRead: true, stamped: body.stamped === true, now: clock() });
    return plain(body);
  };
  return h;
}

test('the save stamps a workout changed in place, and a device\'s older copy of it loses the merge', () => {
  let now = 1700500000000;
  const h = stampingStore(profile(), () => now);
  importMi({ csv: miToCsv(sportRecord(EARLIER)).csv }, { ...deps(h), now });
  // As the first import left them: a workout that is new gets no stamp.
  assert.ok(h.doc.workouts.every(w => w._ts === undefined && w._f === undefined));

  // A phone reads the profile, then renames one of the imported workouts (the app stamps that)
  // and logs a weigh-in, all before the update and none of it sent yet.
  const phone = structuredClone(h.doc);
  const ride = phone.workouts.find(w => w.d === '2023-11-17');
  Object.assign(ride, { name: 'Sunday ride', _ts: now + 1000, _f: { name: now + 1000 } });
  phone.bodyweight = [{ d: '2023-11-21', w: 81, t: now + 2000 }];

  now += 60000;
  assert.equal(importMi(miToImport(sportRecord(EARLIER), sanitizeHr), { ...deps(h), now }).body.updated, 3);
  // Stamped past the document's own `_ts`, which this write moved to `now`: later than anything
  // either copy carried when it was made.
  for (const w of h.doc.workouts.slice(1)) {
    const touched = ['2023-11-15', '2023-11-17', '2023-11-18'].includes(w.d);
    assert.equal(w._ts, touched ? now + 1 : undefined, w.d);
    assert.deepEqual(w._f, touched ? { entries: now + 1 } : undefined, w.d);
  }

  // The phone comes back, its copy the newer one as a whole (it was changed after the update,
  // by its own clock): of the workouts both have, the server's sets and notes stay, in either
  // order of merging; the phone's rename and its weigh-in stay too.
  phone._ts = now + 5000;
  for (const merged of [mergeStates(phone, h.doc), mergeStates(h.doc, phone)]) {
    assert.deepEqual(merged.workouts.map(w => w.entries), h.doc.workouts.map(w => w.entries));
    assert.equal(merged.workouts.find(w => w.d === '2023-11-17').name, 'Sunday ride');
    assert.deepEqual(merged.workouts.find(w => w.d === '2023-11-15').entries[1].sets[0].hr, { avg: 110, max: 165 });
    assert.equal(merged.bodyweight.length, 1);
  }

  // Without the stamps the same merge would have taken the phone's copy back: this is what they are for.
  const bare = structuredClone(h.doc);
  for (const w of bare.workouts) { delete w._ts; delete w._f; }
  const undone = mergeStates(phone, bare).workouts.find(w => w.d === '2023-11-17');
  assert.equal(undone.entries[0].sets[0].hr, undefined);
});
