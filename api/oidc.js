/* Sign-in with Pocket ID: the OpenID Connect relying party, protocol side only.
 *
 * Authorization code flow with PKCE (S256), a state and a nonce per flow, and an ID token checked
 * here by hand: RS256 only, a key from the issuer's JWKS, iss, aud, azp, exp/nbf, nonce. No new
 * dependency for it — node:crypto verifies an RSA signature against a JWK directly, and a library
 * would bring a dozen algorithms this has to refuse anyway.
 *
 * What a `sub` means for a profile (binding, sign-in, sessions) is server.js's business; this
 * module only answers "did this issuer really say this sub, to this client, for this flow". */
import crypto from 'node:crypto';

export class OidcError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/* The configuration from the environment, or null when the feature is off. Off unless both the
 * client id and its secret are set. The issuer has to be https (plain http only on a loopback
 * address, for a local test IdP); anything else turns the feature off with a warning rather than
 * sending a client secret in the clear. */
export function oidcConfig(env, warn = console.warn) {
  const clientId = String(env.POCKET_ID_CLIENT_ID || '').trim();
  const clientSecret = String(env.POCKET_ID_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return null;
  const issuer = String(env.POCKET_ID_ISSUER || 'https://id.suslicketeam.com').trim().replace(/\/+$/, '');
  let u;
  try { u = new URL(issuer); } catch { warn(`POCKET_ID_ISSUER "${issuer.slice(0, 80)}" is not a URL — Pocket ID sign-in is off`); return null; }
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname))) || u.search || u.hash || u.username) {
    warn(`POCKET_ID_ISSUER must be an https URL — Pocket ID sign-in is off`);
    return null;
  }
  return { issuer, clientId, clientSecret };
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export function pkcePair() {
  const verifier = randomToken(32);
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

/* ---------- the flow cookie ----------
 * state, nonce, PKCE verifier, what the flow is for, and its expiry — sealed with AES-256-GCM
 * under a key derived from the instance secret for this purpose only. Sealed rather than just
 * signed so the verifier and nonce are not readable from the browser, and under its own key so a
 * flow cookie and a session token can never be taken for one another. */
const flowKey = secret => crypto.createHmac('sha256', secret).update('openGym oidc flow cookie v1').digest();

export function sealFlow(secret, data) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', flowKey(secret), iv);
  const body = Buffer.concat([c.update(JSON.stringify(data), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}

export function openFlow(secret, value, now = Date.now()) {
  if (typeof value !== 'string' || value.length < 40 || value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const raw = Buffer.from(value, 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', flowKey(secret), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const data = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
    if (!data || typeof data !== 'object' || typeof data.exp !== 'number' || data.exp < now) return null;
    return data;
  } catch { return null; }
}

/* ---------- the client ---------- */
const DISCOVERY_TTL = 3600000;
const JWKS_REFRESH_MIN = 60000;   // an unknown kid refetches the JWKS at most this often
const SKEW_S = 60;

export function createOidcClient({ issuer, clientId, clientSecret, redirectUri, fetchImpl = globalThis.fetch, now = Date.now }) {
  let discovery = null;   // { doc, at }
  let jwks = null;        // { keys, at }

  const getJson = async (url, init) => {
    let r;
    try { r = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) }); }
    catch { throw new OidcError('idp-unreachable'); }
    let body = null;
    try { body = await r.json(); } catch { /* not json */ }
    return { status: r.status, body };
  };

  // Every endpoint has to live on the issuer's own origin: a discovery document cannot send the
  // code, the verifier or the client secret anywhere else.
  const sameOrigin = v => { try { return new URL(v).origin === new URL(issuer).origin; } catch { return false; } };

  async function config() {
    if (discovery && now() - discovery.at < DISCOVERY_TTL) return discovery.doc;
    const { status, body } = await getJson(issuer + '/.well-known/openid-configuration');
    if (status !== 200 || !body || body.issuer !== issuer) throw new OidcError('bad-discovery');
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      if (typeof body[k] !== 'string' || !sameOrigin(body[k])) throw new OidcError('bad-discovery');
    }
    discovery = { doc: body, at: now() };
    return body;
  }

  async function keys(force) {
    if (jwks && !force && now() - jwks.at < DISCOVERY_TTL) return jwks.keys;
    if (jwks && force && now() - jwks.at < JWKS_REFRESH_MIN) return jwks.keys;
    const { status, body } = await getJson((await config()).jwks_uri);
    if (status !== 200 || !body || !Array.isArray(body.keys)) throw new OidcError('bad-jwks');
    jwks = { keys: body.keys.filter(k => k && k.kty === 'RSA' && (!k.use || k.use === 'sig') && (!k.alg || k.alg === 'RS256')), at: now() };
    return jwks.keys;
  }

  async function authorizationUrl({ state, nonce, challenge }) {
    const u = new URL((await config()).authorization_endpoint);
    u.search = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: 'openid',
      state, nonce, code_challenge: challenge, code_challenge_method: 'S256'
    }).toString();
    return u.toString();
  }

  async function redeem(code, verifier) {
    const basic = Buffer.from(encodeURIComponent(clientId) + ':' + encodeURIComponent(clientSecret)).toString('base64');
    const { status, body } = await getJson((await config()).token_endpoint, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }).toString()
    });
    if (status !== 200 || !body || typeof body.id_token !== 'string') throw new OidcError('token-refused');
    return body.id_token;
  }

  async function verifyIdToken(idToken, nonce) {
    const parts = typeof idToken === 'string' ? idToken.split('.') : [];
    if (parts.length !== 3 || !parts.every(p => /^[A-Za-z0-9_-]*$/.test(p))) throw new OidcError('malformed');
    let header, claims;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch { throw new OidcError('malformed'); }
    if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object' || Array.isArray(claims)) throw new OidcError('malformed');
    // RS256 and nothing else: no `none`, no HMAC keyed with something public, no PSS.
    if (header.alg !== 'RS256') throw new OidcError('bad-alg');
    if (header.crit !== undefined) throw new OidcError('bad-alg');

    const pick = list => (header.kid !== undefined
      ? list.find(k => k.kid === header.kid)
      : (list.length === 1 ? list[0] : undefined));
    let jwk = pick(await keys(false));
    if (!jwk) jwk = pick(await keys(true));
    if (!jwk) throw new OidcError('unknown-key');
    let key;
    try { key = crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' }); }
    catch { throw new OidcError('bad-jwks'); }
    if ((key.asymmetricKeyDetails?.modulusLength || 0) < 2048) throw new OidcError('bad-jwks');
    const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url'));
    if (!ok) throw new OidcError('bad-signature');

    if (claims.iss !== issuer) throw new OidcError('bad-iss');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(clientId) || !aud.every(a => typeof a === 'string')) throw new OidcError('bad-aud');
    if (aud.length > 1 && claims.azp !== clientId) throw new OidcError('bad-azp');
    if (claims.azp !== undefined && claims.azp !== clientId) throw new OidcError('bad-azp');
    const t = now() / 1000;
    if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < t) throw new OidcError('expired');
    if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf - SKEW_S > t)) throw new OidcError('not-yet');
    if (claims.iat !== undefined && (typeof claims.iat !== 'number' || claims.iat - SKEW_S > t)) throw new OidcError('not-yet');
    if (!safeEqual(claims.nonce, nonce)) throw new OidcError('bad-nonce');
    if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw new OidcError('bad-sub');
    return claims;
  }

  return { issuer, authorizationUrl, redeem, verifyIdToken };
}
