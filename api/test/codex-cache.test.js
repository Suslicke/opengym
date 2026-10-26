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
  cfg.save({ enabled: true, provider: 'codex', authMode: 'instance', boundUid: {}, auth: {}, ...extra });
}
const withCache = () => fs.writeFileSync(authFile, 'not-json-and-never-read', { mode: 0o600 });
const noCache = () => fs.rmSync(authFile, { force: true });

test('no cache and no key: codex is not connected', () => {
  noCache();
  codexInstance();
  assert.equal(cfg.hasCodexCache(), false);
  assert.equal(cfg.isConnected(), false);
  assert.equal(cfg.credentialFor('alice').ok, false);
});

test('a cache in CREDENTIAL_HOME connects codex without a filed key', () => {
  withCache();
  codexInstance();
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
  const env = cfg.jobEnv('/tmp/job', cfg.credentialFor('alice'));
  assert.equal(env.CODEX_HOME, home);
  assert.equal(env.CODEX_API_KEY, undefined);
});

test('the cache is personal: the first profile to spend it binds it', () => {
  withCache();
  codexInstance();
  cfg.bindInstanceCredential('alice');
  assert.equal(cfg.boundUidFor(), 'alice');
  assert.equal(cfg.credentialFor('bob').reason, 'shared-account');
  assert.equal(cfg.credentialFor('alice').ok, true);
});

test('a filed key wins over the cache', () => {
  withCache();
  codexInstance({ auth: { codex: { type: 'apikey', account: '', data: cfg.encrypt({ token: 'sk-codex' }) } } });
  assert.equal(cfg.usesCodexCache(cfg.load()), false);
  const c = cfg.credentialFor('alice');
  assert.equal(c.type, 'apikey');
  assert.equal(c.auth.token, 'sk-codex');
});

test('another provider ignores the codex cache', () => {
  withCache();
  cfg.reset();
  cfg.save({ enabled: true, provider: 'claude', authMode: 'instance', boundUid: {}, auth: {} });
  assert.equal(cfg.isConnected(), false);
  assert.equal(cfg.credentialFor('alice').ok, false);
});

test('a directory named auth.json is not a cache', () => {
  noCache();
  fs.mkdirSync(authFile);
  codexInstance();
  assert.equal(cfg.hasCodexCache(), false);
  fs.rmdirSync(authFile);
});
