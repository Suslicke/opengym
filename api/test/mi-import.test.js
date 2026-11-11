/* Fork (Suslicke/opengym): the pieces of the Mi Fitness import (mi-import.js), without a server.

   The converter's cases are the ones the script it was ported from checks itself with
   (sleep/scripts/mi-to-opengym.py --test), then the rules that script states and does not test.
   The save loop runs against the real importer (frontend/src/lib/import-csv.js) with a profile
   held in memory, so a conflict can be staged. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { zipEntry, ZipError, miToCsv, importCsv, HEADER, SPORT_RECORD } from '../mi-import.js';
import { makeZip, sportRecord } from './zip-sample.mjs';
import * as lib from '../../frontend/src/lib/import-csv.js';

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

/* ---------- importCsv ---------- */

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
  const out = importCsv(CSV, { lib, read: h.read, write: h.write, now: 1000 });
  assert.deepEqual(out, { status: 200, body: { workouts: 2, skipped: 0 } });
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
  importCsv(CSV, { lib, read: h.read, write: h.write });
  const ids = h.doc.workouts.map(w => w.id);
  const out = importCsv(CSV, { lib, read: h.read, write: h.write });
  assert.deepEqual(out, { status: 200, body: { workouts: 0, skipped: 2 } });
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.doc.workouts.map(w => w.id), ids);
});

test('a write that lost a race is merged again onto what the other writer left', () => {
  const h = store(profile(), { conflicts: 2 });
  const out = importCsv(CSV, { lib, read: h.read, write: h.write });
  assert.deepEqual(out, { status: 200, body: { workouts: 2, skipped: 0 } });
  assert.equal(h.reads, 3);
  assert.deepEqual(h.writes.map(w => w.baseRev), [7, 8, 9]);
  assert.deepEqual(h.doc.workouts.map(w => w.d), ['2023-11-01', '2023-11-15', '2023-11-16', '2023-12-01', '2023-12-02']);
});

test('after three lost races it gives up, with nothing written', () => {
  const h = store(profile(), { conflicts: 9 });
  const out = importCsv(CSV, { lib, read: h.read, write: h.write });
  assert.equal(out.status, 409);
  assert.equal(out.body.code, 'conflict');
  assert.equal(h.writes.length, 3);
  assert.ok(!h.doc.workouts.some(w => w.name === 'Mi Fitness'));
});

test('a profile with no document yet is refused rather than made; an unreadable one is a 503', () => {
  const h = store(null);
  const out = importCsv(CSV, { lib, read: h.read, write: h.write });
  assert.equal(out.status, 409);
  assert.equal(out.body.code, 'no-state');
  assert.equal(h.writes.length, 0);
  assert.equal(importCsv(CSV, { lib, read: () => null, write: h.write }).status, 503);
  assert.equal(h.writes.length, 0);
});

test('a refusal from the write is passed on as it is', () => {
  const h = store(profile());
  const out = importCsv(CSV, { lib, read: h.read, write: () => ({ status: 400, error: 'invalid state' }) });
  assert.deepEqual(out, { status: 400, body: { error: 'invalid state' } });
});

test('a document without the lists the importer reads still takes the workouts', () => {
  const h = store({ unit: 'kg', routines: [] });
  const out = importCsv(CSV, { lib, read: h.read, write: h.write });
  assert.deepEqual(out.body, { workouts: 2, skipped: 0 });
  assert.equal(h.doc.workouts.length, 2);
});
