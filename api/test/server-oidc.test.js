/* Sign-in with Pocket ID (OpenID Connect, authorization code + PKCE), against a mock IdP that runs
   in this process. The server is the real server.js in a child process, as everywhere else.

   What is pinned here is the trust model, not the happy path alone:
   - the routes exist only when POCKET_ID_CLIENT_ID and POCKET_ID_CLIENT_SECRET are both set;
   - the callback answers only to the browser that started the flow (state in a signed cookie),
     and only for the ID token that flow asked for (nonce), signed RS256 by a key from the IdP's
     JWKS, for this client, from this issuer, not expired;
   - a profile is found by the Pocket ID `sub` bound to it and by nothing else: an unknown sub is
     refused even when its e-mail matches a profile, and no profile is ever created;
   - a binding is made only from a signed-in session, and the callback checks that the browser
     still holds that same session; an existing binding is never replaced. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const ORIGIN = 'http://localhost:8080';
const CLIENT_ID = 'opengym-test-client';
const CLIENT_SECRET = 'opengym-test-secret-' + crypto.randomBytes(8).toString('hex');
const CALLBACK = ORIGIN + '/api/auth/oidc/callback';

const mint = (uid, sv = 0, life = 86400000) => {
  const payload = `${uid}:${Date.now() + life}:${sv}:c`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};
const b64u = v => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const s256 = v => crypto.createHash('sha256').update(v).digest('base64url');

/* ---------- the mock IdP ---------- */
async function mockIdp(t) {
  const good = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const idp = {
    kid: 'key-1',
    good, other,
    codes: new Map(),       // code -> { challenge, nonce, sub, extra, token }
    tokenCalls: 0,
    lastTokenReq: null
  };
  const jwk = { ...good.publicKey.export({ format: 'jwk' }), kid: idp.kid, alg: 'RS256', use: 'sig' };

  idp.sign = (claims, { alg = 'RS256', key = good.privateKey, kid = idp.kid, header = {} } = {}) => {
    const h = b64u({ alg, typ: 'JWT', ...(kid ? { kid } : {}), ...header });
    const p = b64u(claims);
    const input = h + '.' + p;
    let sig = '';
    if (alg === 'RS256') sig = crypto.sign('RSA-SHA256', Buffer.from(input), key).toString('base64url');
    else if (alg === 'HS256') sig = crypto.createHmac('sha256', key).update(input).digest('base64url');
    else if (alg === 'PS256') sig = crypto.sign('sha256', Buffer.from(input), { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING }).toString('base64url');
    return input + '.' + sig;
  };
  idp.claims = (nonce, sub, extra = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return { iss: idp.issuer, aud: CLIENT_ID, azp: CLIENT_ID, sub, nonce, iat: now, exp: now + 300, ...extra };
  };

  const server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const url = new URL(req.url, idp.issuer);
    if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      return send(200, {
        issuer: idp.issuer,
        authorization_endpoint: idp.issuer + '/authorize',
        token_endpoint: idp.issuer + '/api/oidc/token',
        jwks_uri: idp.issuer + '/.well-known/jwks.json',
        response_types_supported: ['code'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256', 'plain']
      });
    }
    if (req.method === 'GET' && url.pathname === '/.well-known/jwks.json') return send(200, { keys: [jwk] });
    if (req.method === 'POST' && url.pathname === '/api/oidc/token') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        idp.tokenCalls++;
        const form = new URLSearchParams(body);
        idp.lastTokenReq = { auth: req.headers.authorization || '', form };
        const basic = 'Basic ' + Buffer.from(encodeURIComponent(CLIENT_ID) + ':' + encodeURIComponent(CLIENT_SECRET)).toString('base64');
        if (idp.lastTokenReq.auth !== basic) return send(401, { error: 'invalid_client' });
        const c = idp.codes.get(form.get('code'));
        idp.codes.delete(form.get('code'));
        if (!c) return send(400, { error: 'invalid_grant' });
        if (form.get('grant_type') !== 'authorization_code' || form.get('redirect_uri') !== CALLBACK) return send(400, { error: 'invalid_request' });
        if (s256(form.get('code_verifier') || '') !== c.challenge) return send(400, { error: 'invalid_grant', error_description: 'pkce' });
        const idToken = c.token ? c.token(c) : idp.sign(idp.claims(c.nonce, c.sub, c.extra));
        send(200, { access_token: 'at', token_type: 'Bearer', expires_in: 3600, id_token: idToken });
      });
      return;
    }
    send(404, { error: 'not found' });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  idp.issuer = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());
  return idp;
}

/* ---------- the server ---------- */
const USERS = [
  { id: 'u_one', name: 'One', created: '2026-01-01T00:00:00.000Z', email: 'one@example.com' },
  { id: 'u_two', name: 'Two', created: '2026-01-01T00:00:00.000Z' },
  { id: 'u_three', name: 'Three', created: '2026-01-01T00:00:00.000Z' },
  { id: 'u_off', name: 'Off', created: '2026-01-01T00:00:00.000Z', disabled: true }
];

async function startServer(t, idp, { env = {}, users = USERS } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-oidc-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users, creds: [], subs: [], invites: [] }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost', MEDIA_UPLOADS: '0',
      POCKET_ID_ISSUER: idp ? idp.issuer : '', POCKET_ID_CLIENT_ID: idp ? CLIENT_ID : '', POCKET_ID_CLIENT_SECRET: idp ? CLIENT_SECRET : '',
      ...env
    }
  });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const port = await boundPort(child, () => log);
  const api = `http://127.0.0.1:${port}`;
  return {
    api, dataDir,
    db: () => JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8')),
    req: (p, { method = 'GET', cookie, headers = {}, body } = {}) => fetch(api + p, {
      method, redirect: 'manual',
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined
    })
  };
}

const flowCookieOf = r => {
  const c = r.headers.getSetCookie().find(v => /^(__Host-)?gym_oidc=[^;]+/.test(v));
  return c ? c.split(';')[0] : null;
};
const sessionCookieOf = r => {
  const c = r.headers.getSetCookie().find(v => /^(__Host-)?gymsid=[^;]+;/.test(v));
  return c || null;
};
const resultOf = r => {
  assert.equal(r.status, 302, 'the callback answers with a redirect back into the app');
  const loc = new URL(r.headers.get('location'), ORIGIN);
  assert.equal(loc.origin + loc.pathname, ORIGIN + '/', 'back to the app, nowhere else');
  return loc.searchParams.get('pocket_id');
};

// Starts a sign-in (or, with `cookie`, a link) and returns what the browser would carry to the IdP.
async function begin(h, { cookie } = {}) {
  let r, authUrl;
  if (cookie) {
    r = await h.req('/api/auth/oidc/link', { method: 'POST', cookie, body: {} });
    assert.equal(r.status, 200);
    authUrl = new URL((await r.json()).url);
  } else {
    r = await h.req('/api/auth/oidc/login');
    assert.equal(r.status, 302);
    authUrl = new URL(r.headers.get('location'));
  }
  return { authUrl, flow: flowCookieOf(r) };
}

// What the IdP does after the person authenticated as `sub`: a code bound to the PKCE challenge
// and the nonce of this request, and the callback URL the browser is sent to.
function approve(idp, authUrl, sub, { extra, token, state } = {}) {
  const q = authUrl.searchParams;
  const code = crypto.randomBytes(12).toString('base64url');
  idp.codes.set(code, { challenge: q.get('code_challenge'), nonce: q.get('nonce'), sub, extra, token });
  return `/api/auth/oidc/callback?code=${code}&state=${encodeURIComponent(state ?? q.get('state'))}`;
}

async function signIn(h, idp, sub, opts = {}) {
  const { authUrl, flow } = await begin(h);
  const r = await h.req(approve(idp, authUrl, sub, opts), { cookie: opts.cookie ?? flow });
  return { r, result: resultOf(r), session: sessionCookieOf(r), authUrl };
}

const meOf = async (h, setCookie) => {
  const r = await h.req('/api/me', { cookie: setCookie.split(';')[0] });
  return r.status === 200 ? (await r.json()).user : null;
};
const bind = (users, uid, iss, sub) => users.map(u => (u.id === uid ? { ...u, oidc: { iss, sub, at: '2026-10-01T00:00:00.000Z' } } : u));

/* ---------- off unless configured ---------- */

test('without POCKET_ID_CLIENT_ID/SECRET the feature does not exist: routes 404, config says nothing', async t => {
  const h = await startServer(t, null);
  for (const [p, method] of [['/api/auth/oidc/login', 'GET'], ['/api/auth/oidc/callback?code=a&state=b', 'GET'], ['/api/auth/oidc/link', 'GET'], ['/api/auth/oidc/link', 'POST'], ['/api/auth/oidc/link', 'DELETE']]) {
    const r = await h.req(p, { method, cookie: `gymsid=${mint('u_one')}` });
    assert.equal(r.status, 404, `${method} ${p}`);
  }
  const cfg = await (await h.req('/api/config')).json();
  assert.equal('pocket_id' in cfg, false);
});

test('a client id without a secret is not enough', async t => {
  const idp = await mockIdp(t);
  const h = await startServer(t, idp, { env: { POCKET_ID_CLIENT_SECRET: '' } });
  assert.equal((await h.req('/api/auth/oidc/login')).status, 404);
  assert.equal('pocket_id' in await (await h.req('/api/config')).json(), false);
});

test('configured: /api/config says so, and sign-in starts an authorization-code request with PKCE S256', async t => {
  const idp = await mockIdp(t);
  const h = await startServer(t, idp);
  assert.equal((await (await h.req('/api/config')).json()).pocket_id, true);

  const r = await h.req('/api/auth/oidc/login');
  assert.equal(r.status, 302);
  const u = new URL(r.headers.get('location'));
  assert.equal(u.origin + u.pathname, idp.issuer + '/authorize');
  const q = u.searchParams;
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('client_id'), CLIENT_ID);
  assert.equal(q.get('redirect_uri'), CALLBACK);
  assert.ok(q.get('scope').split(' ').includes('openid'));
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.match(q.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.ok(q.get('state').length >= 22 && q.get('nonce').length >= 22);
  assert.notEqual(q.get('state'), q.get('nonce'));

  const set = r.headers.getSetCookie().find(v => v.startsWith('gym_oidc='));
  assert.ok(set, 'the flow cookie');
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Lax/);
  const age = +/Max-Age=(\d+)/.exec(set)[1];
  assert.ok(age > 0 && age <= 600, 'short-lived');
  // Nothing readable in it: state, nonce and verifier are not sitting there in the clear.
  const val = set.split(';')[0].slice('gym_oidc='.length);
  for (const k of ['state', 'nonce']) assert.ok(!decodeURIComponent(val).includes(q.get(k)), `${k} in the clear`);
});

/* ---------- sign-in ---------- */

test('a bound sub signs into exactly that profile, with the same session cookie a passkey sign-in sets', async t => {
  const idp = await mockIdp(t);
  const users = bind(bind(USERS, 'u_one', idp.issuer, 'sub-one'), 'u_two', idp.issuer, 'sub-two');
  const h = await startServer(t, idp, { users });

  const { r, result, session } = await signIn(h, idp, 'sub-two');
  assert.equal(result, 'signed-in');
  assert.ok(session, 'a session cookie');
  // sessionCookie(): the cookie a passkey sign-in sets, attribute for attribute.
  assert.match(session, /^gymsid=[^;]+; Path=\/; Max-Age=7776000; HttpOnly; SameSite=Lax$/);
  const tok = decodeURIComponent(session.split(';')[0].slice('gymsid='.length));
  assert.match(tok.slice(0, tok.lastIndexOf('.')), /^u_two:\d+:0:c$/, 'a browser cookie for u_two at its session version');
  assert.equal((await meOf(h, session)).id, 'u_two');
  // The flow cookie is spent with the callback.
  assert.ok(r.headers.getSetCookie().some(v => /^gym_oidc=;.*Max-Age=0/.test(v)));
  // PKCE and client authentication were what the token endpoint got.
  assert.equal(idp.lastTokenReq.form.get('grant_type'), 'authorization_code');
  assert.ok(idp.lastTokenReq.form.get('code_verifier'));

  const again = await signIn(h, idp, 'sub-one');
  assert.equal(again.result, 'signed-in');
  assert.equal((await meOf(h, again.session)).id, 'u_one');
});

test('an unknown sub is refused, even when its e-mail matches a profile, and no profile is created', async t => {
  const idp = await mockIdp(t);
  const h = await startServer(t, idp);
  const before = h.db().users.length;
  const { result, session } = await signIn(h, idp, 'sub-nobody', { extra: { email: 'one@example.com', email_verified: true, preferred_username: 'One', name: 'One' } });
  assert.equal(result, 'unbound');
  assert.equal(session, null, 'no session');
  assert.equal(h.db().users.length, before, 'no profile created');
  assert.ok(!h.db().users.some(u => u.oidc), 'nothing bound');
});

test('a sub bound under another issuer does not sign in', async t => {
  const idp = await mockIdp(t);
  const h = await startServer(t, idp, { users: bind(USERS, 'u_one', 'https://elsewhere.example', 'sub-one') });
  const { result, session } = await signIn(h, idp, 'sub-one');
  assert.equal(result, 'unbound');
  assert.equal(session, null);
});

test('a disabled profile does not sign in through Pocket ID either', async t => {
  const idp = await mockIdp(t);
  const h = await startServer(t, idp, { users: USERS.map(u => (u.id === 'u_off' ? { ...u, oidc: { iss: idp.issuer, sub: 'sub-off' } } : u)) });
  const { result, session } = await signIn(h, idp, 'sub-off');
  assert.equal(result, 'disabled');
  assert.equal(session, null);
});

/* ---------- state, nonce, token verification ---------- */

async function boundServer(t) {
  const idp = await mockIdp(t);
  const users = USERS.map(u => (u.id === 'u_one' ? { ...u, oidc: { iss: idp.issuer, sub: 'sub-one' } } : u));
  const h = await startServer(t, idp, { users });
  return { idp, h };
}

test('state mismatch, a missing flow cookie or a forged one: refused before the code is ever redeemed', async t => {
  const { idp, h } = await boundServer(t);
  const { authUrl, flow } = await begin(h);

  let r = await h.req(approve(idp, authUrl, 'sub-one', { state: 'not-the-state' }), { cookie: flow });
  assert.equal(resultOf(r), 'failed');
  assert.equal(sessionCookieOf(r), null);

  r = await h.req(approve(idp, authUrl, 'sub-one'));
  assert.equal(resultOf(r), 'failed', 'no flow cookie');

  // Another browser's flow cookie with this browser's state.
  const theirs = await begin(h);
  r = await h.req(approve(idp, authUrl, 'sub-one'), { cookie: theirs.flow });
  assert.equal(resultOf(r), 'failed');

  // A cookie whose value was edited.
  const [name, val] = flow.split('=');
  const tampered = name + '=' + (val[0] === 'A' ? 'B' : 'A') + val.slice(1);
  r = await h.req(approve(idp, authUrl, 'sub-one'), { cookie: tampered });
  assert.equal(resultOf(r), 'failed');

  // A session cookie value is not a flow cookie.
  r = await h.req(approve(idp, authUrl, 'sub-one'), { cookie: `gym_oidc=${mint('u_one')}` });
  assert.equal(resultOf(r), 'failed');

  assert.equal(idp.tokenCalls, 0, 'no code was redeemed for any of them');
});

test('an error from the IdP (the person said no) is not a sign-in', async t => {
  const { idp, h } = await boundServer(t);
  const { authUrl, flow } = await begin(h);
  const r = await h.req(`/api/auth/oidc/callback?error=access_denied&state=${authUrl.searchParams.get('state')}`, { cookie: flow });
  assert.equal(resultOf(r), 'denied');
  assert.equal(sessionCookieOf(r), null);
  assert.equal(idp.tokenCalls, 0);
});

test('nonce mismatch is refused', async t => {
  const { idp, h } = await boundServer(t);
  const { result, session } = await signIn(h, idp, 'sub-one', { token: c => idp.sign(idp.claims('another-nonce', 'sub-one')) });
  assert.equal(result, 'failed');
  assert.equal(session, null);
});

test('a token without a nonce is refused', async t => {
  const { idp, h } = await boundServer(t);
  const { result } = await signIn(h, idp, 'sub-one', { token: c => { const cl = idp.claims(c.nonce, 'sub-one'); delete cl.nonce; return idp.sign(cl); } });
  assert.equal(result, 'failed');
});

test('bad signatures and algorithm confusion are refused', async t => {
  const { idp, h } = await boundServer(t);
  const cases = {
    'signed by a key that is not in the JWKS, under its kid': c => idp.sign(idp.claims(c.nonce, 'sub-one'), { key: idp.other.privateKey }),
    'signed by an unknown kid': c => idp.sign(idp.claims(c.nonce, 'sub-one'), { key: idp.other.privateKey, kid: 'key-2' }),
    'HS256 keyed with the client secret': c => idp.sign(idp.claims(c.nonce, 'sub-one'), { alg: 'HS256', key: CLIENT_SECRET }),
    'HS256 keyed with the public key PEM': c => idp.sign(idp.claims(c.nonce, 'sub-one'), { alg: 'HS256', key: idp.good.publicKey.export({ type: 'spki', format: 'pem' }) }),
    'alg none': c => { const t = idp.sign(idp.claims(c.nonce, 'sub-one'), { alg: 'none' }); return t.slice(0, t.lastIndexOf('.') + 1); },
    'PS256 with the right key (not RS256)': c => idp.sign(idp.claims(c.nonce, 'sub-one'), { alg: 'PS256' }),
    'payload swapped after signing': c => {
      const [hd, , sig] = idp.sign(idp.claims(c.nonce, 'sub-other')).split('.');
      return [hd, b64u(idp.claims(c.nonce, 'sub-one')), sig].join('.');
    },
    'not a JWT at all': () => 'garbage',
    'a crit header': c => idp.sign(idp.claims(c.nonce, 'sub-one'), { header: { crit: ['exp'] } })
  };
  for (const [name, token] of Object.entries(cases)) {
    const { result, session } = await signIn(h, idp, 'sub-one', { token });
    assert.equal(result, 'failed', name);
    assert.equal(session, null, name);
  }
  // And the genuine article still works on the same server.
  assert.equal((await signIn(h, idp, 'sub-one')).result, 'signed-in');
});

test('wrong issuer, wrong audience, wrong azp and an expired token are refused', async t => {
  const { idp, h } = await boundServer(t);
  const now = Math.floor(Date.now() / 1000);
  const cases = {
    'iss of another IdP': { iss: 'https://evil.example' },
    'iss with a trailing slash': { iss: idp.issuer + '/' },
    'aud of another client': { aud: 'another-client', azp: 'another-client' },
    'aud missing': { aud: undefined },
    'aud list with us and azp of another client': { aud: [CLIENT_ID, 'another-client'], azp: 'another-client' },
    'aud list with us and no azp': { aud: [CLIENT_ID, 'another-client'], azp: undefined },
    'azp of another client': { azp: 'another-client' },
    'expired': { iat: now - 3600, exp: now - 600 },
    'exp missing': { exp: undefined },
    'not valid yet': { nbf: now + 3600 },
    'sub missing': { sub: undefined },
    'sub empty': { sub: '' }
  };
  for (const [name, over] of Object.entries(cases)) {
    const { result, session } = await signIn(h, idp, 'sub-one', { token: c => {
      const cl = { ...idp.claims(c.nonce, 'sub-one'), ...over };
      for (const k of Object.keys(cl)) if (cl[k] === undefined) delete cl[k];
      return idp.sign(cl);
    } });
    assert.equal(result, 'failed', name);
    assert.equal(session, null, name);
  }
  // An aud list that names us, with azp = us, is fine.
  const ok = await signIn(h, idp, 'sub-one', { extra: { aud: [CLIENT_ID, 'another-client'] } });
  assert.equal(ok.result, 'signed-in');
});

/* ---------- linking ---------- */

test('linking needs a signed-in browser session: none, or a Bearer, is a 401', async t => {
  const idp = await mockIdp(t);
  const h = await startServer(t, idp);
  assert.equal((await h.req('/api/auth/oidc/link', { method: 'POST', body: {} })).status, 401);
  assert.equal((await h.req('/api/auth/oidc/link', { method: 'POST', body: {}, headers: { Authorization: 'Bearer ' + mint('u_one') } })).status, 401);
  assert.equal((await h.req('/api/auth/oidc/link')).status, 401);
  assert.equal((await h.req('/api/auth/oidc/link', { method: 'DELETE' })).status, 401);
  // A cross-site page cannot start one with the victim's cookie.
  const r = await h.req('/api/auth/oidc/link', { method: 'POST', body: {}, cookie: `gymsid=${mint('u_one')}`, headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(r.status, 403);
});

test('link from a session, then sign in with it; unlink ends it', async t => {
  const idp = await mockIdp(t);
  const h = await startServer(t, idp);
  const cookie = `gymsid=${mint('u_three')}`;

  assert.deepEqual(await (await h.req('/api/auth/oidc/link', { cookie })).json(), { linked: false });

  const { authUrl, flow } = await begin(h, { cookie });
  assert.equal(authUrl.searchParams.get('redirect_uri'), CALLBACK);
  const r = await h.req(approve(idp, authUrl, 'sub-three'), { cookie: `${cookie}; ${flow}` });
  assert.equal(resultOf(r), 'linked');
  assert.equal(sessionCookieOf(r), null, 'linking does not mint a new session');
  const u3 = h.db().users.find(u => u.id === 'u_three');
  assert.equal(u3.oidc.sub, 'sub-three');
  assert.equal(u3.oidc.iss, idp.issuer);
  const st = await (await h.req('/api/auth/oidc/link', { cookie })).json();
  assert.equal(st.linked, true);
  assert.ok(st.linkedAt);
  assert.equal('sub' in st, false, 'the sub is not handed out');

  const s = await signIn(h, idp, 'sub-three');
  assert.equal(s.result, 'signed-in');
  assert.equal((await meOf(h, s.session)).id, 'u_three');

  const del = await h.req('/api/auth/oidc/link', { method: 'DELETE', cookie });
  assert.equal(del.status, 200);
  assert.equal((await del.json()).linked, false);
  assert.equal(h.db().users.find(u => u.id === 'u_three').oidc, undefined);
  assert.equal((await signIn(h, idp, 'sub-three')).result, 'unbound');
});

test('the callback refuses a link when the browser no longer holds the session that started it', async t => {
  const idp = await mockIdp(t);
  const h = await startServer(t, idp);
  const one = `gymsid=${mint('u_one')}`;

  // Signed out in between (no session cookie at the callback).
  let f = await begin(h, { cookie: one });
  let r = await h.req(approve(idp, f.authUrl, 'sub-x'), { cookie: f.flow });
  assert.equal(resultOf(r), 'session');

  // Another profile's session at the callback.
  f = await begin(h, { cookie: one });
  r = await h.req(approve(idp, f.authUrl, 'sub-x'), { cookie: `gymsid=${mint('u_two')}; ${f.flow}` });
  assert.equal(resultOf(r), 'session');

  // The same profile but a different session (signed in again elsewhere in this browser).
  f = await begin(h, { cookie: one });
  r = await h.req(approve(idp, f.authUrl, 'sub-x'), { cookie: `gymsid=${mint('u_one', 0, 2 * 86400000)}; ${f.flow}` });
  assert.equal(resultOf(r), 'session');

  // Signed out everywhere in between: the session version moved on.
  f = await begin(h, { cookie: one });
  assert.equal((await h.req('/api/logout/all', { method: 'POST', cookie: one, body: {} })).status, 200);
  r = await h.req(approve(idp, f.authUrl, 'sub-x'), { cookie: `${one}; ${f.flow}` });
  assert.equal(resultOf(r), 'session');

  assert.ok(!h.db().users.some(u => u.oidc), 'nothing was bound');
  // And a login flow cookie cannot be used to finish a link, nor the other way round: a link's
  // callback never signs anyone in.
  const two = `gymsid=${mint('u_two')}`;
  f = await begin(h, { cookie: two });
  r = await h.req(approve(idp, f.authUrl, 'sub-two'), { cookie: f.flow });
  assert.equal(sessionCookieOf(r), null);
});

test('an existing binding is never replaced: not on the profile, not for the sub', async t => {
  const idp = await mockIdp(t);
  const h = await startServer(t, idp, { users: USERS.map(u => (u.id === 'u_two' ? { ...u, oidc: { iss: idp.issuer, sub: 'sub-two' } } : u)) });
  const two = `gymsid=${mint('u_two')}`;

  // u_two already has one: a second link is refused up front.
  const r0 = await h.req('/api/auth/oidc/link', { method: 'POST', cookie: two, body: {} });
  assert.equal(r0.status, 409);
  assert.equal((await r0.json()).code, 'already-linked');

  // u_one links, while u_one gets bound by another tab in between: refused at the callback.
  const one = `gymsid=${mint('u_one')}`;
  const a = await begin(h, { cookie: one });
  const b = await begin(h, { cookie: one });
  assert.equal(resultOf(await h.req(approve(idp, a.authUrl, 'sub-a'), { cookie: `${one}; ${a.flow}` })), 'linked');
  assert.equal(resultOf(await h.req(approve(idp, b.authUrl, 'sub-b'), { cookie: `${one}; ${b.flow}` })), 'already-linked');
  assert.equal(h.db().users.find(u => u.id === 'u_one').oidc.sub, 'sub-a');

  // u_three tries to take the sub u_one holds: refused, u_one keeps it.
  const three = `gymsid=${mint('u_three')}`;
  const c = await begin(h, { cookie: three });
  assert.equal(resultOf(await h.req(approve(idp, c.authUrl, 'sub-a'), { cookie: `${three}; ${c.flow}` })), 'taken');
  assert.equal(h.db().users.find(u => u.id === 'u_three').oidc, undefined);
  assert.equal(h.db().users.find(u => u.id === 'u_one').oidc.sub, 'sub-a');
});

test('a link flow is checked like a sign-in: a bad token binds nothing', async t => {
  const idp = await mockIdp(t);
  const h = await startServer(t, idp);
  const one = `gymsid=${mint('u_one')}`;
  const f = await begin(h, { cookie: one });
  const r = await h.req(approve(idp, f.authUrl, 'sub-x', { token: c => idp.sign(idp.claims(c.nonce, 'sub-x'), { key: idp.other.privateKey }) }), { cookie: `${one}; ${f.flow}` });
  assert.equal(resultOf(r), 'failed');
  assert.ok(!h.db().users.some(u => u.oidc));
});
