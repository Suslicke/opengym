/* Fork (Suslicke/opengym): two read-only ways in for machines, each behind its own static token.

     POST /api/mcp            — the MCP server (mcp/) over Streamable HTTP, for an LLM client.
                                OPENGYM_MCP_TOKEN; the route is a 404 while it is unset.
     GET  /api/hub/v1/summary — a "hub/1" summary for admin-hub's Today screen.
                                OPENGYM_HUB_TOKEN; a 404 while it is unset.

   Both act on ONE profile: MCP_PROFILE_ID, or the first admin profile when that is unset.
   Neither ever looks at the session cookie or a session bearer — only its own token works, so a
   signed-in browser gets nothing here, and the hub's token cannot drive the MCP tools.

   The tools live in mcp/src and read frontend/src/lib, outside this directory. In the image they
   sit at /mcp and /frontend beside /app (api/Dockerfile), the same relative layout as the source
   tree, and are imported lazily: an image built without them still boots, and these two routes
   answer 503 instead. */
import crypto from 'node:crypto';

const MCP_URL = new URL('../mcp/src/http.js', import.meta.url);
const TOOLS_URL = new URL('../mcp/src/tools.js', import.meta.url);

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

export function integrationRoutes({ json, readBody, getDb, isAdmin, dataDir, origin, env = process.env }) {
  // MCP_PROFILE_ID, else the first admin. Decided per request: an admin appointed later, or a
  // changed db.json, is picked up without a restart.
  const profileId = () => {
    const fixed = (env.MCP_PROFILE_ID || '').trim();
    if (fixed) return fixed;
    return getDb().users.find(isAdmin)?.id || null;
  };

  async function prepare(res) {
    const m = await load();
    if (m.missing) { json(res, 503, { error: 'the MCP tools are not bundled in this build' }); return null; }
    const uid = profileId();
    if (!uid || !/^[a-zA-Z0-9_-]+$/.test(uid)) { json(res, 503, { error: 'no profile to serve: set MCP_PROFILE_ID' }); return null; }
    m.http.configure({ dataDir, uid });
    return m;
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
      const token = env.OPENGYM_HUB_TOKEN || '';
      if (!token) return json(res, 404, { error: 'not found' });
      if (!tokenOk(req, token)) { res.writeHead(401, { 'Cache-Control': 'no-store' }); return res.end(); }
      const m = await prepare(res);
      if (!m) return;
      json(res, 200, buildSummary(m.tools, { origin }));
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
