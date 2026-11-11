/* Fork (Suslicke/opengym): ways in for machines, each behind its own static token.

     POST /api/mcp            — the MCP server (mcp/) over Streamable HTTP, for an LLM client.
                                OPENGYM_MCP_TOKEN; the route is a 404 while it is unset.
     GET  /api/hub/v1/summary — a "hub/1" summary for admin-hub's Today screen.
                                OPENGYM_HUB_TOKEN; a 404 while it is unset.
     POST /api/hub/v1/import  — a Mi Fitness export (the zip, as the body) forwarded by
                                admin-hub; its workouts and weigh-ins are imported
                                (mi-import.js). The same token as the summary. The only one of
                                the three that writes.

   All act on ONE profile: MCP_PROFILE_ID, or the first admin profile when that is unset.
   None ever looks at the session cookie or a session bearer — only its own token works, so a
   signed-in browser gets nothing here, and the hub's token cannot drive the MCP tools.

   The tools live in mcp/src and read frontend/src/lib, outside this directory; the import uses
   the browser's own importer from frontend/src/lib. In the image they sit at /mcp and /frontend
   beside /app (api/Dockerfile), the same relative layout as the source tree, and are imported
   lazily: an image built without them still boots, and these routes answer 503 instead. */
import crypto from 'node:crypto';
import { SPORT_RECORD, FITNESS_DATA, ZipError, zipEntry, miToImport, miWeights, importMi } from './mi-import.js';

const MCP_URL = new URL('../mcp/src/http.js', import.meta.url);
const TOOLS_URL = new URL('../mcp/src/tools.js', import.meta.url);
const IMPORT_URL = new URL('../frontend/src/lib/import-csv.js', import.meta.url);
const HR_URL = new URL('../frontend/src/lib/heart-rate.js', import.meta.url);
// An export is a few MB. The cap is what the server will hold in memory for one upload.
const MAX_ZIP = 64 * 1024 * 1024;

const sha = v => crypto.createHash('sha256').update(String(v)).digest();
// Hash both sides first: timingSafeEqual needs equal lengths, and comparing digests leaks neither
// the token's length nor where a guess diverges.
function tokenOk(req, expected) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return false;
  return crypto.timingSafeEqual(sha(auth.slice(7).trim()), sha(expected));
}

let modules = null;
async function load() {
  if (!modules) {
    try {
      const [http, tools] = await Promise.all([import(MCP_URL.href), import(TOOLS_URL.href)]);
      modules = { http, tools };
    } catch (e) {
      console.error('[integrations] MCP tools are not available in this build:', e.message);
      modules = { missing: true };
    }
  }
  return modules;
}

// The importer, and what makes a heart rate one a set may carry (`sanitizeHr`).
let importLib = null;
async function loadImport() {
  if (!importLib) {
    try {
      const [lib, hr] = await Promise.all([import(IMPORT_URL.href), import(HR_URL.href)]);
      importLib = { lib, sanitizeHr: hr.sanitizeHr };
    } catch (e) {
      console.error('[integrations] the importer is not available in this build:', e.message);
      importLib = { missing: true };
    }
  }
  return importLib;
}

// The upload as bytes, or null once it is over `limit`. readBody (server.js) is for JSON and
// stops at 5 MB. As there, the rest of an oversized upload is read and dropped rather than the
// socket closed under it, so the client gets to read its 413; one that keeps sending past twice
// the limit is cut off.
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0, over = false; const chunks = [];
    req.on('data', d => {
      size += d.length;
      if (over) { if (size > 2 * limit) req.destroy(); return; }
      if (size > limit) { over = true; chunks.length = 0; return resolve(null); }
      chunks.push(d);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', e => reject(Object.assign(e, { clientGone: true })));
  });
}

export function integrationRoutes({ json, readBody, getDb, isAdmin, dataDir, origin, getData, putData, env = process.env }) {
  // MCP_PROFILE_ID, else the first admin. Decided per request: an admin appointed later, or a
  // changed db.json, is picked up without a restart.
  const profileId = () => {
    const fixed = (env.MCP_PROFILE_ID || '').trim();
    if (fixed) return fixed;
    return getDb().users.find(isAdmin)?.id || null;
  };

  // The profile to act on, or null after answering 503.
  function profile(res) {
    const uid = profileId();
    if (!uid || !/^[a-zA-Z0-9_-]+$/.test(uid)) { json(res, 503, { error: 'no profile to serve: set MCP_PROFILE_ID' }); return null; }
    return uid;
  }

  async function prepare(res) {
    const m = await load();
    if (m.missing) { json(res, 503, { error: 'the MCP tools are not bundled in this build' }); return null; }
    const uid = profile(res);
    if (!uid) return null;
    m.http.configure({ dataDir, uid });
    return m;
  }

  // An empty 401: the hub reads the status, and a body would only say what was wrong with a guess.
  function hubGate(req, res) {
    const token = env.OPENGYM_HUB_TOKEN || '';
    if (!token) { json(res, 404, { error: 'not found' }); return false; }
    if (!tokenOk(req, token)) { res.writeHead(401, { 'Cache-Control': 'no-store' }); res.end(); return false; }
    return true;
  }

  function mcpGate(req, res) {
    const token = env.OPENGYM_MCP_TOKEN || '';
    if (!token) { json(res, 404, { error: 'not found' }); return false; }
    if (!tokenOk(req, token)) {
      json(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer realm="opengym-mcp"' });
      return false;
    }
    return true;
  }

  return {
    mcp: async (req, res) => {
      if (!mcpGate(req, res)) return;
      const m = await prepare(res);
      if (!m) return;
      const body = await readBody(req);
      await m.http.handleMcpRequest(req, res, body);
    },
    // Stateless, JSON-only: there is no server-to-client SSE stream to open, which the
    // Streamable HTTP spec answers with a 405.
    mcpNoStream: async (req, res) => {
      if (!mcpGate(req, res)) return;
      json(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
    },
    hubSummary: async (req, res) => {
      if (!hubGate(req, res)) return;
      const m = await prepare(res);
      if (!m) return;
      json(res, 200, buildSummary(m.tools, { origin }));
    },
    // The hub sends one export to every service it feeds, so a zip with neither a sport record
    // nor fitness data in it is not this route's to complain about: nothing to import, 200.
    hubImport: async (req, res) => {
      if (!hubGate(req, res)) return;
      const { lib, sanitizeHr, missing } = await loadImport();
      if (missing) return json(res, 503, { error: 'the importer is not bundled in this build' });
      const uid = profile(res);
      if (!uid) return;
      const zip = await readRaw(req, MAX_ZIP);
      if (!zip) return json(res, 413, { error: 'body too large' });
      let mi = null, weights = [];
      try {
        const record = zipEntry(zip, SPORT_RECORD);
        if (record) mi = miToImport(record.toString('utf8'), sanitizeHr);
        // Some 30 MB unpacked, held only while the couple of weigh-ins are picked out of it.
        const fitness = zipEntry(zip, FITNESS_DATA);
        if (fitness) weights = miWeights(fitness);
      } catch (e) {
        if (e instanceof ZipError) return json(res, e.status, { error: e.message });
        throw e;
      }
      if (!mi?.workouts && !weights.length) return json(res, 200, { workouts: 0, skipped: 0, weights: 0, updated: 0 });
      // Nothing is awaited from here on: reading the profile, merging and saving it are one
      // synchronous step, like PUT /api/data's own compare-and-write.
      const out = importMi({ csv: mi?.csv, rows: mi?.rows, weights }, { lib, sanitizeHr, read: () => getData(uid), write: body => putData(uid, body) });
      if (out.body.workouts || out.body.weights || out.body.updated) console.log(`[integrations] Mi Fitness import: ${out.body.workouts} workouts added, ${out.body.skipped} already there (${out.body.updated} of them brought up to date), ${out.body.weights} weigh-ins added`);
      json(res, out.status, out.body);
    }
  };
}

/* ---------- the hub summary ---------- */

const pad = n => String(n).padStart(2, '0');
const isoLocal = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const DAY_MS = 86400000;
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / DAY_MS);
const round1 = v => Math.round(v * 10) / 10;
const WD_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WD_RU = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

/** A hub/1 object built from the same tool handlers the MCP server answers with. English base
 *  fields, with a Russian `l10n.ru` block whose arrays line up index for index. */
export function buildSummary(tools, { origin, now = new Date() } = {}) {
  const base = {
    protocol: 'hub/1',
    service: 'gym',
    generated_at: now.toISOString(),
    title: 'Gym',
    ttl_seconds: 900
  };
  const links = [{ label: 'Open openGym', url: origin }];
  const ruLinks = ['Открыть openGym'];

  let plan, recent, bw;
  try {
    plan = tools.getWeekPlan.handler({});
    if (plan.error) {
      return { ...base, status: 'warn', headline: 'No synced data yet', links,
        l10n: { ru: { title: 'Зал', headline: 'Данных пока нет', metrics: [], items: [], links: ruLinks } } };
    }
    recent = tools.listWorkouts.handler({ limit: 200 });
    bw = tools.getBodyweight.handler({});
  } catch (e) {
    return { ...base, status: 'error', headline: 'Cannot read the training data', links,
      l10n: { ru: { title: 'Зал', headline: 'Не удаётся прочитать данные', metrics: [], items: [], links: ruLinks } } };
  }

  const unit = recent.unit || 'kg';
  const today = isoLocal(now);
  // The week runs Monday to Sunday, in the server's time zone (TZ).
  const monday = isoLocal(new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7), 12));
  const thisWeek = recent.workouts.filter(w => w.date >= monday && w.date <= today);
  const goal = plan.weekdays.filter(d => d.routine_ids.length).length;
  const volume = Math.round(thisWeek.reduce((s, w) => s + (Number(w.volume) || 0), 0));
  const last = recent.workouts[0] || null;
  const daysAgo = last ? Math.max(0, daysBetween(last.date, today)) : null;

  const metrics = [], ru = [];
  metrics.push({ key: 'workouts_week', label: 'Workouts this week', value: thisWeek.length, ...(goal ? { goal } : {}), period: 'week' });
  ru.push('Тренировок за неделю');
  if (daysAgo != null) {
    metrics.push({ key: 'last_workout_days', label: 'Last workout', value: daysAgo, unit: 'days ago' });
    ru.push('Последняя тренировка');
  }
  metrics.push({ key: 'volume_week', label: 'Volume this week', value: volume, unit, period: 'week' });
  ru.push('Объём за неделю');
  const weighIns = bw.entries || [];
  if (bw.latest) {
    const prev = weighIns.length > 1 ? weighIns[weighIns.length - 2].weight : null;
    const delta = prev != null ? bw.latest.weight - prev : null;
    const trend = delta == null ? undefined : Math.abs(delta) < 0.1 ? 'flat' : delta > 0 ? 'up' : 'down';
    metrics.push({ key: 'bodyweight', label: 'Bodyweight', value: round1(bw.latest.weight), unit: bw.unit || unit,
      ...(bw.goal != null ? { goal: bw.goal } : {}), ...(trend ? { trend } : {}) });
    ru.push('Вес');
  }

  // The next planned session: today's if it is not logged yet, else the next day that has one.
  const doneToday = recent.workouts.some(w => w.date === today);
  const next = plan.days.find(d => d.routine_ids.length && !(d.date === today && doneToday));
  const items = [], ruItems = [];
  if (next) {
    const names = next.routine_names.filter(Boolean).join(' + ') || 'Workout';
    const when = next.date === today ? 'Today' : daysBetween(today, next.date) === 1 ? 'Tomorrow' : WD_EN[next.weekday] + ' ' + next.date.slice(5);
    const whenRu = next.date === today ? 'Сегодня' : daysBetween(today, next.date) === 1 ? 'Завтра' : WD_RU[next.weekday] + ' ' + next.date.slice(5);
    items.push({ title: `Next: ${names} (${when})`.slice(0, 200), url: origin });
    ruItems.push(`Далее: ${names} (${whenRu})`.slice(0, 200));
  }

  const stale = daysAgo == null || daysAgo > 7;
  const status = stale ? 'warn' : 'ok';
  const of = goal ? ` of ${goal}` : '';
  const ofRu = goal ? ` из ${goal}` : '';
  const headline = `${thisWeek.length}${of} workouts this week` + (daysAgo == null ? ', none logged yet' : stale ? `, last one ${daysAgo} days ago` : '');
  const headlineRu = `${thisWeek.length}${ofRu} тренировок за неделю` + (daysAgo == null ? ', пока ни одной' : stale ? `, последняя ${daysAgo} дн. назад` : '');

  return {
    ...base,
    status,
    headline,
    metrics,
    ...(items.length ? { items } : {}),
    links,
    l10n: { ru: { title: 'Зал', headline: headlineRu, metrics: ru, items: ruItems, links: ruLinks } }
  };
}
