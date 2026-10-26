/* Fork (Suslicke/opengym): a mounted Codex login cache is the instance's Codex credential.
 *
 * The cache is a ChatGPT sign-in made elsewhere and mounted at CREDENTIAL_HOME. Its presence is
 * all that is checked — the file is never read here — and a filed key still takes precedence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempData } from './helpers.mjs';

tempData();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-home-'));
process.env.COACH_CREDENTIAL_DIR = home;
const cfg = await import('../coach/config.js');
const authFile = path.join(home, 'auth.json');

function codexInstance(extra = {}) {
  cfg.reset();
  cfg.save({ enabled: true, provider: 'codex', authMode: 'instance', boundUid: {}, auth: {}, useCodexCache: false, ...extra });
}
// The explicit admin action ("Use server Codex login").
function optIn() { assert.equal(cfg.useCodexLoginCache(), true); }
const withCache = () => fs.writeFileSync(authFile, 'not-json-and-never-read', { mode: 0o600 });
const noCache = () => fs.rmSync(authFile, { force: true });

test('no cache and no key: codex is not connected', () => {
  noCache();
  codexInstance();
  assert.equal(cfg.hasCodexCache(), false);
  assert.equal(cfg.isConnected(), false);
  assert.equal(cfg.credentialFor('alice').ok, false);
});

test('a cache alone, without the admin opt-in, does not connect codex', () => {
  withCache();
  codexInstance();
  assert.equal(cfg.hasCodexCache(), true);
  assert.equal(cfg.isConnected(), false);
  assert.equal(cfg.credentialFor('alice').ok, false);
});

test('opting in without a mounted cache is refused', () => {
  noCache();
  codexInstance();
  assert.equal(cfg.useCodexLoginCache(), false);
  assert.equal(cfg.load().useCodexCache, false);
});

test('after the opt-in, the cache connects codex without a filed key', () => {
  withCache();
  codexInstance();
  optIn();
  assert.equal(cfg.isConnected(), true);
  const c = cfg.credentialFor('alice');
  assert.equal(c.ok, true);
  assert.equal(c.type, cfg.CODEX_CACHE_TYPE);
  assert.equal(c.auth, null, 'the cache is never read into a credential');
  assert.ok(cfg.publicConfig(), 'the Coach UI is offered');
});

test('the job env points CODEX_HOME at the cache and carries no key', () => {
  withCache();
  codexInstance();
  optIn();
  const env = cfg.jobEnv('/tmp/job', cfg.credentialFor('alice'));
  assert.equal(env.CODEX_HOME, home);
  assert.equal(env.CODEX_API_KEY, undefined);
});

test('the cache is personal: the first profile to spend it binds it', () => {
  withCache();
  codexInstance();
  optIn();
  cfg.bindInstanceCredential('alice');
  assert.equal(cfg.boundUidFor(), 'alice');
  assert.equal(cfg.credentialFor('bob').reason, 'shared-account');
  assert.equal(cfg.credentialFor('alice').ok, true);
});

test('disconnect clears the opt-in: codex is really disconnected', () => {
  withCache();
  codexInstance();
  optIn();
  cfg.bindInstanceCredential('alice');
  cfg.saveAuth('codex', null);                 // what POST /api/admin/coach/disconnect does
  assert.equal(cfg.load().useCodexCache, false);
  assert.equal(cfg.boundUidFor(), null);
  assert.equal(cfg.isConnected(), false);
  assert.equal(cfg.credentialFor('alice').ok, false);
});

test('filing a key ends the opt-in; opting in drops a filed key', () => {
  withCache();
  codexInstance();
  optIn();
  cfg.saveAuth('codex', { type: 'apikey', account: '', data: cfg.encrypt({ token: 'sk-codex' }) });
  assert.equal(cfg.load().useCodexCache, false);
  assert.equal(cfg.credentialFor('alice').type, 'apikey');
  optIn();
  assert.equal(cfg.authFor(cfg.load(), 'codex'), null);
  assert.equal(cfg.credentialFor('alice').type, cfg.CODEX_CACHE_TYPE);
});

test('a filed key wins over the cache', () => {
  withCache();
  codexInstance({ useCodexCache: true, auth: { codex: { type: 'apikey', account: '', data: cfg.encrypt({ token: 'sk-codex' }) } } });
  assert.equal(cfg.usesCodexCache(cfg.load()), false);
  const c = cfg.credentialFor('alice');
  assert.equal(c.type, 'apikey');
  assert.equal(c.auth.token, 'sk-codex');
});

test('another provider ignores the codex cache', () => {
  withCache();
  cfg.reset();
  cfg.save({ enabled: true, provider: 'claude', authMode: 'instance', boundUid: {}, auth: {}, useCodexCache: true });
  assert.equal(cfg.isConnected(), false);
  assert.equal(cfg.credentialFor('alice').ok, false);
});

test('a directory named auth.json is not a cache', () => {
  noCache();
  fs.mkdirSync(authFile);
  codexInstance({ useCodexCache: true });
  assert.equal(cfg.hasCodexCache(), false);
  fs.rmdirSync(authFile);
});
