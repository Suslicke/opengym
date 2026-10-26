/* Fork (Suslicke/opengym): POST /api/mcp (MCP over Streamable HTTP) and GET /api/hub/v1/summary.
   Real server.js in a child, a fixture DATA_DIR with two profiles.

   Pinned here: each route answers to its own static token and nothing else (not the other
   route's token, not a session cookie, not a session bearer); an unset token makes the route a
   404; the tools act on MCP_PROFILE_ID or else the first admin; the summary is a valid hub/1
   object (the schema is copied from admin-hub's protocol/ into test/fixtures). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { boundPort } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const ORIGIN = 'https://gym.example.test';
const MCP_TOKEN = crypto.randomBytes(32).toString('hex');
const HUB_TOKEN = crypto.randomBytes(32).toString('hex');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(API, 'test', 'fixtures', 'hub-protocol.v1.schema.json'), 'utf8'));

const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const daysFromToday = n => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return iso(d); };
const TODAY = daysFromToday(0);

const mintToken = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0:c`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};

const USERS = [
  { id: 'u_member', name: 'Member', created: '2026-01-01T00:00:00.000Z' },
  { id: 'u_admin', name: 'Owner', admin: true, created: '2026-01-02T00:00:00.000Z' }
];
const adminState = {
  unit: 'kg', targetW: 80,
  routines: [{ id: 'r_push', name: 'Push Day', ex: [{ id: '0001', sets: 3, reps: 10, weight: 20 }] }],
  // Every weekday planned, so the next session is today or tomorrow whatever day the test runs.
  week: { 0: 'r_push', 1: 'r_push', 2: 'r_push', 3: 'r_push', 4: 'r_push', 5: 'r_push', 6: 'r_push' },
  dayPlan: {},
  bodyweight: [{ d: daysFromToday(-10), w: 82 }, { d: daysFromToday(-1), w: 81.4 }],
  workouts: [{
    id: 'w_today', d: TODAY, name: 'Push Day', routineId: 'r_push', start: 1000, end: 1000 + 40 * 60000, prs: [],
    entries: [{ id: '0001', target: { sets: 3, reps: 10, weight: 20 }, sets: [
      { w: 20, r: 10, done: true }, { w: 20, r: 10, done: true }, { w: 20, r: 8, done: true }
    ] }]
  }]
};
const memberState = { unit: 'kg', routines: [{ id: 'r_other', name: 'Other Routine', ex: [] }], week: {}, workouts: [], bodyweight: [] };

async function startServer(t, env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-int-'));
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
  const h = { log: '' };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  h.api = `http://127.0.0.1:${await boundPort(child, () => h.log)}`;
  return h;
}

const rpc = (h, message, headers = {}) => fetch(`${h.api}/api/mcp`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify(message)
});
const bearer = tok => ({ Authorization: `Bearer ${tok}` });
const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

test('both routes are a 404 while their token is unset', async t => {
  const h = await startServer(t);
  assert.equal((await rpc(h, LIST, bearer(MCP_TOKEN))).status, 404);
  assert.equal((await fetch(`${h.api}/api/mcp`, { headers: bearer(MCP_TOKEN) })).status, 404);
  assert.equal((await fetch(`${h.api}/api/hub/v1/summary`, { headers: bearer(HUB_TOKEN) })).status, 404);
});

test('/api/mcp: missing or wrong bearer is a 401 with WWW-Authenticate; sessions and the hub token do not work', async t => {
  const h = await startServer(t, { OPENGYM_MCP_TOKEN: MCP_TOKEN, OPENGYM_HUB_TOKEN: HUB_TOKEN });
  for (const headers of [{}, bearer('nope'), bearer(MCP_TOKEN + 'x'), bearer(HUB_TOKEN), { Authorization: MCP_TOKEN }]) {
    const r = await rpc(h, LIST, headers);
    assert.equal(r.status, 401, JSON.stringify(headers));
    assert.match(r.headers.get('www-authenticate') || '', /^Bearer /);
  }
  // A signed-in admin's session — as the cookie, and as the paired app's bearer — is not a way in.
  const session = mintToken('u_admin');
  assert.equal((await rpc(h, LIST, { Cookie: `gymsid=${session}` })).status, 401);
  assert.equal((await rpc(h, LIST, { Cookie: `__Host-gymsid=${session}` })).status, 401);
  assert.equal((await rpc(h, LIST, bearer(session))).status, 401);
  // GET (the SSE stream a stateless JSON server does not offer) is gated the same way, then a 405.
  assert.equal((await fetch(`${h.api}/api/mcp`)).status, 401);
  assert.equal((await fetch(`${h.api}/api/mcp`, { headers: bearer(MCP_TOKEN) })).status, 405);
});

test('/api/mcp: tools/list returns the nine read-only tools', async t => {
  const h = await startServer(t, { OPENGYM_MCP_TOKEN: MCP_TOKEN });
  const r = await rpc(h, LIST, bearer(MCP_TOKEN));
  assert.equal(r.status, 200, h.log);
  const body = await r.json();
  assert.deepEqual(body.result.tools.map(x => x.name).sort(), [
    'estimate_1rm', 'get_bodyweight', 'get_routine', 'get_week_plan', 'get_workout',
    'list_routines', 'list_workouts', 'muscle_balance', 'preview_session'
  ]);
});

test('/api/mcp: initialize, then tools/call reads the first admin profile from DATA_DIR', async t => {
  const h = await startServer(t, { OPENGYM_MCP_TOKEN: MCP_TOKEN });
  const init = await rpc(h, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }, bearer(MCP_TOKEN));
  assert.equal(init.status, 200);
  assert.equal((await init.json()).result.serverInfo.name, 'opengym');

  const r = await rpc(h, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_workouts', arguments: {} } }, bearer(MCP_TOKEN));
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(!body.result.isError, JSON.stringify(body));
  const data = JSON.parse(body.result.content[0].text);
  assert.equal(data.total_count, 1);
  assert.equal(data.workouts[0].id, 'w_today');
  assert.equal(data.workouts[0].volume, 560);
});

test('/api/mcp: MCP_PROFILE_ID picks the profile', async t => {
  const h = await startServer(t, { OPENGYM_MCP_TOKEN: MCP_TOKEN, MCP_PROFILE_ID: 'u_member' });
  const r = await rpc(h, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_routines', arguments: {} } }, bearer(MCP_TOKEN));
  const data = JSON.parse((await r.json()).result.content[0].text);
  assert.deepEqual(data.routines.map(x => x.name), ['Other Routine']);
});

test('/api/hub/v1/summary: hub token only, empty 401 otherwise, and a valid hub/1 object', async t => {
  const h = await startServer(t, { OPENGYM_MCP_TOKEN: MCP_TOKEN, OPENGYM_HUB_TOKEN: HUB_TOKEN });
  const session = mintToken('u_admin');
  for (const headers of [{}, bearer('nope'), bearer(MCP_TOKEN), bearer(session), { Cookie: `gymsid=${session}` }]) {
    const r = await fetch(`${h.api}/api/hub/v1/summary`, { headers });
    assert.equal(r.status, 401, JSON.stringify(headers));
    assert.equal(await r.text(), '');
  }

  const r = await fetch(`${h.api}/api/hub/v1/summary`, { headers: bearer(HUB_TOKEN) });
  assert.equal(r.status, 200, h.log);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const s = await r.json();

  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(SCHEMA);
  assert.ok(validate(s), JSON.stringify(validate.errors, null, 2));

  assert.equal(s.service, 'gym');
  assert.equal(s.title, 'Gym');
  assert.equal(s.status, 'ok');
  assert.ok(s.metrics.length <= 8);
  const m = Object.fromEntries(s.metrics.map(x => [x.key, x]));
  assert.equal(m.workouts_week.value, 1);
  assert.equal(m.workouts_week.goal, 7);
  assert.equal(m.last_workout_days.value, 0);
  assert.equal(m.volume_week.value, 560);
  assert.equal(m.bodyweight.value, 81.4);
  assert.equal(m.bodyweight.trend, 'down');
  // Today's session is logged, so the next one is tomorrow's.
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].title, 'Next: Push Day (Tomorrow)');
  assert.deepEqual(s.links, [{ label: 'Open openGym', url: ORIGIN }]);

  // Bilingual: l10n.ru lines up index for index with the English arrays.
  const ru = s.l10n.ru;
  assert.equal(ru.title, 'Зал');
  assert.ok(ru.headline);
  assert.equal(ru.metrics.length, s.metrics.length);
  assert.equal(ru.items.length, s.items.length);
  assert.equal(ru.links.length, s.links.length);
});
