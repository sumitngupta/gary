import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Hono } from 'hono';
import { resetPeopleStoreForTests } from './people';
import { resetWebSignInFailuresForTests, webSignInRoute } from './web-session';

async function isolated(t: TestContext, env: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'gary-web-session-'));
  const prior = { ...process.env };
  Object.assign(process.env, { GARY_DATA_DIR: dir, GARY_ADMIN_PASSWORD: 'correct horse', ...env });
  const reset = () => { resetPeopleStoreForTests(); resetWebSignInFailuresForTests(); };
  reset();
  t.after(async () => {
    process.env = prior;
    reset();
    await rm(dir, { recursive: true, force: true });
  });
  assert.ok('handler' in webSignInRoute);
  const app = new Hono();
  app.post('/gary/web/session', webSignInRoute.handler as never);
  return async (remoteAddress: string, password: string, headers: Record<string, string> = {}) => app.request('/gary/web/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ secret: password }),
  }, { incoming: { socket: { remoteAddress } } });
}

async function failTenTimes(signIn: (address: string, password: string, headers?: Record<string, string>) => Promise<Response>, address: string, headers?: Record<string, string>) {
  const statuses = [];
  for (let i = 0; i < 10; i += 1) statuses.push((await signIn(address, 'wrong', headers)).status);
  return statuses;
}

test('ten failed sign-ins from one address lock out that address only', async (t) => {
  const signIn = await isolated(t);
  assert.deepEqual(await failTenTimes(signIn, '203.0.113.7'), Array(10).fill(401));
  const lockedOut = await signIn('203.0.113.7', 'correct horse');
  assert.deepEqual([lockedOut.status, await lockedOut.json()], [429, { error: 'Too many failed sign-ins. Try again in an hour.' }]);
  const admin = await signIn('198.51.100.20', 'correct horse');
  assert.equal(admin.status, 200);
  assert.match(admin.headers.get('set-cookie') ?? '', /^gary_session=[A-Za-z0-9_-]{43}; /);
});

test('x-forwarded-for picks the bucket only when GARY_TRUST_PROXY is true', async (t) => {
  const untrusted = await isolated(t);
  await failTenTimes(untrusted, '203.0.113.7', { 'x-forwarded-for': '192.0.2.1' });
  assert.equal((await untrusted('203.0.113.7', 'wrong', { 'x-forwarded-for': '192.0.2.99' })).status, 429);

  resetWebSignInFailuresForTests();
  process.env.GARY_TRUST_PROXY = 'true';
  await failTenTimes(untrusted, '198.51.100.250', { 'x-forwarded-for': '198.51.100.1, 192.0.2.1' });
  assert.equal((await untrusted('198.51.100.250', 'wrong', { 'x-forwarded-for': '198.51.100.1, 192.0.2.1' })).status, 429);
  assert.equal((await untrusted('198.51.100.250', 'wrong', { 'x-forwarded-for': '203.0.113.66, 192.0.2.1' })).status, 429);
  assert.equal((await untrusted('198.51.100.250', 'correct horse', { 'x-forwarded-for': '192.0.2.2' })).status, 200);
});
