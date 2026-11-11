/* Fork (Suslicke/opengym): POST /api/hub/v1/import, a Mi Fitness export forwarded by admin-hub.
   Real server.js in a child, a fixture DATA_DIR with two profiles, zips built here
   (zip-sample.mjs).

   Pinned here: the hub's token and nothing else opens the route, and it is a 404 while the token
   is unset; the workouts of the sport record land in the first admin's document, saved the way a
   device saves (the revision moves, a write id is set, what was there stays as it was); the same
   export again changes nothing; a zip without a sport record is a 200 with zeros, a body that is
   no zip a 400, a profile with no document a 409. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';
import { makeZip, sportRecord } from './zip-sample.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const ORIGIN = 'https://gym.example.test';
const MCP_TOKEN = crypto.randomBytes(32).toString('hex');
const HUB_TOKEN = crypto.randomBytes(32).toString('hex');

const mintToken = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0:c`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};

const USERS = [
  { id: 'u_member', name: 'Member', created: '2026-01-01T00:00:00.000Z' },
  { id: 'u_admin', name: 'Owner', admin: true, created: '2026-01-02T00:00:00.000Z' },
  { id: 'u_new', name: 'Never synced', created: '2026-01-03T00:00:00.000Z' }
];
const OLD = {
  id: 'w_old', d: '2023-11-20', name: 'Push Day', routineId: 'r_push', start: 1700470800000, end: 1700473200000, prs: [], vol: 560,
  entries: [{ id: '0001', target: { sets: 3, reps: 10, weight: 20 }, sets: [
    { w: 20, r: 10, done: true }, { w: 20, r: 10, done: true }, { w: 20, r: 8, done: true }
  ] }]
};
const adminState = {
  unit: 'kg', targetW: 80, _ts: 1700473200000,
  routines: [{ id: 'r_push', name: 'Push Day', ex: [{ id: '0001', sets: 3, reps: 10, weight: 20 }] }],
  week: { 1: 'r_push' }, dayPlan: {}, exWeights: { '0001': { w: 20, d: '2023-11-20' } }, customEx: [],
  bodyweight: [{ d: '2023-11-20', w: 82 }],
  workouts: [OLD]
};
const memberState = { unit: 'kg', routines: [], week: {}, workouts: [], bodyweight: [] };

// Three workouts and a row that is not one. 1700000000 is 2023-11-15 03:13:20 at +05:00; the
// third is on the day the profile already trained (w_old), which the importer leaves alone.
const RECORD = sportRecord([
  { key: 'rock_climbing', start_time: 1700100000, end_time: 1700103600, duration: 3600, timezone: 20 },
  { key: 'outdoor_walking', start_time: 1700000000, end_time: 1700002200, duration: 2200, distance: 3021, avg_hrm: 101, calories: 150, timezone: 20 },
  { key: 'outdoor_walking', start_time: 1700450000, end_time: 1700451800, duration: 1800, distance: 2400, timezone: 20 },
  { key: 'broken', raw: 'not-json' },
]);
const NAME = 'MiFitness Personal Data/20261112_1234_MiFitness_hlth_center_sport_record.csv';
const exportZip = (deflate = true) => makeZip([
  { name: 'MiFitness Personal Data/', data: '' },
  { name: 'MiFitness Personal Data/20261112_1234_MiFitness_hlth_center_fitness_data.csv', data: 'Uid,Sid,Key,Time,Value,UpdateTime\n1,2,steps,1700000000,"{""steps"":12}",1\n', deflate },
  { name: '__MACOSX/MiFitness Personal Data/._20261112_1234_MiFitness_hlth_center_sport_record.csv', data: 'Mac OS X', deflate },
  { name: NAME, data: RECORD, deflate },
]);

async function startServer(t, env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-mi-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: USERS, creds: [], subs: [], invites: [] }));
  fs.writeFileSync(path.join(dataDir, 'state-u_admin.json'), JSON.stringify(adminState));
  fs.writeFileSync(path.join(dataDir, 'state-u_member.json'), JSON.stringify(memberState));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'gym.example.test', ADMIN_UIDS: '',
      OPENGYM_MCP_TOKEN: '', OPENGYM_HUB_TOKEN: '', MCP_PROFILE_ID: '', ...env
    }
  });
  const h = { log: '', dataDir };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  h.api = `http://127.0.0.1:${await boundPort(child, () => h.log)}`;
  h.file = uid => fs.readFileSync(path.join(dataDir, `state-${uid}.json`), 'utf8');
  h.state = uid => JSON.parse(h.file(uid));
  return h;
}

const bearer = tok => ({ Authorization: `Bearer ${tok}` });
const send = (h, body, headers = bearer(HUB_TOKEN)) => fetch(`${h.api}/api/hub/v1/import`, {
  method: 'POST', headers: { 'Content-Type': 'application/zip', ...headers }, body
});
// What a signed-in device sees: the revision it polls, and the document.
const rev = async (h, uid = 'u_admin') => (await (await fetch(`${h.api}/api/data/rev`, { headers: bearer(mintToken(uid)) })).json());
const pull = async (h, uid = 'u_admin') => (await (await fetch(`${h.api}/api/data`, { headers: bearer(mintToken(uid)) })).json());

test('the route is a 404 while OPENGYM_HUB_TOKEN is unset', async t => {
  const h = await startServer(t, { OPENGYM_MCP_TOKEN: MCP_TOKEN });
  const before = h.file('u_admin');
  assert.equal((await send(h, exportZip())).status, 404);
  assert.equal((await send(h, exportZip(), bearer(MCP_TOKEN))).status, 404);
  assert.equal(h.file('u_admin'), before);
});

test('only the hub token opens it: anything else is an empty 401 and nothing is imported', async t => {
  const h = await startServer(t, { OPENGYM_MCP_TOKEN: MCP_TOKEN, OPENGYM_HUB_TOKEN: HUB_TOKEN });
  const before = h.file('u_admin');
  const session = mintToken('u_admin');
  for (const headers of [{}, bearer('nope'), bearer(HUB_TOKEN + 'x'), bearer(MCP_TOKEN), bearer(session), { Authorization: HUB_TOKEN }, { Cookie: `gymsid=${session}` }]) {
    const r = await send(h, exportZip(), headers);
    assert.equal(r.status, 401, JSON.stringify(headers));
    assert.equal(await r.text(), '');
  }
  assert.equal(h.file('u_admin'), before);
});

test('an export\'s workouts land in the first admin\'s history, saved as a device saves', async t => {
  const h = await startServer(t, { OPENGYM_HUB_TOKEN: HUB_TOKEN });
  const member = h.file('u_member');
  // Asked before, so the server's cached copy of the revision is the one from before the import.
  assert.deepEqual(await rev(h), { rev: 0 });

  const r = await send(h, exportZip());
  assert.equal(r.status, 200, h.log);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await r.json(), { workouts: 2, skipped: 1 });

  const S = h.state('u_admin');
  assert.deepEqual(S.workouts.map(w => w.d), ['2023-11-15', '2023-11-16', '2023-11-20']);
  // What was there is as it was, the day the import left alone included.
  assert.deepEqual(S.workouts[2], OLD);
  for (const k of ['unit', 'targetW', 'routines', 'week', 'dayPlan', 'exWeights', 'bodyweight']) assert.deepEqual(S[k], adminState[k], k);

  const [walk, climb] = S.workouts;
  assert.equal(walk.name, 'Mi Fitness');
  assert.equal(walk.entries.length, 1);
  assert.deepEqual(walk.entries[0].sets.map(({ min, speed, done }) => ({ min, speed, done })), [{ min: 36.7, speed: 4.9, done: true }]);
  assert.equal(walk.entries[0].note, 'avg HR 101 · 150 kcal · Mi Fitness');
  assert.deepEqual(climb.entries[0].sets.map(({ min, speed }) => ({ min, speed })), [{ min: 60, speed: 0 }]);
  // Sports the catalogue does not have become the profile's own exercises, as cardio.
  const own = Object.fromEntries(S.customEx.map(c => [c.id, c]));
  assert.equal(own[walk.entries[0].id].n, 'outdoor walk');
  assert.equal(own[walk.entries[0].id].bp, 'cardio');
  assert.equal(own[climb.entries[0].id].n, 'bouldering');
  assert.equal(S.customEx.length, 2);

  // The revision moved, on disk and for a device polling it; the write has an id of its own.
  assert.equal(S._rev, 1);
  assert.match(S._wid, /^[0-9a-f]{16}$/);
  assert.ok(S._ts > adminState._ts);
  assert.deepEqual(await rev(h), { rev: 1, wid: S._wid });
  const got = await pull(h);
  assert.equal(got.rev, 1);
  assert.deepEqual(got.state.workouts.map(w => w.id), S.workouts.map(w => w.id));

  // The other profile is not this route's.
  assert.equal(h.file('u_member'), member);
});

test('the same export a second time adds nothing and leaves the document and its revision alone', async t => {
  const h = await startServer(t, { OPENGYM_HUB_TOKEN: HUB_TOKEN });
  assert.deepEqual(await (await send(h, exportZip(false))).json(), { workouts: 2, skipped: 1 });
  const after = h.file('u_admin');
  const ids = h.state('u_admin').workouts.map(w => w.id);

  const again = await send(h, exportZip(false));
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { workouts: 0, skipped: 3 });
  assert.equal(h.file('u_admin'), after);
  assert.deepEqual((await rev(h)).rev, 1);

  // Deflated this time, and the ids are what the file says, not chance: still nothing new.
  assert.deepEqual(await (await send(h, exportZip(true))).json(), { workouts: 0, skipped: 3 });
  assert.deepEqual(h.state('u_admin').workouts.map(w => w.id), ids);
});

test('a device that syncs after the import keeps the imported workouts and its own change', async t => {
  const h = await startServer(t, { OPENGYM_HUB_TOKEN: HUB_TOKEN });
  const device = await pull(h);                       // the phone's copy, from before the import
  await send(h, exportZip());

  // Its push over the revision it read is refused with the current document, as for any write
  // made in between.
  const headers = { ...bearer(mintToken('u_admin')), 'Content-Type': 'application/json' };
  const stale = await fetch(`${h.api}/api/data`, { method: 'PUT', headers, body: JSON.stringify({ state: { ...device.state, targetW: 78 }, baseRev: device.rev }) });
  assert.equal(stale.status, 409);
  const cur = await stale.json();
  assert.equal(cur.rev, 1);
  assert.equal(cur.state.workouts.length, 3);
  // Merged onto that and pushed again, it goes through.
  const ok = await fetch(`${h.api}/api/data`, { method: 'PUT', headers, body: JSON.stringify({ state: { ...cur.state, targetW: 78 }, baseRev: cur.rev, baseWid: cur.state._wid }) });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).rev, 2);
  const S = h.state('u_admin');
  assert.equal(S.targetW, 78);
  assert.deepEqual(S.workouts.map(w => w.d), ['2023-11-15', '2023-11-16', '2023-11-20']);
});

test('MCP_PROFILE_ID picks the profile the import goes to', async t => {
  const h = await startServer(t, { OPENGYM_HUB_TOKEN: HUB_TOKEN, MCP_PROFILE_ID: 'u_member' });
  const admin = h.file('u_admin');
  assert.deepEqual(await (await send(h, exportZip())).json(), { workouts: 3, skipped: 0 });
  assert.equal(h.state('u_member').workouts.length, 3);
  assert.equal(h.file('u_admin'), admin);
});

test('a zip without a sport record is not an error: 200, nothing imported', async t => {
  const h = await startServer(t, { OPENGYM_HUB_TOKEN: HUB_TOKEN });
  const before = h.file('u_admin');
  for (const zip of [
    makeZip([{ name: 'sleep/20261112_hlth_center_aggregated_fitness_data.csv', data: 'a,b\n1,2\n', deflate: true }]),
    makeZip([]),
    // The file is there and holds no workout.
    makeZip([{ name: NAME, data: sportRecord([]) }]),
    makeZip([{ name: NAME, data: sportRecord([{ key: 'broken', raw: 'not-json' }]), deflate: true }]),
  ]) {
    const r = await send(h, zip);
    assert.equal(r.status, 200, h.log);
    assert.deepEqual(await r.json(), { workouts: 0, skipped: 0 });
  }
  assert.equal(h.file('u_admin'), before);
});

test('a body that is not a zip is a 400', async t => {
  const h = await startServer(t, { OPENGYM_HUB_TOKEN: HUB_TOKEN });
  const before = h.file('u_admin');
  const good = exportZip();
  for (const body of [
    Buffer.alloc(0),
    Buffer.from('not a zip at all'),
    Buffer.from(JSON.stringify({ state: { workouts: [] } })),
    Buffer.from(RECORD),
    good.subarray(0, good.length - 30),
    makeZip([{ name: NAME, data: RECORD, encrypted: true }]),
  ]) {
    const r = await send(h, body);
    assert.equal(r.status, 400, `${body.length} bytes: ${h.log}`);
    assert.equal(typeof (await r.json()).error, 'string');
  }
  assert.equal(h.file('u_admin'), before);
  assert.ok(!/TypeError|RangeError|at file:/.test(h.log), h.log);
});

test('a profile that has no document yet is refused with a 409, and none is made', async t => {
  const h = await startServer(t, { OPENGYM_HUB_TOKEN: HUB_TOKEN, MCP_PROFILE_ID: 'u_new' });
  const r = await send(h, exportZip());
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'no-state');
  assert.ok(!fs.existsSync(path.join(h.dataDir, 'state-u_new.json')));
});

test('a state file that cannot be read is a 503 and is not written over', async t => {
  const h = await startServer(t, { OPENGYM_HUB_TOKEN: HUB_TOKEN });
  fs.writeFileSync(path.join(h.dataDir, 'state-u_admin.json'), '{"workouts": [');
  const r = await send(h, exportZip());
  assert.equal(r.status, 503);
  assert.equal(h.file('u_admin'), '{"workouts": [');
});

test('an upload over 64 MB is a 413', async t => {
  const h = await startServer(t, { OPENGYM_HUB_TOKEN: HUB_TOKEN });
  const r = await send(h, Buffer.alloc(64 * 1024 * 1024 + 1));
  assert.equal(r.status, 413);
  // The server is still there for the next one.
  assert.deepEqual(await (await send(h, exportZip())).json(), { workouts: 2, skipped: 1 });
});
