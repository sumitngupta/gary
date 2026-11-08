import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { serve } from '@hono/node-server';
import { Mastra } from '@mastra/core';
import { createHonoServer } from '@mastra/deployer/server';
import { resetPeopleStoreForTests } from './people';
import { recordWebPeerAddress, resetWebSignInFailuresForTests, webRoutes } from './web-session';

type Host = '127.0.0.1' | '[::1]';

/** Serves the web routes through Mastra's real HTTP stack, listening on both loopback addresses. */
async function isolated(t: TestContext, env: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'gary-web-session-'));
  const prior = { ...process.env };
  Object.assign(process.env, { GARY_DATA_DIR: dir, GARY_ADMIN_PASSWORD: 'correct horse', ...env });
  const reset = () => { resetPeopleStoreForTests(); resetWebSignInFailuresForTests(); };
  reset();
  const app = await createHonoServer(new Mastra({ logger: false, server: { middleware: [recordWebPeerAddress], apiRoutes: webRoutes } }), { tools: {} });
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const listening = serve({ fetch: app.fetch, port: 0, hostname: '::' }, () => resolve(listening));
  });
  const { port } = server.address() as AddressInfo;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    process.env = prior;
    reset();
    await rm(dir, { recursive: true, force: true });
  });
  return (host: Host, password: string, headers: Record<string, string> = {}) => fetch(`http://${host}:${port}/gary/web/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ secret: password }),
  });
}

type SignIn = Awaited<ReturnType<typeof isolated>>;

async function failTenTimes(signIn: SignIn, host: Host, headers?: Record<string, string>) {
  const statuses = [];
  for (let i = 0; i < 10; i += 1) statuses.push((await signIn(host, 'wrong', headers)).status);
  return statuses;
}

test('ten failed sign-ins from one address lock out that address only', async (t) => {
  const signIn = await isolated(t);
  assert.deepEqual(await failTenTimes(signIn, '127.0.0.1'), Array(10).fill(401));
  const lockedOut = await signIn('127.0.0.1', 'correct horse');
  assert.deepEqual([lockedOut.status, await lockedOut.json()], [429, { error: 'Too many failed sign-ins. Try again in an hour.' }]);
  const admin = await signIn('[::1]', 'correct horse');
  assert.equal(admin.status, 200);
  assert.match(admin.headers.get('set-cookie') ?? '', /^gary_session=[A-Za-z0-9_-]{43}; /);
});

test('x-forwarded-for picks the bucket only when GARY_TRUST_PROXY is true', async (t) => {
  const signIn = await isolated(t);
  await failTenTimes(signIn, '127.0.0.1', { 'x-forwarded-for': '192.0.2.1' });
  assert.equal((await signIn('127.0.0.1', 'wrong', { 'x-forwarded-for': '192.0.2.99' })).status, 429);

  resetWebSignInFailuresForTests();
  process.env.GARY_TRUST_PROXY = 'true';
  await failTenTimes(signIn, '127.0.0.1', { 'x-forwarded-for': '198.51.100.1, 192.0.2.1' });
  assert.equal((await signIn('127.0.0.1', 'wrong', { 'x-forwarded-for': '198.51.100.1, 192.0.2.1' })).status, 429);
  assert.equal((await signIn('127.0.0.1', 'wrong', { 'x-forwarded-for': '203.0.113.66, 192.0.2.1' })).status, 429);
  assert.equal((await signIn('127.0.0.1', 'correct horse', { 'x-forwarded-for': '192.0.2.2' })).status, 200);
});
